import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectStore, StoreError } from './store.mjs';
import { TaskRunner } from './jobs.mjs';
import { PREFIX } from '../server-path.mjs';
import { nativeAcceptancePlan } from './acceptance.mjs';
import { SentenceWriting } from './writing.mjs';
import { NativeSentenceWriting } from './native-writing.mjs';
import { publishFigure } from './figure-publish.mjs';
import { WordEditing } from './word-edit.mjs';
import {WordFormatting} from './word-formatting.mjs';
import { WordPreview } from './word-preview.mjs';
import { revisionAction, systemFonts, systemFont } from './revision-service.mjs';

export { PREFIX };
const testMarker = (value) => typeof value === 'string' && /^RW-[AB]-(WRITE|FIGURE|READ)-20261109$/.test(value) ? value : null;
export const WORDCRAFT_FILES = ['wordcraft-0.17.0-bridge.js','wordcraft-0.17.0.wasm.gz','version.json','NotoSansCJKsc-Regular.woff2'];
export const ROUTES = ['word', ...WORDCRAFT_FILES.map(name=>'wordcraft/'+name), 'state', 'mutate', 'versions', 'asset', 'app', 'app.js', 'host-status'].map((name) => `${PREFIX}/${name}`);
const response = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });

export function boundProjectContext(store, agentId, { objectId } = {}) {
  const binding = store.db.prepare('SELECT project_id,task FROM bindings WHERE session_id=?').get(agentId || '');
  if (!binding) throw new StoreError('UNBOUND_SESSION', '当前会话尚未绑定科研项目，不能读取其他项目资料。', 403);
  const project = store.project(binding.project_id);
  if (objectId) return { binding, project, object: store.object(binding.project_id, objectId) };
  return { binding, project };
}

