import test from 'node:test';import assert from 'node:assert/strict';import {mkdir,mkdtemp} from 'node:fs/promises';import {fileURLToPath} from 'node:url';import {join} from 'node:path';
import {WorkspaceRuntime} from '../src/server/runtime.mjs';import {NativeSentenceAdapter} from '../src/client/native-sentence-adapter.mjs';import {createApi} from '../src/client/api.mjs';
import {PythonWorker} from '../src/server/python-worker.mjs';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const root=fileURLToPath(new URL('../',import.meta.url)),out=join(root,'_scratch/out/workflow-performance-tests');await mkdir(out,{recursive:true});
test('a slow read-only reminders request cannot hold a new sentence preparation behind it',async()=>{
  const original=globalThis.fetch;let release,started;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>started=resolve),calls=[];
  globalThis.fetch=async(_url,options)=>{const action=JSON.parse(options.body).action;calls.push(action);if(action==='reviewReminders'){started();await gate}return Response.json({projects:[],actionResult:{jobId:'prepared'}})};
  try{const api=createApi(),background=api.mutate('reviewReminders',{});await entered;const preparation=api.mutate('prepareSentenceSession',{});await new Promise(resolve=>setImmediate(resolve));assert(calls.includes('prepareSentenceSession'));release();await Promise.all([background,preparation])}finally{release();globalThis.fetch=original}
});
test('a client updated before its Host falls back to bounded stamp polling instead of a busy watch loop',async()=>{
  const original=globalThis.fetch,calls=[];globalThis.fetch=async url=>{calls.push(url);return Response.json({stamp:'legacy'})};
  try{const api=createApi();await api.watchState('legacy');const controller=new AbortController(),waiting=api.watchState('legacy',controller.signal);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,1,'an old Host must not get another immediate full-state request');controller.abort();await assert.rejects(waiting);assert.equal(calls.length,1)}finally{globalThis.fetch=original}
});
test('a new sentence on an already verified document session does not bind or refresh that session again',async()=>{
  const sid='session-00000000-1111-2222-3333-444444444444',project={id:'paper',rootPath:'synthetic'},job={id:'one',objectId:'document',nativeSessionId:sid};let binds=0,refreshes=0;
  const adapter=new NativeSentenceAdapter({async mutate(){binds++;return{projects:[{id:project.id,jobs:[job]}]}}});adapter.setSessions({refresh:async()=>refreshes++,retain:()=>({ready:Promise.resolve(),release(){}})});
  try{await adapter.ensure(project,job);const before={binds,refreshes};const next=await adapter.ensure(project,{...job,id:'two'});assert.equal(next.status,'ready');assert.equal(binds,before.binds);assert.equal(refreshes,before.refreshes);await adapter.ensure(project,job,undefined,{verify:true});assert.equal(binds,before.binds+1)}finally{adapter.dispose()}
});
test('native model writes wake the state watcher directly and cancelled watchers release their listener',async()=>{
  const runtime=new WorkspaceRuntime({root:await mkdtemp(join(out,'watch-')),sampleRoot:join(root,'samples/figure'),publicRoot:join(root,'public')});
  try{await runtime.store.createProject({title:'合成状态通知'});const stamp=runtime.stamp(),watch=runtime.waitForChange(stamp);assert.equal(runtime.store.changeListeners.size,1);
    await runtime.store.write(()=>runtime.store.db.prepare('INSERT INTO preferences VALUES(?,?)').run('synthetic-proposal-notification','saved'));
    assert.notEqual((await watch).stamp,stamp);assert.equal(runtime.store.changeListeners.size,0);
    const controller=new AbortController(),cancelled=runtime.waitForChange(runtime.stamp(),controller.signal);controller.abort();await cancelled;assert.equal(runtime.store.changeListeners.size,0);
  }finally{await runtime.dispose()}
});
test('Word inspections reuse one worker, errors do not poison the next request, and shutdown leaves no process',async()=>{
  const directory=await mkdtemp(join(out,'worker-')),file=join(directory,'synthetic.docx');await promisify(execFile)('python',['-I',join(root,'probes/word-reader/create-fixture.py'),'--output',file,'--paragraphs','3'],{windowsHide:true});
  const worker=new PythonWorker(join(root,'src/server/word-edit.py'));
  try{const first=await worker.call({path:file}),child=worker.child;await assert.rejects(worker.call({path:join(directory,'missing.docx')}));const second=await worker.call({path:file});assert.equal(worker.child,child);assert.equal(second.text,first.text);assert.equal(worker.sequence,3)}finally{await worker.close()}
  assert.equal(worker.child,null);await assert.rejects(worker.call({path:file}),/已关闭/);
});
