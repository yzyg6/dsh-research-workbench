import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,stat,writeFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {WorkspaceRuntime} from '../src/server/runtime.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),out=join(root,'_scratch/out/project-lifecycle-tests');await mkdir(out,{recursive:true});
async function setup(){const base=await mkdtemp(join(out,'case-')),r=new WorkspaceRuntime({root:join(base,'catalog'),sampleRoot:join(root,'samples/figure'),publicRoot:join(root,'public')});const p=await r.store.createProject({title:'项目管理与 Word 打开合成测试'});return {r,p,base,workspace:r.store.project(p).root_path}}

test('opening the original Word from workspace files restores a missing managed copy from its verified legacy version',async()=>{
  const {r,p,workspace}=await setup();try{
    const original=join(workspace,'paper','synthetic.docx');await promisify(execFile)('python',['-I',join(root,'probes/word-reader/create-fixture.py'),'--output',original,'--paragraphs','2'],{windowsHide:true});
    const id=await r.store.importWorkspaceFile({projectId:p,path:'paper/synthetic.docx'}),row=r.store.object(p,id),bytes=await readFile(original);
    const metadata={...JSON.parse(row.metadata),workspaceFile:'paper/synthetic_工作台-missing.docx',wordOriginalFile:'paper/synthetic.docx',wordEditable:true};
    await r.store.write(()=>r.store.db.prepare('UPDATE objects SET metadata=? WHERE id=?').run(JSON.stringify(metadata),id));
    const opened=await r.mutate('importWorkspaceFile',{projectId:p,path:'paper/synthetic.docx'}),selected=opened.projects.find(item=>item.id===p).objects.find(item=>item.id===opened.actionResult.objectId);
    assert.equal(selected.id,id);assert.equal(selected.contentError,null,'a stale working-copy alias must not block opening the selected Word');
    assert.deepEqual(await readFile(join(workspace,metadata.workspaceFile)),bytes);assert.deepEqual(await readFile(original),bytes);
    assert.equal((await r.mutate('prepareWordEdit',{projectId:p,objectId:id})).actionResult.chineseFont,'Noto Sans CJK SC');
  }finally{await r.dispose()}
});

test('project deletion hides catalog entries, preserves files and history, and reopening the folder restores the same identity',async()=>{
  const {r,p,workspace}=await setup();try{
    const other=await r.store.createProject({title:'保留的另一项目'}),object=(await r.store.state()).projects.find(item=>item.id===p).objects[0];
    await r.store.documentHistory.ensure(p,object.id);const head=(await r.store.documentHistory.list(p,object.id)).head,bytes=(await r.store.asset(p,object.id)).bytes;
    await r.store.activateProject(p);const removed=await r.mutate('removeProject',{projectId:p});
    assert(!removed.projects.some(item=>item.id===p));assert.equal(removed.activeProjectId,other);
    assert((await stat(workspace)).isDirectory());assert.deepEqual(await readFile(join(workspace,r.store.db.prepare('SELECT path FROM objects WHERE id=?').get(object.id).path)),bytes);
    assert.throws(()=>r.store.object(p,object.id),{code:'PROJECT_REMOVED'});
    const reopened=await r.store.openWorkspace({path:workspace});assert.equal(reopened,p);assert.equal((await r.store.documentHistory.list(p,object.id)).head,head);
    assert.deepEqual((await r.store.asset(p,object.id)).bytes,bytes);
    await r.mutate('removeProject',{projectId:other});const empty=await r.mutate('removeProject',{projectId:p});assert.equal(empty.projects.length,0);assert.equal(empty.activeProjectId,null);
    assert.equal(r.store.workspaceFiles.errors.size,0);
  }finally{await r.dispose()}
});

test('a project with queued work cannot be removed and the catalog marker persists after service reopening',async()=>{
  const {r,p,base}=await setup();try{
    const jobId=await r.store.enqueueJob({projectId:p,type:'project.integrity',operationKey:'deletion-busy-test'});
    await assert.rejects(r.mutate('removeProject',{projectId:p}),{code:'PROJECT_BUSY'});assert.equal((await r.store.state()).projects.length,1);
    await r.store.cancelJob({projectId:p,jobId});await r.mutate('removeProject',{projectId:p});await r.dispose();
    const reopened=new WorkspaceRuntime({root:join(base,'catalog'),sampleRoot:join(root,'samples/figure'),publicRoot:join(root,'public')});try{assert.equal((await reopened.store.state()).projects.length,0)}finally{await reopened.dispose()}
  }finally{if(!r.store.closed)await r.dispose()}
});

