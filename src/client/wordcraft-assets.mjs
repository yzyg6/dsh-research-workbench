import {WORDCRAFT_ASSETS} from '../shared/wordcraft-version.mjs';

async function valid(value){
  if(typeof value?.script!=='string'||!(value.wasm instanceof ArrayBuffer)||value.wasm.byteLength!==WORDCRAFT_ASSETS.wasm.bytes||!(value.font instanceof ArrayBuffer)||value.font.byteLength!==WORDCRAFT_ASSETS.font.bytes)return false;
  const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
  return await digest(new TextEncoder().encode(value.script))===WORDCRAFT_ASSETS.script.sha256&&await digest(value.wasm)===WORDCRAFT_ASSETS.wasm.sha256&&await digest(value.font)===WORDCRAFT_ASSETS.font.sha256;
}
async function database(){
  if(typeof indexedDB==='undefined')return null;
  return new Promise(resolve=>{
    let done=false;const finish=db=>{if(done){db?.close();return}done=true;clearTimeout(timer);resolve(db)},timer=setTimeout(()=>finish(null),2000),request=indexedDB.open('dsh-research-wordcraft',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('assets');request.onsuccess=()=>finish(request.result);request.onerror=()=>finish(null);request.onblocked=()=>finish(null);
  });
}
const recordKey='0.17.0:'+WORDCRAFT_ASSETS.font.sha256+':'+WORDCRAFT_ASSETS.wasm.sha256;
/** One bounded disk entry. No module or document is retained in the parent heap. */
export async function loadWordcraftAssets(prefix,signal){
  const db=await database();
  try{
    if(db){let cached;try{cached=await new Promise(resolve=>{const tx=db.transaction('assets','readonly'),request=tx.objectStore('assets').get(recordKey);request.onsuccess=()=>resolve(request.result);request.onerror=tx.onabort=()=>resolve(null)})}catch{/* An unavailable disk cache must not prevent opening Word. */}signal?.throwIfAborted();if(await valid(cached))return cached}
    const read=async asset=>{const result=await fetch(`${prefix}/wordcraft/${asset.name}?sha256=${asset.sha256}`,{signal});if(!result.ok)throw Error(asset.name===WORDCRAFT_ASSETS.font.name?'中文字体资源尚未加载，请重载科研工作台插件与 Host 后重试。':'Word 编辑器资源读取失败。');return result};
    const [script,wasm,font]=await Promise.all([read(WORDCRAFT_ASSETS.script),read(WORDCRAFT_ASSETS.wasm),read(WORDCRAFT_ASSETS.font)]),value={script:await script.text(),wasm:await wasm.arrayBuffer(),font:await font.arrayBuffer()};
    if(!await valid(value))throw Error('Word 编辑器资源校验失败，请更新科研工作台插件。');signal?.throwIfAborted();
    if(db)try{await new Promise(resolve=>{const tx=db.transaction('assets','readwrite'),store=tx.objectStore('assets');store.clear();store.put(value,recordKey);tx.oncomplete=tx.onerror=tx.onabort=()=>resolve()})}catch{/* Quota failure keeps the current in-memory load usable. */}
    return value;
  }finally{db?.close()}
}
