import test from 'node:test';import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,readdir,unlink,stat} from 'node:fs/promises';import {join} from 'node:path';import {fileURLToPath} from 'node:url';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {WorkspaceRuntime} from '../src/server/runtime.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),out=join(root,'_scratch/out/word-edit-tests'),exec=promisify(execFile);await mkdir(out,{recursive:true});
const sid='session-00000000-1111-2222-3333-444444444444';
async function setup(){const base=await mkdtemp(join(out,'case-')),workspace=join(base,'workspace');await mkdir(join(workspace,'paper'),{recursive:true});const file=join(workspace,'paper','synthetic.docx');await exec('python',['-I',join(root,'probes/word-reader/create-fixture.py'),'--output',file,'--paragraphs','3'],{windowsHide:true});
 const r=new WorkspaceRuntime({root:join(base,'catalog'),sampleRoot:join(root,'samples/figure'),publicRoot:join(root,'public')}),p=await r.store.openWorkspace({path:workspace}),o=(await r.store.state()).projects[0].objects.find(x=>x.title==='synthetic.docx');r.nativeWriting.validateSession=async()=>{};r.writing.evidence={retrieve:async()=>({sources:[],terms:[],warnings:['显式测试替身；无外部证据。'],zotero:'test-double'})};return{r,p,o,file,base,workspace}}
const selection={anchor:{story:'body',path:[0],off:0},focus:{story:'body',path:[0],off:6},text:'Word 测'};
async function firstSelection(r,p,o){const {path}=await r.wordEditing.source(p,o.id),result=await r.wordEditing.inspect({path});const first=result.text.split('\n')[0];return{anchor:{story:'body',path:[0],off:0},focus:{story:'body',path:[0],off:Buffer.byteLength(first,'utf8')},text:first}}
async function proposal(r,p,o){const s=await firstSelection(r,p,o),id=await r.nativeWriting.prepare({projectId:p,objectId:o.id,expectedRevision:o.revision,wordSelection:s});await r.nativeWriting.bind({projectId:p,jobId:id,sessionId:sid});await r.nativeWriting.userTurn(sid,[{role:'user',content:[{type:'text',text:'更清楚地表述。'}]}],{provider:'test-double',model:'chosen-model'},1);await r.nativeWriting.readContext(sid,'',new AbortController().signal);await r.nativeWriting.propose(sid,{selectionId:id,replacement:'改写后的合成稿件标题',reason:'仅验证选句替换。',evidenceIds:[],warnings:['这是合成验证。']});return id}

