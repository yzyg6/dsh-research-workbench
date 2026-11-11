import {loadWordcraftAssets} from './wordcraft-assets.mjs';
import { PREFIX } from '../server-path.mjs';

/** Serialize mutations, but keep every request's explicit project owner. */
export function createApi() {
  let tail = Promise.resolve();
  let generation = 0;
  const request = async (name, init) => {
    const timeout=AbortSignal.timeout(name.startsWith('word?')?90000:init?.body && /"(?:openWorkspace|refreshWorkspace|exportWord|saveFigureFromFiles|documentHistory|documentHistoryDetail|restoreDocumentHistory|reviewReminders|applySentence|undoSentence|saveObject|openFormattingConversation|previewWordFormatting|applyWordFormatting|undoWordFormatting)"/.test(init.body) ? 120000 : 15000);
    const result = await fetch(`${PREFIX}/${name}`, { ...init, signal: init?.signal ? AbortSignal.any([init.signal,timeout]) : timeout });
    let body; try { body = await result.json(); } catch { throw new Error('工作台服务尚未就绪，请重载 DSH 后重试。'); }
    if (!result.ok) { const error = new Error(body.error || '资料保存未完成，输入仍保留。'); error.code = body.code; throw error; }
    return body;
  };
  return {
    wordcraftAssets: signal=>loadWordcraftAssets(PREFIX,signal),
    systemFontUrl: id=>`${PREFIX}/asset?${new URLSearchParams({systemFont:id})}`,
    saveWord(projectId,objectId,expectedRevision,bytes){generation++;const operation=tail.then(()=>request(`word?${new URLSearchParams({projectId,objectId,expectedRevision})}`,{method:'POST',headers:{'content-type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'},body:bytes,signal:AbortSignal.timeout(60000)}));tail=operation.catch(()=>{});return operation;},
    stamp: () => request('state?stamp=1'),
    workspaceTree: (projectId, directory = '', offset = 0) => request(`state?${new URLSearchParams({ tree: '1', projectId, directory, offset })}`),
    wordStatus: (projectId, objectId) => request(`state?${new URLSearchParams({word:'1',projectId,objectId})}`),
    wordPage: (projectId, objectId, page, signal) => request(`asset?${new URLSearchParams({word:'1',projectId,objectId,page})}`,{signal}),
    wordImageUrl: (projectId, objectId, image) => `${PREFIX}/asset?${new URLSearchParams({word:'1',projectId,objectId,image})}`,
    async bootstrap() { await tail; const started = generation; const result = await request('state'); if (started !== generation) { await tail; return request('state'); } return result; },
    mutate(action, data) { generation++; const operation = tail.then(() => request('mutate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, data }) })); tail = operation.catch(() => {}); return operation; },
    versions: (projectId, objectId) => request(`versions?${new URLSearchParams({ projectId, objectId })}`),
    assetUrl: (projectId, objectId) => `${PREFIX}/asset?${new URLSearchParams({ projectId, objectId })}`,
    imageUrl: (projectId, objectId, src) => /^(https?:|data:image\/)/i.test(src || '') || src?.startsWith(PREFIX + '/asset?') ? src : `${PREFIX}/asset?${new URLSearchParams({ projectId, objectId, image: src || '' })}`,
    hostStatus: (data) => request('host-status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }),
  };
}
