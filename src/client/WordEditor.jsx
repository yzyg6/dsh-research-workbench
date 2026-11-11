import React from 'react';
import { RevisionPanel } from './SentenceEditor.jsx';
import { WordReader } from './WordReader.jsx';
import { installChineseFont,installSystemFonts,documentSystemFonts } from './wordcraft-font.mjs';
import {DocumentHistory,RelatedReminders} from './RevisionTools.jsx';
import {readWordSidebarRatio,rememberWordSidebarRatio} from './workbench-preferences.mjs';
import { wordcraftFrame } from './wordcraft-frame.mjs';
import {ActionMenu} from './ActionMenu.jsx';
import {setWordRibbon,readWordRibbon,rememberWordRibbon,isWordOpenPage,showWordDocument,setWordZoom,wordZoom} from './wordcraft-view.mjs';
import {WordWorkspaceFiles} from './WordWorkspaceFiles.jsx';
import { Icon } from './icons.jsx';
import{WordFormatPanel}from'./WordFormatPanel.jsx';

/** One lazily mounted WASM instance. No full-document polling, no base64 DOCX. */
export function WordEditor({api,project,object,sentence,onSaved,registerSave,onDirty,onHistory,onSelectObject,onBrowseWorkspace,...reader}){
  const conversations=(project.writingConversations||[]).filter(thread=>thread.objectId===object.id);
  const initialJob=(sentence.jobs||[]).find(item=>item.id===sentence.initialNativeJobId&&(item.output?.objectId||item.objectId)===object.id);
  const [mode,setMode]=React.useState('edit'),[frameHtml,setFrameHtml]=React.useState(''),[phase,setPhase]=React.useState('正在加载 Word 编辑器…'),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false),[jobId,setJobId]=React.useState(initialJob?.id||null),[tab,setTab]=React.useState('chat'),[history,setHistory]=React.useState(false),[notice,setNotice]=React.useState(''),[sidebarOpen,setSidebarOpen]=React.useState(true),[sidebarWidth,setSidebarWidth]=React.useState(()=>Math.round(((globalThis.innerWidth||1844)-68)*readWordSidebarRatio())),[reviewJobId,setReviewJobId]=React.useState(initialJob?.id||null);
  const [reminderCount,setReminderCount]=React.useState(0),[fonts,setFonts]=React.useState(null),[fontsBusy,setFontsBusy]=React.useState(false);
  const requiredFonts=React.useRef([]),loadMoreFonts=React.useRef(null);
  const pendingFont=React.useRef(null),continueDiscussion=React.useRef(false),sidebarBoard=React.useRef(null);
  const [selectionFeedback,setSelectionFeedback]=React.useState(null);
  const selectionFlow=React.useRef({read:0,running:false,queued:null,lastKey:null,generation:0,closed:false});
  const discussionOperation=React.useRef(null),[dialogBusy,setDialogBusy]=React.useState(false);
  const [dialogError,setDialogError]=React.useState('');
  const [filePicker,setFilePicker]=React.useState(false),[fileBusy,setFileBusy]=React.useState(false),[fileError,setFileError]=React.useState('');
  const fileActions=React.useRef(null),fileOperation=React.useRef(false);
  const pendingWasm=React.useRef(null),bootstrapUrl=React.useRef(''),metrics=React.useRef({started:performance.now(),wasmBytes:0,instanceId:crypto.randomUUID()}),dialogActions=React.useRef(null);
  const frame=React.useRef(null),live=React.useRef({}),bridge=React.useRef(null),dirty=React.useRef(false),loadedRevision=React.useRef(object.revision),managedId=React.useRef(null),saveOperation=React.useRef(null),exportWaiter=React.useRef(null),drag=React.useRef(null),opening=React.useRef(false);
  const sidebarElement=React.useRef(null),resizeFrame=React.useRef(null);
  const cancelResizeFrame=()=>{if(resizeFrame.current!==null)cancelAnimationFrame(resizeFrame.current);resizeFrame.current=null};
  React.useEffect(()=>()=>cancelResizeFrame(),[]);
  live.current={object,project,sentence,onSaved,onDirty,onSelectObject,onBrowseWorkspace};
  React.useEffect(()=>{const element=sidebarBoard.current;if(!element)return;const observer=new ResizeObserver(()=>{if(!drag.current)setSidebarWidth(Math.max(280,Math.min(element.clientWidth*.55,element.clientWidth*readWordSidebarRatio())))});observer.observe(element);return()=>observer.disconnect()},[]);
  const persistWidth=width=>{if(sidebarBoard.current)rememberWordSidebarRatio(width/sidebarBoard.current.clientWidth)};
  const resizeWidth=x=>Math.max(280,Math.min(drag.current.limit,drag.current.width+drag.current.x-x));
  const previewWidth=width=>{if(sidebarElement.current)sidebarElement.current.style.width=`${width}px`};
  const finishResize=(event,cancelled=false)=>{
    if(!drag.current)return;
    cancelResizeFrame();const width=cancelled?drag.current.width:resizeWidth(event.clientX);
    previewWidth(width);drag.current=null;
    if(sidebarBoard.current)delete sidebarBoard.current.dataset.resizing;
    if(!cancelled){setSidebarWidth(width);persistWidth(width)}
    if(event.currentTarget.hasPointerCapture?.(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const restore=async commit=>{await save();locked(true);try{const next=await api.mutate('restoreDocumentHistory',{projectId:project.id,objectId:object.id,commit,expectedRevision:loadedRevision.current});onSaved(next);setNotice('已恢复为新的历史版本，后续历史保留。')}finally{locked(false)}};
  const locate=async text=>{try{if(!bridge.current)throw Error('请切换至 Word 编辑模式查找。');await bridge.current.execute('edit.find',{text:text.slice(0,80),special:false});setNotice('已在 Word 中查找相关段落。')}catch(e){setError(e.message)}};
  const markDirty=value=>{dirty.current=value;live.current.onDirty(value)};
  const report=(stage,info={})=>{const {project,object}=live.current;void api.mutate('wordEditorStatus',{projectId:project.id,objectId:object.id,revision:loadedRevision.current,stage,instanceId:metrics.current.instanceId,engineDirty:info.dirty,bootMs:performance.now()-metrics.current.started,wasmBytes:frame.current?.contentWindow?.wordcraftMemoryBytes?.()||metrics.current.wasmBytes,heapBytes:performance.memory?.usedJSHeapSize,...info.perf}).catch(()=>{})};
  const locked=value=>{if(frame.current)frame.current.inert=value;setBusy(value)};
  const ensureManaged=async supplied=>{const info=supplied||await bridge.current.uiInspect({});if(managedId.current===null||info.document!==managedId.current||info.documents?.length!==1)throw Error('编辑器已打开其他文档。请将其另存后，重新打开当前工作区 Word，避免保存到错误稿件。');return info};
  const persistExport=async data=>{
    if(!/\.docx$/i.test(data.name||''))throw Error('工作台保存接收 DOCX。PDF 等导出请使用原应用。');
    await ensureManaged();const bytes=data.bytes instanceof ArrayBuffer?data.bytes:data.bytes?.buffer;
    if(!bytes||bytes.byteLength>32*1024*1024)throw Error('Word 保存内容为空或超过32 MiB。');
    const {project,object}=live.current,next=await api.saveWord(project.id,object.id,loadedRevision.current,bytes),saved=next.projects.find(p=>p.id===project.id).objects.find(o=>o.id===object.id);
    loadedRevision.current=saved.revision;markDirty(false);live.current.onSaved(next);setNotice(`已保存到同一 Word 工作副本 · 原件保留`);return saved;
  };
  const save=()=>{
    if(saveOperation.current)return saveOperation.current;
    const operation=(async()=>{
      if(!bridge.current){if(dirty.current)throw Error('Word 尚未就绪，当前内容未保存。');return}
      const info=await ensureManaged();if(info.dirty)markDirty(true);if(!dirty.current)return;
      locked(true);frame.current?.contentWindow?.document.activeElement?.blur();
      try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{exportWaiter.current=null;reject(Error('Word 导出超时，编辑内容仍保留。'))},30000);exportWaiter.current={resolve:value=>{clearTimeout(timer);resolve(value)},reject:error=>{clearTimeout(timer);reject(error)}};void bridge.current.execute('file.save',{}).catch(error=>{const waiter=exportWaiter.current;exportWaiter.current=null;waiter?.reject(error)})})}finally{locked(false)}
    })();saveOperation.current=operation;operation.finally(()=>{if(saveOperation.current===operation)saveOperation.current=null}).catch(()=>{});return operation;
  };
  React.useEffect(()=>setJobId(initialJob?.id||null),[initialJob?.id]);
  const saveRef=React.useRef(save);saveRef.current=save;
  React.useEffect(()=>registerSave(()=>saveRef.current()),[registerSave]);
  const openFiles=async()=>{if(!bridge.current||busy||fileOperation.current)return;try{await showWordDocument(bridge.current);setFileError('');setFilePicker(true)}catch(e){setError(e.message)}};
  const selectFile=async item=>{
    if(fileOperation.current)return;fileOperation.current=true;setFileBusy(true);setFileError('');
    try{
      if(!live.current.project.objects?.some(candidate=>candidate.id===item.id))throw Error('请选择当前项目中的文稿。');
      await saveRef.current();
      if(item.id!==live.current.object.id){if(!live.current.onSelectObject)throw Error('请通过工作区文件列表打开此文稿。');const result=await live.current.onSelectObject(item);if(result===null)throw Error('文稿未切换，请查看工作台提示。')}
      else await showWordDocument(bridge.current);
      setFilePicker(false);
    }catch(e){setFileError(e.message)}finally{fileOperation.current=false;setFileBusy(false)}
  };
  fileActions.current={open:openFiles};
  const openOriginal=async()=>{
    if(fileOperation.current)return;fileOperation.current=true;setFileBusy(true);setError('');
    try{
      await saveRef.current();const {project,object}=live.current;
      const next=await api.mutate('importWorkspaceFile',{projectId:project.id,path:object.metadata.wordOriginalFile,openOriginal:true});
      const selected=next.projects.find(item=>item.id===project.id)?.objects.find(item=>item.id===next.actionResult.objectId);
      if(!selected||!live.current.onSelectObject)throw Error('请从工作区文件中选择原稿。');
      if(await live.current.onSelectObject(selected)===null)throw Error('原稿未切换，当前文稿仍保留。');
    }catch(e){setError(e.message)}finally{fileOperation.current=false;setFileBusy(false)}
  };
  const close=async()=>{setSidebarOpen(false);setError('')};
  const openConversation=({preserveReview=false,...options}={})=>{
    if(discussionOperation.current)return discussionOperation.current;
    const flow=selectionFlow.current;
    const operation=(async()=>{
      setDialogBusy(true);setSidebarOpen(true);setDialogError('');
      try{
        await save();if(flow.closed)return;
        const id=await live.current.sentence.onOpenConversation(options);if(flow.closed)return;
        setJobId(id);
        if(!flow.running){flow.lastKey=null;setSelectionFeedback(null);if(!preserveReview){setTab('chat');setReviewJobId(null)}}
        setHistory(false);await live.current.sentence.onNativeOpen?.(id);
      }catch(e){if(!flow.closed)setDialogError(e.message)}finally{if(!flow.closed)setDialogBusy(false)}
    })();
    discussionOperation.current=operation;
    void operation.finally(()=>{if(discussionOperation.current===operation)discussionOperation.current=null});
    return operation;
  };
  const capture=async()=>{
    if(!bridge.current||busy||opening.current||saveOperation.current||fileOperation.current)return;
    const flow=selectionFlow.current,read=++flow.read,generation=flow.generation;
    const active=()=>!flow.closed&&generation===flow.generation;
    const keyOf=value=>JSON.stringify([live.current.object.id,loadedRevision.current,value]);
    try{
      const info=await bridge.current.uiInspect({});if(!active()||read!==flow.read)return;
      if(isWordOpenPage(info)){await fileActions.current?.open();return}
      if(info.ui?.backstage||filePicker||!live.current.sentence.onNativePrepare)return;
      await ensureManaged(info);const selection=await bridge.current.execute('document.selection',{});if(!active()||read!==flow.read||!selection.text?.trim()||selection.text.length>8000)return;
      if(JSON.stringify(selection.anchor)===JSON.stringify(selection.focus))return;
      const wordSelection={anchor:selection.anchor,focus:selection.focus,text:selection.text};
      const key=keyOf(wordSelection);if(key===flow.lastKey)return;
      flow.lastKey=key;flow.queued=wordSelection;
      setSelectionFeedback({text:selection.text,state:'pending'});setSidebarOpen(true);setTab('chat');setHistory(false);setError('');
      if(flow.running)return;
      flow.running=true;
      try{
        // Serialize server activation. Keep at most the newest waiting selection;
        // a slow earlier response must never replace the latest sidebar target.
        while(flow.queued&&active()){
          const currentSelection=flow.queued;flow.queued=null;
          try{
            await discussionOperation.current;if(!active())return;
            await save();if(!active())return;
            const id=await live.current.sentence.onNativePrepare({wordSelection:currentSelection});if(!active())return;
            if(flow.queued)continue;
            await live.current.sentence.onNativeOpen?.(id);if(!active())return;
            if(flow.queued)continue;
            flow.lastKey=keyOf(currentSelection);setError('');setJobId(id);setReviewJobId(id);
            setSelectionFeedback({text:currentSelection.text,state:'ready',jobId:id});
          }catch(e){if(!active())return;if(flow.queued)continue;flow.lastKey=null;setSelectionFeedback({text:currentSelection.text,state:'error',error:e.message})}
        }
      }finally{flow.running=false}
    }catch(e){if(active())setError(e.message)}
  };
  const captureRef=React.useRef(capture);captureRef.current=capture;
  const openDocument=async(cancelled,zoom=95)=>{
    const {project,object}=live.current;opening.current=true;setPhase('正在打开 Word 正文…');
    try{
      const result=await fetch(api.assetUrl(project.id,object.id),{cache:'no-store'});if(!result.ok)throw Error('Word 读取失败。');const bytes=await result.arrayBuffer();if(cancelled())return;
      const previous=(await bridge.current.uiInspect({})).document;
      frame.current.contentWindow.postMessage({type:'wordcraft:open',name:object.title.endsWith('.docx')?object.title:object.title+'.docx',bytes},location.origin,[bytes]);
      // Initial open is asynchronous; inspect only while opening (bounded).
      for(let n=0;n<80;n++){if(cancelled())return;await new Promise(resolve=>setTimeout(resolve,100));const info=await bridge.current.uiInspect({});if(info.documents?.length===1&&info.document!==previous){managedId.current=info.document;loadedRevision.current=object.revision;markDirty(false);await setWordZoom(bridge.current,zoom);await showWordDocument(bridge.current);if(cancelled())return;setPhase('');report('ready',info);if(continueDiscussion.current){continueDiscussion.current=false;void dialogActions.current?.openConversation({preserveReview:true})}return}}
      throw Error('Word 打开超时，可切换轻量阅读或重新打开。');
    }finally{opening.current=false}
  };
  React.useEffect(()=>{
    if(mode!=='edit')return;let closed=false,detach=()=>{},captureTimer,moduleUrl,bootUrl;const controller=new AbortController();
    const flow={read:0,running:false,queued:null,lastKey:null,generation:0,closed:false};selectionFlow.current=flow;discussionOperation.current=null;setDialogBusy(false);setSelectionFeedback(null);
    setPhase('正在加载 Word 编辑器…');setFrameHtml('');setFonts(null);requiredFonts.current=[];metrics.current={started:performance.now(),wasmBytes:0,instanceId:crypto.randomUUID()};
    void api.mutate('prepareWordEdit',{projectId:project.id,objectId:object.id}).then(result=>{controller.signal.throwIfAborted();if(!result.actionResult?.chineseFont)throw Error('本次新增了中文字体接口，重载科研工作台插件与 Host 后即可使用。');requiredFonts.current=result.actionResult.fontFamilies||[];return api.wordcraftAssets(controller.signal)}).then(({script,wasm,font})=>{if(closed)return;moduleUrl=URL.createObjectURL(new Blob([script],{type:'text/javascript'}));const html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#eee}canvas{position:absolute;inset:0;width:100%;height:100%}#wordcraft_loading{position:absolute;inset:0;display:grid;place-items:center;color:#333;font:14px system-ui}</style><canvas id="wordcraft_canvas" data-host="page"></canvas><div id="wordcraft_loading">正在启动 Word 编辑器…</div></html>';pendingWasm.current=wasm;pendingFont.current=font;const bootstrap=`(${wordcraftFrame.toString()})({...${JSON.stringify({hostOrigin:location.origin,moduleUrl})},installFont:${installChineseFont.toString()}});`;bootUrl=URL.createObjectURL(new Blob([bootstrap],{type:'text/javascript'}));bootstrapUrl.current=bootUrl;setFrameHtml(html)}).catch(e=>{if(!closed){setPhase('');setError(e.message)}});
    const cancelled=()=>closed;
    const message=event=>{
      if(event.source!==frame.current?.contentWindow)return;if(event.origin!==location.origin){setPhase('');setError('Word 内嵌页面来源与工作台不一致：'+event.origin);return}const data=event.data||{};
      if(data.type==='rw-wordcraft-memory'){metrics.current.wasmBytes=data.wasmBytes||0;}
      else if(data.type==='rw-wordcraft-frame'){setPhase('正在启动 Word 图形引擎…');const bytes=pendingWasm.current,font=pendingFont.current;pendingWasm.current=null;pendingFont.current=null;if(bytes&&font)frame.current.contentWindow.postMessage({type:'rw-wordcraft-start',bytes,font},location.origin,[bytes,font]);}
      else if(data.type==='rw-wordcraft-font-loading'){setPhase('正在加载中文字体…')}
      else if(data.type==='wordcraft:ready'){
        bridge.current=frame.current.contentWindow.wordcraft;
        if(!bridge.current){setError('Word 编辑接口未加载。');return}
        const doc=frame.current.contentWindow.document;
        const pointer=()=>{clearTimeout(captureTimer);captureTimer=setTimeout(()=>void captureRef.current(),80)};
        const keys=event=>{if(((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='o')||(event.altKey&&!event.ctrlKey&&event.key.toLowerCase()==='f')){event.preventDefault();event.stopImmediatePropagation();void fileActions.current?.open();return}if(dialogActions.current?.keys(event))return;if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();event.stopImmediatePropagation();void saveRef.current().catch(e=>setError(e.message))}else if(event.key==='Escape'){void close().catch(e=>setError(e.message))}};
        const keyup=event=>{if(event.shiftKey||['Enter','F10'].includes(event.key))pointer()};doc.addEventListener('pointerup',pointer);doc.addEventListener('keyup',keyup);doc.addEventListener('keydown',keys,true);
        detach=()=>{doc.removeEventListener('pointerup',pointer);doc.removeEventListener('keyup',keyup);doc.removeEventListener('keydown',keys,true)};
        const loadFonts=async(all=false)=>{
          setFontsBusy(true);
          try{
            const result=await api.mutate('systemFonts',{});if(closed)return;
            const selected=all?result.actionResult:documentSystemFonts(result.actionResult,requiredFonts.current);
            const installed=await installSystemFonts(bridge.current,selected,api.systemFontUrl,controller.signal,label=>all?setNotice('正在加载系统字体：'+label):setPhase('正在加载文档字体：'+label));
            if(closed)return;
            setFonts(previous=>({loaded:[...new Set([...(previous?.loaded||[]),...installed.loaded])],failed:installed.failed}));
            if(installed.failed.length)setError('以下系统字体未加载：'+installed.failed.join('、'));
            if(all)setNotice(installed.failed.length?'部分字体加载失败，可重试。':'常用系统字体已加载，可在 Word 字体列表中选择。');
          }catch(e){if(!closed)setError('系统字体加载未完成：'+e.message)}finally{if(!closed)setFontsBusy(false)}
        };
        loadMoreFonts.current=loadFonts;
        void (async()=>{await loadFonts();if(!closed)await setWordRibbon(bridge.current,readWordRibbon()).catch(()=>{})})().then(()=>{if(!closed)return openDocument(cancelled)}).then(()=>{if(!closed&&!live.current.sentence.jobs?.some(item=>item.id===live.current.sentence.initialNativeJobId&&(item.output?.objectId||item.objectId)===live.current.object.id)&&live.current.sentence.nativeRender)void dialogActions.current?.openConversation()}).catch(e=>{if(!closed){setPhase('');setError(e.message)}});
      }else if(data.type==='wordcraft:dirty'&&data.dirty&&!opening.current)markDirty(true);
      else if(data.type==='wordcraft:failed'){report('failed',{perf:{errorStack:data.stack||data.error}});setPhase('');setError(data.error||'当前 DSH 图形环境无法启动 Word 编辑器，可使用轻量阅读。')}
      else if(data.type==='wordcraft:save'){
        const waiter=exportWaiter.current;exportWaiter.current=null;
        if(saveOperation.current&&!waiter){setError('上一次保存仍在进行，请稍后重试。');return}
        locked(true);const operation=persistExport(data);if(!waiter)saveOperation.current=operation;void operation.then(result=>waiter?.resolve(result)).catch(e=>{markDirty(true);setError(e.message);waiter?.reject(e)}).finally(()=>{if(saveOperation.current===operation)saveOperation.current=null;locked(false)});
      }
    };
    window.addEventListener('message',message);
    return()=>{closed=true;loadMoreFonts.current=null;flow.closed=true;flow.generation++;flow.queued=null;report('closed');bootstrapUrl.current='';controller.abort();if(moduleUrl)URL.revokeObjectURL(moduleUrl);if(bootUrl)URL.revokeObjectURL(bootUrl);pendingWasm.current=null;pendingFont.current=null;clearTimeout(captureTimer);detach();window.removeEventListener('message',message);exportWaiter.current?.reject(Error('Word 编辑器已关闭。'));exportWaiter.current=null;bridge.current=null;managedId.current=null;if(frame.current)frame.current.src='about:blank';live.current.onDirty(false)};
  },[mode,object.id]);
  React.useEffect(()=>{
    if(mode!=='edit'||!bridge.current||opening.current||loadedRevision.current===object.revision)return;
    let cancelled=false;
    void(async()=>{if(dirty.current)throw Error('Word 已在其他位置更新，当前输入保留，请先另存副本。');locked(true);const previous=await ensureManaged();const prepared=await api.mutate('prepareWordEdit',{projectId:project.id,objectId:object.id});if(cancelled)return;requiredFonts.current=prepared.actionResult.fontFamilies||[];await loadMoreFonts.current?.();if(cancelled)return;await bridge.current.execute('file.close',{});await openDocument(()=>cancelled,wordZoom(previous))})().catch(e=>setError(e.message)).finally(()=>locked(false));return()=>{cancelled=true};
  },[object.revision,mode]);
  React.useEffect(()=>{
    if(!jobId||!sidebarOpen)return;
    let pending=false,closed=false;
    const refresh=async()=>{if(closed||pending||document.visibilityState==='hidden')return;pending=true;try{await live.current.sentence.onRefresh?.()}catch{/* Keep the current discussion available while reconnecting. */}finally{pending=false}};
    const timer=setInterval(()=>void refresh(),1200);
    const visible=()=>{if(document.visibilityState!=='hidden')void refresh()};document.addEventListener('visibilitychange',visible);
    return()=>{closed=true;clearInterval(timer);document.removeEventListener('visibilitychange',visible)};
  },[jobId,sidebarOpen]);
  const jobs=sentence.jobs||[],relevant=jobs.filter(job=>job.type==='writing.sentence'&&!job.conversationOnly&&(job.output?.objectId||job.objectId)===object.id),job=jobs.find(job=>job.id===jobId),reviewJob=jobs.find(item=>item.id===reviewJobId)||job,undoable=relevant.find(job=>job.output?.review==='adopted'&&job.output.appliedRevision===object.revision);
  const selectionPending=selectionFeedback?.state==='pending',selectionBlocked=selectionPending||selectionFeedback?.state==='error'||dialogBusy||fileBusy,interactionBusy=busy||selectionPending||dialogBusy||fileBusy;
  const act=async(action,id)=>{try{setError('');await save();locked(true);await live.current.sentence.onAction(action,id);setReviewJobId(id);setSidebarOpen(true);setTab('review');continueDiscussion.current=true;setNotice(action==='applySentence'?'修改已保存到同一 Word 工作副本，可在右侧撤回。':'已撤回并更新同一 Word 工作副本。')}catch(e){setError(e.message)}finally{locked(false)}};
  const changeMode=async()=>{try{await save();await close();setFilePicker(false);setMode(mode==='edit'?'read':'edit');setError('')}catch(e){setError(e.message)}};
  const toggleRibbon=async()=>{try{if(!bridge.current)return;const info=await bridge.current.uiInspect({}),collapsed=!info.ui?.ribbonCollapsed;await setWordRibbon(bridge.current,collapsed);rememberWordRibbon(collapsed)}catch(e){setError(e.message)}};
  React.useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),4000);return()=>clearTimeout(timer)},[notice]);
  const showConversation=()=>{setSidebarOpen(true);setTab('chat');if(!jobId&&!selectionPending)void openConversation()};
  dialogActions.current={openConversation,keys:event=>{if(!event.ctrlKey||!event.altKey||busy||selectionBlocked)return false;const key=(event.code?.startsWith('Key')?event.code.slice(3):event.key).toLowerCase();if(!['c','d','a','z'].includes(key))return false;event.preventDefault();event.stopPropagation();if(key==='c'){if(sidebarOpen)void close();else showConversation()}if(key==='d'&&reviewJob?.output?.proposal)setTab(tab==='review'?'chat':'review');if(key==='a'&&reviewJob?.status==='succeeded'&&reviewJob.output?.review==='pending'&&reviewJob.output.expectedRevision===object.revision)void act('applySentence',reviewJob.id);if(key==='z'&&undoable)void act('undoSentence',undoable.id);return true}};
  React.useEffect(()=>{const keys=event=>dialogActions.current?.keys(event);window.addEventListener('keydown',keys,true);return()=>window.removeEventListener('keydown',keys,true)},[]);
  return <section className="rw-word-editor" aria-label="Word 正文编辑区"><div className="rw-word-toolbar">
      <div className="rw-word-document-title" title={object.metadata?.workspaceFile||object.title}><Icon name="file" size={14}/><strong>{object.title}</strong><small className="rw-document-role" data-role={object.metadata?.wordEditable?'workspace':'original'} title={object.metadata?.wordEditable?'在当前工作区版本持续保存，不再另建 Word':'原稿保留；首次修改保存为工作区版本'}>{object.metadata?.wordEditable?'工作区版本':'原稿'}</small></div>
      <button className="rw-icon-button" disabled={busy||fileBusy||Boolean(phase)||mode!=='edit'} aria-label="打开工作区 Word" title="打开工作区 Word（Ctrl+O）" onClick={()=>void openFiles()}><Icon name="folder" size={15}/></button>
      {undoable&&<button className="rw-icon-button" aria-label="撤回上次采用" title="撤回上次采用" disabled={interactionBusy} onClick={()=>void act('undoSentence',undoable.id)}><Icon name="arrow" size={14}/></button>}
      <button disabled={busy||!sentence.nativeRender} className="rw-icon-button" aria-label={sidebarOpen?'收起 Word 对话栏':'展开 Word 对话栏'} title={sidebarOpen?'收起对话栏':'展开对话栏'} aria-pressed={sidebarOpen} onClick={()=>{if(sidebarOpen)void close();else showConversation()}}><Icon name="chat" size={15}/></button>
      <ActionMenu label="Word 文档操作">{object.metadata?.wordOriginalFile&&<button disabled={interactionBusy||Boolean(phase)} onClick={()=>void openOriginal()}>打开原始文稿</button>}<button disabled={busy} onClick={()=>{setSidebarOpen(true);setTab('history')}}>文档 Git 历史与恢复</button><button disabled={busy} onClick={()=>setNotice(fonts?.loaded?.length?'已加载：'+fonts.loaded.join('、'):'系统字体尚未加载')}>查看已加载系统字体</button><button disabled={busy||fontsBusy||Boolean(phase)||mode!=='edit'} onClick={()=>void loadMoreFonts.current?.(true)}>{fontsBusy?'正在加载字体…':'加载更多系统字体'}</button><button onClick={()=>setHistory(!history)}>{history?'关闭改写记录':`改写记录 · ${relevant.length}`}</button><button disabled={busy} onClick={reader.onOpenNative}>使用原应用打开</button><button disabled={busy} onClick={()=>void changeMode()}>{mode==='edit'?'切换轻量阅读':'直接编辑 Word'}</button><button disabled={busy||mode!=='edit'} onClick={()=>void toggleRibbon()}>展开／收起 Word 功能区</button></ActionMenu>
    </div>
    {notice&&<output className="rw-word-save-notice" role="status">{notice}</output>}{error&&<p className="rw-sentence-warning" role="alert">{error}</p>}
    {history&&<div className="rw-revision-history">{relevant.map(item=><button key={item.id} disabled={interactionBusy} onClick={()=>{selectionFlow.current.lastKey=null;setSelectionFeedback(null);setJobId(item.id);setReviewJobId(item.id);setSidebarOpen(true);setTab('review');setHistory(false);void sentence.onNativeOpen?.(item.id)}}>{item.original?.slice(0,60)}<small>{item.phase}</small></button>)}</div>}
    <div className="rw-word-layout" ref={sidebarBoard}><div className="rw-word-document">
    {filePicker&&<WordWorkspaceFiles project={project} object={object} busy={fileBusy} error={fileError} onSelect={item=>void selectFile(item)} onClose={()=>setFilePicker(false)} onBrowse={onBrowseWorkspace?()=>{setFilePicker(false);onBrowseWorkspace()}:null} onAdvanced={()=>{void bridge.current.execute('ui.backstage',{value:true,page:'info'}).then(()=>setFilePicker(false)).catch(e=>setFileError(e.message))}}/>}
    {mode==='edit'?<div className="rw-word-frame-wrap" inert={filePicker||undefined}>{(phase||busy)&&<div className="rw-word-loading" role="status">{busy?'正在保存或更新 Word…':phase}</div>}<iframe ref={frame} srcDoc={frameHtml||undefined} onLoad={()=>{if(frameHtml&&bootstrapUrl.current){const doc=frame.current.contentDocument,script=doc.createElement('script');script.src=bootstrapUrl.current;script.onload=()=>{const info=doc.documentElement.dataset;if(info.wordcraftError){setPhase('');setError(info.wordcraftError)}else if(!info.wordcraftBoot){setPhase('');setError('Word 启动脚本未执行。')}else setPhase(p=>p==='正在启动 Word 图形引擎…'?'Word 脚本已启动，等待引擎…':p)};script.onerror=()=>{setPhase('');setError('Word 启动脚本无法加载。')};doc.body.appendChild(script);setPhase('正在启动 Word 图形引擎…')}}} title="Wordcraft 论文编辑器" className="rw-word-frame" /></div>:<WordReader api={api} project={project} object={object} {...reader}/>}
    </div>
    <div className="rw-word-sidebar-resizer" hidden={!sidebarOpen} role="separator" aria-label="Word 对话栏宽度" aria-orientation="vertical" tabIndex={0} aria-valuemin={280} aria-valuemax={Math.round((sidebarBoard.current?.clientWidth||1300)*.55)} aria-valuenow={sidebarWidth}
      onKeyDown={event=>{if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();setSidebarWidth(n=>Math.max(280,Math.min((sidebarBoard.current?.clientWidth||1300)*.55,n+(event.key==='ArrowLeft'?24:-24))))}}
      onPointerDown={event=>{if(event.button!==0)return;drag.current={x:event.clientX,width:sidebarWidth,limit:(sidebarBoard.current?.clientWidth||1300)*.55,last:sidebarWidth};if(sidebarBoard.current)sidebarBoard.current.dataset.resizing='true';event.currentTarget.setPointerCapture(event.pointerId);event.preventDefault()}}
      onPointerMove={event=>{if(!drag.current)return;drag.current.last=resizeWidth(event.clientX);if(resizeFrame.current===null)resizeFrame.current=requestAnimationFrame(()=>{resizeFrame.current=null;if(drag.current)previewWidth(drag.current.last)})}}
      onKeyUp={()=>persistWidth(sidebarWidth)} onPointerUp={event=>finishResize(event)} onPointerCancel={event=>finishResize(event,true)} onLostPointerCapture={event=>finishResize(event,true)}/>
    <aside ref={sidebarElement} className="rw-word-sidebar" hidden={!sidebarOpen} aria-label="Word 右侧原生修改对话" style={{width:sidebarWidth}}>
      <header title={`DSH 原生对话 · ${project.title}`}><Icon name="chat" size={14}/><strong>论文修改</strong>
        <nav className="rw-native-sentence-tabs" aria-label="Word 修改视图"><button aria-label="修改对话" aria-pressed={tab==='chat'} onClick={()=>setTab('chat')}>对话</button><button aria-label="左右对照与文献依据" title="左右对照与文献依据" aria-pressed={tab==='review'} disabled={!reviewJob?.output?.proposal} onClick={()=>setTab('review')}>对照{reviewJob?.output?.review==='pending'?' ·':''}</button><button aria-label="格式修改对话" aria-pressed={tab==='format'} onClick={()=>setTab('format')}>格式</button><button aria-pressed={tab==='history'} onClick={()=>setTab('history')}>历史</button><button aria-pressed={tab==='related'} onClick={()=>setTab('related')}>关联{reminderCount?` · ${reminderCount}`:''}</button></nav>
        <ActionMenu label="论文对话操作"><p className="rw-menu-context" title={project.rootPath}>{project.title}</p><p className="rw-menu-context">{object.metadata?.wordEditable?'工作区版本':'原稿'} · {object.title}</p><button disabled={interactionBusy} onClick={()=>void openConversation()}>讨论全文</button><button disabled={interactionBusy} onClick={()=>void openConversation({newThread:true})}>新建对话</button>{conversations.length>1&&<label>当前文稿的对话<select aria-label="切换论文修改对话" disabled={interactionBusy} value={job?.nativeSessionId||''} onChange={event=>{event.currentTarget.closest('details').open=false;void openConversation({sessionId:event.target.value})}}><option value="" disabled>选择对话</option>{conversations.map((thread,i)=><option key={thread.sessionId} value={thread.sessionId}>对话 {conversations.length-i}</option>)}</select></label>}</ActionMenu>
        <button className="rw-icon-button" aria-label="收起 Word 对话栏" title="收起对话栏" onClick={()=>void close()}><Icon name="close" size={13}/></button>
      </header>
      <div className="rw-word-conversation-document" title={`论文工作区：${project.rootPath}\n当前文稿：${object.metadata?.workspaceFile||object.title}\n原生对话：${(tab==='format'?project.jobs?.find(item=>item.id===project.formattingThreads?.[object.id]?.jobId)?.nativeSessionId:job?.nativeSessionId)||'正在关联'}`}><span className="rw-document-role" data-role={object.metadata?.wordEditable?'workspace':'original'}>{object.metadata?.wordEditable?'工作区版本':'原稿'}</span><span>{object.title}</span></div>
      {tab==='format'&&<WordFormatPanel key={object.id} api={api} project={project} object={object} nativeRender={sentence.nativeRender} onSaved={onSaved} onBeforeAction={()=>saveRef.current()}/>}
      {dialogError&&<div className="rw-word-connection-status" role="status"><span>{dialogError}</span>{job&&<button className="rw-quiet" disabled={dialogBusy} onClick={()=>void openConversation()}>重新连接</button>}</div>}
      {(selectionFeedback||(job&&!job.conversationOnly))&&<details className="rw-native-sentence-target rw-word-target"><summary title={selectionFeedback?.text||job.original}><span>选句</span><em>{selectionFeedback?.text||job.original}</em></summary><blockquote>{selectionFeedback?.text||job.original}</blockquote></details>}
      {selectionFeedback&&<div className="rw-word-selection-status" data-state={selectionFeedback.state} role="status" aria-live="polite">{selectionPending?'正在关联到当前对话…':selectionFeedback.state==='error'?selectionFeedback.error:'已关联当前选句 · 可在下方提出修改要求'}{selectionFeedback.state==='error'&&<button onClick={()=>void captureRef.current()}>重试</button>}</div>}
      {dialogBusy&&!selectionFeedback&&<div className="rw-word-selection-status" role="status">正在打开论文对话…</div>}
      <div className="rw-native-sentence-columns" hidden={tab==='format'}><div className="rw-native-sentence-conversation" aria-busy={selectionPending} inert={selectionBlocked||undefined} hidden={tab!=='chat'}>{job?sentence.nativeRender?.({project,job,selectionPending:selectionBlocked,autoSelectionDraft:selectionFeedback?.state==='ready'&&selectionFeedback.jobId===job.id,onError:setDialogError}):<div className="rw-word-sidebar-empty"><p>选中 Word 中的一句话提出修改要求，或围绕全文继续讨论。</p><button className="rw-secondary" disabled={interactionBusy||!sentence.nativeRender||Boolean(phase)} onClick={()=>void openConversation()}>{dialogError?'重新连接':'打开原生对话'}</button></div>}</div>{reviewJob?.output?.proposal&&<div className="rw-native-sentence-review" hidden={tab!=='review'}><RevisionPanel job={reviewJob} workingCopy currentRevision={object.revision} embedded busy={busy||selectionBlocked} error={error} modelReady onAction={act} onClassify={sentence.onClassify} onClose={()=>setTab('chat')}/></div>}{tab==='history'&&<DocumentHistory api={api} project={project} object={object} onRestore={restore}/>}<div className="rw-related-container" hidden={tab!=='related'}>{!phase&&<RelatedReminders api={api} project={project} object={object} onLocate={locate} onCount={setReminderCount}/>}</div></div>
    </aside></div>
  </section>;
}
