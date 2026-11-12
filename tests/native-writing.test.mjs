import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkspaceRuntime } from '../src/server/runtime.mjs';
import { documentCodec } from '../dist/writing-document.mjs';
import { NativeSentenceAdapter } from '../src/client/native-sentence-adapter.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)), output = join(root, '_scratch/out/native-writing-tests'); await mkdir(output, { recursive: true });
const sid = 'session-00000000-1111-2222-3333-444444444444';
const document = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '沉积物可能影响甲烷排放。' }] }, { type: 'paragraph', content: [{ type: 'text', text: '全文上下文：本研究没有进行因果推断。' }] }] };
const evidence = { sources: [{ id: 'E1', title: '显式测试替身', snippet: '测试片段' }], terms: ['甲烷'], warnings: [], local: 'test-double', zotero: 'test-double' };
const proposal = { replacement: '沉积物可能与甲烷排放相关。', reason: '保留观察性限定。', evidenceIds: ['E1'], warnings: [] };
async function setup() {
  const runtime = new WorkspaceRuntime({ root: await mkdtemp(join(output, 'case-')), sampleRoot: join(root, 'samples/figure'), publicRoot: join(root, 'public') });
  const projectId = await runtime.store.createProject({ title: '原生选句专用测试' }), object = (await runtime.store.state()).projects[0].objects[0];
  const markdown = documentCodec().markdown.serialize(document); await runtime.store.saveObject({ projectId, objectId: object.id, expectedRevision: 1, text: markdown });
  runtime.nativeWriting.validateSession = async () => {};
  runtime.writing.evidence = { retrieve: async () => structuredClone(evidence) };
  const args = { projectId, objectId: object.id, expectedRevision: 2, document, from: 1, to: 13, operationKey: 'native-test' };
  return { runtime, args, markdown };
}
test('preparing a native thread never invokes a model; repeat selections retain one durable identity', async () => {
  const { runtime, args } = await setup(); let calls = 0; runtime.writing.generate = async () => { calls++; throw Error('must not run'); };
  const id = await runtime.nativeWriting.prepare(args), repeat = await runtime.nativeWriting.prepare({ ...args, operationKey: 'different' });
  assert.equal(id, repeat); assert.equal(calls, 0); assert.equal(runtime.writing.row(args.projectId, id).status, 'draft');
  assert.equal(await runtime.store.claimJob(), null);
  await runtime.nativeWriting.bind({ projectId: args.projectId, jobId: id, sessionId: sid });
  const publicJob = (await runtime.store.state()).projects[0].jobs[0];
  assert.equal(publicJob.nativeSessionId, sid); assert.equal(publicJob.native, true);
  assert.equal(runtime.nativeWriting.sessions()[0].session_id, sid);
  const directory = runtime.store.root; await runtime.dispose();
  const restored = new WorkspaceRuntime({ root: directory, sampleRoot: join(root, 'samples/figure'), publicRoot: join(root, 'public') });
  assert.equal(restored.nativeWriting.findSession(sid).id, id); await restored.dispose();
});
test('native conversation captures its own model and actual request, retrieves context, saves suggestions and retains multi-turn history', async () => {
  const { runtime, args, markdown } = await setup(); const id = await runtime.nativeWriting.prepare(args);
  await runtime.nativeWriting.bind({ projectId: args.projectId, jobId: id, sessionId: sid });
  const user = text => [{ role: 'user', source: { kind: 'prompt' }, content: [{ type: 'text', text }] }];
  await runtime.nativeWriting.userTurn(sid, user('改为观察性关联。'), { provider: 'test-native', model: 'chosen-A' }, 1);
  const context = await runtime.nativeWriting.readContext(sid, '甲烷', new AbortController().signal);
  assert.equal(context.article, markdown); assert.equal(context.instruction, '改为观察性关联。');
  await runtime.nativeWriting.propose(sid, { ...proposal, selectionId: id });
  let result = JSON.parse(runtime.writing.row(args.projectId, id).output);
  assert.equal(result.model.model, 'chosen-A'); assert.equal(result.nativeSessionId, sid);
  const stepStamp=runtime.stamp();await runtime.nativeWriting.userTurn(sid,user('改为观察性关联。'),{provider:'test-native',model:'chosen-A'},1);assert.equal(runtime.stamp(),stepStamp,'unchanged model steps must not rewrite the job or trigger another full snapshot');
  await runtime.nativeWriting.userTurn(sid, user('更简洁。'), { provider: 'test-native', model: 'chosen-B' }, 2);
  await assert.rejects(runtime.nativeWriting.propose(sid, { ...proposal, selectionId: id }), { code: 'CONTEXT_REQUIRED' });
  await runtime.nativeWriting.readContext(sid,'甲烷',new AbortController().signal);
  await runtime.nativeWriting.propose(sid, { ...proposal, selectionId: id, replacement: '沉积物或与甲烷排放相关。' });
  result = JSON.parse(runtime.writing.row(args.projectId, id).output);
  assert.equal(result.model.model, 'chosen-B'); assert.equal(result.instruction, '更简洁。'); assert.equal(result.history.length, 1);
  await runtime.nativeWriting.userTurn(sid,user('只讨论格式，保留已有改写建议。'),{provider:'test',model:'chosen-B'},3);
  await runtime.nativeWriting.idle(sid);
  assert.equal(runtime.writing.row(args.projectId,id).status,'succeeded');
  assert.equal(JSON.parse(runtime.writing.row(args.projectId,id).output).proposal.replacement,result.proposal.replacement);
  assert.equal((await runtime.store.asset(args.projectId, args.objectId)).bytes.toString(), markdown);
  await runtime.writing.apply({ projectId: args.projectId, jobId: id });
  await runtime.nativeWriting.userTurn(sid,user('继续调整 Word 字体。'),{provider:'test',model:'chosen-B'},4);
  await runtime.nativeWriting.idle(sid);
  assert.equal(runtime.nativeWriting.snapshot(sid).input.instruction,'继续调整 Word 字体。');
  assert.equal(JSON.parse(runtime.writing.row(args.projectId,id).output).review,'adopted');
  assert.equal(runtime.writing.row(args.projectId,id).status,'succeeded');
  await assert.rejects(runtime.nativeWriting.propose(sid, { ...proposal, selectionId: id }), { code: 'ALREADY_REVIEWED' });
  await runtime.writing.undo({ projectId: args.projectId, jobId: id });
  assert.equal((await runtime.store.asset(args.projectId, args.objectId)).bytes.toString(), markdown);
  assert.equal(runtime.nativeWriting.findSession(sid).id, id); await runtime.dispose();
});
test('native tools reject foreign sessions, unsupported evidence and figure task chats', async () => {
  const { runtime, args } = await setup(), id = await runtime.nativeWriting.prepare(args);
  assert.throws(() => runtime.nativeWriting.snapshot('foreign'), { code: 'UNBOUND_SESSION' });
  await runtime.store.bindSession({ projectId: args.projectId, task: 'figure', sessionId: sid });
  await assert.rejects(runtime.nativeWriting.bind({ projectId: args.projectId, jobId: id, sessionId: sid }), { code: 'SESSION_ALREADY_OWNED' });
  const otherSid = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  await runtime.nativeWriting.bind({ projectId: args.projectId, jobId: id, sessionId: otherSid });
  await assert.rejects(runtime.nativeWriting.propose(otherSid, { ...proposal, selectionId: id }), { code: 'CONTEXT_REQUIRED' });
  await runtime.nativeWriting.userTurn(otherSid, [{ role: 'user', content: [{ type: 'text', text: '润色' }] }], { provider: 'test', model: 'native' }, 1);
  await runtime.nativeWriting.readContext(otherSid, '', new AbortController().signal);
  await assert.rejects(runtime.nativeWriting.propose(otherSid, { ...proposal, selectionId: id, evidenceIds: ['invented'] }), { code: 'UNSUPPORTED_EVIDENCE' });
  const otherProject = await runtime.store.createProject({ title: '另一项目' });
  await assert.rejects(runtime.nativeWriting.bind({ projectId: otherProject, jobId: id, sessionId: otherSid }), { code: 'REVISION_NOT_FOUND' });
  await runtime.dispose();
});

