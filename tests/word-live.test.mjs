import test from 'node:test';
import assert from 'node:assert/strict';
import {WordLiveControl} from '../src/server/word-live.mjs';
import {WordLiveEditor,connectWordLive} from '../src/client/word-live.mjs';
import {wordCommand} from '../src/shared/word-live.mjs';

const owner={projectId:'paper',objectId:'doc',instanceId:'aaaaaaaa-1111-2222-3333-444444444444'};
function server(options){
  let revision=1,turn=1,jobId='job';
  const runtime={store:{object(p,o){assert.equal(p,'paper');assert.equal(o,'doc');return{revision}}},nativeWriting:{snapshot(s){assert.equal(s,'chat');return{row:{id:jobId,project_id:'paper'},input:{format:'docx',objectId:'doc',nativeTurn:turn,instruction:'全文字号改为12磅'}}},findSession(s){const {row,input}=this.snapshot(s);return{...row,input:JSON.stringify(input)}}}};
  const service=new WordLiveControl(runtime,options);service.poll(owner);
  const deliver=(result)=>{const {request}=service.poll(owner);assert(request);assert.equal(service.poll(owner).request,null,'a claimed request is never delivered twice');service.acknowledge({...owner,id:request.id,result:{revision,...result}});return request};
  return{service,deliver,rev:()=>revision++,turn:()=>turn++,job:()=>jobId='other-job'};
}
test('the same document chat reads a live context, executes once, and only confirms after a saved revision receipt',async()=>{
  const f=server();const read=f.service.context('chat');f.deliver({contextId:'live-1',text:'文稿',selection:{text:'选句'}});const context=await read;
  assert.equal(context.contextId,'live-1');assert(context.capabilities.includes('line_spacing'));
  const edit=f.service.edit('chat',{contextId:'live-1',action:'size',fontSizePt:12,scope:'all',reason:'全文12磅'});
  assert.equal(f.service.pending.size,1);f.rev();const command=f.deliver({saved:true});assert.equal(command.plan.fontSizePt,12);assert.equal((await edit).revision,2);
  await assert.rejects(f.service.edit('chat',{contextId:'live-1',action:'size',fontSizePt:12,scope:'all',reason:'重放'}),{code:'CONTEXT_REQUIRED'});f.service.dispose();
});
test('new turns, changed versions and foreign windows cannot apply a previously read context',async()=>{
  const f=server();let read=f.service.context('chat');f.deliver({contextId:'one'});await read;f.turn();
  const action={action:'align',alignment:'justify',scope:'all',reason:'两端对齐'};
  await assert.rejects(f.service.edit('chat',{...action,contextId:'one'}),{code:'CONTEXT_REQUIRED'});
  read=f.service.context('chat');f.deliver({contextId:'two'});await read;f.rev();await assert.rejects(f.service.edit('chat',{...action,contextId:'two'}),{code:'VERSION_CONFLICT'});
  assert.throws(()=>f.service.poll({...owner,instanceId:'bbbbbbbb-1111-2222-3333-444444444444'}),{code:'WORD_EDITOR_OWNED'});
  read=f.service.context('chat');const request=f.service.poll(owner).request;
  assert.throws(()=>f.service.acknowledge({...owner,objectId:'other',id:request.id,result:{revision:2}}),{code:'INVALID_BINDING'});
  f.service.acknowledge({...owner,id:request.id,error:'编辑器已关闭'});await assert.rejects(read,{code:'WORD_EDIT_FAILED'});f.service.dispose();
});
test('queued work is cancelled when its conversation target changes, closes or times out; running outcomes are marked unknown',async()=>{
  const f=server({timeoutMs:20});let read=f.service.context('chat');f.job();assert.equal(f.service.poll(owner).request,null);await assert.rejects(read,{code:'CONTEXT_CHANGED'});
  read=f.service.context('chat');f.service.poll({...owner,release:true});await assert.rejects(read,{code:'WORD_CLOSED'});
  f.service.poll(owner);const controller=new AbortController();read=f.service.context('chat',controller.signal);f.service.poll(owner);controller.abort();await assert.rejects(read,/结果待确认/);
  read=f.service.context('chat');const keepAlive=setTimeout(()=>{},50);await assert.rejects(read,/未领取操作/);clearTimeout(keepAlive);assert.equal(f.service.poll(owner).request,null);f.service.dispose();
});
function editorFixture(){
  let revision=1,dirty=false,selection={anchor:{story:'body',path:[0],off:0},focus:{story:'body',path:[0],off:6},text:'中文'},format=12,saveFailure=false;
  const calls=[],bridge={async execute(command,params){calls.push([command,params]);if(command==='document.selection')return structuredClone(selection);if(command==='document.text')return{text:'中文  正文\n\nEnglish words'};if(command==='document.inspect')return{selection:structuredClone(selection),blocks:[{index:0,type:'paragraph',props:{size:format}}],canUndo:true};if(command==='font.list')return{families:['SimSun']};if(command==='select.all')return{};format=params.size||format;dirty=true;return{changed:true}}};
  const editor=new WordLiveEditor({bridge,managed:async()=>{},revision:()=>revision,dirty:()=>dirty,save:async()=>{if(saveFailure)throw Error('磁盘不可写');if(dirty){revision++;dirty=false}}});
  return{editor,calls,dirty:()=>dirty=true,move:()=>selection.focus.off=3,failSave:()=>saveFailure=true};
}
test('direct editor actions use native commands and save in place; moving the selection or manual edits invalidate context',async()=>{
  const f=editorFixture();let context=await f.editor.run({kind:'context'});
  const result=await f.editor.run({kind:'edit',contextId:context.contextId,plan:{action:'size',fontSizePt:12,scope:'all'}});
  assert.equal(result.saved,true);assert.equal(result.revision,2);assert.deepEqual(f.calls.filter(([name])=>name==='select.all'||name==='format.size'),[['select.all',{whole:true}],['format.size',{size:12}]]);assert(!f.calls.some(([name])=>name==='document.setText'||name==='file.open'));
  context=await f.editor.run({kind:'context'});f.move();await assert.rejects(f.editor.run({kind:'edit',contextId:context.contextId,plan:{action:'bold',enabled:true,scope:'selection'}}),/选区已变化/);
  context=await f.editor.run({kind:'context'});f.dirty();await assert.rejects(f.editor.run({kind:'edit',contextId:context.contextId,plan:{action:'remove_blank_paragraphs',scope:'all'}}),/已编辑/);
});
test('a failed save reports the changed editor honestly, rather than reporting saved or replaying the edit',async()=>{
  const f=editorFixture(),context=await f.editor.run({kind:'context'});f.failSave();
  const request={kind:'edit',contextId:context.contextId,plan:{action:'remove_extra_spaces',scope:'selection'}};
  await assert.rejects(f.editor.run(request),/已执行操作，但保存未确认/);await assert.rejects(f.editor.run(request),/重新读取/);
  assert.equal(f.calls.filter(([name])=>name==='para.removeExtraSpaces').length,1);
});
test('closing or switching Word during font loading cannot edit or save a different document',async()=>{
  let active=true,release;const loaded=new Promise(resolve=>release=resolve),f=editorFixture();
  f.editor.active=()=>{if(!active)throw Error('Word 已切换文稿')};f.editor.loadFonts=()=>loaded;
  const context=await f.editor.run({kind:'context'}),operation=f.editor.run({kind:'edit',contextId:context.contextId,plan:{action:'font',fontFamily:'宋体',scope:'all'}});
  await new Promise(resolve=>setImmediate(resolve));active=false;release();await assert.rejects(operation,/已切换文稿/);
  assert.equal(f.calls.filter(([name])=>name==='format.font'||name==='select.all').length,0);
});
test('lost acknowledgement retries only the receipt, never the native operation',async()=>{
  let runs=0,polls=0,acks=0,complete;const done=new Promise(resolve=>complete=resolve);
  const disconnect=connectWordLive({api:{async wordControl(action,data){if(data.release)return{};if(action==='ack'){acks++;if(acks===1)throw Error('network lost');complete();return{accepted:true}}polls++;return{request:polls===1?{id:'one',kind:'edit'}:null}}},owner,editor:{async run(){runs++;return{saved:true,revision:2}}},lock(){},onError(){}});
  await done;disconnect();assert.equal(runs,1);assert.equal(acks,2);
});
test('actions validate fields and units, rejecting scripts, raw commands and unrelated text replacement',()=>{
  assert.deepEqual(wordCommand({action:'font',fontFamily:'宋体',latinFontFamily:'Times New Roman',scope:'all'}),{command:'format.font',params:{eastAsia:'SimSun',name:'Times New Roman'}});
  for(const action of[{action:'size',scope:'all',fontSizePt:NaN},{action:'font',scope:'all',fontFamily:'<script>'},{action:'document.setText',scope:'all'},{action:'align',scope:'all',alignment:'center',path:'other.docx'},{action:'bold',scope:'all'},{action:'indents',scope:'all'}])assert.throws(()=>wordCommand(action));
});
