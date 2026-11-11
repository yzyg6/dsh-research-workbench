import React from 'react';
import {ActionMenu} from './ActionMenu.jsx';
import {WorkbenchSidebar} from './WorkbenchSidebar.jsx';
import {MottoTicker} from './MottoTicker.jsx';
import {readSidebarCollapsed,rememberSidebarCollapsed} from './workbench-preferences.mjs';
import { Icon } from './icons.jsx';
import { TASKS, TASK_LABELS, defaultLayout, normalizeLayout, objectForTask, visiblePanes } from '../shared/model.mjs';
import styles from './workbench.css';
import nativeTheme from './native-theme.css';
import compactLayout from './compact-layout.css';
import revisionToolsStyle from './revision-tools.css';
import refinedStyle from './refined-workbench.css';
import {DocumentHistory} from './RevisionTools.jsx';
import { SentenceEditor } from './SentenceEditor.jsx';
import { WorkspaceBrowser } from './WorkspaceBrowser.jsx';
import { WordEditor } from './WordEditor.jsx';
import { WordReader } from './WordReader.jsx';

const TASK_ICONS = { writing: 'write', figure: 'figure', reading: 'read' };
const KINDS = { manuscript: '正文', note: '笔记', data: '数据', figure: '图表', evidence: '证据', file: '文件' };
const date = (value) => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '尚未保存';
const paneNames = { main: '工作区', context: '项目资料', chat: 'DSH 原生对话' };
const RECOVERY_KEY = 'dsh-research-workbench:pending-drafts:v1';
const layoutEvent = (kind, event) => ({ id: crypto.randomUUID(), kind, trusted: event.isTrusted === true });
const workbenchStyles = styles + nativeTheme + compactLayout + revisionToolsStyle + refinedStyle;