test('Word selection keeps its own document conversation, with full context, adopt/undo and one current DOCX',async()=>{
 const {r,p,o,file,base}=await setup();try{const original=await readFile(file),id=await proposal(r,p,o);await r.mutate('applySentence',{projectId:p,jobId:id});const adopted=r.store.object(p,o.id),meta=JSON.parse(adopted.metadata);assert.equal(adopted.revision,2);assert.equal((await r.store.state()).projects[0].objects.find(x=>x.id===o.id).contentError,null);assert(meta.workspaceFile.includes('_工作台-'));assert.deepEqual(await readFile(file),original);assert((await r.wordEditing.context(p,o.id)).startsWith('改写后的合成稿件标题'));
 const originalPath=await r.store.projectPath(p,r.store.db.prepare('SELECT path FROM object_versions WHERE object_id=? AND revision=1').get(o.id).path),currentPath=await r.store.projectPath(p,adopted.path);
 const comparison=await exec('python',['-I','-c',"import zipfile,sys,json;a=zipfile.ZipFile(sys.argv[1]);b=zipfile.ZipFile(sys.argv[2]);print(json.dumps([n for n in a.namelist() if a.read(n)!=b.read(n)]))",originalPath,currentPath],{windowsHide:true});assert.deepEqual(JSON.parse(comparison.stdout),['word/document.xml']);
 await r.mutate('undoSentence',{projectId:p,jobId:id});assert.equal(r.store.object(p,o.id).revision,3);assert.deepEqual((await r.store.asset(p,o.id)).bytes,original);assert.equal(r.store.versions(p,o.id).length,2);
 const discussion=await r.nativeWriting.open({projectId:p,objectId:o.id});assert.equal(JSON.parse(r.writing.row(p,discussion).input).nativeSessionId,sid);assert.equal(r.nativeWriting.conversations(p).length,1);await r.store.createObject({projectId:p,kind:'manuscript',title:'同一篇论文的 Markdown 副本',text:'# 合成稿\n\n仅验证文件对话隔离。'});const md=(await r.store.state()).projects[0].objects.find(x=>x.kind==='manuscript'&&x.encoding==='utf8');const mdChat=await r.nativeWriting.open({projectId:p,objectId:md.id});assert.equal(JSON.parse(r.writing.row(p,mdChat).input).nativeSessionId,undefined);await r.nativeWriting.open({projectId:p,objectId:o.id});
 await r.nativeWriting.readContext(sid,'',new AbortController().signal);assert.equal(r.nativeWriting.snapshot(sid).input.format,'docx');
 const other=new WorkspaceRuntime({root:join(base,'fresh-catalog'),sampleRoot:join(root,'samples/figure'),publicRoot:join(root,'public')});try{assert.equal(await other.store.openWorkspace({path:r.store.project(p).root_path}),p);assert.equal(other.store.versions(p,o.id).length,2)}finally{await other.dispose()}
 }finally{await r.dispose()}
});
test('Word binary save validates its body, protects foreign/stale versions, and detects working-copy external changes',async()=>{
 const {r,p,o,file}=await setup();try{const id=await proposal(r,p,o);await r.mutate('applySentence',{projectId:p,jobId:id});const bytes=(await r.store.asset(p,o.id)).bytes;
 await assert.rejects(r.wordEditing.save({projectId:p,objectId:o.id,expectedRevision:1,bytes}),{code:'VERSION_CONFLICT'});
 const other=await r.store.createProject({title:'another'});await assert.rejects(r.wordEditing.save({projectId:other,objectId:o.id,expectedRevision:2,bytes}),{code:'OBJECT_NOT_FOUND'});
 await assert.rejects(r.wordEditing.save({projectId:p,objectId:o.id,expectedRevision:2,bytes:Buffer.from('invalid')}),{code:'WORD_INVALID'});
 const url=`http://local/api/research-workbench/word?projectId=${p}&objectId=${o.id}&expectedRevision=2`,response=await r.handle(new Request(url,{method:'POST',headers:{'content-type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'},body:bytes}));assert.equal(response.status,200);
 const working=JSON.parse(r.store.object(p,o.id).metadata).workspaceFile;await writeFile(await r.store.projectPath(p,working),'external');
 await assert.rejects(r.wordEditing.save({projectId:p,objectId:o.id,expectedRevision:2,bytes:await readFile(file)}),{code:'EXTERNAL_CHANGE'});assert.equal(r.store.object(p,o.id).revision,2);
 }finally{await r.dispose()}
});
test('Word anchors reject forged text, non-body and cross-paragraph ranges; stale adoption preserves manual edits',async()=>{
 const {r,p,o,file}=await setup();try{const s=await firstSelection(r,p,o),args={projectId:p,objectId:o.id,expectedRevision:1,wordSelection:s};
 for(const wordSelection of [{...s,anchor:{...s.anchor,off:1}},{...s,text:'forged'},{...s,focus:{...s.focus,path:[1]}},{...s,anchor:{...s.anchor,story:{part:1}}}])await assert.rejects(r.nativeWriting.prepare({...args,wordSelection}),{code:'WORD_INVALID'});
 const id=await proposal(r,p,o);await r.mutate('applySentence',{projectId:p,jobId:id});await r.wordEditing.save({projectId:p,objectId:o.id,expectedRevision:2,bytes:await readFile(file)});await assert.rejects(r.mutate('undoSentence',{projectId:p,jobId:id}),{code:'VERSION_CONFLICT'});assert.equal(r.store.object(p,o.id).revision,3);
 }finally{await r.dispose()}
});
test('Wordcraft resources use fixed local paths with immutable WASM caching and no arbitrary file access',async()=>{
 const {r}=await setup();try{let response=await r.handle(new Request('http://local/api/research-workbench/wordcraft/version.json'));assert.equal(response.status,200);assert((await response.json()).version==='0.17.0');
 response=await r.handle(new Request('http://local/api/research-workbench/wordcraft/NotoSansCJKsc-Regular.woff2'));assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'font/woff2');assert((await response.arrayBuffer()).byteLength>10*1024*1024);
 response=await r.handle(new Request('http://local/api/research-workbench/wordcraft/../../package.json'));assert.equal(response.status,404);
 response=await r.handle(new Request('http://local/api/research-workbench/wordcraft/wordcraft-0.17.0.wasm.gz'));assert.equal(response.status,200);assert(response.headers.get('cache-control').includes('immutable'));assert((await response.arrayBuffer()).byteLength<24*1024*1024);
 }finally{await r.dispose()}
});


