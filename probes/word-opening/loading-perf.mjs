/** Headless, isolated Word loading and outage-recovery test. Never attaches to DSH. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {WorkspaceRuntime} from '../../src/server/runtime.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),out=join(root,'_scratch/out/word-loading-performance');await mkdir(out,{recursive:true});
const directory=await mkdtemp(join(out,'case-')),runtime=new WorkspaceRuntime({root:join(directory,'catalog'),sampleRoot:join(root,'samples/figure'),publicRoot:join(root,'public'),trustedTransport:false});
const projectId=await runtime.store.createProject({title:'合成 Word 加载验收'}),objects=[];
for(const name of ['synthetic-A.docx','synthetic-B.docx']){await promisify(execFile)('python',['-I',join(root,'probes/word-reader/create-fixture.py'),'--output',join(runtime.store.project(projectId).root_path,'paper',name),'--paragraphs','40'],{windowsHide:true});objects.push(await runtime.store.importWorkspaceFile({projectId,path:'paper/'+name,openOriginal:true}));}
await runtime.store.saveTaskState({projectId,task:'writing',patch:{selectedObjectId:objects[0]}});
const panelMode=process.argv.includes('--panel');
const panelBundle=join(directory,'panel.js');
if(panelMode){
 const require=createRequire(join(root,'_scratch/tmp/ui-deps/package.json'));
 require('esbuild').buildSync({stdin:{resolveDir:root,loader:'jsx',contents:`
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {App} from './src/client/App.jsx';
  import {createApi} from './src/client/api.mjs';
  const api=createApi();
  function Host(){const [open,setOpen]=React.useState(true);return open?<App api={api} onLeave={()=>setOpen(false)}/>:<button id="reopen" onClick={()=>setOpen(true)}>科研工作台</button>}
  createRoot(document.getElementById('root')).render(<Host/>);
 `},bundle:true,format:'esm',minify:true,loader:{'.css':'text'},nodePaths:[join(root,'_scratch/tmp/ui-deps/node_modules'),join(root,'_scratch/tmp/editor-deps/node_modules')],outfile:panelBundle});
}
const events=[],requests=[];const diagnostic=runtime.recordDiagnostic.bind(runtime);runtime.recordDiagnostic=async(name,data)=>{if(name==='word-editor-latest')events.push(data);return diagnostic(name,data)};
let browser,ws,server,failPoll=false,failedPoll=false;const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
 server=createServer(async(incoming,outgoing)=>{const abort=new AbortController();outgoing.on('close',()=>abort.abort());try{
  if((panelMode||process.env.RESEARCH_PROBE_BUNDLE)&&incoming.url==='/api/research-workbench/app.js'){outgoing.writeHead(200,{'content-type':'text/javascript'}).end(await readFile(panelMode?panelBundle:process.env.RESEARCH_PROBE_BUNDLE));return}
  const chunks=[];for await(const chunk of incoming)chunks.push(chunk);const body=Buffer.concat(chunks);let action;try{action=JSON.parse(body.toString()).action}catch{}
  if(failPoll&&action==='poll'&&incoming.url.endsWith('/word-control')){failPoll=false;failedPoll=true;outgoing.writeHead(503).end('<html>Temporary synthetic outage</html>');return}
  const start=performance.now(),response=await runtime.handle(new Request(`http://127.0.0.1:${server.address().port}${incoming.url}`,{method:incoming.method,headers:incoming.headers,signal:abort.signal,...(body.length?{body}:{})}));const bytes=Buffer.from(await response.arrayBuffer());
  requests.push({url:incoming.url,action,ms:Math.round(performance.now()-start),bytes:bytes.length,status:response.status});outgoing.writeHead(response.status,Object.fromEntries(response.headers));outgoing.end(bytes);
 }catch(error){if(!outgoing.destroyed)outgoing.writeHead(500).end(error.message)}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--remote-debugging-port=0',`--user-data-dir=${join(directory,'edge-profile')}`,'--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-first-run','--disable-background-timer-throttling','about:blank'],{windowsHide:true,stdio:'ignore'});
 let port;for(let i=0;i<100;i++){try{port=Number((await readFile(join(directory,'edge-profile/DevToolsActivePort'),'utf8')).split('\n')[0]);if(port)break}catch{}await pause(100)}assert(port);
 const page=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p=>p.type==='page');ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});let seq=0;const pending=new Map(),errors=[];
 ws.onmessage=event=>{const item=JSON.parse(event.data),p=pending.get(item.id);if(p){clearTimeout(p.timer);pending.delete(item.id);item.error?p.reject(Error(JSON.stringify(item.error))):p.resolve(item.result)}else if(item.method==='Runtime.exceptionThrown')errors.push(item.params.exceptionDetails.text)};
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timed out: '+method))},20000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}))});
 const evaluate=async expression=>{const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value};
 await call('Runtime.enable');await call('Emulation.setDeviceMetricsOverride',{width:1440,height:960,deviceScaleFactor:1,mobile:false});await call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/api/research-workbench/app`});
 const waitReady=async count=>{for(let i=0;i<400;i++){if(events.filter(e=>e.stage==='ready').length>=count)return;await pause(100)}throw Error('Word failed to become ready: '+await evaluate('document.body.innerText'))};
 await waitReady(1);await evaluate(`Array.from(document.querySelectorAll('.rw-resource')).find(b=>b.title==='synthetic-B.docx').click()`);await waitReady(2);
 failPoll=true;for(let i=0;i<50&&!failedPoll;i++)await pause(50);assert(failedPoll);await pause(1300);
 const bannerStuck=await evaluate(`document.querySelector('.rw-word-editor')?.textContent.includes('工作台连接暂未恢复') || !!document.querySelector('[data-word-connection="offline"]')`);
 if(process.argv.includes('--resume')){
  const before=await evaluate(`(async()=>{
    const frame=document.querySelector('.rw-word-frame'),engine=frame.contentWindow.wordcraft;
    await engine.execute('view.zoom',{value:120});
    ${panelMode?`const caret={story:'body',path:[15],off:0};await engine.execute('select.range',{anchor:caret,focus:caret});await engine.execute('text.insert',{text:'验收',raw:true});`:''}
    const info=await engine.uiInspect({}),rect=info.canvasRect;
    await engine.request('ui.wheel',{x:rect[0]+rect[2]*0.3,y:rect[1]+rect[3]*0.6,dy:-1800,unit:'point'});
    await new Promise(resolve=>setTimeout(resolve,600));
    frame.contentDocument.dispatchEvent(new Event('wheel'));
    const view=await engine.uiInspect({});
    return {top:view.pages[0][1],pageCount:view.pages.length,rect,zoom:view.view.zoom};
  })()`);
  assert(before.top < -500 && before.top > -6500, 'fixture is in the middle of the document: '+JSON.stringify(before));
  if(panelMode){
   await evaluate(`document.querySelector('button[aria-label="返回 DSH"]').click()`);
   for(let i=0;i<100&&!await evaluate(`!!document.querySelector('#reopen')`);i++)await pause(100);
   assert(await evaluate(`!!document.querySelector('#reopen')`),'exit finished saving');
   assert.equal(runtime.store.object(projectId,objects[1]).revision,2);
   await evaluate(`document.querySelector('#reopen').click()`);
  }else{await pause(400);await call('Page.reload')}
  await waitReady(3);
  const resumed=await evaluate(`(async()=>{
    const info=await document.querySelector('.rw-word-frame').contentWindow.wordcraft.uiInspect({});
    const selection=await document.querySelector('.rw-word-frame').contentWindow.wordcraft.execute('document.selection',{});
    return {top:info.pages[0][1],zoom:info.view.zoom,title:document.querySelector('.rw-word-document-title strong').textContent,caret:selection.focus};
  })()`);
  assert(resumed.title.startsWith('synthetic-B'),JSON.stringify(resumed));
  assert(Math.abs(resumed.zoom-1.2)<0.01,JSON.stringify(resumed));
  assert(Math.abs(resumed.top-before.top)<15,JSON.stringify({before,resumed}));
  if(panelMode)assert.deepEqual(resumed.caret.path,[15]);
  console.log(JSON.stringify({before,resumed}));
 }
 const report={label:process.argv.includes('--before')?'before':'after',directory,headless:true,syntheticOnly:true,readyMs:events.filter(e=>e.stage==='ready').map(e=>Math.round(e.bootMs)),assetRequests:requests.filter(r=>r.url.includes('/wordcraft/')).length,fontRequests:requests.filter(r=>r.url.includes('systemFont=')).length,prepareMs:requests.filter(r=>r.action==='prepareWordEdit').map(r=>r.ms),bannerStuck,errors};
 await writeFile(join(out,(process.argv.includes('--resume')?'resume':report.label)+'.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));assert.deepEqual(errors,[]);if(!process.argv.includes('--before')){assert.equal(bannerStuck,false);assert.equal(report.assetRequests,3)}await call('Browser.close');
}finally{ws?.close();if(browser?.exitCode===null)browser.kill();server?.closeAllConnections();server?.close();await runtime.dispose()}
