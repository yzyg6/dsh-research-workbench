import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkspaceRuntime } from '../src/server/runtime.mjs';
import { WordEditing } from '../src/server/word-edit.mjs';
import { createSectionReplyReader } from '../src/server/review-agents.mjs';
import { MANUSCRIPT_REVIEW_GUIDANCE, MANUSCRIPT_REVIEW_TEMPLATES, MANUSCRIPT_REVISION_GUIDANCE, MANUSCRIPT_SECTION_RULE, PROMPT_TEMPLATES } from '../src/shared/revision-review.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);
const sessionId = 'session-00000000-1111-2222-3333-444444444444';

test('review recovery reuses only the completed reply for the original child and stage', async () => {
  let disposed = 0;
  const childId = 'fixture-review-child';
  const turn = (id, section, peers, reply, kind='completed') => [
    { type: 'user/message', data: { id, content: [{ type: 'text', text: '审阅任务\n以下 JSON 是待审材料和任务约束。\n' + JSON.stringify({ section: { id: section }, peers }) }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: reply }] } } },
    { type: 'turn/end', data: { reason: { kind } } },
  ];
  const read = createSectionReplyReader({ get: () => ({ observeSession: async id => {
    assert.equal(id, childId);
    return {
      header: { parentSession: sessionId, agentPreset: 'research-workbench-review' },
      inheritedEventCount: 3,
      events: [ ...turn('inherited', 10, undefined, 'inherited'), ...turn('initial', 2, undefined, 'initial'),
        ...turn('exchange', 2, [], 'exchange'), ...turn('broken', 3, undefined, 'incomplete', 'error') ],
      [Symbol.dispose]: () => { disposed++; },
    };
  } }) });
  const input = { parentId: sessionId, childId, sectionId: 2, signal: new AbortController().signal };
  assert.equal(await read({ ...input, exchange: false }), 'initial');
  assert.equal(await read({ ...input, exchange: true }), 'exchange');
  assert.equal(await read({ ...input, exchange: true, parentId: 'different-parent' }), '');
  assert.equal(await read({ ...input, exchange: false, sectionId: 10 }), '');
  await assert.rejects(read({ ...input, exchange: false, sectionId: 3 }), { code: 'REVIEW_AGENT_INCOMPLETE' });
  assert.equal(disposed, 5);
});

