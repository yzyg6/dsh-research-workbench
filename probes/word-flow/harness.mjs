/** Offline component + business integration. No desktop/browser/model automation. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {getEventListeners} from 'node:events';
import {WorkspaceRuntime} from '../../src/server/runtime.mjs';
import {NativeSentenceAdapter} from '../../src/client/native-sentence-adapter.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),out=join(root,'_scratch/out/word-flow');await mkdir(out,{recursive:true});
const require=createRequire(join(root,'_scratch/tmp/ui-deps/package.json')),React=require('react'),{create,act}=require('react-test-renderer');
const esbuild=require('esbuild'),reactPath=require.resolve('react'),compiled=join(out,'ui.cjs');
esbuild.buildSync({stdin:{contents:`export {WordEditor} from ${JSON.stringify(join(root,'src/client/WordEditor.jsx'))};export {NativeSentenceBody} from ${JSON.stringify(join(root,'src/client/entry.jsx'))};`,resolveDir:root,loader:'jsx'},outfile:compiled,bundle:true,platform:'node',format:'cjs',loader:{'.css':'text'},alias:{react:reactPath},external:[reactPath],nodePaths:[join(root,'_scratch/tmp/ui-deps/node_modules'),join(root,'_scratch/tmp/editor-deps/node_modules')],logLevel:'silent'});
const {WordEditor,NativeSentenceBody}=createRequire(import.meta.url)(compiled),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export const sid='session-00000000-1111-2222-3333-444444444444';
const textOf=node=>typeof node==='string'?node:(node?.children||[]).map(textOf).join('');
const visible=node=>{for(let current=node;current;current=current.parent)if(current.props?.hidden)return false;return true};
// Node's EventTarget does not normalize boolean capture on removal as browsers do.
class DomEvents extends EventTarget{removeEventListener(type,callback,options){super.removeEventListener(type,callback,typeof options==='boolean'?{capture:options}:options)}}

export async function wordFlow(t){
  const directory=await mkdtemp(join(out,'case-')),workspace=join(directory,'workspace'),file=join(workspace,'paper','synthetic.docx');
  await promisify(execFile)('python',['-I',join(root,'probes/word-reader/create-fixture.py'),'--output',file,'--paragraphs','3'],{windowsHide:true});
  const runtime=new WorkspaceRuntime({root:join(directory,'catalog'),sampleRoot:join(root,'samples/figure'),publicRoot:join(root,'public')});
  const projectId=await runtime.store.openWorkspace({path:workspace}),objectId=(await runtime.store.state()).projects[0].objects.find(o=>o.title==='synthetic.docx').id;
  runtime.nativeWriting.validateSession=async session=>assert.equal(session,sid);
  let attachments=0,created=0,retained=0,released=0;
  runtime.nativeWriting.attachSession=async session=>{assert.equal(session,sid);attachments++};
  runtime.writing.evidence.zotero={search:async()=>{throw Error('Explicit offline Zotero service double')}};
  await writeFile(join(workspace,'reference','合成验证说明.md'),'# 合成测试材料\n\nWord 阅读验证只用于软件检查；不是研究证据，不应用于论文结论。');
  const initial=await runtime.nativeWriting.open({projectId,objectId});await runtime.nativeWriting.bind({projectId,jobId:initial,sessionId:sid});
  const adapter=new NativeSentenceAdapter({mutate:async(action,data)=>runtime.mutate(action,data)});
  adapter.setSessions({refresh:async()=>{},create:async()=>{created++;return sid},retain:()=>{retained++;return{ready:Promise.resolve(),release(){released++}}}});
  const previous=Object.fromEntries(['window','document','location','fetch','IS_REACT_ACT_ENVIRONMENT'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const win=new DomEvents(),doc=new DomEvents(),frameDoc=new DomEvents();frameDoc.activeElement={blur(){}};
  Object.assign(globalThis,{window:win,document:doc,location:{origin:'https://offline.invalid'},fetch:async()=>{const bytes=(await runtime.store.asset(projectId,objectId)).bytes;return{ok:true,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)}},IS_REACT_ACT_ENVIRONMENT:true});
  let renderer,update,documentId=0,selection={anchor:{story:'body',path:[0],off:0},focus:{story:'body',path:[0],off:0},text:''},opens=0,frames=0,saveCallback,modelOperation,contextResult;
  let input={draft:'',phase:'plain',model:'offline-model-A'},version=0;const listeners=new Set(),messages=[],steps=[];
  const changeInput=patch=>{input={...input,...patch};version++;for(const fn of listeners)fn()};
  const actions={setDraft:draft=>changeInput({draft}),persistDraft:()=>{},submit:()=>{
    if(input.phase!=='plain'||!input.draft.trim())return;
    const instruction=input.draft,model=input.model;messages.push({role:'user',content:[{type:'text',text:instruction}]});changeInput({draft:'',phase:'running'});
    modelOperation=(async()=>{
      await runtime.nativeWriting.userTurn(sid,[messages.at(-1)],{provider:'offline-script',model},messages.length);
      contextResult=await runtime.nativeWriting.readContext(sid,'Word');steps.push({step:'context',selectionId:contextResult.selectionId,fullArticle:contextResult.article,evidence:contextResult.evidence,instruction:contextResult.instruction});
      await runtime.nativeWriting.propose(sid,{selectionId:contextResult.selectionId,replacement:'合成 Word 阅读验证',reason:'显式离线脚本建议，仅检查软件流程。',evidenceIds:[],warnings:['合成文献不能支持真实研究结论。']});
      await runtime.nativeWriting.idle(sid);await publish();messages.push({role:'assistant',content:[{type:'text',text:'离线建议已保存'}]});changeInput({phase:'plain'});
    })();
  }};
  function Native(info){
    React.useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>version);
    return React.createElement(NativeSentenceBody,{sessionId:sid,jobId:info.job.id,conversationOnly:info.job.conversationOnly,selectedText:info.job.original,selectionPending:info.selectionPending,autoSelectionDraft:info.autoSelectionDraft,useSession:()=>({}),useConversation:()=>({}),useInput:()=>input,useWorkspaces:()=>({items:[{sessionIds:[sid]}]}),inputActions:actions,renderFactorySlot:()=>React.createElement('div',{'data-conversation-content':true},React.createElement('select',{'aria-label':'测试替身模型选择器',value:input.model,onChange:event=>changeInput({model:event.target.value})},React.createElement('option',{value:'offline-model-A'},'A'),React.createElement('option',{value:'offline-model-B'},'B')),React.createElement('textarea',{'aria-label':'测试替身原生输入框',value:input.draft,onChange:event=>actions.setDraft(event.target.value)}),React.createElement('button',{onClick:actions.submit},'测试替身发送'))});
  }
  let viewJobId=initial;
  async function publish(){const state=await runtime.viewState();if(update)update(state);return state}
  async function ensure(id){const state=await runtime.viewState(),project=state.projects.find(p=>p.id===projectId);await adapter.ensure(project,project.jobs.find(j=>j.id===id))}
  const sentence={onNativePrepare:async({wordSelection})=>{const id=await runtime.nativeWriting.prepare({projectId,objectId,expectedRevision:runtime.store.object(projectId,objectId).revision,wordSelection});await ensure(id);await publish();steps.push({step:'selection',id});return id},onNativeOpen:async id=>{viewJobId=id;if(id)await runtime.nativeWriting.activate({projectId,jobId:id});await publish()},onOpenConversation:async options=>{const id=await runtime.nativeWriting.open({projectId,objectId,...options});await ensure(id);await publish();return id},onAction:async(action,jobId)=>{await runtime.mutate(action,{projectId,jobId});steps.push({step:action,revision:runtime.store.object(projectId,objectId).revision});await publish()},onRefresh:publish,nativeRender:info=>React.createElement(Native,info)};
  const api={wordcraftAssets:()=>new Promise(()=>{}),assetUrl:()=>'/synthetic.docx',mutate:action=>action==='prepareWordEdit'?Promise.resolve({actionResult:{chineseFont:'Noto Sans CJK SC',fontFamilies:[]}}):action==='systemFonts'?Promise.resolve({actionResult:[]}):action==='reviewReminders'?Promise.resolve({actionResult:{reminders:[]}}):new Promise(()=>{}),saveWord:async()=>{throw Error('Unexpected Word export: no manual edits in this scenario')}};
  const frame={inert:false,contentDocument:frameDoc,contentWindow:{document:frameDoc,postMessage(data){if(data.type==='wordcraft:open'){documentId++;opens++}}}};
  frame.contentWindow.wordcraft={uiInspect:async()=>({document:documentId,documents:[documentId],dirty:false,ui:{ribbonCollapsed:true}}),execute:async name=>{if(name==='document.selection')return structuredClone(selection);if(name==='file.close'||name==='ui.backstage'||name==='view.zoom')return;throw Error('Unexpected engine command '+name)}};
  function Harness(){const [state,setState]=React.useState(null);update=setState;const project=state?.projects.find(p=>p.id===projectId);return project?React.createElement(WordEditor,{api,project,object:project.objects.find(o=>o.id===objectId),sentence:{...sentence,jobs:project.jobs,initialNativeJobId:viewJobId},registerSave:callback=>{saveCallback=callback;return()=>{saveCallback=null}},onDirty:()=>{},onSaved:setState}):null}
  t.after(async()=>{
    try{
      if(renderer)await act(async()=>renderer.unmount());
      for(const target of [win,doc,frameDoc])for(const name of ['pointerdown','pointerup','keydown','keyup','blur','resize','message'])assert.equal(getEventListeners(target,name).length,0,`listener leaked: ${name}`);
      adapter.dispose();assert.equal(released,retained);
      await writeFile(join(directory,'cleanup.json'),JSON.stringify({listenersAfterUnmount:0,nativeLeasesReleased:released,frames,documentOpens:opens}));
    }finally{adapter.dispose();await runtime.dispose();for(const [key,value]of Object.entries(previous)){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key]}}
  });
  await ensure(initial);
  await act(async()=>{renderer=create(React.createElement(Harness),{createNodeMock:element=>{if(element.type==='iframe'){frames++;return frame}return element.type==='details'?{open:false,contains:()=>false}:null}})});
  await act(async()=>{await publish()});
  await act(async()=>{const event=new Event('message');Object.defineProperties(event,{source:{value:frame.contentWindow},origin:{value:location.origin},data:{value:{type:'wordcraft:ready'}}});win.dispatchEvent(event);await pause(150)});
  const all=()=>JSON.stringify(renderer.toJSON());
  const settle=async predicate=>{for(let n=0;n<850;n++){await act(async()=>{await pause(35)});const conversation=renderer.root.findAllByProps({className:'rw-native-sentence-conversation'})[0];if(predicate()&&!frame.inert&&!conversation?.props.inert)return}throw Error('Offline flow did not settle: '+all().slice(-1800))};
  const button=(label)=>renderer.root.findAll(node=>node.type==='button'&&visible(node)&&(node.props['aria-label']===label||textOf(node).includes(label)))[0];
  const click=async label=>{const node=button(label);assert(node,`button missing: ${label}`);assert(!node.props.disabled,`button disabled: ${label}`);await act(async()=>{node.props.onClick({})});};
  return{runtime,projectId,objectId,file,directory,workspace,renderer,frame,steps,messages,button,click,all,settle,input:()=>input,context:()=>contextResult,runModel:()=>modelOperation,counts:()=>({created,retained,released,attachments,opens,frames}),type:async text=>act(async()=>actions.setDraft(text)),chooseModel:async model=>act(async()=>changeInput({model})),submit:async()=>act(async()=>{const event=new Event('keydown',{cancelable:true});Object.defineProperties(event,{key:{value:'Enter'},ctrlKey:{value:true},altKey:{value:true}});win.dispatchEvent(event);await modelOperation}),select:async()=>{const text=(await runtime.wordEditing.context(projectId,objectId)).split('\n')[0];selection={anchor:{story:'body',path:[0],off:0},focus:{story:'body',path:[0],off:Buffer.byteLength(text,'utf8')},text};await act(async()=>{frameDoc.dispatchEvent(new Event('pointerup'));await pause(110)});await settle(()=>all().includes('已关联当前选句'));return text},publish:async()=>act(publish),save:()=>saveCallback?.()};
}
