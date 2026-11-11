import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectStore } from '../src/server/store.mjs';
import { DatabaseSync } from 'node:sqlite';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = join(root, '_scratch', 'out', 'phase1-tests');
await mkdir(out, { recursive: true });
async function make() { const directory = await mkdtemp(join(out, 'store-')); return new ProjectStore({ root: directory, sampleRoot: join(root, 'samples/figure') }); }

test('two projects retain independent objects, three task layouts and six native bindings after reopening', async () => {
  let store = await make(); const directory = store.root;
  const a = await store.createProject({ title: '论文 A' }), b = await store.createProject({ title: '论文 B' });
  const first = await store.state();
  for (const [n, projectId] of [a, b].entries()) {
    const object = first.projects.find((p) => p.id === projectId).objects[0];
    await store.saveObject({ projectId, objectId: object.id, expectedRevision: 1, text: `# 论文 ${n}\n\n仅属于 ${projectId}` });
    for (const [i, task] of ['writing', 'figure', 'reading'].entries()) {
      await store.saveTaskState({ projectId, task, patch: { cursor: n * 100 + i, scrollTop: n * 50 + i, selectedObjectId: object.id, layout: { order: ['chat', 'main', 'context'], weights: { main: 40 + i, context: 20, chat: 35 }, collapsed: { context: true }, maximized: null } } });
      await store.bindSession({ projectId, task, sessionId: `session-${String(n * 3 + i + 1).padStart(8, '0')}-1234-1234-1234-123456789abc` });
    }
  }
  await store.activateProject(a); await store.close();
  store = new ProjectStore({ root: directory, sampleRoot: join(root, 'samples/figure') });
  const next = await store.state(); assert.equal(next.activeProjectId, a);
  for (const [n, projectId] of [a, b].entries()) {
    const project = next.projects.find((p) => p.id === projectId);
    assert.match(project.objects[0].text, new RegExp(projectId));
    assert.equal(project.objects[0].revision, 2);
    assert.equal(new Set(Object.values(project.bindings)).size, 3);
    for (const [i, task] of ['writing', 'figure', 'reading'].entries()) { assert.equal(project.taskStates[task].value.cursor, n * 100 + i); assert.equal(project.taskStates[task].value.scrollTop, n * 50 + i); assert.deepEqual(project.taskStates[task].value.layout.order, ['chat', 'main', 'context']); }
  }
  assert.equal(new Set(next.projects.flatMap((p) => Object.values(p.bindings))).size, 6);
  await store.close();
});

test('stale writes fail and immutable Markdown versions survive', async () => {
  const store = await make(), projectId = await store.createProject({ title: '版本检查' });
  const object = (await store.state()).projects[0].objects[0];
  await store.saveObject({ projectId, objectId: object.id, expectedRevision: 1, text: '# 第二版' });
  await assert.rejects(store.saveObject({ projectId, objectId: object.id, expectedRevision: 1, text: '过期覆盖' }), { code: 'VERSION_CONFLICT' });
  assert.equal((await store.state()).projects[0].objects[0].text, '# 第二版');
  const versions = store.versions(projectId, object.id); assert.deepEqual(versions.map((v) => v.revision), [2, 1]);
  const old = store.db.prepare('SELECT path FROM object_versions WHERE object_id=? AND revision=1').get(object.id);
  assert.match(await readFile(join(store.project(projectId).root_path, old.path), 'utf8'), /版本检查/);
  await store.close();
});

test('layout event evidence stays with its task and repeated flushes do not duplicate it', async () => {
  const store = await make(), projectId = await store.createProject({ title: 'layout evidence' });
  const layout = (await store.state()).projects[0].taskStates.writing.value.layout;
  const event = { id: '12345678-1234-1234-1234-123456789abc', kind: 'pointer-drop', trusted: true };
  await store.saveTaskState({ projectId, task: 'writing', patch: { layout, layoutEvent: event } });
  await store.saveTaskState({ projectId, task: 'writing', patch: { layout, layoutEvent: event } });
  const owner = (await store.state()).projects[0];
  assert.equal(owner.taskStates.writing.value.layoutEvents.length, 1);
  assert.equal(owner.taskStates.reading.value.layoutEvents, undefined);
  await assert.rejects(store.saveTaskState({ projectId, task: 'writing', patch: { layoutEvent: event } }), { code: 'INVALID_INPUT' });
  await store.close();
});

test('project boundaries reject foreign objects, dependencies and native session reuse', async () => {
  const store = await make(), a = await store.createProject({ title: 'A' }), b = await store.createProject({ title: 'B' });
  const state = await store.state(), objectA = state.projects.find((p) => p.id === a).objects[0], objectB = state.projects.find((p) => p.id === b).objects[0];
  await assert.rejects(store.saveObject({ projectId: b, objectId: objectA.id, expectedRevision: 1, text: '串项目' }), { code: 'OBJECT_NOT_FOUND' });
  await assert.rejects(store.addDependency({ projectId: a, sourceId: objectA.id, targetId: objectB.id }), { code: 'OBJECT_NOT_FOUND' });
  await assert.rejects(store.saveTaskState({ projectId: b, task: 'reading', patch: { selectedObjectId: objectA.id } }), { code: 'OBJECT_NOT_FOUND' });
  const sessionId = 'session-12345678-1234-1234-1234-123456789abc';
  await store.bindSession({ projectId: a, task: 'writing', sessionId });
  await assert.rejects(store.bindSession({ projectId: b, task: 'writing', sessionId }), { code: 'SESSION_ALREADY_OWNED' });
  await assert.rejects(store.asset(b, objectA.id), { code: 'OBJECT_NOT_FOUND' });
  await store.close();
});

