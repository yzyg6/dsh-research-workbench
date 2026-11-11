import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ProjectStore } from '../src/server/store.mjs';
import { WorkspaceRuntime } from '../src/server/runtime.mjs';
const exec = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url)), out = join(root, '_scratch/out/workspace-layout-tests'); await mkdir(out, { recursive: true });
const make = async () => { const base = await mkdtemp(join(out, 'case-')); return { base, store: new ProjectStore({ root: join(base, 'catalog'), sampleRoot: join(root, 'samples/figure') }), workspace: join(base, 'paper-root') }; };
async function fixture(workspace) { for (const name of ['Paper', 'Picture', 'Data', 'Reference', 'Temp']) await mkdir(join(workspace, name), { recursive: true }); await writeFile(join(workspace, 'Paper', '稿件.md'), '# 稿件\n\n沉积物可能影响甲烷排放。\n'); await writeFile(join(workspace, 'Data', 'original.csv'), 'group,value\nA,1\n'); await writeFile(join(workspace, 'Reference', '已解析文献.md'), '# 文献\n\n沉积物与甲烷排放的观察性证据。\n'); }

test('a new exact root gets the standard directories, real Git, readable master and versions', async () => {
  const { store, workspace } = await make(), projectId = await store.createProject({ title: '新论文', workspacePath: workspace });
  const project = (await store.state()).projects[0], object = project.objects[0];
  assert.equal(project.rootPath, workspace); assert.equal(project.workspace.directories.data, 'Data');
  for (const name of ['paper','picture','Data','reference','temp','.git']) assert((await stat(join(workspace, name))).isDirectory());
  assert.match(object.metadata.workspaceFile, /^paper[\\/]/); assert.match(store.object(projectId, object.id).path, /^paper[\\/]_versions[\\/]/);
  await store.saveObject({ projectId, objectId: object.id, expectedRevision: 1, text: '# 新版' });
  assert.equal(await readFile(join(workspace, object.metadata.workspaceFile), 'utf8'), '# 新版');
  const checkpoint = JSON.parse(await readFile(join(workspace, '.research-workbench/project.json'), 'utf8'));
  assert.equal(checkpoint.versions.length, 2); assert.equal(checkpoint.objects[0].revision, 2); await store.close();
});

