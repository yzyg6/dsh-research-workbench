import { mkdir, readFile, readdir, stat, rename, rm, realpath, utimes } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, relative, isAbsolute, extname, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { StoreError } from './store.mjs';

const check=(ok,code,message,status=400)=>{if(!ok)throw new StoreError(code,message,status)};
const inside=(base,path)=>{const rel=relative(base,path);return rel===''||!rel.startsWith('..')&&!isAbsolute(rel)};
const MIME={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif'};
const READER=1,MAX_CACHE=160*1024*1024;

/** DOCX never enters state(): one isolated parser, disk segments, bounded live metadata. */
export class WordPreview {
  constructor(store,{python='python',script=fileURLToPath(new URL('./word-reader.py',import.meta.url)),timeoutMs=30000}={}) {
    this.store=store;this.python=python;this.script=script;this.timeoutMs=timeoutMs;this.jobs=new Map();this.initializing=new Map();this.queue=[];this.current=null;this.closed=false;
  }
  async context(projectId,objectId) {
    const object=this.store.object(projectId,objectId),metadata=JSON.parse(object.metadata);
    check(/^[a-f0-9]{64}$/.test(object.sha256),'INVALID_WORD_CACHE','Word 版本校验信息无效。');
    check(object.encoding==='binary'&&extname(metadata.workspaceFile||object.path).toLowerCase()==='.docx','UNSUPPORTED_WORD','工作台内阅读支持 .docx；旧版 .doc 请先在原应用另存为 .docx。');
    const source=await this.store.projectPath(projectId,object.path),details=await stat(source);
    check(details.size<=32*1024*1024,'WORD_TOO_LARGE','此 Word 超过32 MiB，请用原应用查看或拆分稿件。',413);
    const layout=await this.store.workspaceFiles.layout(projectId),base=await this.store.projectPath(projectId,join(layout.directories.temp,'dsh-workbench','word-preview'));
    await mkdir(base,{recursive:true});const folder=join(base,`${object.sha256}-r${READER}`);
    check(inside(await realpath(base),await this.physical(folder)),'PATH_OUTSIDE_PROJECT','阅读缓存路径不属于本工作区。',403);
    return {projectId,objectId,source,sha256:object.sha256,base,folder,key:folder};
  }
  async physical(path){try{return await realpath(path)}catch(error){if(error.code!=='ENOENT')throw error;return join(await this.physical(dirname(path)),basename(path))}}
  async manifest(context) {
    try {const path=join(context.folder,'manifest.json');check((await stat(path)).size<=2*1024*1024,'INVALID_WORD_CACHE','阅读缓存过大。');const data=JSON.parse(await readFile(path,'utf8'));check(data.schemaVersion===1&&data.readerVersion===READER&&data.sourceSha256===context.sha256&&Array.isArray(data.pages)&&data.pages.length>0&&data.pages.length<=1001,'INVALID_WORD_CACHE','阅读缓存不兼容。');return data;}catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return null;throw error}
  }
  public(job){return{state:job.state,phase:job.phase,leaseId:job.leaseId,segments:job.manifest?.pages.length||0,counts:job.manifest?.counts,warnings:job.manifest?.warnings||[],metrics:job.manifest?{parseElapsedMs:job.manifest.elapsedMs,peakWorkingSetBytes:job.manifest.peakWorkingSetBytes}:undefined,error:job.error||null}}
  async start(projectId,objectId) {
    check(!this.closed,'CLOSED','Word 阅读服务已关闭。',503);
    const context=await this.context(projectId,objectId),leaseId=randomUUID(),previous=this.initializing.get(context.key)||Promise.resolve();
    const operation=previous.catch(()=>{}).then(()=>this.acquire(context,leaseId));this.initializing.set(context.key,operation);
    try{return await operation}finally{if(this.initializing.get(context.key)===operation)this.initializing.delete(context.key)}
  }
  async acquire(context,leaseId) {
    check(!this.closed,'CLOSED','Word 阅读服务已关闭。',503);let job=this.jobs.get(context.key);
    if(job&&['queued','running','ready'].includes(job.state)){check(job.leases.size<32,'WORD_BUSY','此文档已有过多打开请求。',429);job.leases.add(leaseId);return{...this.public(job),leaseId}}
    let manifest;try{manifest=await this.manifest(context)}catch(error){if(error.code==='INVALID_WORD_CACHE')manifest=null;else throw error}
    this.trim();check(this.jobs.size<8,'WORD_BUSY','已打开较多 Word，请先关闭其他阅读页。',429);
    check(manifest||this.queue.length+(this.current?1:0)<4,'WORD_BUSY','已有文档正在加载，请稍后重试。',429);
    job={...context,leases:new Set([leaseId]),state:manifest?'ready':'queued',phase:manifest?'阅读缓存已就绪':'等待后台解析',manifest,lastUsed:Date.now()};this.jobs.set(context.key,job);
    if(manifest)void utimes(join(context.folder,'manifest.json'),new Date(),new Date()).catch(()=>{});else{this.queue.push(job);this.pump()}
    this.trim();return{...this.public(job),leaseId};
  }
  async status(projectId,objectId) {
    const context=await this.context(projectId,objectId),job=this.jobs.get(context.key);
    if(job){if(job.done&&!['queued','running'].includes(job.state))await job.done;return this.public(job)}
    const manifest=await this.manifest(context);return manifest?{state:'ready',segments:manifest.pages.length,counts:manifest.counts,warnings:manifest.warnings,metrics:{parseElapsedMs:manifest.elapsedMs,peakWorkingSetBytes:manifest.peakWorkingSetBytes}}:{state:'missing'};
  }
  async cancel({projectId,objectId,leaseId}) {
    check(typeof leaseId==='string'&&/^[a-f0-9-]{36}$/.test(leaseId),'INVALID_INPUT','阅读请求身份无效。');
    this.store.object(projectId,objectId);const job=[...this.jobs.values()].find(job=>job.projectId===projectId&&job.leases.has(leaseId));if(!job)return;
    job.leases.delete(leaseId);job.lastUsed=Date.now();
    if(!job.leases.size&&['queued','running'].includes(job.state)){job.cancelled=true;job.child?.kill();if(job.state==='queued'){job.state='cancelled';this.queue=this.queue.filter(x=>x!==job)}}
    this.trim();
  }
  trim(){const idle=[...this.jobs.values()].filter(j=>!j.leases.size&&!['queued','running'].includes(j.state));for(const job of idle)if(this.jobs.size>=8)this.jobs.delete(job.key)}
  pump(){if(this.closed||this.current)return;const job=this.queue.shift();if(!job)return;if(job.cancelled){this.pump();return}this.current=job;job.done=this.run(job).finally(()=>{this.current=null;this.pump()})}
  async removeOwned(base,folder) {
    const canonical=await realpath(base),destination=await this.physical(folder);
    check(destination!==canonical&&inside(canonical,destination),'PATH_OUTSIDE_PROJECT','缓存清理路径无效。',403);
    await rm(folder,{recursive:true,force:true});
  }
  async run(job) {
    const stage=join(job.base,`.building-${randomUUID()}`);job.state='running';job.phase='正在后台读取 Word 正文、表格与图片';job.stage=stage;
    try{
      await mkdir(stage,{recursive:false});if(job.cancelled)throw Error('cancelled');
      await new Promise((accept,reject)=>{
        const child=spawn(this.python,['-I','-X','utf8',this.script,'--source',job.source,'--output',stage,'--sha256',job.sha256],{windowsHide:true,stdio:['ignore','pipe','pipe']});job.child=child;let output='',timedOut=false;
        const timer=setTimeout(()=>{timedOut=true;child.kill()},this.timeoutMs);timer.unref?.();
        child.stdout.on('data',chunk=>{if(output.length<16000)output+=chunk.toString('utf8')});child.stderr.on('data',()=>{});
        child.on('error',error=>{clearTimeout(timer);reject(error)});
        child.on('close',code=>{clearTimeout(timer);job.child=null;if(job.cancelled)return reject(Error('cancelled'));if(timedOut)return reject(new StoreError('WORD_TIMEOUT','Word 解析超时，可用原应用查看或拆分文档。'));if(code!==0){let message;try{message=JSON.parse(output.trim()).message}catch{}return reject(new StoreError('WORD_PARSE_FAILED',message||'Word 读取失败，请使用原应用查看。'))}accept()});
      });
      const manifest=await this.manifest({...job,folder:stage});check(manifest,'WORD_PARSE_FAILED','未生成阅读缓存。');if(job.cancelled)throw Error('cancelled');
      // Only our disposable cache is replaced; the Word and its saved version are read-only.
      await this.removeOwned(job.base,job.folder);await rename(stage,job.folder);job.manifest=manifest;job.state='ready';job.phase='Word 阅读已就绪';
      await this.prune(job.base).catch(()=>{});
    }catch(error){job.state=job.cancelled?'cancelled':'failed';job.phase=job.cancelled?'阅读已关闭，解析已停止':'Word 阅读未完成';job.error=job.cancelled?null:error instanceof StoreError?error.message:error.code==='ENOENT'?'未找到本机 Python 3，请使用原应用打开 Word。':'Word 读取未完成，原文件保持不变。';await this.removeOwned(job.base,stage).catch(()=>{})}
    finally{job.child=null;job.stage=null;this.trim()}
  }
  async prune(base) {
    const caches=[];
    for(const entry of await readdir(base,{withFileTypes:true}))if(entry.isDirectory()&&!entry.isSymbolicLink()&&/^[a-f0-9]{64}-r1$/.test(entry.name)){
      const folder=join(base,entry.name),path=join(folder,'manifest.json');let manifest;try{if((await stat(path)).size>2*1024*1024)continue;manifest=JSON.parse(await readFile(path,'utf8'))}catch{continue}
      if(manifest.schemaVersion!==1||manifest.readerVersion!==READER)continue;
      caches.push({folder,age:(await stat(path)).mtimeMs,bytes:Object.values(manifest.assets||{}).reduce((n,x)=>n+x.bytes,0)+(manifest.pages||[]).reduce((n,x)=>n+x.bytes,0)});
    }
    let size=caches.reduce((n,x)=>n+x.bytes,0),count=caches.length;
    for(const cache of caches.sort((a,b)=>a.age-b.age)){if(size<=MAX_CACHE&&count<=6)break;const job=this.jobs.get(cache.folder);if(job?.leases.size)continue;await this.removeOwned(base,cache.folder);this.jobs.delete(cache.folder);size-=cache.bytes;count--}
  }
  async asset(projectId,objectId,{page,image}) {
    const context=await this.context(projectId,objectId),manifest=this.jobs.get(context.key)?.manifest||await this.manifest(context);check(manifest,'WORD_NOT_READY','Word 阅读尚未就绪。',409);
    if(image!==undefined){check(/^[a-z]+-[0-9]+\.(png|jpe?g|gif)$/.test(image)&&manifest.assets?.[image],'INVALID_WORD_ASSET','未找到此 Word 图片。',404);const file=await this.store.projectPath(projectId,relative(this.store.project(projectId).root_path,join(context.folder,image)));check((await stat(file)).size<=12*1024*1024,'CONTENT_TOO_LARGE','图片过大。',413);return{bytes:await readFile(file),contentType:MIME[extname(image)]}}
    check(Number.isInteger(page)&&page>=0&&page<manifest.pages.length,'INVALID_WORD_PAGE','阅读分段不存在。',404);
    const file=await this.store.projectPath(projectId,relative(this.store.project(projectId).root_path,join(context.folder,`page-${page}.json`)));check((await stat(file)).size<=1024*1024,'CONTENT_TOO_LARGE','阅读分段过大。',413);return{bytes:await readFile(file),contentType:'application/json; charset=utf-8'};
  }
  async dispose(){this.closed=true;for(const job of this.queue){job.cancelled=true;job.state='cancelled'}this.queue=[];if(this.current){this.current.cancelled=true;this.current.child?.kill();await this.current.done}this.jobs.clear()}
}
