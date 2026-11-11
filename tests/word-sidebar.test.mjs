import test from 'node:test';import assert from 'node:assert/strict';
import {createRequire} from 'node:module';import {mkdir} from 'node:fs/promises';import {fileURLToPath} from 'node:url';import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),out=join(root,'_scratch/out/word-sidebar-tests');await mkdir(out,{recursive:true});
const require=createRequire(join(root,'_scratch/tmp/ui-deps/package.json')),esbuild=require('esbuild');
const file=join(out,'render.cjs');
esbuild.buildSync({stdin:{contents:`import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {WordEditor} from ${JSON.stringify(join(root,'src/client/WordEditor.jsx'))};export function render(props){return renderToStaticMarkup(React.createElement(WordEditor,props))}export function native(){return React.createElement('button',null,'原生模型选择器测试替身')}`,resolveDir:root,loader:'jsx'},outfile:file,bundle:true,platform:'node',format:'cjs',loader:{'.css':'text'},nodePaths:[join(root,'_scratch/tmp/ui-deps/node_modules'),join(root,'_scratch/tmp/editor-deps/node_modules')],logLevel:'silent'});
const renderer=createRequire(import.meta.url)(file);

test('Word docks the native conversation and two-column review beside its canvas, without a floating dialog',()=>{
 const job={id:'j_sidebar',type:'writing.sentence',native:true,objectId:'o_word',status:'succeeded',output:{objectId:'o_word',original:'原句',proposal:{replacement:'建议',reason:'测试替身',evidenceIds:[],warnings:[]},evidence:{terms:[],sources:[],warnings:[]},review:'pending',expectedRevision:1}};
 const html=renderer.render({api:{},project:{id:'p_test',title:'合成项目',rootPath:'T:/synthetic',writingConversations:[]},object:{id:'o_word',title:'synthetic.docx',revision:1},sentence:{jobs:[job],initialNativeJobId:job.id,nativeRender:renderer.native}});
 assert(html.includes('aria-label="Word 右侧原生修改对话"'));assert(html.includes('原生模型选择器测试替身'));assert(html.includes('Word 对话栏宽度'));assert(html.includes('左右对照与文献依据'));assert(html.includes('aria-label="修改前"'));assert(html.includes('aria-label="修改后"'));assert(!html.includes('role="dialog"'));assert(!html.includes('rw-native-sentence-dialog'));assert(html.includes('title="Wordcraft 论文编辑器"'));
 assert(!html.includes('rw-writing-hint'));assert(!html.includes('rw-writing-conversation-controls'));
 assert(html.includes('aria-label="Word 文档操作"'));assert(html.includes('aria-label="论文对话操作"'));assert(html.includes('新建对话'));assert(html.includes('展开／收起 Word 功能区'));
});

test('a saved conversation for a different document is not treated as the current Word selection',()=>{
 const html=renderer.render({api:{},project:{id:'p_test',title:'合成项目',rootPath:'T:/synthetic',writingConversations:[]},object:{id:'o_current',title:'current.docx',revision:1},sentence:{initialNativeJobId:'j_foreign',jobs:[{id:'j_foreign',objectId:'o_other'}],nativeRender:renderer.native}});
 assert(!html.includes('原生模型选择器测试替身'));assert(html.includes('打开原生对话'));
});
