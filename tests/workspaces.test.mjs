import test from 'node:test';
import assert from 'node:assert/strict';
import { installProjectWorkspaces } from '../src/server/workspaces.mjs';

test('workspace repair attaches only bound sessions and preserves ids on repeated starts', async () => {
  const projects = [{ id: 'A', title: 'A', root_path: '/projects/A' }, { id: 'B', title: 'B', root_path: '/projects/B' }];
  const bindings = ['A', 'B'].flatMap((project_id) => [0, 1, 2].map((n) => ({ project_id, session_id: `${project_id}-${n}` })));
  const entities = new Map(); let creates = 0, attaches = 0, callback;
  const runtime = { integrations: {}, store: { db: { prepare: (sql) => ({ all: () => sql.includes('FROM projects') ? projects : bindings }) } }, onMutation: (fn) => { callback = fn; return () => {}; } };
  const ctx = { effect() {}, workspaceRegistry: {
    resolveByPath: async (path) => entities.get(path),
    create: async (path) => { creates++; const entity = { sessionIds: [], attachSession: async (id) => { attaches++; entity.sessionIds.push(id); } }; entities.set(path, entity); return entity; },
  } };
  const sync = await installProjectWorkspaces(ctx, runtime);
  await Promise.all([sync(), sync()]);
  assert.equal(creates, 2); assert.equal(attaches, 6);
  assert.deepEqual(entities.get('/projects/A').sessionIds, ['A-0', 'A-1', 'A-2']);
  assert.deepEqual(entities.get('/projects/B').sessionIds, ['B-0', 'B-1', 'B-2']);
  assert.equal(runtime.integrations.nativeWorkspaces.attachedSessions, 6);
  assert.equal(typeof callback, 'function');
});

test('a rejected native cwd attachment remains a visible partial integration', async () => {
  const runtime = { integrations: {}, store: { db: { prepare: (sql) => ({ all: () => sql.includes('FROM projects') ? [{ id: 'A', root_path: '/projects/A' }] : [{ project_id: 'A', session_id: 'owned' }] }) } }, onMutation: () => () => {} };
  await installProjectWorkspaces({ effect() {}, workspaceRegistry: { resolveByPath: async () => ({ sessionIds: [], attachSession: async () => { throw Error('native cwd validation refused'); } }) } }, runtime);
  assert.equal(runtime.integrations.nativeWorkspaces.status, 'partial');
  assert.equal(runtime.integrations.nativeWorkspaces.attachedSessions, 0);
  assert.deepEqual(runtime.integrations.nativeWorkspaces.failedProjects, ['A']);
});
