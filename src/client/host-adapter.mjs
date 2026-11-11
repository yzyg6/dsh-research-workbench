/** Own only the native sessions explicitly bound to this workbench's projects. */
export class HostAdapter {
  constructor(api) { this.api = api; this.sessions = null; this.records = new Map(); this.references = new Set(); this.pending = new Map(); this.listeners = new Set(); this.revision = 0; this.closed = false; }
  subscribe = (listener) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = () => this.revision;
  notify() { this.revision++; for (const listener of this.listeners) listener(); }
  release(ref) { if (ref && this.references.delete(ref)) ref.release(); }
  setSessions(sessions) {
    if (this.sessions && this.sessions !== sessions) {
      for (const ref of [...this.references]) this.release(ref);
      for (const [key, record] of this.records) this.records.set(key, { ...record, ref: null, status: 'unavailable', mounted: false });
    }
    this.sessions = sessions; this.notify();
  }
  async ensure(project, task, { replace = false, retry = false, onBinding } = {}) {
    if (!this.sessions) throw new Error('当前宿主的原生会话服务尚未就绪。');
    const ownerKey = `${project.id}:${task}`;
    if (this.pending.has(ownerKey)) return this.pending.get(ownerKey);
    const previous = this.records.get(ownerKey), boundId = project.bindings[task];
    if (!replace && !retry && previous && previous.sessionId === boundId && ['ready', 'failed'].includes(previous.status)) return previous;
    const operation = (async () => {
      const service = this.sessions;
      let sessionId = boundId;
      this.records.set(ownerKey, { ...previous, ownerKey, projectId: project.id, task, status: 'loading', error: null }); this.notify();
      try {
        if (!sessionId || replace) {
          const createdId = await service.create({ cwd: project.rootPath });
          if (this.closed) return null;
          const next = await this.api.mutate('bindSession', { projectId: project.id, task, sessionId: createdId, ...(replace ? { replaceSessionId: boundId } : {}) });
          sessionId = next.projects.find((owner) => owner.id === project.id)?.bindings[task];
          if (!sessionId) throw new Error('原生会话已创建，但项目绑定未保存。');
          onBinding?.(next);
        }
        if (this.closed) return null;
        // The service can arrive before its first durable catalog snapshot.
        // Await the public refresh before retaining an existing identity.
        if (boundId && !replace && typeof service.refresh === 'function') await service.refresh();
        if (this.closed) return null;
        const ref = service.retain(sessionId, { source: 'research-workbench' });
        this.references.add(ref);
        const record = { ownerKey, projectId: project.id, task, sessionId, ref, status: 'loading', error: null, mounted: false };
        this.records.set(ownerKey, record);
        try { await ref.ready; }
        catch (error) { this.release(ref); record.ref = null; throw error; }
        if (this.closed || this.records.get(ownerKey) !== record) { this.release(ref); return null; }
        this.release(previous?.ref);
        record.status = 'ready'; this.notify(); return record;
      } catch (error) {
        if (previous?.ref && this.references.has(previous.ref)) { this.records.set(ownerKey, previous); this.notify(); return previous; }
        const errorCode = /unknown session/.test(error?.message || '') ? 'CATALOG_UNKNOWN_SESSION' : typeof error?.code === 'string' && /^[a-zA-Z0-9_/-]{1,100}$/.test(error.code) ? error.code : 'NATIVE_OPEN_FAILED';
        this.records.set(ownerKey, { ownerKey, projectId: project.id, task, sessionId, status: 'failed', errorCode, error: '此任务的原生对话暂不可用，项目资料与已保存输入仍保留。' }); this.notify(); return this.records.get(ownerKey);
      }
    })();
    this.pending.set(ownerKey, operation);
    try { return await operation; } finally { this.pending.delete(ownerKey); }
  }
  markMounted(key, mounted) { const record = this.records.get(key); if (record && record.mounted !== mounted) { record.mounted = mounted; this.notify(); } }
  async dispose() { this.closed = true; for (const ref of [...this.references]) this.release(ref); this.records.clear(); this.listeners.clear(); }
}
