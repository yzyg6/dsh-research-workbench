import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),out=join(root,'_scratch/out/word-selection-tests');await mkdir(out,{recursive:true});
const require=createRequire(join(root,'_scratch/tmp/ui-deps/package.json')),React=require('react'),{create,act}=require('react-test-renderer'),esbuild=require('esbuild');
const file=join(out,'component.cjs'),reactPath=require.resolve('react');
esbuild.buildSync({entryPoints:[join(root,'src/client/WordEditor.jsx')],outfile:file,bundle:true,platform:'node',format:'cjs',loader:{'.css':'text'},alias:{react:reactPath},external:[reactPath],nodePaths:[join(root,'_scratch/tmp/ui-deps/node_modules'),join(root,'_scratch/tmp/editor-deps/node_modules')],logLevel:'silent'});
const nativeFile=join(out,'native.cjs');
esbuild.buildSync({entryPoints:[join(root,'src/client/entry.jsx')],outfile:nativeFile,bundle:true,platform:'node',format:'cjs',loader:{'.css':'text'},alias:{react:reactPath},external:[reactPath],nodePaths:[join(root,'_scratch/tmp/ui-deps/node_modules'),join(root,'_scratch/tmp/editor-deps/node_modules')],logLevel:'silent'});
const {WordEditor}=createRequire(import.meta.url)(file),{NativeSentenceBody}=createRequire(import.meta.url)(nativeFile),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function mount(t,{prepare,discussion,backstage=false,resize=false}={}){
  const previous=Object.fromEntries(['window','document','location','fetch','IS_REACT_ACT_ENVIRONMENT','ResizeObserver','requestAnimationFrame','cancelAnimationFrame','innerWidth'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const win=new EventTarget(),doc=new EventTarget(),frameDoc=new EventTarget();frameDoc.activeElement={blur(){}};
  Object.assign(globalThis,{window:win,document:doc,location:{origin:'https://synthetic.invalid'},fetch:async()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(1)}),IS_REACT_ACT_ENVIRONMENT:true});
  const resizeFrames=new Map(),sidebarNode={style:{}},boardNode={clientWidth:1000,dataset:{}};let resizeFrameId=0,nativeRenders=0;
  if(resize)Object.assign(globalThis,{innerWidth:1068,ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame:callback=>{resizeFrames.set(++resizeFrameId,callback);return resizeFrameId},cancelAnimationFrame:id=>resizeFrames.delete(id)});
  let zoom=180,documentId=0,documentDirty=false,saves=0,backstagePage='home',selection={anchor:{para:0,off:0},focus:{para:0,off:0},text:''},calls=0,renderer;
  const send=data=>{const event=new Event('message');Object.defineProperties(event,{source:{value:frame.contentWindow},origin:{value:location.origin},data:{value:data}});win.dispatchEvent(event)};
  const engine={uiInspect:async()=>({document:documentId,documents:[documentId],dirty:documentDirty,view:{zoom:zoom/100,fit:''},ui:{ribbonCollapsed:true,backstage,backstagePage}}),execute:async(name,args)=>{if(name==='view.zoom'){zoom=args.value;return}if(name==='document.selection')return structuredClone(selection);if(name==='ui.backstage'){backstage=args.value;if(args.page)backstagePage=args.page;return}if(name==='file.close')return;if(name==='file.save'){documentDirty=false;queueMicrotask(()=>send({type:'wordcraft:save',name:'synthetic.docx',bytes:new ArrayBuffer(1)}));return}throw Error('Unexpected command '+name)}};
  const frame={inert:false,contentDocument:frameDoc,contentWindow:{wordcraft:engine,document:frameDoc,postMessage(data){if(data.type==='wordcraft:open'){documentId++;zoom=180}}}};
  const props={api:{mutate:action=>action==='prepareWordEdit'?Promise.resolve({actionResult:{chineseFont:'Noto Sans CJK SC',fontFamilies:[]}}):action==='systemFonts'?Promise.resolve({actionResult:[]}):action==='reviewReminders'?Promise.resolve({actionResult:{reminders:[]}}):new Promise(()=>{}),wordcraftAssets:()=>new Promise(()=>{}),assetUrl:()=>'/synthetic.docx',saveWord:async()=>{saves++;return {projects:[{id:'p_test',objects:[{id:'o_test',revision:2}]}]}}},project:{id:'p_test',title:'合成选句测试',writingConversations:[]},object:{id:'o_test',title:'synthetic.docx',revision:1},registerSave:()=>()=>{},onDirty:()=>{},onSaved:()=>{},sentence:{initialNativeJobId:'j_whole',jobs:[{id:'j_whole',objectId:'o_test',conversationOnly:true}],nativeRender:()=>React.createElement('span',null,'native-conversation-test-double'),onNativePrepare:async args=>{calls++;return prepare?prepare(args):'j_selected'},onNativeOpen:async()=>{},onRefresh:async()=>{}}};
  if(discussion){props.sentence.initialNativeJobId=null;props.sentence.jobs=[];props.sentence.onOpenConversation=discussion}
  t.after(async()=>{if(renderer)await act(async()=>renderer.unmount());for(const [key,value] of Object.entries(previous)){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key]}});
  const nativeRender=props.sentence.nativeRender;props.sentence.nativeRender=info=>{nativeRenders++;return nativeRender(info)};
  await act(async()=>{renderer=create(React.createElement(WordEditor,props),{createNodeMock:element=>element.type==='iframe'?frame:element.type==='details'?{open:false,contains:()=>false}:resize&&element.props.className==='rw-word-layout'?boardNode:resize&&element.props.className==='rw-word-sidebar'?sidebarNode:null})});
  await act(async()=>{send({type:'wordcraft:ready'});await pause(140)});
  return {resizeFrames,sidebarNode,boardNode,nativeRenders:()=>nativeRenders,zoom:()=>zoom,setZoom:value=>{zoom=value},renderer,frame,props,rerender:async()=>act(async()=>renderer.update(React.createElement(WordEditor,props))),backstage:()=>backstage,filePage:(page='home')=>{backstage=true;backstagePage=page},key:async key=>{const event=new Event('keydown',{cancelable:true});Object.defineProperties(event,{key:{value:key},ctrlKey:{value:true}});await act(async()=>{frameDoc.dispatchEvent(event);await pause(0)});return event},edit:()=>{documentDirty=true},saves:()=>saves,select:value=>{selection=value},calls:()=>calls,pointer:async()=>act(async()=>{frameDoc.dispatchEvent(new Event('pointerup'));await pause(110)}),text:()=>JSON.stringify(renderer.toJSON())};
}
const selected={anchor:{para:0,off:0},focus:{para:0,off:12},text:'当前选中的句子。'};

