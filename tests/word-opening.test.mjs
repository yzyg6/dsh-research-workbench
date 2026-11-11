import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {WordEditing} from '../src/server/word-edit.mjs';
import {systemFonts} from '../src/server/revision-service.mjs';
import {documentSystemFonts} from '../src/client/wordcraft-font.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
test('opening discovers body, style, theme and footnote fonts without changing the DOCX',async()=>{
 const out=join(root,'_scratch/out/word-opening-tests');await mkdir(out,{recursive:true});const dir=await mkdtemp(join(out,'case-')),file=join(dir,'synthetic.docx');
 await promisify(execFile)('python',['-I',join(root,'probes/word-opening/create-fixture.py'),file],{windowsHide:true});
 const before=await readFile(file),summary=await new WordEditing(null).inspect({path:file,summary:true});
 assert.deepEqual(summary.fontFamilies,['Cambria','Times New Roman','宋体','楷体','黑体']);assert(!('text' in summary));assert.deepEqual(await readFile(file),before);
 if(process.platform==='win32'){
   const available=await systemFonts(),selected=documentSystemFonts(available,summary.fontFamilies);
   assert(selected.some(f=>f.id==='simsun'));assert(selected.some(f=>f.id==='times-bold'));assert(selected.some(f=>f.id==='times-italic'));assert(!selected.some(f=>f.id==='simfang'));assert(selected.length<available.length);
   assert(selected.every(f=>Number.isFinite(f.modified)&&f.bytes>0));
 }
});
