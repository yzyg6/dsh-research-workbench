import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkspaceRuntime } from '../src/server/runtime.mjs';
import { documentCodec, sentenceAnchor, replaceSentence } from '../dist/writing-document.mjs';
import { validateProposal } from '../src/server/writing.mjs';
import { WritingEvidence, searchTerms } from '../src/server/writing-evidence.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = join(root, '_scratch/out/writing-tests'); await mkdir(out, { recursive: true });
const selected = '沉积物可能影响甲烷排放。';
const doc = { type: 'doc', content: [
  { type: 'paragraph', content: [{ type: 'text', text: '前文限定：这是观察性研究。' }] },
  { type: 'paragraph', content: [{ type: 'text', text: selected }, { type: 'text', text: '后句必须保留。', marks: [{ type: 'bold' }] }] },
  { type: 'paragraph', content: [{ type: 'text', text: '末段说明：没有进行因果推断。' }] },
] };
const from = doc.content[0].content[0].text.length + 3, to = from + selected.length;
const evidence = { terms: ['甲烷'], sources: [{ id: 'E1', title: '专用合成适配器测试，非真实文献', snippet: '测试检索片段', kind: 'test-adapter' }], warnings: [], zotero: 'test-double', local: 'test-double' };
const proposal = { replacement: '沉积物可能与甲烷排放有关。', reason: '保留观察性限定。', evidenceIds: ['E1'], warnings: [] };

async function setup() {
  const directory = await mkdtemp(join(out, 'case-'));
  const runtime = new WorkspaceRuntime({ root: directory, sampleRoot: join(root, 'samples/figure'), publicRoot: join(root, 'public'), trustedTransport: false });
  const projectId = await runtime.store.createProject({ title: '选句修改自动测试' });
  const object = (await runtime.store.state()).projects[0].objects[0];
  const markdown = documentCodec().markdown.serialize(doc);
  await runtime.store.saveObject({ projectId, objectId: object.id, expectedRevision: object.revision, text: markdown });
  runtime.writing.evidence = { retrieve: async () => structuredClone(evidence) };
  runtime.writing.generate = async input => {
    assert.equal(input.markdown, markdown); assert.equal(input.selectedText, selected);
    assert.match(input.markdown, /观察性研究/); assert.match(input.markdown, /没有进行因果推断/);
    assert.equal(input.evidence.sources[0].id, 'E1');
    return { text: JSON.stringify(proposal), model: { provider: 'test-only', model: 'explicit-test-double' } };
  };
  const args = { projectId, objectId: object.id, expectedRevision: 2, document: doc, from, to, operationKey: crypto.randomUUID() };
  return { runtime, args, markdown };
}
async function execute(runtime, args) { const id = await runtime.writing.enqueue(args); const row = await runtime.store.claimJob(['writing.sentence']); await runtime.writing.run(row, new AbortController().signal); return id; }

