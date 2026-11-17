import {WORDCRAFT_ASSETS} from '../shared/wordcraft-version.mjs';

const recordKey=JSON.stringify(WORDCRAFT_ASSETS);
async function valid(value){
  if(typeof value?.script!=='string'||!(value.wasm instanceof ArrayBuffer)||value.wasm.byteLength!==WORDCRAFT_ASSETS.wasm.bytes||!(value.font instanceof ArrayBuffer)||value.font.byteLength!==WORDCRAFT_ASSETS.font.bytes)return false;
  const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
  const hashes=await Promise.all([digest(new TextEncoder().encode(value.script)),digest(value.wasm),digest(value.font)]);
  return hashes[0]===WORDCRAFT_ASSETS.script.sha256&&hashes[1]===WORDCRAFT_ASSETS.wasm.sha256&&hashes[2]===WORDCRAFT_ASSETS.font.sha256;
}
async function database(){
  if(typeof indexedDB==='undefined')return null;
  return new Promise(resolve=>{
    let done=false;const finish=db=>{if(done){db?.close();return}done=true;clearTimeout(timer);resolve(db)},timer=setTimeout(()=>finish(null),250);
    try{const request=indexedDB.open('dsh-research-wordcraft',1);request.onupgradeneeded=()=>request.result.createObjectStore('assets');request.onsuccess=()=>finish(request.result);request.onerror=request.onblocked=()=>finish(null)}catch{finish(null)}
  });
}
function disk(db,write,value){
  return new Promise(resolve=>{
    let done=false,tx;const finish=result=>{if(done)return;done=true;clearTimeout(timer);resolve(result)},timer=setTimeout(()=>{finish(null);try{tx?.abort()}catch{}},500);
    try{tx=db.transaction('assets',write?'readwrite':'readonly');const store=tx.objectStore('assets');tx.onerror=tx.onabort=()=>finish(null);
      if(write){store.clear();store.put(value,recordKey);tx.oncomplete=()=>finish(true)}
      else{const request=store.get(recordKey);request.onsuccess=()=>finish(request.result);request.onerror=()=>finish(null)}
    }catch{finish(null)}
  });
}
async function readAssets(prefix,signal){
  let db=await database(),value;
  try{
    if(db){const cached=await disk(db,false);signal.throwIfAborted();if(await valid(cached))value=cached}
    if(!value){
      const read=async(asset,text=false)=>{
        for(let attempt=0;;attempt++){
          signal.throwIfAborted();
          try{
            const result=await fetch(`${prefix}/wordcraft/${asset.name}?sha256=${asset.sha256}`,{signal:AbortSignal.any([signal,AbortSignal.timeout(30000)])});
            if(!result.ok)throw Object.assign(Error('Word 编辑器资源暂未连接。'),{retry:[404,408,429,502,503,504].includes(result.status)});
            return text?await result.text():await result.arrayBuffer();
          }catch(error){signal.throwIfAborted();if(attempt>=2||!(error.retry||error instanceof TypeError||error.name==='TimeoutError'))throw error;await new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(signal.reason)},timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve()},100*2**attempt);signal.addEventListener('abort',abort,{once:true})})}
        }
      };
      const [script,wasm,font]=await Promise.all([read(WORDCRAFT_ASSETS.script,true),read(WORDCRAFT_ASSETS.wasm),read(WORDCRAFT_ASSETS.font)]);value={script,wasm,font};
      if(!await valid(value))throw Error('Word 编辑器资源校验失败，请更新科研工作台插件。');
      // Persist independently: a stalled disk cache cannot hold engine startup.
      if(db){const writing=db;db=null;void disk(writing,true,value).finally(()=>writing.close())}
    }
    signal.throwIfAborted();
    const bytes=await new Response(new Blob([value.wasm]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    const module=await WebAssembly.compile(bytes);signal.throwIfAborted();
    return{script:value.script,font:value.font,module};
  }finally{db?.close()}
}

// One immutable runtime expires after two idle minutes. This retains no
// Instance, WebAssembly.Memory, editor DOM, document bytes or user data.
let current=null;
export function loadWordcraftAssets(prefix,signal){
  signal?.throwIfAborted();
  const key=prefix+'\0'+recordKey;
  if(!current||current.key!==key){
    const entry={key,controller:new AbortController(),users:0,value:null,timer:null};current=entry;
    entry.promise=readAssets(prefix,entry.controller.signal).then(value=>{entry.value=value;return value},error=>{if(current===entry)current=null;entry.controller.abort();throw error});
  }
  const entry=current;entry.users++;clearTimeout(entry.timer);
  return new Promise((resolve,reject)=>{
    let done=false;
    const finish=(error,value)=>{
      if(done)return;done=true;signal?.removeEventListener('abort',abort);
      if(--entry.users===0){
        if(!entry.value){if(current===entry)current=null;entry.controller.abort()}
        else{entry.timer=setTimeout(()=>{if(current===entry)current=null},120000);entry.timer.unref?.()}
      }
      if(error)reject(error);else resolve({script:value.script,module:value.module,font:value.font.slice(0)});
    };
    const abort=()=>finish(signal.reason);signal?.addEventListener('abort',abort,{once:true});
    entry.promise.then(value=>finish(null,value),error=>finish(error));
    if(signal?.aborted)abort();
  });
}
