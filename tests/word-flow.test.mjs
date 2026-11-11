import test from 'node:test';import assert from 'node:assert/strict';import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';import {WorkspaceRuntime} from '../src/server/runtime.mjs';
import {wordFlow,sid} from '../probes/word-flow/harness.mjs';

test('Word flow: select → native request/model → full context/local evidence → side-by-side review → adopt → undo',async t=>{
  const flow=await wordFlow(t),original=await readFile(flow.file),originalText=await flow.runtime.wordEditing.context(flow.projectId,flow.objectId);
  const discussion=await flow.runtime.nativeWriting.readContext(sid,'Word');assert.equal(discussion.conversationOnly,true);assert(discussion.evidence.sources.length>0,'whole-article discussion also scopes local evidence to its project');
  const selected=await flow.select();assert(flow.input().draft.includes(selected));assert.equal(flow.messages.length,0);
  const request='精简所选标题并保留合成标识。';await flow.type(request);await flow.chooseModel('offline-model-B');await flow.submit();
  const context=flow.context();assert(context.article.includes('第3段'));assert.equal(context.selectedText,selected);assert.equal(context.instruction,request);
  assert((await flow.runtime.writing.evidence.local(flow.projectId,['word'])).length>0,'fixture path and keyword must work independently');
  assert(context.evidence.sources.length>0,'native context must retain local evidence from the owning workspace');assert.equal(context.evidence.zotero,'unavailable');
  await flow.click('左右对照与文献依据');assert(flow.all().includes('aria-label":"修改前'));assert(flow.all().includes('aria-label":"修改后'));assert(flow.all().includes('合成验证说明.md'));assert(flow.all().includes('检索命中 · 未采用'));assert(flow.all().includes('offline-model-B'));
  const jobId=flow.runtime.nativeWriting.findSession(sid).id;
  await flow.click('采用修改');await flow.settle(()=>flow.runtime.store.object(flow.projectId,flow.objectId).revision===2&&flow.counts().opens>=2&&!flow.frame.inert&&flow.button('撤回本次采用')?.props.disabled===false);
  assert((await flow.runtime.wordEditing.context(flow.projectId,flow.objectId)).startsWith('合成 Word 阅读验证'));assert.deepEqual(await readFile(flow.file),original);
  await flow.click('撤回本次采用');await flow.settle(()=>flow.runtime.store.object(flow.projectId,flow.objectId).revision===3&&flow.counts().opens>=3&&!flow.frame.inert);
  assert.equal(await flow.runtime.wordEditing.context(flow.projectId,flow.objectId),originalText);assert.deepEqual((await flow.runtime.store.asset(flow.projectId,flow.objectId)).bytes,original);assert.equal(flow.runtime.store.versions(flow.projectId,flow.objectId).length,2);
  assert.equal(JSON.parse(flow.runtime.writing.row(flow.projectId,jobId).output).review,'undone');assert.equal(flow.runtime.nativeWriting.conversations(flow.projectId).length,1);assert.equal(flow.counts().retained,1);assert.equal(flow.counts().created,0);
  assert.equal(flow.counts().frames,1,'adoption and undo reuse one editor frame');
  const restored=new WorkspaceRuntime({root:join(flow.directory,'restored-catalog'),sampleRoot:join(flow.directory,'unused-samples'),publicRoot:join(flow.directory,'unused-public')});
  try{assert.equal(await restored.store.openWorkspace({path:flow.workspace}),flow.projectId);assert.equal(restored.store.versions(flow.projectId,flow.objectId).length,2);const saved=JSON.parse(restored.writing.row(flow.projectId,jobId).output);assert.equal(saved.review,'undone');assert.equal(saved.evidence.sources[0].title,'合成验证说明.md');assert.equal(saved.instruction,request);assert.equal(restored.nativeWriting.conversations(flow.projectId)[0].sessionId,sid)}finally{await restored.dispose()}
  await writeFile(join(flow.directory,'flow-result.json'),JSON.stringify({steps:flow.steps,counts:flow.counts(),originalRestored:true,savedWordFiles:2,internalRevision:3,nativeServices:'explicit test doubles',model:'offline-script'},null,2));
});

async function manualVersion(flow,replacement){
  const {path}=await flow.runtime.wordEditing.source(flow.projectId,flow.objectId),text=(await flow.runtime.wordEditing.context(flow.projectId,flow.objectId)).split('\n')[0],temporary=join(flow.directory,'manual-version.docx');
  const selection={anchor:{story:'body',path:[0],off:0},focus:{story:'body',path:[0],off:Buffer.byteLength(text,'utf8')},text};
  await flow.runtime.wordEditing.inspect({path,selection,replacement,output:temporary});
  await flow.runtime.wordEditing.save({projectId:flow.projectId,objectId:flow.objectId,expectedRevision:flow.runtime.store.object(flow.projectId,flow.objectId).revision,bytes:await readFile(temporary)});
  await flow.publish();await flow.settle(()=>!flow.frame.inert);
}

test('review disables adoption immediately when the displayed Word revision has newer manual edits',async t=>{
  const flow=await wordFlow(t);await flow.select();await flow.type('只精简标题。');await flow.submit();await flow.click('左右对照与文献依据');
  await manualVersion(flow,'人工修改的合成稿标题');
  assert.equal(flow.button('采用修改').props.disabled,true,'stale comparison must not invite adoption');
  assert(flow.all().includes('重新选句'));assert((await flow.runtime.wordEditing.context(flow.projectId,flow.objectId)).startsWith('人工修改的合成稿标题'));
});

test('review disables undo when later manual Word edits would be overwritten',async t=>{
  const flow=await wordFlow(t);await flow.select();await flow.type('只精简标题。');await flow.submit();await flow.click('左右对照与文献依据');await flow.click('采用修改');
  await flow.settle(()=>flow.runtime.store.object(flow.projectId,flow.objectId).revision===2&&flow.counts().opens>=2);
  await manualVersion(flow,'采用后人工编辑的合成稿');
  assert.equal(flow.button('撤回本次采用').props.disabled,true,'undo cannot replace later manual edits');
  assert(flow.all().includes('采用后正文已有更新'));assert.equal(flow.runtime.store.object(flow.projectId,flow.objectId).revision,3);
});
