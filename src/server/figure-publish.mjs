import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { join, basename, extname, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { StoreError } from './store.mjs';
import { fileHash } from './workspace-files.mjs';

const check = (ok, code, message) => { if (!ok) throw new StoreError(code, message, 409); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Publish, without executing, an already produced script + PNG/SVG/PDF bundle. */
export async function publishFigure(store, { projectId, title, script, png, svg, pdf, objectId, expectedRevision }) {
  const layout = await store.workspaceFiles.layout(projectId), sources = {};
  for (const [format, path] of Object.entries({ script, png, svg, pdf })) {
    check(typeof path === 'string' && path.replace(/\\/g, '/').toLowerCase().startsWith(layout.directories.temp.toLowerCase() + '/'), 'FIGURE_BUNDLE_REQUIRED', '新图必须提供当前工作区 temp 内的制作脚本、PNG、SVG、PDF 四个文件。');
    const resolved = await store.projectPath(projectId, path); check((await stat(resolved)).size <= 32 * 1024 * 1024, 'CONTENT_TOO_LARGE', '单个图表文件上限为 32 MiB。'); sources[format] = await readFile(resolved);
  }
  check(['.py', '.r'].includes(extname(script).toLowerCase()), 'FIGURE_BUNDLE_REQUIRED', '制作脚本需为 Python 或 R 源码。');
  check(sources.png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && /<svg\b/i.test(sources.svg.subarray(0, 8192).toString()) && sources.pdf.subarray(0, 5).toString() === '%PDF-', 'INVALID_FIGURE_FORMAT', '图表格式不完整；不会用占位文件代替真实 PNG/SVG/PDF。');
  return store.write(() => store.transaction(async () => {
    const existing = objectId ? store.object(projectId, objectId) : null;
    check(!existing || existing.kind === 'figure' && existing.revision === expectedRevision, 'VERSION_CONFLICT', '图表已有新版本，未覆盖。');
    const id = existing?.id || `o_${randomUUID()}`, revision = existing ? existing.revision + 1 : 1, previous = existing ? JSON.parse(existing.metadata) : {}, stamp = new Date().toISOString();
    const name = String(title || existing?.title || 'Figure').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 80) || 'Figure';
    const folder = previous.figureDirectory || join(layout.directories.picture, `${name}-${id.slice(-8)}`).replace(/\\/g, '/');
    check(folder.startsWith(layout.directories.picture + '/') && !folder.split('/').includes('_versions'), 'WORKSPACE_ROLE_MISMATCH', '图表必须保存在 picture 的独立子目录。');
    for (const [path, expected] of Object.entries(previous.bundleHashes || {})) check(await fileHash(await store.projectPath(projectId, path)) === expected, 'EXTERNAL_CHANGE', '图或脚本在外部已有修改，请重新扫描工作区后核对。');
    const versionFolder = join(folder, '_versions', `v${String(revision).padStart(4, '0')}-${randomUUID()}`), files = {}, bundleHashes = {};
    const names = { script: 'plot' + extname(script).toLowerCase(), png: 'figure.png', svg: 'figure.svg', pdf: 'figure.pdf' };
    for (const format of Object.keys(sources)) {
      const version = join(versionFolder, names[format]).replace(/\\/g, '/'), immutable = await store.projectPath(projectId, version); await mkdir(dirname(immutable), { recursive: true }); await writeFile(immutable, sources[format], { flag: 'wx' });
      const working = join(folder, names[format]).replace(/\\/g, '/'); await store.workspaceFiles.publish(projectId, working, sources[format], previous.bundleHashes?.[working] || null); files[format] = working; bundleHashes[working] = hash(sources[format]);
    }
    const metadata = { ...previous, figureDirectory: folder, workspaceFile: files.png, workspaceReadOnly: true, mimeType: 'image/png', bytes: sources.png.length, formats: { png: files.png, svg: files.svg, pdf: files.pdf }, scripts: [files.script], bundleHashes, missing: [], sourceMtimeMs: (await stat(await store.projectPath(projectId, files.png))).mtimeMs };
    const markerFile = join(folder, '.research-workbench-figure.json').replace(/\\/g, '/');
    const markerPath = await store.projectPath(projectId, markerFile);
    let markerHash = null;
    try { markerHash = await fileHash(markerPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await store.workspaceFiles.publish(projectId, markerFile, Buffer.from(JSON.stringify({ schemaVersion: 1, publication: true, title: name, primaryStem: 'figure', formats: metadata.formats, sourceSnapshots: [files.script], missing: [] }, null, 2)), markerHash);
    const versionPath = join(versionFolder, names.png).replace(/\\/g, '/'), checksum = hash(sources.png);
    if (existing) store.db.prepare('UPDATE objects SET title=?,revision=?,path=?,sha256=?,metadata=?,updated_at=? WHERE id=?').run(name, revision, versionPath, checksum, JSON.stringify(metadata), stamp, id);
    else store.db.prepare('INSERT INTO objects VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, projectId, 'figure', name, revision, versionPath, checksum, 'binary', JSON.stringify(metadata), stamp, stamp);
    store.db.prepare('INSERT INTO object_versions VALUES(?,?,?,?,?,?,?,?)').run(id, projectId, revision, versionPath, checksum, 'binary', JSON.stringify(metadata), stamp);
    store.db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(stamp, projectId);
    return id;
  }));
}