test('reviews run parallel section workers, resume selectively, exchange findings, preserve Word comments and hand off to comparison', async () => {
  const out = join(root, '_scratch/out/review-tests');
  await mkdir(out, { recursive: true });
  const base = await mkdtemp(join(out, 'case-'));
  const config = { root: join(base, 'catalog'), publicRoot: join(root, 'public'), sampleRoot: join(root, 'samples/figure') };
  let runtime = new WorkspaceRuntime(config);
  try {
    const projectId = await runtime.store.createProject({ title: '合成审阅测试' });
    const originalPath = join(runtime.store.project(projectId).root_path, 'paper', 'synthetic.docx');
    await exec('python', ['-I', join(root, 'probes/manuscript-review/create-fixture.py'), originalPath], { windowsHide: true });
    const original = await readFile(originalPath);
    const objectId = await runtime.store.importWorkspaceFile({ projectId, path: 'paper/synthetic.docx' });
    const setupNative = () => {
      runtime.nativeWriting.validateSession = async () => {};
      runtime.writing.evidence = { retrieve: async () => ({ sources: [], warnings: [], terms: [] }) };
    };
    setupNative();
    const discussion = await runtime.nativeWriting.open({ projectId, objectId });
    await runtime.nativeWriting.bind({ projectId, jobId: discussion, sessionId });
    const calls = [];
    let active = 0, peak = 0, malformedReplies = 0, malformedCrossReplies = 0;
    const malformed = '{"summary":"本节称为"合成估计"。","findings":[]}';
    const fakeAgent = async ({ parentId, childId, prompt, published }) => {
      assert.equal(parentId, sessionId);
      const payload = JSON.parse(prompt.split('\n').at(-1));
      calls.push({ childId, payload, prompt });
      if (!childId) await published('synthetic-child-' + (payload.section?.id || 'coordinator'));
      active++;
      peak = Math.max(peak, active);
      await delay(25);
      active--;
      if(payload.task==='arrange-review-relations')return JSON.stringify({degrees:[{id:'1-1',kind:'meaning',reason:'口径变化影响结果比较。'},{id:'2-1',kind:'structure',reason:'结果应放在统一定义之后。'}],relations:[
        {from:'1-1',to:'2-1',kind:'before',reason:'先统一口径，再核对结果。'},
        {from:'2-1',to:'1-1',kind:'before',reason:'会形成循环。'},
        {from:'forged',to:'1-1',kind:'together',reason:'不存在。'},
      ]});
      if (!payload.section) return JSON.stringify(payload.sections
        ? { summary: '统一全文计量口径。', plan: [{ step: '先明确方法定义，再检查结果。', findings: ['1-1', '2-1', 'forged'] }] }
        : { answer: '该结果依赖方法中已定义的单位。' });
      if (payload.section.id === 2 && (payload.peers ? malformedCrossReplies++ < 2 : malformedReplies++ < 3)) return malformed;
      const paragraph = payload.section.paragraphs[0];
      assert.equal(payload.section.paragraphs.length, 2);
      if (payload.section.id === 2 && payload.peers && payload.repair?.concise) {
        assert(prompt.includes('FINDING\t'));
        return `\x60\x60\x60tsv\nSUMMARY\t残余口径已复核。\nFINDING\t${paragraph.index}\t${paragraph.text}\t"计量口径"需要说明。\t沿用方法节的定义。\n\x60\x60\x60`;
      }
      const incomplete = payload.section.id === 1 && !payload.peers;
      const result = JSON.stringify({ summary: '计量口径需要相互核对。', findings: [{
        index: incomplete ? 999 : paragraph.index, quote: paragraph.text, issue: '未定义适用口径。',
        suggestion: '解释统一口径。',
        ...(!incomplete ? { steps: payload.section.id === 1 ? ['先定义口径。', '再解释其适用范围。'] : '先定义，再解释其适用范围。' } : {}),
        ...(payload.section.id === 2 ? { prompt: '结合前文说明口径并保留已有单位。' } : {}),
        scope: 'chapter', links: [1, 2, 99],
      }] });
      if (incomplete) return '<acp source="fixture">continuation</acp>\n审阅回执如下。\n```json\n' + result + '\n```\n<acp source="fixture">end</acp>';
      return payload.peers && payload.section.id === 1 ? '<acp source="fixture">continuation</acp>\n' + result : result;
    };
    runtime.review.agent = fakeAgent;
    const data = { projectId, objectId, expectedRevision: 1, instruction: '检查方法与结果的一致性。', operationKey: randomUUID() };
    const { actionResult: { jobId } } = await runtime.mutate('startManuscriptReview', data);
    const owner = { projectId, objectId, jobId };
    const state = () => runtime.review.status(owner);
    const wait = async expected => {
      for (let tries = 0; tries < 160; tries++) {
        if (state().status === expected && !runtime.review.running.has(jobId)) return state();
        await delay(35);
      }
      assert.fail(state().phase + ': ' + state().error);
    };
    await wait('failed');
    assert.equal(peak, 2);
    assert.equal(state().workers[0].status, 'read', 'a single JSON envelope and missing redundant fields need no model retry');
    const failedCalls = calls.filter(c => c.payload.section?.id === 2);
    assert.equal(failedCalls.length, 3, 'two bounded automatic repair attempts for malformed JSON');
    assert.equal(failedCalls[1].childId, 'synthetic-child-2', 'repair continues in the existing section session');
    assert.equal(failedCalls[1].payload.repair.code, 'REVIEW_RESPONSE_INVALID');
    assert.equal(failedCalls[2].payload.repair.concise, true);
    assert.deepEqual(state().workers.map(w => w.path), [['1 方法','1.1 合成采样'], ['2 结果','2.1 合成估计值']]);
    runtime.review.previousSectionReply = async ({ sectionId, childId, exchange }) => {
      assert.equal(sectionId, 2);
      assert.equal(childId, 'synthetic-child-2');
      assert.equal(exchange, false);
      return malformed;
    };
    await runtime.mutate('resumeManuscriptReview', owner);
    await runtime.review.running.get(jobId)?.operation;
    assert.equal(state().status, 'draft', state().error);
    const drafted = await wait('draft');
    assert.deepEqual(drafted.workers.map(w => w.status), ['standby', 'standby']);
    assert.equal(calls.filter(c => c.payload.section?.id === 1 && !c.payload.peers).length, 1);
    const resumedCall = calls.filter(c => c.payload.section?.id === 2 && !c.payload.peers)[3];
    assert.equal(resumedCall.childId, 'synthetic-child-2');
    assert.equal(resumedCall.payload.repair.code, 'REVIEW_RESPONSE_INVALID');
    for (const call of calls.filter(c => c.payload.section)) {
      assert(call.prompt.startsWith(MANUSCRIPT_REVIEW_GUIDANCE));
      assert.equal(call.payload.authorRequest, data.instruction);
    }
    for (const call of calls.filter(c => c.payload.peers)) {
      assert.equal(call.childId, 'synthetic-child-' + call.payload.section.id);
      assert.equal(call.payload.peers.length, 1);
      assert.notEqual(call.payload.peers[0].id, call.payload.section.id);
    }
    const crossCalls = calls.filter(c => c.payload.section?.id === 2 && c.payload.peers);
    assert.equal(crossCalls.length, 3);
    assert.equal(crossCalls[2].payload.repair.concise, true);
    assert.equal(drafted.findings[1].issue, '"计量口径"需要说明。');
    const peerFinding = crossCalls[0].payload.peers[0].findings[0];
    assert.equal(peerFinding.quote, '合成方法采用两种计量口径。');
    const firstFinding = calls.find(c => c.payload.section?.id === 1 && c.payload.peers).payload.first.findings[0];
    assert.equal(firstFinding.index, 2);
    assert.equal(firstFinding.steps, '解释统一口径。');
    assert.equal(firstFinding.prompt, '解释统一口径。');
    assert.deepEqual(await readFile(originalPath), original);
    const route = new URL('http://local/api/research-workbench/review-status');
    route.search = new URLSearchParams(owner);
    assert.equal((await (await runtime.handle(new Request(route))).json()).id, jobId);
    assert(!JSON.stringify(await runtime.viewState()).includes('synthetic-child-1'));
    await assert.rejects(runtime.review.target({ ...owner, findingId: '99-9', scope: 'locate' }), { code: 'REVIEW_FINDING_NOT_FOUND' });
    const { actionResult } = await runtime.mutate('publishReviewComments', owner);
    assert.deepEqual(actionResult, { count: 2, revision: 2 });
    const finished = await wait('succeeded');
    assert.deepEqual(finished.plan[0].findings, ['1-1', '2-1']);
    assert.equal(finished.commentRevision, 2);
    assert(calls.find(c => c.payload.sections).prompt.startsWith(MANUSCRIPT_REVISION_GUIDANCE));
    for (const template of [...MANUSCRIPT_REVIEW_TEMPLATES, ...PROMPT_TEMPLATES]) {
      assert(template.prompt.includes(MANUSCRIPT_SECTION_RULE), template.id);
    }
    await runtime.mutate('arrangeReviewRelations',owner);
    const arranged=await wait('succeeded');
    assert.equal(arranged.findings[0].kind,'meaning');
    assert.deepEqual(arranged.relations,[{from:'1-1',to:'2-1',kind:'before',reason:'先统一口径，再核对结果。'}]);
    assert((await runtime.store.documentHistory.list(projectId, objectId)).entries.some(item => item.action?.includes('2 条 Word 批注')));
    await assert.rejects(runtime.mutate('publishReviewComments', owner), { code: 'REVIEW_NOT_READY' });
    const { path } = await runtime.wordEditing.source(projectId, objectId);
    const inspect = "import sys,json,zipfile,xml.etree.ElementTree as E;a=zipfile.ZipFile(sys.argv[1]);b=zipfile.ZipFile(sys.argv[2]);r=E.fromstring(b.read('word/comments.xml'));print(json.dumps({'changed':[n for n in a.namelist() if a.read(n)!=b.read(n)], 'comments':[''.join(c.itertext()) for c in r]}))";
    const receipt = JSON.parse((await exec('python', ['-I', '-c', inspect, originalPath, path], { windowsHide: true })).stdout);
    assert.deepEqual(receipt.changed, ['word/document.xml', 'word/comments.xml']);
    assert.equal(receipt.comments.length, 3);
    assert.equal(receipt.comments[0], '已有的合成批注。');
    assert.match(receipt.comments[1], /修改路径：先定义口径。再解释其适用范围。/);
    assert.match(receipt.comments[2], /修改路径：沿用方法节的定义。/);
    assert.match(receipt.comments[1], /提示词：解释统一口径。先定义口径。再解释其适用范围。/);
    assert.equal(await runtime.wordEditing.context(projectId, objectId), (await runtime.wordEditing.inspect({ path: originalPath })).text);
    await runtime.dispose();
    runtime = new WorkspaceRuntime(config);
    setupNative();
    runtime.review.agent = fakeAgent;
    assert.equal(state().status, 'succeeded');
    await runtime.mutate('followManuscriptReview', { ...owner, target: 2, message: '结果用哪个口径？' });
    const replied = await wait('succeeded');
    assert.equal(calls.at(-1).childId, 'synthetic-child-2');
    assert(calls.at(-1).prompt.startsWith(MANUSCRIPT_REVISION_GUIDANCE));
    assert.match(replied.messages.at(-1).text, /依赖方法/);
    const finding = { ...owner, findingId: '1-1' };
    const located = await runtime.review.target({ ...finding, scope: 'locate' });
    assert.deepEqual(located.wordSelection.anchor.path, [2]);
    await runtime.mutate('decideManuscriptReview', { ...finding, dismissed: true });
    assert.equal(state().findings[0].decision.dismissed, true);
    const { actionResult: revision } = await runtime.mutate('prepareReviewRevision', { ...finding, scope: 'chapter' });
    assert.match(revision.instruction, /修改路径/);
    assert(revision.instruction.endsWith(MANUSCRIPT_REVISION_GUIDANCE));
    assert.equal(state().findings[0].decision.dismissed, false);
    assert.equal(runtime.store.object(projectId, objectId).revision, 2);
    await runtime.nativeWriting.userTurn(sessionId, [{ role: 'user', content: [{ type: 'text', text: revision.instruction }] }], { provider: 'test', model: 'test' }, 1);
    const context = await runtime.nativeWriting.readContext(sessionId, '');
    assert.deepEqual(context.paragraphs, ['合成方法采用两种计量口径。', '方法段落保留原始单位。']);
    await runtime.nativeWriting.propose(sessionId, {
      selectionId: revision.jobId, paragraphs: ['合成方法定义两种计量口径。', '方法段落保留原始单位。'],
      reason: '明确合成方法的定义。', evidenceIds: [], warnings: [],
    });
    assert.equal(state().findings[0].decision.review, 'pending');
    assert.equal(runtime.store.object(projectId, objectId).revision, 2);
    await runtime.mutate('applySentence', { projectId, jobId: revision.jobId });
    assert.equal(state().findings[0].decision.review, 'adopted');
    const patched = await runtime.wordEditing.source(projectId, objectId);
    const after = JSON.parse((await exec('python', ['-I', '-c', inspect, originalPath, patched.path], { windowsHide: true })).stdout);
    assert.deepEqual(after.comments, receipt.comments);
    assert.deepEqual(await readFile(originalPath), original);
    await assert.rejects(runtime.review.target({ ...finding, scope: 'locate' }), { code: 'REVIEW_ANCHOR_CHANGED' });
    await runtime.mutate('undoSentence', { projectId, jobId: revision.jobId });
    assert.equal(state().findings[0].decision.review, 'undone');
    assert.equal(located.wordSelection.text, (await runtime.review.target({ ...finding, scope: 'locate' })).wordSelection.text);
  } finally { await runtime.dispose(); }
});