test('the writing task conversation is reused by discussion and successive selections without creating a new chat', async () => {
  const {runtime,args}=await setup();let attached=0,named=0;
  runtime.nativeWriting.attachSession=async(id,project)=>{assert.equal(id,sid);assert.equal(project.id,args.projectId);attached++};runtime.nativeWriting.nameSession=async()=>{named++};
  await runtime.store.bindSession({projectId:args.projectId,task:'writing',sessionId:sid});
  const discussion=await runtime.nativeWriting.open(args);assert.equal(runtime.nativeWriting.findSession(sid).id,discussion);
  const first=await runtime.nativeWriting.prepare(args),next=await runtime.nativeWriting.prepare({...args,from:15,to:20});
  for(const id of [discussion,first,next])assert.equal(JSON.parse(runtime.writing.row(args.projectId,id).input).nativeSessionId,sid);
  assert.equal(runtime.nativeWriting.conversations(args.projectId).length,1);assert.equal(named,1);assert.equal(attached,3);
  const context=await runtime.nativeWriting.readContext(sid,'甲烷');assert.equal(context.selectionId,next);await runtime.dispose();
});

test('only an explicit new conversation starts a fresh thread; old chats remain selectable across reopening', async () => {
  const {runtime,args}=await setup();const first=await runtime.nativeWriting.prepare(args);await runtime.nativeWriting.bind({projectId:args.projectId,jobId:first,sessionId:sid});
  const discussion=await runtime.nativeWriting.open({...args,newThread:true}),secondSid='session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  assert.equal(JSON.parse(runtime.writing.row(args.projectId,discussion).input).nativeSessionId,undefined);
  await runtime.nativeWriting.bind({projectId:args.projectId,jobId:discussion,sessionId:secondSid});
  const selected=await runtime.nativeWriting.prepare(args);assert.notEqual(selected,first);assert.equal(JSON.parse(runtime.writing.row(args.projectId,selected).input).nativeSessionId,secondSid);
  const selectedAgain=await runtime.nativeWriting.prepare(args);assert.equal(selectedAgain,selected);assert.equal(runtime.nativeWriting.conversations(args.projectId).length,2);
  const oldDiscussion=await runtime.nativeWriting.open({...args,sessionId:sid});assert.equal(runtime.nativeWriting.findSession(sid).id,oldDiscussion);assert.equal(runtime.nativeWriting.thread(args.projectId).sessionId,sid);
  await assert.rejects(runtime.nativeWriting.open({...args,sessionId:'session-11111111-2222-3333-4444-555555555555'}),{code:'INVALID_BINDING'});
  const rootPath=runtime.store.root;await runtime.dispose();const restored=new WorkspaceRuntime({root:rootPath,sampleRoot:join(root,'samples/figure'),publicRoot:join(root,'public')});assert.equal(restored.nativeWriting.thread(args.projectId).sessionId,sid);assert.equal(restored.nativeWriting.conversations(args.projectId).length,2);await restored.dispose();
});

