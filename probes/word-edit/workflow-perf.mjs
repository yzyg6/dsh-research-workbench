/** Repeatable local workflow latency; no real manuscript or model requests. */
import assert from 'node:assert/strict';import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';import {join} from 'node:path';import {fileURLToPath} from 'node:url';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {WorkspaceRuntime} from '../../src/server/runtime.mjs';import {NativeSentenceAdapter} from '../../src/client/native-sentence-adapter.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),out=join(root,'_scratch/out/workflow-perf');await mkdir(out,{recursive:true});const directory=await mkdtemp(join(out,'run-'));
const r=new WorkspaceRuntime({root:join(directory,'catalog'),sampleRoot:join(root,'samples/figure'),publicRoot:join(root,'public')});
const projectId=await r.store.createProject({title:'专用合成性能文稿'}),file=join(r.store.project(projectId).root_path,'paper','perf.docx');await promisify(execFile)('python',['-I',join(root,'probes/word-reader/create-fixture.py'),'--output',file,'--paragraphs','80'],{windowsHide:true});
const objectId=await r.store.importWorkspaceFile({projectId,path:'paper/perf.docx',openOriginal:true}),sid='session-00000000-1111-2222-3333-444444444444';r.nativeWriting.validateSession=async()=>{};r.nativeWriting.attachSession=async()=>{};r.writing.evidence={retrieve:async()=>({sources:[],terms:[],warnings:[],local:'offline-perf',zotero:'offline-perf'})};
const initial=await r.nativeWriting.open({projectId,objectId});await r.nativeWriting.bind({projectId,jobId:initial,sessionId:sid});
const times={},counts={inspect:0,state:0,bindRequests:0,sessionRefresh:0};
const detail={};for(const [target,name,label]of[[r.wordEditing,'inspect','pythonInspection'],[r.store.documentHistory,'text','historyText'],[r.store.documentHistory,'append','historyAppend'],[r.store.documentHistory,'repository','historyRepository'],[r.store.workspaceFiles,'checkpointAll','checkpoint']]){const original=target[name].bind(target);target[name]=async(...args)=>{const start=performance.now();try{return await original(...args)}finally{const entry=detail[label]||{calls:0,ms:0};entry.calls++;entry.ms+=Math.round(performance.now()-start);detail[label]=entry}}}
for(const [object,name,key]of[[r.wordEditing,'inspect','inspect'],[r.store,'state','state']]){const original=object[name].bind(object);object[name]=(...args)=>{counts[key]++;return original(...args)}}
const timed=async(name,work)=>{const start=performance.now(),result=await work();times[name]=Math.round(performance.now()-start);return result};
const adapter=new NativeSentenceAdapter({mutate:async(action,data)=>{counts.bindRequests++;return r.mutate(action,data)}});adapter.setSessions({refresh:async()=>{counts.sessionRefresh++},retain:()=>({ready:Promise.resolve(),release(){}})});
try{
  const parsed=await r.wordEditing.inspect({path:file}),text=parsed.text.split('\n')[40],wordSelection={anchor:{story:'body',path:[40],off:0},focus:{story:'body',path:[40],off:Buffer.byteLength(text)},text},args={projectId,objectId,expectedRevision:1,wordSelection};
  const prepared=await timed('select',()=>r.mutate('prepareSentenceSession',args)),jobId=prepared.actionResult.jobId,project=prepared.projects.find(p=>p.id===projectId),job=project.jobs.find(j=>j.id===jobId);
  await timed('bridge',()=>adapter.ensure(project,job));
  await r.nativeWriting.userTurn(sid,[{role:'user',content:[{type:'text',text:'保持原意，精简当前选句。'}]}],{provider:'offline-perf',model:'no-model'},1);
  await timed('context',()=>r.nativeWriting.readContext(sid,''));
  const replacement='第40段。这是用于性能验证的合成建议。';
  await timed('proposal',()=>r.nativeWriting.propose(sid,{selectionId:jobId,replacement,reason:'合成性能测试',evidenceIds:[],warnings:[]}));
  await timed('reviewSnapshot',()=>r.viewState());
  await timed('adopt',()=>r.mutate('applySentence',{projectId,jobId}));
  await timed('undo',()=>r.mutate('undoSentence',{projectId,jobId}));
  const result={directory,synthetic:true,model:'none',times,counts,detail};await writeFile(join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  if(process.argv.includes('--enforce')){assert(times.select<=250,`select ${times.select}ms > 250ms`);assert(times.adopt<=1500,`adopt ${times.adopt}ms > 1500ms`)}
}finally{adapter.dispose();await r.dispose()}