test('the first Word comment adds the required OOXML parts without changing document text', async () => {
  const out = join(root, '_scratch/out/review-tests');
  await mkdir(out, { recursive: true });
  const folder = await mkdtemp(join(out, 'first-comment-'));
  const original = join(folder, 'original.docx'), output = join(folder, 'reviewed.docx');
  await exec('python', ['-I', join(root, 'probes/word-reader/create-fixture.py'), '--output', original, '--paragraphs', '3'], { windowsHide: true });
  const word = new WordEditing(null);
  const before = await word.inspect({ path: original });
  await word.inspect({ path: original, output, reviewComments: [{
    index: 1, quote: '第1段。', id: '1-1', author: '合成标题',
    issue: '合成问题。', suggestion: '合成建议。', steps: '合成路径。', prompt: '合成提示词。',
  }] });
  const after = await word.inspect({ path: output });
  assert.equal(after.text, before.text);
  assert.equal(after.hasComments, true);
  const check = "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert b'comments.xml' in z.read('[Content_Types].xml'); assert b'comments.xml' in z.read('word/_rels/document.xml.rels'); assert b'comment' in z.read('word/comments.xml')";
  await exec('python', ['-I', '-c', check, output], { windowsHide: true });
});

test('batch drafting falls back to the anchored paragraph for both chapter range and inline formatting restrictions', async () => {
  const out = join(root, '_scratch/out/review-tests');
  await mkdir(out, { recursive: true });
  const base = await mkdtemp(join(out, 'restricted-ranges-'));
  const runtime = new WorkspaceRuntime({ root: join(base, 'catalog'), publicRoot: join(root, 'public'), sampleRoot: join(root, 'samples/figure') });
  try {
    const projectId = await runtime.store.createProject({ title: '合成选区测试' });
    const originalPath = join(runtime.store.project(projectId).root_path, 'paper', 'synthetic.docx');
    await exec('python', ['-I', join(root, 'probes/manuscript-review/create-fixture.py'), originalPath, '--restricted-review-ranges'], { windowsHide: true });
    const original = await readFile(originalPath);
    const objectId = await runtime.store.importWorkspaceFile({ projectId, path: 'paper/synthetic.docx' });
    runtime.nativeWriting.validateSession = async () => {};
    const discussion = await runtime.nativeWriting.open({ projectId, objectId });
    await runtime.nativeWriting.bind({ projectId, jobId: discussion, sessionId });
    const drafts = [];
    runtime.review.agent = async ({ childId, prompt, published }) => {
      const data = JSON.parse(prompt.split('\n').at(-1));
      if (data.task === 'draft-review-revision') {
        drafts.push(data);
        assert.equal(data.scope, 'paragraph');
        return JSON.stringify({ replacement: data.original.replace(/。$/, '，已复核。'), reason: '补充合成说明。', evidenceIds: [], warnings: [] });
      }
      if (!childId) await published('ranges-' + (data.section?.id || 'coordinator'));
      if (!data.section) return JSON.stringify({ summary: '已审阅。' });
      const paragraph = data.section.paragraphs[0];
      return JSON.stringify({ summary: '已审阅。', findings: [{ index: paragraph.index, quote: paragraph.text, issue: '说明不足。', suggestion: '说明已复核。', scope: 'chapter' }] });
    };
    const { jobId } = await runtime.review.start({ projectId, objectId, expectedRevision: 1, operationKey: randomUUID() });
    const owner = { projectId, objectId, jobId };
    const finish = async () => runtime.review.running.get(jobId)?.operation;
    await finish();
    await runtime.review.publish(owner);
    await finish();
    await runtime.review.startBatch({ ...owner, findingIds: ['1-1', '2-1'], expectedRevision: 2, operationKey: randomUUID() });
    await finish();
    const items = runtime.review.batchView(owner).batch.items;
    assert.deepEqual(items.map(item => [item.state, item.scope]), [['ready', 'paragraph'], ['ready', 'paragraph']]);
    assert.equal(drafts.length, 2);
    assert.equal(runtime.store.object(projectId, objectId).revision, 2, 'generating proposals leaves Word untouched');
    for (const item of items) {
      const before = await runtime.wordEditing.context(projectId, objectId);
      const job = runtime.review.batchProposal({ ...owner, findingId: item.findingId });
      await runtime.mutate('applySentence', { projectId, jobId: item.jobId, proposalUpdatedAt: job.updatedAt });
      const after = await runtime.wordEditing.context(projectId, objectId);
      assert.equal(after, before.replace(job.output.original, job.output.proposal.replacement));
    }
    assert.deepEqual(await readFile(originalPath), original);
  } finally { await runtime.dispose(); }
});

