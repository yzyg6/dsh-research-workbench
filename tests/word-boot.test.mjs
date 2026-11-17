import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareWordBoot,readWordBytes} from '../src/client/word-boot.mjs';
import {createApi} from '../src/client/api.mjs';

test('document inspection, immutable runtime preparation and file reading start in parallel',async()=>{
  const original=globalThis.fetch,started=[];let release;
  const gate=new Promise(resolve=>release=resolve);
  globalThis.fetch=async()=>{started.push('document');await gate;return new Response(new Uint8Array([1,2]))};
  const api={assetUrl:()=>'/synthetic',async mutate(action){assert.equal(action,'prepareWordEdit');started.push('prepare');await gate;return{actionResult:{chineseFont:'Noto Sans CJK SC',fontFamilies:['SimSun']}}},async wordcraftAssets(){started.push('runtime');await gate;return{module:'synthetic-module'}}};
  try{const opening=prepareWordBoot(api,'p','o',7,new AbortController().signal);await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(started,['prepare','runtime','document']);release();const result=await opening;assert.equal(result.document.revision,7);assert.equal(result.document.objectId,'o');assert.deepEqual(result.fonts,['SimSun']);assert.equal(result.document.bytes.byteLength,2)}finally{release();globalThis.fetch=original}
});

test('temporary asset failure retries only the Word read, and cancellation stops a retry',async()=>{
  const original=globalThis.fetch;let calls=0;
  const api={assetUrl:()=>'/synthetic'};
  globalThis.fetch=async()=>++calls===1?new Response('starting',{status:503}):new Response(new Uint8Array([1,2]));
  try{assert.equal((await readWordBytes(api,'p','o')).byteLength,2);assert.equal(calls,2);const controller=new AbortController();globalThis.fetch=async()=>{calls++;return new Response('starting',{status:503})};const reading=readWordBytes(api,'p','o',controller.signal);await new Promise(resolve=>setImmediate(resolve));controller.abort();await assert.rejects(reading,{name:'AbortError'});assert.equal(calls,3)}finally{globalThis.fetch=original}
});

test('Word diagnostics cannot queue the opening preparation or invalidate an in-flight state read',async()=>{
  const original=globalThis.fetch;let release;const gate=new Promise(resolve=>release=resolve),calls=[];
  globalThis.fetch=async(_url,options)=>{const action=options?.body?JSON.parse(options.body).action:'state';calls.push(action);if(action==='wordEditorStatus')await gate;return Response.json(action==='state'?{projects:[]}:{actionResult:{chineseFont:'Noto Sans CJK SC'}})};
  try{const api=createApi(),diagnostic=api.mutate('wordEditorStatus',{}),prepared=api.mutate('prepareWordEdit',{});await new Promise(resolve=>setImmediate(resolve));assert(calls.includes('prepareWordEdit'));await api.bootstrap();assert.equal(calls.filter(c=>c==='state').length,1);release();await Promise.all([diagnostic,prepared])}finally{release();globalThis.fetch=original}
});
