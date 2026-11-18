import {randomUUID} from 'node:crypto';
import {readFile,unlink} from 'node:fs/promises';
import {StoreError} from './store.mjs';
import {wordCommand,WORD_ACTIONS} from '../shared/word-live.mjs';

const check=(ok,code,message,status=409)=>{if(!ok)throw new StoreError(code,message,status)};
/** Ephemeral requests target one live editor; mutations are never replayed. */
export class WordLiveControl {
  constructor(runtime,{timeoutMs=90000,leaseMs=5000}={}){this.runtime=runtime;this.timeoutMs=timeoutMs;this.leaseMs=leaseMs;this.editors=new Map();this.pending=new Map();this.contexts=new Map()}
  key(p,o){return `${p}:${o}`}
  owner(sessionId){const snapshot=this.runtime.nativeWriting.snapshot(sessionId);check(snapshot.input.format==='docx','WORD_NOT_OPEN','请打开当前文稿的 Word 编辑模式。');return snapshot}
  poll({projectId,objectId,instanceId,release=false}){
    this.runtime.store.object(projectId,objectId);check(typeof instanceId==='string'&&/^[a-f0-9-]{36}$/.test(instanceId),'INVALID_INPUT','Word 编辑器身份无效。',400);
    const key=this.key(projectId,objectId),old=this.editors.get(key);
    if(release){if(old?.id===instanceId){this.editors.delete(key);for(const item of this.pending.values())if(item.key===key)item.finish(new StoreError('WORD_CLOSED','Word 编辑器已关闭；请检查保存状态后再操作。'))}return{request:null}}
    const running=[...this.pending.values()].some(item=>item.key===key&&item.state==='running');
    check(!old||old.id===instanceId||Date.now()-old.seen>this.leaseMs&&!running,'WORD_EDITOR_OWNED','当前文稿已在另一个编辑窗口连接。');
    this.editors.set(key,{id:instanceId,seen:Date.now()});
    const item=[...this.pending.values()].find(item=>item.key===key&&item.instanceId===instanceId&&item.state==='queued');
    if(!item)return{request:null};
    const active=this.runtime.nativeWriting.findSession(item.sessionId),input=active&&JSON.parse(active.input);
    if(active?.id!==item.jobId||input?.nativeTurn!==item.turn){item.finish(new StoreError('CONTEXT_CHANGED','文稿会话或本轮要求已变化，操作已取消。'));return{request:null}}
    item.state='running';return{request:{id:item.id,kind:item.kind,contextId:item.contextId,plan:item.plan}};
  }
  acknowledge({projectId,objectId,instanceId,id,result,error}){
    const item=this.pending.get(id);if(!item)return{accepted:false};
    check(item.key===this.key(projectId,objectId)&&item.instanceId===instanceId,'INVALID_BINDING','操作回执不属于当前 Word。',403);
    if(error){item.finish(new StoreError('WORD_EDIT_FAILED',String(error).slice(0,1000)));return{accepted:true}}
    check(result&&typeof result==='object'&&Number.isInteger(result.revision),'INVALID_INPUT','Word 回执缺少版本。',400);
    if(this.runtime.store.object(projectId,objectId).revision!==result.revision){
      item.finish(new StoreError('VERSION_CONFLICT','Word 已产生其他版本，请重新读取当前正文和历史记录。'));
      return {accepted:true};
    }
    if(item.plan?.action==='replace_text'){
      if(item.committed?.revision!==result.revision)item.finish(new StoreError('WORD_NOT_SAVED','正文写入尚无保存回执。'));
      else item.finish(null,item.committed);
      return {accepted:true};
    }
    if(item.kind==='edit')check(result.saved===true,'WORD_NOT_SAVED','编辑器尚未确认保存。');
    item.finish(null,result);return{accepted:true};
  }
  request(sessionId,kind,options={},signal){
    const {row,input}=this.owner(sessionId),key=this.key(row.project_id,input.objectId),editor=this.editors.get(key);
    check(editor&&Date.now()-editor.seen<this.leaseMs,'WORD_NOT_OPEN','当前 Word 编辑器未连接。请打开此文稿的编辑模式后重试。');
    check(![...this.pending.values()].some(item=>item.key===key),'WORD_BUSY','当前文稿还有一项操作未完成。');signal?.throwIfAborted();
    return new Promise((resolve,reject)=>{
      const id=randomUUID(),item={id,key,instanceId:editor.id,kind,...options,sessionId,jobId:row.id,turn:input.nativeTurn,state:'queued'};
      const abort=()=>item.finish(new StoreError('WORD_CANCELLED',item.state==='queued'?'Word 操作已取消。':'操作已交付编辑器，结果待确认；请检查文稿与 Git 历史，不要自动重试。'));
      const timer=setTimeout(()=>item.finish(new StoreError('WORD_TIMEOUT',item.state==='queued'?'Word 编辑器未领取操作，已取消。':'Word 操作结果未确认，请检查文稿与 Git 历史，不要自动重试。',504)),this.timeoutMs);timer.unref?.();
      item.finish=(error,result)=>{if(!this.pending.delete(id))return;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve({...result,instanceId:editor.id})};
      this.pending.set(id,item);signal?.addEventListener('abort',abort,{once:true});
    });
  }
  async context(sessionId,signal,{query,offset=0}={}){
    check(query===undefined || typeof query==='string'&&query.trim()&&query.length<=1000,'INVALID_INPUT','请提供要查找的原文片段。',400);
    check(Number.isSafeInteger(offset)&&offset>=0,'INVALID_INPUT','搜索页偏移无效。',400);
    const before=this.owner(sessionId),result=await this.request(sessionId,'context',{plan:query?{query}:undefined},signal);
    if(query){
      const word=this.runtime.wordEditing;
      const {row,path}=await word.source(before.row.project_id,before.input.objectId);
      check(row.revision===result.revision,'VERSION_CONFLICT','Word 已更新，请重新查找。');
      result.search=await word.inspect({path,wordText:{query,offset,sha256:row.sha256}});
    }
    const after=this.owner(sessionId);
    check(before.row.id===after.row.id&&before.input.nativeTurn===after.input.nativeTurn,'CONTEXT_CHANGED','对话目标已更新，请重新读取 Word。');
    check(typeof result.contextId==='string'&&result.contextId.length<=80,'INVALID_INPUT','Word 上下文身份无效。',400);
    this.contexts.set(sessionId,{id:result.contextId,jobId:after.row.id,turn:after.input.nativeTurn,instanceId:result.instanceId,revision:result.revision});
    return {...result,capabilities:WORD_ACTIONS};
  }
  async edit(sessionId,args,signal){
    try{wordCommand(args)}catch(error){throw new StoreError('INVALID_WORD_ACTION',error.message,400)}
    const {row,input}=this.owner(sessionId),context=this.contexts.get(sessionId);
    check(context&&context.id===args.contextId&&context.jobId===row.id&&context.turn===input.nativeTurn,'CONTEXT_REQUIRED','请先读取当前轮次的 Word 编辑器上下文。');
    check(input.instruction?.trim(),'CONTEXT_REQUIRED','请先在当前对话提出编辑要求。');
    check(typeof args.reason==='string'&&args.reason.trim().length>0&&args.reason.length<=500,'INVALID_INPUT','请提供简短操作说明。',400);
    check(this.editors.get(this.key(row.project_id,input.objectId))?.id===context.instanceId&&this.runtime.store.object(row.project_id,input.objectId).revision===context.revision,'VERSION_CONFLICT','Word 版本或窗口已变化，请重新读取。');
    this.contexts.delete(sessionId);
    return this.request(sessionId,'edit',{contextId:context.id,revision:context.revision,plan:args},signal);
  }
  applyText({projectId,objectId,instanceId,id}){
    const item=this.pending.get(id);
    check(item?.state==='running'&&item.plan?.action==='replace_text'&&item.key===this.key(projectId,objectId)
      &&item.instanceId===instanceId,'INVALID_BINDING','正文写入请求已失效，请重新读取当前 Word。');
    item.write ??= this.commitText(projectId,objectId,item);
    return item.write;
  }
  async commitText(projectId,objectId,item){
    const beforeSave=()=>{
      const {row,input}=this.owner(item.sessionId);
      check(this.pending.get(item.id)===item&&row.id===item.jobId&&input.nativeTurn===item.turn
        &&this.editors.get(item.key)?.id===item.instanceId,'CONTEXT_CHANGED','文稿窗口或对话轮次已变化。');
    };
    beforeSave();
    const word=this.runtime.wordEditing,{row,path}=await word.source(projectId,objectId);
    check(row.revision===item.revision,'VERSION_CONFLICT','Word 已更新，请重新查找原文。');
    const output=await word.temporary(projectId);
    try{
      const {replaced}=await word.inspect({path,output,wordText:{sha256:row.sha256,replacements:item.plan.replacements}});
      const revision=await word.save({projectId,objectId,expectedRevision:row.revision,bytes:await readFile(output)},{
        validated:true,beforeSave,historyAction:'对话修改正文 · '+item.plan.reason,
        afterSave:revision=>this.runtime.store.db.prepare("UPDATE jobs SET input=json_set(input,'$.directWordEdit',json(?)) WHERE id=?")
          .run(JSON.stringify({turn:item.turn,revision,replaced}),item.jobId),
      });
      item.committed={saved:true,action:'replace_text',revision,replaced};
      return item.committed;
    }finally{await unlink(output).catch(()=>{})}
  }
  dispose(){for(const item of this.pending.values())item.finish(new StoreError('WORD_CLOSED','Word 服务已关闭，请检查文稿保存状态。'));this.contexts.clear();this.editors.clear()}
}
