import test from 'node:test';
import assert from 'node:assert/strict';
import { HostAdapter } from '../src/client/host-adapter.mjs';

function setup() {
  let creates = 0, releases = 0;
  const projects = ['A', 'B'].map((id) => ({ id, rootPath: `project-${id}`, bindings: {} }));
  let activeProjectId = 'A';
  const api = { async mutate(_action, data) { const owner = projects.find((p) => p.id === data.projectId); owner.bindings[data.task] = data.sessionId; return { projects: structuredClone(projects), activeProjectId }; } };
  const adapter = new HostAdapter(api);
  adapter.setSessions({ async create({ cwd }) { creates++; await new Promise((resolve) => setTimeout(resolve, cwd === 'project-A' ? 20 : 1)); return `session-${cwd}-${creates}`; }, retain(sessionId) { return { sessionId, ready: Promise.resolve(), release() { releases++; } }; } });
  return { adapter, projects, counts: () => ({ creates, releases }), selectB: () => { activeProjectId = 'B'; } };
}
test('late native creation stays with its original project when the user switches projects', async () => {
  const env = setup();
  let active;
  const first = env.adapter.ensure(env.projects[0], 'writing', { onBinding: (next) => { active = next.activeProjectId; } });
  env.selectB();
  const second = env.adapter.ensure(env.projects[1], 'writing');
  await Promise.all([first, second]);
  assert.equal(active, 'B');
  assert.equal(env.adapter.records.get('A:writing').projectId, 'A');
  assert.equal(env.adapter.records.get('B:writing').projectId, 'B');
  assert.notEqual(env.projects[0].bindings.writing, env.projects[1].bindings.writing);
  await env.adapter.dispose();
});
test('concurrent opening submits once and reopening a saved binding creates no new session', async () => {
  const env = setup();
  await Promise.all([env.adapter.ensure(env.projects[0], 'writing'), env.adapter.ensure(env.projects[0], 'writing')]);
  await env.adapter.ensure(env.projects[0], 'writing');
  assert.equal(env.counts().creates, 1);
  await env.adapter.dispose(); assert.equal(env.counts().releases, 1);
});
test('unavailable or failed native service does not mutate project bindings', async () => {
  const env = setup(); env.adapter.setSessions(null);
  await assert.rejects(env.adapter.ensure(env.projects[0], 'reading'), /尚未就绪/);
  assert.deepEqual(env.projects[0].bindings, {});
  env.adapter.setSessions({ create: async () => { throw new Error('offline'); } });
  const record = await env.adapter.ensure(env.projects[0], 'reading');
  assert.equal(record.status, 'failed'); assert.deepEqual(env.projects[0].bindings, {});
  await env.adapter.dispose();
});

test('failed replacement preserves the original native reference and disposal releases it once', async () => {
  const env = setup();
  const first = await env.adapter.ensure(env.projects[0], 'writing');
  env.adapter.sessions.create = async () => { throw new Error('temporary host failure'); };
  const next = await env.adapter.ensure(env.projects[0], 'writing', { replace: true });
  assert.equal(next, first); assert.equal(next.status, 'ready');
  assert.equal(env.counts().releases, 0);
  await env.adapter.dispose(); assert.equal(env.counts().releases, 1);
});

test('reopening a durable binding awaits the native catalog before retain and never creates a replacement', async () => {
  let loaded = false, creates = 0;
  const env = setup(), project = env.projects[0];
  project.bindings.writing = 'session-old-same-id';
  env.adapter.setSessions({
    async refresh() { await new Promise((resolve) => setTimeout(resolve, 4)); loaded = true; },
    create() { creates++; throw Error('must retain existing identity'); },
    retain(sessionId) { assert.equal(loaded, true); return { sessionId, ready: Promise.resolve(), release() {} }; },
  });
  const record = await env.adapter.ensure(project, 'writing');
  assert.equal(record.status, 'ready'); assert.equal(record.sessionId, 'session-old-same-id'); assert.equal(creates, 0);
  await env.adapter.dispose();
});
