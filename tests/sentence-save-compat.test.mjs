import test from 'node:test';
import assert from 'node:assert/strict';
import {createApi} from '../src/client/api.mjs';
import {installSentenceSave} from '../probes/revision-save/install-save.mjs';
import {wordFlow,sid} from '../probes/word-flow/harness.mjs';

test('a stale Host reports the save route mismatch clearly and leaves subsequent retries available',async()=>{
  const original=globalThis.fetch;let attempts=0;
  globalThis.fetch=async()=>++attempts===1?Response.json({error:'工作台不支持这个操作。',code:'UNKNOWN_ACTION'},{status:400}):Response.json({actionResult:{saved:true}});
  try{
    const api=createApi();await assert.rejects(api.mutate('editSentenceSuggestion',{}),error=>error.code==='HOST_UPDATE_REQUIRED'&&/输入.*保留/.test(error.message));
    assert.equal((await api.mutate('editSentenceSuggestion',{})).actionResult.saved,true);
  }finally{globalThis.fetch=original}
});

test('repair a legacy Host in place: edited text persists, conflicts remain 409, and adoption uses the edit',async t=>{
  const flow=await wordFlow(t);await flow.select();await flow.type('精简。');await flow.submit();
  const runtime=flow.runtime,originalMutate=runtime.mutate,jobId=runtime.nativeWriting.findSession(sid).id;
  class LegacyError extends Error{constructor(code,message,status=400){super(message);this.code=code;this.status=status}}
  runtime.mutate=async function(action,data){if(action==='editSentenceSuggestion')throw new LegacyError('UNKNOWN_ACTION','工作台不支持这个操作。');return originalMutate.call(this,action,data)};
  const previous=runtime.mutate;await assert.rejects(runtime.mutate('editSentenceSuggestion',{}),{code:'UNKNOWN_ACTION'});
  const repair=installSentenceSave(runtime,LegacyError);assert.equal(installSentenceSave(runtime,LegacyError),repair);
  await flow.click('左右对照与文献依据');await flow.click('编辑第 1 句建议');
  const {act}=(await import('node:module')).createRequire(new URL('../_scratch/tmp/ui-deps/package.json',import.meta.url))('react-test-renderer');
  await act(async()=>flow.renderer.root.findByProps({'aria-label':'第 1 句改后文字'}).props.onChange({target:{value:'修复后保存的合成标题'}}));
  await flow.click('保存本句');await flow.settle(()=>flow.button('采用修改')?.props.disabled===false);
  assert(JSON.parse(runtime.writing.row(flow.projectId,jobId).output).proposal.replacement.includes('修复后保存的合成标题'));
  assert.equal(runtime.store.object(flow.projectId,flow.objectId).revision,1);
  await assert.rejects(runtime.mutate('editSentenceSuggestion',{projectId:flow.projectId,jobId,expectedReplacement:'stale'}),error=>error instanceof LegacyError&&error.code==='VERSION_CONFLICT'&&error.status===409);
  await flow.click('采用修改');await flow.settle(()=>runtime.store.object(flow.projectId,flow.objectId).revision===2);
  assert((await runtime.wordEditing.context(flow.projectId,flow.objectId)).includes('修复后保存的合成标题'));assert.equal(flow.counts().opens,1);
  repair.restore();assert.equal(runtime.mutate,previous);
});