test('batch drafting reuses the review agents and accepts only a single revalidated Word target at a time', async () => {
  const out = join(root, '_scratch/out/review-tests');
  await mkdir(out, { recursive: true });
  const base = await mkdtemp(join(out, 'batch-'));
  const config = { root: join(base, 'catalog'), publicRoot: join(root, 'public'), sampleRoot: join(root, 'samples/figure') };
  let runtime = new WorkspaceRuntime(config);
  const chapterResponse = Promise.withResolvers();
  try {
    const projectId = await runtime.store.createProject({ title: '合成批量改稿测试' });
    const path = join(runtime.store.project(projectId).root_path, 'paper', 'synthetic.docx');
    await exec('python', ['-I', join(root, 'probes/manuscript-review/create-fixture.py'), path], { windowsHide: true });
    const original = await readFile(path);
    const objectId = await runtime.store.importWorkspaceFile({ projectId, path: 'paper/synthetic.docx' });
    runtime.nativeWriting.validateSession = async () => {};
    const thread = await runtime.nativeWriting.open({ projectId, objectId });
    await runtime.nativeWriting.bind({ projectId, jobId: thread, sessionId });
    const calls = [], busyChildren = new Set();
    let malformedResponses = 0;
    const fakeAgent = async ({ childId, prompt, published }) => {
      const data = JSON.parse(prompt.split('\n').at(-1));
      if (data.task === 'draft-review-revision') {
        assert.equal(childId, `batch-child-${data.finding.workerId}`);
        assert(prompt.startsWith(MANUSCRIPT_REVISION_GUIDANCE));
        assert.equal(data.authorRequest, MANUSCRIPT_REVIEW_TEMPLATES[0].prompt);
        assert(!busyChildren.has(childId), 'each child receives its own suggestions serially');
        busyChildren.add(childId);
        calls.push(data);
        if (data.finding.id === '2-1' && data.repair) await chapterResponse.promise;
        else await delay(15);
        busyChildren.delete(childId);
        const revise = text => text.replace(/。$/, `，已核对${data.finding.id}。`);
        if (data.finding.id === '2-1' && !data.repair) {
          return JSON.stringify({ paragraphs: data.original.map(text => `${revise(text)}[12]`), reason: '合成引用越界。', evidenceIds: [], warnings: [] });
        }
        if (data.finding.id === '1-3' && malformedResponses++ < 2) return '合成的非 JSON 回复';
        const reply = JSON.stringify({ ...(Array.isArray(data.original) ? { paragraphs: data.original.map(revise) } : { replacement: revise(data.original) }),
          reason: '采用审阅建议标明计量口径。', evidenceIds: [], warnings: [] });
        if (data.finding.id === '1-1') return '<acp source="fixture">continuation</acp>\n以下是改稿。\n' + reply + '\n<acp source="fixture">end</acp>';
        if (data.finding.id === '2-1') return '<acp source="fixture">continuation</acp>\n以下是改稿。\n```json\n' + reply + '\n```';
        return reply;
      }
      if (!data.section) return JSON.stringify({ summary: '核对各小节的计量口径。', relations: [{ from: '1-1', to: '2-1', kind: 'before', reason: '先定义再报告。' }] });
      if (!childId) await published(`batch-child-${data.section.id}`);
      const finding = (paragraph, quote = paragraph.text, scope = 'paragraph') => ({ index: paragraph.index, quote, issue: '计量口径需要说明。',
        suggestion: '明确计算口径。', steps: ['核对定义。'], prompt: '核对数量口径。', scope });
      const [first, second] = data.section.paragraphs;
      return JSON.stringify({ summary: '本节口径需要核对。', findings: data.section.id === 1
        ? [finding(first, '计量口径'), finding(first, '采用两种'), finding(second)] : [finding(first, first.text, 'chapter')] });
    };
    runtime.review.agent = fakeAgent;
    const { jobId } = await runtime.review.start({ projectId, objectId, expectedRevision: 1, operationKey: randomUUID() });
    const owner = { projectId, objectId, jobId };
    const snapshot = () => runtime.review.status(owner);
    const finish = async () => { await runtime.review.running.get(jobId)?.operation; assert.equal(snapshot().status, 'succeeded', snapshot().error); };
    await runtime.review.running.get(jobId).operation;
    await runtime.mutate('publishReviewComments', owner);
    await finish();
    const start = { ...owner, findingIds: ['2-1', '1-1', '1-2', '1-3'], expectedRevision: 2, operationKey: randomUUID() };
    await runtime.mutate('startReviewBatch', start);
    await runtime.mutate('startReviewBatch', start);
    const failedItem = () => snapshot().batch.items.find(item => item.findingId === '1-3');
    for (let tries = 0; tries < 200 && failedItem().state !== 'failed'; tries++) await delay(20);
    assert.equal(failedItem().errorCode, 'INVALID_PROPOSAL');
    assert.equal(snapshot().status, 'running');
    await runtime.mutate('startReviewBatch', { ...start, findingIds: ['1-3'], retry: true, operationKey: randomUUID() });
    assert.equal(failedItem().state, 'queued');
    chapterResponse.resolve();
    await finish();
    assert.equal(calls.length, 7, 'after one automatic repair per finding, the current batch handles the queued retry');
    assert.equal(calls.find(call => call.finding.id === '2-1' && call.repair)?.repair.code, 'CITATION_CHANGED');
    assert.deepEqual(calls.find(call => call.finding.id === '2-1').citationMarkers, [[], []]);
    assert.equal(calls.find(call => call.finding.id === '2-1').related[0].from, '1-1');
    assert.deepEqual(snapshot().batch.items.map(item => item.findingId), ['1-1', '1-2', '1-3', '2-1']);
    assert.deepEqual(snapshot().batch.items.map(({ state, error }) => error || state), ['ready', 'ready', 'ready', 'ready']);
    assert.equal(runtime.store.object(projectId, objectId).revision, 2, 'generation never modifies Word');
    const proposal = findingId => runtime.review.batchProposal({ ...owner, findingId });
    const accept = async findingId => {
      const draft = proposal(findingId);
      return (await runtime.mutate('applySentence', { projectId, jobId: draft.id, proposalUpdatedAt: draft.updatedAt })).actionResult.wordUpdate;
    };
    const route = new URL('http://local/api/research-workbench/review-status');
    route.search = new URLSearchParams({ ...owner, batch: '1' });
    const overview = await (await runtime.handle(new Request(route))).json();
    assert.equal(overview.batch.items.length, 4);
    assert(!JSON.stringify(overview).includes('replacement'));
    assert(!(await runtime.viewState()).projects[0].jobs.some(item => item.batchFindingId));
    route.search = new URLSearchParams({ ...owner, findingId: '1-1' });
    assert.equal((await (await runtime.handle(new Request(route))).json()).id, proposal('1-1').id);
    const commentStatus = async id => {
      const {path} = await runtime.wordEditing.source(projectId,objectId);
      const item = snapshot().findings.find(item => item.id === id);
      return runtime.wordEditing.inspect({path,resolveReviewComments:[{...item,author:item.path.at(-1)}]});
    };
    assert.equal((await commentStatus('1-1')).changed,true);
    assert.deepEqual(await accept('1-1'), { objectId, fromRevision: 2, revision: 3, reviewComment: 'resolved', reopen: true });
    assert.deepEqual(await commentStatus('1-1'),{changed:false,reviewCommentStates:['resolved']});
    assert.equal((await commentStatus('1-2')).changed,true);
    await assert.rejects(accept('1-2'), { code: 'REVIEW_BATCH_CONFLICT' });
    assert.equal(runtime.store.object(projectId, objectId).revision, 3);
    await runtime.mutate('skipReviewBatchItem', { ...owner, findingId: '1-3' });
    await assert.rejects(accept('1-3'), { code: 'REVISION_NOT_READY' });
    assert.deepEqual(await accept('2-1'), { objectId, fromRevision: 3, revision: 4, reviewComment: 'resolved', reopen: true });
    const stale = proposal('1-2');
    await runtime.mutate('startReviewBatch', { ...owner, findingIds: ['1-2'], retry: true, expectedRevision: 4, operationKey: randomUUID() });
    await finish();
    assert.notEqual(proposal('1-2').id, stale.id);
    assert.match(proposal('1-2').output.original, /已核对1-1/);
    assert.equal((await accept('1-2')).revision, 5);
    assert.deepEqual(await readFile(path), original);
    assert.equal((await runtime.wordEditing.inspect({ path: (await runtime.wordEditing.source(projectId, objectId)).path })).hasComments, true);
    await runtime.dispose();
    runtime = new WorkspaceRuntime(config);
    assert.deepEqual(snapshot().batch.items.map(item => item.state), ['adopted', 'adopted', 'skipped', 'adopted']);
    await runtime.mutate('undoSentence', { projectId, jobId: proposal('1-2').id });
    assert.equal(snapshot().batch.items[1].state, 'undone');
    assert.equal((await commentStatus('1-2')).changed,true);
    assert.equal((await commentStatus('2-1')).changed,false);
    assert.match(await runtime.wordEditing.context(projectId, objectId), /已核对1-1/);

    runtime.review.agent = fakeAgent;
    runtime.nativeWriting.validateSession = async () => {};
    await runtime.mutate('startReviewBatch', { ...owner, findingIds: ['1-2'], retry: true, expectedRevision: 6, operationKey: randomUUID() });
    await finish();
    const target = runtime.wordEditing.reviewTarget;
    runtime.wordEditing.reviewTarget = () => null; // Simulate a proposal adopted by the previous plugin version.
    assert.equal((await accept('1-2')).revision,7);
    runtime.wordEditing.reviewTarget = target;
    assert.equal((await commentStatus('1-2')).changed,true);
    const text = await runtime.wordEditing.context(projectId,objectId);
    assert.deepEqual(await runtime.wordEditing.syncReviewComments({...owner,expectedRevision:7}),{revision:8,resolved:3,unmatched:0});
    assert.equal(await runtime.wordEditing.context(projectId,objectId),text);
    assert.equal((await commentStatus('1-2')).changed,false);
    assert.equal(proposal('1-2').output.appliedRevision,8);
    await runtime.mutate('undoSentence', { projectId, jobId: proposal('1-2').id });
    assert.equal((await commentStatus('1-2')).changed,true);
    assert.equal((await commentStatus('1-1')).changed,false);
    assert.equal((await commentStatus('2-1')).changed,false);

    await runtime.mutate('startReviewBatch', { ...owner, findingIds: ['1-2'], retry: true, expectedRevision: 9, operationKey: randomUUID() });
    await finish();
    runtime.wordEditing.reviewTarget = () => null;
    assert.equal((await accept('1-2')).revision,10);
    runtime.wordEditing.reviewTarget = target;
    const beforeSync = await runtime.wordEditing.source(projectId,objectId);
    const unsaved = join(base,'unsaved-after-adoption.docx'), originalLine='方法段落保留原始单位。';
    await runtime.wordEditing.inspect({path:beforeSync.path,output:unsaved,replacement:'方法段落中保留了手动编辑。',
      selection:{anchor:{story:'body',path:[3],off:0},focus:{story:'body',path:[3],off:Buffer.byteLength(originalLine)},text:originalLine}});
    assert.equal((await runtime.wordEditing.syncReviewComments({...owner,expectedRevision:10})).revision,11);
    assert.deepEqual(await runtime.wordEditing.saveInteractive({...owner,expectedRevision:10,bytes:await readFile(unsaved)}),{revision:12,reopen:true});
    assert.match(await runtime.wordEditing.context(projectId,objectId), /保留了手动编辑/);
    assert.deepEqual(await runtime.wordEditing.syncReviewComments({...owner,expectedRevision:12}),{revision:12,resolved:3,unmatched:0});
  } finally { chapterResponse.resolve(); await runtime.dispose(); }
});

