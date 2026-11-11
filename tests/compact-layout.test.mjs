import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {readSidebarCollapsed,rememberSidebarCollapsed} from '../src/client/workbench-preferences.mjs';
import {setWordRibbon,wordZoom} from '../src/client/wordcraft-view.mjs';

test('same-document updates retain manual zoom or fit mode, and invalid values use 95 percent',()=>{
 assert.equal(wordZoom({view:{zoom:1.5,fit:''}}),150);
 assert.equal(wordZoom({view:{zoom:1.5,fit:'pageWidth'}}),'pageWidth');
 assert.equal(wordZoom({}),95);assert.equal(wordZoom({view:{zoom:NaN}}),95);
});

test('icon rail preference defaults compact, persists both choices, and survives unavailable storage',()=>{
  const values=new Map(),storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
  assert.equal(readSidebarCollapsed(storage),true);
  rememberSidebarCollapsed(false,storage);assert.equal(readSidebarCollapsed(storage),false);
  rememberSidebarCollapsed(true,storage);assert.equal(readSidebarCollapsed(storage),true);
  const denied={getItem(){throw Error('denied')},setItem(){throw Error('denied')}};
  assert.equal(readSidebarCollapsed(denied),true);assert.doesNotThrow(()=>rememberSidebarCollapsed(false,denied));
});

test('Word ribbon preference is idempotent and executes only a display command',async()=>{
  let collapsed=false;const calls=[];
  const api={uiInspect:async()=>({ui:{ribbonCollapsed:collapsed}}),execute:async(name,args)=>{calls.push({name,args});collapsed=!collapsed}};
  await setWordRibbon(api,true);await setWordRibbon(api,true);
  assert.equal(collapsed,true);assert.deepEqual(calls,[{name:'ui.collapseRibbon',args:{}}]);
  await setWordRibbon(api,false);await setWordRibbon(api,false);
  assert.equal(collapsed,false);assert.deepEqual(calls.map(call=>call.name),['ui.collapseRibbon','ui.collapseRibbon']);
});

const root=fileURLToPath(new URL('../',import.meta.url)),out=join(root,'_scratch/out/compact-layout-tests');await mkdir(out,{recursive:true});
const require=createRequire(join(root,'_scratch/tmp/ui-deps/package.json')),esbuild=require('esbuild'),file=join(out,'render.cjs');
esbuild.buildSync({stdin:{contents:`import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {WorkbenchSidebar} from ${JSON.stringify(join(root,'src/client/WorkbenchSidebar.jsx'))};export function render(props){return renderToStaticMarkup(React.createElement(WorkbenchSidebar,props))}`,resolveDir:root,loader:'jsx'},outfile:file,bundle:true,platform:'node',format:'cjs',nodePaths:[join(root,'_scratch/tmp/ui-deps/node_modules')],logLevel:'silent'});
const renderer=createRequire(import.meta.url)(file);

test('both sidebar presentations retain named project, task and file entry points',()=>{
  const project={title:'合成项目',objects:[{id:'o_test',title:'synthetic.md',kind:'manuscript'}]};
  for(const collapsed of [true,false]){
    const html=renderer.render({collapsed,project,task:'writing'});
    assert(html.includes(`data-collapsed="${collapsed}"`));
    for(const label of ['切换论文项目','打开已有工作区','工作区文件','论文写作','数据与制图','文献阅读','项目资料'])assert(html.includes(`aria-label="${label}"`),label);
    assert(html.includes('aria-current="page"'));assert(html.includes('title="synthetic.md"'));
    assert(!html.includes('iframe'));
  }
});