test('DOCX patches preserve repeated sentences, UTF-8 byte offsets, namespaces, run formatting, suffix spaces and formula context',async()=>{
 const {r,p,base,workspace}=await setup();try{
  const file=join(workspace,'paper','rich.docx');await exec('python',['-I',join(root,'probes/word-edit/create-rich-fixture.py'),file],{windowsHide:true});const id=await r.store.importWorkspaceFile({projectId:p,path:'paper/rich.docx'}),{path}=await r.wordEditing.source(p,id),prefix='前😀重复句。 中间 ',start=Buffer.byteLength(prefix,'utf8'),s={anchor:{story:'body',path:[0],off:start},focus:{story:'body',path:[0],off:start+Buffer.byteLength('重复句。','utf8')},text:'重复句。'},output=join(base,'patched.docx');
  const data=await r.wordEditing.inspect({path,selection:s,replacement:'保留不确定性。',output});assert(data.text.includes('公式 OOXML'));assert.equal(data.formulas,1);
  const result=await r.wordEditing.inspect({path:output});assert(result.text.startsWith(prefix+'保留不确定性。 后缀\n重复句。'));
  const raw=await exec('python',['-I','-c',"import zipfile,sys,json;a=zipfile.ZipFile(sys.argv[1]);b=zipfile.ZipFile(sys.argv[2]);xml=b.read('word/document.xml').decode();print(json.dumps({'others':all(a.read(n)==b.read(n) for n in a.namelist() if n!='word/document.xml'),'namespaces':'xmlns:cx=\"urn:unchanged\" mc:Ignorable=\"cx\"' in xml,'format':'<w:i/>' in xml,'spaces':'xml:space=\"preserve\"> 后缀</w:t>' in xml}))",path,output],{windowsHide:true});assert.deepEqual(JSON.parse(raw.stdout),{others:true,namespaces:true,format:true,spaces:true});
 }finally{await r.dispose()}
});


test('a manual DOCX binary save updates one working copy; repeated saves are idempotent',async()=>{
 const {r,p,o,file,base}=await setup();try{
  const original=await readFile(file),path=join(base,'manual.docx');await exec('python',['-I','-c',"import zipfile,sys;a=zipfile.ZipFile(sys.argv[1]);b=zipfile.ZipFile(sys.argv[2],'w');[(b.writestr(i,a.read(i.filename).replace('专用合成'.encode(),'手动编辑'.encode()) if i.filename=='word/document.xml' else a.read(i.filename))) for i in a.infolist()];b.close()",file,path],{windowsHide:true});
  const bytes=await readFile(path),request=()=>new Request(`http://local/api/research-workbench/word?projectId=${p}&objectId=${o.id}&expectedRevision=${r.store.object(p,o.id).revision}`,{method:'POST',headers:{'content-type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'},body:bytes});
  assert.equal((await r.handle(request())).status,200);assert.equal(r.store.object(p,o.id).revision,2);assert((await r.wordEditing.context(p,o.id)).startsWith('手动编辑'));assert.deepEqual(await readFile(file),original);assert.equal((await r.store.state()).projects[0].objects.find(x=>x.id===o.id).contentError,null);
  assert.equal((await r.handle(request())).status,200);assert.equal(r.store.versions(p,o.id).length,2);
 }finally{await r.dispose()}
});