test('a sentence proposal sees the complete article and evidence; adoption and undo persist immutable versions across reopening', async () => {
  const { runtime, args, markdown } = await setup();
  const id = await execute(runtime, args);
  assert.equal(runtime.writing.row(args.projectId, id).status, 'succeeded');
  assert.equal((await runtime.store.asset(args.projectId, args.objectId)).bytes.toString(), markdown);
  await runtime.writing.apply({ projectId: args.projectId, jobId: id });
  const changed = (await runtime.store.asset(args.projectId, args.objectId)).bytes.toString();
  assert.equal(changed, markdown.replace(selected, proposal.replacement));
  assert.match(changed, /\*\*后句必须保留。\*\*/);
  assert.equal(JSON.parse(runtime.writing.row(args.projectId, id).output).review, 'adopted');
  const directory = runtime.store.root; await runtime.dispose();
  const reopened = new WorkspaceRuntime({ root: directory, sampleRoot: join(root, 'samples/figure'), publicRoot: join(root, 'public') });
  await reopened.writing.undo({ projectId: args.projectId, jobId: id });
  assert.equal((await reopened.store.asset(args.projectId, args.objectId)).bytes.toString(), markdown);
  assert.equal(reopened.store.versions(args.projectId, args.objectId).length, 4);
  assert.equal(JSON.parse(reopened.writing.row(args.projectId, id).output).review, 'undone');
  await reopened.dispose();
});
test('stale adoption and undo cannot overwrite manual edits or another project', async () => {
  const { runtime, args } = await setup(); const id = await execute(runtime, args);
  const other = await runtime.store.createProject({ title: '隔离项目' });
  await assert.rejects(runtime.writing.apply({ projectId: other, jobId: id }), { code: 'REVISION_NOT_FOUND' });
  await runtime.writing.apply({ projectId: args.projectId, jobId: id });
  await runtime.store.saveObject({ projectId: args.projectId, objectId: args.objectId, expectedRevision: 3, text: '作者后续手改，必须保留。' });
  await assert.rejects(runtime.writing.undo({ projectId: args.projectId, jobId: id }), { code: 'VERSION_CONFLICT' });
  assert.equal(JSON.parse(runtime.writing.row(args.projectId, id).output).review, 'adopted');
  assert.equal((await runtime.store.asset(args.projectId, args.objectId)).bytes.toString(), '作者后续手改，必须保留。');
  await runtime.dispose();
});
test('a changed manuscript during generation keeps the suggestion but prevents adoption', async () => {
  const { runtime, args } = await setup();
  const generate = runtime.writing.generate;
  runtime.writing.generate = async input => { await runtime.store.saveObject({ projectId: args.projectId, objectId: args.objectId, expectedRevision: 2, text: '生成期间作者新写的内容。' }); return generate(input); };
  const id = await execute(runtime, args);
  assert.equal(runtime.writing.row(args.projectId, id).status, 'outdated');
  await assert.rejects(runtime.writing.apply({ projectId: args.projectId, jobId: id }), { code: 'REVISION_NOT_READY' });
  await runtime.dispose();
});
test('model failures, missing models and cancelled jobs leave the article intact', async () => {
  const { runtime, args, markdown } = await setup();
  runtime.writing.generate = null;
  await assert.rejects(runtime.writing.enqueue(args), { code: 'MODEL_UNAVAILABLE' });
  runtime.writing.generate = async () => { throw new Error('private provider error containing secrets'); };
  const id = await execute(runtime, args);
  const failed = runtime.writing.row(args.projectId, id);
  assert.equal(failed.status, 'failed'); assert.doesNotMatch(failed.error, /secrets/);
  const cancelled = await runtime.writing.enqueue({ ...args, operationKey: crypto.randomUUID() });
  await runtime.store.cancelJob({ projectId: args.projectId, jobId: cancelled });
  assert.equal(await runtime.store.claimJob(['writing.sentence']), null);
  assert.equal((await runtime.store.asset(args.projectId, args.objectId)).bytes.toString(), markdown);
  await runtime.dispose();
});
test('precise anchors preserve repeated sentences, formatting, citations and surrounding tables/math; cross-block and forged snapshots fail', async () => {
  const { runtime, args } = await setup();
  const forged = structuredClone(doc); forged.content[0].content[0].text = '伪造的上下文';
  await assert.rejects(runtime.writing.enqueue({ ...args, document: forged }), { code: 'VERSION_CONFLICT' });
  assert.throws(() => sentenceAnchor(doc, 1, to), /同一段/);
  const repeated = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: '重复。重复。' }, { type: 'citation', attrs: { key: 'known2026' } }] },
    { type: 'paragraph', content: [{ type: 'inlineMath', attrs: { latex: 'x^2' } }] },
  ] };
  const changed = replaceSentence(repeated, 4, 7, '只改第二句。');
  assert.equal(changed, '重复。只改第二句。[@known2026]\n\n$x^2$');
  await runtime.dispose();
});
test('unretrieved and synthetic evidence, invalid JSON and invented citations cannot enter a proposal', () => {
  assert.throws(() => validateProposal('bad json', selected, evidence), { code: 'INVALID_PROPOSAL' });
  assert.throws(() => validateProposal(JSON.stringify({ ...proposal, evidenceIds: ['E999'] }), selected, evidence), { code: 'UNSUPPORTED_EVIDENCE' });
  assert.throws(() => validateProposal(JSON.stringify(proposal), selected, { ...evidence, sources: [{ id: 'E1', synthetic: true }] }), { code: 'UNSUPPORTED_EVIDENCE' });
  assert.throws(() => validateProposal(JSON.stringify({ ...proposal, replacement: '新结论 [@invented]' }), selected, evidence), { code: 'CITATION_CHANGED' });
  assert.throws(() => validateProposal(JSON.stringify(proposal), selected + ' [1]', evidence), { code: 'CITATION_CHANGED' });
});
test('shared local parsed literature works across projects and Zotero outage is explicit', async () => {
  const { runtime, args } = await setup();
  const library = new WritingEvidence(runtime.store, { zotero: { search: async () => { throw Error('offline'); } } });
  await library.import({ title: '解析文献.md', text: '# 文献\n\n甲烷排放与沉积物有关。\n\n不能将关联解释为因果。' });
  const other = await runtime.store.createProject({ title: '共享库第二项目' });
  const result = await library.retrieve({ projectId: other, selectedText: selected }, new AbortController().signal);
  assert.equal(result.sources[0].title, '解析文献.md'); assert.equal(result.zotero, 'unavailable');
  assert.match(result.warnings.join(' '), /Zotero MCP 暂不可用/);
  assert.ok(result.sources[0].locator.includes('非页码') || result.sources[0].locator.includes('页码未提供'));
  assert.ok(searchTerms(selected).includes('甲烷'));
  const empty = await library.retrieve({ projectId: args.projectId, selectedText: 'zzzzzznomatch' }, new AbortController().signal);
  assert.equal(empty.sources.length, 0); assert.match(empty.warnings.join(' '), /不得新增/);
  await runtime.dispose();
});
