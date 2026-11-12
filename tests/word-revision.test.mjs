import test from 'node:test';import assert from 'node:assert/strict';
import {selectionWithText} from '../src/shared/word-sentence-update.mjs';
import {mirrorWordRevision,restoreWordPosition} from '../src/client/word-revision.mjs';
test('replacement anchors normalize reversed selections and count Chinese and emoji as UTF-8 bytes',()=>{
  const selection={anchor:{story:'body',path:[40],off:35},focus:{story:'body',path:[40],off:10}};
  const range=selectionWithText(selection,'甲😀乙');assert.equal(range.anchor.off,10);assert.equal(range.focus.off,20);assert.deepEqual(range.anchor.path,[40]);
  assert.throws(()=>selectionWithText({...selection,focus:{story:'body',path:[41],off:0}},'甲'));
});
test('a mismatched live sentence is never silently overwritten or marked synchronized',async()=>{
  const calls=[],api={async execute(name){calls.push(name);return{text:'作者后来手动改过的文字'}}};let acknowledged=0;
  await assert.rejects(mirrorWordRevision(api,{selection:{anchor:{},focus:{},text:'原句'},replacement:'改句'},null,()=>acknowledged++),/不一致/);
  assert.deepEqual(calls,['select.range','document.selection']);assert.equal(acknowledged,0);
});
test('sentence updates mirror in the current document and correct scrolling without opening any document',async()=>{
  let text='原句',top=-1200,acknowledged=0;const calls=[];
  const api={async execute(name,args){calls.push([name,args]);if(name==='document.selection')return{text};if(name==='text.insert'){text=args.text;top=-900}},async uiInspect(){return{pages:[[0,top,600,800]],canvasRect:[0,0,800,600]}},async request(name,args){calls.push([name,args]);top+=args.dy}};
  const selection={anchor:{story:'body',path:[40],off:0},focus:{story:'body',path:[40],off:6},text:'原句'};
  await mirrorWordRevision(api,{selection,replacement:'修改😀'}, {selection,view:{pages:[[0,-1200,600,800]]}},async()=>acknowledged++);
  assert.equal(text,'修改😀');assert.equal(top,-1200);assert.equal(acknowledged,1);assert(!calls.some(([name])=>name==='file.open'||name==='file.close'||name==='document.setText'));
  assert.deepEqual(calls.find(([name])=>name==='text.insert')[1],{text:'修改😀',raw:true});
  assert.equal(calls.filter(([name])=>name==='select.range').at(-1)[1].focus.off,10);
});
test('historical position restoration tolerates removed paragraphs and missing geometry',async()=>{
  let calls=0;await restoreWordPosition({execute:async()=>{calls++;throw Error('paragraph removed')}},{selection:{anchor:{},focus:{}}});assert.equal(calls,1);
});
