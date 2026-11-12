import React from 'react';
import { App } from './App.jsx';
import { createApi } from './api.mjs';
import { HostAdapter } from './host-adapter.mjs';
import { Icon } from './icons.jsx';
import { TASK_LABELS } from '../shared/model.mjs';
import { acceptanceMarker, storedMarker } from './native-evidence.mjs';
import { seedNativeDraft } from './native-fixture.mjs';
import { NativeSentenceAdapter } from './native-sentence-adapter.mjs';
import { DEFAULT_PROMPT } from './SentenceEditor.jsx';
import {PROMPT_TEMPLATES} from '../shared/revision-review.mjs';
import {PromptPicker} from './RevisionTools.jsx';

const NS = 'dsh-research-workbench';
const api = createApi();
const host = new HostAdapter(api);
const sentenceHost = new NativeSentenceAdapter(api);
let context;

function NativeBody(props) {
  const session = props.useSession((value) => value);
  const conversation = props.useConversation((value) => value);
  const input = props.useInput((value) => value);
  const workspaces = props.useWorkspaces((value) => value);
  const seeded = React.useRef(false);
  const member = Boolean(workspaces?.items?.some((workspace) => workspace.sessionIds.includes(props.sessionId)));
  React.useEffect(() => {
    const result = seedNativeDraft({ mode: props.acceptance?.mode, marker: props.acceptance?.marker, draft: input?.draft, phase: input?.phase, workspaceMember: member, applied: seeded.current, actions: props.inputActions });
    if (result === 'seeded') seeded.current = true;
  }, [props.acceptance?.mode, props.acceptance?.marker, input?.draft, input?.phase, member, props.inputActions]);
  const hero = session?.blank === true && !session?.promptAttempted && !conversation?.activeTargets?.size;
  React.useEffect(() => { host.markMounted(props.ownerKey, true); return () => host.markMounted(props.ownerKey, false); }, [props.ownerKey, props.sessionId]);
  React.useEffect(() => {
    const record = host.records.get(props.ownerKey);
    if (!record) return;
    record.nativeEvidence = { slotSessionId: props.sessionId, workspaceMember: member, inputPhase: input?.phase || null, draftMarker: acceptanceMarker(input?.draft), seededThisMount: seeded.current, fixtureMode: props.acceptance?.mode || null };
    host.notify();
  }, [props.ownerKey, props.sessionId, input?.draft, input?.phase, member, props.acceptance?.mode]);
  return props.renderFactorySlot('conversation.content', { variant: 'embedded', phase: hero ? 'hero' : 'active', hero });
}
class NativeBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div className="rw-native-failure" role="status">原生对话界面暂不可用。项目资料仍可编辑；重载 DSH 后可恢复同一会话。</div> : this.props.children; }
}
function NativeSessions({ info, SessionProvider, renderSlot }) {
  React.useSyncExternalStore(host.subscribe, host.getSnapshot);
  const ownerKey = `${info.project.id}:${info.task}`;
  React.useEffect(() => { if (host.sessions) void host.ensure(info.project, info.task, { onBinding: info.onBinding }); }, [ownerKey, info.project.bindings[info.task], host.sessions]);
  React.useEffect(() => {
    if (!info.acceptance || !host.sessions) return;
    let cancelled = false;
    void (async () => {
      for (const entry of info.acceptance.entries) {
        if (cancelled) return;
        const project = info.projects.find((candidate) => candidate.id === entry.projectId);
        if (!project) continue;
        if (info.acceptance.mode === 'restore' && !project.bindings[entry.task]) { info.onError('验收绑定缺失，未创建替代会话。'); continue; }
        await host.ensure(project, entry.task, { onBinding: info.onBinding });
      }
    })().catch(() => info.onError('原生验收尚未完成；项目与已有输入保留。'));
    return () => { cancelled = true; };
  }, [info.acceptance?.runId, info.acceptance?.mode, host.sessions]);
  const active = host.records.get(ownerKey);
  const available = typeof SessionProvider === 'function' && Boolean(host.sessions);
  return <>
    {(!active || active.status !== 'ready' || !available) && <div className="rw-chat-empty"><div className="rw-chat-symbol"><Icon name="chat" size={23} /></div><h3>{available ? active?.status === 'failed' ? '研究现场仍然保留' : `正在恢复${TASK_LABELS[info.task]}对话` : '原生对话暂不可用'}</h3><p>{active?.error || (available ? '沿用 DSH 中已有的模型配置，不会自动发送消息。' : '项目资料可独立查看和编辑。DSH 会话服务恢复后，可继续同一任务。')}</p>{available && active?.status === 'failed' && <><button className="rw-secondary" onClick={() => void host.ensure(info.project, info.task, { retry: true, onBinding: info.onBinding })}>重新连接</button><button className="rw-quiet" onClick={() => void host.ensure(info.project, info.task, { replace: true, onBinding: info.onBinding })}>新建此任务对话</button></>}</div>}
    {available && [...host.records.values()].filter((record) => record.ref && record.status === 'ready').map((record) => <div className="rw-native-frame" data-project-session={record.ownerKey} data-native-session-id={record.sessionId} hidden={record.ownerKey !== ownerKey} key={record.sessionId}><NativeBoundary key={record.sessionId}><SessionProvider session={record.ref}>{renderSlot(NS + '.session', { ownerKey: record.ownerKey, acceptance: info.acceptance?.entries.find((entry) => entry.projectId === record.projectId && entry.task === record.task) ? { mode: info.acceptance.mode, marker: info.acceptance.entries.find((entry) => entry.projectId === record.projectId && entry.task === record.task).marker } : null }, { only: 'native' })}</SessionProvider></NativeBoundary></div>)}
  </>;
}
function Panel(props) {
  return <App api={api} onLeave={() => context.layout.selectPanel(null)} nativeRender={(info) => <NativeSessions info={info} SessionProvider={props.SessionProvider} renderSlot={props.renderSlot} />} nativeSentenceRender={info => <NativeSentenceConversation info={info} SessionProvider={props.SessionProvider} renderSlot={props.renderSlot} />} />;
}
export function NativeSentenceBody(props) {
  const session = props.useSession(value => value), conversation = props.useConversation(value => value);
  const input = props.useInput(value => value), workspaces = props.useWorkspaces(value => value);
  const [notice, setNotice] = React.useState('');
  const body = React.useRef(null);
  const preparedSelection=React.useRef(null),automaticDraft=React.useRef(null);
  const [template,setTemplate]=React.useState('scientific');
  const templatePrompt=PROMPT_TEMPLATES.find(item=>item.id===template).prompt;
  const member = Boolean(workspaces?.items?.some(workspace => workspace.sessionIds.includes(props.sessionId)));
  const defaultRequest=(prompt=templatePrompt)=>props.conversationKind==='formatting'?'请检查当前 Word 的格式，并按我的要求生成可预览的格式方案。先不要应用。':props.autoSelectionDraft&&props.selectedText?`请修改当前选句：\n“${props.selectedText}”\n\n修改要求：${prompt}`:props.conversationOnly?'请结合整篇稿件及实际文献，讨论论证结构、术语一致性与证据支持，先给出修改建议，不直接改写文件。':prompt;
  const chooseTemplate=id=>{setTemplate(id);if(member&&input?.phase==='plain'&&!props.selectionPending&&(!input.draft?.trim()||input.draft===automaticDraft.current?.text)){const text=defaultRequest(PROMPT_TEMPLATES.find(item=>item.id===id).prompt);props.inputActions.setDraft(text);props.inputActions.persistDraft();automaticDraft.current={jobId:props.jobId,text};setNotice('模板已立即更新到输入框，可编辑后发送。')}else setNotice('模板已选择；已有输入已保留，可点击填入模板。')};
  const conversationContent=React.useMemo(()=>props.renderFactorySlot('conversation.content',{variant:'embedded',phase:'active',hero:false}),[props.renderFactorySlot]);
  const fillDefault = () => { if (!member || input?.phase !== 'plain'||props.selectionPending) return; if (input?.draft?.trim()&&input.draft!==automaticDraft.current?.text) { setNotice('原生输入框已有文字，已保留。可直接编辑后发送。'); return; } const text=defaultRequest();props.inputActions.setDraft(text); props.inputActions.persistDraft();automaticDraft.current={jobId:props.jobId,text}; setNotice('默认要求已填入原生输入框，确认模型后发送。'); };
  React.useEffect(()=>{
    if(props.conversationOnly){preparedSelection.current=null;return}
    if(!props.autoSelectionDraft||props.conversationOnly||!props.selectedText||props.selectionPending||!member||input?.phase!=='plain'||preparedSelection.current===props.jobId)return;
    preparedSelection.current=props.jobId;
    if(input.draft?.trim()&&input.draft!==automaticDraft.current?.text){setNotice('已切换当前选句；输入框已有内容已保留，请核对修改要求后发送。');return}
    const text=defaultRequest();automaticDraft.current={jobId:props.jobId,text};props.inputActions.setDraft(text);props.inputActions.persistDraft();setNotice('当前选句的默认要求已填入；可直接编辑，确认模型后发送。');
  },[props.autoSelectionDraft,props.conversationOnly,props.selectedText,props.selectionPending,props.jobId,member,input?.phase,input?.draft,props.inputActions]);
  React.useEffect(() => {
    const keys = event => {
      if (!event.ctrlKey || !event.altKey) return;
      if (event.key.toLowerCase() === 'i') { event.preventDefault(); event.stopPropagation(); const inputs = body.current?.querySelectorAll('[contenteditable="true"][role="textbox"]'); inputs?.[inputs.length - 1]?.focus(); }
      if (event.key.toLowerCase() === 'p') { event.preventDefault(); event.stopPropagation(); fillDefault(); }
      if (event.key === 'Enter' && member && input?.phase === 'plain'&&!props.selectionPending) { event.preventDefault(); event.stopPropagation(); if (input?.draft?.trim()) props.inputActions.submit(); else setNotice('请先在原生输入框填写修改要求。'); }
    };
    window.addEventListener('keydown', keys, true); return () => window.removeEventListener('keydown', keys, true);
  }, [member, input?.phase, input?.draft, props.inputActions,props.selectionPending,props.selectedText,props.autoSelectionDraft,template]);
  React.useEffect(() => { sentenceHost.mounted(props.jobId, true); return () => sentenceHost.mounted(props.jobId, false); }, [props.jobId, props.sessionId]);
  React.useEffect(() => { const record = sentenceHost.records.get(props.jobId); if (record) { record.nativeEvidence = { slotSessionId: props.sessionId, workspaceMember: member, inputPhase: input?.phase || null }; sentenceHost.notify(); } }, [props.jobId, props.sessionId, member, input?.phase]);
  React.useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),4000);return()=>clearTimeout(timer)},[notice]);
  return <div ref={body} className="rw-native-sentence-body">{(!member||!props.conversationOnly)&&<div className="rw-native-sentence-tools">{!member&&<span>正在加入论文工作区…</span>}{!props.conversationOnly&&<PromptPicker value={template} disabled={!member||input?.phase!=='plain'||props.selectionPending} onChange={chooseTemplate}/>}{!props.conversationOnly&&<button className="rw-secondary" title="填入默认要求（Ctrl+Alt+P），Ctrl+Alt+Enter 发送" disabled={!member||input?.phase!=='plain'||props.selectionPending} onClick={fillDefault}>填入模板</button>}</div>}{!props.conversationOnly&&<details className="rw-template-preview"><summary>查看模板内容</summary><p>{templatePrompt}</p></details>}{notice&&<p className="rw-native-sentence-notice" role="status">{notice}</p>}{conversationContent}</div>;
}
function NativeSentenceConversation({ info, SessionProvider, renderSlot }) {
  React.useSyncExternalStore(sentenceHost.subscribe, sentenceHost.getSnapshot);
  const [attempt, setAttempt] = React.useState(0);
  const [connectionError,setConnectionError]=React.useState('');
  const lastReady=React.useRef(null),readyService=React.useRef(null);
  React.useEffect(() => { let closed=false;if (sentenceHost.sessions && info.job?.native) {setConnectionError('');const previous=lastReady.current,warm=attempt===0&&readyService.current===sentenceHost.sessions&&previous?.projectId===info.project.id&&previous?.objectId===info.job.objectId&&previous?.sessionId===info.job.nativeSessionId;void (warm?Promise.resolve():api.mutate('reconnectNativeSentence',{})).then(()=>{if(!closed)return sentenceHost.ensure(info.project, info.job, info.onBinding,{verify:attempt>0})}).then(record=>{if(!closed&&record?.status==='ready')info.onError('')}).catch(error => {if(!closed){setConnectionError(error.message);info.onError(error.message)}})}return()=>{closed=true}; }, [info.job?.id, info.job?.nativeSessionId, sentenceHost.sessions, attempt]);
  const record = sentenceHost.records.get(info.job?.id);
  if(record?.status==='ready'){lastReady.current=record;readyService.current=sentenceHost.sessions}
  const previous=lastReady.current;
  const shown=record?.status==='ready'?record:record?.status!=='failed'&&readyService.current===sentenceHost.sessions&&previous?.projectId===info.project.id&&previous?.objectId===info.job?.objectId&&previous?.sessionId===info.job?.nativeSessionId?previous:null;
  if (connectionError||!SessionProvider || !sentenceHost.sessions || !shown) return <div className="rw-native-failure" role="status">{connectionError||record?.error || '正在连接 DSH 原生选句会话…'}{(connectionError||record?.status === 'failed') && <button className="rw-secondary" onClick={() => setAttempt(n => n + 1)}>重新连接</button>}</div>;
  const discussion=info.job.conversationOnly||['adopted','undone'].includes(info.job.output?.review);
  return <div className="rw-native-sentence-frame" data-native-sentence-session-id={shown.sessionId}><NativeBoundary key={shown.sessionId}><SessionProvider session={shown.ref}>{renderSlot(NS + '.sentence-session', { jobId: info.job.id,conversationKind:info.job.conversationKind, conversationOnly: discussion,selectedText:discussion?'':info.job.original||info.job.output?.original,selectionPending:info.selectionPending||record?.status!=='ready',autoSelectionDraft:info.autoSelectionDraft }, { only: 'native' })}</SessionProvider></NativeBoundary></div>;
}
function OpenButton() { return <button type="button" title="打开科研工作台" aria-label="科研工作台" onClick={() => context.layout.selectPanel(NS)} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 9px', border: 0, borderRadius: 6, color: 'inherit', background: 'transparent', cursor: 'pointer', fontSize: 12 }}><Icon name="brand" size={16} />科研工作台</button>; }
function WorkbenchRailIcon(){return <Icon name="brand" size={18}/>}
export const inject = ['slots', 'layout'];
export function apply(ctx) {
  context = ctx;
  ctx.effect(()=>ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:NS,order:-5,label:()=> '科研工作台'},WorkbenchRailIcon)),NS+': pinned sidebar entry');
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: NS, children: { [NS + '.session']: { kind: 'list', scope: 'session' }, [NS + '.sentence-session']: { kind: 'list', scope: 'session' } } }, Panel)), NS + ': project workspace');
  ctx.effect(() => ctx.slots.inject(NS + '.session', () => ctx.slots.register({ name: NS + '.session', id: 'native' }, NativeBody)), NS + ': native sessions');
  ctx.effect(() => ctx.slots.inject(NS + '.sentence-session', () => ctx.slots.register({ name: NS + '.sentence-session', id: 'native' }, NativeSentenceBody)), NS + ': native sentence sessions');
  for (const slot of ['conversation.session.header.utilities']) ctx.effect(() => ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, id: NS, order: 95 }, OpenButton)), NS + ': ' + slot);
  ctx.inject(['sessions'], (scope) => { host.setSessions(scope.sessions); sentenceHost.setSessions(scope.sessions); scope.effect(() => () => { host.setSessions(null); sentenceHost.setSessions(null); }, NS + ': native availability'); });
  ctx.effect(() => () => host.dispose(), NS + ': session ownership');
  ctx.effect(() => () => sentenceHost.dispose(), NS + ': sentence session ownership');
  ctx.effect(() => {
    let timer;
    const publish = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const bySession = new Map();
        for (const record of [...host.records.values(), ...sentenceHost.records.values()]) if (record.sessionId && (!bySession.has(record.sessionId) || record.mounted)) bySession.set(record.sessionId, record);
        const sessions = [...bySession.values()].map((record) => {
          const model = record.ref && record.status === 'ready' ? record.ref.binding.session.projections.faceOf('modelSelection').getSnapshot() : null;
          const next = model?.next || model?.lastUsed;
          return { projectId: record.projectId, task: record.task, jobId: record.jobId, sessionId: record.sessionId, status: record.status, errorCode: record.errorCode || null, mounted: Boolean(record.mounted), nativeEvidence: { ...record.nativeEvidence, storedDraftMarker: storedMarker(localStorage, record.sessionId) }, nextModel: next ? { provider: next.provider, model: next.model, reasoningEffort: next.reasoningEffort } : null };
        });
        void api.hostStatus({ version: '0.7.1', uiVersion:'0.11.0', origin: location.origin, userAgent: navigator.userAgent, sessions }).catch(() => {});
      }, 120);
    };
    const off = host.subscribe(publish), offSentence = sentenceHost.subscribe(publish); publish();
    return () => { off(); offSentence(); clearTimeout(timer); };
  }, NS + ': local host receipt');
  // Restore only our own panel preference. Never take over the standard view.
  const migrating = !localStorage.getItem(NS + ':project-ui-v1') && Boolean(localStorage.getItem(NS + ':phase0:v1'));
  localStorage.setItem(NS + ':project-ui-v1', '1');
  if (localStorage.getItem(NS + ':opened') === '1' || migrating) ctx.layout.selectPanel(NS);
  ctx.effect(() => ctx.layout.panelInfo.subscribe(() => { localStorage.setItem(NS + ':opened', ctx.layout.panelInfo.getSnapshot().activePanelId === NS ? '1' : '0'); }), NS + ': navigation');
}
