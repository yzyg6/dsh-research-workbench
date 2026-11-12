import test from 'node:test';
import assert from 'node:assert/strict';
import {installNativeSentenceWriting} from '../src/server/native-writing.mjs';
import {hostTools} from '../src/server/tools.mjs';

test('the real DSH tool definitions mount live Word actions in the existing document conversation and its guard allows them',async t=>{
  try{await hostTools({get:()=>null})}catch{t.skip('DSH host SDK is not installed on this development machine');return}
  const definitions=[],guards=[],prompts=[],disposals=[];
  const child={tools:{restrict:()=>()=>{},register(tool){definitions.push(tool);return()=>{}},guard(fn){guards.push(fn);return()=>{}}},systemPrompt:{section(value){prompts.push(value.text);return()=>{}},context:()=>()=>{}},on:()=>()=>{}};
  const agent={id:'existing-document-chat',ctx:child};
  const service={validateSession:null,findSession:()=>({id:'current-job'}),snapshot:()=>({row:{id:'current-job'},input:{format:'docx',objectId:'current-document'}}),conversations:()=>[]};
  const runtime={nativeWriting:service,wordLive:{context:async id=>({contextId:'actual-context',sessionId:id}),edit:async(id,args)=>({saved:true,sessionId:id,action:args.action})},store:{projectRows:()=>[]},integrations:{},onMutation:()=>()=>{}};
  const ctx={agents:{list:()=>[agent]},sessionController:{listState:{summaryFor:()=>{},summarizeCold:()=>{},projectionsFor:()=>{}}},get:name=>name==='workspaceRegistry'?{list:()=>[]}:null,on:()=>()=>{},effect(factory){const off=factory();if(off)disposals.push(off)}};
  try{
    await installNativeSentenceWriting(ctx,runtime);
    const context=definitions.find(tool=>tool.name==='research_word_context'),edit=definitions.find(tool=>tool.name==='research_word_edit');
    assert(context);assert(edit);assert.equal(definitions.filter(tool=>tool.name.startsWith('research_word_format')).length,0);
    assert(guards.length);for(const guard of guards){assert.equal(guard({name:'research_word_edit'}),undefined);assert(guard({name:'shell'}))}
    assert(prompts.some(text=>text.includes('无需另开格式对话')));
    assert.equal(JSON.parse(await context.execute({},{agent})).sessionId,agent.id);
    assert.equal(JSON.parse(await edit.execute({action:'font',scope:'all',reason:'合成测试',contextId:'actual-context',fontFamily:'宋体'},{agent})).saved,true);
  }finally{disposals.reverse().forEach(dispose=>dispose())}
});
