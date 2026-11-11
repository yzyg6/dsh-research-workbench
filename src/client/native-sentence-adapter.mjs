/** A durable session belongs to one document, shared only by its selection jobs. */
export class NativeSentenceAdapter {
  constructor(api) { this.api = api; this.sessions = null; this.records = new Map(); this.threads = new Map(); this.pending = new Map(); this.allocations=new Map();this.bindings=new Map();this.visibleSessions=new Set();this.listeners = new Set(); this.revision = 0; this.closed = false; this.references = new Set(); }
  subscribe = fn => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  getSnapshot = () => this.revision;
  notify() { this.revision++; for (const fn of this.listeners) fn(); }
  releaseAll() { for (const ref of this.references) ref.release(); this.references.clear(); this.threads.clear(); for (const record of this.records.values()) Object.assign(record, { ref: null, status: 'unavailable', mounted: false }); }
  setSessions(value) { if (value !== this.sessions) { this.releaseAll(); this.pending.clear();this.bindings.clear();this.visibleSessions.clear(); } this.sessions = value; this.notify(); }
  async ensure(project, job, onBinding,{verify=false}={}) {
    if (!this.sessions) throw new Error('DSH 原生会话服务尚未就绪。');
    const key = `${project.id}:${job.objectId||'legacy'}:${job.nativeThreadKey || job.nativeSessionId || 'initial'}`, service = this.sessions;
    let conversation = this.threads.get(key) || [...this.threads.values()].find(record => record.projectId === project.id && record.objectId===job.objectId && job.nativeSessionId && record.sessionId === job.nativeSessionId);
    if (!conversation) {
      let operation = this.pending.get(key);
      if (!operation) {
        operation = (async () => {
          let sessionId = job.nativeSessionId||this.allocations.get(key), ref;
          try {
            if (!sessionId) {sessionId = await service.create({ cwd: project.rootPath });this.allocations.set(key,sessionId)}
            else if (typeof service.refresh === 'function') await service.refresh();
            if (this.closed || this.sessions !== service) return null;
            // Persist ownership and verify workspace membership before mounting.
            await this.bind(project,job,sessionId,onBinding);
            ref = service.retain(sessionId, { source: 'research-workbench-writing' }); this.references.add(ref); await ref.ready;
            if (this.closed || this.sessions !== service) { if (this.references.delete(ref)) ref.release(); return null; }
            const value = { projectId: project.id,objectId:job.objectId,sessionId, ref, status: 'ready' }; this.threads.set(key, value); return value;
          } catch (error) { if (ref && this.references.delete(ref)) ref.release(); throw error; }
        })(); this.pending.set(key, operation);
      }
      try { conversation = await operation; } catch { const failed={jobId:job.id,projectId:project.id,task:'sentence',status:'failed',error:'论文修改对话暂未连接，记录保留。可重新连接。'};this.records.set(job.id,failed);this.notify();return failed; }
      finally { if (this.pending.get(key) === operation) this.pending.delete(key); }
    }
    if (!conversation || this.closed) return null;
    let record = this.records.get(job.id);
    if (!verify&&record?.status === 'ready' && record.sessionId === conversation.sessionId) return record;
    try {
      if(verify||this.bindings.get(job.id)!==conversation.sessionId)await this.bind(project,job,conversation.sessionId,onBinding,{refresh:verify});
      if (this.closed || this.sessions !== service) return null;
      record={...conversation,jobId:job.id,task:'sentence',mounted:false};this.records.set(job.id,record);this.notify();return record;
    } catch { record={jobId:job.id,projectId:project.id,task:'sentence',status:'failed',error:'论文对话绑定暂未完成，可重新连接；原会话保留。'};this.records.set(job.id,record);this.notify();return record; }
  }
  async bind(project,job,sessionId,onBinding,{refresh=false}={}){
    const next=await this.api.mutate(job.conversationKind==='formatting'?'bindFormattingSession':'bindSentenceSession',{projectId:project.id,jobId:job.id,sessionId});
    const bound=next.projects.find(p=>p.id===project.id)?.jobs.find(j=>j.id===job.id);
    if(bound?.nativeSessionId!==sessionId||job.objectId&&bound.objectId!==job.objectId)throw Error('原生对话与当前文稿的绑定未通过核对。');
    if(refresh||!this.visibleSessions.has(sessionId)){await this.sessions?.refresh?.();this.visibleSessions.add(sessionId)}
    this.bindings.set(job.id,sessionId);onBinding?.(next);
  }
  mounted(jobId, value) { const record = this.records.get(jobId); if (record && record.mounted !== value) { record.mounted = value; this.notify(); } }
  dispose() { this.closed = true; this.releaseAll(); this.records.clear();this.allocations.clear();this.bindings.clear();this.visibleSessions.clear();this.listeners.clear(); }
}