test('writing comments accepts a save with an identical review snapshot and rejects changed content', async () => {
  const out = join(root, '_scratch/out/review-tests');
  await mkdir(out, { recursive: true });
  const base = await mkdtemp(join(out, 'publish-after-save-'));
  const runtime = new WorkspaceRuntime({ root: join(base, 'catalog'), publicRoot: join(root, 'public'), sampleRoot: join(root, 'samples/figure') });
  try {
    const projectId = await runtime.store.createProject({ title: '合成批注版本测试' });
    const path = join(runtime.store.project(projectId).root_path, 'paper', 'synthetic.docx');
    await exec('python', ['-I', join(root, 'probes/manuscript-review/create-fixture.py'), path], { windowsHide: true });
    const original = await readFile(path);
    const objectId = await runtime.store.importWorkspaceFile({ projectId, path: 'paper/synthetic.docx' });
    runtime.nativeWriting.validateSession = async () => {};
    const thread = await runtime.nativeWriting.open({ projectId, objectId });
    await runtime.nativeWriting.bind({ projectId, jobId: thread, sessionId });
    runtime.review.agent = async ({ prompt }) => {
      const { section } = JSON.parse(prompt.split('\n').at(-1));
      if (!section) return JSON.stringify({ summary: '合成汇总。' });
      const paragraph = section.paragraphs[0];
      return JSON.stringify({ summary: '合成初审。', findings: [{ index: paragraph.index, quote: paragraph.text,
        issue: '定义需要核对。', suggestion: '补充定义。', steps: ['核对定义。'], prompt: '补充定义。' }] });
    };
    const data = { projectId, objectId };
    const { jobId } = await runtime.review.start({ ...data, expectedRevision: 1, operationKey: randomUUID() });
    const owner = { ...data, jobId };
    await runtime.review.running.get(jobId).operation;
    const rewritten = join(base, 'exported.docx'), changed = join(base, 'changed.docx');
    await exec('python', ['-I', '-X', 'utf8', '-c', [
      'import sys,zipfile',
      'with zipfile.ZipFile(sys.argv[1]) as source, zipfile.ZipFile(sys.argv[2], "w") as result:',
      ' for name in source.namelist():',
      '  part=source.read(name)',
      '  if name=="word/document.xml" and sys.argv[3]=="changed": part=part.replace("方法段落保留原始单位。".encode(),"方法段落采用换算单位。".encode())',
      '  result.writestr(name,part)',
      ' result.comment=b"new zip export"',
    ].join('\n'), path, changed, 'changed'], { windowsHide: true });
    await runtime.wordEditing.save({ ...data, expectedRevision: 1, bytes: await readFile(changed) });
    await assert.rejects(runtime.review.publish(owner), { code: 'VERSION_CONFLICT' });
    await runtime.wordEditing.save({ ...data, expectedRevision: 2, bytes: original });
    await exec('python', ['-I', '-c', 'import sys,zipfile; p=zipfile.ZipFile(sys.argv[1]); q=zipfile.ZipFile(sys.argv[2],"w"); q.comment=b"new zip export"; [q.writestr(n,p.read(n)) for n in p.namelist()]; q.close()', path, rewritten], { windowsHide: true });
    await runtime.wordEditing.save({ ...data, expectedRevision: 3, bytes: await readFile(rewritten) });
    assert.deepEqual(await runtime.review.publish(owner), { count: 2, revision: 5 });
    assert.equal(runtime.review.status(owner).commentRevision, 5);
    assert.deepEqual(JSON.parse(runtime.store.object(projectId,objectId).metadata).wordReviewUpdate,{fromRevision:4,revision:5});
    const stale=new Request('http://local/api/research-workbench/word?'+new URLSearchParams({...data,expectedRevision:4}),{
      method:'POST',headers:{'content-type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'},body:await readFile(changed),
    });
    const response=await runtime.handle(stale);
    assert.equal(response.status,200);
    assert.deepEqual((await response.json()).actionResult.wordUpdate,{objectId,revision:6,reopen:true});
    assert.match(await runtime.wordEditing.context(projectId,objectId),/方法段落采用换算单位。/);
    const {path:working}=await runtime.wordEditing.source(projectId,objectId);
    const {stdout}=await exec('python',['-I','-c',"import sys,zipfile,xml.etree.ElementTree as E;print(len(E.fromstring(zipfile.ZipFile(sys.argv[1]).read('word/comments.xml'))))",working],{windowsHide:true});
    assert.equal(Number(stdout),3);
  } finally { await runtime.dispose(); }
});
