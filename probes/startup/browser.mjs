/** Real browser startup/reopen probe. Uses isolated synthetic files, never DSH data. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { WorkspaceRuntime } from '../../src/server/runtime.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = join(root, '_scratch/out/startup-browser'); await mkdir(out, { recursive: true });
const directory = await mkdtemp(join(out, 'case-'));
const runtime = new WorkspaceRuntime({ root: join(directory, 'catalog'), sampleRoot: join(root, 'samples/figure'), publicRoot: join(root, 'public'), trustedTransport: false });
const projectId = await runtime.store.createProject({ title: '合成启动性能验收' });
for (let i = 0; i < 12; i++) await runtime.store.createObject({ projectId, kind: 'evidence', title: `按需资料-${i}`, text: `# 按需资料-${i}\n\n` + 'Synthetic imported evidence. '.repeat(16000) });
const trace = [], pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let misses = 2, browser, ws, server;
try {
  server = createServer(async (incoming, outgoing) => {
    const controller = new AbortController(); outgoing.on('close', () => controller.abort());
    try {
      if (incoming.url.startsWith('/api/research-workbench/state?summary') && misses-- > 0) { trace.push({ unavailable: true }); outgoing.writeHead(503).end('<html>Host is starting</html>'); return; }
      const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
      const started = performance.now();
      const response = await runtime.handle(new Request(`http://127.0.0.1:${server.address().port}${incoming.url}`, { method: incoming.method, headers: incoming.headers, signal: controller.signal, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }));
      const bytes = Buffer.from(await response.arrayBuffer());
      if (incoming.url.startsWith('/api/research-workbench/state?summary')) trace.push({ bytes: bytes.length, ms: Math.round(performance.now() - started) });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(bytes);
    } catch (error) { if (!outgoing.destroyed) outgoing.writeHead(500).end(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/research-workbench/app`;
  browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(directory, 'edge-profile')}`, '--no-first-run', '--disable-background-timer-throttling', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let port;
  for (let i = 0; i < 100; i++) { try { port = Number((await readFile(join(directory, 'edge-profile/DevToolsActivePort'), 'utf8')).split('\n')[0]); if (port) break; } catch {} await pause(100); }
  assert(port, 'Edge debugging port');
  const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p => p.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0; const pending = new Map(), errors = [];
  ws.onmessage = event => { const item = JSON.parse(event.data), waiter = pending.get(item.id); if (waiter) { clearTimeout(waiter.timer); pending.delete(item.id); item.error ? waiter.reject(Error(JSON.stringify(item.error))) : waiter.resolve(item.result); } else if (item.method === 'Runtime.exceptionThrown') errors.push(item.params.exceptionDetails.text); };
  const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(Error(`Timeout: ${method}`)); }, 15000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  await call('Runtime.enable'); await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  const opens = [];
  for (let n = 0; n < 10; n++) {
    const start = performance.now(); await call('Page.navigate', { url: url + '?open=' + n });
    let ready = false;
    for (let i = 0; i < 200; i++) { ready = await evaluate(`document.querySelector('.rw-breadcrumb strong')?.textContent === '合成启动性能验收' && !document.querySelector('[data-error="true"]') && !!document.querySelector('.rw-paper')`); if (ready) break; await pause(25); }
    assert(ready, await evaluate('document.body.innerText')); opens.push(Math.round(performance.now() - start));
  }
  const startupTrace = [...trace];
  await evaluate(`Array.from(document.querySelectorAll('.rw-resource')).find(b=>b.title==='按需资料-0').click()`);
  let selected = false;
  for (let i = 0; i < 100; i++) { selected = await evaluate(`document.querySelector('.rw-paper')?.textContent.includes('Synthetic imported evidence.')`); if (selected) break; await pause(25); }
  assert(selected, 'selecting a hidden file loads its content'); assert.deepEqual(errors, []);
  assert.equal(trace.filter(t => t.unavailable).length, 2);
  assert(startupTrace.filter(t => t.bytes).every(t => t.bytes < 25000), 'reopening must not transfer hidden full texts');
  const report = { date: '2026-11-12', successfulOpens: opens.length, failedOpens: 0, openMs: opens, transientRouteFailuresRecovered: 2, hiddenFiles: 12, hiddenTextBytes: 12 * 28 * 16000, stateResponses: startupTrace.filter(t => t.bytes), selectedFileLoaded: selected, browserErrors: errors, syntheticDataOnly: true };
  await writeFile(join(out, 'latest.json'), JSON.stringify(report, null, 2));
  await writeFile(join(out, 'latest.png'), Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  console.log(JSON.stringify(report, null, 2));
  await call('Browser.close');
} finally {
  ws?.close(); if (browser?.exitCode === null) browser.kill();
  server?.closeAllConnections(); server?.close(); await runtime.dispose();
}