test('whole-article discussion reads the latest saved article and cannot silently submit a sentence replacement', async () => {
  const {runtime,args}=await setup(),id=await runtime.nativeWriting.open(args);await runtime.nativeWriting.bind({projectId:args.projectId,jobId:id,sessionId:sid});
  await runtime.store.saveObject({...args,text:'作者后续保存的整篇正文。'});
  await runtime.nativeWriting.userTurn(sid,[{role:'user',content:[{type:'text',text:'讨论整体论证'}]}],{provider:'test',model:'native'},1);
  const context=await runtime.nativeWriting.readContext(sid,'甲烷');assert.equal(context.article,'作者后续保存的整篇正文。');assert.equal(context.conversationOnly,true);
  await assert.rejects(runtime.nativeWriting.propose(sid,{...proposal,selectionId:id}),{code:'NO_SELECTION'});await runtime.nativeWriting.idle(sid);assert.equal(runtime.writing.row(args.projectId,id).status,'draft');await runtime.dispose();
});

test('the native adapter keeps one retained session for multiple simultaneous selections in the same conversation', async () => {
  let creates=0,retains=0,releases=0;const project={id:'project-test',rootPath:'dedicated-synthetic-project'},jobs=[{id:'one',nativeThreadKey:'one-thread'},{id:'two',nativeThreadKey:'one-thread'}];
  const adapter=new NativeSentenceAdapter({async mutate(action,args){assert.equal(action,'bindSentenceSession');return{projects:[{id:project.id,jobs:jobs.map(j=>({...j,nativeSessionId:args.sessionId}))}]}}});
  adapter.setSessions({async create(){creates++;return sid},retain(){retains++;return{ready:Promise.resolve(),release(){releases++}}}});
  const records=await Promise.all(jobs.map(job=>adapter.ensure(project,job)));assert.equal(creates,1);assert.equal(retains,1);assert.equal(records[0].sessionId,records[1].sessionId);
  adapter.dispose();assert.equal(releases,1);
});

