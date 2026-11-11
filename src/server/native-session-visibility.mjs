import {resolve} from 'node:path';
import {StoreError} from './store.mjs';

const installationKey=Symbol.for('dsh-research-workbench.native-session-list-visibility');
const canonical=value=>process.platform==='win32'?resolve(value).toLowerCase():resolve(value);

/** A presentation adapter for DSH's provisional-blank sidebar policy.
 * Never changes the native log, projection storage, messages, or turn state.
 * Only document-bound sessions in their verified paper workspace are exposed.
 */
export function installNativeConversationVisibility(ctx,runtime){
  const list=ctx.sessionController?.listState,registry=ctx.get('workspaceRegistry');
  const names=['summaryFor','summarizeCold','projectionsFor'];
  if(!list||!registry||names.some(name=>typeof list[name]!=='function'))throw new StoreError('NATIVE_VISIBILITY_UNAVAILABLE','当前 DSH 会话列表接口尚未就绪，论文对话显示服务需要重新连接。',503);
  let installed=list[installationKey];
  if(!installed){
    const originals=new Map(names.map(name=>[name,{descriptor:Object.getOwnPropertyDescriptor(list,name),method:list[name]}]));
    installed={runtimes:new Map(),originals,wrappers:new Map()};
    const owned=(id,cwd)=>typeof cwd==='string'&&[...installed.runtimes.values()].some(entry=>entry.scopes.get(id)===canonical(cwd));
    const projections=(value,id,cwd)=>{
      const metadata=value?.values?.sessionListMetadata;
      return metadata?.blank===true&&owned(id,cwd)?{...value,values:{...value.values,sessionListMetadata:{...metadata,blank:false}}}:value;
    };
    const summary=value=>value?.blank===true&&owned(value.sessionId,value.cwd)?{...value,blank:false,projections:projections(value.projections,value.sessionId,value.cwd)}:value;
    const wrappers={
      summaryFor:function(...args){return summary(originals.get('summaryFor').method.apply(this,args))},
      summarizeCold:function(...args){return summary(originals.get('summarizeCold').method.apply(this,args))},
      projectionsFor:function(header,...args){return projections(originals.get('projectionsFor').method.call(this,header,...args),header.id,header.cwd)},
    };
    for(const name of names){Object.defineProperty(list,name,{configurable:true,writable:true,value:wrappers[name]});installed.wrappers.set(name,wrappers[name])}
    Object.defineProperty(list,installationKey,{configurable:true,value:installed});
  }
  if(installed.runtimes.has(runtime)){installed.runtimes.get(runtime).refresh();return}
  const entry={scopes:new Map(),refresh:null};
  const refresh=()=>{
    const scopes=new Map();
    if(!runtime.store.closed){
      const workspaces=registry.list();
      for(const project of runtime.store.projectRows()){
        const root=canonical(project.root_path),workspace=workspaces.find(w=>typeof w.path==='string'&&canonical(w.path)===root);
        if(!workspace)continue;
        for(const conversation of [...runtime.nativeWriting.conversations(project.id),...(runtime.wordFormatting?.conversations(project.id)||[])])if(workspace.sessionIds.includes(conversation.sessionId))scopes.set(conversation.sessionId,root);
      }
    }
    entry.scopes=scopes;
  };
  entry.refresh=refresh;installed.runtimes.set(runtime,entry);refresh();
  const off=runtime.onMutation(refresh);runtime.refreshNativeConversationVisibility=refresh;
  runtime.integrations.nativeConversationVisibility='ready';
  let disposed=false;const dispose=()=>{
    if(disposed)return;disposed=true;
    off();installed.runtimes.delete(runtime);
    if(runtime.refreshNativeConversationVisibility===refresh)delete runtime.refreshNativeConversationVisibility;
    if(runtime.disposeNativeConversationVisibility===dispose)delete runtime.disposeNativeConversationVisibility;
    if(!installed.runtimes.size){for(const[name,{descriptor}]of installed.originals){if(list[name]!==installed.wrappers.get(name))continue;if(descriptor)Object.defineProperty(list,name,descriptor);else delete list[name]}if(list[installationKey]===installed)delete list[installationKey]}
    runtime.integrations.nativeConversationVisibility='unavailable';
  };runtime.disposeNativeConversationVisibility=dispose;
  ctx.effect(()=>dispose,'research-workbench: named empty document conversations in native sidebar');
}
