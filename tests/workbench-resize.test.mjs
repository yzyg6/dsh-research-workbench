import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {defaultLayout} from '../src/shared/model.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),out=join(root,'_scratch/out/workbench-resize-tests');
await mkdir(out,{recursive:true});
const require=createRequire(join(root,'_scratch/tmp/ui-deps/package.json'));
const React=require('react'),{create,act}=require('react-test-renderer'),esbuild=require('esbuild'),reactPath=require.resolve('react');
const file=join(out,'dock.cjs');
esbuild.buildSync({entryPoints:[join(root,'src/client/App.jsx')],outfile:file,bundle:true,platform:'node',format:'cjs',loader:{'.css':'text'},alias:{react:reactPath},external:[reactPath],nodePaths:[join(root,'_scratch/tmp/ui-deps/node_modules'),join(root,'_scratch/tmp/editor-deps/node_modules')],logLevel:'silent'});
const {Dock}=require(file);

async function mount(t){
  const previous=Object.fromEntries(['requestAnimationFrame','cancelAnimationFrame','IS_REACT_ACT_ENVIRONMENT'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  let id=0,commits=0,renderer;const frames=new Map(),saved=[],panes=Object.fromEntries(['main','context','chat'].map(key=>[key,{style:{}}]));
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true,requestAnimationFrame:callback=>{frames.set(++id,callback);return id},cancelAnimationFrame:key=>frames.delete(key)});
  const board={clientWidth:1000,querySelector:selector=>panes[selector.match(/data-pane="(\w+)"/)[1]]};
  const layout=defaultLayout('figure');
  await act(async()=>{renderer=create(React.createElement(React.Profiler,{id:'dock',onRender:()=>commits++},React.createElement(Dock,{task:'figure',layout,onLayout:(value,event)=>saved.push({value,event}),children:{main:'document',context:'context',chat:'conversation'}})),{createNodeMock:element=>element.props.className==='rw-board'?board:null})});
  t.after(async()=>{await act(async()=>renderer.unmount());for(const [key,value] of Object.entries(previous)){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key]}});
  const event=x=>({clientX:x,pointerId:1,button:0,isTrusted:false,preventDefault(){},currentTarget:{setPointerCapture(){},releasePointerCapture(){}}});
  return {renderer,panes,saved,frames,event,commits:()=>commits,splitter:()=>renderer.root.findByProps({role:'separator'}),flush:()=>{const pending=[...frames.values()];frames.clear();for(const callback of pending)callback()}};
}

test('dense pointer movement coalesces to one frame without React commits, then saves the final pointer position once',async t=>{
  const view=await mount(t);
  await act(async()=>view.splitter().props.onPointerDown(view.event(500)));
  const afterStart=view.commits();
  for(let n=1;n<=150;n++)view.splitter().props.onPointerMove(view.event(500+n/2));
  assert.equal(view.frames.size,1);assert.equal(view.commits(),afterStart);assert.equal(view.saved.length,0);
  view.flush();assert.equal(view.commits(),afterStart);assert(view.panes.main.style.flex.startsWith('64.75 '));
  await act(async()=>view.splitter().props.onPointerUp(view.event(610)));
  assert.equal(view.saved.length,1);assert.equal(view.frames.size,0);
  assert.equal(view.saved[0].value.weights.main,67.9);assert.equal(view.saved[0].event.kind,'pointer-resize');
});

test('cancelled and lost pointer captures restore visible pane widths and leave persisted layout intact',async t=>{
  const view=await mount(t);
  for(const finish of ['onPointerCancel','onLostPointerCapture']){
    await act(async()=>view.splitter().props.onPointerDown(view.event(500)));
    view.splitter().props.onPointerMove(view.event(620));view.flush();
    await act(async()=>view.splitter().props[finish](view.event(620)));
    assert.equal(view.panes.main.style.flex,'58 1 0');assert.equal(view.panes.chat.style.flex,'32 1 0');
    assert.equal(view.frames.size,0);assert.equal(view.saved.length,0);
  }
});

test('keyboard resizing remains immediate and persists without waiting for an animation frame',async t=>{
  const view=await mount(t);
  await act(async()=>view.splitter().props.onKeyDown({...view.event(0),key:'ArrowRight'}));
  assert.equal(view.saved.length,1);assert.equal(view.saved[0].value.weights.main,61);
  assert.equal(view.saved[0].event.kind,'keyboard-resize');assert.equal(view.frames.size,0);
});