test('opening an existing root reuses case, preserves Git staging, imports existing content and protects raw data', async () => {
  const { store, workspace } = await make(); await fixture(workspace); await exec('git', ['init','--quiet'], { cwd: workspace, windowsHide: true });
  await writeFile(join(workspace, 'unrelated.txt'), 'existing user staging'); await exec('git', ['add','unrelated.txt'], { cwd: workspace, windowsHide: true });
  const before = await readFile(join(workspace, '.git/index')), raw = await readFile(join(workspace, 'Data/original.csv'));
  await writeFile(join(workspace, '.gitignore'), 'user-rule/\n');
  const id = await store.openWorkspace({ path: workspace }), again = await store.openWorkspace({ path: workspace }); assert.equal(again, id);
  const p = (await store.state()).projects[0]; assert.equal(p.rootPath, workspace); assert.equal(p.workspace.directories.picture, 'Picture'); assert.equal(p.workspace.directories.paper, 'Paper');
  assert.deepEqual(await readFile(join(workspace,'.git/index')), before); assert.match(await readFile(join(workspace,'.gitignore'),'utf8'), /^user-rule\//);
  const data = p.objects.find(o => o.kind === 'data'); assert.equal(data.metadata.workspaceReadOnly, true); assert.match(data.text, /A,1/);
  await assert.rejects(store.saveObject({ projectId:id,objectId:data.id,expectedRevision:1,text:'changed' })); assert.deepEqual(await readFile(join(workspace,'Data/original.csv')),raw);
  assert.equal(p.objects.filter(o=>o.metadata.workspaceFile==='Paper/稿件.md').length,1); await store.close();
});

test('project-local checkpoint restores the same identities, versions and task state into a fresh host catalog', async () => {
  const { store, workspace, base } = await make(); await fixture(workspace); const id=await store.openWorkspace({path:workspace}), p=(await store.state()).projects[0],o=p.objects.find(x=>x.kind==='manuscript');
  await store.saveObject({projectId:id,objectId:o.id,expectedRevision:1,text:'# 仍在论文根目录中的新版本'});
  await store.saveTaskState({projectId:id,task:'writing',patch:{selectedObjectId:o.id,scrollTop:70}}); await store.close();
  const restored=new ProjectStore({root:join(base,'fresh-catalog'),sampleRoot:join(root,'samples/figure')});
  assert.equal(await restored.openWorkspace({path:workspace}),id); const next=(await restored.state()).projects[0];
  assert.equal(next.objects.find(x=>x.id===o.id).revision,2); assert.equal(next.taskStates.writing.value.scrollTop,70); assert.equal(restored.versions(id,o.id).length,2); await restored.close();
});

test('external Markdown edits are never overwritten and scanning records a new local version', async () => {
  const {store,workspace}=await make(); await fixture(workspace); const id=await store.openWorkspace({path:workspace}),o=(await store.state()).projects[0].objects.find(x=>x.kind==='manuscript'),path=join(workspace,o.metadata.workspaceFile);
  await writeFile(path,'# 作者在外部编辑的新稿'); const state=await store.state(); assert(state.projects[0].objects.find(x=>x.id===o.id).contentError);
  await assert.rejects(store.saveObject({projectId:id,objectId:o.id,expectedRevision:1,text:'不应覆盖'}),{code:'EXTERNAL_CHANGE'});
  assert.equal(await readFile(path,'utf8'),'# 作者在外部编辑的新稿'); await store.refreshWorkspace({projectId:id});
  const next=(await store.state()).projects[0].objects.find(x=>x.id===o.id); assert.equal(next.revision,2); assert.equal(next.contentError,null); assert.equal(next.text,'# 作者在外部编辑的新稿'); await store.close();
});

test('canonical copies roll back with failed metadata transactions and existing filenames are not replaced by new objects', async () => {
  const {store,workspace}=await make(); await fixture(workspace); const id=await store.openWorkspace({path:workspace}),o=(await store.state()).projects[0].objects.find(x=>x.kind==='manuscript'),path=join(workspace,o.metadata.workspaceFile),before=await readFile(path);
  await assert.rejects(store.saveObject({projectId:id,objectId:o.id,expectedRevision:1,text:'不可提交的版本'},{afterSave(){throw Error('simulated transaction failure')}})); assert.deepEqual(await readFile(path),before); assert.equal(store.versions(id,o.id).length,1);
  const newId=await store.createObject({projectId:id,kind:'manuscript',title:'稿件.md',text:'同名独立稿'}); assert.notEqual(store.object(id,newId).metadata,store.object(id,o.id).metadata); assert.deepEqual(await readFile(path),before); await store.close();
});

test('directory links cannot redirect workspace business files outside the chosen root', async () => {
  const {store,workspace,base}=await make(); await mkdir(workspace); const outside=join(base,'outside'); await mkdir(outside); await symlink(outside,join(workspace,'paper'),'junction');
  await assert.rejects(store.openWorkspace({path:workspace}),{code:'WORKSPACE_PATH_OUTSIDE'}); await store.close();
});

test('workspace browsing is restricted to business directories and local parsed references are searchable without import copies', async () => {
  const {base,workspace,store}=await make(); await store.close(); await fixture(workspace);
  const runtime=new WorkspaceRuntime({root:join(base,'runtime-catalog'),sampleRoot:join(root,'samples/figure'),publicRoot:join(root,'public')});const id=await runtime.store.openWorkspace({path:workspace});
  const listing=await runtime.store.workspaceFiles.list(id); assert.deepEqual(listing.entries.map(x=>x.name),['Paper','Picture','Data','Reference','Temp']);
  await assert.rejects(runtime.store.workspaceFiles.list(id,'.git'),{code:'WORKSPACE_PATH_OUTSIDE'});
  await assert.rejects(runtime.store.workspaceFiles.list(id,'Paper/../../outside'),{code:'PATH_OUTSIDE_PROJECT'});
  const local=await runtime.writing.evidence.local(id,['甲烷']); assert(local.some(x=>x.title==='已解析文献.md'));
  await runtime.writing.evidence.import({projectId:id,title:'新增证据.md',text:'甲烷关联的第二份证据。'}); const objects=(await runtime.store.state()).projects[0].objects; assert(objects.some(o=>o.metadata.workspaceFile?.startsWith('Reference/parsed/'))); await runtime.dispose();
});

test('rescanning and fresh-catalog restore preserve authored revisions and editable derived data', async () => {
  const {base,workspace,store}=await make(),id=await store.createProject({title:'自建资料恢复',workspacePath:workspace});
  const manuscript=(await store.state()).projects[0].objects[0];
  const note=await store.createObject({projectId:id,kind:'note',title:'研究问题',text:'作者的论证笔记。'});
  const data=await store.createObject({projectId:id,kind:'data',title:'derived',text:'group,value\nA,2\n'});
  await store.refreshWorkspace({projectId:id});
  for(const objectId of [manuscript.id,note,data])assert.equal(store.object(id,objectId).revision,1);
  assert.equal(store.object(id,note).kind,'note');assert.equal(JSON.parse(store.object(id,data).metadata).workspaceReadOnly,false);await store.close();
  const restored=new ProjectStore({root:join(base,'fresh-catalog'),sampleRoot:join(root,'samples/figure')});await restored.openWorkspace({path:workspace});
  for(const objectId of [manuscript.id,note,data])assert.equal(restored.object(id,objectId).revision,1);
  await restored.saveObject({projectId:id,objectId:data,expectedRevision:1,text:'group,value\nA,3\n'});await restored.close();
});

test('figure publication requires the full bundle and keeps all four files and immutable revisions in one figure directory', async () => {
  const {publishFigure}=await import('../src/server/figure-publish.mjs');const {store,workspace}=await make(),id=await store.createProject({title:'图表发布验收',workspacePath:workspace});
  const directory=join(workspace,'temp','render');await mkdir(directory,{recursive:true});
  await writeFile(join(directory,'plot.py'),'raise RuntimeError("publication must not execute this script")\n');
  await writeFile(join(directory,'figure.png'),await readFile(join(root,'samples/tavotto/Figure1.png')));
  await writeFile(join(directory,'figure.pdf'),await readFile(join(root,'samples/tavotto/Figure1.pdf')));
  await writeFile(join(directory,'figure.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><path d="M0 100 L50 0 L100 100" fill="none" stroke="black"/></svg>');
  const args={projectId:id,title:'独立图稿',script:'temp/render/plot.py',png:'temp/render/figure.png',svg:'temp/render/figure.svg',pdf:'temp/render/figure.pdf'};
  await assert.rejects(publishFigure(store,{...args,pdf:undefined}),{code:'FIGURE_BUNDLE_REQUIRED'});
  const objectId=await publishFigure(store,args),object=store.object(id,objectId),metadata=JSON.parse(object.metadata);assert.match(metadata.figureDirectory,/^picture\//);assert.deepEqual(metadata.missing,[]);
  for(const path of [...Object.values(metadata.formats),...metadata.scripts])assert(path.startsWith(metadata.figureDirectory+'/'));
  assert.match(await readFile(join(workspace,metadata.scripts[0]),'utf8'),/must not execute/);
  await store.refreshWorkspace({projectId:id});assert.equal(store.object(id,objectId).revision,1);
  await publishFigure(store,{...args,objectId,expectedRevision:1});assert.equal(store.versions(id,objectId).length,2);
  await assert.rejects(publishFigure(store,{...args,objectId,expectedRevision:1}),{code:'VERSION_CONFLICT'});await store.close();
});

test('Markdown images resolve relative to the editable paper while storage cannot target Git or another role', async () => {
  const {store,workspace,base}=await make(),id=await store.createProject({title:'图片路径',workspacePath:workspace}),o=(await store.state()).projects[0].objects[0];
  await writeFile(join(workspace,'picture','image.png'),await readFile(join(root,'samples/tavotto/Figure1.png')));
  const image=await store.workspaceFiles.image(id,o.id,'../picture/image.png');assert.equal(image.contentType,'image/png');assert(image.bytes.length>100);
  await writeFile(join(base,'outside.png'),'outside');await assert.rejects(store.workspaceFiles.image(id,o.id,'../../outside.png'),{code:'PATH_OUTSIDE_PROJECT'});
  await assert.rejects(store.createObject({projectId:id,kind:'manuscript',title:'越界稿',text:'x',metadata:{workspaceFile:'.git/unexpected.md'}}),{code:'WORKSPACE_ROLE_MISMATCH'});
  await assert.rejects(store.createObject({projectId:id,kind:'manuscript',title:'跨类型',text:'x',metadata:{workspaceFile:'Data/unexpected.md'}}),{code:'WORKSPACE_ROLE_MISMATCH'});await store.close();
});
