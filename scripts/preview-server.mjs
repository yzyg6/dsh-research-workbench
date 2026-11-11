import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const files = new Map([['/', ['public/preview.html', 'text/html']], ['/preview.js', ['public/preview.js', 'text/javascript']], ['/preview-data.csv', ['samples/figure/experiment.csv', 'text/csv']], ['/preview-figure.png', ['samples/figure/Figure1.png', 'image/png']]]);
const server = createServer(async (request, response) => {
  const file = files.get(new URL(request.url, 'http://localhost').pathname);
  if (!file || request.method !== 'GET') { response.writeHead(404).end(); return; }
  try { const body = await readFile(join(root, file[0])); response.writeHead(200, { 'content-type': `${file[1]}; charset=utf-8`, 'cache-control': 'no-store' }); response.end(body); }
  catch { response.writeHead(500).end('Preview unavailable'); }
});
server.listen(4383, '127.0.0.1', () => console.log('UI preview: http://127.0.0.1:4383'));
