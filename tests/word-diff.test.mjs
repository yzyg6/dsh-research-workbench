import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {wordDifferences} from '../src/client/word-diff.mjs';

const changed=parts=>parts.filter(part=>part.changed).map(part=>part.text);
const text=parts=>parts.map(part=>part.text).join('');

test('Chinese word replacements highlight both changed words and leave the shared sentence intact',()=>{
  const diff=wordDifferences('不显式模拟梯级水库的联动调度。','不显式模拟梯级水库的联合调度。');
  assert.deepEqual(changed(diff.before),['联动']);assert.deepEqual(changed(diff.after),['联合']);
  assert.equal(diff.before.at(-1).text,'调度。');assert.equal(diff.before.at(-1).changed,false);
});

test('English terms and decimal values stay whole, and unchanged units and citations are not highlighted',()=>{
  const diff=wordDifferences('The measured flux is 1.25 mg [1,2,3].','The estimated flux is 2.50 mg [1,2,3].');
  assert.deepEqual(changed(diff.before),['measured','1.25']);assert.deepEqual(changed(diff.after),['estimated','2.50']);
  assert.equal(diff.after.at(-1).text,' mg [1,2,3].');assert.equal(diff.after.at(-1).changed,false);
});

test('insertions, deletions, repeated words and identical sentences do not highlight their unchanged neighbours',()=>{
  assert.deepEqual(changed(wordDifferences('alpha beta alpha','alpha gamma beta alpha').before),[]);
  assert.equal(changed(wordDifferences('alpha beta alpha','alpha gamma beta alpha').after).join(''),'gamma ');
  assert.deepEqual(changed(wordDifferences('保留。删除。','保留。').after),[]);
  assert.deepEqual(wordDifferences('文字完全一致。','文字完全一致。').before,[{text:'文字完全一致。',changed:false}]);
  assert.deepEqual(wordDifferences('','新增。').before,[]);
});

test('punctuation, whitespace, combining marks and emoji survive exact reconstruction in both columns',()=>{
  const values=['','甲乙。\n丙丁。','alpha  beta\nalpha','😀 👨‍👩‍👧‍👦 e\u0301','1.25 mg [1,2,3]','甲乙，丙丁！'];
  for(const before of values)for(const after of values){const diff=wordDifferences(before,after);assert.equal(text(diff.before),before);assert.equal(text(diff.after),after)}
  const diff=wordDifferences('结果。','结果！');assert.deepEqual(changed(diff.before),['。']);assert.deepEqual(changed(diff.after),['！']);
});

test('large replacements use bounded comparison while preserving shared edges and full original text',()=>{
  const before='共同开头。'+Array.from({length:400},(_,n)=>`old${n} `).join('')+'共同结尾。';
  const after='共同开头。'+Array.from({length:400},(_,n)=>`new${n} `).join('')+'共同结尾。';
  const diff=wordDifferences(before,after);
  assert.equal(text(diff.before),before);assert.equal(text(diff.after),after);
  assert.equal(diff.before[0].text,'共同开头。');assert.equal(diff.before[0].changed,false);
  assert.equal(diff.after.at(-1).changed,false);assert(diff.after.at(-1).text.endsWith('共同结尾。'));
  assert(diff.before.length<=3);assert(diff.after.length<=3);
});

const root=fileURLToPath(new URL('../',import.meta.url)),out=join(root,'_scratch/out/word-diff-tests');await mkdir(out,{recursive:true});
const require=createRequire(join(root,'_scratch/tmp/ui-deps/package.json')),file=join(out,'render.cjs');
require('esbuild').buildSync({stdin:{contents:`import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {SentenceComparison} from ${JSON.stringify(join(root,'src/client/RevisionTools.jsx'))};export function render(props){return renderToStaticMarkup(React.createElement(SentenceComparison,props))}`,resolveDir:root,loader:'jsx'},outfile:file,bundle:true,platform:'node',format:'cjs',nodePaths:[join(root,'_scratch/tmp/ui-deps/node_modules')],logLevel:'silent'});
const {render}=require(file);

test('rendering keeps two labelled columns and author classification controls, with escaped inline highlights',()=>{
  const before='联动调度。<img src=x onerror=1>',after='联合调度。<img src=x onerror=2>';
  const html=render({before,after,onClassify:()=>{}});
  assert(html.includes('aria-label="修改前"'));assert(html.includes('aria-label="修改后"'));
  assert(html.includes('aria-label="第 1 句修改分类"'));assert(html.includes('<mark class="rw-word-change">联动</mark>'));
  assert(html.includes('<mark class="rw-word-change">联合</mark>'));assert(!html.includes('<img'));assert(html.includes('&lt;img'));
  const unchanged=render({before:'文字完全一致。',after:'文字完全一致。'});assert(!unchanged.includes('<mark'));
});
