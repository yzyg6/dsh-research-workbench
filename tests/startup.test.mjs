import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/client/api.mjs';
import { TaskRunner } from '../src/server/jobs.mjs';
import { WorkspaceRuntime } from '../src/server/runtime.mjs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

test('opening joins the background state request and a subsequent project change invalidates the preload', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let reads = 0;
  let activeProjectId = 'paper-a';
  globalThis.fetch = async (url, init) => {
    if (init.method === 'POST') activeProjectId = JSON.parse(init.body).data.projectId;
    else if (!url.endsWith('stamp=1')) reads++;
    return Response.json({ projects: [], activeProjectId, stamp: activeProjectId });
  };
  const api = createApi();
  const warming = api.preload();
  assert.equal((await api.bootstrap({ usePreload: true })).activeProjectId, 'paper-a');
  await warming;
  assert.equal(reads, 1);
  await api.preload();
  await api.mutate('activateProject', { projectId: 'paper-b' });
  assert.equal((await api.bootstrap({ usePreload: true })).activeProjectId, 'paper-b');
  assert.equal(reads, 3);
});

test('opening while the Host registers routes recovers without reloading DSH', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => ++calls < 3
    ? new Response('<html>Host starting</html>', { status: 503 })
    : Response.json({ schemaVersion: 1, projects: [], activeProjectId: null, stamp: 'ready' });
  try {
    const state = await createApi().bootstrap();
    assert.equal(state.stamp, 'ready');
    assert.equal(calls, 3);
  } finally { globalThis.fetch = original; }
});

test('closing during startup cancels retries and a failed save is never replayed', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('Host starting', { status: 503 }); };
  try {
    const api = createApi(), controller = new AbortController();
    const opening = api.bootstrap({ signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    controller.abort();
    await assert.rejects(opening, { name: 'AbortError' });
    await assert.rejects(api.mutate('saveObject', {}), { code: 'SERVICE_UNAVAILABLE' });
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test('an invalid successful response retries but a real authorization error is immediate', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? Response.json({ unrelatedHost: true }) : Response.json({ projects: [], stamp: 'ready' });
  try {
    assert.equal((await createApi().bootstrap()).stamp, 'ready');
    assert.equal(calls, 2);
    globalThis.fetch = async () => { calls++; return Response.json({ code: 'FORBIDDEN', error: 'Access denied' }, { status: 403 }); };
    await assert.rejects(createApi().bootstrap(), { code: 'FORBIDDEN' });
    assert.equal(calls, 3);
  } finally { globalThis.fetch = original; }
});

test('compact state reads only the visible document and loads a newly selected file after switching', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const out = join(root, '_scratch/out/startup-tests'); await mkdir(out, { recursive: true });
  const runtime = new WorkspaceRuntime({ root: await mkdtemp(join(out, 'catalog-')), sampleRoot: join(root, 'samples/figure'), publicRoot: join(root, 'public'), trustedTransport: false });
  try {
    const projectId = await runtime.store.createProject({ title: '合成启动性能测试' });
    const large = 'synthetic hidden content '.repeat(15000);
    const objectId = await runtime.store.createObject({ projectId, kind: 'evidence', title: 'hidden-evidence', text: large });
    const bytesFor = runtime.store.bytesFor.bind(runtime.store), reads = [];
    runtime.store.bytesFor = row => { reads.push(row.id); return bytesFor(row); };
    const read = () => runtime.handle(new Request('http://localhost/api/research-workbench/state?summary=1')).then(r => r.json());
    const state = await read();
    const hidden = state.projects[0].objects.find(o => o.id === objectId);
    assert.equal(hidden.textLoaded, false);
    assert(!reads.includes(objectId), 'a hidden document must not be read or hashed at startup');
    assert(JSON.stringify(state).length < large.length / 4, 'opening cannot transfer every imported document');
    const switched = await runtime.handle(new Request('http://localhost/api/research-workbench/mutate', { method: 'POST', headers: { 'content-type': 'application/json', 'x-research-state': 'summary' }, body: JSON.stringify({ action: 'saveTaskState', data: { projectId, task: 'writing', patch: { selectedObjectId: objectId } } }) })).then(r => r.json());
    const selected = switched.projects[0].objects.find(o => o.id === objectId);
    assert.equal(selected.textLoaded, true);
    assert.equal(selected.text, large);
    assert(reads.includes(objectId));
    assert.equal((await runtime.store.state()).projects[0].objects.find(o => o.id === objectId).text, large, 'full-state compatibility remains available');
    for (let i = 0; i < 12; i++) await runtime.store.createObject({ projectId, kind: 'manuscript', title: `draft-${i}`, text: '# Synthetic manuscript' });
    let scans = 0;
    const conversations = runtime.nativeWriting.conversations.bind(runtime.nativeWriting);
    runtime.nativeWriting.conversations = (...args) => { scans++; return conversations(...args); };
    await runtime.viewState({ summary: true });
    assert.equal(scans, 1, 'opening multiple manuscripts must share one conversation scan per project');
  } finally { await runtime.dispose(); }
});

test('background jobs cannot delay service startup until the job completes', async () => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const running = new Promise(resolve => { entered = resolve; });
  let claimed = false;
  const runner = new TaskRunner({
    async recoverJobs() {},
    async claimJob() { if (claimed) return null; claimed = true; return { id: 'queued-paper-check', type: 'project.integrity' }; },
    async runJob() { entered(); await gate; },
  });
  try {
    let ready = false;
    const starting = runner.start().then(() => { ready = true; });
    await running;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ready, true, 'startup must publish readiness while a durable background job is still running');
    release(); await starting;
  } finally { release(); await runner.stop(); }
});