test('Word visibly distinguishes originals from workspace versions and lists only conversations owned by this file',async t=>{
  const view=await mount(t);assert(view.text().includes('原稿'));
  view.props.object.metadata={wordEditable:true,workspaceFile:'paper/当前_工作台.docx'};
  view.props.project.writingConversations=[{sessionId:'same-1',objectId:'o_test'},{sessionId:'foreign',objectId:'o_other'},{sessionId:'same-2',objectId:'o_test'}];await view.rerender();
  assert(view.text().includes('工作区版本'));
  const choices=view.renderer.root.findByProps({'aria-label':'切换论文修改对话'}).findAllByType('option').map(option=>option.props.value);
  assert.deepEqual(choices,['','same-1','same-2']);assert(view.renderer.root.findByProps({className:'rw-word-conversation-document'}).props.title.includes('当前_工作台.docx'));
});

test('native prompt templates fill the chosen scientific instruction without sending or overwriting authored input',async t=>{
  const previous=Object.fromEntries(['window','IS_REACT_ACT_ENVIRONMENT'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  Object.assign(globalThis,{window:new EventTarget(),IS_REACT_ACT_ENVIRONMENT:true});
  let draft='',submitted=0,renderer;
  const props={sessionId:'s_templates',jobId:'j_templates',selectedText:'合成原句。',useSession:()=>({}),useConversation:()=>({}),useInput:()=>({draft,phase:'plain'}),useWorkspaces:()=>({items:[{sessionIds:['s_templates']}]}),inputActions:{setDraft:text=>{draft=text},persistDraft:()=>{},submit:()=>{submitted++}},renderFactorySlot:()=>React.createElement('div',null,'synthetic-native')};
  t.after(async()=>{if(renderer)await act(async()=>renderer.unmount());for(const [key,value]of Object.entries(previous)){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key]}});
  await act(async()=>{renderer=create(React.createElement(NativeSentenceBody,props))});
  await act(async()=>renderer.root.findByProps({'aria-label':'修改提示词模板'}).props.onChange({target:{value:'concise'}}));
  const fill=()=>renderer.root.findAll(node=>node.type==='button'&&node.children.includes('填入模板'))[0].props.onClick();
  await act(fill);assert(draft.includes('压缩重复与空话'));assert(draft.includes('不掩盖不利结果'));assert.equal(submitted,0);
  draft='作者自己的修改要求';await act(async()=>renderer.update(React.createElement(NativeSentenceBody,props)));await act(fill);assert.equal(draft,'作者自己的修改要求');assert.equal(submitted,0);
});

test('a selected sentence immediately reacts in the sidebar without dimming or disabling Word',async t=>{
  let finish;const gate=new Promise(resolve=>finish=resolve),view=await mount(t,{prepare:()=>gate});
  view.select(selected);await view.pointer();
  assert.equal(view.calls(),1);
  assert.equal(view.frame.inert,false,'merely preparing selection must not disable Word');
  assert(view.text().includes(selected.text),'sidebar must show the new sentence before preparation finishes');
  assert(!view.text().includes('正在保存或更新 Word'),'selection alone must not show a save overlay');
  await act(async()=>{finish('j_selected');await pause(0)});
});

test('clicking again with an unchanged selection does not prepare the same sentence repeatedly',async t=>{
  const view=await mount(t);view.select(selected);await view.pointer();await view.pointer();
  assert.equal(view.calls(),1,'unchanged selection must not restart preparation on every click');
});

test('rapid selections keep only the latest waiting target and never activate an older response in the sidebar',async t=>{
  let finish;const gate=new Promise(resolve=>finish=resolve),prepared=[],opened=[];
  const view=await mount(t,{prepare:async({wordSelection})=>{prepared.push(wordSelection.text);if(prepared.length===1)await gate;return 'j_'+prepared.length}});
  view.props.sentence.onNativeOpen=async id=>opened.push(id);
  view.select(selected);await view.pointer();
  view.select({...selected,text:'第二句。',focus:{para:0,off:24}});await view.pointer();
  view.select({...selected,text:'最后选中的第三句。',focus:{para:0,off:36}});await view.pointer();
  assert(view.text().includes('最后选中的第三句。'));assert.equal(view.frame.inert,false);assert.deepEqual(prepared,[selected.text]);
  await act(async()=>{finish();await pause(30)});
  assert.deepEqual(prepared,[selected.text,'最后选中的第三句。']);assert.deepEqual(opened,['j_2']);
  assert(view.text().includes('已关联当前选句'));assert(!view.text().includes('正在关联到当前对话'));
});

test('a failed selection is explicit, can be retried, and does not leave Word disabled',async t=>{
  let fail=true;const view=await mount(t,{prepare:async()=>{if(fail)throw Error('合成连接失败');return 'j_retry'}});
  view.select(selected);await view.pointer();assert(view.text().includes('合成连接失败'));assert.equal(view.frame.inert,false);
  fail=false;await view.pointer();assert.equal(view.calls(),2);assert(view.text().includes('已关联当前选句'));
});

test('real unsaved edits are saved before linking a sentence; later clicks do not export Word again',async t=>{
  let view;view=await mount(t,{prepare:async()=>{assert.equal(view.saves(),1);return 'j_saved_selection'}});
  view.edit();view.select(selected);await view.pointer();await view.pointer();
  assert.equal(view.calls(),1);assert.equal(view.saves(),1);assert.equal(view.frame.inert,false);assert(view.text().includes('已关联当前选句'));
});

test('a slow initial whole-article conversation cannot overtake and clear a newer selection',async t=>{
  let finish;const gate=new Promise(resolve=>finish=resolve),view=await mount(t,{discussion:()=>gate});
  view.select(selected);await view.pointer();
  assert.equal(view.calls(),0,'initial conversation must finish before preparing the selected-sentence context');
  assert(view.text().includes(selected.text));assert.equal(view.frame.inert,false);
  await act(async()=>{finish('j_new_discussion');await pause(30)});
  assert.equal(view.calls(),1);assert(view.text().includes(selected.text));assert(view.text().includes('已关联当前选句'));
});

test('the native input reacts to a new sentence, preserves authored drafts, and never submits automatically',async t=>{
  const previous=Object.fromEntries(['window','IS_REACT_ACT_ENVIRONMENT'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  Object.assign(globalThis,{window:new EventTarget(),IS_REACT_ACT_ENVIRONMENT:true});
  let draft='',submitted=0,persisted=0,renderer;
  const props={sessionId:'s_test',jobId:'j_1',autoSelectionDraft:true,selectedText:'第一句话。',useSession:()=>({}),useConversation:()=>({}),useInput:()=>({draft,phase:'plain'}),useWorkspaces:()=>({items:[{sessionIds:['s_test']}]}),inputActions:{setDraft:text=>{draft=text},persistDraft:()=>{persisted++},submit:()=>{submitted++}},renderFactorySlot:()=>React.createElement('div',null,'native-content-test-double')};
  t.after(async()=>{if(renderer)await act(async()=>renderer.unmount());for(const [key,value] of Object.entries(previous)){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key]}});
  const render=async()=>act(async()=>{const element=React.createElement(NativeSentenceBody,props);if(renderer)renderer.update(element);else renderer=create(element)});
  await render();assert(draft.includes('第一句话。'));assert(draft.includes('修改要求：'));assert.equal(submitted,0);
  props.jobId='j_2';props.selectedText='第二句话。';props.selectionPending=true;await render();assert(draft.includes('第一句话。'));
  props.selectionPending=false;await render();assert(draft.includes('第二句话。'));assert(!draft.includes('第一句话。'));
  draft='请保留我刚写的修改要求。';props.jobId='j_3';props.selectedText='第三句话。';await render();assert.equal(draft,'请保留我刚写的修改要求。');
  draft='';await render();assert.equal(draft,'','same selection must not refill input after a send or manual clear');
  assert.equal(submitted,0);assert.equal(persisted,2);
  props.conversationOnly=true;await render();props.conversationOnly=false;await render();assert(draft.includes('第三句话。'));assert.equal(persisted,3);assert.equal(submitted,0);
  const template=renderer.root.findByProps({'aria-label':'修改提示词模板'}),option=template.props.children.find(item=>item.props.value!==template.props.value);
  const previousDraft=draft;await act(async()=>template.props.onChange({target:{value:option.props.value}}));assert.notEqual(draft,previousDraft);assert(draft.includes('第三句话。'));assert.equal(persisted,4);
  draft='作者手写要求需要保留。';await render();await act(async()=>renderer.root.findByProps({'aria-label':'修改提示词模板'}).props.onChange({target:{value:'scientific'}}));assert.equal(draft,'作者手写要求需要保留。');assert.equal(submitted,0);
});

test('opening managed Word bytes leaves a restored File Home page and displays the document',async t=>{
  const view=await mount(t,{backstage:true});
  assert.equal(view.backstage(),false,'successfully opened bytes must exit File Home');
});

test('Word File Home routes to the project file picker instead of preparing an old sentence or opening recent local paths',async t=>{
  const view=await mount(t);view.select(selected);view.filePage();await view.pointer();
  assert(view.text().includes('工作区 Word 文件'),'unsupported recent paths need a workspace-backed opening entry');
  assert.equal(view.backstage(),false);assert.equal(view.calls(),0);assert.equal(view.frame.inert,false);
});

const fileButton=(view,title)=>view.renderer.root.findAll(node=>node.type==='button'&&node.props.title===title)[0];
async function filePicker(view){await act(async()=>{await view.renderer.root.findByProps({'aria-label':'打开工作区 Word'}).props.onClick();await pause(0)})}
function addSecondFile(view){const current={...view.props.object,kind:'manuscript',encoding:'binary'},other={id:'o_second',title:'another.docx',kind:'manuscript',encoding:'binary',revision:1,metadata:{workspaceFile:'paper/another.docx'}};view.props.project.objects=[current,other];return other}

test('workspace Word opening saves unsaved edits once and selects by the project object identity',async t=>{
  const view=await mount(t),other=addSecondFile(view);let chosen;view.props.onSelectObject=async item=>{assert.equal(view.saves(),1);chosen=item.id};await view.rerender();view.edit();await filePicker(view);
  assert(view.renderer.root.findByProps({'aria-label':'查找工作区 Word 文件'}).props.autoFocus);assert.equal(view.renderer.root.findByProps({className:'rw-word-frame-wrap'}).props.inert,true);
  await act(async()=>{fileButton(view,other.metadata.workspaceFile).props.onClick();await pause(35)});
  assert.equal(chosen,other.id);assert.equal(view.saves(),1);assert(!view.text().includes('aria-label":"工作区 Word 文件'));
});

test('failed saving leaves the current document and project file picker in place',async t=>{
  const view=await mount(t),other=addSecondFile(view);let chosen=0;view.props.onSelectObject=async()=>{chosen++};view.props.api.saveWord=async()=>{throw Error('合成保存失败')};await view.rerender();view.edit();await filePicker(view);
  await act(async()=>{fileButton(view,other.metadata.workspaceFile).props.onClick();await pause(35)});
  assert.equal(chosen,0);assert(view.text().includes('合成保存失败'));assert(view.text().includes('aria-label":"工作区 Word 文件'));assert.equal(view.frame.inert,false);
});

test('Ctrl+O uses the workspace picker, Escape returns to the document, and advanced Word pages stay available',async t=>{
  const view=await mount(t);addSecondFile(view);await view.rerender();
  const event=await view.key('o');assert(event.defaultPrevented);assert(view.text().includes('工作区 Word 文件'));
  await act(async()=>view.renderer.root.findByProps({'aria-label':'工作区 Word 文件'}).props.onKeyDown({key:'Escape',preventDefault(){},stopPropagation(){}}));assert(!view.text().includes('aria-label":"工作区 Word 文件'));
  await filePicker(view);await act(async()=>{view.renderer.root.findAll(node=>node.type==='button'&&node.children.includes('Word 文件功能'))[0].props.onClick();await pause(0)});
  await view.pointer();assert.equal(view.backstage(),true);assert(!view.text().includes('aria-label":"工作区 Word 文件'));assert.equal(view.calls(),0);
});

test('opening a DOCX saved at 180 percent starts at the default 95 percent without a document save',async t=>{const view=await mount(t);assert.equal(view.zoom(),95);assert.equal(view.saves(),0)});

test('adopting a revision keeps a manually chosen zoom rather than the zoom embedded in DOCX',async t=>{const view=await mount(t);view.setZoom(125);view.props.object={...view.props.object,revision:2};await view.rerender();await act(async()=>pause(200));assert.equal(view.zoom(),125);assert.equal(view.saves(),0)});

test('Word sidebar dragging does not rerender its native conversation on pointer frames and commits the release position',async t=>{
  const view=await mount(t,{resize:true}),separator=()=>view.renderer.root.findByProps({role:'separator'});
  const event=x=>({clientX:x,button:0,pointerId:1,preventDefault(){},currentTarget:{setPointerCapture(){},hasPointerCapture:()=>true,releasePointerCapture(){}}});
  const before=view.nativeRenders();separator().props.onPointerDown(event(600));
  for(let n=1;n<=150;n++)separator().props.onPointerMove(event(600-n/2));
  assert.equal(view.resizeFrames.size,1);assert.equal(view.nativeRenders(),before);
  const pending=[...view.resizeFrames.values()];view.resizeFrames.clear();for(const callback of pending)callback();
  assert.equal(view.sidebarNode.style.width,'455px');assert.equal(view.nativeRenders(),before);
  await act(async()=>separator().props.onPointerUp(event(500)));
  assert.equal(view.sidebarNode.style.width,'480px');assert.equal(separator().props['aria-valuenow'],480);
  assert.equal(view.boardNode.dataset.resizing,undefined);assert.equal(view.saves(),0);
  const renders=view.nativeRenders();separator().props.onPointerDown(event(500));separator().props.onPointerMove(event(420));
  await act(async()=>separator().props.onLostPointerCapture(event(420)));
  assert.equal(view.sidebarNode.style.width,'480px');assert.equal(view.resizeFrames.size,0);assert.equal(view.nativeRenders(),renders);
});

test('an unavailable discussion stays in the sidebar, offers reconnect and does not add a document-wide warning',async t=>{
  let fail=true,calls=0;const view=await mount(t,{discussion:async()=>{calls++;if(fail)throw Error('论文修改服务暂未连接，请重新连接。');return 'j_reconnected'}});
  assert(view.renderer.root.findByProps({className:'rw-word-connection-status'}));
  assert.equal(view.renderer.root.findAllByProps({className:'rw-sentence-warning'}).length,0);
  fail=false;await act(async()=>{await view.renderer.root.findAll(node=>node.type==='button'&&node.children.includes('重新连接'))[0].props.onClick();await pause(0)});
  assert.equal(calls,2);assert.equal(view.renderer.root.findAllByProps({className:'rw-word-connection-status'}).length,0);
});

test('the original-file menu explicitly imports the original and switches only after saving current input',async t=>{
  const view=await mount(t);view.props.object={...view.props.object,metadata:{wordOriginalFile:'paper/original.docx',wordEditable:true}};
  const original={id:'o_original',title:'original.docx',kind:'manuscript',encoding:'binary',revision:1};let chosen,args;
  const mutate=view.props.api.mutate;view.props.api.mutate=async(action,data)=>{if(action!=='importWorkspaceFile')return mutate(action,data);assert.equal(view.saves(),1);args=data;return {projects:[{id:'p_test',objects:[original]}],actionResult:{objectId:original.id}}};
  view.props.onSelectObject=async item=>{chosen=item.id};await view.rerender();view.edit();
  await act(async()=>{await view.renderer.root.findAll(node=>node.type==='button'&&node.children.includes('打开原始文稿'))[0].props.onClick();await pause(0)});
  assert.equal(chosen,original.id);assert.equal(args.openOriginal,true);assert.equal(args.path,'paper/original.docx');assert.equal(view.saves(),1);
});
