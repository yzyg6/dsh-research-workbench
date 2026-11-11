import test from 'node:test';import assert from 'node:assert/strict';import{resolve}from'node:path';
import{installNativeConversationVisibility}from'../src/server/native-session-visibility.mjs';
import{nativeConversationTitle}from'../src/server/native-writing.mjs';
import{NativeSentenceAdapter}from'../src/client/native-sentence-adapter.mjs';

function fixture(){
 const root=resolve('_scratch/out/sidebar-links/paper'),foreign=resolve('_scratch/out/sidebar-links/other'),metadata={blank:true,lastPromptAt:null},projection={kind:'sequenced',asOfSeq:3,values:{sessionListMetadata:metadata,title:'论文修改 · 空对话'}};
 const list={projectionsFor(){return projection},summaryFor(session){return{sessionId:session.header.id,cwd:session.header.cwd,blank:metadata.blank,projections:this.projectionsFor(session.header,session)}},summarizeCold({header}){const projections=this.projectionsFor(header);return{sessionId:header.id,cwd:header.cwd,blank:projections.values.sessionListMetadata.blank,projections}}};
 const original={...list},listeners=new Set(),disposals=[],workspace={path:root,sessionIds:['owned']},runtime={store:{closed:false,projectRows:()=>[{id:'paper',root_path:root}]},nativeWriting:{conversations:()=>[{sessionId:'owned',objectId:'document'}]},integrations:{},onMutation(fn){listeners.add(fn);return()=>listeners.delete(fn)}},ctx={sessionController:{listState:list},get:()=>({list:()=>[workspace]}),effect(fn){disposals.push(fn())}};
 const session={header:{id:'owned',cwd:root}};return{root,foreign,metadata,projection,list,original,listeners,disposals,workspace,runtime,ctx,session};
}
test('owned empty document conversation becomes visible without changing native messages, turns or core blank metadata',()=>{
 const f=fixture();assert.equal(f.list.summaryFor(f.session).blank,true);installNativeConversationVisibility(f.ctx,f.runtime);
 const summary=f.list.summaryFor(f.session);assert.equal(summary.blank,false);assert.equal(summary.projections.values.sessionListMetadata.blank,false);assert.equal(f.metadata.blank,true);assert.equal(f.projection.values.sessionListMetadata.blank,true);assert.equal(summary.projections.asOfSeq,3);assert.equal(f.session.events,undefined);
 f.disposals.reverse().forEach(fn=>fn());assert.equal(f.list.summaryFor,f.original.summaryFor);assert.equal(f.list.summaryFor(f.session).blank,true);assert.equal(f.listeners.size,0);
});
test('unrelated blank conversations and sessions in a wrong workspace remain unchanged',()=>{
 const f=fixture();installNativeConversationVisibility(f.ctx,f.runtime);
 assert.equal(f.list.summaryFor({header:{id:'unrelated',cwd:f.root}}).blank,true);assert.equal(f.list.summaryFor({header:{id:'owned',cwd:f.foreign}}).blank,true);
 f.workspace.sessionIds=[];f.runtime.refreshNativeConversationVisibility();assert.equal(f.list.summaryFor(f.session).blank,true);f.disposals.forEach(fn=>fn());
});
test('cold-start summaries show the same empty document conversation without altering cached projections',()=>{
 const f=fixture();installNativeConversationVisibility(f.ctx,f.runtime);const summary=f.list.summarizeCold(f.session);assert.equal(summary.blank,false);assert.equal(summary.projections.values.sessionListMetadata.blank,false);assert.equal(f.metadata.blank,true);f.disposals.forEach(fn=>fn());
});
test('newly attached sessions are exposed after membership refresh; archived state is not mutated',()=>{
 const f=fixture();f.workspace.sessionIds=[];f.workspace.archivedSessionIds=['owned'];installNativeConversationVisibility(f.ctx,f.runtime);assert.equal(f.list.summaryFor(f.session).blank,true);f.workspace.sessionIds.push('owned');for(const listener of f.listeners)listener();assert.equal(f.list.summaryFor(f.session).blank,false);assert.deepEqual(f.workspace.archivedSessionIds,['owned']);f.disposals.forEach(fn=>fn());
});
test('repeat installation is idempotent and multiple runtimes release the shared presentation adapter safely',()=>{
 const f=fixture();installNativeConversationVisibility(f.ctx,f.runtime);const installed=f.list.summaryFor;installNativeConversationVisibility(f.ctx,f.runtime);assert.equal(f.disposals.length,1);assert.equal(f.list.summaryFor,installed);
 const other={...f.runtime,integrations:{}};installNativeConversationVisibility(f.ctx,other);f.disposals[0]();assert.equal(f.list.summaryFor,installed);f.disposals[1]();assert.equal(f.list.summaryFor,f.original.summaryFor);
});
test('missing native list interfaces fail explicitly without installing partial wrappers',()=>{
 const f=fixture();delete f.list.summarizeCold;assert.throws(()=>installNativeConversationVisibility(f.ctx,f.runtime),{code:'NATIVE_VISIBILITY_UNAVAILABLE'});assert.equal(f.list.summaryFor,f.original.summaryFor);assert.equal(f.disposals.length,0);
});
test('native titles preserve document role and the distinguishing filename suffix within DSH title limits',()=>{
 const title=nativeConversationTitle({title:'synthetic_用于测试标题长度和文件后缀保留的合成文稿_工作台-abcdef12.docx',metadata:JSON.stringify({wordEditable:true})});assert([...title].length<=40);assert(title.includes('工作区版本'));assert(title.endsWith('cdef12.docx'));
});
test('a newly bound blank conversation refreshes the native sidebar after attachment without sending, and later selections reuse it',async()=>{
 const id='session-00000000-1111-2222-3333-444444444444',project={id:'paper',rootPath:'synthetic'},jobs=[{id:'first',objectId:'word',nativeThreadKey:'same-file'},{id:'next-selection',objectId:'word',nativeThreadKey:'same-file'}],events=[];let attached=false,visible=false;
 const adapter=new NativeSentenceAdapter({async mutate(_action,args){events.push('bind');attached=true;return{projects:[{id:project.id,jobs:jobs.map(job=>({...job,nativeSessionId:args.sessionId}))}]}}});
 adapter.setSessions({async create(){events.push('create');return id},async refresh(){events.push('refresh');visible=attached},retain(){events.push('retain');return{ready:Promise.resolve(),release(){},submit(){throw Error('must not send')}}}});
 try{assert.equal((await adapter.ensure(project,jobs[0])).status,'ready');assert.equal(visible,true);assert.deepEqual(events,['create','bind','refresh','retain']);await adapter.ensure(project,jobs[1]);assert.deepEqual(events,['create','bind','refresh','retain','bind'])}finally{adapter.dispose()}
});