export class WorkspaceRuntime {
  constructor({ root, sampleRoot, publicRoot, trustedTransport = true }) {
    this.store = new ProjectStore({ root, sampleRoot });
    this.publicRoot = publicRoot;
    this.trustedTransport = trustedTransport;
    this.runner = new TaskRunner(this.store);
    this.writing = new SentenceWriting(this.store);
    this.nativeWriting = new NativeSentenceWriting(this);
    this.wordPreview = new WordPreview(this.store);
    this.wordEditing = new WordEditing(this.store);
    this.wordFormatting=new WordFormatting(this);
    this.runner.handlers.set('writing.sentence', (row, signal) => this.writing.run(row, signal));
    this.listeners = new Set();
    this.integrations = { projectTools: 'not-mounted', attachedSessions: 0, sentenceModel: 'not-mounted' };
    this.diagnosticTail = Promise.resolve();
  }
  async start() { await this.runner.start(); }
  stamp() {
    return JSON.stringify([this.store.db.prepare('SELECT total_changes() value').get().value, this.store.db.prepare('SELECT max(updated_at) value FROM projects').get().value, this.store.db.prepare('SELECT max(updated_at) value FROM jobs').get().value, this.store.db.prepare('SELECT sum(revision) value FROM task_states').get().value, this.store.db.prepare('SELECT max(updated_at) value FROM bindings').get().value, this.store.db.prepare("SELECT value FROM preferences WHERE key='activeProjectId'").get()?.value, this.integrations, [...(this.store.workspaceFiles?.errors || [])]]);
  }
  async viewState() {
    for(let attempt=0;attempt<3;attempt++){
      const stamp=this.stamp(),state=await this.store.state();
      for(const project of state.projects){project.writingConversations=this.nativeWriting.conversations(project.id);project.activeWritingSessionId=this.nativeWriting.thread(project.id)?.sessionId||null;project.writingThreads=Object.fromEntries(project.objects.filter(o=>o.kind==='manuscript').map(o=>[o.id,this.nativeWriting.thread(project.id,o.id)]).filter(([,thread])=>thread));project.formattingThreads=Object.fromEntries(project.objects.filter(o=>o.kind==='manuscript').map(o=>[o.id,this.wordFormatting.thread(project.id,o.id)]).filter(([,thread])=>thread))}
      const nativeAcceptance=this.trustedTransport?await nativeAcceptancePlan(this.store):null;
      // Never label an older async snapshot with a newer stamp: that would make
      // the client skip every subsequent refresh. Under sustained writes, return
      // the older stamp so the next poll necessarily retries.
      if(stamp===this.stamp()||attempt===2)return{...state,stamp,integrations:{...this.integrations},nativeAcceptance};
    }
  }
  onMutation(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  recordDiagnostic(name, value) {
    const operation = this.diagnosticTail.then(async () => {
      const directory = join(this.store.root, 'diagnostics'); await mkdir(directory, { recursive: true });
      const path = join(directory, `${name}.json`), temporary = path + '.tmp';
      await writeFile(temporary, JSON.stringify({ capturedAt: new Date().toISOString(), ...value }, null, 2), 'utf8');
      await rename(temporary, path);
    });
    this.diagnosticTail = operation.catch(() => {}); return operation;
  }
  async mutate(action, data) {
    let actionResult;
    switch (action) {
      case 'documentHistory': case 'documentHistoryDetail': case 'reviewReminders':
        return {actionResult:await revisionAction(this,action,data)};
      case 'restoreDocumentHistory': case 'checkReminder': case 'classifySentence':
        actionResult=await revisionAction(this,action,data);break;
      case 'systemFonts':return {actionResult:await systemFonts()};
      case 'createProject': await this.store.createProject(data); break;
      case 'removeProject': await this.store.removeProject(data); break;
      case 'openWorkspace': actionResult = { projectId: await this.store.openWorkspace(data) }; break;
      case 'refreshWorkspace': await this.store.refreshWorkspace(data); break;
      case 'importWorkspaceFile': actionResult = { objectId: await this.store.importWorkspaceFile(data) }; break;
      case 'restoreWordWorkingCopy': actionResult={objectId:await this.store.restoreWordWorkingCopy(data)};break;
      case 'reconnectNativeSentence': await this.nativeWriting.ensureReady();return {actionResult:{ready:true}};
      case 'saveFigureFromFiles': actionResult = { objectId: await publishFigure(this.store, data) }; break;
      case 'openWorkspaceFile': {
        const project = this.store.project(data.projectId);
        if (!this.nativeFileOpener) throw new StoreError('NATIVE_UNAVAILABLE', '请在 DSH Desktop 中打开本地文件。', 503);
        const object = data.objectId ? this.store.object(data.projectId, data.objectId) : null;
        const path = object ? await this.store.projectPath(data.projectId, JSON.parse(object.metadata).workspaceFile || object.path) : project.root_path;
        await this.nativeFileOpener({ path, ...(data.reveal || object?.kind === 'file' ? { action: 'reveal' } : {}) }); break;
      }
      case 'createDemo': await this.store.createDemo(data); break;
      case 'activateProject': await this.store.activateProject(data.projectId); break;
      case 'updateProject': await this.store.updateProject(data); break;
      case 'createObject': await this.store.createObject(data); break;
      case 'saveObject': await this.store.saveObject(data); break;
      case 'reviseSentence': actionResult = { jobId: await this.writing.enqueue(data) }; void this.runner.tick(); break;
      case 'prepareSentenceSession': actionResult = { jobId: await this.nativeWriting.prepare(data) }; break;
      case 'openWritingConversation': actionResult = { jobId: await this.nativeWriting.open(data) }; break;
      case 'openFormattingConversation':actionResult={jobId:await this.wordFormatting.open(data)};break;
      case 'bindFormattingSession':await this.wordFormatting.bind(data);break;
      case 'previewWordFormatting':actionResult=await this.wordFormatting.preview(data);break;
      case 'applyWordFormatting':await this.wordFormatting.apply(data);break;
      case 'undoWordFormatting':await this.wordFormatting.undo(data);break;
      case 'prepareWordPreview': return {actionResult:await this.wordPreview.start(data.projectId,data.objectId)};
      case 'prepareWordEdit': {
        const {path}=await this.wordEditing.source(data.projectId,data.objectId);
        return {actionResult:{...await this.wordEditing.inspect({path,summary:true}),chineseFont:'Noto Sans CJK SC'}};
      }
      case 'wordEditorStatus': {
        this.store.object(data.projectId,data.objectId);
        const bounded=value=>Number.isFinite(value)&&value>=0?Math.min(value,16*1024*1024*1024):null;
        await this.recordDiagnostic('word-editor-latest',{projectId:data.projectId,objectId:data.objectId,revision:data.revision,instanceId:typeof data.instanceId==='string'?data.instanceId.slice(0,36):undefined,engineDirty:typeof data.engineDirty==='boolean'?data.engineDirty:undefined,errorStack:typeof data.errorStack==='string'?data.errorStack.slice(0,2500):undefined,stage:['ready','closed','failed'].includes(data.stage)?data.stage:'failed',bootMs:bounded(data.bootMs),wasmBytes:bounded(data.wasmBytes),heapBytes:bounded(data.heapBytes),frameMs:bounded(data.frameMs),renderMs:bounded(data.renderMs),layoutMs:bounded(data.layoutMs)});
        return {actionResult:{recorded:true}};
      }
      case 'cancelWordPreview': await this.wordPreview.cancel(data); return {actionResult:{cancelled:true}};
      case 'bindSentenceSession': await this.nativeWriting.bind(data); break;
      case 'applySentence': await (JSON.parse(this.writing.row(data.projectId,data.jobId).input).format==='docx'?this.wordEditing.apply(this.writing,data):this.writing.apply(data)); break;
      case 'undoSentence': await (JSON.parse(this.writing.row(data.projectId,data.jobId).input).format==='docx'?this.wordEditing.undo(this.writing,data):this.writing.undo(data)); break;
      case 'importLiterature': await this.writing.evidence.import(data); break;
      case 'saveTaskState': if (data.task === 'writing' && data.patch?.sentenceJobId) await this.nativeWriting.activate({ projectId: data.projectId, jobId: data.patch.sentenceJobId }); await this.store.saveTaskState(data); break;
      case 'bindSession': await this.store.bindSession(data); break;
      case 'addDependency': await this.store.addDependency(data); break;
      case 'enqueueJob': await this.store.enqueueJob(data); void this.runner.tick(); break;
      case 'retryJob': await this.store.retryJob(data); void this.runner.tick(); break;
      case 'cancelJob': await this.store.cancelJob(data); this.runner.cancel(data.jobId); break;
      default: throw new StoreError('UNKNOWN_ACTION', '工作台不支持这个操作。');
    }
    for (const listener of this.listeners) { try { listener(); } catch { /* Optional native integrations cannot invalidate a committed save. */ } }
    const state = await this.viewState();
    return actionResult ? { ...state, actionResult } : state;
  }
  async handle(request) {
    try {
      const url = new URL(request.url);
      if (request.method === 'POST' && !this.trustedTransport && request.headers.get('origin') && request.headers.get('origin') !== url.origin) return response({ error: '请求来源与本机工作台不一致。' }, 403);
      const name = url.pathname.slice(PREFIX.length + 1);
      if (!url.pathname.startsWith(PREFIX + '/')) return response({ error: '未找到工作台入口。' }, 404);
      if (name.startsWith('wordcraft/') && request.method === 'GET') {
        const file=name.slice(10);if(!WORDCRAFT_FILES.includes(file))return response({error:'未找到编辑器资源。'},404);
        return new Response(await readFile(join(this.publicRoot,'wordcraft',file)),{headers:{'content-type':file.endsWith('.wasm')?'application/wasm':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.json')?'application/json':file.endsWith('.woff2')?'font/woff2':'application/octet-stream','cache-control':file==='version.json'?'no-store':'public, max-age=31536000, immutable','x-content-type-options':'nosniff'}});
      }
      if (name === 'word' && request.method === 'POST') {
        if(!request.headers.get('content-type')?.startsWith('application/vnd.openxmlformats-officedocument.wordprocessingml.document'))return response({error:'请保存 DOCX 文件。'},415);
        const length=Number(request.headers.get('content-length'));if(length>32*1024*1024)return response({error:'Word 超过32 MiB。'},413);
        const chunks=[];let total=0;const reader=request.body?.getReader();if(!reader)return response({error:'Word 内容为空。'},400);
        try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>32*1024*1024){await reader.cancel();return response({error:'Word 超过32 MiB。'},413)}chunks.push(value)}}finally{reader.releaseLock()}
        await this.wordEditing.save({projectId:url.searchParams.get('projectId'),objectId:url.searchParams.get('objectId'),expectedRevision:Number(url.searchParams.get('expectedRevision')),bytes:Buffer.concat(chunks,total)});
        for(const listener of this.listeners){try{listener()}catch{}}
        return response(await this.viewState());
      }
      if (name === 'app' && request.method === 'GET') return new Response(await readFile(join(this.publicRoot, 'index.html')), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
      if (name === 'app.js' && request.method === 'GET') return new Response(await readFile(join(this.publicRoot, 'app.js')), { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } });
      if (name === 'state' && request.method === 'GET') return response(url.searchParams.get('word') === '1' ? await this.wordPreview.status(url.searchParams.get('projectId'),url.searchParams.get('objectId')) : url.searchParams.get('tree') === '1' ? await this.store.workspaceFiles.list(url.searchParams.get('projectId'), url.searchParams.get('directory') || '', { offset: Number(url.searchParams.get('offset') || 0) }) : url.searchParams.get('stamp') === '1' ? { stamp: this.stamp() } : await this.viewState());
      if (name === 'host-status' && request.method === 'POST') {
        const raw = await request.text(); if (raw.length > 32000) return response({ error: '状态记录过长。' }, 413);
        let body; try { body = JSON.parse(raw); } catch { return response({ error: '状态记录格式不正确。' }, 400); }
        if (!body || !['0.1.1', '0.2.0', '0.3.0', '0.4.0', '0.5.0', '0.6.0', '0.7.0', '0.7.1'].includes(body.version) || !Array.isArray(body.sessions) || body.sessions.length > 60) return response({ error: '状态记录格式不正确。' }, 400);
        const sessions = body.sessions.map((item) => {
          const native = item.task === 'sentence' ? this.nativeWriting.findSession(item.sessionId)||this.wordFormatting.findSession(item.sessionId) : null;
          const binding = native ? { project_id: native.project_id, task: 'sentence' } : this.store.db.prepare('SELECT project_id,task FROM bindings WHERE session_id=?').get(item.sessionId || '');
          if (!binding || binding.project_id !== item.projectId || binding.task !== item.task) throw new StoreError('UNBOUND_SESSION', '状态中的会话不属于该论文项目。', 403);
          const next = item.nextModel;
          const probe = item.nativeEvidence || {};
          return { projectId: binding.project_id, task: binding.task, ...(native ? { jobId: native.id } : {}), sessionId: item.sessionId, mounted: item.mounted === true, status: item.status === 'ready' ? 'ready' : 'unavailable', nativeEvidence: { slotMatchesBinding: probe.slotSessionId === item.sessionId, workspaceMember: probe.workspaceMember === true, inputPhase: ['plain', 'claimed', 'submitting', 'released'].includes(probe.inputPhase) ? probe.inputPhase : null, seededThisMount: probe.seededThisMount === true, fixtureMode: ['seed', 'restore'].includes(probe.fixtureMode) ? probe.fixtureMode : null, draftMarker: testMarker(probe.draftMarker), storedDraftMarker: testMarker(probe.storedDraftMarker) }, nextModel: next ? { provider: String(next.provider || '').slice(0, 100), model: String(next.model || '').slice(0, 150), reasoningEffort: String(next.reasoningEffort || '').slice(0, 40) } : null };
        });
        await this.recordDiagnostic('desktop-client-latest', { version: body.version, origin: String(body.origin || '').slice(0, 300), userAgent: String(body.userAgent || '').slice(0, 700), sessions, integrations: { ...this.integrations } });
        return response({ saved: true });
      }
      if (name === 'versions' && request.method === 'GET') return response(this.store.versions(url.searchParams.get('projectId'), url.searchParams.get('objectId')));
      if (name === 'asset' && request.method === 'GET') {
        if(url.searchParams.has('systemFont'))return new Response(await systemFont(url.searchParams.get('systemFont')),{headers:{'content-type':'font/ttf','cache-control':'private, max-age=3600','x-content-type-options':'nosniff'}});
        await this.store.tail;
        const asset = url.searchParams.get('word') === '1' ? await this.wordPreview.asset(url.searchParams.get('projectId'),url.searchParams.get('objectId'),url.searchParams.has('image')?{image:url.searchParams.get('image')}:{page:Number(url.searchParams.get('page'))}) : url.searchParams.has('image') ? await this.store.workspaceFiles.image(url.searchParams.get('projectId'), url.searchParams.get('objectId'), url.searchParams.get('image')) : await this.store.asset(url.searchParams.get('projectId'), url.searchParams.get('objectId'));
        return new Response(asset.bytes, { headers: { 'content-type': asset.contentType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", ...(asset.sha256 ? {etag:asset.sha256} : {}) } });
      }
      if (name === 'mutate' && request.method === 'POST') {
        if (!this.trustedTransport && request.headers.get('origin') && request.headers.get('origin') !== url.origin) return response({ error: '请求来源与本机工作台不一致。' }, 403);
        if (!request.headers.get('content-type')?.startsWith('application/json')) return response({ error: '操作请求必须为 JSON。' }, 415);
        const raw = await request.text();
        if (Buffer.byteLength(raw) > 2 * 1024 * 1024) return response({ error: '请求内容超过当前上限。' }, 413);
        let body; try { body = JSON.parse(raw); } catch { return response({ error: '请求内容不是有效 JSON。' }, 400); }
        if (!body || typeof body.action !== 'string' || !body.data || typeof body.data !== 'object' || Array.isArray(body.data)) return response({ error: '操作格式不正确。' }, 400);
        return response(await this.mutate(body.action, body.data));
      }
      return response({ error: '未找到对应工作台操作。' }, 404);
    } catch (error) {
      if (error instanceof StoreError) return response({ error: error.message, code: error.code }, error.status);
      return response({ error: '本机资料操作未完成，原记录与输入应保留。', code: 'WORKSPACE_IO_ERROR' }, 500);
    }
  }
  async dispose() { this.disposeNativeConversationVisibility?.();this.listeners.clear(); await this.wordPreview.dispose(); await this.wordEditing.tail; await this.runner.stop(); await this.diagnosticTail; await this.store.close(); }
}
