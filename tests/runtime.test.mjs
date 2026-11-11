import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkspaceRuntime, boundProjectContext } from '../src/server/runtime.mjs';
import { writeFile } from 'node:fs/promises';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = join(root, '_scratch/out/phase1-tests'); await mkdir(out, { recursive: true });
async function make() { return new WorkspaceRuntime({ root: await mkdtemp(join(out, 'runtime-')), sampleRoot: join(root, 'samples/figure'), publicRoot: join(root, 'public'), trustedTransport: false }); }
const request = (action, data, origin) => new Request('http://127.0.0.1:4384/api/research-workbench/mutate', { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify({ action, data }) });

test('async project snapshots cannot carry a newer stamp and suppress all future refreshes',async()=>{
  const runtime=await make();try{
    const a=await runtime.store.createProject({title:'snapshot A'}),b=await runtime.store.createProject({title:'snapshot B'});await runtime.store.activateProject(a);
    const read=runtime.store.state.bind(runtime.store);let calls=0;
    runtime.store.state=async()=>{const state=await read();if(calls++===0)await runtime.store.activateProject(b);return state};
    const state=await runtime.viewState();assert.equal(state.activeProjectId,b);assert.equal(state.stamp,runtime.stamp());assert.equal(calls,2);
  }finally{await runtime.dispose()}
});

test('continuous writes bound snapshot retries and leave an older stamp for the next poll',async()=>{
  const runtime=await make();try{
    const a=await runtime.store.createProject({title:'busy A'}),b=await runtime.store.createProject({title:'busy B'});await runtime.store.activateProject(a);
    const read=runtime.store.state.bind(runtime.store);let calls=0;
    runtime.store.state=async()=>{const state=await read();calls++;await runtime.store.activateProject(state.activeProjectId===a?b:a);return state};
    const state=await runtime.viewState();assert.equal(calls,3);assert.notEqual(state.stamp,runtime.stamp());
  }finally{await runtime.dispose()}
});

test('business routes work without any native model/session service', async () => {
  const runtime = await make();
  const result = await runtime.handle(request('createProject', { title: '离线资料仍可用' })); assert.equal(result.status, 200);
  const state = await result.json(); assert.equal(state.projects.length, 1);
  const project = state.projects[0], object = project.objects[0];
  const saved = await runtime.handle(request('saveObject', { projectId: project.id, objectId: object.id, expectedRevision: 1, text: '原生会话不可用时仍可保存的 Markdown。' }));
  assert.equal(saved.status, 200); assert.equal((await saved.json()).projects[0].objects[0].revision, 2);
  const stale = await runtime.handle(request('saveObject', { projectId: project.id, objectId: object.id, expectedRevision: 1, text: '旧内容' }));
  assert.equal(stale.status, 409); assert.equal((await stale.json()).code, 'VERSION_CONFLICT');
  await runtime.dispose();
});
test('local web mutation rejects cross-origin requests and malformed commands', async () => {
  const runtime = await make();
  assert.equal((await runtime.handle(request('createProject', { title: 'unexpected' }, 'https://untrusted.example'))).status, 403);
  assert.equal((await runtime.handle(request('arbitrary-file-write', { path: '../outside' }))).status, 400);
  assert.equal((await runtime.store.state()).projects.length, 0);
  await runtime.dispose();
});
test('project tools resolve by session ownership, independent of the visible project', async () => {
  const runtime = await make(), a = await runtime.store.createProject({ title: '项目 A' }), b = await runtime.store.createProject({ title: '项目 B' });
  const aSession = 'session-12345678-1234-1234-1234-123456789abc';
  await runtime.store.bindSession({ projectId: a, task: 'figure', sessionId: aSession });
  await runtime.store.activateProject(b);
  assert.equal(boundProjectContext(runtime.store, aSession).project.id, a);
  const objectB = (await runtime.store.state()).projects.find((p) => p.id === b).objects[0];
  assert.throws(() => boundProjectContext(runtime.store, aSession, { objectId: objectB.id }), { code: 'OBJECT_NOT_FOUND' });
  assert.throws(() => boundProjectContext(runtime.store, 'unbound-session'), { code: 'UNBOUND_SESSION' });
  await runtime.dispose();
});
test('optional integration failures cannot turn an already committed save into a false failure', async () => {
  const runtime = await make(); runtime.onMutation(() => { throw new Error('native integration missing'); });
  const response = await runtime.handle(request('createProject', { title: '保存回执准确' }));
  assert.equal(response.status, 200); assert.equal((await response.json()).projects.length, 1);
  await runtime.dispose();
});

test('native fixture is absent by default, scoped to existing projects, and unavailable on the browser transport', async () => {
  const runtime = await make();
  const a = await runtime.store.createProject({ title: 'synthetic A' }), b = await runtime.store.createProject({ title: 'synthetic B' });
  runtime.trustedTransport = true;
  assert.equal((await runtime.viewState()).nativeAcceptance, null);
  await mkdir(join(runtime.store.root, 'diagnostics'));
  const path = join(runtime.store.root, 'diagnostics/native-acceptance-plan.json');
  await writeFile(path, JSON.stringify({ schemaVersion: 1, runId: 'test-only', mode: 'restore', projects: [{ projectId: a, role: 'A' }, { projectId: b, role: 'B' }] }));
  const plan = (await runtime.viewState()).nativeAcceptance;
  assert.equal(plan.entries.length, 6); assert.equal(plan.mode, 'restore');
  assert.equal(plan.entries[0].marker, 'RW-A-WRITE-20261109');
  runtime.trustedTransport = false; assert.equal((await runtime.viewState()).nativeAcceptance, null);
  await runtime.dispose();
});