async function editedBytes(r,p,o,title){const {path}=await r.wordEditing.source(p,o.id),selection=await firstSelection(r,p,o),temporary=await r.wordEditing.temporary(p);try{await r.wordEditing.inspect({path,selection,replacement:title,output:temporary});return await readFile(temporary)}finally{await unlink(temporary).catch(()=>{})}}
async function wordFiles(directory){const result=[];for(const entry of await readdir(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())result.push(...await wordFiles(path));else if(/\.docx$/i.test(entry.name))result.push(path)}return result.sort()}

test('repeated Word saves keep a stable working path and do not add full DOCX snapshots, including external refresh',async()=>{
 const {r,p,o,file,workspace}=await setup();try{
  const original=await readFile(file);let working,files;
  for(let i=0;i<5;i++){await r.wordEditing.save({projectId:p,objectId:o.id,expectedRevision:r.store.object(p,o.id).revision,bytes:await editedBytes(r,p,o,'手动工作稿 '+i)});const row=r.store.object(p,o.id);if(!working){working=row.path;files=await wordFiles(join(workspace,'paper'))}assert.equal(row.path,working);assert.deepEqual(await wordFiles(join(workspace,'paper')),files);assert.equal(r.store.versions(p,o.id).length,2)}
  const bytes=await editedBytes(r,p,o,'外部调整的工作稿');await writeFile(await r.store.projectPath(p,working),bytes);await r.store.refreshWorkspace({projectId:p});
  assert.equal(r.store.object(p,o.id).path,working);assert.equal(r.store.versions(p,o.id).length,2);assert.deepEqual(await wordFiles(join(workspace,'paper')),files);assert.deepEqual(await readFile(file),original);
 }finally{await r.dispose()}
});

test('compact undo survives reopening and restores a manually edited predecessor without a full predecessor snapshot',async()=>{
 const {r,p,o,base,workspace}=await setup();let active=r;try{
  const manual=await editedBytes(r,p,o,'先手动编辑的标题');await r.wordEditing.save({projectId:p,objectId:o.id,expectedRevision:1,bytes:manual});
  const id=await proposal(r,p,{...o,revision:2});await r.mutate('applySentence',{projectId:p,jobId:id});const output=JSON.parse(r.writing.row(p,id).output);assert(output.wordUndo.path.endsWith('.json.gz'));assert.equal(r.store.versions(p,o.id).some(v=>v.revision===2),false);
  await r.dispose();active=new WorkspaceRuntime({root:join(base,'restart'),sampleRoot:join(root,'samples/figure'),publicRoot:join(root,'public')});await active.store.openWorkspace({path:workspace});await active.mutate('undoSentence',{projectId:p,jobId:id});assert.deepEqual((await active.store.asset(p,o.id)).bytes,manual);assert.equal(active.store.versions(p,o.id).length,2);
 }finally{await active.dispose()}
});

test('a failed single-copy save restores bytes, metadata and source timestamps',async()=>{
 const {r,p,o}=await setup();try{
  await r.wordEditing.save({projectId:p,objectId:o.id,expectedRevision:1,bytes:await editedBytes(r,p,o,'第一份工作稿')});const before=r.store.object(p,o.id),bytes=(await r.store.asset(p,o.id)).bytes;
  await assert.rejects(r.wordEditing.save({projectId:p,objectId:o.id,expectedRevision:2,bytes:await editedBytes(r,p,o,'应当回滚的稿件')},{afterSave(){throw Error('合成事务失败')}}),/合成事务失败/);
  assert.equal(r.store.object(p,o.id).revision,2);assert.deepEqual((await r.store.asset(p,o.id)).bytes,bytes);assert.equal((await r.store.state()).projects[0].objects.find(item=>item.id===o.id).contentError,null);assert.equal(r.store.object(p,o.id).metadata,before.metadata);
 }finally{await r.dispose()}
});

