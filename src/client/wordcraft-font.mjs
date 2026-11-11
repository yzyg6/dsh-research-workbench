/** Runs inside the Word iframe. Only adds a display fallback; no document edits. */
export async function installChineseFont(api,bytes,family='Noto Sans CJK SC'){
  const installed=await api.execute('font.list',{all:true});
  if(installed.families?.includes(family))return{family,alreadyLoaded:true};
  if(!(bytes instanceof ArrayBuffer)||!bytes.byteLength||bytes.byteLength>20*1024*1024)throw Error('中文字体未准备好，请重载科研工作台插件与 Host 后重试。');
  const view=new Uint8Array(bytes),chunks=[];
  for(let offset=0;offset<view.length;offset+=32768)chunks.push(String.fromCharCode(...view.subarray(offset,offset+32768)));
  const data=btoa(chunks.join(''));chunks.length=0;
  const result=await api.execute('font.add',{name:'NotoSansCJKsc-Regular.woff2',data});
  if(!result.families?.includes(family))throw Error('中文字体加载未完成，已保留文档原件。');
  return{family,alreadyLoaded:false};
}

/** Include all styles of requested families; keep Song available for Chinese editing. */
export function documentSystemFonts(fonts,families=[]){
  const requested=new Set(families.map(value=>value.replace(/^@/,'').toLowerCase()));
  return fonts.filter(font=>font.id==='simsun'||font.families?.some(family=>requested.has(family.toLowerCase())));
}

// Small, bounded session cache: changing document does not repeat base64 conversion.
// System fonts remain local, and file size/mtime invalidate replaced font files.
const fontData=new Map(),MAX_FONT_DATA=64*1024*1024;let fontDataSize=0;
async function encodedFont(font,url,signal){
  const key=JSON.stringify([url,font.bytes,font.modified]);
  if(fontData.has(key)){const data=fontData.get(key);fontData.delete(key);fontData.set(key,data);return data}
  const versioned=font.modified===undefined?url:`${url}${url.includes('?')?'&':'?'}fontVersion=${encodeURIComponent(font.modified+':'+font.bytes)}`;
  const response=await fetch(versioned,{signal});if(!response.ok)throw Error('字体读取失败');
  const bytes=await response.arrayBuffer();signal?.throwIfAborted();if(!bytes.byteLength||bytes.byteLength>32*1024*1024)throw Error('字体大小无效');
  const view=new Uint8Array(bytes),chunks=[];for(let offset=0;offset<view.length;offset+=32768)chunks.push(String.fromCharCode(...view.subarray(offset,offset+32768)));
  const data=btoa(chunks.join(''));chunks.length=0;
  while(fontDataSize+data.length>MAX_FONT_DATA&&fontData.size){const oldest=fontData.keys().next().value;fontDataSize-=fontData.get(oldest).length;fontData.delete(oldest)}
  fontData.set(key,data);fontDataSize+=data.length;return data;
}

/** Font files stay on this machine; load sequentially to bound base64 memory. */
export async function installSystemFonts(api,fonts,urlFor,signal,onProgress){
  if(!fonts.length)return{loaded:[],failed:[]};
  signal?.throwIfAborted();
  const installed=await api.execute('font.list',{all:true});
  const registered=new Map((installed.fonts||[]).map(font=>[font.file.toLowerCase(),font.families]));
  const loaded=[],failed=[];
  for(const font of fonts){
    signal?.throwIfAborted();
    const existing=registered.get(font.name.toLowerCase());
    if(existing){loaded.push(...existing);continue}
    onProgress?.(font.label);
    try{
      const data=await encodedFont(font,urlFor(font.id),signal);signal?.throwIfAborted();
      const result=await api.execute('font.add',{name:font.name,data});
      signal?.throwIfAborted();
      if(!result.families?.length)throw Error('字体未注册');loaded.push(...result.families);
    }catch(error){
      if(signal?.aborted)throw error;
      // Wordcraft rejects duplicate faces even when the requested font is usable.
      const existing=String(error.message||error).match(/already available:\s*([^\n]+)/i);
      if(existing){const installed=await api.execute('font.list',{all:true});const families=existing[1].split(',').map(value=>value.trim()).filter(value=>installed.families?.includes(value));if(families.length){loaded.push(...families);continue}}
      failed.push(`${font.label}（${String(error.message||error).slice(0,180)}）`);
    }
  }
  return{loaded:[...new Set(loaded)],failed};
}
