import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkspaceRuntime } from '../src/server/runtime.mjs';
import { translationMap } from '../src/server/word-translation.mjs';
import { translateWithTeam, translationSchedule } from '../src/server/translation-team.mjs';

test('completed translations from before team dispatch are reported as reused only with full final coverage', () => {
  const chapter = id => ({id,title:id,part:{id:'methods',title:'方法'},units:[{id,source:'正文'}]});
  const input = {chapters:[chapter('a'),chapter('b')]};
  const output = {team:{document:{plan:{}},parts:{methods:{}}},chapters:[
    {state:'adopted',values:{a:'First.'}},{state:'ready',values:{b:'Second.'}},
  ]};
  const part = status => translationSchedule(input,output,status).parts[0];
  assert.equal(part('succeeded').state,'reused');
  assert(part('succeeded').sections.every(s => s.state === 'reused' && s.paragraphs[0].state === 'reused'));
  output.chapters[1].values.b = ' ';
  assert.equal(part('succeeded').state,'unverified');
  output.chapters[1] = {state:'queued',values:{},drafts:{b:'Second draft.'}};
  assert.equal(part('running').state,'queued');
  assert.equal(part('failed').state,'pending');
  assert.equal(part('running').sections[0].state,'reused');
  assert.equal(part('running').sections[1].state,'queued');
  output.team.parts.methods.dispatchError = {task:'part-plan',error:'Failed'};
  assert.equal(part('failed').state,'failed');
});

test('an oversized review switches to a fresh child with bounded peer material and intact source, drafts and parent relationships', async () => {
  const unit = {id:'p1',source:'面积为 8 525.5 km²。'};
  const text = 'The area was 8,525.5 km².';
  const input = {journal:'',chapters:[{id:'c1',title:'方法',units:[unit]}]};
  const output = {chapters:[{state:'queued',values:{}}]};
  const attempts = [];
  const note = 'shared terminology '.repeat(60);
  await translateWithTeam({input,output,system:'synthetic',parentId:'root',signal:new AbortController().signal,
    save:async()=>{},translationMap,agent:async ({childId,lineage,prompt,published}) => {
      const data = JSON.parse(prompt.split('\n').at(-1));
      if (!childId) await published(randomUUID());
      if (data.task === 'section-review') {
        attempts.push({childId,lineage,data});
        if (attempts.length === 1) throw Error('upstream 400: prompt is too long: 1840925 tokens > 1048576 maximum');
      }
      if (['paragraph-translation','section-review'].includes(data.task)) return JSON.stringify({translations:[{id:unit.id,english:text}]});
      return JSON.stringify({notes:note,glossary:[]});
    }});
  assert.equal(attempts.length,2);
  assert.equal(attempts[0].childId,output.chapters[0].childId);
  assert.equal(attempts[1].childId,undefined);
  assert.notEqual(output.chapters[0].reviewChildId,output.chapters[0].childId);
  assert.deepEqual(attempts[1].lineage,attempts[0].lineage);
  assert.deepEqual(attempts[1].data.units,[unit]);
  assert.deepEqual(attempts[1].data.drafts,attempts[0].data.drafts);
  assert(attempts[1].data.document.length < attempts[0].data.document.length);
  assert.equal(output.chapters[0].state,'ready');
});

test('scientific quantities survive academic English notation and a caption label stays distinct from the sample size', () => {
  const unit = {id:'u1',source:'图 3　429 座水库的 CH₄ 在 11 月至次年 3 月占 20%，面积 8 525.5 km²。'};
  const valid = 'Figure 3. Across 429 reservoirs covering 8,525.5 km², methane accounted for 20% from November to March. CH₄ was measured.';
  const read = english => translationMap(JSON.stringify({translations:[{id:'u1',english}]}),[unit]);
  assert.equal(read(valid).u1,valid);
  for (const invalid of [valid.replace('8,525.5','8,526.5'),valid.replace('429','3,429'),valid.replace('20%','-20%'),
    valid.replace('March','May'),valid.replace('km²','m²'),valid.replace('methane','nitrogen').replace('CH₄','Nitrogen')]) {
    assert.throws(() => read(invalid), /译文/);
  }
  assert.throws(() => read('Could you please provide the missing table?'), /反馈/);
});

