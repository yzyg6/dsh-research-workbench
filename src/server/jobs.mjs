export class TaskRunner {
  constructor(store, { interval = 500 } = {}) { this.store = store; this.interval = interval; this.stopping = false; this.current = null; this.timer = null; this.handlers = new Map(); this.controller = null; this.jobId = null; }
  cancel(jobId) { if (jobId === this.jobId) this.controller?.abort(); }
  async start() { await this.store.recoverJobs(); this.timer = setInterval(() => void this.tick(), this.interval); this.timer.unref?.(); await this.tick(); }
  async tick() {
    if (this.current || this.stopping) return;
    const operation = (async () => { const row = await this.store.claimJob(['project.integrity', ...this.handlers.keys()]); if (!row) return; this.jobId = row.id; this.controller = new AbortController(); const handler = this.handlers.get(row.type); if (handler) await handler(row, this.controller.signal); else await this.store.runJob(row); })();
    this.current = operation;
    try { await operation; } catch { /* A failed runner never drops the durable job row. */ }
    finally { this.current = null; this.controller = null; this.jobId = null; }
  }
  async stop() { this.stopping = true; clearInterval(this.timer); this.controller?.abort(); await this.current; }
}
