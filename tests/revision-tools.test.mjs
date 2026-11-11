import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {WorkspaceRuntime} from '../src/server/runtime.mjs';
import {compareSentences,relatedPassages,validateSentenceChanges,PROMPT_TEMPLATES} from '../src/shared/revision-review.mjs';
import {readWordSidebarRatio,rememberWordSidebarRatio} from '../src/client/workbench-preferences.mjs';
import {systemFonts,systemFont} from '../src/server/revision-service.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),out=join(root,'_scratch/out/revision-tests');await mkdir(out,{recursive:true});
async function setup(){const base=await mkdtemp(join(out,'case-')),runtime=new WorkspaceRuntime({root:join(base,'catalog'),sampleRoot:join(root,'samples/figure'),publicRoot:join(root,'public')});const p=await runtime.store.createProject({title:'Git 历史合成测试'}),o=(await runtime.store.state()).projects[0].objects.find(o=>o.kind==='manuscript');return{runtime,p,o,base}}

test('sentence alignment preserves unchanged neighbours, decimals and original text across insertions',()=>{
  const before='第一句保持。第二句保持。Third sentence has 1.25 mg.',after='第一句保持。新增的句子。第二句保持。Third sentence has 1.25 mg.';
  const rows=compareSentences(before,after);assert.equal(rows.map(r=>r.before).join(''),before);assert.equal(rows.map(r=>r.after).join(''),after);
  assert.equal(rows.filter(r=>r.kind==='unchanged').length,3);assert(rows.some(r=>!r.before&&r.kind==='meaning'));assert.equal(compareSentences('可能增加10%。','一定增加20%。')[0].kind,'meaning');
});
test('model classifications must cover exact text and cannot hide a change as unchanged',()=>{
  assert(!validateSentenceChanges([{before:'甲。',after:'乙。',kind:'unchanged',reason:''}],'甲。','乙。'));
  assert(!validateSentenceChanges([{before:'甲。',after:'丙。',kind:'meaning',reason:''}],'甲。','乙。'));
  assert(!validateSentenceChanges([{before:'甲。',after:'乙。',kind:'__proto__',reason:''}],'甲。','乙。'));
  const rows=[{before:'甲。',after:'乙。',kind:'meaning',reason:'主语变化'}];assert.equal(compareSentences('甲。','乙。',rows)[0].source,'model');
  assert(PROMPT_TEMPLATES.every(t=>t.prompt.includes('不掩盖不利结果')&&t.prompt.includes('不补造数据')));
});
test('reminders point to real matches and exclude the edited passage',()=>{
  const rows=relatedPassages('摘要\n甲烷通量是10%。\n结果\n甲烷通量是10%，见图1。\n完全不相关的段落。','甲烷通量是10%。','甲烷通量是20%。');
  assert.equal(rows.length,1);assert.equal(rows[0].paragraph,4);assert(rows[0].matched.includes('10%'));assert.equal(rows[0].heading,'结果');
  assert.equal(relatedPassages('修改后的标题\n无关内容。','原始标题\n','修改后的标题\n').length,0);
});
test('document Git persists each save, diffs against parent, restores without losing later commits, and rolls back failed saves',async()=>{
  const {runtime:r,p,o,base}=await setup();try{
    await r.store.saveObject({projectId:p,objectId:o.id,expectedRevision:1,text:'第一版。'});
    await r.store.saveObject({projectId:p,objectId:o.id,expectedRevision:2,text:'第二版。'});
    let list=(await r.mutate('documentHistory',{projectId:p,objectId:o.id})).actionResult;assert.equal(list.entries.length,3);
    const first=list.entries[1],head=list.head,detail=(await r.mutate('documentHistoryDetail',{projectId:p,objectId:o.id,commit:head})).actionResult;assert.equal(detail.before,'第一版。');assert.equal(detail.text,'第二版。');
    await r.mutate('restoreDocumentHistory',{projectId:p,objectId:o.id,commit:first.commit,expectedRevision:3});
    list=(await r.mutate('documentHistory',{projectId:p,objectId:o.id})).actionResult;assert.equal(list.entries.length,4);assert.equal(list.entries[0].restoredFrom,first.commit);assert.equal((await r.store.asset(p,o.id)).bytes.toString(),'第一版。');
    await assert.rejects(r.mutate('restoreDocumentHistory',{projectId:p,objectId:o.id,commit:head,expectedRevision:2}),{code:'VERSION_CONFLICT'});
    const originalAppend=r.store.documentHistory.append.bind(r.store.documentHistory);r.store.documentHistory.append=async(...args)=>{const result=await originalAppend(...args);if(args[3]===5)throw Error('synthetic failure after Git ref');return result};
    await assert.rejects(r.store.saveObject({projectId:p,objectId:o.id,expectedRevision:4,text:'失败版本。'}),/synthetic failure/);
    r.store.documentHistory.append=originalAppend;assert.equal((await r.store.documentHistory.list(p,o.id)).head,list.head);assert.equal((await r.store.asset(p,o.id)).bytes.toString(),'第一版。');
    const another=await r.store.createProject({title:'其他项目'});await assert.rejects(r.mutate('documentHistoryDetail',{projectId:another,objectId:o.id,commit:head}),{code:'OBJECT_NOT_FOUND'});
    const repo=list.path;const result=await promisify(execFile)('git',['--git-dir='+repo,'fsck','--no-reflogs'],{windowsHide:true});assert(!result.stderr.includes('error'));
    await r.dispose();const reopened=new WorkspaceRuntime({root:join(base,'catalog'),sampleRoot:join(root,'samples/figure'),publicRoot:join(root,'public')});try{assert.equal((await reopened.store.documentHistory.list(p,o.id)).head,list.head)}finally{await reopened.dispose()}
  }finally{if(!r.store.closed)await r.dispose()}
});
test('DOCX history restores exact bytes, while keeping the original and single working path',async()=>{
  const {runtime:r,p,base}=await setup();try{
    const workspace=r.store.project(p).root_path,file=join(workspace,'paper','history-fixture.docx');await mkdir(join(workspace,'paper'),{recursive:true});await promisify(execFile)('python',['-I',join(root,'probes/word-reader/create-fixture.py'),'--output',file,'--paragraphs','3'],{windowsHide:true});
    const id=await r.store.importWorkspaceFile({projectId:p,path:'paper/history-fixture.docx'}),bytes=await readFile(file);
    await r.mutate('documentHistory',{projectId:p,objectId:id});const initial=(await r.store.documentHistory.list(p,id)).head;
    const parsed=await r.wordEditing.inspect({path:file}),text=parsed.text.split('\n')[0],temp=join(base,'changed.docx');
    await r.wordEditing.inspect({path:file,selection:{text,anchor:{story:'body',path:[0],off:0},focus:{story:'body',path:[0],off:Buffer.byteLength(text)}},replacement:'历史归档合成文稿',output:temp});
    await r.wordEditing.save({projectId:p,objectId:id,expectedRevision:1,bytes:await readFile(temp)});const path=r.store.object(p,id).path;
    await r.mutate('restoreDocumentHistory',{projectId:p,objectId:id,expectedRevision:2,commit:initial});assert.equal(r.store.object(p,id).path,path);assert.deepEqual((await r.store.asset(p,id)).bytes,bytes);assert.deepEqual(await readFile(file),bytes);assert.equal((await r.store.documentHistory.list(p,id)).entries.length,3);
  }finally{await r.dispose()}
});
test('system font access is bounded to installed allowlisted files, layout persists relative width',async()=>{
  await assert.rejects(systemFont('../../Windows/System32/config/SAM'),{code:'FONT_NOT_FOUND'});const fonts=await systemFonts();if(process.platform==='win32')assert(fonts.some(font=>font.id==='simsun'));
  const memory=new Map(),storage={getItem:k=>memory.get(k),setItem:(k,v)=>memory.set(k,v)};assert.equal(readWordSidebarRatio(storage),.38);rememberWordSidebarRatio(.41,storage);assert.equal(readWordSidebarRatio(storage),.41);
});

test('manual-save related reminders persist their checked state and refresh when text changes',async()=>{
  const {runtime:r,p,o}=await setup();try{
    const before='摘要\n甲烷通量是10%。\n结果\n甲烷通量是10%，见图1。';
    await r.store.saveObject({projectId:p,objectId:o.id,expectedRevision:1,text:before});
    await r.store.saveObject({projectId:p,objectId:o.id,expectedRevision:2,text:before.replace('是10%。','是20%。')});
    const list=(await r.mutate('reviewReminders',{projectId:p,objectId:o.id})).actionResult.reminders;assert(list.length>0);const item=list.find(x=>x.text.includes('见图1'));assert(item);
    await r.mutate('checkReminder',{projectId:p,objectId:o.id,id:item.id,checked:true});assert((await r.mutate('reviewReminders',{projectId:p,objectId:o.id})).actionResult.reminders.find(x=>x.id===item.id).checked);
  }finally{await r.dispose()}
});
