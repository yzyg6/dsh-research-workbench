import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,stat} from 'node:fs/promises';import {join} from 'node:path';import {fileURLToPath} from 'node:url';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {WorkspaceRuntime} from '../src/server/runtime.mjs';import {WordPreview} from '../src/server/word-preview.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),out=join(root,'_scratch/out/word-reader-tests'),exec=promisify(execFile);await mkdir(out,{recursive:true});
async function setup(mode='normal',paragraphs=90){const base=await mkdtemp(join(out,'case-')),workspace=join(base,'paper-root');await mkdir(join(workspace,'paper'),{recursive:true});const file=join(workspace,'paper','synthetic.docx');await exec('python',['-I',join(root,'probes/word-reader/create-fixture.py'),'--output',file,'--mode',mode,'--paragraphs',String(paragraphs)],{windowsHide:true});const runtime=new WorkspaceRuntime({root:join(base,'catalog'),sampleRoot:join(root,'samples/figure'),publicRoot:join(root,'public')}),projectId=await runtime.store.openWorkspace({path:workspace}),object=(await runtime.store.state()).projects[0].objects.find(x=>x.title==='synthetic.docx');return{runtime,base,workspace,file,projectId,objectId:object.id}}
async function ready(service,p,o){for(let i=0;i<200;i++){const result=await service.status(p,o);if(!['queued','running'].includes(result.state))return result;await new Promise(r=>setTimeout(r,20))}throw Error('reader test timeout')}

test('DOCX is parsed once into bounded segments containing text, table, image and MathML; state never contains Word content',async()=>{
 const {runtime,projectId,objectId,file}=await setup();try{const original=await readFile(file),[a,b]=await Promise.all([runtime.wordPreview.start(projectId,objectId),runtime.wordPreview.start(projectId,objectId)]);assert.notEqual(a.leaseId,b.leaseId);assert.equal(runtime.wordPreview.jobs.size,1);assert(runtime.wordPreview.queue.length<=1);const status=await ready(runtime.wordPreview,projectId,objectId);assert.equal(status.state,'ready');assert(status.segments>1);assert.equal(status.counts.tables,1);assert.equal(status.counts.images,1);assert.equal(status.counts.formulas,1);
 const blocks=[];for(let page=0;page<status.segments;page++){const asset=await runtime.wordPreview.asset(projectId,objectId,{page});assert(asset.bytes.length<1024*1024);blocks.push(...JSON.parse(asset.bytes).blocks)}assert(blocks.some(x=>x.type==='table'));assert(blocks.some(x=>JSON.stringify(x).includes('mfrac')));assert(blocks.some(x=>JSON.stringify(x).includes('image-1.png')));
 assert.equal((await runtime.store.state()).projects[0].objects.find(x=>x.id===objectId).text,'');assert.deepEqual(await readFile(file),original);
 const context=await runtime.wordPreview.context(projectId,objectId);assert((await stat(join(context.folder,'manifest.json'))).isFile());
 }finally{await runtime.dispose()}
});

test('reopening a cached Word needs no parser and formal routes serve only the selected segment and owned images',async()=>{
 const {runtime,projectId,objectId,base}=await setup();try{await runtime.wordPreview.start(projectId,objectId);assert.equal((await ready(runtime.wordPreview,projectId,objectId)).state,'ready');await runtime.wordPreview.dispose();runtime.wordPreview=new WordPreview(runtime.store,{python:join(base,'missing-python.exe')});const status=await runtime.wordPreview.start(projectId,objectId);assert.equal(status.state,'ready');assert.equal(runtime.wordPreview.current,null);
 const response=await runtime.handle(new Request(`http://local/api/research-workbench/asset?word=1&projectId=${projectId}&objectId=${objectId}&page=0`));assert.equal(response.status,200);assert(Array.isArray((await response.json()).blocks));
 const image=await runtime.wordPreview.asset(projectId,objectId,{image:'image-1.png'});assert.equal(image.contentType,'image/png');await assert.rejects(runtime.wordPreview.asset(projectId,objectId,{image:'../../outside.png'}),{code:'INVALID_WORD_ASSET'});await assert.rejects(runtime.wordPreview.asset(projectId,objectId,{page:100000}),{code:'INVALID_WORD_PAGE'});
 const other=await runtime.store.createProject({title:'other'});await assert.rejects(runtime.wordPreview.status(other,objectId),{code:'OBJECT_NOT_FOUND'});
 }finally{await runtime.dispose()}
});

