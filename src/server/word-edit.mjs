import { readFile, writeFile, mkdir, unlink, stat } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {PythonWorker} from './python-worker.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { StoreError } from './store.mjs';
import { DEFAULT_SENTENCE_PROMPT } from './writing.mjs';
import { reviewWordRange } from './review-word-range.mjs';

const check=(ok,code,message,status=400)=>{if(!ok)throw new StoreError(code,message,status)};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const now=()=>new Date().toISOString();
function commentTarget(finding, date) {
  const {id, issue, suggestion, steps, prompt, path} = finding;
  return {id, issue, suggestion, steps, prompt, author:path.at(-1), date};
}
export class WordEditing {
  constructor(store,{script=fileURLToPath(new URL('./word-edit.py',import.meta.url))}={}){this.store=store;this.script=script;this.pending=0;this.tail=Promise.resolve();this.worker=store?(store.wordWorker||=new PythonWorker(script)):null;this.warming=new Map()}
  warmHistory(projectId,objectId){
    const key=`${projectId}:${objectId}:${this.store.object(projectId,objectId).sha256}`;if(this.warming.has(key))return this.warming.get(key);
    const operation=this.store.write(async()=>{await this.source(projectId,objectId);await this.store.documentHistory.ensure(projectId,objectId)}).catch(error=>{this.warming.delete(key);throw error});
    this.warming.set(key,operation);if(this.warming.size>24)this.warming.delete(this.warming.keys().next().value);return operation;
  }
  inspect(args){
    check(this.pending<4,'WORD_BUSY','Word 正在保存或检查，请稍后重试。',429);this.pending++;
    const operation=this.tail.then(async()=>{const worker=this.worker||new PythonWorker(this.script);try{return await worker.call(args)}finally{if(!this.worker)await worker.close()}}).catch(error=>{throw new StoreError('WORD_INVALID',error.message||'Word 检查未通过，原文件保留。')});this.tail=operation.catch(()=>{});return operation.finally(()=>{this.pending--});
  }
  async source(projectId,objectId){
    const row=this.store.object(projectId,objectId);check(row.kind==='manuscript'&&row.encoding==='binary'&&/\.docx$/i.test(JSON.parse(row.metadata).workspaceFile||row.path),'INVALID_WORD','请选择 .docx 正文。');
    const path=await this.store.projectPath(projectId,row.path);check((await stat(path)).size<=32*1024*1024,'WORD_TOO_LARGE','Word 编辑上限为32 MiB。',413);
    const digest=createHash('sha256');for await(const chunk of createReadStream(path))digest.update(chunk);check(digest.digest('hex')===row.sha256,'EXTERNAL_CHANGE','Word 版本已在外部变化，请重新扫描后核对。',409);return{row,path};
  }
  async context(projectId,objectId){const {path}=await this.source(projectId,objectId);return(await this.inspect({path})).text}
  async temporary(projectId){const layout=await this.store.workspaceFiles.layout(projectId),folder=await this.store.projectPath(projectId,join(layout.directories.temp,'dsh-workbench','word-edit'));await mkdir(folder,{recursive:true});return join(folder,randomUUID()+'.docx')}
  async saveInteractive(args){
    const {projectId,objectId,expectedRevision,bytes}=args;
    const current=this.store.object(projectId,objectId);
    if(current.revision===expectedRevision+1&&Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=32*1024*1024){
      const resolution=JSON.parse(current.metadata).wordCommentResolution;
      if(resolution?.revision===current.revision){
        const {adopted}=this.adoptedReviewComments(projectId,objectId,resolution.reviewId);
        const draft=await this.temporary(projectId),merged=await this.temporary(projectId);
        try{
          await writeFile(draft,bytes,{flag:'wx'});
          const result=await this.inspect({path:draft,output:merged,resolveReviewComments:adopted.map(item=>item.target)});
          const revision=await this.save({...args,expectedRevision:current.revision,bytes:result.changed?await readFile(merged):bytes},
            {validated:true,showComments:true,historyAction:'保存 Word 编辑并同步批注状态'});
          return {revision,reopen:true};
        }catch(error){
          if(!(error instanceof StoreError)||!['WORD_INVALID','WORD_BUSY','VERSION_CONFLICT','EXTERNAL_CHANGE'].includes(error.code))throw error;
        }finally{await Promise.all([unlink(draft).catch(()=>{}),unlink(merged).catch(()=>{})])}
      }
      const review=this.store.db.prepare("SELECT input,output FROM jobs WHERE project_id=? AND type='writing.review' AND json_extract(input,'$.objectId')=? AND json_extract(output,'$.commentRevision')=?").get(projectId,objectId,current.revision);
      if(review){
        const input=JSON.parse(review.input),output=JSON.parse(review.output);
        if((output.commentBaseRevision??current.revision-1)===expectedRevision&&output.findings?.length){
          const draft=await this.temporary(projectId),merged=await this.temporary(projectId);
          try{
            await writeFile(draft,bytes,{flag:'wx'});
            const outline=await this.inspect({path:draft,reviewOutline:true});
            const sameSnapshot=isDeepStrictEqual(outline.paragraphs,input.paragraphs)&&isDeepStrictEqual(outline.sections.map((section,index)=>({...section,id:index+1})),input.sections);
            const findings=output.findings.map(item=>{
              if(sameSnapshot)return {...item,author:item.path.at(-1)};
              const targets=outline.sections.filter(section=>isDeepStrictEqual(section.path,item.path))
                .flatMap(section=>section.paragraphs.filter(p=>p.anchorable&&outline.paragraphs[p.index]===input.paragraphs[item.index]));
              return targets.length===1?{...item,index:targets[0].index,author:item.path.at(-1)}:null;
            });
            if(findings.every(Boolean)){
              await this.inspect({path:draft,output:merged,reviewComments:findings,reviewCommentDate:output.commentDate});
              const revision=await this.save({...args,expectedRevision:current.revision,bytes:await readFile(merged)},
                {validated:true,showComments:true,historyAction:'保存 Word 编辑并同步审阅批注'});
              return{revision,reopen:true};
            }
          }catch(error){
            if(error instanceof StoreError&&!['VERSION_CONFLICT','EXTERNAL_CHANGE','WORD_INVALID'].includes(error.code))throw error;
          }finally{await Promise.all([unlink(draft).catch(()=>{}),unlink(merged).catch(()=>{})]);}
        }
      }
    }
    return{revision:await this.save(args),reopen:false};
  }
  async save({projectId,objectId,expectedRevision,bytes},{beforeSave,afterSave,validated=false,historyAction,restoredFrom,reviewComments=false,showComments=false,commentStateReview}={}){
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
      if(reviewComments||commentStateReview)next.wordReviewUpdate={fromRevision:object.revision,revision};
      if(commentStateReview)next.wordCommentResolution={reviewId:commentStateReview,revision};
      if(reviewComments||showComments)next.wordCommentViewRevision=revision;
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
  async enqueue({projectId,objectId,expectedRevision,wordSelection,revisionMode,reviewFinding,instruction=DEFAULT_SENTENCE_PROMPT,operationKey},{nativeThreadKey}={}){
    check(typeof instruction==='string'&&instruction.length<=6000&&typeof operationKey==='string'&&operationKey.length<=160,'INVALID_INPUT','修改要求无效。');
    const chapter = revisionMode === 'chapter';
    check(wordSelection&&typeof wordSelection.text==='string'&&wordSelection.text.length<=(chapter?18000:8000),'INVALID_SELECTION',chapter?'请选择一个较短的小节正文。':'请选择一句正文。');
    const {row,path}=await this.source(projectId,objectId);check(row.revision===expectedRevision,'VERSION_CONFLICT','Word 已更新，请重新选句。',409);
    const parsed=await this.inspect({path,...(chapter?{chapterSelection:wordSelection}:{selection:wordSelection})});check(parsed.text.length<=180000,'ARTICLE_TOO_LARGE','当前全文上下文上限为18万字。',413);
    return this.store.write(()=>{
      check(this.store.object(projectId,objectId).revision===expectedRevision,'VERSION_CONFLICT','Word 已更新，请重新选句。',409);
      const existing=this.store.db.prepare('SELECT id FROM jobs WHERE project_id=? AND operation_key=?').get(projectId,operationKey);if(existing)return existing.id;
      const project=this.store.project(projectId),id=`j_${randomUUID()}`,stamp=now();
      const input={native:true,format:'docx',...(nativeThreadKey?{nativeThreadKey}:{}),objectId,expectedRevision,wordSelection,selectedText:chapter?parsed.chapterParagraphs.join('\n\n'):parsed.selectedText,markdown:parsed.text,sha256:row.sha256,instruction,keywords:'',question:project.question,journal:project.journal,language:project.language};
      if(chapter)Object.assign(input,{conversationKind:'chapter',chapterParagraphs:parsed.chapterParagraphs,chapterSurroundings:parsed.chapterSurroundings});
      if(parsed.hasComments)input.wordComments=true;
      if(typeof reviewFinding==='string'&&/^j_[\da-f-]{36}:\d+-\d+$/.test(reviewFinding))input.reviewFinding=reviewFinding;
      this.store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,projectId,'writing.sentence','draft','Word 选句已准备，等待原生对话',JSON.stringify(input),null,null,operationKey,null,stamp,stamp);return id;
    });
  }
  reviewTarget(projectId, input, proposal) {
    const [reviewId, findingId] = input.batchFindingId ? [proposal.parent_job_id,input.batchFindingId] : (input.reviewFinding || '').split(':');
    if (!reviewId || !findingId) return null;
    const audit = this.store.db.prepare("SELECT output FROM jobs WHERE project_id=? AND id=? AND type='writing.review' AND json_extract(input,'$.objectId')=?").get(projectId, reviewId, input.objectId);
    const value = audit && JSON.parse(audit.output);
    const finding = value?.commentRevision && value.findings.find(item=>item.id===findingId);
    return finding ? commentTarget(finding,value.commentDate) : null;
  }
  async apply(writing,{projectId,jobId,proposalUpdatedAt,liveRevision=false}){
    const row=writing.row(projectId,jobId),input=JSON.parse(row.input),output=row.output&&JSON.parse(row.output);
    check(row.status==='succeeded'&&output?.review==='pending','REVISION_NOT_READY','此建议当前不能采用。',409);
    if(input.batchTarget&&proposalUpdatedAt)check(row.updated_at===proposalUpdatedAt,'PROPOSAL_CHANGED','修改稿已更新，请重新核对后采用。',409);
    const {row:object,path}=await this.source(projectId,input.objectId);
    if(object.revision!==input.expectedRevision){
      check(input.batchTarget,'VERSION_CONFLICT','Word 已更新，请重新选句。',409);
      const current=await this.inspect({path,reviewOutline:true});
      let target;
      try{target=reviewWordRange(current,input.batchTarget)}catch(error){if(!(error instanceof StoreError))throw error}
      check(target&&target.wordSelection.text===input.wordSelection.text&&isDeepStrictEqual(target.chapterBlocks,input.batchTarget.chapterBlocks),
        'REVIEW_BATCH_CONFLICT','这条建议的原文区间已修改或无法唯一定位。请重新生成这条修改稿。',409);
      input.wordSelection=target.wordSelection;
      input.expectedRevision=object.revision;
    }
    const temporary=await this.temporary(projectId),relative=join('.research-workbench','undo','word',input.objectId,`${jobId}-${randomUUID()}.json.gz`),undo=await this.store.projectPath(projectId,relative);let committed=false;
    await mkdir(join(undo,'..'),{recursive:true});
    const chapter=input.conversationKind==='chapter';
    const linkedReview=Boolean(input.batchTarget||input.reviewFinding);
    const patch=chapter?{chapterSelection:input.wordSelection,chapterReplacement:output.proposal.paragraphs}:{selection:input.wordSelection,replacement:output.proposal.replacement,preserveRuns:linkedReview};
    if(liveRevision&&linkedReview)patch.liveRevision=true;
    const comment=this.reviewTarget(projectId,input,row);
    if(comment)patch.resolveReviewComments=[comment];
    try{const edited=await this.inspect({path,...patch,output:temporary,undo});const commentState=edited.reviewCommentStates?.[0];const result=await this.save({projectId,objectId:input.objectId,expectedRevision:input.expectedRevision,bytes:await readFile(temporary)},{validated:true,showComments:commentState==='resolved',historyAction:(chapter?'采用章节优化：':'采用修改：')+output.proposal.reason.slice(0,120),beforeSave:()=>{
      const latest=writing.row(projectId,jobId);
      check(latest.status==='succeeded'&&latest.output===row.output&&latest.input===row.input,'PROPOSAL_CHANGED','建议已更新，请重新查看对照后采用。',409);
    },afterSave:revision=>{output.review='adopted';output.appliedRevision=revision;output.expectedRevision=input.expectedRevision;output.adoptedAt=now();output.wordUndo={path:relative,sha256:edited.undoSha256};if(commentState)output.wordReviewComment=commentState;this.store.db.prepare("UPDATE jobs SET input=?,output=?,phase='已采用并保存 Word 工作副本',updated_at=? WHERE id=?").run(JSON.stringify(input),JSON.stringify(output),now(),jobId)}});committed=true;return {revision:result,liveRevision:edited.liveRevision}}finally{await unlink(temporary).catch(()=>{});if(!committed)await unlink(undo).catch(()=>{})}
  }
  adoptedReviewComments(projectId,objectId,jobId) {
    const lookup=this.store.db.prepare("SELECT output FROM jobs WHERE project_id=? AND id=? AND type='writing.review' AND json_extract(input,'$.objectId')=?");
    const audit=lookup.get(projectId,jobId,objectId);
    check(audit,'REVIEW_NOT_FOUND','当前文稿中没有这轮审阅。',404);
    const {findings,decisions,commentDate,commentRevision}=JSON.parse(audit.output);
    const draft=this.store.db.prepare("SELECT id,input,output,parent_job_id FROM jobs WHERE project_id=? AND id=? AND type='writing.sentence' AND json_extract(input,'$.objectId')=?");
    const adopted=[];
    for(const finding of commentRevision?findings:[]){
      const id=decisions[finding.id]?.jobId;
      const job=id&&draft.get(projectId,id,objectId);
      const state=job?.output&&JSON.parse(job.output);
      if(state?.review==='adopted'&&this.reviewTarget(projectId,JSON.parse(job.input),job)?.id===finding.id)adopted.push({job,state,target:commentTarget(finding,commentDate)});
    }
    return {lookup,audit,draft,adopted};
  }
  async syncReviewComments({projectId,objectId,jobId,expectedRevision}) {
    const {row:object,path}=await this.source(projectId,objectId);
    check(object.revision===expectedRevision,'VERSION_CONFLICT','Word 已更新，请重新核对批注。',409);
    const {lookup,audit,draft,adopted}=this.adoptedReviewComments(projectId,objectId,jobId);
    if(!adopted.length)return {revision:object.revision,resolved:0};
    const latest=adopted.find(item=>item.state.appliedRevision===object.revision&&item.state.wordUndo);
    const relative=latest&&join('.research-workbench','undo','word',objectId,`comment-sync-${randomUUID()}.json.gz`);
    const undo=relative&&await this.store.projectPath(projectId,relative);
    const temporary=await this.temporary(projectId);
    let committed=false;
    try {
      const targets=adopted.map(item=>item.target);
      const result=await this.inspect({path,output:temporary,resolveReviewComments:targets,undo});
      const resolved=result.reviewCommentStates.filter(state=>state==='resolved').length;
      if(!result.changed)return {revision:object.revision,resolved,unmatched:targets.length-resolved};
      const revision=await this.save({projectId,objectId,expectedRevision,bytes:await readFile(temporary)}, {
        validated:true, showComments:true, commentStateReview:jobId, historyAction:'同步已采用建议的 Word 批注状态',
        beforeSave:()=>{
          check(lookup.get(projectId,jobId,objectId)?.output===audit.output&&adopted.every(({job})=>draft.get(projectId,job.id,objectId)?.output===job.output),
            'PROPOSAL_CHANGED','审阅状态已更新，请重新同步。',409);
        },
        afterSave:revision=>{
          const update=this.store.db.prepare('UPDATE jobs SET output=?,updated_at=? WHERE id=?');
          for(const [index,item] of adopted.entries()){
            item.state.wordReviewComment=result.reviewCommentStates[index];
            if(item===latest){
              item.state.appliedRevision=revision;
              const otherTargets=adopted.filter((entry,i)=>entry!==latest&&result.reviewCommentStates[i]==='resolved').map(entry=>entry.target);
              item.state.wordCommentSync=[...(item.state.wordCommentSync||[]),{path:relative,sha256:result.undoSha256,otherTargets}];
            }
            update.run(JSON.stringify(item.state),now(),item.job.id);
          }
        },
      });
      committed=true;
      return {revision,resolved,unmatched:targets.length-resolved};
    } finally {
      await unlink(temporary).catch(()=>{});
      if(undo&&!committed)await unlink(undo).catch(()=>{});
    }
  }
  async undo(writing,{projectId,jobId}){
    const row=writing.row(projectId,jobId),input=JSON.parse(row.input),output=row.output&&JSON.parse(row.output);check(output?.review==='adopted','REVISION_NOT_ADOPTED','此建议尚未采用或已经撤回。',409);
    const current=await this.source(projectId,input.objectId);check(current.row.revision===output.appliedRevision,'VERSION_CONFLICT','采用后正文已有修改，不能直接撤回。',409);
    let bytes;
    const temporary=[];
    const allocate=async()=>{const file=await this.temporary(projectId);temporary.push(file);return file};
    try{
      if(output.wordUndo){
        let restored=current.path;
        const sync=output.wordCommentSync||[];
        for(const receipt of [...sync].reverse().concat(output.wordUndo)){
          const undo=await this.store.projectPath(projectId,receipt.path);
          check((await stat(undo)).size<=48*1024*1024,'WORD_INVALID','撤回记录超过上限。');
          check(hash(await readFile(undo))===receipt.sha256,'EXTERNAL_CHANGE','撤回记录已变化，当前文稿保留。',409);
          const destination=await allocate();
          await this.inspect({path:restored,undo,output:destination,restoreUndo:true});
          restored=destination;
        }
        const otherTargets=sync.flatMap(item=>item.otherTargets);
        if(otherTargets.length){
          const destination=await allocate();
          if((await this.inspect({path:restored,output:destination,resolveReviewComments:otherTargets})).changed)restored=destination;
        }
        bytes=await readFile(restored);
      }
      else{const prior=this.store.db.prepare('SELECT path,sha256 FROM object_versions WHERE project_id=? AND object_id=? AND revision=?').get(projectId,input.objectId,input.expectedRevision);check(prior,'VERSION_NOT_FOUND','原 Word 存档未找到。',404);bytes=await readFile(await this.store.projectPath(projectId,prior.path));check(hash(bytes)===prior.sha256,'EXTERNAL_CHANGE','原 Word 存档已变化，未撤回。',409)}
      return await this.save({projectId,objectId:input.objectId,expectedRevision:output.appliedRevision,bytes},{validated:true,showComments:output.wordReviewComment==='resolved',historyAction:'撤回上次采用',beforeSave:()=>check(writing.row(projectId,jobId).output===row.output,'ALREADY_REVIEWED','此建议已处理。',409),afterSave:revision=>{output.review='undone';output.undoneRevision=revision;output.undoneAt=now();delete output.wordReviewComment;this.store.db.prepare("UPDATE jobs SET output=?,phase='已撤回并更新同一 Word 工作副本',updated_at=? WHERE id=?").run(JSON.stringify(output),now(),jobId)}});
    }finally{await Promise.all(temporary.map(file=>unlink(file).catch(()=>{})))}
  }
}
