import test from 'node:test';import assert from 'node:assert/strict';
import {installChineseFont,installSystemFonts,documentSystemFonts} from '../src/client/wordcraft-font.mjs';

test('document loading selects Song plus declared families and preserves bold and italic variants',()=>{
 const fonts=[{id:'simsun',families:['SimSun','宋体']},{id:'times',families:['Times New Roman']},{id:'times-bold',families:['Times New Roman']},{id:'times-italic',families:['Times New Roman']},{id:'simkai',families:['KaiTi','楷体']}];
 assert.deepEqual(documentSystemFonts(fonts,['@宋体','TIMES NEW ROMAN']).map(f=>f.id),['simsun','times','times-bold','times-italic']);
 assert.deepEqual(documentSystemFonts(fonts,[]).map(f=>f.id),['simsun']);
});

test('font bytes are reused across editor instances, invalidate when changed, and missing styles still load',async t=>{
 const original=globalThis.fetch;let requests=0;globalThis.fetch=async()=>{requests++;return{ok:true,arrayBuffer:async()=>new Uint8Array([5,6]).buffer}};t.after(()=>{globalThis.fetch=original});
 const added=[],api={execute:async(command,args)=>command==='font.list'?{families:['Test Family'],fonts:[{file:'regular.ttf',families:['Test Family']}]}:(added.push(args.name),{families:['Test Family']})};
 const font={id:'test-bold',name:'bold.ttf',label:'Test Bold',bytes:2,modified:1},url=()=>'/cache-test-font';
 await installSystemFonts(api,[font],url);await installSystemFonts(api,[font],url);
 assert.equal(requests,1);assert.equal(added.length,2,'new WASM instances still need registration');
 await installSystemFonts(api,[{...font,modified:2}],url);assert.equal(requests,2);
 const cancelled=new AbortController();cancelled.abort();await assert.rejects(installSystemFonts(api,[font],url,cancelled.signal),{name:'AbortError'});assert.equal(requests,2);
});

test('opening another document skips font files already registered in the engine',async t=>{
 const original=globalThis.fetch;let requests=0;globalThis.fetch=async()=>{requests++;return{ok:true,arrayBuffer:async()=>new Uint8Array([1]).buffer}};t.after(()=>{globalThis.fetch=original});
 const api={execute:async command=>command==='font.list'?{families:['SimSun'],fonts:[{file:'simsun.ttc',families:['SimSun']}]}:{families:['SimSun']}};
 await installSystemFonts(api,[{id:'simsun',label:'宋体',name:'simsun.ttc'}],id=>'/font/'+id);
 assert.equal(requests,0,'opening must not read and register the same 18 MB font again');
});

test('Chinese display fallback is installed once without editing text, styles or document files',async()=>{
 const calls=[],font=Uint8Array.from({length:65543},(_,i)=>i%256).buffer;
 const api={execute:async(command,params)=>{calls.push({command,params});return command==='font.list'?{families:['Arial']}:{families:['Noto Sans CJK SC']}}};
 assert.deepEqual(await installChineseFont(api,font),{family:'Noto Sans CJK SC',alreadyLoaded:false});
 assert.deepEqual(calls.map(x=>x.command),['font.list','font.add']);assert.deepEqual(Buffer.from(calls[1].params.data,'base64'),Buffer.from(font));
 calls.length=0;api.execute=async command=>{calls.push(command);return{families:['Noto Sans CJK SC']}};
 assert.equal((await installChineseFont(api,null)).alreadyLoaded,true);assert.deepEqual(calls,['font.list']);
});

test('missing or rejected Chinese fonts fail explicitly instead of opening an unreadable canvas',async()=>{
 await assert.rejects(installChineseFont({execute:async()=>({families:[]})},null),/中文字体/);
 await assert.rejects(installChineseFont({execute:async()=>({families:[]})},new Uint8Array([1]).buffer),/中文字体加载未完成/);
});

test('system font loading accepts available faces, preserves bytes and reports genuine failures',async t=>{
 const original=globalThis.fetch;globalThis.fetch=async()=>({ok:true,arrayBuffer:async()=>new Uint8Array([0,1,2,3]).buffer});t.after(()=>{globalThis.fetch=original});
 const api={execute:async(command,args)=>{if(command==='font.list')return{families:['Calibri']};assert.deepEqual(Buffer.from(args.data,'base64'),Buffer.from([0,1,2,3]));if(args.name==='calibri.ttf')throw Error('already available: Calibri');if(args.name==='bad.ttf')throw Error('not a font file');return{families:['SimSun']}}};
 const result=await installSystemFonts(api,[{id:'simsun',label:'宋体',name:'simsun.ttc'},{id:'calibri',label:'Calibri',name:'calibri.ttf'},{id:'bad',label:'坏字体',name:'bad.ttf'}],id=>'/font/'+id);
 assert.deepEqual(result.loaded,['SimSun','Calibri']);assert.equal(result.failed.length,1);assert(result.failed[0].includes('not a font file'));
});
