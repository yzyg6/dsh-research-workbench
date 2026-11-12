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
const reviewMode=process.argv.includes('--review'),workbenchMode=process.argv.includes('--workbench');
const root=fileURLToPath(new URL('../../',import.meta.url)),out=join(root,reviewMode?'_scratch/out/word-review-browser':'_scratch/out/word-live-browser');await mkdir(out,{recursive:true});const directory=await mkdtemp(join(out,'case-'));
const runtime=new WorkspaceRuntime({root:join(directory,'catalog'),sampleRoot:join(root,'samples/figure'),publicRoot:join(root,'public'),trustedTransport:false});
const projectId=await runtime.store.createProject({title:'Word 实时编辑合成验收'}),workspace=runtime.store.project(projectId).root_path,originalFile=join(workspace,'paper','synthetic.docx');
await promisify(execFile)('python',['-I',join(root,'probes/word-edit/create-format-fixture.py'),originalFile],{windowsHide:true});
await promisify(execFile)('python',['-I','-c',"import sys,zipfile; p=sys.argv[1]; z=zipfile.ZipFile(p); members={n:z.read(n) for n in z.namelist()}; z.close(); members['word/document.xml']=members['word/document.xml'].replace(b'<w:tbl>',b'<w:p/><w:p/><w:tbl>'); z=zipfile.ZipFile(p,'w',zipfile.ZIP_DEFLATED); [z.writestr(n,b) for n,b in members.items()]; z.close()",originalFile],{windowsHide:true});
if(reviewMode)await promisify(execFile)('python',['-I',join(root,'probes/word-reader/create-fixture.py'),'--output',originalFile,'--paragraphs','80'],{windowsHide:true});
const original=await readFile(originalFile),objectId=await runtime.store.importWorkspaceFile({projectId,path:'paper/synthetic.docx',openOriginal:true});
if(workbenchMode)await runtime.store.saveTaskState({projectId,task:'writing',patch:{selectedObjectId:objectId}});
runtime.nativeWriting.validateSession=async()=>{};runtime.nativeWriting.attachSession=async()=>{};
const jobId=await runtime.nativeWriting.open({projectId,objectId}),sessionId='session-00000000-1111-2222-3333-444444444444';await runtime.nativeWriting.bind({projectId,jobId,sessionId});
if(reviewMode)runtime.writing.evidence={retrieve:async()=>({sources:[],terms:[],warnings:[],local:'offline-probe',zotero:'offline-probe'})};
const require=createRequire(join(root,'_scratch/tmp/ui-deps/package.json')),esbuild=require('esbuild'),bundle=join(directory,'probe.js');
esbuild.buildSync({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {WordEditor} from './src/client/WordEditor.jsx';import {NativeSentenceBody} from './src/client/entry.jsx';import {createApi} from './src/client/api.mjs';import base from './src/client/workbench.css';import revision from './src/client/revision-tools.css';import compact from './src/client/compact-layout.css';import refined from './src/client/refined-workbench.css';import glass from './src/client/glass-workbench.css';import {App} from './src/client/App.jsx';
const api=createApi(),projectId=${JSON.stringify(projectId)},objectId=${JSON.stringify(objectId)};
const mutateMeasured=api.mutate.bind(api);api.mutate=async(action,data)=>{const start=performance.now();try{return await mutateMeasured(action,data)}finally{window.pipeline?.push({stage:action,start,end:performance.now()})}};
function Native(info){const[draft,setDraft]=React.useState('');return <div className="rw-native-sentence-frame" style={{height:'100%'}}><NativeSentenceBody sessionId=${JSON.stringify(sessionId)} jobId={info.job.id} autoSelectionDraft={info.autoSelectionDraft} selectedText={info.job.original} conversationOnly={info.job.conversationOnly||['adopted','undone'].includes(info.job.output?.review)} selectionPending={info.selectionPending} useSession={()=>({})} useConversation={()=>({})} useInput={()=>({draft,phase:'plain'})} useWorkspaces={()=>({items:[{sessionIds:[${JSON.stringify(sessionId)}]}]})} inputActions={{setDraft:text=>{window.pipeline?.push({stage:'draft',start:performance.now(),end:performance.now()});setDraft(text)},persistDraft(){},submit(){throw Error('The probe never submits a model request')}}} renderFactorySlot={()=><div data-conversation-content style={{height:'100%',display:'flex',flexDirection:'column'}}><div data-conversation-region="messages" style={{flex:1,overflow:'auto',paddingTop:24}}><small style={{color:'#617087'}}>合成对话 · 界面验证</small><div className="_bubble_1sgyj_1" style={{margin:'18px 0'}}>请帮我核对当前选句，保持术语和引用不变。</div><article className="_markdown_rve47_5"><p>已保留当前文稿上下文。你可以继续调整修改要求，在对照中编辑建议后采用。</p><p>字体、排版和空白清理也可以直接在这里提出。</p></article></div><div data-composer-card style={{margin:'12px 16px',padding:12}}><textarea data-composer-input aria-label="合成原生输入框" value={draft} onChange={e=>setDraft(e.target.value)} style={{width:'100%',minHeight:110,border:0,resize:'none'}}/><div style={{display:'flex',justifyContent:'space-between',color:'#617087',fontSize:11,marginTop:8}}><span>＋　合成测试 · 无模型调用</span><button disabled aria-label="合成发送按钮">↑</button></div></div></div>}/></div>}
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
  if(reviewMode){
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
