import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';

function run(command,args,input,options={}) {
  return new Promise((resolve,reject)=>{
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
    Object.assign(env,{GIT_AUTHOR_NAME:'科研工作台',GIT_AUTHOR_EMAIL:'workbench@localhost',GIT_COMMITTER_NAME:'科研工作台',GIT_COMMITTER_EMAIL:'workbench@localhost',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'});
    const commandArgs=command==='git'&&process.platform==='win32'?['-c','core.longpaths=true',...args]:args;
    const child=spawn(command,commandArgs,{windowsHide:true,stdio:['pipe','pipe','pipe'],env,cwd:options.cwd});const chunks=[];let size=0,stderr='';
    const timer=setTimeout(()=>{child.kill();reject(Error('文档历史操作超时；请保留编辑内容并重试。'))},60000);
    child.on('error',error=>{clearTimeout(timer);reject(Error(`文档历史无法运行 ${command}：${error.message}`))});
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>64*1024*1024){child.kill();reject(Error('历史内容超过读取上限。'))}else chunks.push(chunk)});
    child.stderr.on('data',chunk=>{if(stderr.length<2000)stderr+=chunk});
    child.on('close',code=>{clearTimeout(timer);if(code===0)resolve(Buffer.concat(chunks));else if(options.allowFailure)resolve(null);else reject(Error(`文档历史操作失败：${stderr.slice(0,600)}`))});
    child.stdin.on('error',()=>{});child.stdin.end(input);
  });
}
// Keep GIT_DIR relative as well: Git for Windows checks its length before some
// long-path-aware file operations. Never change the caller's cwd or Git config.
const runGit=(directory,args,input,options={})=>run('git',['--git-dir=.',...args],input,{...options,cwd:directory});
/** A private bare repository per document. SQLite transaction rollbacks restore its ref. */
export class DocumentHistory {
  constructor(store){this.store=store;this.repositories=new Map();this.last=new Map()}
  async repository(projectId,objectId){
    const row=this.store.object(projectId,objectId);if(row.kind!=='manuscript')throw Error('请选择论文文稿。');
    const path=await this.store.projectPath(projectId,join('.research-workbench','git',objectId+'.git'));
    const git=(...args)=>runGit(path,args);
    if(this.repositories.has(path))return{...this.repositories.get(path),git};
    await mkdir(path,{recursive:true});
    if(!(await runGit(path,['rev-parse','--is-bare-repository'],null,{allowFailure:true})))await runGit(path,['init','--bare','.']);
    const config=await readFile(join(path,'config'),'utf8'),format=/objectformat\s*=\s*sha256/i.test(config)?'sha256':'sha1';
    this.repositories.set(path,{path,format});return{path,format,git};
  }
  async head(path){
    try{const ref=(await readFile(join(path,'refs/heads/main'),'utf8')).trim();if(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(ref))return ref;throw Error('文稿历史引用无效。')}catch(error){if(error.code!=='ENOENT')throw error}
    try{return(await readFile(join(path,'packed-refs'),'utf8')).split('\n').map(line=>line.split(' ')).find(([,ref])=>ref==='refs/heads/main')?.[0]||null}catch(error){if(error.code==='ENOENT')return null;throw error}
  }
  async text(bytes,encoding){
    if(encoding==='utf8')return bytes.toString('utf8');
    if(this.store.wordWorker)return(await this.store.wordWorker.call({historyBase64:bytes.toString('base64')})).text;
    return(await run('python',['-I','-X','utf8',fileURLToPath(new URL('./history-text.py',import.meta.url))],bytes)).toString('utf8');
  }
  async append(projectId,objectId,bytes,revision,{action='保存文稿',restoredFrom=null}={}){
    const object=this.store.object(projectId,objectId),{path,git,format}=await this.repository(projectId,objectId),parent=await this.head(path);
    const content=createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    const known=this.last.get(path);
    if(parent&&(known?.commit===parent?known.content:(await git('rev-parse',parent+':document')).toString().trim())===content){this.last.set(path,{commit:parent,content});return parent}
    const text=await this.text(bytes,object.encoding);
    const meta={revision,action,restoredFrom,objectId,projectId,title:object.title,encoding:object.encoding,at:new Date().toISOString()};
    const staging='refs/workbench/'+randomUUID(),chunks=[];
    const add=value=>chunks.push(Buffer.isBuffer(value)?value:Buffer.from(value));
    const data=value=>{const bytes=Buffer.isBuffer(value)?value:Buffer.from(value);add(`data ${bytes.length}\n`);add(bytes);add('\n')};
    for(const [index,value]of[bytes,text,JSON.stringify(meta)].entries()){add(`blob\nmark :${index+1}\n`);data(value)}
    add(`commit ${staging}\nmark :4\ncommitter 科研工作台 <workbench@localhost> now\n`);data(`${action} · r${revision}\n`);if(parent)add(`from ${parent}\n`);
    add('M 100644 :1 document\nM 100644 :2 text.txt\nM 100644 :3 metadata.json\n\nget-mark :4\ndone\n');
    let commit;
    try{
      commit=(await runGit(path,['fast-import','--quiet','--date-format=now','--done'],Buffer.concat(chunks))).toString().trim();
      if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit))throw Error('Git 历史提交未返回有效身份。');
      await runGit(path,['update-ref','--stdin'],`start\nupdate refs/heads/main ${commit} ${parent||'0'.repeat(content.length)}\ndelete ${staging} ${commit}\nprepare\ncommit\n`);
    }catch(error){await git('update-ref','-d',staging).catch(()=>{});throw error}
    this.last.set(path,{commit,content});
    this.store.fileRollbacks?.push(async()=>{this.last.delete(path);return parent?git('update-ref','refs/heads/main',parent,commit):git('update-ref','-d','refs/heads/main',commit)});
    return commit;
  }
  async ensure(projectId,objectId){
    const {path}=await this.repository(projectId,objectId),object=this.store.object(projectId,objectId);
    const bytes=await this.store.bytesFor(object);
    // Also captures an externally imported revision before the next workbench edit.
    await this.append(projectId,objectId,bytes,object.revision,{action:await this.head(path)?'同步当前文稿':'开始记录文稿历史'});
  }
  async list(projectId,objectId,offset=0,limit=50){
    const {path,git}=await this.repository(projectId,objectId),head=await this.head(path);
    if(!head)return{entries:[],path,head:null};
    offset=Number.isInteger(offset)&&offset>=0?offset:0;
    limit=Math.max(1,Math.min(50,limit));
    const lines=(await git('log','--format=%H %P','--max-count='+(limit+1),'--skip='+offset,'refs/heads/main')).toString().trim().split('\n').filter(Boolean);
    const entries=[];
    for(const line of lines.slice(0,limit)){
      const [commit,...parents]=line.trim().split(' '),meta=JSON.parse((await git('show',commit+':metadata.json')).toString());
      entries.push({...meta,commit,parents});
    }
    return{path,head,entries,hasMore:lines.length>limit,offset};
  }
  async detail(projectId,objectId,commit){
    if(typeof commit!=='string'||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(commit))throw Error('历史版本标识无效。');
    const {git}=await this.repository(projectId,objectId);
    await git('merge-base','--is-ancestor',commit,'refs/heads/main');
    const meta=JSON.parse((await git('show',commit+':metadata.json')).toString());
    if(meta.projectId!==projectId||meta.objectId!==objectId)throw Error('历史不属于当前文稿。');
    const parents=(await git('show','-s','--format=%P',commit)).toString().trim().split(' ').filter(Boolean);
    return{...meta,commit,parents,text:(await git('show',commit+':text.txt')).toString(),before:parents.length?(await git('show',parents[0]+':text.txt')).toString():''};
  }
  async bytes(projectId,objectId,commit){await this.detail(projectId,objectId,commit);return(await this.repository(projectId,objectId)).git('show',commit+':document')}
}
