/** Self-contained trusted iframe bootstrap, serialized by the host (no closures). */
export function wordcraftFrame({hostOrigin,moduleUrl,installFont}) {
  document.documentElement.dataset.wordcraftBoot='1';
  const canvas=document.getElementById('wordcraft_canvas');
  const post=data=>{
    if(data.type==='wordcraft:save'&&data.bytes instanceof ArrayBuffer){
      try{parent.postMessage(data,hostOrigin,[data.bytes]);return}catch{/* Some engines expose a non-transferable view. */}
    }
    parent.postMessage(data,hostOrigin);
  };
  // Accessibility value providers can emit a plain Event rather than InputEvent.
  // wasm-bindgen requires inputType to be a string. Normal IME events pass intact.
  document.addEventListener('input',event=>{
    const target=event.target;
    if(typeof event.inputType==='string'||!(target instanceof HTMLInputElement||target instanceof HTMLTextAreaElement))return;
    event.stopImmediatePropagation();
    target.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'insertText',data:target.value||''}));
  },true);
  window.addEventListener('error',event=>post({type:'wordcraft:failed',error:event.message,stack:event.error?.stack||''}));
  window.addEventListener('unhandledrejection',event=>post({type:'wordcraft:failed',error:String(event.reason)}));
  let chineseFont;
  for(const type of ['wordcraft:dirty','wordcraft:save','wordcraft:failed'])canvas.addEventListener(type,event=>post({type,...event.detail}));
  canvas.addEventListener('wordcraft:ready',async event=>{
    try{
      post({type:'rw-wordcraft-font-loading'});
      const font=await installFont(window.wordcraft,chineseFont);
      chineseFont=null;
      post({type:'wordcraft:ready',...event.detail,chineseFont:font.family});
    }catch(error){chineseFont=null;post({type:'wordcraft:failed',error:String(error)})}
  });
  window.addEventListener('message',async event=>{
    if(event.source!==parent||event.origin!==hostOrigin)return;
    if(event.data?.type==='wordcraft:open')canvas.dispatchEvent(new CustomEvent('wordcraft:open',{detail:event.data}));
    if(event.data?.type==='rw-wordcraft-start'){
      try{
        chineseFont=event.data.font;
        const module=await import(moduleUrl);
        const bytes=await new Response(new Blob([event.data.bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
        const wasm=await module.default({module_or_path:bytes});
        window.wasmBindings=module;window.wordcraftMemoryBytes=()=>wasm.memory?.buffer.byteLength||0;
        post({type:'rw-wordcraft-memory',wasmBytes:wasm.memory?.buffer.byteLength||0});
        dispatchEvent(new CustomEvent('TrunkApplicationStarted',{detail:{wasm}}));
      }catch(error){post({type:'wordcraft:failed',error:String(error)})}
    }
  });
  post({type:'rw-wordcraft-frame'});
}
