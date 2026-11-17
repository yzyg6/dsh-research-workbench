import {loadWordcraftAssets} from './wordcraft-assets.mjs';
import { PREFIX } from '../server-path.mjs';

const unavailable = () => Object.assign(new Error('工作台连接暂未恢复，请点击“重新连接”重试。'), { code: 'SERVICE_UNAVAILABLE' });
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Serialize mutations, but keep every request's explicit project owner. */
export function createApi() {
  let tail = Promise.resolve();
  let generation = 0;
  let watchSupported=true;
  let preload;
  const request = async (name, init) => {
    const timeout=AbortSignal.timeout(name.startsWith('word?')?90000:init?.body && /"(?:openWorkspace|refreshWorkspace|exportWord|saveFigureFromFiles|documentHistory|documentHistoryDetail|restoreDocumentHistory|reviewReminders|applySentence|undoSentence|saveObject|openFormattingConversation|previewWordFormatting|applyWordFormatting|undoWordFormatting|startManuscriptReview|publishReviewComments|prepareReviewRevision)"/.test(init.body) ? 120000 : 15000);
    const result = await fetch(`${PREFIX}/${name}`, { ...init, headers: { ...init?.headers, 'x-research-state': 'summary' }, signal: init?.signal ? AbortSignal.any([init.signal,timeout]) : timeout });
    let body; try { body = await result.json(); } catch { throw unavailable(); }
    if (!result.ok) {
      if (!body?.code && [404, 408, 425, 429, 502, 503, 504].includes(result.status)) throw unavailable();
      const staleSaveHost=body.code==='UNKNOWN_ACTION'&&name==='mutate'&&init?.body&&JSON.parse(init.body).action==='editSentenceSuggestion';
      const error=new Error(staleSaveHost?'当前 DSH 后台尚未加载句子编辑保存接口。输入仍保留，请更新后台服务后重试保存。':body.error||'资料保存未完成，输入仍保留。');
      error.code=staleSaveHost?'HOST_UPDATE_REQUIRED':body.code;throw error;
    }
    return body;
  };
  const api = {
    wordcraftAssets: signal=>loadWordcraftAssets(PREFIX,signal),
    wordControl:(action,data)=>request('word-control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,data})}),
    systemFontUrl: id=>`${PREFIX}/asset?${new URLSearchParams({systemFont:id})}`,
    saveWord(projectId,objectId,expectedRevision,bytes){generation++;const operation=tail.then(()=>request(`word?${new URLSearchParams({projectId,objectId,expectedRevision})}`,{method:'POST',headers:{'content-type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'},body:bytes,signal:AbortSignal.timeout(60000)}));tail=operation.catch(()=>{});return operation;},
    stamp: () => request('state?stamp=1'),
    async watchState(stamp,signal){
      if(!watchSupported){await new Promise((resolve,reject)=>{signal?.throwIfAborted();const abort=()=>{clearTimeout(timer);reject(signal.reason)},timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve()},1000);signal?.addEventListener('abort',abort,{once:true})});return request('state?stamp=1',{signal})}
      const result=await request('state?'+new URLSearchParams({watch:'1',stamp}),{signal});if(result.watch!==true)watchSupported=false;return result;
    },
    workspaceTree: (projectId, directory = '', offset = 0) => request(`state?${new URLSearchParams({ tree: '1', projectId, directory, offset })}`),
    wordStatus: (projectId, objectId) => request(`state?${new URLSearchParams({word:'1',projectId,objectId})}`),
    reviewStatus: (projectId, objectId, jobId, signal) => request(`review-status?${new URLSearchParams({projectId,objectId,...(jobId?{jobId}:{})})}`, {signal}),
    reviewBatchStatus: ({projectId, objectId, jobId}, signal) => request(`review-status?${new URLSearchParams({projectId,objectId,jobId,batch:'1'})}`, {signal}),
    reviewBatchProposal: ({projectId, objectId, jobId, findingId}, signal) => request(`review-status?${new URLSearchParams({projectId,objectId,jobId,findingId})}`, {signal}),
    wordPage: (projectId, objectId, page, signal) => request(`asset?${new URLSearchParams({word:'1',projectId,objectId,page})}`,{signal}),
    wordImageUrl: (projectId, objectId, image) => `${PREFIX}/asset?${new URLSearchParams({word:'1',projectId,objectId,image})}`,
    async bootstrap({ signal, usePreload = false } = {}) {
      const warmed = usePreload ? preload : null;
      if (warmed) {
        preload = null;
        if (warmed.generation === generation) {
          const result = await warmed.promise;
          signal?.throwIfAborted();
          if (result && warmed.generation === generation) {
            try {
              const latest = await request('state?stamp=1', { signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(1500)]) });
              if (result.stamp && latest.stamp === result.stamp && warmed.generation === generation) return result;
            } catch { signal?.throwIfAborted(); }
          }
        }
      }
      // Retry only this read. A lost mutation response must never replay a save.
      const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20000)]);
      let attempt = 0;
      while (true) {
        deadline.throwIfAborted();
        await tail;
        const started = generation;
        try {
          const result = await request('state?summary=1', { signal: AbortSignal.any([deadline, AbortSignal.timeout(4000)]) });
          if (!Array.isArray(result?.projects)) throw unavailable();
          if (started !== generation) continue;
          return result;
        } catch (error) {
          signal?.throwIfAborted();
          if (deadline.aborted) throw unavailable();
          if (error.code !== 'SERVICE_UNAVAILABLE' && !(error instanceof TypeError) && !['TimeoutError', 'AbortError'].includes(error.name)) throw error;
          try { await pause(Math.min(1000, 100 * 2 ** Math.min(attempt++, 4)), deadline); }
          catch { signal?.throwIfAborted(); throw unavailable(); }
        }
      }
    },
    mutate(action, data) { const readOnly=['systemFonts','reviewReminders','documentHistoryDetail','prepareWordEdit','wordEditorStatus'].includes(action);if(!readOnly)generation++;const send=()=>request('mutate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, data }) });if(readOnly)return send();const operation = tail.then(send); tail = operation.catch(() => {}); return operation; },
    versions: (projectId, objectId) => request(`versions?${new URLSearchParams({ projectId, objectId })}`),
    assetUrl: (projectId, objectId) => `${PREFIX}/asset?${new URLSearchParams({ projectId, objectId })}`,
    imageUrl: (projectId, objectId, src) => /^(https?:|data:image\/)/i.test(src || '') || src?.startsWith(PREFIX + '/asset?') ? src : `${PREFIX}/asset?${new URLSearchParams({ projectId, objectId, image: src || '' })}`,
    hostStatus: (data) => request('host-status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }),
  };
  api.preload = signal => {
    const entry = { generation };
    entry.promise = api.bootstrap({ signal }).catch(() => null);
    preload = entry;
    return entry.promise;
  };
  return api;
}
