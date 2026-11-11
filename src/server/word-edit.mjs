import { readFile, writeFile, mkdir, unlink, stat } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { StoreError } from './store.mjs';
import { DEFAULT_SENTENCE_PROMPT } from './writing.mjs';

const check=(ok,code,message,status=400)=>{if(!ok)throw new StoreError(code,message,status)};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const now=()=>new Date().toISOString();
export class WordEditing {
  constructor(store,{script=fileURLToPath(new URL('./word-edit.py',import.meta.url))}={}){this.store=store;this.script=script;this.pending=0;this.tail=Promise.resolve()}
  inspect(args){
    check(this.pending<4,'WORD_BUSY','Word 正在保存或检查，请稍后重试。',429);this.pending++;
    const operation=this.tail.then(()=>new Promise((resolve,reject)=>{
      const child=spawn('python',['-I','-X','utf8',this.script],{windowsHide:true,stdio:['pipe','pipe','pipe']});let output='',overflow=false;
      const timer=setTimeout(()=>{child.kill();reject(new StoreError('WORD_TIMEOUT','Word 检查超时，当前编辑内容仍保留。',504))},30000);timer.unref?.();
      child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{if(output.length+chunk.length>2*1024*1024){overflow=true;child.kill()}else output+=chunk.toString('utf8')});child.stderr.resume();
      child.on('error',()=>{clearTimeout(timer);reject(new StoreError('WORD_UNAVAILABLE','未找到可用的本机 Python，Word 保存未完成。',503))});
      child.on('close',code=>{clearTimeout(timer);let result;try{result=JSON.parse(output)}catch{}if(code!==0||!result||overflow)reject(new StoreError('WORD_INVALID',result?.error||'Word 检查未通过，原文件保留。'));else resolve(result)});
      child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(args));
    }));this.tail=operation.catch(()=>{});return operation.finally(()=>{this.pending--});
  }
  async source(projectId,objectId){
    const row=this.store.object(projectId,objectId);check(row.kind==='manuscript'&&row.encoding==='binary'&&/\.docx$/i.test(JSON.parse(row.metadata).workspaceFile||row.path),'INVALID_WORD','请选择 .docx 正文。');
    const path=await this.store.projectPath(projectId,row.path);check((await stat(path)).size<=32*1024*1024,'WORD_TOO_LARGE','Word 编辑上限为32 MiB。',413);
    const digest=createHash('sha256');for await(const chunk of createReadStream(path))digest.update(chunk);check(digest.digest('hex')===row.sha256,'EXTERNAL_CHANGE','Word 版本已在外部变化，请重新扫描后核对。',409);return{row,path};
  }
  async context(projectId,objectId){const {path}=await this.source(projectId,objectId);return(await this.inspect({path})).text}
  async temporary(projectId){const layout=await this.store.workspaceFiles.layout(projectId),folder=await this.store.projectPath(projectId,join(layout.directories.temp,'dsh-workbench','word-edit'));await mkdir(folder,{recursive:true});return join(folder,randomUUID()+'.docx')}
  async save({projectId,objectId,expectedRevision,bytes},{beforeSave,afterSave,validated=false,historyAction,restoredFrom}={}){
    check(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=32*1024*1024,'WORD_TOO_LARGE','Word 保存上限为32 MiB。',413);
    await this.source(projectId,objectId);
    if(!validated){const temporary=await this.temporary(projectId);try{await writeFile(temporary,bytes,{flag:'wx'});await this.inspect({path:temporary})}finally{await unlink(temporary).catch(()=>{})}}
    try{return await this.store.write(()=>this.store.transaction(async()=>{
      const {row:object}=await this.source(projectId,objectId);check(object.revision===expectedRevision,'VERSION_CONFLICT','Word 已有后续修改，当前编辑未覆盖；请先核对。',409);beforeSave?.();
      const metadata=JSON.parse(object.metadata),sha256=hash(bytes);
      await this.store.documentHistory.ensure(projectId,objectId);
      if(sha256===object.sha256){afterSave?.(object.revision);return object.revision}
      const first=!metadata.wordEditable,layout=await this.store.workspaceFiles.layout(projectId);
      const next={...metadata,workspaceReadOnly:true,wordEditable:true,wordStorageMode:'single-copy',wordOriginalFile:metadata.wordOriginalFile||metadata.workspaceFile,bytes:bytes.length};
      if(first)next.workspaceFile=join(layout.directories.paper,`${basename(metadata.workspaceFile||object.title,extname(metadata.workspaceFile||object.title))}_工作台-${objectId.slice(-8)}.docx`);
      const revision=object.revision+1,stamp=now(),paths=await this.store.workspaceFiles.allocate(projectId,{objectId,kind:'manuscript',title:object.title,extension:'.docx',revision,metadata:next,versioned:false});
      // Only the working copy is replaced. The sequence remains for conflict detection.
      await this.store.workspaceFiles.publish(projectId,paths.working,bytes,first?null:object.sha256);
      next.workspaceFile=paths.working;next.sourceMtimeMs=(await stat(await this.store.projectPath(projectId,paths.working))).mtimeMs;const meta=JSON.stringify(next);
      if(metadata.wordStorageMode==='single-copy')check(this.store.db.prepare('UPDATE object_versions SET revision=?,path=?,sha256=?,metadata=?,created_at=? WHERE object_id=? AND project_id=? AND revision=?').run(revision,paths.working,sha256,meta,stamp,objectId,projectId,object.revision).changes===1,'WORD_STATE_CHANGED','工作副本记录已变化，请重新打开项目。',409);
      else this.store.db.prepare('INSERT INTO object_versions VALUES(?,?,?,?,?,?,?,?)').run(objectId,projectId,revision,paths.working,sha256,'binary',meta,stamp);
      this.store.db.prepare('UPDATE objects SET title=?,revision=?,path=?,sha256=?,metadata=?,updated_at=? WHERE id=?').run(first?basename(paths.working):object.title,revision,paths.version,sha256,meta,stamp,objectId);
      this.store.db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(stamp,projectId);afterSave?.(revision);
      await this.store.documentHistory.append(projectId,objectId,bytes,revision,{action:historyAction,restoredFrom});return revision;
    }));}catch(error){
      if(!validated&&['VERSION_CONFLICT','EXTERNAL_CHANGE'].includes(error.code)){
        const layout=await this.store.workspaceFiles.layout(projectId),relative=join(layout.directories.temp,'dsh-workbench','word-recovery',`${objectId}-${hash(bytes).slice(0,16)}.docx`),path=await this.store.projectPath(projectId,relative);await mkdir(join(path,'..'),{recursive:true});await writeFile(path,bytes);error.message+=` 恢复副本已保存：${relative}`;
      }throw error;
    }
  }
  async enqueue({projectId,objectId,expectedRevision,wordSelection,instruction=DEFAULT_SENTENCE_PROMPT,operationKey}){
    check(typeof instruction==='string'&&instruction.length<=6000&&typeof operationKey==='string'&&operationKey.length<=160,'INVALID_INPUT','修改要求无效。');
    check(wordSelection&&typeof wordSelection.text==='string'&&wordSelection.text.length<=8000,'INVALID_SELECTION','请选择一句正文。');
    const {row,path}=await this.source(projectId,objectId);check(row.revision===expectedRevision,'VERSION_CONFLICT','Word 已更新，请重新选句。',409);
    const parsed=await this.inspect({path,selection:wordSelection});check(parsed.text.length<=180000,'ARTICLE_TOO_LARGE','当前全文上下文上限为18万字。',413);
    return this.store.write(()=>{
      check(this.store.object(projectId,objectId).revision===expectedRevision,'VERSION_CONFLICT','Word 已更新，请重新选句。',409);
      const existing=this.store.db.prepare('SELECT id FROM jobs WHERE project_id=? AND operation_key=?').get(projectId,operationKey);if(existing)return existing.id;
      const project=this.store.project(projectId),id=`j_${randomUUID()}`,stamp=now();
      const input={native:true,format:'docx',objectId,expectedRevision,wordSelection,selectedText:parsed.selectedText,markdown:parsed.text,sha256:row.sha256,instruction,keywords:'',question:project.question,journal:project.journal,language:project.language};
      this.store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,projectId,'writing.sentence','draft','Word 选句已准备，等待原生对话',JSON.stringify(input),null,null,operationKey,null,stamp,stamp);return id;
    });
  }
  async apply(writing,{projectId,jobId}){
    const row=writing.row(projectId,jobId),input=JSON.parse(row.input),output=row.output&&JSON.parse(row.output);
    check(row.status==='succeeded'&&output?.review==='pending','REVISION_NOT_READY','此建议当前不能采用。',409);
    const {row:object,path}=await this.source(projectId,input.objectId);check(object.revision===input.expectedRevision,'VERSION_CONFLICT','Word 已更新，请重新选句。',409);
    const temporary=await this.temporary(projectId),relative=join('.research-workbench','undo','word',input.objectId,`${jobId}-${randomUUID()}.json.gz`),undo=await this.store.projectPath(projectId,relative);let committed=false;
    await mkdir(join(undo,'..'),{recursive:true});
    try{const edited=await this.inspect({path,selection:input.wordSelection,replacement:output.proposal.replacement,output:temporary,undo});const result=await this.save({projectId,objectId:input.objectId,expectedRevision:input.expectedRevision,bytes:await readFile(temporary)},{validated:true,historyAction:'采用修改：'+output.proposal.reason.slice(0,120),beforeSave:()=>check(JSON.parse(writing.row(projectId,jobId).output).review==='pending','ALREADY_REVIEWED','此建议已处理。',409),afterSave:revision=>{output.review='adopted';output.appliedRevision=revision;output.adoptedAt=now();output.wordUndo={path:relative,sha256:edited.undoSha256};this.store.db.prepare("UPDATE jobs SET output=?,phase='已采用并保存 Word 工作副本',updated_at=? WHERE id=?").run(JSON.stringify(output),now(),jobId)}});committed=true;return result}finally{await unlink(temporary).catch(()=>{});if(!committed)await unlink(undo).catch(()=>{})}
  }
  async undo(writing,{projectId,jobId}){
    const row=writing.row(projectId,jobId),input=JSON.parse(row.input),output=row.output&&JSON.parse(row.output);check(output?.review==='adopted','REVISION_NOT_ADOPTED','此建议尚未采用或已经撤回。',409);
    const current=await this.source(projectId,input.objectId);check(current.row.revision===output.appliedRevision,'VERSION_CONFLICT','采用后正文已有修改，不能直接撤回。',409);
    let bytes,temporary;
    try{
      if(output.wordUndo){const undo=await this.store.projectPath(projectId,output.wordUndo.path);check((await stat(undo)).size<=48*1024*1024,'WORD_INVALID','撤回记录超过上限。');check(hash(await readFile(undo))===output.wordUndo.sha256,'EXTERNAL_CHANGE','撤回记录已变化，当前文稿保留。',409);temporary=await this.temporary(projectId);await this.inspect({path:current.path,undo,output:temporary,restoreUndo:true});bytes=await readFile(temporary)}
      else{const prior=this.store.db.prepare('SELECT path,sha256 FROM object_versions WHERE project_id=? AND object_id=? AND revision=?').get(projectId,input.objectId,input.expectedRevision);check(prior,'VERSION_NOT_FOUND','原 Word 存档未找到。',404);bytes=await readFile(await this.store.projectPath(projectId,prior.path));check(hash(bytes)===prior.sha256,'EXTERNAL_CHANGE','原 Word 存档已变化，未撤回。',409)}
      return await this.save({projectId,objectId:input.objectId,expectedRevision:output.appliedRevision,bytes},{validated:true,historyAction:'撤回上次采用',beforeSave:()=>check(JSON.parse(writing.row(projectId,jobId).output).review==='adopted','ALREADY_REVIEWED','此建议已处理。',409),afterSave:revision=>{output.review='undone';output.undoneRevision=revision;output.undoneAt=now();this.store.db.prepare("UPDATE jobs SET output=?,phase='已撤回并更新同一 Word 工作副本',updated_at=? WHERE id=?").run(JSON.stringify(output),now(),jobId)}});
    }finally{if(temporary)await unlink(temporary).catch(()=>{})}
  }
}