test('background results stay with their owner and changed inputs cannot be published', async () => {
  const store = await make(), a = await store.createProject({ title: 'A' }), b = await store.createProject({ title: 'B' });
  const jobId = await store.enqueueJob({ projectId: a, type: 'project.integrity', operationKey: 'same-operation' });
  assert.equal(await store.enqueueJob({ projectId: a, type: 'project.integrity', operationKey: 'same-operation' }), jobId);
  await store.activateProject(b);
  const claimed = await store.claimJob(); await store.runJob(claimed);
  let state = await store.state(); assert.equal(state.projects.find((p) => p.id === a).jobs[0].status, 'succeeded'); assert.equal(state.projects.find((p) => p.id === b).jobs.length, 0);
  await store.enqueueJob({ projectId: a, type: 'project.integrity', operationKey: 'will-change' });
  const stale = await store.claimJob(), object = state.projects.find((p) => p.id === a).objects[0];
  await store.runJob(stale, { beforeCommit: () => store.saveObject({ projectId: a, objectId: object.id, expectedRevision: 1, text: '新输入' }) });
  state = await store.state(); assert.equal(state.projects.find((p) => p.id === a).jobs.find((j) => j.id === stale.id).status, 'outdated');
  await store.close();
});

test('cancelled and interrupted jobs retain receipts and can be retried', async () => {
  const store = await make(), projectId = await store.createProject({ title: '任务恢复' });
  const cancelled = await store.enqueueJob({ projectId, type: 'project.integrity', operationKey: 'cancel-me' });
  await store.cancelJob({ projectId, jobId: cancelled }); assert.equal(await store.claimJob(), null);
  await store.retryJob({ projectId, jobId: cancelled });
  const claimed = await store.claimJob(); await store.recoverJobs();
  const jobs = (await store.state()).projects[0].jobs; assert.equal(jobs.find((job) => job.id === claimed.id).status, 'interrupted');
  await store.close();
});

test('external file changes are reported and never silently replaced', async () => {
  const store = await make(), projectId = await store.createProject({ title: '外部变动' });
  const object = (await store.state()).projects[0].objects[0], raw = store.object(projectId, object.id);
  await writeFile(join(store.project(projectId).root_path, raw.path), '外部改动');
  assert.match((await store.state()).projects[0].objects[0].contentError, /工作台外/);
  await assert.rejects(store.saveObject({ projectId, objectId: object.id, expectedRevision: 1, text: '不应覆盖' }), { code: 'EXTERNAL_CHANGE' });
  const job = await store.enqueueJob({ projectId, type: 'project.integrity', operationKey: 'external-corruption' });
  await store.runJob(await store.claimJob()); assert.equal((await store.state()).projects[0].jobs.find((j) => j.id === job).status, 'failed');
  assert.equal(await readFile(join(store.project(projectId).root_path, raw.path), 'utf8'), '外部改动'); await store.close();
});

test('demo uses the actual saved synthetic data, chart and dependency identities', async () => {
  const store = await make(), projectId = await store.createDemo(), state = await store.state(), project = state.projects.find((p) => p.id === projectId);
  assert.equal(project.objects.length, 4); assert.equal(project.dependencies.length, 2);
  assert.equal(project.objects.find((o) => o.kind === 'data').text.trim().split('\n').length, 73);
  const figure = project.objects.find((o) => o.kind === 'figure'), asset = await store.asset(projectId, figure.id);
  assert.deepEqual(asset.bytes, await readFile(join(root, 'samples/figure/Figure1.png'))); await store.close();
});

test('a newer database is refused without rewriting its contents', async () => {
  const directory = await mkdtemp(join(out, 'future-')), path = join(directory, 'workbench.sqlite');
  const future = new DatabaseSync(path); future.exec("CREATE TABLE future_data(value TEXT); INSERT INTO future_data VALUES('keep-me'); PRAGMA user_version=99;"); future.close();
  const before = await readFile(path);
  assert.throws(() => new ProjectStore({ root: directory, sampleRoot: join(root, 'samples/figure') }), { code: 'NEWER_SCHEMA' });
  assert.deepEqual(await readFile(path), before);
});

test('a chosen project directory is durable and protected paths are refused before writing', async () => {
  const store = await make(), parent = await mkdtemp(join(out, 'chosen-'));
  const projectId = await store.createProject({ title: '指定保存位置', directory: parent });
  assert.equal(store.project(projectId).root_path, join(parent, projectId));
  await assert.rejects(store.createProject({ title: '不应创建', directory: 'relative/path' }), { code: 'ABSOLUTE_PATH_REQUIRED' });
  await assert.rejects(store.createProject({ title: '不应触及旧项目', directory: store.forbiddenRoot }), { code: 'FORBIDDEN_ROOT' });
  await store.close();
});
