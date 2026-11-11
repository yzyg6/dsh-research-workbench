import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,copyFile,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {WorkspaceRuntime} from '../src/server/runtime.mjs';
import {NativeSentenceAdapter} from '../src/client/native-sentence-adapter.mjs';
import {resolveProjectWorkspace} from '../src/server/workspaces.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),out=join(root,'_scratch/out/document-conversations');await mkdir(out,{recursive:true});
const sid='session-00000000-1111-2222-3333-444444444444',otherSid='session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
async function setup(t){
  const directory=await mkdtemp(join(out,'case-')),r=new WorkspaceRuntime({root:join(directory,'catalog'),sampleRoot:join(root,'samples/figure'),publicRoot:join(root,'public')});
  t.after(async()=>{if(!r.store.closed)await r.dispose()});
  const p=await r.store.createProject({title:'逐文件对话合成测试'}),workspace=r.store.project(p).root_path;
  await promisify(execFile)('python',['-I',join(root,'probes/word-reader/create-fixture.py'),'--output',join(workspace,'paper','初稿.docx'),'--paragraphs','2'],{windowsHide:true});
  await copyFile(join(workspace,'paper','初稿.docx'),join(workspace,'paper','修改稿.docx'));
  const a=await r.store.importWorkspaceFile({projectId:p,path:'paper/初稿.docx',openOriginal:true}),b=await r.store.importWorkspaceFile({projectId:p,path:'paper/修改稿.docx',openOriginal:true});
  r.nativeWriting.validateSession=async()=>{};return{r,p,a,b,workspace,directory};
}
test('different Word files have isolated conversations under the same paper workspace, including across restart',async t=>{
  const{r,p,a,b,directory}=await setup(t);
  const ja=await r.nativeWriting.open({projectId:p,objectId:a});await r.nativeWriting.bind({projectId:p,jobId:ja,sessionId:sid});
  const jb=await r.nativeWriting.open({projectId:p,objectId:b});
  assert.equal(JSON.parse(r.writing.row(p,jb).input).nativeSessionId,undefined,'another Word must not reuse the first Word conversation');
  await r.nativeWriting.bind({projectId:p,jobId:jb,sessionId:otherSid});
  assert.equal(r.nativeWriting.thread(p,a).sessionId,sid);assert.equal(r.nativeWriting.thread(p,b).sessionId,otherSid);
  await assert.rejects(r.nativeWriting.open({projectId:p,objectId:b,sessionId:sid}),{code:'INVALID_BINDING'});
  assert.deepEqual(r.nativeWriting.conversations(p,a).map(x=>x.sessionId),[sid]);
  await r.dispose();const restored=new WorkspaceRuntime({root:join(directory,'catalog'),sampleRoot:join(root,'samples/figure'),publicRoot:join(root,'public')});
  try{assert.equal(restored.nativeWriting.thread(p,a).sessionId,sid);assert.equal(restored.nativeWriting.thread(p,b).sessionId,otherSid)}finally{await restored.dispose()}
});
test('saving the Word workspace version retains its filename, document identity and native conversation',async t=>{
  const{r,p,a,workspace}=await setup(t),original=await readFile(join(workspace,'paper','初稿.docx'));
  const j=await r.nativeWriting.open({projectId:p,objectId:a});await r.nativeWriting.bind({projectId:p,jobId:j,sessionId:sid});
  const changed=join(workspace,'Temp','changed.docx');await promisify(execFile)('python',['-I',join(root,'probes/word-reader/create-fixture.py'),'--output',changed,'--paragraphs','3'],{windowsHide:true});
  await r.wordEditing.save({projectId:p,objectId:a,expectedRevision:1,bytes:await readFile(changed)});
  const managed=r.store.object(p,a),path=JSON.parse(managed.metadata).workspaceFile;
  assert.equal(JSON.parse(managed.metadata).wordEditable,true);assert.notEqual(path,'paper/初稿.docx');
  const again=await r.nativeWriting.open({projectId:p,objectId:a});assert.equal(JSON.parse(r.writing.row(p,again).input).nativeSessionId,sid);
  await promisify(execFile)('python',['-I',join(root,'probes/word-reader/create-fixture.py'),'--output',changed,'--paragraphs','4'],{windowsHide:true});
  await r.wordEditing.save({projectId:p,objectId:a,expectedRevision:managed.revision,bytes:await readFile(changed)});
  assert.equal(JSON.parse(r.store.object(p,a).metadata).workspaceFile,path);assert.deepEqual(await readFile(join(workspace,'paper','初稿.docx')),original);
  assert.equal((await readdir(join(workspace,'paper'))).filter(name=>name.endsWith('.docx')).length,3,'two originals and exactly one persistent workspace Word');
});
test('a delayed or malicious bind cannot attach one Word conversation to another Word',async t=>{
  const{r,p,a,b}=await setup(t),ja=await r.nativeWriting.open({projectId:p,objectId:a});await r.nativeWriting.bind({projectId:p,jobId:ja,sessionId:sid});
  const jb=await r.nativeWriting.open({projectId:p,objectId:b});
  await assert.rejects(r.nativeWriting.bind({projectId:p,jobId:jb,sessionId:sid}),{code:'SESSION_ALREADY_OWNED'});
  assert.equal(r.nativeWriting.snapshot(sid).input.objectId,a);
});
test('a saved binding is revalidated and repaired after workspace attachment failure without a replacement session',async t=>{
  const{r,p,a}=await setup(t),j=await r.nativeWriting.open({projectId:p,objectId:a});let attach=0;
  r.nativeWriting.attachSession=async()=>{if(++attach===1)throw Error('synthetic registry offline');return{workspaceId:'workspace-paper'}};
  const project=(await r.viewState()).projects.find(x=>x.id===p),getJob=()=>r.store.publicJob(r.writing.row(p,j));let creates=0;
  const adapter=new NativeSentenceAdapter({mutate:(action,args)=>r.mutate(action,args)});t.after(()=>adapter.dispose());
  adapter.setSessions({async create(){creates++;return sid},refresh:async()=>{},retain(){return{ready:Promise.resolve(),release(){}}}});
  assert.equal((await adapter.ensure(project,getJob())).status,'failed');
  assert.equal(getJob().nativeSessionId,sid,'failed workspace linking must retain the allocated native identity');
  assert.equal((await adapter.ensure(project,getJob())).status,'ready');assert.equal(attach,2);assert.equal(creates,1);
});
test('an already saved session must still be checked by the server before rendering the native conversation',async()=>{
  let checks=0;const adapter=new NativeSentenceAdapter({async mutate(){checks++;throw Error('wrong workspace')}});
  adapter.setSessions({refresh:async()=>{},retain(){return{ready:Promise.resolve(),release(){}}}});
  try{const record=await adapter.ensure({id:'p',rootPath:'synthetic'},{id:'j',objectId:'o',nativeSessionId:sid});assert.equal(checks,1);assert.equal(record.status,'failed')}finally{adapter.dispose()}
});
test('manual reconnect rechecks workspace ownership even for an already mounted session without creating another chat',async()=>{
  let checked=0,created=0;const job={id:'j',objectId:'o',nativeSessionId:sid},project={id:'p',rootPath:'synthetic'},adapter=new NativeSentenceAdapter({async mutate(){checked++;return{projects:[{id:'p',jobs:[job]}]}}});
  adapter.setSessions({create:async()=>{created++;return sid},refresh:async()=>{},retain:()=>({ready:Promise.resolve(),release(){}})});
  try{await adapter.ensure(project,job);await adapter.ensure(project,job,undefined,{verify:true});assert.equal(checked,2);assert.equal(created,0)}finally{adapter.dispose()}
});
test('paper checkpoint restores both document identities and their native conversation links into a fresh catalog',async t=>{
  const{r,p,a,b,workspace,directory}=await setup(t);
  for(const[objectId,sessionId]of[[a,sid],[b,otherSid]]){const jobId=await r.nativeWriting.open({projectId:p,objectId});await r.nativeWriting.bind({projectId:p,jobId,sessionId})}
  await r.dispose();const fresh=new WorkspaceRuntime({root:join(directory,'fresh-catalog'),sampleRoot:join(root,'samples/figure'),publicRoot:join(root,'public')});
  try{assert.equal(await fresh.store.openWorkspace({path:workspace}),p);assert.equal(fresh.nativeWriting.thread(p,a).sessionId,sid);assert.equal(fresh.nativeWriting.thread(p,b).sessionId,otherSid)}finally{await fresh.dispose()}
});
test('concurrent Word conversations resolve exactly one native paper workspace',async()=>{
  let created=0;const workspace={id:'one-paper',sessionIds:[]},registry={resolveByPath:async()=>null,create:async()=>{created++;return workspace}},project={root_path:out,title:'synthetic'};
  const result=await Promise.all(Array.from({length:12},()=>resolveProjectWorkspace(registry,project)));assert.equal(created,1);assert(result.every(value=>value===workspace));
});
test('a delayed reconnect of an old conversation cannot replace a newly chosen conversation for the same Word',async t=>{
  const{r,p,a}=await setup(t),old=await r.nativeWriting.open({projectId:p,objectId:a});await r.nativeWriting.bind({projectId:p,jobId:old,sessionId:sid});
  const next=await r.nativeWriting.open({projectId:p,objectId:a,newThread:true});
  await assert.rejects(r.nativeWriting.bind({projectId:p,jobId:old,sessionId:sid}),{code:'THREAD_CHANGED'});
  assert.equal(r.nativeWriting.thread(p,a).jobId,next);await r.nativeWriting.bind({projectId:p,jobId:next,sessionId:otherSid});
});
test('legacy mixed-file conversation history stays intact but future turns belong only to its last active document',async t=>{
  const{r,p,a,b}=await setup(t),ja=await r.nativeWriting.open({projectId:p,objectId:a});await r.nativeWriting.bind({projectId:p,jobId:ja,sessionId:sid});
  const jb=await r.nativeWriting.open({projectId:p,objectId:b});
  await r.store.write(()=>{const input=JSON.parse(r.writing.row(p,jb).input);input.nativeSessionId=sid;r.store.db.prepare('UPDATE jobs SET input=? WHERE id=?').run(JSON.stringify(input),jb);r.store.db.prepare('DELETE FROM preferences WHERE key=? OR key LIKE ?').run(`sentenceSession:${sid}`,`sentenceThread:${p}:%`);r.store.db.prepare('UPDATE preferences SET value=? WHERE key=?').run(JSON.stringify({key:input.nativeThreadKey,sessionId:sid,jobId:jb}),`sentenceThread:${p}`)});
  assert.equal(r.nativeWriting.thread(p,a),null);assert.equal(r.nativeWriting.thread(p,b).sessionId,sid);
  const opened=await r.nativeWriting.open({projectId:p,objectId:a});assert.equal(JSON.parse(r.writing.row(p,opened).input).nativeSessionId,undefined);
  await assert.rejects(r.nativeWriting.bind({projectId:p,jobId:opened,sessionId:sid}),{code:'SESSION_ALREADY_OWNED'});
  assert.equal(JSON.parse(r.writing.row(p,ja).input).nativeSessionId,sid,'legacy job history must remain untouched');
});
test('legacy migration respects the actively viewed older selection instead of the most recent job from another Word',async t=>{
  const{r,p,a,b}=await setup(t),ja=await r.nativeWriting.open({projectId:p,objectId:a});await r.nativeWriting.bind({projectId:p,jobId:ja,sessionId:sid});const jb=await r.nativeWriting.open({projectId:p,objectId:b});
  await r.store.write(()=>{const input=JSON.parse(r.writing.row(p,jb).input);input.nativeSessionId=sid;r.store.db.prepare('UPDATE jobs SET input=? WHERE id=?').run(JSON.stringify(input),jb);r.store.db.prepare('DELETE FROM preferences WHERE key=? OR key LIKE ?').run(`sentenceSession:${sid}`,`sentenceThread:${p}:%`);const older=JSON.parse(r.writing.row(p,ja).input);r.store.db.prepare('UPDATE preferences SET value=? WHERE key=?').run(JSON.stringify({key:older.nativeThreadKey,sessionId:sid,jobId:ja}),`sentenceThread:${p}`)});
  const reopened=await r.nativeWriting.open({projectId:p,objectId:a});assert.equal(JSON.parse(r.writing.row(p,reopened).input).nativeSessionId,sid);assert.equal(r.nativeWriting.sessionOwner(sid).objectId,a);
  const other=await r.nativeWriting.open({projectId:p,objectId:b});assert.equal(JSON.parse(r.writing.row(p,other).input).nativeSessionId,undefined);
});