test('an older selected conversation remains available after more than fifty newer jobs', async () => {
  const {runtime,args}=await setup(),id=await runtime.nativeWriting.open(args);await runtime.nativeWriting.bind({projectId:args.projectId,jobId:id,sessionId:sid});
  const insert=runtime.store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  for(let i=0;i<60;i++){const at=new Date(Date.UTC(2027,0,1,0,0,i)).toISOString();insert.run(`j_${crypto.randomUUID()}`,args.projectId,'project.integrity','draft','synthetic pagination fixture','{}',null,null,`pagination-${i}`,null,at,at)}
  const state=await runtime.viewState(),project=state.projects.find(p=>p.id===args.projectId);assert(project.jobs.some(j=>j.id===id));assert.equal(project.writingConversations[0].sessionId,sid);await runtime.dispose();
});
test('native requests preserve newer manual edits and a turn without proposal is visibly retryable', async () => {
  const { runtime, args } = await setup(), id = await runtime.nativeWriting.prepare(args);
  await runtime.nativeWriting.bind({ projectId: args.projectId, jobId: id, sessionId: sid });
  await runtime.nativeWriting.userTurn(sid, [{ role: 'user', content: [{ type: 'text', text: '润色' }] }], { provider: 'test', model: 'native' }, 1);
  await runtime.nativeWriting.idle(sid); assert.equal(runtime.writing.row(args.projectId, id).status, 'failed');
  await runtime.nativeWriting.userTurn(sid, [{ role: 'user', content: [{ type: 'text', text: '再试' }] }], { provider: 'test', model: 'native' }, 2);
  await runtime.nativeWriting.readContext(sid, '', new AbortController().signal);
  await runtime.store.saveObject({ ...args, expectedRevision: 2, text: '作者的新稿，不应覆盖。' });
  await runtime.nativeWriting.propose(sid, { ...proposal, selectionId: id }); assert.equal(runtime.writing.row(args.projectId, id).status, 'outdated');
  await assert.rejects(runtime.writing.apply({ projectId: args.projectId, jobId: id }), { code: 'REVISION_NOT_READY' });
  assert.equal((await runtime.store.asset(args.projectId, args.objectId)).bytes.toString(), '作者的新稿，不应覆盖。'); await runtime.dispose();
});
test('native adapter restores the saved sentence session, keeps task chats separate and creates only once', async () => {
  let creates = 0, releases = 0, submits = 0, bound;
  const project = { id: 'project-test', rootPath: 'dedicated-synthetic-project' }, job = { id: 'sentence-job', native: true, nativeSessionId: null };
  const adapter = new NativeSentenceAdapter({ async mutate(action, args) { assert.equal(action, 'bindSentenceSession'); bound = args; return { projects: [{ id: project.id, jobs: [{ ...job, nativeSessionId: args.sessionId }] }] }; } });
  adapter.setSessions({ async create({ cwd }) { assert.equal(cwd, project.rootPath); creates++; return sid; }, refresh: async () => {}, retain(id) { assert.equal(id, sid); return { ready: Promise.resolve(), release() { releases++; }, submit() { submits++; } }; } });
  await Promise.all([adapter.ensure(project, job), adapter.ensure(project, job)]);
  assert.equal(creates, 1); assert.equal(bound.projectId, project.id); assert.equal(submits, 0);
  await adapter.ensure(project, { ...job, nativeSessionId: sid }); assert.equal(creates, 1);
  adapter.dispose(); assert.equal(releases, 1);
});

