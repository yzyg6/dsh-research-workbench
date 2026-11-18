/** Fetch only immutable input bytes. Retrying this read never saves a document. */
export async function readWordDocument(api,projectId,objectId,revision,signal){
  for(let attempt=0;;attempt++){
    signal?.throwIfAborted();
    try{
      const result=await fetch(api.assetUrl(projectId,objectId),{cache:'no-store',signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(30000)])});
      if(!result.ok)throw Object.assign(Error('Word 读取暂未完成，请重试打开文稿。'),{retry:[404,408,429,502,503,504].includes(result.status)});
      const bytes=await result.arrayBuffer();signal?.throwIfAborted();
      if(!bytes.byteLength||bytes.byteLength>32*1024*1024)throw Error('Word 内容为空或超过32 MiB。');
      const servedRevision=Number(result.headers?.get('x-research-revision'));
      return {bytes,objectId,revision:Number.isSafeInteger(servedRevision)&&servedRevision>0?servedRevision:revision};
    }catch(error){
      signal?.throwIfAborted();if(attempt>=2||!(error.retry||error instanceof TypeError||error.name==='TimeoutError'))throw error;
      await new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(signal.reason)},timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve()},100*2**attempt);signal?.addEventListener('abort',abort,{once:true})});
    }
  }
}

/** Independent input reads overlap. No document/editor instance is reused. */
export async function prepareWordBoot(api,projectId,objectId,revision,signal){
  const prepare=async()=>{
    for(let attempt=0;;attempt++){
      signal?.throwIfAborted();
      try{return await api.mutate('prepareWordEdit',{projectId,objectId})}
      catch(error){
        signal?.throwIfAborted();if(attempt>=2||!(error.code==='SERVICE_UNAVAILABLE'||error instanceof TypeError||error.name==='TimeoutError'))throw error;
        await new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(signal.reason)},timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve()},100*2**attempt);signal?.addEventListener('abort',abort,{once:true})});
      }
    }
  };
  const [prepared,assets,document]=await Promise.all([
    prepare(),
    api.wordcraftAssets(signal),
    readWordDocument(api,projectId,objectId,revision,signal),
  ]);
  signal?.throwIfAborted();
  if(!prepared.actionResult?.chineseFont)throw Error('Word 中文字体接口尚未就绪，请更新科研工作台插件。');
  return{assets,fonts:prepared.actionResult.fontFamilies||[],document};
}