function Modal({ title, onClose, children, footer }) {
  const ref = React.useRef(null);
  React.useEffect(() => { const dialog = ref.current; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} className="rw-modal" aria-label={title} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="rw-modal-head"><h2>{title}</h2><button className="rw-icon-button" aria-label="关闭弹窗" onClick={onClose}><Icon name="close" /></button></div>
    <div className="rw-modal-body">{children}</div>{footer && <div className="rw-modal-footer">{footer}</div>}
  </dialog>;
}

function Markdown({ text }) {
  // Stage-one readable draft surface. Rich editing and full Markdown fidelity
  // belong to the next milestone; raw text is always preserved on disk.
  const blocks = text.split(/\n\s*\n/);
  return blocks.map((block, index) => {
    if (/^### /.test(block)) return <h3 key={index}>{block.slice(4)}</h3>;
    if (/^## /.test(block)) return <h2 key={index}>{block.slice(3)}</h2>;
    if (/^# /.test(block)) return <h1 key={index}>{block.slice(2)}</h1>;
    if (/^---+$/.test(block.trim())) return <hr key={index} />;
    if (/^[-*] /.test(block)) return <ul key={index}>{block.split('\n').map((line, n) => <li key={n}>{line.replace(/^[-*] /, '')}</li>)}</ul>;
    return <p key={index} style={{ whiteSpace: 'pre-wrap' }}>{block}</p>;
  });
}

function Splitter({ left, right, layout, board, onChange, onCommit, onResizing }) {
  const drag = React.useRef(null);
  const pendingFrame = React.useRef(null);
  const cancelFrame = () => { if (pendingFrame.current !== null) cancelAnimationFrame(pendingFrame.current); pendingFrame.current = null; };
  React.useEffect(() => () => { cancelFrame(); }, []);
  const preview = (value) => {
    for (const key of [left, right]) {
      const pane = board.current?.querySelector(`[data-pane="${key}"]`);
      if (pane) pane.style.flex = `${value.weights[key]} 1 0`;
    }
  };
  const move = (delta) => {
    const base = drag.current?.weights || layout.weights;
    const total = base[left] + base[right];
    const next = Math.max(total * .22, Math.min(total * .78, base[left] + delta));
    const result = { ...layout, weights: { ...base, [left]: next, [right]: total - next } };
    return result;
  };
  return <div className="rw-splitter" role="separator" tabIndex={0} aria-label={`${paneNames[left]}与${paneNames[right]}宽度`} aria-orientation="vertical" aria-valuemin={22} aria-valuemax={78} aria-valuenow={Math.round(layout.weights[left] / (layout.weights[left] + layout.weights[right]) * 100)}
    onKeyDown={(event) => { if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return; event.preventDefault(); onCommit(move(event.key === 'ArrowRight' ? 3 : -3), layoutEvent('keyboard-resize', event)); }}
    onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, weights: { ...layout.weights }, width: board.current.clientWidth, total: visiblePanes(layout).reduce((sum, key) => sum + layout.weights[key], 0), last: layout }; onResizing(true); }}
    onPointerMove={(event) => { if (!drag.current) return; drag.current.last = move((event.clientX - drag.current.x) / drag.current.width * drag.current.total); if (pendingFrame.current === null) pendingFrame.current = requestAnimationFrame(() => { pendingFrame.current = null; if (drag.current) preview(drag.current.last); }); }}
    onPointerUp={(event) => { if (!drag.current) return; cancelFrame(); const result = move((event.clientX - drag.current.x) / drag.current.width * drag.current.total); preview(result); drag.current = null; onResizing(false); event.currentTarget.releasePointerCapture(event.pointerId); onCommit(result, layoutEvent('pointer-resize', event)); }}
    onPointerCancel={() => { cancelFrame(); preview(layout); drag.current = null; onResizing(false); onChange(layout); }}
    onLostPointerCapture={() => { if (!drag.current) return; cancelFrame(); preview(layout); drag.current = null; onResizing(false); }} />;
}

export function Dock({ task, layout, onLayout, children }) {
  const board = React.useRef(null);
  const [live, setLive] = React.useState(layout);
  const [resizing, setResizing] = React.useState(false);
  const [drop, setDrop] = React.useState(null);
  const dragged = React.useRef(null);
  React.useEffect(() => { setLive(layout); }, [layout]);
  const commit = (value, event) => { const safe = normalizeLayout(value, task); setLive(safe); onLayout(safe, event); };
  const shown = visiblePanes(live).filter(key => task !== 'writing' || key !== 'chat');
  const swap = (from, to, event) => { if (from === to || !from || !to) return; const order = [...live.order]; const a = order.indexOf(from), b = order.indexOf(to); [order[a], order[b]] = [order[b], order[a]]; commit({ ...live, order }, event); };
  const nodes = [];
  // Keep all three panels mounted, including minimized panels. Native composer
  // state must not disappear because a pane is resized or put away.
  for (const key of live.order) {
    if (task === 'writing' && key === 'chat') continue;
    const visible = shown.includes(key);
    nodes.push(<section key={key} className="rw-pane" data-pane={key} hidden={!visible} data-drop-target={drop === key} aria-label={key === 'main' ? TASK_LABELS[task] : paneNames[key]} style={{ flex: `${live.weights[key]} 1 0` }}
      onDragOver={(event) => { if (!dragged.current) return; event.preventDefault(); setDrop(key); }} onDragLeave={() => setDrop(null)}
      onDrop={(event) => { event.preventDefault(); swap(dragged.current, key, layoutEvent('pointer-drop', event)); dragged.current = null; setDrop(null); }}>
      <div className="rw-pane-head" onDoubleClick={(event) => { if (event.target.closest('button,select')) return; commit({ ...live, maximized: live.maximized === key ? null : key }); }}>
        <button className="rw-drag" draggable={!live.maximized} aria-label={`拖动${paneNames[key]}换位`} title="拖动换位" onDragStart={(event) => { dragged.current = key; event.dataTransfer.setData('text/plain', key); event.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => { dragged.current = null; setDrop(null); }}><Icon name="grip" size={13} /></button>
        <div className="rw-pane-title"><Icon name={key === 'chat' ? 'chat' : key === 'context' ? 'layers' : TASK_ICONS[task]} size={14} />{key === 'main' ? TASK_LABELS[task] : paneNames[key]}</div>
        <div className="rw-pane-controls"><select aria-label={`${paneNames[key]}换位`} title="面板换位" value="" onChange={(event) => swap(key, event.target.value)}><option value="">↔</option>{live.order.filter((other) => other !== key && (task !== 'writing' || other !== 'chat')).map((other) => <option key={other} value={other}>与{paneNames[other]}换位</option>)}</select>
          <button className="rw-icon-button" aria-label={`${live.maximized === key ? '还原' : '放大'}${paneNames[key]}`} onClick={() => commit({ ...live, maximized: live.maximized === key ? null : key })}><Icon name="maximize" size={12} /></button>
          <button className="rw-icon-button" aria-label={`收起${paneNames[key]}`} disabled={shown.length === 1 && !live.maximized} onClick={() => commit({ ...live, collapsed: { ...live.collapsed, [key]: true }, maximized: null })}><Icon name="minimize" size={13} /></button></div>
      </div><div className="rw-pane-body" style={key === 'chat' ? { display: 'flex', flexDirection: 'column', overflow: 'hidden' } : undefined}>{children[key]}</div>
    </section>);
    const next = shown[shown.indexOf(key) + 1];
    if (visible && next && !live.maximized) nodes.push(<Splitter key={`${key}-${next}`} left={key} right={next} layout={live} board={board} onChange={setLive} onCommit={commit} onResizing={setResizing} />);
  }
  return <div ref={board} className="rw-board" data-pane-count={shown.length} data-resizing={resizing} onKeyDown={(event) => { if (event.key === 'Escape' && live.maximized) commit({ ...live, maximized: null }); }}>{nodes}</div>;
}

function Context({ project, object, onSelect, showResources }) {
  return <div className="rw-context"><div className="rw-context-section"><h3>研究问题</h3><p className="rw-context-question">{project.question || '添加研究问题，让正文、数据与证据围绕同一条主线展开。'}</p></div>
    {showResources&&<div className="rw-context-section"><h3>项目资料 · {project.objects.length}</h3>{project.objects.map((item) => <button key={item.id} className="rw-resource" aria-selected={item.id === object?.id} onClick={() => onSelect(item)}><i className="rw-file-dot" data-kind={item.kind} /><span>{item.title}</span><small>v{item.revision}</small></button>)}</div>}
    <div className="rw-context-section"><h3>关联与来源</h3>{project.dependencies?.length ? project.dependencies.map((edge) => <div key={edge.id} className="rw-context-item"><Icon name="link" size={13} /><div>{project.objects.find((item) => item.id === edge.sourceId)?.title}<span> → </span>{project.objects.find((item) => item.id === edge.targetId)?.title}</div></div>) : <p className="rw-context-muted">保存的正文、数据与图表属于当前项目。文献原文与证据关系将在阅读空间接入。</p>}</div>
    <div className="rw-context-section"><span className="rw-context-tag">{project.language === 'en' ? '英文稿件' : '中文稿件'}</span>{project.journal && <span className="rw-context-tag">{project.journal}</span>}{project.isDemo && <span className="rw-context-tag">合成数据示例</span>}</div></div>;
}

function Content({ object, project, text, task, editMode, onEditMode, onText, onHistory, onCursor, cursor, onScroll, scrollTop, assetUrl, sentence, onOpenNative, api, wordSegment, onWordPosition, onSelectObject, onBrowseWorkspace, wordControl }) {
  const scroll = React.useRef(null);
  const editor = React.useRef(null);
  const [recovering,setRecovering]=React.useState(false),[recoveryError,setRecoveryError]=React.useState('');
  React.useEffect(()=>setRecoveryError(''),[object?.id]);
  React.useEffect(() => { if (scroll.current) scroll.current.scrollTop = scrollTop || 0; }, [object?.id, task]);
  React.useEffect(() => { if (editMode && editor.current) { editor.current.focus(); editor.current.setSelectionRange(cursor || 0, cursor || 0); } }, [object?.id, task, editMode]);
  if (!object) return <div className="rw-empty"><Icon name={TASK_ICONS[task]} size={30} /><h2>从一份资料开始</h2><p>在左侧新建笔记或导入 Markdown，保存后的内容可以跨任务使用。</p></div>;
  if (object.contentError) return <div className="rw-native-failure" role="alert">{recoveryError||object.contentError}<p>已有文稿和历史保留。可以重新扫描工作区，或尝试恢复缺失的 Word 工作副本。</p><div className="rw-file-recovery-actions">{object.metadata?.wordEditable&&/\.docx$/i.test(object.metadata.workspaceFile||object.title)&&<button className="rw-secondary" disabled={recovering} onClick={async()=>{setRecovering(true);setRecoveryError('');try{const next=await api.mutate('restoreWordWorkingCopy',{projectId:project.id,objectId:object.id});wordControl?.onSaved(next)}catch(e){setRecoveryError(e.message)}finally{setRecovering(false)}}}>{recovering?'正在核对并恢复…':'恢复工作副本'}</button>}<button className="rw-quiet" onClick={onBrowseWorkspace}>打开工作区文件</button></div></div>;
  if (object.encoding === 'binary' && /\.docx$/i.test(object.metadata?.workspaceFile || object.title)) { const manuscript=project.objects.find(item=>item.encoding==='utf8'&&item.kind==='manuscript'&&item.metadata?.workspaceFile?.toLowerCase()===(object.metadata?.workspaceFile||'').replace(/\.docx$/i,'.md').toLowerCase()); return task==='writing'?<WordEditor key={object.id} api={api} project={project} object={object} sentence={sentence} onHistory={onHistory} onSelectObject={onSelectObject} onBrowseWorkspace={onBrowseWorkspace} {...wordControl} initialSegment={wordSegment||0} onPosition={onWordPosition} onOpenNative={onOpenNative} onOpenMarkdown={manuscript?()=>onSelectObject(manuscript):null}/>:<WordReader key={`${object.id}:${object.revision}`} api={api} project={project} object={object} initialSegment={wordSegment||0} onPosition={onWordPosition} onOpenNative={onOpenNative} onOpenMarkdown={manuscript?()=>onSelectObject(manuscript):null}/>; }
  if (object.encoding === 'binary' && !(object.kind === 'figure' && object.metadata?.mimeType?.startsWith('image/')) && !(object.kind === 'data' && object.metadata?.preview)) return <div className="rw-file-preview"><Icon name="file" size={30} /><h2>{object.title}</h2><p>{object.metadata?.workspaceFile || '工作区原始文件'}</p><p className="rw-context-muted">保留原格式与文件版本；在原应用中打开和编辑，完成后重新扫描工作区。</p><button className="rw-primary" onClick={onOpenNative}>{object.kind === 'file' ? '在资源管理器中定位' : '使用原应用打开'}</button>{object.metadata?.mimeType === 'application/pdf' && <iframe title={object.title} src={assetUrl(project.id, object.id)} />}</div>;
  if (object.kind === 'figure') return <div className="rw-figure"><h2>{object.title}</h2><p>{object.metadata?.caption || '保留原始图文件与来源版本。'}</p><p className="rw-context-muted">格式：{Object.keys(object.metadata?.formats || {}).join(' / ') || 'PNG'} · 源文件 {object.metadata?.scripts?.length || 0} 项</p>{Boolean(object.metadata?.missing?.length) && <p className="rw-sentence-warning">历史资料缺项：{object.metadata.missing.join('、')}</p>}<button className="rw-secondary" onClick={() => onOpenNative(true)}>在工作区中定位图稿</button><img src={assetUrl(project.id, object.id)} alt={object.metadata?.caption || object.title} /><p style={{ marginTop: 16 }}>{object.metadata?.sampleDescription || '项目保存的图表资源'}</p></div>;
  if (object.kind === 'data') {
    const rows = text.trim().split('\n').map((line) => line.split(','));
    return <><div className="rw-object-toolbar"><Icon name="data" /><div><h2>{object.title}</h2><p>{object.metadata?.preview ? '预览 ' : ''}{Math.max(0, rows.length - 1)} 行 · {rows[0]?.length || 0} 个字段{project.isDemo ? ' · 合成实验样例' : object.metadata?.workspaceReadOnly ? ' · 原始数据只读' : ''}</p></div><button className="rw-quiet" onClick={onHistory}><Icon name="clock" size={14} />版本</button></div><div className="rw-table-wrap"><table className="rw-table"><thead><tr>{rows[0]?.map((cell, index) => <th key={index}>{cell}</th>)}</tr></thead><tbody>{rows.slice(1, 101).map((row, index) => <tr key={index}>{row.map((cell, n) => <td key={n}>{cell}</td>)}</tr>)}</tbody></table></div></>;
  }
  return <div ref={scroll} style={{ height: '100%', overflow: 'auto', display: 'flex', flexDirection: 'column' }} onScroll={(event) => onScroll(event.currentTarget.scrollTop)}>
    <div className="rw-pane-toolbar"><span className="rw-document-name"><Icon name="file" size={12} />{object.title.endsWith('.md') ? object.title : `${object.title}.md`}<span>·</span>v{object.revision}</span><div style={{ display: 'flex', alignItems: 'center', gap: 5 }}><button className="rw-icon-button" aria-label="查看内容版本" onClick={onHistory}><Icon name="clock" size={13} /></button><div className="rw-mode-tabs"><button aria-pressed={!editMode} onClick={() => onEditMode(false)}>{task === 'writing' && object.kind === 'manuscript' ? '写作' : '阅读'}</button><button aria-pressed={editMode} onClick={() => onEditMode(true)}>源码</button></div></div></div>
    {editMode ? <textarea ref={editor} className="rw-editor" aria-label="Markdown 草稿" spellCheck={false} value={text} onChange={(event) => onText(event.target.value)} onSelect={(event) => onCursor(event.currentTarget.selectionStart)} /> : <article className="rw-paper"><p className="rw-paper-eyebrow">{object.kind === 'note' ? 'Research note' : 'Manuscript draft'} · {project.isDemo ? 'Synthetic example' : 'Working paper'}</p><div className="rw-paper-meta"><span>{project.title}</span><span>{project.language === 'en' ? 'English' : '中文稿件'}</span><span>{date(object.updatedAt)}</span></div>{task === 'writing' && object.kind === 'manuscript' ? <SentenceEditor key={object.id} text={text} object={object} project={project} onText={onText} {...sentence} /> : <Markdown text={text} />}</article>}
  </div>;
}

export function App({ api, nativeRender, nativeSentenceRender, onLeave = null, preview = false }) {
  const [state, setState] = React.useState({ projects: [], activeProjectId: null });
  const current = React.useRef(state);
  const [sidebarCollapsed,setSidebarCollapsed]=React.useState(()=>readSidebarCollapsed());
  const toggleSidebar=()=>setSidebarCollapsed(value=>{const next=!value;rememberSidebarCollapsed(next);return next});
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [modal, setModal] = React.useState(null);
  const [projectToRemove,setProjectToRemove]=React.useState(null),[removingProject,setRemovingProject]=React.useState(false),[removalError,setRemovalError]=React.useState('');
  const [mottoSettingsOpen,setMottoSettingsOpen]=React.useState(false);
  const [form, setForm] = React.useState({ title: '', question: '', journal: '', language: 'zh' });
  const [history, setHistory] = React.useState([]);
  const drafts = React.useRef(new Map());
  const [draftEpoch, setDraftEpoch] = React.useState(0);
  const saving = React.useRef(null);
  const wordSave=React.useRef(null),wordDirty=React.useRef(false);
  const [wordChanged,setWordChanged]=React.useState(false);
  const registerWordSave=React.useCallback(callback=>{wordSave.current=callback;return()=>{if(wordSave.current===callback)wordSave.current=null}},[]);
  const markWordDirty=React.useCallback(value=>{wordDirty.current=value;setWordChanged(value)},[]);
  const [saveBusy, setSaveBusy] = React.useState(false);
  const liveTasks = React.useRef(new Map());
  const [taskEpoch, setTaskEpoch] = React.useState(0);
  const importRef = React.useRef(null);
  const mounted = React.useRef(true);
  const accept = React.useCallback((next) => { if (!mounted.current) return; current.current = next; setState(next); }, []);
  const cacheDrafts = () => { try { localStorage.setItem(RECOVERY_KEY, JSON.stringify([...drafts.current])); } catch { setError('浏览器未能缓存未保存输入，请先保存资料再退出。'); } };
  React.useEffect(() => {
    mounted.current = true;
    api.bootstrap().then((next) => {
      try {
        const recovery = JSON.parse(localStorage.getItem(RECOVERY_KEY) || '[]');
        if (Array.isArray(recovery)) for (const [objectId, entry] of recovery) {
          const owner = next.projects.find((p) => p.id === entry?.projectId), saved = owner?.objects.find((o) => o.id === objectId);
          if (saved && typeof entry.text === 'string' && Number.isInteger(entry.expectedRevision) && saved.text !== entry.text) drafts.current.set(objectId, entry);
        }
        cacheDrafts();
      } catch { setError('未保存输入缓存无法读取，缓存原件仍保留。'); }
      accept(next); setDraftEpoch((n) => n + 1);
    }).catch((e) => setError(e.message)).finally(() => setLoading(false));
    return () => { mounted.current = false; };
  }, [api, accept]);
  const mutate = async (action, data) => { const next = await api.mutate(action, data); accept(next); return next; };
  React.useEffect(() => {
    if (!api.stamp) return;
    let pending = false, cancelled = false;
    const check = async () => { if (pending || document.visibilityState === 'hidden') return; pending = true; try { const next = await api.stamp(); if (!cancelled && next.stamp !== current.current.stamp) { const fresh = await api.bootstrap(); if (!cancelled) accept(fresh); } } catch { /* Keep local drafts while a native connection is recovering. */ } finally { pending = false; } };
    const timer = setInterval(() => void check(), 2500);
    window.addEventListener('focus', check); document.addEventListener('visibilitychange', check);
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', check); };
  }, [api, accept]);
  const safe = (fn) => async (...args) => { try { setError(''); return await fn(...args); } catch (e) { setError(e.message || '操作未完成，输入仍保留。'); return null; } };
  const flush = React.useCallback(async () => {
    if (saving.current) return saving.current;
    const operation = (async () => {
      setSaveBusy(true);
      try {
        while (drafts.current.size) {
          const [objectId, entry] = drafts.current.entries().next().value;
          const project = current.current.projects.find((p) => p.id === entry.projectId);
          const object = project?.objects.find((o) => o.id === objectId);
          if (!object) throw new Error('草稿的原项目或资料已不可用，内容仍在本页保留。');
          const next = await api.mutate('saveObject', { projectId: project.id, objectId, expectedRevision: entry.expectedRevision, text: entry.text });
          accept(next);
          if (drafts.current.get(objectId) === entry) drafts.current.delete(objectId);
          else {
            const latest = drafts.current.get(objectId);
            const saved = next.projects.find((p) => p.id === project.id)?.objects.find((o) => o.id === objectId);
            if (latest?.expectedRevision === entry.expectedRevision && saved) drafts.current.set(objectId, { ...latest, expectedRevision: saved.revision });
          }
          cacheDrafts();
          setDraftEpoch((n) => n + 1);
        }
      } finally { setSaveBusy(false); }
    })();
    saving.current = operation;
    try { await operation; } finally { saving.current = null; }
  }, [api, accept]);
  React.useEffect(() => { if (!drafts.current.size) return; const timer = setTimeout(() => void flush().catch((e) => setError(e.message)), 750); return () => clearTimeout(timer); }, [draftEpoch, flush]);
  React.useEffect(() => { const guard = (event) => { if (drafts.current.size || wordDirty.current) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard); }, []);
  React.useEffect(() => { if (!state.projects.some((p) => p.jobs?.some((job) => ['queued', 'running'].includes(job.status)))) return; const interval = setInterval(() => api.bootstrap().then(accept).catch(() => {}), 1600); return () => clearInterval(interval); }, [state, api, accept]);
  const project = state.projects.find((item) => item.id === state.activeProjectId) || state.projects[0];
  const task = project?.activeTask || 'writing';
  const taskKey = project ? `${project.id}:${task}` : '';
  const storedTask = project?.taskStates?.[task]?.value || {};
  const view = { ...storedTask, ...liveTasks.current.get(taskKey) };
  const layout = React.useMemo(() => { const value = normalizeLayout(view.layout, task); return task === 'writing' ? { ...value, collapsed: { ...value.collapsed, chat: true }, maximized: value.maximized === 'chat' ? null : value.maximized } : value; }, [view.layout, task]);
  const object = project ? objectForTask({ ...project, taskStates: { ...project.taskStates, [task]: { value: view } } }, task) : null;
  const text = object ? drafts.current.get(object.id)?.text ?? object.text ?? '' : '';
  const persistView = async (patch) => {
    if (!project) return;
    const owner = project.id, ownerTask = task, key = taskKey;
    const base = { ...current.current.projects.find((p) => p.id === owner)?.taskStates[ownerTask]?.value, ...liveTasks.current.get(key), ...patch };
    liveTasks.current.set(key, base); setTaskEpoch((n) => n + 1);
    const next = await api.mutate('saveTaskState', { projectId: owner, task: ownerTask, patch });
    accept(next);
    if (liveTasks.current.get(key) === base) liveTasks.current.delete(key);
  };
  const pendingViewTimers = React.useRef(new Map());
  const pendingViewPatches = React.useRef(new Map());
  const ephemeralView = (patch) => {
    const key = taskKey, owner = project.id, ownerTask = task;
    const base = { ...view, ...liveTasks.current.get(key), ...patch };
    liveTasks.current.set(key, base); setTaskEpoch((n) => n + 1);
    pendingViewPatches.current.set(key, { ...pendingViewPatches.current.get(key), ...patch });
    clearTimeout(pendingViewTimers.current.get(key));
    pendingViewTimers.current.set(key, setTimeout(() => {
      const changes = pendingViewPatches.current.get(key); pendingViewPatches.current.delete(key);
      api.mutate('saveTaskState', { projectId: owner, task: ownerTask, patch: changes }).then((next) => { accept(next); if (liveTasks.current.get(key) === base) liveTasks.current.delete(key); }).catch((e) => setError(e.message));
    }, 450));
  };
  const flushViews = async () => {
    for (const timer of pendingViewTimers.current.values()) clearTimeout(timer);
    pendingViewTimers.current.clear(); pendingViewPatches.current.clear();
    for (const [key, value] of [...liveTasks.current]) {
      const [projectId, ownerTask] = key.split(':');
      const next = await api.mutate('saveTaskState', { projectId, task: ownerTask, patch: value });
      accept(next);
      if (liveTasks.current.get(key) === value) liveTasks.current.delete(key);
    }
  };
  const saveAll = async () => { await wordSave.current?.();await flush();await flushViews(); };
  const openNewProject = () => { setForm({ title: '', question: '', journal: '', language: 'zh', workspacePath: '', directory: '' }); setModal('new'); };
  const editProject = safe(async () => { await saveAll(); await mutate('updateProject', { projectId: project.id, patch: form }); setModal(null); });
  const changeProject = safe(async (id) => { await saveAll(); await mutate('activateProject', { projectId: id }); setModal(null); });
  const removeProject=async()=>{if(!projectToRemove||removingProject)return;setRemovingProject(true);setRemovalError('');try{await saveAll();await mutate('removeProject',{projectId:projectToRemove.id});setProjectToRemove(null);setModal('projects');setNotice('已从项目列表删除，磁盘文件与文档历史均已保留。')}catch(e){setRemovalError(e.message)}finally{setRemovingProject(false)}};
  const changeTask = safe(async (next) => { await saveAll(); await mutate('updateProject', { projectId: project.id, patch: { activeTask: next } }); });
  const selectObject = safe(async (item) => { await saveAll(); await persistView({ selectedObjectId: item.id, scrollTop: 0, cursor: 0 }); });
  const showHistory = safe(async () => { await saveAll(); setHistory(await api.versions(project.id, object.id)); setModal('history'); });
  const createProject = safe(async (isDemo = false) => { await saveAll(); await mutate(isDemo ? 'createDemo' : 'createProject', form); setModal(null); setForm({ title: '', question: '', journal: '', language: 'zh' }); });
  const addNote = safe(async () => { await saveAll(); const next = await mutate('createObject', { projectId: project.id, kind: 'note', title: '研究笔记', text: '# 研究笔记\n\n' }); const owner = next.projects.find((p) => p.id === project.id); const note = owner.objects.at(-1); await persistView({ selectedObjectId: note.id, editMode: true }); });
  const importMarkdown = safe(async (event) => { const file = event.target.files[0]; if (!file) return; if (file.size > 1024 * 1024) throw new Error('当前稿件导入上限为 1 MiB。'); const body = await file.text(); await saveAll(); const next = await mutate('createObject', { projectId: project.id, kind: 'manuscript', title: file.name.replace(/\.md$/i, ''), text: body }); const imported = next.projects.find((p) => p.id === project.id).objects.at(-1); await persistView({ selectedObjectId: imported.id, editMode: false }); event.target.value = ''; });
  const running = state.projects.flatMap((p) => p.jobs || []).filter((job) => ['queued', 'running'].includes(job.status)).length;
  const changed = drafts.current.size > 0 || wordChanged;
  const isWord=object?.encoding==='binary'&&/\.docx$/i.test(object.metadata?.workspaceFile||object.title);
  const prepareSentence = async ({ markdown, ...request }) => {
    if(request.wordSelection){await saveAll();const saved=current.current.projects.find(p=>p.id===project.id).objects.find(o=>o.id===object.id);const next=await mutate('prepareSentenceSession',{...request,projectId:project.id,objectId:object.id,expectedRevision:saved.revision});return next.actionResult.jobId;}
    if ((drafts.current.get(object.id)?.text ?? object.text) !== markdown) {
      drafts.current.set(object.id, { projectId: project.id, text: markdown, expectedRevision: drafts.current.get(object.id)?.expectedRevision ?? object.revision }); cacheDrafts(); setDraftEpoch(n => n + 1);
    }
    await saveAll();
    const saved = current.current.projects.find(p => p.id === project.id).objects.find(o => o.id === object.id);
    const next = await mutate('prepareSentenceSession', { ...request, projectId: project.id, objectId: object.id, expectedRevision: saved.revision, operationKey: crypto.randomUUID() });
    return next.actionResult.jobId;
  };
  const context = project && <Context project={project} object={object} onSelect={selectObject} showResources={sidebarCollapsed} />;
  const content = project && <Content key={`${project.id}:${task}`} project={project} task={task} object={object} text={text} editMode={Boolean(view.editMode)} cursor={view.cursor} scrollTop={view.scrollTop} onCursor={(cursor) => ephemeralView({ cursor })} onScroll={(scrollTop) => ephemeralView({ scrollTop })} onEditMode={safe((editMode) => persistView({ editMode }))} onText={(value) => { drafts.current.set(object.id, { projectId: project.id, text: value, expectedRevision: drafts.current.get(object.id)?.expectedRevision ?? object.revision }); cacheDrafts(); setDraftEpoch((n) => n + 1); }} onHistory={showHistory} wordControl={{onSaved:accept,registerSave:registerWordSave,onDirty:markWordDirty}} assetUrl={api.assetUrl} api={api} wordSegment={view.wordViews?.[object?.id] || 0} onWordPosition={segment => { const positions={...view.wordViews,[object.id]:segment}; ephemeralView({wordViews:Object.fromEntries(Object.entries(positions).slice(-30))}); }} onSelectObject={selectObject} onBrowseWorkspace={()=>setModal('workspace-files')} onOpenNative={safe((reveal = false) => mutate('openWorkspaceFile', { projectId: project.id, objectId: object.id, reveal: reveal === true }))} sentence={{
    resolveImage: src => api.imageUrl?.(project.id, object.id, src) || src,
    jobs: project.jobs, modelReady: state.integrations?.sentenceModel === 'ready',
    nativeRender: nativeSentenceRender ? info => nativeSentenceRender({ ...info, onBinding: accept }) : null,
    onNativePrepare: nativeSentenceRender ? prepareSentence : null,
    onOpenConversation: nativeSentenceRender ? async ({markdown,...options}) => { if (object.encoding==='utf8' && (drafts.current.get(object.id)?.text ?? object.text) !== markdown) { drafts.current.set(object.id, { projectId: project.id, text: markdown, expectedRevision: drafts.current.get(object.id)?.expectedRevision ?? object.revision }); cacheDrafts(); setDraftEpoch(n=>n+1); } await saveAll(); const next=await mutate('openWritingConversation',{projectId:project.id,objectId:object.id,...options});return next.actionResult.jobId; } : null,
    initialNativeJobId: project.writingThreads?.[object?.id]?.jobId||view.sentenceJobId,
    onNativeOpen: jobId => persistView({ sentenceJobId: jobId }),
    onRefresh: async () => { const fresh=await api.stamp();if(fresh.stamp!==current.current.stamp)accept(await api.bootstrap()); },
    onRevise: async ({ markdown, ...request }) => {
      if ((drafts.current.get(object.id)?.text ?? object.text) !== markdown) {
        drafts.current.set(object.id, { projectId: project.id, text: markdown, expectedRevision: drafts.current.get(object.id)?.expectedRevision ?? object.revision });
        cacheDrafts(); setDraftEpoch(n => n + 1);
      }
      await saveAll();
      const saved = current.current.projects.find(p => p.id === project.id).objects.find(o => o.id === object.id);
      const next = await mutate('reviseSentence', { ...request, projectId: project.id, objectId: object.id, expectedRevision: saved.revision, operationKey: crypto.randomUUID() });
      return next.actionResult.jobId;
    },
    onClassify: async (jobId,data) => { await mutate('classifySentence',{projectId:project.id,jobId,...data}); },
    onAction: async (action, jobId) => { await saveAll(); await mutate(action, { projectId: project.id, jobId }); },
    onImport: async data => { await mutate('importLiterature', { ...data, projectId: project.id }); },
  }} />;
  const chat = project && task !== 'writing' && <><div className="rw-chat-intro"><Icon name="link" size={12}/><span>已关联当前项目资料</span></div><div className="rw-chat-area">{nativeRender ? nativeRender({ project, task, projects: state.projects, acceptance: state.nativeAcceptance, onBinding: accept, onError: setError }) : <div className="rw-chat-empty"><div className="rw-chat-symbol"><Icon name="chat" size={23} /></div><h3>把思路留在研究现场</h3><p>{preview ? '这是独立界面预览。DSH 中会在此承载原生对话，沿用已有模型配置。' : '在 DSH Desktop 打开工作台，使用写作、制图和阅读各自的原生对话。'}<br />项目资料始终可以独立使用。</p></div>}</div></>;
  return <><style>{workbenchStyles}</style><div className="rw-app" data-task={task} data-sidebar-collapsed={sidebarCollapsed} data-acceptance={Boolean(state.nativeAcceptance)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void safe(saveAll)(); } }}>
    <header className="rw-topbar">
      <button className="rw-icon-button rw-sidebar-toggle" aria-label={sidebarCollapsed?'展开工作台左侧栏':'收起工作台左侧栏'} aria-expanded={!sidebarCollapsed} aria-controls="rw-project-sidebar" title={sidebarCollapsed?'展开左侧栏':'收起为图标栏'} onClick={toggleSidebar}><Icon name="sidebar" size={18}/></button>
      <div className="rw-brand"><span className="rw-brand-emblem"><Icon name="brand" size={18}/></span><strong>科研工作台</strong></div>
      <div className="rw-breadcrumb"><strong title={project?.rootPath||''}>{project?.title||'开启新的研究'}</strong>{project&&<><span className="rw-breadcrumb-divider" aria-hidden="true">/</span><h1 className="rw-task-label">{TASK_LABELS[task]}</h1></>}{project?.isDemo&&<span className="rw-sample-tag">实验示例</span>}</div>
      <MottoTicker settingsOpen={mottoSettingsOpen} onSettingsChange={setMottoSettingsOpen}/>
      <div className="rw-top-actions"><span className="rw-save-state" data-dirty={changed||Boolean(error)}>{saveBusy?'正在保存':error?'有内容尚未保存':changed?'有未保存内容':project?.workspace?.checkpointError?'工作区待同步':'已保存'}</span>
        <button className="rw-primary rw-global-save" disabled={!project||saveBusy} aria-label={isWord?'保存 Word':'保存资料'} title={isWord?'保存到同一 Word 工作副本（Ctrl+S）':'保存（Ctrl+S）'} onClick={()=>void safe(saveAll)()}><Icon name="save" size={14}/><span>保存</span></button>
        <button className="rw-icon-button" aria-label="后台任务" title={running?`${running} 个后台任务`:'后台任务'} onClick={()=>setModal('jobs')}><Icon name="clock" size={16}/>{running>0&&<small>{running}</small>}</button>
        <ActionMenu label="工作台与布局操作" icon="settings">
          {project&&<><button onClick={()=>void safe(()=>persistView({layout:{...layout,maximized:layout.maximized==='main'?null:'main'}}))()}>{layout.maximized==='main'?'还原面板大小':'放大当前工作区'}</button><button onClick={()=>void safe(()=>persistView({layout:{...layout,collapsed:{...layout.collapsed,context:!layout.collapsed.context},maximized:null}}))()}>{layout.collapsed.context?'显示项目资料面板':'收起项目资料面板'}</button>
          {Object.entries(layout.collapsed).filter(([key,hidden])=>hidden&&key!=='context'&&(task!=='writing'||key!=='chat')).map(([key])=><button key={key} onClick={()=>void safe(()=>persistView({layout:{...layout,collapsed:{...layout.collapsed,[key]:false},maximized:null}}))()}>展开{paneNames[key]}</button>)}
          <button onClick={()=>void safe(()=>persistView({layout:defaultLayout(task)}))()}>重置布局</button></>}
          <button onClick={()=>setMottoSettingsOpen(true)}>励志标语设置</button><button onClick={()=>setModal('about')}>工作台信息</button>
        </ActionMenu>
        {onLeave&&<button className="rw-icon-button" aria-label="返回 DSH" title="返回 DSH" onClick={()=>void safe(async()=>{await saveAll();onLeave()})()}><Icon name="arrow" size={16}/></button>}
      </div>
    </header>
    {state.nativeAcceptance && <div className="rw-banner" role="status">{state.nativeAcceptance.mode === 'restore' ? '本机验收模式 · 测试草稿已保存，恢复检查由工作台继续完成；请勿发送。' : '本机验收模式 · 请把蓝色拖动柄拖到另一面板内，再拖动蓝色竖线；无需输入或发送消息。'}</div>}{preview && <div className="rw-banner rw-preview-banner"><span>界面预览 · 合成实验样例</span><span>仅本机</span></div>}{project?.workspace?.checkpointError && <div className="rw-banner" role="alert">{project.workspace.checkpointError}</div>}{error && <div className="rw-banner" data-error="true" role="alert"><span>{error}</span><button aria-label="关闭错误提示" className="rw-icon-button" onClick={() => setError('')}><Icon name="close" size={13} /></button></div>}
    <div className="rw-body"><WorkbenchSidebar collapsed={sidebarCollapsed} project={project} task={task} object={object} onNewProject={openNewProject} onProjects={()=>setModal('projects')} onOpenWorkspace={()=>{setForm({path:'',title:''});setModal('open-workspace')}} onFiles={()=>setModal('workspace-files')} onTask={key=>void changeTask(key)} onNote={()=>void addNote()} onSelect={item=>void selectObject(item)} onImport={()=>importRef.current.click()} onResources={()=>setModal('resources')}/><input ref={importRef} hidden type="file" accept=".md,.markdown,.txt" aria-label="导入 Markdown 文件" onChange={event=>void importMarkdown(event)}/>
      <main className="rw-workspace">{project ? <><Dock task={task} layout={layout} onLayout={(value, event) => void safe(() => persistView({ layout: value, ...(event ? { layoutEvent: event } : {}) }))()}>{{ main: content, context, chat }}</Dock></> : <div className="rw-empty"><div className="rw-empty-mark"><Icon name="brand" size={31} /></div><div><h1>让一个研究问题，成为一篇论文。</h1><p>{loading ? '正在打开本机工作台…' : '把论证、数据、图表和文献放回同一处。每个任务保留自己的对话，每个项目保留自己的研究现场。'}</p></div><div className="rw-empty-buttons"><button className="rw-primary" onClick={openNewProject}><Icon name="plus" size={15} />新建论文项目</button><button className="rw-secondary" onClick={() => void createProject(true)}>打开实验示例<Icon name="arrow" size={14} /></button></div></div>}</main></div>
    {notice && <div role="status" className="rw-toast">{notice}</div>}
    {['new', 'edit'].includes(modal) && <Modal title={modal === 'edit' ? '项目信息' : '新建论文项目'} onClose={() => setModal(null)} footer={<><button className="rw-quiet" onClick={() => setModal(null)}>取消</button><button className="rw-primary" disabled={!form.title.trim()} onClick={() => void (modal === 'edit' ? editProject() : createProject(false))}>{modal === 'edit' ? '保存项目信息' : '创建项目'}<Icon name="arrow" size={14} /></button></>}><label>项目名称<input autoFocus placeholder="例如：分组干预与时序响应" maxLength={120} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label><label>保存位置<input aria-label="项目保存位置" placeholder="使用工作台默认位置" readOnly={modal === 'edit'} value={modal === 'edit' ? project.rootPath : form.workspacePath || ''} onChange={(event) => setForm({ ...form, workspacePath: event.target.value })} /></label><label>研究问题<textarea placeholder="这个研究试图回答什么？可以稍后补充。" value={form.question} onChange={(event) => setForm({ ...form, question: event.target.value })} /></label><div style={{ display: 'flex', gap: 14 }}><label style={{ flex: 1 }}>目标期刊<input placeholder="可稍后填写" value={form.journal} onChange={(event) => setForm({ ...form, journal: event.target.value })} /></label><label style={{ width: 115 }}>稿件语言<select value={form.language} onChange={(event) => setForm({ ...form, language: event.target.value })}><option value="zh">中文</option><option value="en">English</option></select></label></div><p className="rw-context-muted">每个项目独立保存正文、资料、布局与三个任务会话。目录缺失时自动创建，已有目录通过“打开已有工作区”关联。正文、图表、数据、参考文献和过程文件按目录分类保存。</p></Modal>}
    {modal === 'projects' && <Modal title="你的研究项目" onClose={() => setModal(null)} footer={<>{project && <button className="rw-quiet" onClick={() => { setForm({ title: project.title, question: project.question, journal: project.journal, language: project.language }); setModal('edit'); }}>项目信息</button>}<button className="rw-quiet" onClick={() => void createProject(true)}>打开实验示例</button><button className="rw-primary" onClick={openNewProject}><Icon name="plus" size={14} />新建项目</button></>}>{state.projects.length ? state.projects.map((item) => <div className="rw-project-entry" key={item.id}><button className="rw-project-row" aria-current={item.id === project?.id} onClick={() => void changeProject(item.id)}><Icon name="folder" size={20} /><span><strong>{item.title}</strong><small>{TASK_LABELS[item.activeTask]} · {date(item.updatedAt)}{item.isDemo ? ' · 合成实验示例' : ''}</small></span>{item.id === project?.id && <Icon name="check" size={17} />}</button><button className="rw-icon-button rw-project-delete" aria-label={`删除项目：${item.title}`} title="从列表删除，保留磁盘文件" onClick={()=>{setProjectToRemove(item);setRemovalError('');setModal('remove-project')}}><Icon name="trash" size={15}/></button></div>) : <p className="rw-context-muted">还没有研究项目。创建一篇论文，或先打开合成实验示例。</p>}</Modal>}
    {modal==='remove-project'&&projectToRemove&&<Modal title="删除这个研究项目？" onClose={()=>{if(!removingProject)setModal('projects')}} footer={<><button className="rw-quiet" disabled={removingProject} onClick={()=>setModal('projects')}>取消</button><button className="rw-primary" disabled={removingProject} onClick={()=>void removeProject()}>{removingProject?'正在删除…':'从列表删除'}</button></>}><p className="rw-project-remove-title">{projectToRemove.title}</p><p className="rw-context-muted">只从工作台项目列表移除。磁盘上的原稿、工作副本、资料与 Git 历史均保留，不删除原生对话。以后可以通过“打开已有工作区”重新添加。</p><p className="rw-project-remove-path">{projectToRemove.rootPath}</p>{removalError&&<p className="rw-error-text" role="alert">{removalError}</p>}</Modal>}
    {modal === 'open-workspace' && <Modal title="打开已有论文工作区" onClose={() => setModal(null)} footer={<button className="rw-primary" disabled={!form.path?.trim()} onClick={() => void safe(async () => { await saveAll(); await mutate('openWorkspace', { path: form.path.trim(), title: form.title?.trim() || undefined }); setModal(null); })()}>关联并打开</button>}><div className="rw-form"><label>论文根目录<input autoFocus value={form.path || ''} onChange={event => setForm({ ...form, path: event.target.value })} placeholder="D:\Research\MyPaper" /></label><p className="rw-context-muted">自动匹配 paper、picture、Data、reference、temp；缺失目录自动创建，保留既有 .git 和文件。</p></div></Modal>}
    {modal==='resources'&&project&&<Modal title="项目资料" onClose={()=>setModal(null)} footer={<button className="rw-secondary" onClick={()=>{setModal(null);importRef.current.click()}}>导入 Markdown</button>}>{project.objects.map(item=><button className="rw-project-row" key={item.id} title={item.metadata?.workspaceFile||item.title} onClick={async()=>{await selectObject(item);setModal(null)}}><Icon name={item.kind==='data'?'data':item.kind==='figure'?'figure':'file'} size={17}/><span><strong>{item.title}</strong><small>{KINDS[item.kind]} · v{item.revision}</small></span>{item.id===object?.id&&<Icon name="check" size={15}/>}</button>)}</Modal>}
    {modal === 'workspace-files' && project && <Modal title="论文工作区文件" onClose={() => setModal(null)}><WorkspaceBrowser api={api} project={project} onRefresh={async () => { await saveAll(); await mutate('refreshWorkspace', { projectId: project.id }); }} onReveal={() => void safe(() => mutate('openWorkspaceFile', { projectId: project.id }))()} onSelect={async entry => { await saveAll(); const next = await mutate('importWorkspaceFile', { projectId: project.id, path: entry.relativePath, openOriginal: /\.docx$/i.test(entry.relativePath) }); const selected = next.projects.find(p => p.id === project.id).objects.find(o => o.id === next.actionResult.objectId), targetTask = ['figure', 'data'].includes(selected.kind) ? 'figure' : selected.kind === 'evidence' ? 'reading' : 'writing'; await mutate('saveTaskState', { projectId: project.id, task: targetTask, patch: { selectedObjectId: selected.id, scrollTop: 0 } }); await mutate('updateProject', { projectId: project.id, patch: { activeTask: targetTask } }); setModal(null); }} /></Modal>}
    {modal === 'history' && <Modal title={object.kind==='manuscript'?'文档 Git 历史':'保存的内容版本'} onClose={() => setModal(null)}>{object.kind==='manuscript'?<DocumentHistory api={api} project={project} object={object} onRestore={async commit=>{await saveAll();const saved=current.current.projects.find(p=>p.id===project.id).objects.find(o=>o.id===object.id);await mutate('restoreDocumentHistory',{projectId:project.id,objectId:object.id,commit,expectedRevision:saved.revision})}}/>:history.map((version) => <div className="rw-history-row" key={version.revision}><strong>{isWord?(version.revision===object.revision&&object.metadata?.wordEditable?'当前工作副本':version.revision===1?'原始文稿':`已有存档 · 修订 ${version.revision}`):`版本 ${version.revision}`}</strong><p>{date(version.createdAt)} · {version.sha256.slice(0, 12)}</p></div>)}</Modal>}
    {modal === 'jobs' && <Modal title="后台任务" onClose={() => setModal(null)} footer={project && <button className="rw-secondary" onClick={() => void safe(() => mutate('enqueueJob', { projectId: project.id, type: 'project.integrity', operationKey: crypto.randomUUID() }))()}><Icon name="check" size={14} />检查当前项目文件</button>}>{state.projects.flatMap((owner) => (owner.jobs || []).map((job) => <div className="rw-job" key={job.id}><Icon name={job.status === 'succeeded' ? 'check' : 'clock'} size={17} /><div><strong>{job.type === 'writing.sentence' ? '选句修改' : '项目文件检查'}</strong><small>{owner.title}</small><p>{job.phase || job.status}{job.error ? ` · ${job.error}` : ''}</p></div>{job.type !== 'writing.sentence' && ['failed', 'interrupted', 'cancelled', 'outdated'].includes(job.status) && <button className="rw-quiet" onClick={() => void safe(() => mutate('retryJob', { projectId: owner.id, jobId: job.id }))()}>重试</button>}{['queued', 'running'].includes(job.status) && <button className="rw-quiet" onClick={() => void safe(() => mutate('cancelJob', { projectId: owner.id, jobId: job.id }))()}>取消</button>}</div>))}{!state.projects.some((p) => p.jobs?.length) && <p className="rw-context-muted">暂无后台任务。切换项目不会中断已提交的工作；处理结果会保存在所属项目。</p>}</Modal>}
    {modal === 'about' && <Modal title="关于这个研究现场" onClose={() => setModal(null)}><div className="rw-context-section"><h3>科研工作台 · 项目与任务空间</h3><p className="rw-context-muted">每篇论文独立存储，布局和会话按项目、任务恢复。当前可以管理项目资料、保存 Markdown 草稿和版本、查看本机任务。</p></div><div className="rw-context-section"><h3>原生对话</h3><p className="rw-context-muted">在 DSH 中沿用已有模型配置。对话暂不可用时，项目资料仍然可以查看和编辑。</p></div><p className="rw-context-muted">{project?.rootPath || '新项目保存在独立科研工作台目录。'}</p><p className="rw-context-muted" style={{ marginTop: 12 }}>写作页支持直接编辑、选句改写、全文上下文与文献检索，对照采用并保留版本。已解析的文献 Markdown 可在选句浮窗中加入共享文献库。</p></Modal>}
  </div></>;
}