test('successive selections share one native conversation and stale selection tokens cannot write into the next sentence', async () => {
  const { runtime, args } = await setup(), first = await runtime.nativeWriting.prepare(args);
  await runtime.nativeWriting.bind({ projectId: args.projectId, jobId: first, sessionId: sid });
  const secondArgs = { ...args, from: 15, to: 20 };
  runtime.nativeWriting.sessionStatus = () => 'running';
  await assert.rejects(runtime.nativeWriting.prepare(secondArgs), { code: 'NATIVE_BUSY' });
  runtime.nativeWriting.sessionStatus = () => 'idle';
  const second = await runtime.nativeWriting.prepare(secondArgs);
  assert.notEqual(second, first); assert.equal(runtime.nativeWriting.findSession(sid).id, second);
  assert.equal(runtime.store.publicJob(runtime.writing.row(args.projectId, second)).nativeSessionId, sid);
  assert.equal(runtime.nativeWriting.sessions().length, 1);
  await runtime.nativeWriting.userTurn(sid, [{ role: 'user', content: [{ type: 'text', text: '修改下一句。' }] }], { provider: 'test', model: 'chosen' }, 2);
  const context = await runtime.nativeWriting.readContext(sid, '甲烷', new AbortController().signal);
  assert.equal(context.selectionId, second);
  await assert.rejects(runtime.nativeWriting.propose(sid, { ...proposal, selectionId: first }), { code: 'SELECTION_CHANGED' });
  await runtime.nativeWriting.idle(sid);
  await runtime.nativeWriting.activate({ projectId: args.projectId, jobId: first });
  assert.equal(runtime.nativeWriting.findSession(sid).id, first);
  await runtime.dispose();
});

test('a delayed evidence result cannot be attached to a newer sentence in the shared native conversation',async t=>{
  const {runtime,args}=await setup();t.after(()=>runtime.dispose());const first=await runtime.nativeWriting.prepare(args);
  await runtime.nativeWriting.bind({projectId:args.projectId,jobId:first,sessionId:sid});
  await runtime.nativeWriting.userTurn(sid,[{role:'user',content:[{type:'text',text:'第一句要求。'}]}],{provider:'test',model:'chosen'},1);
  let finish,started;const gate=new Promise(resolve=>finish=resolve),began=new Promise(resolve=>started=resolve);
  runtime.writing.evidence.retrieve=async()=>{started();await gate;return structuredClone(evidence)};
  const pending=runtime.nativeWriting.readContext(sid,'甲烷');await began;
  const second=await runtime.nativeWriting.prepare({...args,from:15,to:20});
  await runtime.nativeWriting.userTurn(sid,[{role:'user',content:[{type:'text',text:'第二句要求。'}]}],{provider:'test',model:'chosen'},2);
  finish();await assert.rejects(pending,{code:'SELECTION_CHANGED'});
  assert.equal(runtime.nativeWriting.findSession(sid).id,second);assert.equal(runtime.nativeWriting.snapshot(sid).input.evidence,undefined);
  await assert.rejects(runtime.nativeWriting.propose(sid,{...proposal,selectionId:second}),{code:'CONTEXT_REQUIRED'});
});
