import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, copyFileSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile, realpath, stat, readdir } from 'node:fs/promises';
import { resolve, relative, join, isAbsolute, dirname, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TASKS, defaultTaskState, normalizeLayout } from '../shared/model.mjs';
import { WorkspaceFiles, fileHash, MIME } from './workspace-files.mjs';
import { DocumentHistory } from './document-history.mjs';

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${randomUUID()}`;
const json = (value) => JSON.stringify(value);
const parse = (value) => JSON.parse(value);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const TEXT_KINDS = ['manuscript', 'note', 'data', 'evidence'];
export class StoreError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
function assert(condition, code, message, status) { if (!condition) throw new StoreError(code, message, status); }
function bounded(value, name, max, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  assert(typeof value === 'string' && value.length <= max, 'INVALID_INPUT', `${name}格式或长度不正确。`);
  return value;
}
function within(root, path) { const rel = relative(root, path); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); }
function physicalCandidate(path) {
  const missing = [];
  let ancestor = path;
  while (!existsSync(ancestor)) { const parent = dirname(ancestor); assert(parent !== ancestor, 'INVALID_PATH', '保存位置不可访问。'); missing.unshift(basename(ancestor)); ancestor = parent; }
  return join(realpathSync(ancestor), ...missing);
}
function key(value, prefix) { assert(typeof value === 'string' && new RegExp(`^${prefix}_[a-f0-9-]{36}$`).test(value), 'INVALID_ID', '资料身份不正确。'); return value; }

/** SQLite owns identities and the current version pointer; immutable files own content. */
export class ProjectStore {
  constructor({ root, sampleRoot, forbiddenRoot = fileURLToPath(new URL('../../../dsh-splitview', import.meta.url)) }) {
    this.root = resolve(root);
    this.forbiddenRoot = physicalCandidate(resolve(forbiddenRoot));
    assert(!within(this.forbiddenRoot, physicalCandidate(this.root)), 'FORBIDDEN_ROOT', '科研资料不能写入现有 dsh-splitview。');
    this.sampleRoot = sampleRoot;
    mkdirSync(this.root, { recursive: true });
    mkdirSync(join(this.root, 'projects'), { recursive: true });
    const databasePath = join(this.root, 'workbench.sqlite');
    this.db = new DatabaseSync(databasePath);
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) { this.db.close(); throw new StoreError('NEWER_SCHEMA', '资料库版本高于当前插件，请使用匹配版本打开。', 409); }
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=4000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    if (version === 0) {
      if (existsSync(databasePath) && this.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n) {
        this.db.close(); copyFileSync(databasePath, databasePath + `.pre-migration-${Date.now()}.bak`);
        throw new StoreError('UNKNOWN_SCHEMA', '发现未识别的数据结构，已保留备份，未执行迁移。', 409);
      }
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE projects(id TEXT PRIMARY KEY,title TEXT NOT NULL,question TEXT NOT NULL,journal TEXT NOT NULL,language TEXT NOT NULL,is_demo INTEGER NOT NULL DEFAULT 0,active_task TEXT NOT NULL,root_path TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE preferences(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE task_states(project_id TEXT NOT NULL REFERENCES projects(id),task TEXT NOT NULL,revision INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(project_id,task));
        CREATE TABLE objects(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),kind TEXT NOT NULL,title TEXT NOT NULL,revision INTEGER NOT NULL,path TEXT NOT NULL,sha256 TEXT NOT NULL,encoding TEXT NOT NULL,metadata TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE object_versions(object_id TEXT NOT NULL REFERENCES objects(id),project_id TEXT NOT NULL,revision INTEGER NOT NULL,path TEXT NOT NULL,sha256 TEXT NOT NULL,encoding TEXT NOT NULL,metadata TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(object_id,revision));
        CREATE TABLE bindings(project_id TEXT NOT NULL REFERENCES projects(id),task TEXT NOT NULL,session_id TEXT NOT NULL UNIQUE,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,task));
        CREATE TABLE dependencies(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),source_id TEXT NOT NULL REFERENCES objects(id),target_id TEXT NOT NULL REFERENCES objects(id),source_revision INTEGER NOT NULL,kind TEXT NOT NULL,UNIQUE(project_id,source_id,target_id,kind));
        CREATE TABLE jobs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),type TEXT NOT NULL,status TEXT NOT NULL,phase TEXT NOT NULL,input TEXT NOT NULL,output TEXT,error TEXT,operation_key TEXT NOT NULL,parent_job_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(project_id,operation_key));
        PRAGMA user_version=1; COMMIT;`);
    }
    this.workspaceFiles = new WorkspaceFiles(this);
    this.documentHistory = new DocumentHistory(this);
    this.fileRollbacks = null;
    this.tail = Promise.resolve();
    this.closed = false;
  }
  write(operation) {
    const next = this.tail.then(async () => { assert(!this.closed, 'CLOSED', '项目资料服务已关闭。', 503); const before=this.db.prepare('SELECT total_changes() value').get().value;const result = await operation(); if(this.db.prepare('SELECT total_changes() value').get().value!==before||this.workspaceFiles.errors.size)await this.workspaceFiles.checkpointAll(); return result; });
    this.tail = next.catch(() => {});
    return next;
  }
  async transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    this.fileRollbacks = [];
    try { const result = await operation(); this.db.exec('COMMIT'); this.fileRollbacks = null; return result; }
    catch (error) { this.db.exec('ROLLBACK'); for (const undo of this.fileRollbacks.reverse()) await undo().catch(() => {}); this.fileRollbacks = null; throw error; }
  }
  project(projectId) {
    key(projectId, 'p');
    const row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
    assert(row, 'PROJECT_NOT_FOUND', '该论文项目不存在。', 404);
    assert(!this.db.prepare('SELECT 1 FROM preferences WHERE key=?').get(`removedProject:${projectId}`), 'PROJECT_REMOVED', '项目已从列表删除，可通过原工作区目录重新打开。', 404);
    return row;
  }
  projectRows(){return this.db.prepare("SELECT p.* FROM projects p WHERE NOT EXISTS (SELECT 1 FROM preferences WHERE key='removedProject:'||p.id) ORDER BY p.created_at,p.id").all()}
  async removeProject({projectId}){
    return this.write(()=>this.transaction(async()=>{
      const project=this.project(projectId);
      assert(!this.db.prepare("SELECT 1 FROM jobs WHERE project_id=? AND status IN ('queued','running') LIMIT 1").get(projectId),'PROJECT_BUSY','项目还有正在处理的任务，请先完成或取消后再删除。',409);
      await this.workspaceFiles.checkpointAll();
      assert(!this.workspaceFiles.errors.has(projectId),'CHECKPOINT_FAILED','项目状态尚未同步，请先修复工作区后再删除。',409);
      this.db.prepare('INSERT INTO preferences(key,value) VALUES(?,?)').run(`removedProject:${projectId}`,json({removedAt:now(),title:project.title}));
      if(this.db.prepare("SELECT value FROM preferences WHERE key='activeProjectId'").get()?.value===projectId){
        const next=this.projectRows()[0]?.id;
        if(next)this.db.prepare("UPDATE preferences SET value=? WHERE key='activeProjectId'").run(next);
        else this.db.prepare("DELETE FROM preferences WHERE key='activeProjectId'").run();
      }
      this.workspaceFiles.errors.delete(projectId);
    }));
  }
  object(projectId, objectId) {
    this.project(projectId); key(objectId, 'o');
    const row = this.db.prepare('SELECT * FROM objects WHERE id=? AND project_id=?').get(objectId, projectId);
    assert(row, 'OBJECT_NOT_FOUND', '该资料不属于当前论文项目。', 404);
    return row;
  }
  async projectPath(projectId, rel) {
    const owner = this.project(projectId);
    const root = resolve(owner.root_path);
    const path = resolve(root, rel);
    assert(within(root, path), 'PATH_OUTSIDE_PROJECT', '资料路径超出当前项目。');
    // Existing symlinks/junctions cannot redirect an asset to another project.
    const physicalRoot = await realpath(root);
    const physical = physicalCandidate(path);
    assert(within(physicalRoot, physical), 'PATH_OUTSIDE_PROJECT', '资料链接指向项目外部。');
    return path;
  }
  async bytesFor(row) { return readFile(await this.projectPath(row.project_id, row.path)); }
  async state() {
    await this.tail;
    const projects = [];
    for (const row of this.projectRows()) {
      try { await this.workspaceFiles.ensure(row.root_path); } catch (error) { this.workspaceFiles.errors.set(row.id, error.message); }
      const objects = [];
      for (const item of this.db.prepare('SELECT * FROM objects WHERE project_id=? ORDER BY created_at,rowid').all(row.id)) {
        let text = '', contentError = null;
        const metadata = parse(item.metadata);
        if (item.kind === 'figure' && item.encoding === 'binary' && !metadata.mimeType) metadata.mimeType = 'image/png';
        try {
          if (item.encoding === 'utf8') { if (metadata.preview !== undefined) text = metadata.preview; else { const bytes = await this.bytesFor(item); assert(hash(bytes) === item.sha256, 'CONTENT_CHANGED', '文件在工作台外发生变化，原版本仍保留。', 409); text = bytes.toString('utf8'); } }
          if (metadata.workspaceFile) {
            const working = await this.projectPath(row.id, metadata.workspaceFile), details = await stat(working);
            assert(metadata.bytes === undefined || details.size === metadata.bytes, 'EXTERNAL_CHANGE', '工作区文件在外部更新，请重新扫描后核对。', 409);
            if (item.encoding === 'utf8' && metadata.preview === undefined) assert(await fileHash(working) === item.sha256, 'EXTERNAL_CHANGE', '工作区正文在外部更新，请重新扫描后核对。', 409);
            else if (metadata.sourceMtimeMs) assert(Math.abs(details.mtimeMs - metadata.sourceMtimeMs) < 2, 'EXTERNAL_CHANGE', '工作区文件在外部更新，请重新扫描后核对。', 409);
            if (item.kind === 'data' && metadata.preview) text = metadata.preview;
          }
        } catch (error) { contentError = error instanceof StoreError ? error.message : '资料文件暂时不可读取，原记录仍保留。'; }
        objects.push({ id: item.id, projectId: row.id, kind: item.kind, title: item.title, revision: item.revision, sha256: item.sha256, encoding: item.encoding, text, contentError, metadata, createdAt: item.created_at, updatedAt: item.updated_at });
      }
      projects.push({ id: row.id, title: row.title, question: row.question, journal: row.journal, language: row.language, isDemo: Boolean(row.is_demo), activeTask: row.active_task, rootPath: row.root_path, workspace: { ...this.workspaceFiles.layouts.get(resolve(row.root_path)), checkpointError: this.workspaceFiles.errors.get(row.id) || null }, createdAt: row.created_at, updatedAt: row.updated_at, objects,
        taskStates: Object.fromEntries(this.db.prepare('SELECT * FROM task_states WHERE project_id=?').all(row.id).map((task) => [task.task, { revision: task.revision, value: parse(task.value) }])),
        bindings: Object.fromEntries(this.db.prepare('SELECT * FROM bindings WHERE project_id=?').all(row.id).map((binding) => [binding.task, binding.session_id])),
        dependencies: this.db.prepare('SELECT * FROM dependencies WHERE project_id=?').all(row.id).map((edge) => ({ id: edge.id, sourceId: edge.source_id, targetId: edge.target_id, sourceRevision: edge.source_revision, kind: edge.kind })),
        jobs: this.db.prepare("SELECT * FROM jobs WHERE project_id=? AND (id IN (SELECT id FROM jobs WHERE project_id=? ORDER BY created_at DESC LIMIT 50) OR id IN (SELECT json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END,'$.jobId') FROM preferences WHERE key=? OR key LIKE ? OR key LIKE ?) OR id=(SELECT json_extract(value,'$.sentenceJobId') FROM task_states WHERE project_id=? AND task='writing')) ORDER BY created_at DESC").all(row.id,row.id,`sentenceThread:${row.id}`,`sentenceThread:${row.id}:%`,`formatThread:${row.id}:%`,row.id).map((job) => this.publicJob(job)) });
    }
    const active = this.db.prepare("SELECT value FROM preferences WHERE key='activeProjectId'").get()?.value;
    return { schemaVersion: 1, defaultProjectDirectory: join(this.root, 'projects'), activeProjectId: projects.some((p) => p.id === active) ? active : projects[0]?.id || null, projects };
  }
  async createProject(args = {}) {
    const title = bounded(args.title, '项目名称', 120).trim();
    assert(title, 'INVALID_TITLE', '请填写项目名称。');
    const question = bounded(args.question, '研究问题', 10000, '');
    const journal = bounded(args.journal, '目标期刊', 200, '');
    const language = args.language || 'zh'; assert(['zh', 'en'].includes(language), 'INVALID_LANGUAGE', '稿件语言不正确。');
    const chosen = bounded(args.directory, '保存位置', 2048, '').trim();
    const explicitRoot = bounded(args.workspacePath, '项目目录', 2048, '').trim();
    assert(!explicitRoot || isAbsolute(explicitRoot), 'ABSOLUTE_PATH_REQUIRED', '项目目录应为绝对路径。');
    if (explicitRoot) assert(!within(this.forbiddenRoot, physicalCandidate(resolve(explicitRoot))), 'FORBIDDEN_ROOT', '项目不能保存在既有 dsh-splitview。');
    assert(!chosen || isAbsolute(chosen), 'ABSOLUTE_PATH_REQUIRED', '保存位置应为本机绝对路径。');
    const parent = chosen ? resolve(chosen) : join(this.root, 'projects');
    assert(!within(this.forbiddenRoot, physicalCandidate(parent)), 'FORBIDDEN_ROOT', '科研项目不能保存到现有 dsh-splitview。');
    return this.write(() => this.transaction(async () => {
      const projectId = id('p'), stamp = now(), rootPath = explicitRoot ? resolve(explicitRoot) : join(parent, projectId);
      assert(!this.db.prepare('SELECT 1 FROM projects WHERE root_path=?').get(rootPath), 'WORKSPACE_ALREADY_OPEN', '该目录已关联论文项目，请打开已有工作区。', 409);
      if (explicitRoot && existsSync(rootPath)) assert(!(await readdir(rootPath)).length, 'WORKSPACE_EXISTS', '目录已有内容，请使用“打开已有工作区”。', 409);
      await mkdir(rootPath, { recursive: true });
      await this.workspaceFiles.ensure(rootPath);
      this.db.prepare('INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?,?)').run(projectId, title, question, journal, language, args.isDemo ? 1 : 0, 'writing', rootPath, stamp, stamp);
      for (const task of TASKS) this.db.prepare('INSERT INTO task_states VALUES(?,?,?,?)').run(projectId, task, 1, json(defaultTaskState(task)));
      this.db.prepare("INSERT INTO preferences VALUES('activeProjectId',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(projectId);
      await this.insertObject(projectId, { kind: 'manuscript', title: '论文主稿', text: `# ${title}\n\n` });
      return projectId;
    }));
  }
  async openWorkspace({ path, title }) {
    bounded(path, '工作区路径', 2048); assert(isAbsolute(path), 'ABSOLUTE_PATH_REQUIRED', '请选择论文工作区的绝对路径。');
    const rootPath = physicalCandidate(resolve(path));
    assert(rootPath !== dirname(rootPath) && !within(this.forbiddenRoot, rootPath), 'FORBIDDEN_ROOT', '工作区不能是磁盘根目录或既有 dsh-splitview。');
    await this.workspaceFiles.ensure(rootPath);
    return this.write(() => this.transaction(async () => {
      const existing = this.db.prepare('SELECT id,root_path FROM projects').all().find(p => resolve(p.root_path).toLowerCase() === rootPath.toLowerCase());
      let projectId = existing?.id;
      if(projectId)this.db.prepare('DELETE FROM preferences WHERE key=?').run(`removedProject:${projectId}`);
      if (!projectId) {
        const checkpointPath = join(rootPath, '.research-workbench', 'project.json');
        if (existsSync(checkpointPath)) {
          assert((await stat(checkpointPath)).size <= 32 * 1024 * 1024, 'WORKSPACE_MANIFEST_TOO_LARGE', '工作区状态文件过大，未覆盖。');
          const checkpoint = parse(await readFile(checkpointPath, 'utf8'));
          assert(checkpoint.schemaVersion === 1 && checkpoint.project && Array.isArray(checkpoint.objects), 'INVALID_WORKSPACE', '工作区状态文件不完整，原件保留。');
          projectId = key(checkpoint.project.id, 'p');
          assert(!this.db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId), 'WORKSPACE_ID_ALREADY_OPEN', '相同身份已在另一目录打开，请使用原工作区。', 409);
          const oldRoot = resolve(checkpoint.project.root_path).toLowerCase(), sameRoot = oldRoot === rootPath.toLowerCase();
          const project = { ...checkpoint.project, root_path: rootPath };
          const tables = {
            projects: { rows: [project], columns: ['id','title','question','journal','language','is_demo','active_task','root_path','created_at','updated_at'] },
            objects: { rows: checkpoint.objects, columns: ['id','project_id','kind','title','revision','path','sha256','encoding','metadata','created_at','updated_at'] },
            object_versions: { rows: checkpoint.versions, columns: ['object_id','project_id','revision','path','sha256','encoding','metadata','created_at'] },
            task_states: { rows: checkpoint.tasks, columns: ['project_id','task','revision','value'] },
            bindings: { rows: sameRoot ? checkpoint.bindings : [], columns: ['project_id','task','session_id','updated_at'] },
            dependencies: { rows: checkpoint.dependencies, columns: ['id','project_id','source_id','target_id','source_revision','kind'] },
            jobs: { rows: (checkpoint.jobs || []).map(row => { if (sameRoot || !['writing.sentence','word.format'].includes(row.type)) return row; const input = parse(row.input); delete input.nativeSessionId; return { ...row, input: json(input) }; }), columns: ['id','project_id','type','status','phase','input','output','error','operation_key','parent_job_id','created_at','updated_at'] },
          };
          for (const [table, { rows, columns }] of Object.entries(tables)) {
            assert(Array.isArray(rows) && rows.length <= 10000, 'INVALID_WORKSPACE', '工作区记录数量或结构无效。');
            for (const row of rows) {
              assert(table === 'projects' || row.project_id === projectId, 'INVALID_WORKSPACE', '工作区记录引用了其他论文项目。');
              if (row.path) assert(!isAbsolute(row.path) && !row.path.split(/[\\/]/).some(part => part === '..' || part === '.git'), 'PATH_OUTSIDE_PROJECT', '工作区记录存在越界路径。');
              this.db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map(column => row[column] ?? null));
            }
          }
          if (sameRoot && checkpoint.thread) this.db.prepare('INSERT INTO preferences VALUES(?,?)').run(`sentenceThread:${projectId}`, checkpoint.thread);
          if(sameRoot&&checkpoint.conversationState){
            assert(Array.isArray(checkpoint.conversationState)&&checkpoint.conversationState.length<=10000,'INVALID_WORKSPACE','文稿对话关联数量无效。');
            for(const record of checkpoint.conversationState){
              const value=parse(record.value),isThread=record.key===`sentenceThread:${projectId}:${value.objectId}`||record.key===`formatThread:${projectId}:${value.objectId}`,isOwner=/^sentenceSession:session-[a-f0-9-]{36}$/.test(record.key)&&value.projectId===projectId;
              assert((isThread||isOwner)&&this.db.prepare('SELECT 1 FROM objects WHERE project_id=? AND id=?').get(projectId,value.objectId),'INVALID_WORKSPACE','文稿对话归属无效。');
              this.db.prepare('INSERT INTO preferences VALUES(?,?)').run(record.key,record.value);
            }
          }
        } else {
          projectId = id('p'); const stamp = now(), name = bounded(title, '项目名称', 120, basename(rootPath)).trim();
          this.db.prepare('INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?,?)').run(projectId, name, '', '', 'zh', 0, 'writing', rootPath, stamp, stamp);
          for (const task of TASKS) this.db.prepare('INSERT INTO task_states VALUES(?,?,?,?)').run(projectId, task, 1, json(defaultTaskState(task)));
        }
      }
      await this.scanWorkspaceFiles(projectId);
      this.db.prepare("INSERT INTO preferences VALUES('activeProjectId',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(projectId);
      return projectId;
    }));
  }
  async scanWorkspaceFiles(projectId) {
    for (const file of await this.workspaceFiles.discover(projectId)) await this.workspaceFiles.attach(projectId, file.relativePath);
    let manuscript = this.db.prepare("SELECT * FROM objects WHERE project_id=? AND kind='manuscript' ORDER BY (encoding='utf8') DESC,updated_at DESC LIMIT 1").get(projectId);
    if (!manuscript) { await this.insertObject(projectId, { kind: 'manuscript', title: '论文主稿', text: `# ${this.project(projectId).title}\n\n` }); manuscript = this.db.prepare("SELECT * FROM objects WHERE project_id=? AND kind='manuscript' LIMIT 1").get(projectId); }
    for (const [task, kind] of [['writing','manuscript'],['figure','data'],['reading','evidence']]) {
      const row = this.db.prepare('SELECT value FROM task_states WHERE project_id=? AND task=?').get(projectId, task), value = parse(row.value);
      if (!value.selectedObjectId) { const selected = task === 'writing' ? manuscript : this.db.prepare('SELECT id FROM objects WHERE project_id=? AND kind=? ORDER BY created_at LIMIT 1').get(projectId, kind); value.selectedObjectId = selected?.id || null; this.db.prepare('UPDATE task_states SET value=?,revision=revision+1 WHERE project_id=? AND task=?').run(json(value), projectId, task); }
    }
  }
  async refreshWorkspace({ projectId }) { return this.write(() => this.transaction(() => this.scanWorkspaceFiles(projectId))); }
  async importWorkspaceFile({ projectId, path, openOriginal=false }) { assert(typeof openOriginal==='boolean','INVALID_INPUT','原稿打开选项不正确。');return this.write(() => this.transaction(async () => { await this.workspaceFiles.list(projectId, dirname(path)); return this.workspaceFiles.attach(projectId, path,{openOriginal}); })); }
  async restoreWordWorkingCopy({projectId,objectId}){return this.write(()=>this.transaction(()=>this.workspaceFiles.restoreWordWorkingCopy(projectId,objectId)))}
  async insertObject(projectId, { kind, title, text = '', bytes, metadata = {} }) {
    this.project(projectId);
    assert([...TEXT_KINDS, 'figure'].includes(kind), 'INVALID_KIND', '资料类型不正确。');
    bounded(title, '资料名称', 200);
    assert(bytes || typeof text === 'string', 'INVALID_CONTENT', '资料内容应为文本。');
    const content = bytes || Buffer.from(text, 'utf8');
    assert(content.length <= 8 * 1024 * 1024, 'CONTENT_TOO_LARGE', '资料超过当前保存上限。', 413);
    const objectId = id('o'), stamp = now(), encoding = bytes ? 'binary' : 'utf8';
    const paths = await this.workspaceFiles.allocate(projectId, { objectId, kind, title, revision: 1, metadata });
    await writeFile(paths.versionPath, content, { flag: 'wx' });
    await this.workspaceFiles.publish(projectId, paths.working, content);
    const sha256 = hash(content), rel = paths.version;
    const meta = json({ ...metadata, workspaceManaged: true, workspaceReadOnly: Boolean(bytes), workspaceFile: paths.working, bytes: content.length, mimeType: bytes ? 'image/png' : kind === 'data' ? MIME['.csv'] : MIME['.md'] });
    this.db.prepare('INSERT INTO objects VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(objectId, projectId, kind, title, 1, rel, sha256, encoding, meta, stamp, stamp);
    this.db.prepare('INSERT INTO object_versions VALUES(?,?,?,?,?,?,?,?)').run(objectId, projectId, 1, rel, sha256, encoding, meta, stamp);
    this.db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(stamp, projectId);
    return objectId;
  }
  async createObject(args) {
    assert(TEXT_KINDS.includes(args.kind), 'INVALID_KIND', '此入口只接收稿件、笔记、数据文本或证据。');
    bounded(args.text, '资料内容', 1024 * 1024, '');
    return this.write(() => this.transaction(() => this.insertObject(args.projectId, args)));
  }
  async saveObject({ projectId, objectId, expectedRevision, text }, { beforeSave, afterSave, historyAction, restoredFrom } = {}) {
    bounded(text, '资料内容', 1024 * 1024);
    assert(Number.isInteger(expectedRevision) && expectedRevision > 0, 'REVISION_REQUIRED', '保存资料必须带上原版本。');
    return this.write(() => this.transaction(async () => {
      const object = this.object(projectId, objectId);
      beforeSave?.(object);
      assert(object.revision === expectedRevision, 'VERSION_CONFLICT', '资料已有新版本，当前输入仍保留；请核对后再保存。', 409);
      assert(object.encoding === 'utf8', 'BINARY_CONTENT', '此原始或二进制资料不能直接覆盖，请另存派生文件。');
      assert(!parse(object.metadata).workspaceReadOnly, 'READ_ONLY_SOURCE', '原始资料只读，请另存派生文件。', 409);
      assert(hash(await this.bytesFor(object)) === object.sha256, 'EXTERNAL_CHANGE', '原文件已在工作台外变化，请保留当前输入并单独导入新版本。', 409);
      const content = Buffer.from(text, 'utf8'), sha256 = hash(content);
      if (object.kind === 'manuscript') await this.documentHistory.ensure(projectId, objectId);
      if (sha256 === object.sha256) { afterSave?.(object.revision); return object.revision; }
      const revision = object.revision + 1, stamp = now(), metadata = parse(object.metadata);
      assert(!metadata.workspaceReadOnly, 'READ_ONLY_SOURCE', '原始资料只读，请另存派生文件。', 409);
      const paths = await this.workspaceFiles.allocate(projectId, { objectId, kind: object.kind, title: object.title, revision, metadata });
      await writeFile(paths.versionPath, content, { flag: 'wx' });
      await this.workspaceFiles.publish(projectId, paths.working, content, metadata.workspaceFile ? object.sha256 : null);
      const nextMeta = json({ ...metadata, workspaceFile: paths.working, bytes: content.length });
      this.db.prepare('INSERT INTO object_versions VALUES(?,?,?,?,?,?,?,?)').run(objectId, projectId, revision, paths.version, sha256, 'utf8', nextMeta, stamp);
      this.db.prepare('UPDATE objects SET revision=?,path=?,sha256=?,metadata=?,updated_at=? WHERE id=? AND project_id=?').run(revision, paths.version, sha256, nextMeta, stamp, objectId, projectId);
      this.db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(stamp, projectId);
      afterSave?.(revision);
      if (object.kind === 'manuscript') await this.documentHistory.append(projectId, objectId, content, revision, { action: historyAction, restoredFrom });
      return revision;
    }));
  }
  async activateProject(projectId) {
    return this.write(() => { this.project(projectId); this.db.prepare("INSERT INTO preferences VALUES('activeProjectId',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(projectId); });
  }
  async updateProject({ projectId, patch }) {
    return this.write(() => {
      const row = this.project(projectId);
      assert(patch && typeof patch === 'object', 'INVALID_INPUT', '项目修改格式不正确。');
      const title = bounded(patch.title, '项目名称', 120, row.title).trim(); assert(title, 'INVALID_TITLE', '项目名称不能为空。');
      const question = bounded(patch.question, '研究问题', 10000, row.question), journal = bounded(patch.journal, '目标期刊', 200, row.journal);
      const task = patch.activeTask || row.active_task, language = patch.language || row.language;
      assert(TASKS.includes(task) && ['zh', 'en'].includes(language), 'INVALID_INPUT', '项目任务或语言不正确。');
      this.db.prepare('UPDATE projects SET title=?,question=?,journal=?,language=?,active_task=?,updated_at=? WHERE id=?').run(title, question, journal, language, task, now(), projectId);
    });
  }
  async saveTaskState({ projectId, task, patch, value, expectedRevision }) {
    assert(TASKS.includes(task), 'INVALID_TASK', '任务空间不正确。');
    return this.write(() => {
      this.project(projectId);
      const row = this.db.prepare('SELECT * FROM task_states WHERE project_id=? AND task=?').get(projectId, task);
      if (expectedRevision !== undefined) assert(expectedRevision === row.revision, 'VERSION_CONFLICT', '任务布局已有更新，请刷新后再调整。', 409);
      const changes = patch || value;
      assert(changes && typeof changes === 'object' && !Array.isArray(changes), 'INVALID_INPUT', '任务状态不正确。');
      const state = parse(row.value);
      if (changes.layout !== undefined) state.layout = normalizeLayout(changes.layout, task);
      if (changes.layoutEvent !== undefined) {
        const event = changes.layoutEvent;
        assert(changes.layout && event && typeof event.id === 'string' && /^[a-f0-9-]{36}$/.test(event.id) && ['pointer-drop', 'pointer-resize', 'keyboard-resize', 'menu-swap'].includes(event.kind) && typeof event.trusted === 'boolean', 'INVALID_INPUT', '布局操作记录不正确。');
        if (!(state.layoutEvents || []).some((item) => item.id === event.id)) state.layoutEvents = [...state.layoutEvents || [], { id: event.id, kind: event.kind, trusted: event.trusted, capturedAt: now() }].slice(-12);
      }
      if (changes.selectedObjectId !== undefined) { if (changes.selectedObjectId !== null) this.object(projectId, changes.selectedObjectId); state.selectedObjectId = changes.selectedObjectId; }
      for (const field of ['cursor', 'scrollTop']) if (changes[field] !== undefined) { assert(Number.isFinite(changes[field]) && changes[field] >= 0, 'INVALID_INPUT', '阅读或编辑位置不正确。'); state[field] = Math.min(1e8, changes[field]); }
      if (changes.editMode !== undefined) { assert(typeof changes.editMode === 'boolean', 'INVALID_INPUT', '编辑状态不正确。'); state.editMode = changes.editMode; }
      if (changes.wordViews !== undefined) { assert(changes.wordViews&&typeof changes.wordViews==='object'&&!Array.isArray(changes.wordViews)&&Object.keys(changes.wordViews).length<=30,'INVALID_INPUT','Word 阅读位置格式无效。'); for(const [objectId,segment]of Object.entries(changes.wordViews)){this.object(projectId,objectId);assert(Number.isInteger(segment)&&segment>=0&&segment<=1000,'INVALID_INPUT','Word 阅读分段无效。')} state.wordViews=changes.wordViews; }
      if (changes.sentenceJobId !== undefined) {
        if (changes.sentenceJobId !== null) { const job = this.db.prepare("SELECT input FROM jobs WHERE id=? AND project_id=? AND type='writing.sentence'").get(changes.sentenceJobId, projectId); assert(job && parse(job.input).native, 'REVISION_NOT_FOUND', '不能打开其他项目的选句会话。', 403); }
        state.sentenceJobId = changes.sentenceJobId;
      }
      this.db.prepare('UPDATE task_states SET revision=revision+1,value=? WHERE project_id=? AND task=?').run(json(state), projectId, task);
    });
  }
  async bindSession({ projectId, task, sessionId, replaceSessionId }) {
    assert(TASKS.includes(task) && typeof sessionId === 'string' && /^session-[a-f0-9-]{36}$/.test(sessionId), 'INVALID_BINDING', '原生会话绑定不正确。');
    return this.write(() => {
      this.project(projectId);
      const existing = this.db.prepare('SELECT * FROM bindings WHERE project_id=? AND task=?').get(projectId, task);
      if (existing && existing.session_id !== replaceSessionId) return existing.session_id;
      const occupied = this.db.prepare('SELECT * FROM bindings WHERE session_id=?').get(sessionId);
      assert(!occupied || occupied.project_id === projectId && occupied.task === task, 'SESSION_ALREADY_OWNED', '该会话已属于其他项目或任务。', 409);
      this.db.prepare('INSERT INTO bindings VALUES(?,?,?,?) ON CONFLICT(project_id,task) DO UPDATE SET session_id=excluded.session_id,updated_at=excluded.updated_at').run(projectId, task, sessionId, now());
      return sessionId;
    });
  }
  async addDependency({ projectId, sourceId, targetId, kind = 'supports' }) {
    assert(['supports', 'uses', 'illustrates', 'derived_from'].includes(kind), 'INVALID_RELATION', '依赖类型不正确。');
    return this.write(() => {
      const source = this.object(projectId, sourceId); this.object(projectId, targetId);
      assert(sourceId !== targetId, 'SELF_RELATION', '资料不能依赖自身。');
      this.db.prepare('INSERT INTO dependencies VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,source_id,target_id,kind) DO NOTHING').run(id('d'), projectId, sourceId, targetId, source.revision, kind);
    });
  }
  versions(projectId, objectId) {
    this.object(projectId, objectId);
    return this.db.prepare('SELECT revision,sha256,created_at FROM object_versions WHERE project_id=? AND object_id=? ORDER BY revision DESC').all(projectId, objectId).map((row) => ({ revision: row.revision, sha256: row.sha256, createdAt: row.created_at }));
  }
  async asset(projectId, objectId) {
    const row = this.object(projectId, objectId), bytes = await this.bytesFor(row);
    assert(hash(bytes) === row.sha256, 'CONTENT_CHANGED', '资源已在工作台外发生变化，原采用版本未被替换。', 409);
    return { bytes, contentType: parse(row.metadata).mimeType || (row.encoding === 'binary' ? row.kind === 'figure' ? 'image/png' : 'application/octet-stream' : 'text/plain; charset=utf-8'), sha256: row.sha256 };
  }
  async createDemo({ directory } = {}) {
    const projectId = await this.createProject({ title: '分组干预与时序响应', question: '不同分组的响应指标如何随时间变化，哪些描述能够由现有数据与图表支持？', journal: '目标期刊待定', language: 'zh', isDemo: true, directory });
    const content = '# 分组干预对时序响应的影响\n\n本文使用固定随机种子的合成实验数据，展示研究问题、数据、图表与正文之间的关联。所有数据仅用于工作台功能验证，不代表真实研究结论。\n\n## 1 研究问题\n\n不同分组的响应指标如何随测量时间变化？围绕组别与时间两个维度，先明确可回答的问题，再组织图表与正文证据。\n\n## 2 数据与研究设计\n\n实验包含对照组、处理 A 和处理 B。测量时间为第 0、7、14、21 天，每个组别与时间组合包含 6 个独立样本，共 72 条观测。响应指标以任意单位记录。\n\n统计汇总保留样本量、均值和样本标准差。图 1 与原始数据一起保存，后续采用到正文时保留各自的版本身份。\n\n## 3 论证与证据\n\n先判断现有数据能够支持哪些描述，再决定正文表达。图表、输入数据和稿件关联保存在项目中。\n\n- 数据来源：专用合成实验表。\n- 图表来源：已通过阶段零验证的 Matplotlib 绘图样例。\n- 当前用途：验证项目、任务空间与状态恢复。';
    const manuscript = this.db.prepare("SELECT id FROM objects WHERE project_id=? AND kind='manuscript'").get(projectId).id;
    await this.saveObject({ projectId, objectId: manuscript, expectedRevision: 1, text: content });
    const dataId = await this.createObject({ projectId, kind: 'data', title: 'experiment.csv', text: await readFile(join(this.sampleRoot, 'experiment.csv'), 'utf8') });
    const figureId = await this.write(() => this.transaction(async () => this.insertObject(projectId, { kind: 'figure', title: '图 1 · 时序响应', bytes: await readFile(join(this.sampleRoot, 'Figure1.png')), metadata: { caption: '合成响应随时间变化及第 21 天的组间分布。误差线为标准差。', sampleDescription: '3 个组别 × 4 个时间点 × 6 个独立样本，共 72 条合成观测。' } })));
    await this.createObject({ projectId, kind: 'note', title: '文献与证据笔记', text: '# 文献与证据笔记\n\n从当前研究问题出发，记录文献结论、适用条件与原文位置。\n\n本示例尚未关联真实论文。后续检索优先使用 Zotero 和本地已解析全文。' });
    await this.addDependency({ projectId, sourceId: dataId, targetId: figureId, kind: 'derived_from' });
    await this.addDependency({ projectId, sourceId: figureId, targetId: manuscript, kind: 'illustrates' });
    return projectId;
  }
  publicJob(row) { const input = ['writing.sentence','word.format'].includes(row.type) ? parse(row.input) : null; return { id: row.id, projectId: row.project_id, type: row.type, status: row.status, phase: row.phase, error: row.error, output: row.output ? parse(row.output) : null, createdAt: row.created_at, updatedAt: row.updated_at, parentJobId: row.parent_job_id, ...(input?.native ? { native: true,conversationKind:input.conversationKind||'revision', nativeSessionId: input.nativeSessionId || null, nativeThreadKey: input.nativeThreadKey || input.nativeSessionId || null, conversationOnly: Boolean(input.conversationOnly), objectId: input.objectId, original: input.selectedText, expectedRevision: input.expectedRevision, nativeEvidence: input.evidence || null } : {}) }; }
  async enqueueJob({ projectId, type, operationKey, parentJobId = null }) {
    assert(type === 'project.integrity', 'UNKNOWN_JOB', '当前处理器不支持这个任务。');
    bounded(operationKey, '操作标识', 160); assert(operationKey.trim(), 'INVALID_OPERATION', '操作标识不能为空。');
    return this.write(() => {
      this.project(projectId);
      const previous = this.db.prepare('SELECT id FROM jobs WHERE project_id=? AND operation_key=?').get(projectId, operationKey);
      if (previous) return previous.id;
      const input = this.db.prepare('SELECT id,revision,sha256,path FROM objects WHERE project_id=? ORDER BY id').all(projectId);
      const jobId = id('j'), stamp = now();
      this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(jobId, projectId, type, 'queued', '等待检查项目文件', json(input), null, null, operationKey, parentJobId, stamp, stamp);
      return jobId;
    });
  }
  async cancelJob({ projectId, jobId }) {
    return this.write(() => { this.project(projectId); key(jobId, 'j'); this.db.prepare("UPDATE jobs SET status='cancelled',phase='已取消',updated_at=? WHERE id=? AND project_id=? AND status IN ('queued','running')").run(now(), jobId, projectId); });
  }
  async retryJob({ projectId, jobId }) {
    this.project(projectId); key(jobId, 'j');
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=? AND project_id=?').get(jobId, projectId);
    assert(row && ['failed', 'interrupted', 'outdated', 'cancelled'].includes(row.status), 'NOT_RETRYABLE', '此任务当前不需要重试。', 409);
    return this.enqueueJob({ projectId, type: row.type, operationKey: `retry:${jobId}:${randomUUID()}`, parentJobId: jobId });
  }
  async recoverJobs() { return this.write(() => this.db.prepare("UPDATE jobs SET status='interrupted',phase='宿主退出后中断，可重试',updated_at=? WHERE status='running'").run(now())); }
  async claimJob(types = ['project.integrity']) {
    await this.tail;assert(!this.closed,'CLOSED','项目资料服务已关闭。',503);
    if(!this.db.prepare(`SELECT 1 FROM jobs WHERE status='queued' AND type IN (${types.map(()=>'?').join(',')}) LIMIT 1`).get(...types))return null;
    return this.write(() => {
      const row = this.db.prepare(`SELECT * FROM jobs WHERE status='queued' AND type IN (${types.map(() => '?').join(',')}) ORDER BY created_at,id LIMIT 1`).get(...types);
      if (!row) return null;
      this.db.prepare("UPDATE jobs SET status='running',phase='核对已保存版本与文件哈希',updated_at=? WHERE id=? AND status='queued'").run(now(), row.id);
      return row;
    });
  }
  async runJob(row, { beforeCommit } = {}) {
    try {
      const input = parse(row.input), checked = [];
      for (const expected of input) {
        const object = this.object(row.project_id, expected.id);
        const bytes = await readFile(await this.projectPath(row.project_id, expected.path));
        assert(hash(bytes) === expected.sha256, 'CONTENT_CHANGED', '发现外部修改或损坏文件，未覆盖原记录。', 409);
        checked.push({ objectId: expected.id, revision: expected.revision, sha256: expected.sha256, stillCurrent: object.revision === expected.revision });
      }
      await beforeCommit?.();
      return this.write(async () => {
        const current = this.db.prepare('SELECT status FROM jobs WHERE id=?').get(row.id);
        if (current.status !== 'running') return;
        const outdated = input.some((expected) => this.object(row.project_id, expected.id).revision !== expected.revision);
        if (outdated) { this.db.prepare("UPDATE jobs SET status='outdated',phase='输入版本已更新，旧结果未覆盖资料',updated_at=? WHERE id=?").run(now(), row.id); return; }
        const layout = await this.workspaceFiles.layout(row.project_id);
        const rel = join(layout.directories.temp, 'dsh-workbench', 'jobs', `${row.id}.json`), path = await this.projectPath(row.project_id, rel);
        await mkdir(resolve(path, '..'), { recursive: true });
        await writeFile(path, json({ projectId: row.project_id, jobId: row.id, checked, completedAt: now() }), { flag: 'wx' });
        this.db.prepare("UPDATE jobs SET status='succeeded',phase=?,output=?,updated_at=? WHERE id=? AND status='running'").run(`已核对 ${checked.length} 份资料，文件与保存版本一致`, json({ path: rel, checked: checked.length }), now(), row.id);
      });
    } catch (error) {
      return this.write(() => this.db.prepare("UPDATE jobs SET status='failed',phase='文件检查未完成',error=?,updated_at=? WHERE id=? AND status='running'").run(error instanceof StoreError ? error.message : '文件读取或写入失败，原资料仍保留。', now(), row.id));
    }
  }
  async close() { await this.tail; this.closed = true; this.db.close(); }
}
