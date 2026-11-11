import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { WorkspaceRuntime } from '../src/server/runtime.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const dataRoot = process.env.RESEARCH_DEV_ROOT || join(root, '_scratch/out/phase1-dev');
const runtime = new WorkspaceRuntime({ root: dataRoot, sampleRoot: join(root, 'samples/figure'), publicRoot: join(root, 'public'), trustedTransport: false });
await runtime.start();
const server = createServer(async (incoming, outgoing) => {
  try {
    if (incoming.headers.host !== '127.0.0.1:4384') { outgoing.writeHead(403).end(); return; }
    if (incoming.url === '/') { outgoing.writeHead(302, { location: '/api/research-workbench/app' }).end(); return; }
    const chunks = []; let length = 0;
    for await (const chunk of incoming) { length += chunk.length; if (length > 2 * 1024 * 1024) { outgoing.writeHead(413).end(); return; } chunks.push(chunk); }
    const request = new Request(`http://127.0.0.1:4384${incoming.url}`, { method: incoming.method, headers: incoming.headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
    const response = await runtime.handle(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch { outgoing.writeHead(500).end('Local workspace unavailable'); }
});
server.listen(4384, '127.0.0.1', () => console.log('Phase-one workspace: http://127.0.0.1:4384'));
let stopping = false;
async function stop() { if (stopping) return; stopping = true; server.close(); await runtime.dispose(); process.exit(0); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