test('missing single-copy Word is restored from the exact Git head; differing backups never replace it with older bytes',async()=>{
  const {r,p,workspace}=await setup();try{
    const original=join(workspace,'paper','synthetic.docx');await promisify(execFile)('python',['-I',join(root,'probes/word-reader/create-fixture.py'),'--output',original,'--paragraphs','2'],{windowsHide:true});
    const id=await r.store.importWorkspaceFile({projectId:p,path:'paper/synthetic.docx'}),row=r.store.object(p,id),bytes=await readFile(original);
    await r.store.documentHistory.ensure(p,id);const head=(await r.store.documentHistory.list(p,id)).head;
    const metadata={...JSON.parse(row.metadata),workspaceFile:'paper/synthetic_工作台-missing.docx',wordOriginalFile:'paper/synthetic.docx',wordEditable:true,wordStorageMode:'single-copy'};
    await r.store.write(()=>{r.store.db.prepare('UPDATE objects SET path=?,metadata=? WHERE id=?').run(metadata.workspaceFile,JSON.stringify(metadata),id);r.store.db.prepare('DELETE FROM object_versions WHERE object_id=?').run(id)});
    await writeFile(original,'external original bytes, must not be overwritten');
    await r.mutate('restoreWordWorkingCopy',{projectId:p,objectId:id});assert.deepEqual(await readFile(join(workspace,metadata.workspaceFile)),bytes);assert.equal((await r.store.documentHistory.list(p,id)).head,head);
    assert.equal(await readFile(original,'utf8'),'external original bytes, must not be overwritten');
    await writeFile(join(workspace,metadata.workspaceFile),'new external working bytes');await r.mutate('restoreWordWorkingCopy',{projectId:p,objectId:id});assert.equal(await readFile(join(workspace,metadata.workspaceFile),'utf8'),'new external working bytes');
    await unlink(join(workspace,metadata.workspaceFile));await r.store.write(()=>r.store.db.prepare('UPDATE objects SET sha256=? WHERE id=?').run('f'.repeat(64),id));
    await assert.rejects(r.mutate('restoreWordWorkingCopy',{projectId:p,objectId:id}),{code:'WORD_WORKING_COPY_MISSING'});
    await assert.rejects(stat(join(workspace,metadata.workspaceFile)),{code:'ENOENT'});
  }finally{await r.dispose()}
});

test('explicit original opening selects the actual original, independently of the working copy, and reuses its identity',async()=>{
  const {r,p,workspace}=await setup();try{
    const original=join(workspace,'paper','synthetic.docx');await promisify(execFile)('python',['-I',join(root,'probes/word-reader/create-fixture.py'),'--output',original,'--paragraphs','2'],{windowsHide:true});
    const workingId=await r.store.importWorkspaceFile({projectId:p,path:'paper/synthetic.docx'}),row=r.store.object(p,workingId),originalBytes=await readFile(original),copy=join(workspace,'paper','synthetic_工作台.docx');
    await writeFile(copy,originalBytes);await r.store.write(()=>r.store.db.prepare('UPDATE objects SET metadata=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.metadata),workspaceFile:'paper/synthetic_工作台.docx',wordOriginalFile:'paper/synthetic.docx',wordEditable:true}),workingId));
    const result=await r.mutate('importWorkspaceFile',{projectId:p,path:'paper/synthetic.docx',openOriginal:true}),originalId=result.actionResult.objectId;
    assert.notEqual(originalId,workingId);assert.equal(r.store.object(p,originalId).title,'synthetic.docx');assert(!JSON.parse(r.store.object(p,originalId).metadata).wordEditable);
    assert.deepEqual((await r.store.asset(p,originalId)).bytes,originalBytes);assert.deepEqual(await readFile(copy),originalBytes);
    assert.equal(await r.store.importWorkspaceFile({projectId:p,path:'paper/synthetic.docx',openOriginal:true}),originalId);
    assert.equal(await r.store.importWorkspaceFile({projectId:p,path:'paper/synthetic.docx'}),workingId);
  }finally{await r.dispose()}
});

test('native connection retry initializes the service and unavailable errors do not tell a Desktop user to open Desktop',async()=>{
  const {r}=await setup();try{
    await assert.rejects(r.nativeWriting.ensureReady(),error=>error.code==='NATIVE_UNAVAILABLE'&&error.message.includes('重新连接')&&!error.message.includes('DSH Desktop'));
    let calls=0;r.reconnectNativeSentence=async()=>{calls++;r.nativeWriting.validateSession=async()=>{}};
    assert.deepEqual((await r.mutate('reconnectNativeSentence',{})).actionResult,{ready:true});
    await r.nativeWriting.ensureReady();assert.equal(calls,1);
  }finally{await r.dispose()}
});