const root = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);
const english = {
  '1 方法':'1 Methods',
  '1.1 合成采样':'1.1 Synthetic sampling',
  '合成方法采用两种计量口径。':'The synthetic method uses two accounting definitions.',
  '方法段落保留原始单位。':'The methods retain the original units.',
  '2 结果':'2 Results',
  '2.1 合成估计值':'2.1 Synthetic estimates',
  '结果沿用合成方法的计量口径。':'The results follow the accounting definitions of the synthetic method.',
  '结果段落报告对应区间。':'The results report the corresponding intervals.',
  '采用公式⟦1⟧计算温室气体排放[8,11]。':'Equation ⟦1⟧ was used to calculate greenhouse gas emissions [8,11].',
  '水库面积为 2.5 km²。':'Reservoir area was 2.5 km².',
  '图 1 合成排放量':'Figure 1. Synthetic emissions',
  '参考文献':'References',
  '合成方法':'The synthetic method',
};

test('Word translation resumes safely, adopts into a separate file and keeps citations, formulas, figures and references', async () => {
  const directory = join(root, '_scratch/out/word-translation');
  await mkdir(directory, { recursive:true });
  const base = await mkdtemp(join(directory, 'case-'));
  const runtime = new WorkspaceRuntime({ root:join(base, 'catalog'), sampleRoot:join(root, 'samples/figure'), publicRoot:join(root, 'public') });
  try {
    const projectId = await runtime.store.createProject({ title:'Translation fixture', journal:'Fixture Journal' });
    const file = join(runtime.store.project(projectId).root_path, 'paper', 'synthetic.docx');
    await exec('python', ['-I', join(root,'probes/manuscript-review/create-fixture.py'), file,'--translation-fixture'], { windowsHide:true });
    const original = await readFile(file);
    const objectId = await runtime.store.importWorkspaceFile({ projectId, path:'paper/synthetic.docx' });
    const source = { projectId, objectId };
    const manuscriptSession = 'session-00000000-1111-2222-3333-444444444444';
    runtime.nativeWriting.validateSession = async () => {};
    const conversation = await runtime.nativeWriting.open(source);
    await runtime.nativeWriting.bind({projectId,jobId:conversation,sessionId:manuscriptSession});
    const calls = [];
    let rejectResults = true;
    let droppedCitation = false;
    const dispatchAttempts = [];
    let selectionAttempts = 0;
    runtime.translation.agent = async ({ parentId, childId, prompt, published }) => {
      const content=JSON.parse(prompt.split('\n').at(-1));
      const id=childId||randomUUID();
      if(!childId)await published(id);
      calls.push({...content,parentId,id});
      const response = value => (childId ? '<acp tokens="5" type="text">m00001</acp>\n' : '') + JSON.stringify(value);
      if (content.task==='section-review') {
        assert(prompt.includes('research_translation_humanizer'));
        if (content.units[0].source === '合成方法') return response({translations:[{id:content.units[0].id,english:'The synthetic method with 99 samples.'}]});
        return response({translations:content.drafts});
      }
      if (content.task!=='paragraph-translation') {
        return response({notes:content.task,glossary:[{source:'计量口径',english:'accounting definitions'}]});
      }
      if (content.units[0].source === '合成方法' && ++selectionAttempts <= 2) {
        return response({translations:[{id:content.units[0].id,english:'Please confirm the intended terminology.'}]});
      }
      if (content.units[0].kind === 'table-cell' && rejectResults) {
        const current = runtime.translation.status(source);
        const node = current.schedule.parts.flatMap(part => part.sections).flatMap(section => section.paragraphs)
          .find(unit => unit.id === content.units[0].id);
        dispatchAttempts.push([node.state,node.task]);
        throw Error('Synthetic temporary model failure');
      }
      return response({ translations:content.units.map(unit => {
        const replacement = english[unit.source];
        assert(replacement, 'unexpected fixture source: ' + unit.source);
        if (unit.source.includes('[8,11]') && !droppedCitation) {
          droppedCitation = true;
          return { id:unit.id, english:replacement.replace(' [8,11]', '') };
        }
        return { id:unit.id, english:replacement };
      }) });
    };
    await runtime.start();
    const begin = async (scope, data={}) => (await runtime.mutate('startWordTranslation', {
      ...source, scope, expectedRevision:1, operationKey:randomUUID(), ...data,
    })).actionResult.jobId;
    const ready = async jobId => {
      for (let tries=0;tries<200;tries++) {
        const current=runtime.translation.status({ ...source, jobId });
        if (['succeeded','failed'].includes(current.status)) return current;
        await delay(35);
      }
      assert.fail('Translation did not finish');
    };
    const jobId = await begin('document');
    let status = await ready(jobId);
    const owner = { ...source, jobId };
    assert.equal(status.journal, 'Fixture Journal');
    assert.equal(status.status, 'failed');
    const failed = status.chapters.find(chapter => chapter.state === 'failed');
    assert(failed);
    assert(dispatchAttempts.some(([state,task]) => state === 'running' && task === 'paragraph-translation'));
    assert(dispatchAttempts.some(([state]) => state === 'retrying'));
    const failedSection = status.schedule.parts.flatMap(part => part.sections).find(node => node.id === failed.id);
    const failedWorker = failedSection.paragraphs.find(node => node.kind === 'table-cell' && node.state === 'failed');
    assert.match(failedWorker.error, /可继续/);
    assert(failed.images.some(image => image.state === 'chinese'));
    assert(status.chapters.some(chapter => chapter.state === 'ready'));
    assert(!status.target);
    assert.deepEqual(await readFile(file), original);
    rejectResults = false;
    const firstChapterCalls = calls.filter(call => call.task==='paragraph-translation'&&call.chapter === '1 方法').length;
    await runtime.mutate('retryWordTranslation', owner);
    status = await ready(jobId);
    assert.equal(status.status, 'succeeded', JSON.stringify(status.chapters));
    assert.equal(status.schedule.document.state, 'done');
    for (const part of status.schedule.parts) {
      assert.equal(part.state, 'done');
      for (const section of part.sections) {
        assert.equal(section.state, 'done');
        assert(section.paragraphs.every(p => p.state === 'done' && !p.error));
      }
    }
    assert.equal(calls.filter(call => call.task==='paragraph-translation'&&call.chapter === '1 方法').length, firstChapterCalls);
    assert(calls.some(call => call.repair?.includes('引文')));
    assert(calls.some(call => call.units?.some(unit => unit.kind === 'caption')));
    assert(!calls.some(call => call.units?.some(unit => unit.source.includes('原始文献题名'))));
    const part=calls.find(call=>call.task==='part-plan'&&call.title==='1 方法');
    const section=calls.find(call=>call.task==='section-plan'&&call.chapter==='1.1 合成采样');
    const paragraph=calls.find(call=>call.task==='paragraph-translation'&&call.chapter===section.chapter);
    assert.equal(part.parentId,manuscriptSession);
    assert.equal(section.parentId,part.id);
    assert.equal(paragraph.parentId,section.id);
    assert(paragraph.glossary.some(term=>term.english==='accounting definitions'));
    const review=calls.find(call=>call.task==='section-review'&&call.chapter===section.chapter);
    assert.equal(review.id,section.id);
    assert(review.neighbors.after.some(neighbor=>neighbor.english.includes('2 Results')));
    assert(review.partReview.notes==='part-review');
    assert.equal(review.repair,undefined);
    const chapter = runtime.translation.status({ ...owner, chapterId:failed.id }).current;
    const cell = chapter.units.find(unit => unit.kind === 'table-cell');
    const edit = { ...owner, chapterId:chapter.id, unitId:cell.id, previous:cell.english };
    await assert.rejects(runtime.mutate('editWordTranslation', { ...edit, english:'Reservoir area was 3.5 km².' }), { code:'TRANSLATION_NUMBERS' });
    await runtime.mutate('editWordTranslation', { ...edit, english:'The reservoir area was 2.5 km².' });
    const response = await runtime.handle(new Request('http://localhost/api/research-workbench/translation-status?' +
      new URLSearchParams({ ...owner, chapterId:chapter.id })));
    assert.equal(response.status, 200);
    status = await response.json();
    const first = await runtime.mutate('adoptWordTranslation', { ...owner, chapterId:chapter.id, updatedAt:status.updatedAt });
    const target = first.actionResult.target;
    assert.notEqual(target.id, objectId);
    assert.match(await runtime.wordEditing.context(projectId, target.id), /The reservoir area was 2.5 km²/);
    assert.match(await runtime.wordEditing.context(projectId, target.id), /1 方法/);
    status = runtime.translation.status(owner);
    assert.equal(status.chapters.filter(chapter => chapter.state === 'adopted').length, 1);
    const second = await runtime.mutate('adoptWordTranslation', { ...owner, updatedAt:status.updatedAt });
    assert.equal(second.actionResult.target.id, target.id);
    assert.equal(second.actionResult.target.revision, target.revision + 1);
    const dest = (await runtime.wordEditing.source(projectId, target.id)).path;
    const changed = (await exec('python', ['-I','-X','utf8','-c', [
      'import sys,zipfile',
      'a,b=[zipfile.ZipFile(path) for path in sys.argv[1:]]',
      'assert a.namelist()==b.namelist()',
      "assert [name for name in a.namelist() if a.read(name)!=b.read(name)]==['word/document.xml']",
      "print(b.read('word/document.xml').decode())",
    ].join('\n'),file,dest], { windowsHide:true })).stdout;
    assert.match(changed, /<m:oMath><m:r><m:t>x<\/m:t>/);
    assert.match(changed, /greenhouse gas emissions \[8,11\]/);
    assert.match(changed, /<w:tbl>/);
    assert.match(changed, /Figure 1\. Synthetic emissions/);
    assert.match(changed, /\[8\] 合成作者。原始文献题名。2021。/);
    assert.match(changed, /1 Methods/);
    assert.equal((await runtime.store.documentHistory.list(projectId,target.id)).entries.length,2);
    assert.deepEqual(await readFile(file), original);

    const point = { story:'body', path:[2], off:0 };
    const selection = { anchor:point, focus:{ ...point, off:Buffer.byteLength('合成方法') }, text:'合成方法' };
    const selectedJob = await begin('selection', { journal:'Another Journal', wordSelection:selection });
    const selected = await ready(selectedJob);
    assert.equal(selected.journal, 'Another Journal');
    assert.equal(selected.current.units.length, 1);
    assert.equal(selected.current.units[0].source, '合成方法');
    assert.equal(selected.current.units[0].english, 'The synthetic method');
    assert.equal(selectionAttempts, 3);
    assert.equal(selected.current.units[0].retainedDraft, true);
    const adopted = await runtime.mutate('adoptWordTranslation', { ...source, jobId:selectedJob, chapterId:selected.current.id, updatedAt:selected.updatedAt });
    const text = await runtime.wordEditing.context(projectId, adopted.actionResult.target.id);
    assert.match(text, /The synthetic method采用两种计量口径。/);
    assert.match(text, /2 结果/);
    assert.deepEqual(await readFile(file), original);
  } finally { await runtime.dispose(); }
});
