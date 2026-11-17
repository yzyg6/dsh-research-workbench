/** Isolated real Web/WASM integration. Never opens DSH or a research manuscript. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {WorkspaceRuntime} from '../../src/server/runtime.mjs';
const syncMode=process.argv.includes('--manuscript-sync');
const batchMode=process.argv.includes('--manuscript-batch');
const auditMode=syncMode||batchMode||process.argv.includes('--manuscript-audit');
const chapterMode=process.argv.includes('--chapter');
const reviewMode=chapterMode||process.argv.includes('--review'),workbenchMode=auditMode||chapterMode||process.argv.includes('--workbench');
const root=fileURLToPath(new URL('../../',import.meta.url)),out=join(root,reviewMode?'_scratch/out/word-review-browser':'_scratch/out/word-live-browser');await mkdir(out,{recursive:true});const directory=await mkdtemp(join(out,'case-'));
const runtime=new WorkspaceRuntime({root:join(directory,'catalog'),sampleRoot:join(root,'samples/figure'),publicRoot:join(root,'public'),trustedTransport:false});
const projectId=await runtime.store.createProject({title:'Word 实时编辑合成验收'}),workspace=runtime.store.project(projectId).root_path,originalFile=join(workspace,'paper','synthetic.docx');
await promisify(execFile)('python',['-I',join(root,'probes/word-edit/create-format-fixture.py'),originalFile],{windowsHide:true});
await promisify(execFile)('python',['-I','-c',"import sys,zipfile; p=sys.argv[1]; z=zipfile.ZipFile(p); members={n:z.read(n) for n in z.namelist()}; z.close(); members['word/document.xml']=members['word/document.xml'].replace(b'<w:tbl>',b'<w:p/><w:p/><w:tbl>'); z=zipfile.ZipFile(p,'w',zipfile.ZIP_DEFLATED); [z.writestr(n,b) for n,b in members.items()]; z.close()",originalFile],{windowsHide:true});
if(reviewMode)await promisify(execFile)('python',['-I',join(root,'probes/word-reader/create-fixture.py'),'--output',originalFile,'--paragraphs','80'],{windowsHide:true});
if(auditMode)await promisify(execFile)('python',['-I',join(root,'probes/manuscript-review/create-fixture.py'),originalFile],{windowsHide:true});
const original=await readFile(originalFile),objectId=await runtime.store.importWorkspaceFile({projectId,path:'paper/synthetic.docx',openOriginal:true});
if(workbenchMode)await runtime.store.saveTaskState({projectId,task:'writing',patch:{selectedObjectId:objectId}});
runtime.nativeWriting.validateSession=async()=>{};runtime.nativeWriting.attachSession=async()=>{};
const jobId=await runtime.nativeWriting.open({projectId,objectId}),sessionId='session-00000000-1111-2222-3333-444444444444';await runtime.nativeWriting.bind({projectId,jobId,sessionId});
if(reviewMode||auditMode)runtime.writing.evidence={retrieve:async()=>({sources:[],terms:[],warnings:[],local:'offline-probe',zotero:'offline-probe'})};
if(auditMode)runtime.review.agent=async({childId,prompt,published})=>{
  const data=JSON.parse(prompt.split('\n').at(-1));
  if(data.task==='draft-review-revision'){
    assert.equal(childId,'offline-review-'+data.finding.workerId);
    const revise=text=>text.replace(/。$/,'，已核对。');
    return JSON.stringify({...(Array.isArray(data.original)?{paragraphs:data.original.map(revise)}:{replacement:revise(data.original)}),reason:'澄清合成稿件的计量口径。',evidenceIds:[],warnings:[]});
  }
  if(!childId)await published('offline-review-'+(data.section?.id||'coordinator'));
  if(!data.section)return JSON.stringify({summary:'统一全文口径。',plan:[{step:'检查定义与结果。',findings:['1-1','2-1']}],relations:[{from:'1-1',to:'2-1',kind:'before',reason:'先确认方法定义，再核对结果范围。'}]});
  const paragraph=data.section.paragraphs[0];
  return JSON.stringify({summary:'核对计量口径。',findings:[{index:paragraph.index,quote:paragraph.text,issue:'口径需解释。',reason:'读者需要对应方法和结果。',kind:data.section.id===1?'meaning':'structure',suggestion:'补充定义。',steps:'明确单位，再说明定义。',prompt:'说明计量口径，保留已有单位。',scope:batchMode&&data.section.id===2?'paragraph':'chapter',links:[1,2]}]});
};
const require=createRequire(join(root,'_scratch/tmp/ui-deps/package.json')),esbuild=require('esbuild'),bundle=join(directory,'probe.js');
esbuild.buildSync({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {WordEditor} from './src/client/WordEditor.jsx';import {NativeSentenceBody} from './src/client/entry.jsx';import {createApi} from './src/client/api.mjs';import base from './src/client/workbench.css';import revision from './src/client/revision-tools.css';import compact from './src/client/compact-layout.css';import refined from './src/client/refined-workbench.css';import glass from './src/client/glass-workbench.css';import {App} from './src/client/App.jsx';
const api=createApi(),projectId=${JSON.stringify(projectId)},objectId=${JSON.stringify(objectId)};
const mutateMeasured=api.mutate.bind(api);api.mutate=async(action,data)=>{const start=performance.now();try{return await mutateMeasured(action,data)}finally{window.pipeline?.push({stage:action,start,end:performance.now()})}};
function Native(info){const[draft,setDraft]=React.useState('');return <div className="rw-native-sentence-frame" style={{height:'100%'}}><NativeSentenceBody sessionId=${JSON.stringify(sessionId)} jobId={info.job.id} autoSelectionDraft={info.autoSelectionDraft} reviewInstruction={info.reviewInstruction||info.job.reviewInstruction} selectedText={info.job.original} conversationOnly={info.job.conversationOnly||['adopted','undone'].includes(info.job.output?.review)} selectionPending={info.selectionPending} useSession={()=>({})} useConversation={()=>({})} useInput={()=>({draft,phase:'plain'})} useWorkspaces={()=>({items:[{sessionIds:[${JSON.stringify(sessionId)}]}]})} inputActions={{setDraft:text=>{window.pipeline?.push({stage:'draft',start:performance.now(),end:performance.now()});setDraft(text)},persistDraft(){},submit(){throw Error('The probe never submits a model request')}}} renderFactorySlot={()=><div data-conversation-content style={{height:'100%',display:'flex',flexDirection:'column'}}><div data-conversation-region="messages" style={{flex:1,overflow:'auto',paddingTop:24}}><small style={{color:'#617087'}}>合成对话 · 界面验证</small><div className="_bubble_1sgyj_1" style={{margin:'18px 0'}}>请帮我核对当前选句，保持术语和引用不变。</div><article className="_markdown_rve47_5"><p>已保留当前文稿上下文。你可以继续调整修改要求，在对照中编辑建议后采用。</p><p>字体、排版和空白清理也可以直接在这里提出。</p></article></div><div data-composer-card style={{margin:'12px 16px',padding:12}}><textarea data-composer-input aria-label="合成原生输入框" value={draft} onChange={e=>setDraft(e.target.value)} style={{width:'100%',minHeight:110,border:0,resize:'none'}}/><div style={{display:'flex',justifyContent:'space-between',color:'#617087',fontSize:11,marginTop:8}}><span>＋　合成测试 · 无模型调用</span><button disabled aria-label="合成发送按钮">↑</button></div></div></div>}/></div>}
function Probe(){const[state,setState]=React.useState(null),[job,setJob]=React.useState(${JSON.stringify(jobId)});React.useEffect(()=>{let closed=false;const controller=new AbortController();window.publish=async()=>{const next=await api.bootstrap();if(!closed)setState(next);return next};void(async()=>{let next=await window.publish();while(!closed){const changed=await api.watchState(next.stamp,controller.signal);if(closed)return;if(changed.stamp!==next.stamp)next=await window.publish()}})().catch(()=>{});return()=>{closed=true;controller.abort()}},[]);if(!state)return null;const project=state.projects.find(p=>p.id===projectId),object=project.objects.find(o=>o.id===objectId);const mutate=async(action,data)=>{const next=await api.mutate(action,{projectId,...data});setState(next);return next};return <><style>{base+revision+compact+refined+glass}</style><div className="rw-app" style={{height:'100%'}}><WordEditor api={api} project={project} object={object} sentence={{jobs:project.jobs,initialNativeJobId:job,nativeRender:info=>React.createElement(Native,info),onNativePrepare:async({wordSelection})=>(await mutate('prepareSentenceSession',{objectId,expectedRevision:object.revision,wordSelection})).actionResult.jobId,onNativeOpen:async id=>{setJob(id)},onOpenConversation:async()=>(await mutate('openWritingConversation',{objectId})).actionResult.jobId,onAction:(action,jobId)=>mutate(action,{jobId}),onEditSuggestion:(jobId,data)=>mutate('editSentenceSuggestion',{jobId,...data})}} onSaved={setState} registerSave={()=>()=>{}} onDirty={()=>{}}/></div></>}createRoot(document.getElementById('root')).render(${workbenchMode?'<App api={api} nativeSentenceRender={info=>React.createElement(Native,info)}/>' : '<Probe/>'});`,resolveDir:root,loader:'jsx'},outfile:bundle,bundle:true,format:'esm',loader:{'.css':'text'},nodePaths:[join(root,'_scratch/tmp/ui-deps/node_modules'),join(root,'_scratch/tmp/editor-deps/node_modules')],logLevel:'silent'});
let browser,ws,server;
const serverTrace=[];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
  server=createServer(async(incoming,outgoing)=>{try{
    if(incoming.url==='/probe'){outgoing.setHeader('content-type','text/html');outgoing.end('<html><meta charset="utf-8"><style>html,body,#root{height:100%;margin:0}.rw-word-editor{height:100%;display:flex;flex-direction:column}.rw-word-layout,.rw-word-document,.rw-word-frame-wrap{height:100%;flex:1}.rw-word-frame{width:100%;height:100%;border:0}.rw-word-layout{display:flex}.rw-word-conversation{width:300px}</style><div id="root"></div><script type="module" src="/probe.js"></script>');return}
    if(incoming.url==='/probe.js'){outgoing.setHeader('content-type','text/javascript');outgoing.end(await readFile(bundle));return}
    const chunks=[];for await(const chunk of incoming)chunks.push(chunk);
    const serverStart=performance.now();let action;try{if(incoming.url.endsWith('/mutate'))action=JSON.parse(Buffer.concat(chunks).toString()).action}catch{}
    const response=await runtime.handle(new Request(`http://127.0.0.1:${server.address().port}${incoming.url}`,{method:incoming.method,headers:incoming.headers,...(chunks.length?{body:Buffer.concat(chunks)}:{})}));
    if(action)serverTrace.push({stage:action,ms:Math.round(performance.now()-serverStart)});
    outgoing.writeHead(response.status,Object.fromEntries(response.headers));outgoing.end(Buffer.from(await response.arrayBuffer()));
  }catch(error){outgoing.writeHead(500).end(error.message)}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--remote-debugging-port=0',`--user-data-dir=${join(directory,'edge-profile')}`,'--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-first-run',`http://127.0.0.1:${server.address().port}/probe`],{windowsHide:true,stdio:'ignore'});
  let port;for(let i=0;i<100;i++){try{port=Number((await readFile(join(directory,'edge-profile/DevToolsActivePort'),'utf8')).split('\n')[0]);if(port)break}catch{}await pause(100)}assert(port,'Edge debugging port');
  let page;for(let i=0;i<100;i++){const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();page=pages.find(p=>p.type==='page'&&p.url.includes('/probe'));if(page)break;await pause(100)}assert(page);
  ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});let seq=0;const waiters=new Map();ws.onmessage=event=>{const item=JSON.parse(event.data),pending=waiters.get(item.id);if(pending){waiters.delete(item.id);item.error?pending.reject(Error(JSON.stringify(item.error))):pending.resolve(item.result)}};
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;waiters.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))});
  const evaluate=async expression=>{const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value};
  if(workbenchMode)await call('Emulation.setDeviceMetricsOverride',{width:1440,height:960,deviceScaleFactor:1,mobile:false});
  for(let i=0;i<180;i++){if(runtime.wordLive.editors.size)break;await pause(300)}
  assert(runtime.wordLive.editors.size,await evaluate('document.body.innerText'));
  const ui=await evaluate(`({formatPanel:!!document.querySelector('[aria-label="Word 格式修改"]'),frames:document.querySelectorAll('iframe').length,body:document.body.innerText})`);assert.equal(ui.formatPanel,false);assert.equal(ui.frames,1);
  const results=[];
  if(auditMode){
    const waitFor=async expression=>{
      for(let i=0;i<250;i++){if(await evaluate(expression))return;await pause(80)}
      assert.fail(await evaluate('document.body.innerText'));
    };
    const button=text=>`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim().startsWith(${JSON.stringify(text)}))`;
    const findingState=(id,state)=>`document.querySelector('[data-finding-id="${id}"] .rw-review-resolution[data-state="${state}"]')?.textContent.trim()`;
    const nativeCommentResolved=id=>`(async()=>{const w=document.querySelector('iframe').contentWindow.wordcraft;const item=(await w.execute('review.comments',{})).find(comment=>JSON.stringify(comment).includes(${JSON.stringify('['+id+']')}));return item?.resolved})()`;
    await evaluate(button('审阅')+'.click()');
    await waitFor(button('开始全文审阅')+'?.disabled===false');
    const composer=`document.querySelector('textarea[aria-label="审阅要求"]')`;
    const picker=`document.querySelector('select[aria-label="审阅重点模板"]')`;
    assert.equal(await evaluate(picker+'.value'),'overview');
    assert.equal(await evaluate(picker+'.options.length'),7);
    const choose=id=>evaluate(`(()=>{const select=${picker};select.value=${JSON.stringify(id)};select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await choose('methods');
    await evaluate(`document.querySelector('[aria-label="审阅重点"] .rw-word-module-preview-toggle').click()`);
    assert(await evaluate(`document.querySelector('[aria-label="审阅重点"] .rw-word-template-preview:not([hidden])').textContent.includes('预处理')`));
    assert.equal(await evaluate(composer+'.value'),'');
    await evaluate(button('填入模板')+'.click()');
    assert((await evaluate(composer+'.value')).includes('预处理'));
    assert.equal(runtime.review.history({projectId,objectId}).length,0);
    await choose('results');
    await evaluate(button('填入模板')+'.click()');
    assert(!(await evaluate(composer+'.value')).includes('预处理'));
    await evaluate(`(()=>{const input=${composer};Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'请额外核对合成稿的单位。');input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await evaluate(button('追加模板')+'.click()');
    assert((await evaluate(composer+'.value')).startsWith('请额外核对合成稿的单位。\n\n'));
    assert(await evaluate(button('已填入')+'.disabled'));
    await evaluate(button('开始全文审阅')+'.click()');
    await waitFor(button('写入 2 条 Word 批注')+'?.disabled===false');
    const submitted=runtime.review.status({projectId,objectId}).instruction;
    assert(submitted.startsWith('请额外核对合成稿的单位。')&&submitted.includes('比较基准'));
    await evaluate(`(()=>{const api=document.querySelector('iframe').contentWindow.wordcraft;const execute=api.execute.bind(api);window.commentPaneResults=[];api.execute=async(name,...args)=>{const result=await execute(name,...args);if(name==='view.commentsPane')window.commentPaneResults.push(result.value);return result}})()`);
    if(syncMode){
      await evaluate(`(async()=>{const frame=document.querySelector('iframe'),w=frame.contentWindow.wordcraft;window.originalWordFrame=frame;await w.execute('review.trackChanges',{});const point={story:'body',path:[3],off:0};await w.execute('select.range',{anchor:point,focus:point});await w.execute('text.insert',{text:'实时合成编辑。',raw:true})})()`);
      await waitFor(`(async()=>{const w=document.querySelector('iframe').contentWindow.wordcraft;return (await w.uiInspect({})).dirty})()`);
      const status=runtime.review.status({projectId,objectId});
      await runtime.mutate('publishReviewComments',{projectId,objectId,jobId:status.id});
      await waitFor(`(async()=>{const frame=document.querySelector('iframe');if(frame!==window.originalWordFrame||document.querySelector('.rw-word-loading'))return false;const w=frame.contentWindow.wordcraft,{comments,trackChanges}=await w.execute('document.inspect',{text:true});const {text}=await w.execute('document.text',{});return comments===3&&trackChanges&&text.includes('实时合成编辑。')&&window.commentPaneResults.at(-1)===true})()`);
      assert.equal(runtime.store.object(projectId,objectId).revision,3);
      assert.match(await runtime.wordEditing.context(projectId,objectId),/实时合成编辑。/);
      assert.deepEqual(await readFile(originalFile),original);
      console.log(JSON.stringify({realTime:true,dirtyDraftMerged:true,trackerPreserved:true,commentsVisible:true,sameIframe:true}));
    }else{
    await evaluate(button('写入 2 条 Word 批注')+'.click()');
    await waitFor(`document.body.innerText.includes('全文审阅意见')&&!document.querySelector('.rw-word-loading')`);
    await waitFor(`window.commentPaneResults.length===1`);
    await waitFor(button('显示 Word 批注')+'?.disabled===false');
    await evaluate(button('显示 Word 批注')+'.click()');
    await waitFor(`window.commentPaneResults.length===3`);
    assert.deepEqual(await evaluate('window.commentPaneResults'),[true,false,true]);
    await evaluate(`document.querySelector('.rw-review-relations>summary').click()`);
    await waitFor(`document.querySelector('.rw-review-relations[open] [data-direction="after"]')?.textContent.includes('先确认方法定义')`);
    await evaluate(`document.querySelector('.rw-review-relations [data-direction="after"] button').click()`);
    await waitFor(`document.querySelector('.rw-review-graded[open][data-kind="structure"]')?.textContent.includes('读者需要对应方法和结果')`);
    const degreeColors=await evaluate(`[...document.querySelectorAll('.rw-review-graded')].map(node=>getComputedStyle(node).borderInlineStartColor)`);
    assert.equal(new Set(degreeColors).size,2);
    await evaluate(`document.querySelector('.rw-review-finding>summary').click()`);
    await waitFor(button('定位到 Word')+'?.disabled===false');
    await evaluate(button('定位到 Word')+'.click()');
    await waitFor(`(async()=>((await document.querySelector('iframe').contentWindow.wordcraft.execute('document.selection',{})).text==='合成方法采用两种计量口径。'))()`);
    const inspection=await evaluate(`document.querySelector('iframe').contentWindow.wordcraft.execute('document.inspect',{text:true})`);
    assert.equal(inspection.comments,3);
    const selected=inspection.selection;
    const saved=await runtime.wordEditing.source(projectId,objectId);
    assert.equal((await runtime.wordEditing.inspect({path:saved.path,selection:{...selected,coordinate:'wordcraft'}})).selectedText,'合成方法采用两种计量口径。');
    if(batchMode){
      assert.equal(await evaluate(nativeCommentResolved('1-1')),false);
      await waitFor(button('全选待处理')+'?.disabled===false');
      await evaluate(button('全选待处理')+'.click()');
      await waitFor(button('批量生成修改稿')+'?.disabled===false');
      await evaluate(button('批量生成修改稿')+'.click()');
      await waitFor(button('采用这条修改')+'?.disabled===false');
      assert.equal(runtime.store.object(projectId,objectId).revision,2,'generation awaits individual review');
      const reviewPicker=`document.querySelector('[aria-label="选择要审核的修改"]')`;
      assert.equal(await evaluate(reviewPicker+'.value'),'1-1');
      const editFirst=`document.querySelector('[aria-label="编辑第 1 段建议"]')`;
      await waitFor(`${editFirst}?.disabled===false`);
      await evaluate(editFirst+'.click()');
      const paragraphInput=`document.querySelector('[aria-label="第 1 段改后文字"]')`;
      const typeEdit=(selector,value)=>evaluate(`(()=>{const input=${selector};Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
      await typeEdit(paragraphInput,'合成方法采用两种计量口径[99]。');
      await evaluate(button('保存本段')+'.click()');
      await waitFor(`document.querySelector('.rw-chapter-comparison [role="alert"]')?.textContent.includes('引用')`);
      await typeEdit(paragraphInput,'合成方法采用两种计量口径，作者已核对。');
      await evaluate(button('保存本段')+'.click()');
      await waitFor(`!${paragraphInput}&&document.querySelector('.rw-chapter-comparison')?.textContent.includes('作者已核对')`);
      assert.equal(runtime.store.object(projectId,objectId).revision,2,'editing one draft must leave Word untouched');
      const documentIdentity=`(async()=>(await document.querySelector('iframe').contentWindow.wordcraft.uiInspect({})).document)()`;
      const initialDocument=await evaluate(documentIdentity);
      if(process.argv.includes('--profile-adoption'))await evaluate(`(()=>{const w=document.querySelector('iframe').contentWindow.wordcraft;window.adoptionTrace=[];for(const key of ['execute','request','uiInspect']){const original=w[key].bind(w);w[key]=async(...args)=>{const t=performance.now();try{return await original(...args)}finally{window.adoptionTrace.push([key==='uiInspect'?key:args[0],Math.round(performance.now()-t)])}}}})()`);
      const firstAdoption=performance.now();
      await evaluate(button('采用这条修改')+'.click()');
      await waitFor(`document.querySelector('.rw-review-batch-progress')?.textContent.includes('1/2')&&${button('下一条待审核')}?.disabled===false`);
      assert.equal(runtime.store.object(projectId,objectId).revision,3);
      const adoptionMs=Math.round(performance.now()-firstAdoption);
      if(process.argv.includes('--profile-adoption'))console.log(JSON.stringify({trace:await evaluate('window.adoptionTrace'),server:serverTrace.filter(item=>item.stage==='applySentence')}));
      assert.equal(await evaluate(documentIdentity),initialDocument,'adopting a compatible section keeps the existing Word document');
      assert.match(await runtime.wordEditing.context(projectId,objectId),/作者已核对/);
      await waitFor(`${nativeCommentResolved('1-1')}`);
      assert.equal(await evaluate(nativeCommentResolved('2-1')),false);
      await evaluate(button('返回审阅')+'.click()');
      await waitFor(`${findingState('1-1','adopted')}==='已解决'&&${findingState('2-1','pending')}==='待采用'`);
      assert.equal(await evaluate(`document.querySelector('.rw-review-resolution-count').textContent.trim()`),'已解决 1/2 条');
      await evaluate(button('查看批量对照')+'.click()');
      await waitFor(button('下一条待审核')+'?.disabled===false');
      await evaluate(button('下一条待审核')+'.click()');
      await waitFor(button('采用这条修改')+'?.disabled===false');
      assert.equal(await evaluate(reviewPicker+'.value'),'2-1');
      await evaluate(`document.querySelector('[aria-label="编辑第 1 句建议"]').click()`);
      const sentenceInput=`document.querySelector('[aria-label="第 1 句改后文字"]')`;
      await typeEdit(sentenceInput,'结果沿用合成方法的计量口径，已由作者核对。');
      await evaluate(button('保存本句')+'.click()');
      await waitFor(`!${sentenceInput}&&document.querySelector('.rw-colored-comparison')?.textContent.includes('已由作者核对')`);
      await evaluate(button('采用这条修改')+'.click()');
      await waitFor(`document.querySelector('.rw-review-batch-progress')?.textContent.includes('2/2')&&${button('返回审阅')}?.disabled===false`);
      assert.equal(runtime.store.object(projectId,objectId).revision,4);
      assert.equal(await evaluate(documentIdentity),initialDocument,'a second adoption also keeps the current Word document');
      await waitFor(`${nativeCommentResolved('2-1')}`);
      await waitFor(`(async()=>{const w=document.querySelector('iframe').contentWindow.wordcraft;const {text}=await w.execute('document.text',{});return text.includes('结果沿用合成方法的计量口径，已由作者核对。')&&text.includes('结果段落报告对应区间。')&&(await w.execute('document.inspect',{text:true})).comments===3})()`);
      await evaluate(button('返回审阅')+'.click()');
      await waitFor(`${findingState('2-1','adopted')}==='已解决'`);
      assert.equal(await evaluate(`document.querySelector('.rw-review-resolution-count').textContent.trim()`),'已解决 2/2 条');
      await evaluate(button('查看批量对照')+'.click()');
      await waitFor(`${reviewPicker}?.value==='2-1'`);
      await waitFor(button('撤回本次采用')+'?.disabled===false');
      await evaluate(button('撤回本次采用')+'.click()');
      await waitFor(`document.querySelector('.rw-review-batch-progress')?.textContent.includes('1/2')&&${button('返回审阅')}?.disabled===false`);
      assert.equal(runtime.store.object(projectId,objectId).revision,5);
      assert.equal(await evaluate(nativeCommentResolved('2-1')),false);
      assert.equal(await evaluate(nativeCommentResolved('1-1')),true);
      await evaluate(button('返回审阅')+'.click()');
      await waitFor(`${findingState('1-1','adopted')}==='已解决'&&${findingState('2-1','undone')}==='待处理'`);
      assert.deepEqual(await readFile(originalFile),original);
      console.log(JSON.stringify({manuscriptBatch:true,realWordcraftWasm:true,individualApprovals:2,editedOneDraft:true,sameDocument:true,adoptionMs,reviewResolved:true,nativeWordCommentResolved:true,undoRestoresPending:true,commentsPreserved:true,queueSelectionPreserved:true,originalPreserved:true}));
    }else{
    await waitFor(button('准备小节修改')+'?.disabled===false');
    await evaluate(button('准备小节修改')+'.click()');
    await waitFor(`document.querySelector('[aria-label="合成原生输入框"]')?.value.includes('说明计量口径')`);
    await runtime.nativeWriting.userTurn(sessionId,[{role:'user',content:[{type:'text',text:'合成建议'}]}],{provider:'offline-probe',model:'no-model'},1);
    const context=await runtime.nativeWriting.readContext(sessionId,'');
    await runtime.nativeWriting.propose(sessionId,{selectionId:context.selectionId,paragraphs:['合成方法定义计量口径。',context.paragraphs[1]],reason:'合成核对。',warnings:[],evidenceIds:[]});
    await waitFor(`!!document.querySelector('[aria-label="整节改写对照"]')`);
    assert.equal(runtime.store.object(projectId,objectId).revision,2,'comparison remains unapplied');
    await evaluate(button('采用修改')+'.click()');
    await waitFor(button('撤回本次采用')+'?.disabled===false');
    await waitFor(`!document.querySelector('.rw-word-loading')&&!document.querySelector('iframe').inert`);
    assert.equal(await evaluate(nativeCommentResolved('1-1')),true);
    assert.equal(await evaluate(nativeCommentResolved('2-1')),false);
    await evaluate(`document.querySelector('iframe').contentWindow.wordcraft.execute('file.save',{})`);
    for(let tries=0;tries<150&&runtime.store.object(projectId,objectId).revision<4;tries++)await pause(80);
    assert.equal(runtime.store.object(projectId,objectId).revision,4,await evaluate('document.body.innerText'));
    const {path}=await runtime.wordEditing.source(projectId,objectId);
    const exported=(await promisify(execFile)('python',['-I','-X','utf8','-c',"import sys,zipfile;print(zipfile.ZipFile(sys.argv[1]).read('word/comments.xml').decode())",path],{windowsHide:true})).stdout;
    assert(exported.includes('已有的合成批注。')&&exported.includes('明确单位')&&exported.includes('说明计量口径'));
    const adopted=runtime.review.status({projectId,objectId}).findings.find(item=>item.id==='1-1');
    assert.deepEqual(await runtime.wordEditing.inspect({path,resolveReviewComments:[{...adopted,author:adopted.path.at(-1)}]}),
      {reviewCommentStates:['resolved'],changed:false});
    assert.deepEqual(await readFile(originalFile),original);
    await evaluate(button('审阅')+'.click()');
    await waitFor(`${findingState('1-1','adopted')}==='已解决'&&document.querySelector('[data-finding-id="1-1"]').open`);
    assert.equal(await evaluate(`document.querySelector('.rw-review-resolution-count').textContent.trim()`),'已解决 1/2 条');
    console.log(JSON.stringify({manuscriptAudit:true,reviewTemplates:7,draftPreserved:true,realWordcraftWasm:true,commentPaneOpened:true,commentsSurviveExport:true,chapterHandoff:true,humanAdopted:true,reviewResolved:true,originalPreserved:true}));
    }
    }
  }else if(chapterMode){
    await evaluate(`document.querySelector('.rw-word-scope-options input[value="chapter"]').click()`);
    const paragraph = n => ('第'+n+'段。这是合成文字，不是真实研究结论。').repeat(6);
    await evaluate(`document.querySelector('iframe').contentWindow.wordcraft.execute('select.range',{anchor:{story:'body',path:[15],off:0},focus:{story:'body',path:[17],off:${Buffer.byteLength(paragraph(17))}}})`);
    await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='使用 Word 选区').click()`);
    for(let i=0;i<200&&runtime.nativeWriting.snapshot(sessionId).input.conversationKind!=='chapter';i++)await pause(50);
    const active=runtime.nativeWriting.snapshot(sessionId);
    assert.equal(active.input.conversationKind,'chapter',await evaluate('document.body.innerText'));
    await runtime.nativeWriting.userTurn(sessionId,[{role:'user',content:[{type:'text',text:'合成验收：先写核心结论，再写背景。'}]}],{provider:'offline-probe',model:'no-model'},1);
    const context=await runtime.nativeWriting.readContext(sessionId,'合成');
    assert.deepEqual(context.paragraphs,[15,16,17].map(paragraph));
    const paragraphs=[context.paragraphs[2],context.paragraphs[0],context.paragraphs[1]];
    await runtime.nativeWriting.propose(sessionId,{selectionId:context.selectionId,paragraphs,reason:'将核心论点提前。',warnings:[],evidenceIds:[]});
    const waitFor=async expression=>{
      for(let i=0;i<200;i++){if(await evaluate(expression))return;await pause(50)}
      assert.fail(await evaluate('document.body.innerText'));
    };
    await waitFor(`document.querySelector('.rw-word-template')&&document.querySelector('.rw-word-module-status[data-state="ready"]')?.textContent.includes('当前小节')`);
    await evaluate(`document.querySelector('.rw-word-module-preview-toggle').click()`);
    assert(await evaluate(`!document.querySelector('.rw-word-template-preview').hidden`));
    await evaluate(`document.querySelector('.rw-word-module-preview-toggle').click()`);
    assert(await evaluate(`document.querySelector('.rw-word-template-preview').hidden`));
    const measureModules = () => evaluate(`(()=>{const pane=document.querySelector('.rw-word-sidebar');const modules=[...pane.querySelectorAll('.rw-word-conversation-document,.rw-word-scope,.rw-word-template')];const rects=modules.map(module=>module.getBoundingClientRect());const chat=pane.querySelector('[data-conversation-content]').getBoundingClientRect();const edge=pane.getBoundingClientRect().right;return{aligned:rects.every(rect=>Math.abs(rect.x-rects[0].x)<1&&Math.abs(rect.width-rects[0].width)<1),overflow:pane.scrollWidth-pane.clientWidth,overflowChildren:[...pane.querySelectorAll('*')].filter(node=>node.getBoundingClientRect().right>edge+1).slice(0,10).map(node=>node.getAttribute('class')||node.tagName),width:pane.clientWidth,chatHeight:chat.height,clip:{x:rects[0].x-5,y:rects[0].y-5,width:rects[0].width+10,height:rects[2].bottom-rects[0].y+10,scale:1}}})()`);
    const modules = await measureModules();
    assert(modules.aligned&&modules.overflow<=1&&modules.chatHeight>=300,JSON.stringify(modules));
    const image=await call('Page.captureScreenshot',{format:'png',clip:modules.clip});
    await writeFile(join(directory,'word-revision-modules.png'),Buffer.from(image.data,'base64'));
    await evaluate(`document.querySelector('.rw-word-sidebar').style.width='280px'`);
    const narrow = await measureModules();
    assert(narrow.aligned&&narrow.overflow<=1&&narrow.width<=280&&narrow.chatHeight>=300,JSON.stringify(narrow));
    await waitFor(`document.querySelector('[aria-label="左右对照与文献依据"]')?.disabled===false`);
    await evaluate(`document.querySelector('[aria-label="左右对照与文献依据"]').click()`);
    await waitFor(`!!document.querySelector('[aria-label="整节改写对照"]')`);
    await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.startsWith('采用修改')).click()`);
    await waitFor(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.startsWith('撤回本次采用')&&!b.disabled)`);
    await waitFor(`(async()=>{const info=await document.querySelector('iframe').contentWindow.wordcraft.uiInspect({});return info.documents?.length===1&&!document.querySelector('.rw-word-update-status')&&!document.querySelector('.rw-word-loading')})()`);
    assert.equal(runtime.store.object(projectId,objectId).revision,2);
    const visible=await evaluate(`(async()=>{const engine=document.querySelector('iframe').contentWindow.wordcraft;return (await engine.execute('document.text',{})).text})()`);
    assert(visible.indexOf(paragraph(17))<visible.indexOf(paragraph(15)));
    await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.startsWith('撤回本次采用')).click()`);
    await waitFor(`document.querySelector('[aria-label="改写对照与文献依据"]').textContent.includes('已撤回')&&!document.querySelector('iframe').inert`);
    assert.deepEqual((await runtime.store.asset(projectId,objectId)).bytes,original);
    console.log(JSON.stringify({chapter:true,paragraphs:3,sharedSession:true,review:true,adopted:true,undoRestoredOriginal:true,modules,narrow,directory}));
  }else if(reviewMode){
    await evaluate(`window.engine=document.querySelector('iframe').contentWindow.wordcraft; engine.execute('select.range',{anchor:{story:'body',path:[40],off:0},focus:{story:'body',path:[40],off:Math.min(90,new TextEncoder().encode('第40段。这是合成文字，不是真实研究结论。').length)}})`);
    await pause(250);
    const selectionStart=Date.now();await evaluate(`(()=>{window.pipeline=[];window.pipelineStart=performance.now();for(const method of ['uiInspect','execute']){const original=engine[method].bind(engine);engine[method]=async(...args)=>{const start=performance.now();try{return await original(...args)}finally{window.pipeline.push({stage:method==='execute'?args[0]:method,start,end:performance.now()})}}}document.querySelector('iframe').contentWindow.document.dispatchEvent(new Event('pointerup'))})()`);
    let selectionJob;for(let i=0;i<100;i++){const row=runtime.nativeWriting.findSession(sessionId);if(row&&!JSON.parse(row.input).conversationOnly){selectionJob=row;break}await pause(10)}assert(selectionJob,'selection bound');
    for(let i=0;i<80;i++){if(await evaluate(`document.querySelector('[aria-label="合成原生输入框"]')?.value.includes('第40段')`))break;await pause(10)}const promptReadyMs=Date.now()-selectionStart;const selectionTrace=await evaluate(`pipeline.map(p=>({stage:p.stage,start:Math.round(p.start-pipelineStart),ms:Math.round(p.end-p.start)}))`);assert(await evaluate(`document.querySelector('[aria-label="合成原生输入框"]')?.value.includes('第40段')`));
    const firstPromptReadyMs=promptReadyMs,warmPromptMs=[];
    for(const paragraph of[41,40]){
      await evaluate(`engine.execute('select.range',{anchor:{story:'body',path:[${paragraph}],off:0},focus:{story:'body',path:[${paragraph}],off:new TextEncoder().encode('第${paragraph}段。这是合成文字，不是真实研究结论。').length}})`);await pause(100);
      const start=Date.now();await evaluate(`document.querySelector('iframe').contentWindow.document.dispatchEvent(new Event('pointerup'))`);
      let ready=false;for(let i=0;i<120;i++){if(await evaluate(`document.querySelector('[aria-label="合成原生输入框"]')?.value.includes('第${paragraph}段')`)){ready=true;break}await pause(10)}assert(ready,'successive selection prompt linked');warmPromptMs.push(Date.now()-start);
    }
    selectionJob=runtime.nativeWriting.findSession(sessionId);
    await runtime.nativeWriting.userTurn(sessionId,[{role:'user',content:[{type:'text',text:'合成改写测试'}]}],{provider:'offline-probe',model:'no-model'},1);const context=await runtime.nativeWriting.readContext(sessionId,'');
    const proposalStart=Date.now();await runtime.nativeWriting.propose(sessionId,{selectionId:context.selectionId,replacement:'第40段。这里是待核对的合成修改建议。',reason:'软件验证',evidenceIds:[],warnings:[]});
    for(let i=0;i<80;i++){if(await evaluate(`document.querySelector('[aria-label="左右对照与文献依据"]')?.disabled===false`))break;await pause(10)}const reviewReadyMs=Date.now()-proposalStart;await evaluate(`document.querySelector('[aria-label="左右对照与文献依据"]').click()`);await pause(50);
    const beforeView=await evaluate('engine.uiInspect({})');assert(beforeView.pages[0][1]<-500,'the reader is away from the document start');
    const backgrounds=await evaluate(`Object.fromEntries(['unchanged','wording','structure','meaning'].map(kind=>{const card=document.createElement('div');card.className='rw-change-row';card.dataset.kind=kind;document.querySelector('.rw-app').append(card);const color=getComputedStyle(card).backgroundColor;card.remove();return[kind,color]}))`);assert.equal(new Set(Object.values(backgrounds)).size,4);
    await evaluate(`document.querySelector('[aria-label="编辑第 1 句建议"]').click()`);await pause(50);
    await evaluate(`(()=>{const t=document.querySelector('[aria-label="第 1 句改后文字"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'第40段。作者手动编辑后的合成建议。');t.dispatchEvent(new Event('input',{bubbles:true}))})()`);await pause(50);
    await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='保存本句').click()`);await pause(300);
    assert.equal(runtime.store.object(projectId,objectId).revision,1,'editing suggestions must not write Word');
    assert(JSON.parse(runtime.writing.row(projectId,selectionJob.id).output).proposal.replacement.includes('作者手动编辑'));
    for(let i=0;i<120;i++){if(await evaluate(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.startsWith('采用修改')&&!b.disabled)`))break;await pause(20)}
    assert(await evaluate(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.startsWith('采用修改')&&!b.disabled)`),'saved edit enables adoption');
    const adoptionStart=await evaluate('performance.now()'),start=Date.now();await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.startsWith('采用修改')).click()`);await pause(50);
    let savingView;for(let i=0;i<120;i++){
      savingView=await evaluate(`({fullOverlay:!!document.querySelector('.rw-word-loading'),status:!!document.querySelector('.rw-word-update-status'),completed:Array.from(document.querySelectorAll('button')).some(b=>b.textContent.startsWith('撤回本次采用'))})`);
      assert.equal(savingView.fullOverlay,false);if(savingView.status||savingView.completed)break;await pause(20);
    }assert(savingView.status||savingView.completed,'saving must show corner feedback or already be complete');
    for(let i=0;i<120;i++){const state=await evaluate(`({ready:!document.querySelector('iframe').inert&&Array.from(document.querySelectorAll('button')).some(b=>b.textContent.startsWith('撤回本次采用')&&!b.disabled)})`);if(state.ready)break;await pause(30)}
    const elapsed=Date.now()-start,afterView=await evaluate('engine.uiInspect({})'),afterSelection=await evaluate(`engine.execute('document.selection',{})`);
    assert.equal(afterView.document,beforeView.document,'adoption must not reopen the document');assert.deepEqual(afterSelection.anchor.path,[40]);assert(Math.abs(afterView.pages[0][1]-beforeView.pages[0][1])<5,'viewport must remain at the original paragraph');assert.equal(afterView.dirty,false);
    assert((await runtime.wordEditing.context(projectId,objectId)).includes('作者手动编辑后的合成建议'));
    const image=await call('Page.captureScreenshot',{format:'png'});await writeFile(join(directory,'review.png'),Buffer.from(image.data,'base64'));
    const revisionTrace=await evaluate(`pipeline.filter(p=>p.start>=${adoptionStart}).map(p=>({stage:p.stage,start:Math.round(p.start-${adoptionStart}),ms:Math.round(p.end-p.start)}))`);
    let glassUi;
    if(workbenchMode){
      glassUi=await evaluate(`(()=>{const a=document.querySelector('.rw-word-toolbar').getBoundingClientRect(),b=document.querySelector('.rw-word-sidebar>header').getBoundingClientRect();return{headerTopDelta:a.top-b.top,headerBottomDelta:a.bottom-b.bottom,accent:getComputedStyle(document.querySelector('.rw-app')).getPropertyValue('--rw-accent').trim(),frost:getComputedStyle(document.querySelector('.rw-topbar')).backdropFilter,saveBackground:getComputedStyle(document.querySelector('.rw-global-save')).backgroundImage}})()`);
      assert.equal(glassUi.headerTopDelta,0);assert.equal(glassUi.headerBottomDelta,0);assert.equal(glassUi.accent,'#174994');assert(glassUi.frost.includes('blur'));assert.equal(glassUi.saveBackground,'none');
      await evaluate(`document.querySelector('[aria-label="修改对话"]').click()`);await pause(180);
      const conversation=await evaluate(`(()=>{const bubble=document.querySelector('._bubble_1sgyj_1'),frame=document.querySelector('.rw-native-sentence-frame'),input=document.querySelector('[data-composer-card]');return{bubbleShadow:getComputedStyle(bubble).boxShadow,bubbleBackground:getComputedStyle(bubble).backgroundColor,frameBackground:getComputedStyle(frame).backgroundColor,composerRadius:getComputedStyle(input).borderRadius}})()`);
      assert.equal(conversation.bubbleShadow,'none');assert.equal(conversation.bubbleBackground,'rgb(237, 243, 250)');assert.equal(conversation.frameBackground,'rgb(248, 250, 252)');glassUi.conversation=conversation;
      const chatImage=await call('Page.captureScreenshot',{format:'png'});await writeFile(join(directory,'conversation.png'),Buffer.from(chatImage.data,'base64'));
      await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'},{name:'prefers-reduced-transparency',value:'reduce'}]});
      await evaluate(`document.querySelector('summary[aria-label="工作台与布局操作"]').click()`);await pause(50);
      const reduced=await evaluate(`({animation:getComputedStyle(document.querySelector('.rw-topbar .rw-action-menu-body')).animationName,blur:getComputedStyle(document.querySelector('.rw-topbar')).backdropFilter})`);
      assert.equal(reduced.animation,'none');assert.equal(reduced.blur,'none');glassUi.reduced=reduced;
    }
    const summary={realWordcraftWasm:true,realReactReview:true,model:'none: explicit synthetic proposal',firstPromptReadyMs,warmPromptMs,reviewReadyMs,selectionTrace,revisionTrace,serverTrace,backgrounds,savingView,elapsedMs:elapsed,sameDocumentId:afterView.document,paragraph:afterSelection.anchor.path,scrollDelta:afterView.pages[0][1]-beforeView.pages[0][1],wordRevision:runtime.store.object(projectId,objectId).revision,...(glassUi?{glassUi}:{})};
    await writeFile(join(directory,'result.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify({directory,...summary}));if(process.argv.includes('--enforce')){assert(Math.max(...warmPromptMs)<=600,'successive selection/prompt exceeded 600ms');assert(reviewReadyMs<=250,'review notification exceeded 250ms');assert(elapsed<=1500,'adoption exceeded 1500ms')}
  }else{
  for(const [index,plan]of[
    {action:'font',fontFamily:'宋体',latinFontFamily:'Times New Roman'},
    {action:'size',fontSizePt:12},
    {action:'align',alignment:'justify'},
    {action:'line_spacing',lineSpacing:1.5},
    {action:'paragraph_spacing',beforePt:0,afterPt:6},
    {action:'indents',firstLinePt:24},
    {action:'remove_extra_spaces'},
    {action:'remove_blank_paragraphs'},
    {action:'undo'},
    {action:'redo'},
  ].entries()){
    await runtime.nativeWriting.userTurn(sessionId,[{role:'user',content:[{type:'text',text:'合成测试：全文 '+plan.action}]}],{provider:'offline-probe',model:'no-model'},index+1);
    const context=await runtime.wordLive.context(sessionId);const result=await runtime.wordLive.edit(sessionId,{...plan,scope:'all',contextId:context.contextId,reason:'合成浏览器集成验收'});assert.equal(result.saved,true);if(plan.action==='remove_blank_paragraphs')assert(result.revision>context.revision,'blank paragraphs really removed');results.push({action:plan.action,revision:result.revision});
  }
  const finalContext=await runtime.wordLive.context(sessionId);assert(finalContext.text.includes('English words'));assert(!finalContext.text.includes('English  words'));
  const format=await evaluate(`document.querySelector('iframe').contentWindow.wordcraft.execute('document.selection',{})`);assert.equal(format.format.size,12);
  assert.deepEqual(await readFile(originalFile),original,'source manuscript is preserved');
  const history=await runtime.store.documentHistory.list(projectId,objectId);assert(history.entries.length>=10);
  const screenshot=await call('Page.captureScreenshot',{format:'png'});await writeFile(join(directory,'editor.png'),Buffer.from(screenshot.data,'base64'));
  const result={realWordcraftWasm:true,realReactEditor:true,model:'none: explicit synthetic tool calls',ui,results,originalPreserved:true,workingFile:JSON.parse(runtime.store.object(projectId,objectId).metadata).workspaceFile,historyEntries:history.entries.length,selectionFormat:format.format};
  await writeFile(join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({directory,...result}));
  }
}catch(error){await writeFile(join(directory,'failure.txt'),error.stack);throw error}
finally{try{if(ws?.readyState===1)ws.send(JSON.stringify({id:999999,method:'Browser.close'}))}catch{}ws?.close();browser?.kill();server?.closeAllConnections();await new Promise(resolve=>server?server.close(resolve):resolve());await runtime.dispose()}
