import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { StoreError } from './store.mjs';

const stop = new Set('修改 润色 学术 句子 这句话 本文 研究 进行 可能 影响 结果 表明 说明 根据 结合 更加 以及 其中 之间 this that with from have were been study results sentence please rewrite'.split(' '));
export function searchTerms(text) {
  const words = [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(text)].filter(x => x.isWordLike).map(x => x.segment.toLowerCase());
  return [...new Set(words.filter(x => x.length >= 2 && !stop.has(x) && !/^\d+$/.test(x)))].sort((a, b) => b.length - a.length).slice(0, 6);
}
function unpack(result) {
  if (result?.isError) throw new Error('Zotero 全文检索返回错误。');
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.filter(x => x.type === 'text').map(x => x.text).join('\n');
  try { return JSON.parse(text); } catch { throw new Error('Zotero 全文检索响应格式无法识别。'); }
}
export class ZoteroFulltext {
  constructor({ fetcher = fetch } = {}) { this.fetcher = fetcher; this.sequence = 0; this.session = null; this.initializing = null; }
  async rpc(method, params, signal) {
    const id = ++this.sequence;
    const result = await this.fetcher('http://127.0.0.1:23120/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(this.session ? { 'Mcp-Session-Id': this.session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(20000)]) });
    if (!result.ok) throw new Error('Zotero MCP 暂不可用。');
    this.session = result.headers.get('Mcp-Session-Id') || this.session;
    const raw = await result.text(); let data;
    try { data = JSON.parse(raw); } catch { data = raw.split('\n').filter(x => x.startsWith('data:')).map(x => { try { return JSON.parse(x.slice(5).trim()); } catch { return null; } }).find(x => x?.id === id); }
    if (!data || data.error) throw new Error('Zotero MCP 检索失败。');
    return data.result;
  }
  async tool(name, args, signal) {
    if (!this.initializing) this.initializing = this.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dsh-research-workbench', version: '0.2.0' } }, signal).catch(error => { this.initializing = null; this.session = null; throw error; });
    await this.initializing;
    return unpack(await this.rpc('tools/call', { name, arguments: args }, signal));
  }
  async search(terms, signal) {
    const settled = await Promise.allSettled(terms.slice(0, 4).map(q => this.tool('search_fulltext', { q, mode: 'standard', contextLength: 500, maxResults: 5 }, signal)));
    const hits = new Map(); let completed = 0;
    for (const result of settled) {
      if (result.status !== 'fulfilled') continue; completed++;
      const data = result.value;
      for (const item of (Array.isArray(data.results) ? data.results : []).slice(0, 20)) for (const match of (item.matches || []).slice(0, 3)) {
        if (!match.context || match.type !== 'attachment') continue;
        const snippet = String(match.context).slice(0, 1800), key = `${item.itemKey}:${match.position}:${snippet.slice(0, 80)}`;
        const score = terms.reduce((n, term) => n + (snippet.toLowerCase().includes(term) ? 1 : 0), 0);
        if (score) hits.set(key, { title: String(item.title || 'Zotero 文献').replace(/<[^>]*>/g, ''), itemKey: item.itemKey, snippet, kind: 'Zotero 附件全文', locator: Number.isInteger(match.position) ? `全文字符位置 ${match.position}（非页码）` : '附件全文片段（页码未提供）', filename: match.filename || '', score, url: /^[A-Z0-9]{8}$/.test(item.itemKey) ? `zotero://select/library/items/${item.itemKey}` : '', synthetic: /phase0|synthetic fixture|test fixture/i.test(item.title || '') });
      }
    }
    if (!completed && terms.length) throw new Error('Zotero MCP 暂不可用；本次未检索到 Zotero 全文。');
    return [...hits.values()].sort((a, b) => b.score - a.score).slice(0, 6);
  }
}
export class WritingEvidence {
  constructor(store, { zotero = new ZoteroFulltext() } = {}) { this.store = store; this.zotero = zotero; this.directory = join(store.root, 'library'); }
  async import({ title, text, projectId }) {
    if (typeof title !== 'string' || !title.trim() || title.length > 200 || typeof text !== 'string' || !text.trim() || text.length > 1024 * 1024) throw new StoreError('INVALID_LITERATURE', '请选择不超过 1 MiB 的已解析文献 Markdown。');
    await mkdir(this.directory, { recursive: true });
    let value;
    if (projectId) { const objectId = await this.store.createObject({ projectId, kind: 'evidence', title, text }); value = { id: objectId, title: title.trim(), sourceProjectId: projectId, sourceObjectId: objectId, kind: '本地解析文献 Markdown', importedAt: new Date().toISOString() }; }
    else value = { id: randomUUID(), title: title.trim(), text, kind: '本地解析文献 Markdown', importedAt: new Date().toISOString() };
    await writeFile(join(this.directory, `${value.id}.json`), JSON.stringify(value), { flag: 'wx' });
    return value.id;
  }
  async local(projectId, terms) {
    const documents = [], knownPaths = new Set();
    let entries = []; try { entries = await readdir(this.directory, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const file of entries.filter(x => x.isFile() && x.name.endsWith('.json')).slice(0, 1000)) {
      try { const raw = await readFile(join(this.directory, file.name), 'utf8'); if (raw.length <= 1200000) { const doc = JSON.parse(raw); if (doc.sourceProjectId && doc.sourceObjectId) { const object = this.store.object(doc.sourceProjectId, doc.sourceObjectId), metadata = JSON.parse(object.metadata), path = await this.store.projectPath(doc.sourceProjectId, metadata.workspaceFile); doc.text = await readFile(path, 'utf8'); knownPaths.add(path); } if (typeof doc.text === 'string') documents.push(doc); } } catch { /* One invalid imported file cannot hide other literature. */ }
    }
    const layout = await this.store.workspaceFiles.layout(projectId);
    const visit = async (directory, depth = 0) => {
      if (depth > 8 || documents.length >= 1000) return;
      for (const entry of (await this.store.workspaceFiles.list(projectId, directory, { limit: 2000 })).entries) {
        if (entry.directory && !entry.name.startsWith('_')) await visit(entry.relativePath, depth + 1);
        else if (/\.(md|markdown|txt)$/i.test(entry.name) && entry.bytes <= 1024 * 1024) { const path = await this.store.projectPath(projectId, entry.relativePath); if (!knownPaths.has(path)) { knownPaths.add(path); documents.push({ id: entry.relativePath, title: entry.name, text: await readFile(path, 'utf8'), kind: '工作区解析文献 Markdown' }); } }
      }
    };
    await visit(layout.directories.reference);
    for (const row of this.store.db.prepare("SELECT * FROM objects WHERE project_id=? AND kind='evidence' AND encoding='utf8'").all(projectId)) { const metadata = JSON.parse(row.metadata); if (metadata.workspaceFile && knownPaths.has(await this.store.projectPath(projectId, metadata.workspaceFile))) continue; documents.push({ id: row.id, title: row.title, text: (await this.store.asset(projectId, row.id)).bytes.toString('utf8'), kind: '当前项目证据资料', revision: row.revision }); }
    const hits = [];
    for (const doc of documents) {
      let offset = 0;
      for (const block of doc.text.split(/\n\s*\n/)) {
        const position = doc.text.indexOf(block, offset); offset = position + block.length;
        const score = terms.reduce((n, term) => n + (block.toLowerCase().includes(term) ? 1 : 0), 0);
        if (score) { const first = Math.min(...terms.map(t => block.toLowerCase().indexOf(t)).filter(x => x >= 0)); const start = Math.max(0, first - 300); hits.push({ title: doc.title, localId: doc.id, snippet: block.slice(start, start + 1500), kind: doc.kind || '本地解析文献', locator: `Markdown 字符位置 ${position + start}（页码未提供）`, revision: doc.revision, score, synthetic: /phase0|synthetic|合成|测试夹具/i.test(doc.title || '') }); }
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, 6);
  }
  async retrieve({ projectId, selectedText, keywords }, signal) {
    const terms = searchTerms(keywords || selectedText), warnings = [];
    if (!terms.length) warnings.push('没有提取到有效检索词，可填写文献关键词后重新生成。');
    const [local, zotero] = await Promise.allSettled([this.local(projectId, terms), this.zotero.search(terms, signal)]);
    signal?.throwIfAborted();
    if (local.status === 'rejected') warnings.push('本地文献读取未完成。');
    if (zotero.status === 'rejected') warnings.push('Zotero MCP 暂不可用；本次仅使用可读取的本地证据。');
    const sources = [...(local.value || []), ...(zotero.value || [])].sort((a, b) => b.score - a.score).slice(0, 10).map((source, i) => ({ ...source, id: `E${i + 1}` }));
    if (!sources.length) warnings.push('未找到匹配的全文证据；仅能优化表达，不得新增文献结论或引用。');
    if (sources.some(x => x.synthetic)) warnings.push('检索包含明确标记的合成测试资料，不能作为真实科研结论的依据。');
    return { terms, sources, warnings, zotero: zotero.status === 'fulfilled' ? 'searched' : 'unavailable', local: local.status === 'fulfilled' ? 'searched' : 'unavailable' };
  }
}