test('readers share a lease: closing one does not stop another; closing the last reaps the parsing process',async()=>{
 const {runtime,base,projectId,objectId}=await setup();try{const script=join(base,'slow-reader.py');await writeFile(script,'import time\ntime.sleep(20)\n');runtime.wordPreview.script=script;const [a,b]=await Promise.all([runtime.wordPreview.start(projectId,objectId),runtime.wordPreview.start(projectId,objectId)]);const job=runtime.wordPreview.current;for(let n=0;n<100&&!job.child;n++)await new Promise(r=>setTimeout(r,5));assert(job.child);await runtime.wordPreview.cancel({projectId,objectId,leaseId:a.leaseId});assert.equal(job.cancelled,undefined);await runtime.wordPreview.cancel({projectId,objectId,leaseId:b.leaseId});await job.done;assert.equal(job.state,'cancelled');assert.equal(job.child,null);assert.equal(runtime.wordPreview.current,null);assert.equal(job.stage,null);
 }finally{await runtime.dispose()}
});

test('unsafe ZIP paths and XML entities fail without extraction, while external pictures are not fetched',async()=>{
 for(const mode of ['unsafe','entity','external']){const {runtime,projectId,objectId}=await setup(mode,1);try{await runtime.wordPreview.start(projectId,objectId);const status=await ready(runtime.wordPreview,projectId,objectId);assert.equal(status.state,mode==='external'?'ready':'failed');if(mode==='external')assert(status.warnings.some(s=>s.includes('外链')));else assert.equal(runtime.wordPreview.current,null)}finally{await runtime.dispose()}}
});

test('Word reading positions persist and cannot reference another project',async()=>{
 const {runtime,projectId,objectId}=await setup();try{await runtime.store.saveTaskState({projectId,task:'writing',patch:{wordViews:{[objectId]:2}}});assert.equal((await runtime.store.state()).projects[0].taskStates.writing.value.wordViews[objectId],2);const other=await runtime.store.createProject({title:'other'});await assert.rejects(runtime.store.saveTaskState({projectId:other,task:'writing',patch:{wordViews:{[objectId]:0}}}),{code:'OBJECT_NOT_FOUND'})}finally{await runtime.dispose()}
});

test('the parsing queue is bounded and disposal stops its only child instead of launching queued documents',async()=>{
 const {runtime,base,workspace,projectId,file}=await setup();try{const content=await readFile(file);for(let i=0;i<4;i++)await writeFile(join(workspace,'paper',`extra-${i}.docx`),Buffer.concat([content,Buffer.from(String(i))]));await runtime.store.refreshWorkspace({projectId});const objects=(await runtime.store.state()).projects[0].objects.filter(x=>x.title.endsWith('.docx'));const script=join(base,'slow-reader.py');await writeFile(script,'import time\ntime.sleep(20)\n');runtime.wordPreview.script=script;
 for(const object of objects.slice(0,4))await runtime.wordPreview.start(projectId,object.id);assert(runtime.wordPreview.current);assert.equal(runtime.wordPreview.queue.length,3);await assert.rejects(runtime.wordPreview.start(projectId,objects[4].id),{code:'WORD_BUSY'});const active=runtime.wordPreview.current;await runtime.wordPreview.dispose();assert.equal(active.child,null);assert.equal(runtime.wordPreview.queue.length,0);assert.equal(runtime.wordPreview.jobs.size,0);
 }finally{await runtime.dispose()}
});

test('idle task polls and no-op writes do not serialize workspace snapshots; real mutations still checkpoint',async()=>{
 const {runtime,projectId}=await setup();try{let checkpoints=0;const original=runtime.store.workspaceFiles.checkpointAll.bind(runtime.store.workspaceFiles);runtime.store.workspaceFiles.checkpointAll=async()=>{checkpoints++;await original()};
 for(let n=0;n<10;n++)await runtime.runner.tick();await runtime.store.write(()=>null);assert.equal(checkpoints,0);
 const jobId=await runtime.store.enqueueJob({projectId,type:'project.integrity',operationKey:'real-check'});assert(checkpoints>0);await runtime.runner.tick();assert.equal(runtime.store.db.prepare('SELECT status FROM jobs WHERE id=?').get(jobId).status,'succeeded');
 }finally{await runtime.dispose()}
});
