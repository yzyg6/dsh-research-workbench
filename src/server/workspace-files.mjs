import { mkdir, readdir, stat, readFile, writeFile, rename, copyFile, unlink, realpath, open, utimes } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname, extname, basename, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { StoreError } from './store.mjs';

const exec = promisify(execFile);
export const ROLES = { paper: 'paper', picture: 'picture', data: 'Data', reference: 'reference', temp: 'temp' };
const check = (ok, code, message, status = 400) => { if (!ok) throw new StoreError(code, message, status); };
export const fileHash = async path => { const digest = createHash('sha256'); for await (const chunk of createReadStream(path)) digest.update(chunk); return digest.digest('hex'); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const stable = value => JSON.stringify((function normalize(node) { return Array.isArray(node) ? node.map(normalize) : node && typeof node === 'object' ? Object.fromEntries(Object.keys(node).sort().map(key => [key, normalize(node[key])])) : node; })(value));
const rel = (root, path) => relative(root, path).split(sep).join('/');
const inside = (root, path) => { const value = relative(root, path); return value === '' || !value.startsWith('..') && !isAbsolute(value); };
const cleanName = value => String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 90) || 'untitled';
const exists = async path => { try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
export const MIME = { '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.tsv': 'text/tab-separated-values; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.py': 'text/x-python; charset=utf-8', '.r': 'text/plain; charset=utf-8', '.tex': 'text/x-tex; charset=utf-8' };

/** Files and manifests belong to the paper root; the host database is a catalog. */
export class WorkspaceFiles {
  constructor(store) { this.store = store; this.layouts = new Map(); this.checkpoints = new Map(); this.errors = new Map(); this.compatibility = new Map(); }
  async ensure(root) {
    root = resolve(root);
    if (this.layouts.has(root)) return this.layouts.get(root);
    await mkdir(root, { recursive: true });
    const physicalRoot = await realpath(root), names = await readdir(root, { withFileTypes: true }), directories = {};
    for (const [role, standard] of Object.entries(ROLES)) {
      const matches = names.filter(entry => entry.name.toLowerCase() === standard.toLowerCase());
      check(matches.length <= 1, 'AMBIGUOUS_DIRECTORY', `工作区存在多个 ${standard} 目录，请先区分。`);
      const name = matches[0]?.name || standard, path = join(root, name);
      await mkdir(path, { recursive: true });
      check((await stat(path)).isDirectory() && inside(physicalRoot, await realpath(path)), 'WORKSPACE_PATH_OUTSIDE', `${name} 必须是当前论文工作区内的目录。`);
      directories[role] = name;
    }
    const privateRoot = join(root, '.research-workbench'); await mkdir(privateRoot, { recursive: true });
    check(inside(physicalRoot, await realpath(privateRoot)), 'WORKSPACE_PATH_OUTSIDE', '项目状态目录不能指向论文工作区外部。');
    const configuration = join(privateRoot, 'workspace.json');
    const compatibilityPath = join(privateRoot, 'compatibility.json');
    const ignored = new Set();
    if (await exists(compatibilityPath)) { const aliases = JSON.parse(await readFile(compatibilityPath, 'utf8')); for (const alias of aliases.links || []) if (typeof alias.source === 'string' && typeof alias.target === 'string' && inside(root, resolve(root, alias.source)) && inside(root, resolve(root, alias.target))) ignored.add(alias.source.replace(/\\/g, '/').toLowerCase()); }
    this.compatibility.set(root, ignored);
    if (await exists(configuration)) {
      const old = JSON.parse(await readFile(configuration, 'utf8'));
      check(old.schemaVersion === 1, 'NEWER_WORKSPACE', '工作区目录配置版本不兼容，未覆盖。', 409);
      for (const role of Object.keys(ROLES)) check(old.directories[role]?.toLowerCase() === directories[role].toLowerCase(), 'WORKSPACE_LAYOUT_CHANGED', '工作区目录映射已变化，请先恢复配置中的目录。', 409);
    } else await writeFile(configuration, JSON.stringify({ schemaVersion: 1, directories }, null, 2), { flag: 'wx' });
    let git = 'ready';
    if (!await exists(join(root, '.git'))) {
      try { await exec('git', ['init', '--quiet'], { cwd: root, windowsHide: true, timeout: 15000 }); }
      catch { git = 'unavailable'; }
    }
    const ignore = join(root, '.gitignore'), marker = '# DSH research workbench';
    const previous = await exists(ignore) ? await readFile(ignore, 'utf8') : '';
    if (!previous.includes(marker)) await writeFile(ignore, `${previous}${previous && !previous.endsWith('\n') ? '\n' : ''}\n${marker}\n/${directories.temp}/\n/.research-workbench/cache/\n/.research-workbench/locks/\n`, 'utf8');
    const layout = { rootPath: root, directories, git }; this.layouts.set(root, layout); return layout;
  }
  async layout(projectId) { return this.ensure(this.store.project(projectId).root_path); }
  async safe(projectId, path) { return this.store.projectPath(projectId, path); }
  async image(projectId, objectId, source) {
    check(typeof source === 'string' && source.length > 0 && source.length <= 4096 && !source.includes('\0'), 'INVALID_IMAGE_PATH', '稿件图片路径无效。');
    const layout = await this.layout(projectId), object = this.store.object(projectId, objectId), metadata = JSON.parse(object.metadata);
    let value;
    try { value = /^file:/i.test(source) ? fileURLToPath(source) : decodeURIComponent(source.split(/[?#]/)[0]); } catch { throw new StoreError('INVALID_IMAGE_PATH', '图片路径编码无效。'); }
    const destination = isAbsolute(value) ? resolve(value) : resolve(layout.rootPath, dirname(metadata.workspaceFile || object.path), value);
    check(inside(layout.rootPath, destination), 'PATH_OUTSIDE_PROJECT', '图片不属于当前论文工作区。', 403);
    const path = rel(layout.rootPath, destination);
    check(Object.values(layout.directories).some(folder => path.startsWith(folder + '/')), 'WORKSPACE_PATH_OUTSIDE', '只能读取工作区业务目录内的图片。', 403);
    const contentType = MIME[extname(path).toLowerCase()]; check(contentType?.startsWith('image/'), 'INVALID_IMAGE_PATH', '该文件不是受支持的论文图片。');
    const file = await this.safe(projectId, path); check((await stat(file)).size <= 64 * 1024 * 1024, 'CONTENT_TOO_LARGE', '图片文件过大。', 413);
    const bytes = await readFile(file); return { bytes, contentType, sha256: hash(bytes) };
  }
  async atomic(projectId, destination, bytes) {
    const layout = await this.layout(projectId), temporary = await this.safe(projectId, join(layout.directories.temp, 'dsh-workbench', 'transactions', randomUUID() + '.tmp'));
    await mkdir(dirname(temporary), { recursive: true }); await mkdir(dirname(destination), { recursive: true });
    await writeFile(temporary, bytes, { flag: 'wx' });
    try { await rename(temporary, destination); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  }
  async allocate(projectId, { objectId, kind, title, extension, revision, metadata = {}, versioned = true }) {
    const layout = await this.layout(projectId), folder = layout.directories[{ manuscript: 'paper', note: 'paper', data: 'data', evidence: 'reference', figure: 'picture' }[kind]] || metadata.workspaceFile?.split(/[\\/]/)[0];
    const stem = cleanName(basename(title, extname(title))), suffix = extension || (kind === 'figure' ? '.png' : kind === 'data' ? '.csv' : '.md');
    let working = metadata.workspaceFile;
    if (!working) {
      const base = kind === 'figure' ? join(folder, `${stem}-${objectId.slice(-8)}`) : kind === 'note' ? join(folder, 'notes') : kind === 'evidence' ? join(folder, 'parsed') : folder;
      working = join(base, stem + suffix);
      if (await exists(await this.safe(projectId, working))) working = join(base, `${stem}-${objectId.slice(-8)}${suffix}`);
    }
    working = rel(layout.rootPath, await this.safe(projectId, working));
    check(working.toLowerCase().startsWith(folder.toLowerCase() + '/') && !working.split('/').includes('_versions'), 'WORKSPACE_ROLE_MISMATCH', '资料必须保存到所属类型的工作区目录，不能写入 Git 或内部版本目录。', 403);
    working = folder + working.slice(folder.length);
    const extensions = { manuscript: ['.md','.markdown','.doc','.docx','.pdf','.tex'], note: ['.md','.markdown','.txt'], data: ['.csv','.tsv','.xlsx','.json','.parquet','.shp','.gpkg','.geojson'], evidence: ['.md','.markdown','.pdf','.txt'], figure: ['.png','.svg','.pdf'], file: ['.py','.r','.ipynb','.drawio','.json'] };
    check(extensions[kind]?.includes(extname(working).toLowerCase()), 'WORKSPACE_ROLE_MISMATCH', '文件扩展名与资料类型不匹配。', 403);
    if(!versioned)return {working,version:working,versionPath:await this.safe(projectId,working)};
    const version = join(folder, '_versions', objectId, `v${String(revision).padStart(4, '0')}-${randomUUID()}${suffix}`);
    const versionPath = await this.safe(projectId, version); await mkdir(dirname(versionPath), { recursive: true });
    return { working: rel(layout.rootPath, await this.safe(projectId, working)), version: rel(layout.rootPath, versionPath), versionPath };
  }
  async publish(projectId, working, bytes, expectedHash = null) {
    const destination = await this.safe(projectId, working), present = await exists(destination);
    if (present) check(expectedHash && await fileHash(destination) === expectedHash, 'EXTERNAL_CHANGE', '工作区文件已在外部修改，未覆盖；请重新扫描工作区后核对。', 409);
    const previous = present ? await readFile(destination) : null, previousStat=present?await stat(destination):null, nextHash = hash(bytes);
    await this.atomic(projectId, destination, bytes);
    this.store.fileRollbacks?.push(async () => { if (await exists(destination) && await fileHash(destination) === nextHash) { if (previous) {await this.atomic(projectId, destination, previous);await utimes(destination,previousStat.atime,previousStat.mtime)} else await unlink(destination); } });
  }
  export(projectId) {
    const db = this.store.db;
    const conversationState=db.prepare("SELECT key,value FROM preferences WHERE key LIKE ? OR key LIKE ? OR (key LIKE 'sentenceSession:%' AND json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END,'$.projectId')=?)").all(`sentenceThread:${projectId}:%`,`formatThread:${projectId}:%`,projectId);
    return { schemaVersion: 1, project: this.store.project(projectId), objects: db.prepare('SELECT * FROM objects WHERE project_id=?').all(projectId), versions: db.prepare('SELECT * FROM object_versions WHERE project_id=?').all(projectId), tasks: db.prepare('SELECT * FROM task_states WHERE project_id=?').all(projectId), bindings: db.prepare('SELECT * FROM bindings WHERE project_id=?').all(projectId), dependencies: db.prepare('SELECT * FROM dependencies WHERE project_id=?').all(projectId), jobs: db.prepare('SELECT * FROM jobs WHERE project_id=?').all(projectId), thread: this.store.db.prepare('SELECT value FROM preferences WHERE key=?').get(`sentenceThread:${projectId}`)?.value || null,conversationState };
  }
  async checkpointAll() {
    for (const project of this.store.projectRows()) {
      try {
        await this.layout(project.id);
        const content = JSON.stringify(this.export(project.id), null, 2), checksum = hash(content);
        if (this.checkpoints.get(project.id) !== checksum) { await this.atomic(project.id, await this.safe(project.id, '.research-workbench/project.json'), content); this.checkpoints.set(project.id, checksum); }
        this.errors.delete(project.id);
      } catch (error) { this.errors.set(project.id, error instanceof StoreError ? error.message : '项目状态快照尚未同步；已保存的正文版本仍保留。'); }
    }
  }
  async list(projectId, directory = '', { offset = 0, limit = 250 } = {}) {
    const layout = await this.layout(projectId), allowed = Object.values(layout.directories);
    check(typeof directory === 'string' && (!directory || allowed.some(folder => directory === folder || directory.startsWith(folder + '/') || directory.startsWith(folder + '\\'))), 'WORKSPACE_PATH_OUTSIDE', '只能浏览论文工作区的业务目录。', 403);
    check(Number.isInteger(offset) && offset >= 0 && offset <= 100000, 'INVALID_INPUT', '文件列表位置无效。');
    if (!directory) return { entries: allowed.map(name => ({ name, relativePath: name, directory: true })), total: allowed.length, offset: 0, limit };
    const path = await this.safe(projectId, directory), entries = await readdir(path, { withFileTypes: true });
    const rows = [];
    const visible = entries.filter(e => !e.name.startsWith('.') && e.name !== '_versions' && !e.isSymbolicLink() && !this.compatibility.get(layout.rootPath)?.has(rel(layout.rootPath, join(path, e.name)).toLowerCase())).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'zh-CN'));
    for (const entry of visible.slice(offset, offset + limit)) {
      const relativePath = rel(layout.rootPath, join(path, entry.name));
      const details = entry.isDirectory() ? null : await stat(join(path, entry.name));
      rows.push({ name: entry.name, relativePath, directory: entry.isDirectory(), bytes: details?.size || 0, modifiedAt: details?.mtime.toISOString(), kind: this.classify(layout, relativePath) });
    }
    return { entries: rows, total: visible.length, offset, limit };
  }
  classify(layout, path) {
    const folder = path.split(/[\\/]/)[0], extension = extname(path).toLowerCase();
    if (folder === layout.directories.paper) return ['.md', '.markdown'].includes(extension) ? path.replace(/\\/g, '/').startsWith(folder + '/notes/') || /README|计划|说明|清单|记录/i.test(basename(path)) ? 'note' : 'manuscript' : ['.doc', '.docx', '.pdf', '.tex'].includes(extension) ? 'manuscript' : null;
    if (folder === layout.directories.picture) return ['.png', '.svg', '.pdf'].includes(extension) ? 'figure' : ['.py', '.r', '.ipynb', '.drawio', '.json'].includes(extension) ? 'file' : null;
    if (folder === layout.directories.data) return ['.csv', '.tsv', '.xlsx', '.json', '.parquet', '.shp', '.gpkg', '.geojson'].includes(extension) ? 'data' : null;
    if (folder === layout.directories.reference) return ['.pdf', '.md', '.markdown', '.txt'].includes(extension) ? 'evidence' : null;
    return null;
  }
  async discover(projectId) {
    const layout = await this.layout(projectId), files = [];
    const visit = async (directory, depth) => {
      if (depth > 8 || files.length >= 500) return;
      for (const entry of (await this.list(projectId, directory, { limit: 2000 })).entries) {
        if (entry.directory) { if (!['assets', 'history', 'archive', 'legacy', '__pycache__'].includes(entry.name.toLowerCase()) && !entry.name.startsWith('_')) await visit(entry.relativePath, depth + 1); }
        else if (entry.kind && entry.kind !== 'file' && (entry.kind !== 'data' || ['.csv', '.tsv', '.xlsx', '.parquet'].includes(extname(entry.name).toLowerCase()))) files.push(entry);
      }
    };
    for (const role of ['paper', 'picture', 'data', 'reference']) await visit(layout.directories[role], 0);
    const figureGroups = new Map();
    for (const file of files) if (file.kind === 'figure') { const stem = file.relativePath.slice(0, -extname(file.relativePath).length); const old = figureGroups.get(stem); if (!old || extname(file.name).toLowerCase() === '.png') figureGroups.set(stem, file); }
    const figures = [], markers = new Map();
    for (const file of figureGroups.values()) {
      const folder = dirname(file.relativePath);
      if (!markers.has(folder)) { try { markers.set(folder, JSON.parse(await readFile(await this.safe(projectId, join(folder, '.research-workbench-figure.json')), 'utf8'))); } catch { markers.set(folder, null); } }
      const marker = markers.get(folder);
      if (marker?.primaryStem && basename(file.name, extname(file.name)) !== marker.primaryStem) continue;
      figures.push(file);
    }
    return [...files.filter(f => f.kind !== 'figure'), ...figures];
  }
  async attach(projectId, relativePath,{openOriginal=false}={}) {
    const layout = await this.layout(projectId), source = await this.safe(projectId, relativePath), canonical = rel(layout.rootPath, source), kind = this.classify(layout, canonical);
    check(kind, 'UNSUPPORTED_WORKSPACE_FILE', '此文件可以留在工作区中，当前编辑器暂不直接编辑。');
    const originalOwner=this.store.db.prepare("SELECT id FROM objects WHERE project_id=? AND json_extract(metadata,'$.wordOriginalFile')=? AND json_extract(metadata,'$.wordEditable')=1").get(projectId,canonical);
    if(originalOwner&&!openOriginal)return this.restoreWordWorkingCopy(projectId,originalOwner.id);
    const details = await stat(source); check(details.isFile(), 'INVALID_INPUT', '请选择实际文件。');
    const checksum = await fileHash(source), existing = this.store.db.prepare("SELECT * FROM objects WHERE project_id=? AND json_extract(metadata,'$.workspaceFile')=?").get(projectId, canonical);
    const objectId = existing?.id || `o_${randomUUID()}`, revision = existing ? existing.revision + 1 : 1, extension = extname(source).toLowerCase();
    const prior = existing ? JSON.parse(existing.metadata) : {};
    const editable = (['.md', '.markdown', '.txt'].includes(extension) && kind !== 'data' || kind === 'data' && ['.csv', '.tsv'].includes(extension) && prior.workspaceManaged === true) && details.size <= 1024 * 1024;
    const metadata = { ...(existing ? JSON.parse(existing.metadata) : {}), workspaceFile: canonical, workspaceReadOnly: !editable, mimeType: MIME[extension] || 'application/octet-stream', bytes: details.size, sourceMtimeMs: details.mtimeMs };
    if (kind === 'data' && ['.csv', '.tsv'].includes(extension)) { const handle = await open(source, 'r'); try { const buffer = Buffer.alloc(Math.min(details.size, 128 * 1024)); const { bytesRead } = await handle.read(buffer); metadata.preview = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/).slice(0, 101).join('\n'); } finally { await handle.close(); } }
    if (kind === 'figure') {
      metadata.formats = {};
      for (const format of ['png', 'svg', 'pdf']) { const sibling = source.slice(0, -extension.length) + '.' + format; if (await exists(sibling)) metadata.formats[format] = rel(layout.rootPath, sibling); }
      const scripts = (await readdir(dirname(source))).filter(name => ['.py', '.r', '.ipynb', '.drawio'].includes(extname(name).toLowerCase()));
      metadata.scripts = scripts.map(name => rel(layout.rootPath, join(dirname(source), name)));
      try { const marker = JSON.parse(await readFile(join(dirname(source), '.research-workbench-figure.json'), 'utf8')); if (marker.publication) metadata.scripts = []; for (const path of marker.sourceSnapshots || []) if (typeof path === 'string' && await exists(await this.safe(projectId, path))) metadata.scripts.push(path); metadata.figureDirectory = rel(layout.rootPath, dirname(source)); } catch (error) { if (error instanceof StoreError) throw error; }
      metadata.scripts = [...new Set(metadata.scripts)];
      metadata.bundleHashes = {};
      for (const path of [...Object.values(metadata.formats), ...metadata.scripts]) metadata.bundleHashes[path] = await fileHash(await this.safe(projectId, path));
      metadata.missing = [...['png', 'svg', 'pdf'].filter(format => !metadata.formats[format]), ...(metadata.scripts.length ? [] : ['source'])];
    }
    if (existing?.sha256 === checksum) { const previous = JSON.parse(existing.metadata); if ((kind !== 'figure' || stable({ ...previous, sourceMtimeMs: 0 }) === stable({ ...metadata, sourceMtimeMs: 0 })) && existing.kind === kind && existing.encoding === (editable || kind === 'data' && ['.csv', '.tsv'].includes(extension) ? 'utf8' : 'binary')) { if (stable(previous) !== stable(metadata)) this.store.db.prepare('UPDATE objects SET metadata=? WHERE id=?').run(JSON.stringify(metadata), existing.id); return existing.id; } }
    const compactWord=kind==='manuscript'&&extension==='.docx'&&prior.wordEditable===true;
    if(compactWord)metadata.wordStorageMode='single-copy';
    const paths = await this.allocate(projectId, { objectId, kind, title: basename(source), extension, revision, metadata,versioned:!compactWord });
    // Original datasets remain read-only and are never rewritten or copied as derived output.
    const versionPath = kind === 'data'||compactWord ? canonical : paths.version;
    if (kind !== 'data'&&!compactWord) { await copyFile(source, paths.versionPath); check(await fileHash(paths.versionPath) === checksum, 'EXTERNAL_CHANGE', '导入期间文件有变化，请重试。', 409); }
    const stamp = new Date().toISOString(), encoding = editable || kind === 'data' && ['.csv', '.tsv'].includes(extension) ? 'utf8' : 'binary';
    if (existing) this.store.db.prepare('UPDATE objects SET kind=?,revision=?,path=?,sha256=?,encoding=?,metadata=?,updated_at=? WHERE id=?').run(kind, revision, versionPath, checksum, encoding, JSON.stringify(metadata), stamp, objectId);
    else this.store.db.prepare('INSERT INTO objects VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(objectId, projectId, kind, basename(source), revision, versionPath, checksum, encoding, JSON.stringify(metadata), stamp, stamp);
    if(compactWord&&prior.wordStorageMode==='single-copy')this.store.db.prepare('UPDATE object_versions SET revision=?,path=?,sha256=?,encoding=?,metadata=?,created_at=? WHERE object_id=? AND project_id=? AND revision=?').run(revision,versionPath,checksum,encoding,JSON.stringify(metadata),stamp,objectId,projectId,existing.revision);
    else this.store.db.prepare('INSERT INTO object_versions VALUES(?,?,?,?,?,?,?,?)').run(objectId, projectId, revision, versionPath, checksum, encoding, JSON.stringify(metadata), stamp);
    this.store.db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(stamp, projectId);
    return objectId;
  }
  async restoreWordWorkingCopy(projectId,objectId){
    const row=this.store.object(projectId,objectId),metadata=JSON.parse(row.metadata);
    check(row.kind==='manuscript'&&row.encoding==='binary'&&metadata.wordEditable&&/\.docx$/i.test(metadata.workspaceFile||''),'INVALID_WORD','请选择已编辑的 Word 工作副本。');
    const destination=await this.safe(projectId,metadata.workspaceFile);
    if(await exists(destination))return row.id;
    const candidates=[row.path,...this.store.db.prepare('SELECT path FROM object_versions WHERE project_id=? AND object_id=? AND sha256=? ORDER BY revision DESC').all(projectId,objectId,row.sha256).map(item=>item.path),metadata.wordOriginalFile].filter(Boolean);
    let bytes=null;
    for(const candidate of new Set(candidates)){
      const path=await this.safe(projectId,candidate);
      try{if((await stat(path)).size<=32*1024*1024){const data=await readFile(path);if(hash(data)===row.sha256){bytes=data;break}}}catch(error){if(error.code!=='ENOENT')throw error}
    }
    if(!bytes){
      const repository=await this.safe(projectId,join('.research-workbench','git',objectId+'.git'));
      if(await exists(repository)){
        const head=await this.store.documentHistory.head(repository);
        if(head){const data=await this.store.documentHistory.bytes(projectId,objectId,head);if(hash(data)===row.sha256)bytes=data}
      }
    }
    check(bytes,'WORD_WORKING_COPY_MISSING','工作副本已移动或删除，未找到与当前版本一致的备份。请恢复该文件，或将原稿另存为新文稿后导入。',409);
    await mkdir(dirname(destination),{recursive:true});
    // Create only a missing derived copy; never overwrite a file or roll back to an older hash.
    const handle=await open(destination,'wx');try{await handle.writeFile(bytes)}finally{await handle.close()}
    this.store.fileRollbacks?.push(async()=>{if(await exists(destination)&&await fileHash(destination)===row.sha256)await unlink(destination)});
    const restored={...metadata,bytes:bytes.length,sourceMtimeMs:(await stat(destination)).mtimeMs};
    this.store.db.prepare('UPDATE objects SET metadata=? WHERE id=? AND project_id=?').run(JSON.stringify(restored),objectId,projectId);
    return row.id;
  }
}
