import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {WORDCRAFT_ASSETS} from '../src/shared/wordcraft-version.mjs';

test('reopening Word reuses verified assets and compiled code while giving each iframe its own transferable font',async()=>{
  const {loadWordcraftAssets}=await import('../src/client/wordcraft-assets.mjs?reuse');
  const original=globalThis.fetch;let reads=0;
  globalThis.fetch=async url=>{reads++;const name=new URL(url,'http://synthetic.local').pathname.split('/').at(-1);return new Response(await readFile(new URL('../public/wordcraft/'+name,import.meta.url)))};
  try{
    const first=await loadWordcraftAssets('/synthetic-assets'),next=await loadWordcraftAssets('/synthetic-assets');
    assert.equal(reads,3,'reopening must not fetch and rehash the entire 34 MB runtime again');
    assert(first.module instanceof WebAssembly.Module);assert.equal(first.module,next.module);
    structuredClone(first.font,{transfer:[first.font]});
    assert.equal(next.font.byteLength,WORDCRAFT_ASSETS.font.bytes,'closing one iframe cannot detach the next document font');
  }finally{globalThis.fetch=original}
});

test('concurrent opens share compilation and cancelling one caller leaves the other usable',async()=>{
  const {loadWordcraftAssets}=await import('../src/client/wordcraft-assets.mjs?concurrent');
  const original=globalThis.fetch;let reads=0,release;const gate=new Promise(resolve=>release=resolve);
  globalThis.fetch=async url=>{reads++;await gate;const name=new URL(url,'http://synthetic.local').pathname.split('/').at(-1);return new Response(await readFile(new URL('../public/wordcraft/'+name,import.meta.url)))};
  try{const controller=new AbortController(),first=loadWordcraftAssets('/synthetic-assets',controller.signal),next=loadWordcraftAssets('/synthetic-assets');controller.abort();await assert.rejects(first,{name:'AbortError'});release();assert((await next).module instanceof WebAssembly.Module);assert.equal(reads,3)}finally{release();globalThis.fetch=original}
});

test('a stalled IndexedDB transaction falls back to verified resources instead of hanging Word',async()=>{
  const {loadWordcraftAssets}=await import('../src/client/wordcraft-assets.mjs?stalled-db');
  const originalFetch=globalThis.fetch,originalDb=Object.getOwnPropertyDescriptor(globalThis,'indexedDB');let reads=0,aborts=0;
  globalThis.indexedDB={open(){
    const request={};
    queueMicrotask(()=>{
      request.result={close(){},transaction(){
        return{objectStore:()=>({get:()=>({}),clear(){},put(){}}),abort(){aborts++}};
      }};
      request.onsuccess();
    });
    return request;
  }};
  globalThis.fetch=async url=>{reads++;const name=new URL(url,'http://synthetic.local').pathname.split('/').at(-1);return new Response(await readFile(new URL('../public/wordcraft/'+name,import.meta.url)))};
  try{const result=await Promise.race([loadWordcraftAssets('/synthetic-assets'),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('cache never yielded')),4000);timer.unref()})]);assert(result.module instanceof WebAssembly.Module);assert.equal(reads,3);assert(aborts>=1)}finally{globalThis.fetch=originalFetch;if(originalDb)Object.defineProperty(globalThis,'indexedDB',originalDb);else delete globalThis.indexedDB}
});