test('undo records exclude a large unchanged picture and detect record tampering',async()=>{
 const {r,p,o,file,base,workspace}=await setup();try{
  const large=join(workspace,'paper','large.docx');await exec('python',['-I','-c',"import zipfile,sys,random,struct,zlib; a=zipfile.ZipFile(sys.argv[1]); w,h=1024,1024; raw=random.Random(52).randbytes(w*h*3); chunk=lambda n,d:struct.pack('>I',len(d))+n+d+struct.pack('>I',zlib.crc32(n+d)); png=b'\\x89PNG\\r\\n\\x1a\\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(b''.join(b'\\0'+raw[i:i+w*3] for i in range(0,len(raw),w*3))))+chunk(b'IEND',b''); b=zipfile.ZipFile(sys.argv[2],'w'); [b.writestr(i,png if i.filename=='word/media/image1.png' else a.read(i.filename)) for i in a.infolist()]; b.close()",file,large],{windowsHide:true});
  const objectId=await r.store.importWorkspaceFile({projectId:p,path:'paper/large.docx'}),original=await readFile(large),item={...o,id:objectId,revision:1},id=await proposal(r,p,item);await r.mutate('applySentence',{projectId:p,jobId:id});const saved=JSON.parse(r.writing.row(p,id).output),undo=await r.store.projectPath(p,saved.wordUndo.path),record=await readFile(undo);assert((await stat(undo)).size<16*1024);assert(original.length>3*1024*1024);
  const after=(await r.store.asset(p,objectId)).bytes;await writeFile(undo,Buffer.from('invalid'));await assert.rejects(r.mutate('undoSentence',{projectId:p,jobId:id}),{code:'EXTERNAL_CHANGE'});assert.deepEqual((await r.store.asset(p,objectId)).bytes,after);
  await writeFile(undo,record);await r.mutate('undoSentence',{projectId:p,jobId:id});assert.deepEqual((await r.store.asset(p,objectId)).bytes,original);
 }finally{await r.dispose()}
});

test('legacy Word archives remain readable while the next undo and saves migrate to one working copy',async()=>{
 const {r,p,o}=await setup();try{
  const id=await proposal(r,p,o);await r.mutate('applySentence',{projectId:p,jobId:id});const row=r.store.object(p,o.id),meta=JSON.parse(row.metadata),bytes=(await r.store.asset(p,o.id)).bytes;
  delete meta.wordStorageMode;const paths=await r.store.workspaceFiles.allocate(p,{objectId:o.id,kind:'manuscript',title:row.title,extension:'.docx',revision:2,metadata:meta});await writeFile(paths.versionPath,bytes);
  await r.store.write(()=>{const output=JSON.parse(r.writing.row(p,id).output);delete output.wordUndo;r.store.db.prepare('UPDATE jobs SET output=? WHERE id=?').run(JSON.stringify(output),id);r.store.db.prepare('UPDATE objects SET path=?,metadata=? WHERE id=?').run(paths.version,JSON.stringify(meta),o.id);r.store.db.prepare('UPDATE object_versions SET path=?,metadata=? WHERE object_id=? AND revision=2').run(paths.version,JSON.stringify(meta),o.id)});
  await r.mutate('undoSentence',{projectId:p,jobId:id});assert.equal(JSON.parse(r.store.object(p,o.id).metadata).wordStorageMode,'single-copy');assert.deepEqual(await readFile(paths.versionPath),bytes);
  const count=r.store.versions(p,o.id).length;await r.wordEditing.save({projectId:p,objectId:o.id,expectedRevision:3,bytes:await editedBytes(r,p,o,'迁移后的同一份工作稿')});assert.equal(r.store.versions(p,o.id).length,count);assert.deepEqual(await readFile(paths.versionPath),bytes);
 }finally{await r.dispose()}
});
