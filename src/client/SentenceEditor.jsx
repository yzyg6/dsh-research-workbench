import React from 'react';
import { Editor } from '@tiptap/core';
import { writingExtensions, sentenceAnchor } from '../shared/writing-document.mjs';
import { Icon } from './icons.jsx';
import katexStyles from './katex.generated.css';
import { SentenceComparison, PromptPicker } from './RevisionTools.jsx';
import { DEFAULT_REVISION_PROMPT, PROMPT_TEMPLATES } from '../shared/revision-review.mjs';

export const DEFAULT_PROMPT = DEFAULT_REVISION_PROMPT;

export function RevisionPanel({ anchor, job, busy, error, onGenerate, onAction, onClassify, onEditSuggestion, onEditingChange, onClose, onImport, modelReady, currentRevision, workingCopy=false, embedded = false }) {
  const [instruction, setInstruction] = React.useState(DEFAULT_PROMPT);
  const [template,setTemplate]=React.useState('scientific');
  const [keywords, setKeywords] = React.useState('');
  const [advanced, setAdvanced] = React.useState(false);
  const [refining, setRefining] = React.useState(false);
  const [imported, setImported] = React.useState('');
  const [editingSuggestion,setEditingSuggestion]=React.useState(false);
  const fileRef = React.useRef(null);
  const bodyRef = React.useRef(null);
  const [viewport, setViewport] = React.useState(() => ({ width: globalThis.window?.innerWidth || 1200, height: globalThis.window?.innerHeight || 800 }));
  React.useEffect(() => { const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight }); window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize); }, []);
  const output = job?.output, proposal = output?.proposal;
  React.useLayoutEffect(() => { if (proposal && bodyRef.current) bodyRef.current.scrollTop = 0; }, [job?.id]);
  const running = ['queued', 'running'].includes(job?.status), pending = output?.review === 'pending';
  const outdated=job?.status==='outdated'||(pending&&Number.isInteger(currentRevision)&&output.expectedRevision!==currentRevision);
  const undoOutdated=output?.review==='adopted'&&Number.isInteger(currentRevision)&&output.appliedRevision!==currentRevision;
  const original = output?.original || anchor?.selectedText || '';
  const position = anchor?.position || { left: Math.max(16, viewport.width / 2 - 220), top: 100 };
  const top = Math.max(16, Math.min(position.top, viewport.height - (proposal ? 620 : 370)));
  return <aside className={`rw-sentence-panel${embedded ? ' rw-sentence-embedded' : ''}`} role={embedded ? 'region' : 'dialog'} aria-label={embedded ? '改写对照与文献依据' : '选句修改'} style={embedded ? { position: 'static', width: '100%', height: '100%', maxHeight: 'none', border: 0, borderRadius: 0, boxShadow: 'none' } : { left: Math.max(12, Math.min(position.left, viewport.width - 456)), top, maxHeight: viewport.height - top - 16 }} onMouseDown={event => event.stopPropagation()}>
    <header><span className="rw-sentence-mark"><Icon name="write" size={17} /></span><div><strong>{embedded ? '改写对照' : '选句修改'}</strong><small>结合全文 · 检索文献 · 对照采用</small></div>{!embedded && <button className="rw-icon-button" aria-label="关闭选句修改" onClick={onClose}><Icon name="close" size={15} /></button>}</header>
    <div ref={bodyRef} className="rw-sentence-body">
      {proposal ? <SentenceComparison key={job.id} before={original} after={proposal.replacement} changes={proposal.sentenceChanges} busy={busy} editable={pending&&!outdated&&job.status==='succeeded'} onEditingChange={value=>{setEditingSuggestion(value);onEditingChange?.(value)}} onEdit={onEditSuggestion?data=>onEditSuggestion(job.id,data):undefined} onClassify={onClassify ? data=>onClassify(job.id,data) : undefined}/> : <><div className="rw-sentence-label">已选正文</div><blockquote className="rw-sentence-original">{original}</blockquote></>}
      {anchor && (!proposal || refining) && !output?.review?.match(/adopted|undone/) && <><PromptPicker value={template} disabled={running||busy} onChange={id=>{setTemplate(id);setInstruction(PROMPT_TEMPLATES.find(item=>item.id===id).prompt)}}/><label className="rw-sentence-label" htmlFor="rw-sentence-request">你的修改要求</label><textarea id="rw-sentence-request" aria-label="句子修改要求" placeholder="例如：更简洁；强调研究意义；核对因果关系……" value={instruction} onChange={event => setInstruction(event.target.value)} maxLength={6000} disabled={running || busy} /><div className="rw-sentence-presets">{['更简洁', '增强逻辑衔接', '核对证据与措辞'].map(text => <button key={text} disabled={running || busy} onClick={() => setInstruction(text)}>{text}</button>)}</div>
      <button className="rw-sentence-disclosure" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}><Icon name="search" size={12} />文献检索设置<Icon name="down" size={10} /></button>
      {advanced && <div className="rw-sentence-retrieval"><label>文献关键词（可选）<input aria-label="文献关键词" value={keywords} maxLength={500} onChange={event => setKeywords(event.target.value)} placeholder="留空则从选句提取，支持中英文关键词" /></label><p>优先检索 Zotero MCP 全文与本地已解析文献。关键词命中后，再判断证据是否支持表达。</p><button className="rw-quiet" disabled={busy || running} onClick={() => fileRef.current.click()}><Icon name="upload" size={12} />添加已解析文献 Markdown</button><input hidden ref={fileRef} type="file" accept=".md,.markdown,.txt" aria-label="添加本地文献" onChange={async event => { const file = event.target.files[0]; if (!file) return; try { if (file.size > 1024 * 1024) throw new Error('文献文件上限为 1 MiB。'); await onImport({ title: file.name, text: await file.text() }); setImported(`已加入共享文献库：${file.name}`); } catch (error) { setImported(error.message); } event.target.value = ''; }} />{imported && <p role="status">{imported}</p>}</div>}
      {anchor && <div className="rw-sentence-generate"><button className="rw-secondary" disabled={running || busy || !modelReady} onClick={() => onGenerate(DEFAULT_PROMPT, keywords, job?.id)} title={DEFAULT_PROMPT}>默认学术润色</button><button className="rw-primary" disabled={!instruction.trim() || running || busy || !modelReady} onClick={() => onGenerate(instruction, keywords, job?.id)}>{proposal ? '按要求继续修改' : '按要求修改'}<Icon name="arrow" size={13} /></button></div>}</>}
      {!embedded && !modelReady && <p className="rw-sentence-warning">原生模型服务尚未加载。请重启 DSH 应用与 Host，沿用已有模型配置。</p>}
      {(running || busy) && <div className="rw-sentence-progress" role="status"><span />{busy ? '正在保存与准备…' : job.phase}</div>}
      {error && <p role="alert" className="rw-sentence-warning">{error}</p>}
      {job?.error && <p role="alert" className="rw-sentence-warning">{job.error}</p>}
      {proposal && <>{output.instruction && <p className="rw-sentence-reason">修改要求：{output.instruction}</p>}<p className="rw-sentence-reason">{proposal.reason}</p>
      <div className="rw-sentence-context"><Icon name="file" size={12} /><span>整篇稿件已带入 · {workingCopy?'修订 r':'v'}{output.expectedRevision}</span><span>{output.model?.model}</span></div>
      {[...(output.evidence?.warnings || []), ...proposal.warnings].map((warning, index) => <p className="rw-sentence-warning" key={index}>{warning}</p>)}
      <details className="rw-evidence-list" open={embedded || undefined}><summary>文献依据 · {proposal.evidenceIds.length} 条用于建议 / {output.evidence.sources.length} 条命中</summary><p className="rw-context-muted">检索词：{output.evidence.terms.join('、') || '无'} · Zotero {output.evidence.zotero === 'searched' ? '已检索' : '不可用'}</p>{output.evidence.sources.map(source => <article key={source.id} className="rw-evidence-card"><div><b>{source.id}</b><span>{proposal.evidenceIds.includes(source.id) ? '用于本次建议' : '检索命中 · 未采用'}</span></div><strong>{source.title}</strong><small>{source.kind} · {source.locator}{source.synthetic ? ' · 合成测试资料' : ''}</small><blockquote>{source.snippet}</blockquote>{source.url && <a href={source.url}>在 Zotero 中定位文献 ↗</a>}</article>)}</details>
      {outdated && <p className="rw-sentence-warning">{workingCopy?'正文已有后续修改，请在当前正文重新选句。':'正文已有新版本，原文保持不变。请在最新正文重新选句。'}</p>}
      {undoOutdated && <p className="rw-sentence-warning">采用后正文已有更新，不能直接撤回。请先查看版本记录，保留后续修改。</p>}
      {anchor && pending && !refining && <button className="rw-secondary" onClick={() => setRefining(true)}>继续提要求</button>}
</>}
      {running && <button className="rw-quiet" onClick={() => onAction('cancelJob', job.id)}>取消本次生成</button>}
    </div>
    {proposal && <div className="rw-sentence-review">{pending && <button className="rw-primary" disabled={busy || editingSuggestion || outdated || job.status !== 'succeeded'} onClick={() => onAction('applySentence', job.id)}><Icon name="check" size={14} />采用修改{job.native ? '（Ctrl+Alt+A）' : ''}</button>}{output.review === 'adopted' && <><span><Icon name="check" size={13} />{workingCopy?'已保存到工作副本':`已保存 v${output.appliedRevision}`}</span><button className="rw-secondary" disabled={busy||undoOutdated} onClick={() => onAction('undoSentence', job.id)}>撤回本次采用{job.native ? '（Ctrl+Alt+Z）' : ''}</button></>}{output.review === 'undone' && <span>已撤回 · 修改历史保留</span>}{pending && <button className="rw-quiet" onClick={onClose}>保留原文</button>}</div>}
    <footer>{workingCopy?'采用后更新同一 Word 工作副本 · 支持撤回':'只有采用后才替换原句 · 每次修改保留版本'}</footer>
  </aside>;
}

export function SentenceEditor({ text, object, project, jobs, modelReady, onText, onRevise, onAction, onClassify, onEditSuggestion, onImport, nativeRender, onNativePrepare, onRefresh, initialNativeJobId, onNativeOpen, onOpenConversation, resolveImage }) {
  const conversations=(project.writingConversations||[]).filter(thread=>thread.objectId===object.id);
  const element = React.useRef(null), editor = React.useRef(null), callbacks = React.useRef({ onText });
  const suggestionEditing=React.useRef(false);
  callbacks.current = { onText };
  const [selection, setSelection] = React.useState(null), [jobId, setJobId] = React.useState(null), [notice, setNotice] = React.useState('');
  const [error, setError] = React.useState(''), [busy, setBusy] = React.useState(false), [history, setHistory] = React.useState(false);
  const [editorError, setEditorError] = React.useState('');
  const lastNativeJob = React.useRef(null); if (jobId) lastNativeJob.current = jobId;
  const [nativeTab, setNativeTab] = React.useState('chat'), [floating, setFloating] = React.useState(null);
  const floatingDrag = React.useRef(null);
  const floatingPosition = () => {
    const width = Math.min(nativeTab === 'review' ? 820 : 440, window.innerWidth - 24), height = Math.min(nativeTab === 'review' ? 560 : 470, window.innerHeight - 24);
    const position = floating || selection?.position || { left: window.innerWidth - width - 24, top: window.innerHeight - height - 24 };
    return { left: Math.max(12, Math.min(position.left, window.innerWidth - width - 12)), top: Math.max(12, Math.min(position.top, window.innerHeight - height - 12)) };
  };
  React.useEffect(() => { const focus = event => { if (event.ctrlKey && event.altKey && event.key.toLowerCase() === 'w') { event.preventDefault(); event.stopPropagation(); editor.current?.commands.focus(); } }; window.addEventListener('keydown', focus, true); return () => window.removeEventListener('keydown', focus, true); }, []);
  const refresh = React.useRef(onRefresh); refresh.current = onRefresh;
  React.useEffect(() => { if (!nativeRender || !(selection || jobId)) return; const timer = setInterval(() => void refresh.current?.().catch(() => {}), 1200); return () => clearInterval(timer); }, [Boolean(nativeRender), Boolean(selection || jobId)]);
  React.useEffect(() => {
    if (!selection || !onNativePrepare) return;
    let cancelled = false; setBusy(true);
    void onNativePrepare({ document: selection.document, from: selection.from, to: selection.to, markdown: selection.markdown }).then(async id => { if (!cancelled) { setJobId(id); await onNativeOpen?.(id); } }).catch(error => { if (!cancelled) { setError(error.message); if (lastNativeJob.current) { setSelection(null); setJobId(lastNativeJob.current); } } }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [selection, Boolean(onNativePrepare)]);
  React.useEffect(() => { const close = event => { if (event.key === 'Escape' && !event.defaultPrevented && !busy) { setSelection(null); setJobId(null); setError(''); void onNativeOpen?.(null).catch(() => {}); } }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, [busy]);
  React.useEffect(() => {
    try {
      const instance = new Editor({ element: element.current, extensions: writingExtensions({ resolveImage }), content: text, contentType: 'markdown', editorProps: { attributes: { class: 'rw-rich-content', 'aria-label': '论文正文编辑器', role: 'textbox', 'aria-multiline': 'true', spellcheck: 'false' } }, onUpdate: ({ editor }) => callbacks.current.onText(editor.getMarkdown()) });
      editor.current = instance;
      return () => { editor.current = null; instance.destroy(); };
    } catch { setEditorError('此稿件包含当前编辑器无法解析的内容，请切换源码编辑，原 Markdown 保留。'); }
  }, [object.id]);
  React.useEffect(() => { const instance = editor.current; if (instance && text !== instance.getMarkdown()) { instance.commands.setContent(text, { contentType: 'markdown', emitUpdate: false }); } }, [text]);
  const capture = () => {
    const instance = editor.current;
    if (!instance || instance.state.selection.empty || !instance.view.hasFocus()) return;
    const { from, to } = instance.state.selection;
    try {
      const document = instance.getJSON(), anchor = sentenceAnchor(document, from, to);
      const coords = instance.view.coordsAtPos(to);
      setSelection({ document, from, to, selectedText: anchor.selectedText, markdown: anchor.markdown, position: { left: coords.left + 16, top: coords.bottom + 12 } }); setJobId(null); setNativeTab('chat'); setHistory(false); setError('');
    } catch (error) { setError(error.message); }
  };
  const generate = async (instruction, keywords, parentJobId) => {
    try {
      setBusy(true); setError('');
      const live = editor.current;
      if (!selection || JSON.stringify(live.getJSON()) !== JSON.stringify(selection.document)) throw new Error('选句后的正文已有变化，请重新选中要修改的句子。');
      const id = await onRevise({ document: selection.document, from: selection.from, to: selection.to, instruction, keywords, parentJobId, markdown: selection.markdown });
      setJobId(id);
    } catch (error) { setError(error.message); } finally { setBusy(false); }
  };
  const close = async () => { setSelection(null); setJobId(null); setError(''); await onNativeOpen?.(null); };
  const openConversation = async (options = {}) => { try { setBusy(true); setError(''); const previous = !Object.keys(options).length && jobs?.find(item => item.id === (lastNativeJob.current || initialNativeJobId) && item.native && item.objectId === object.id && !['adopted','undone'].includes(item.output?.review)); const id = previous?.id || await onOpenConversation({ ...options, markdown: editor.current?.getMarkdown() || text }); setSelection(null); setJobId(id); setNativeTab('chat'); setHistory(false); await onNativeOpen?.(id); } catch(error) { setError(error.message); } finally { setBusy(false); } };
  const act = async (action, id) => { if(action==='applySentence'&&suggestionEditing.current){setError('请先保存或取消正在编辑的本句建议。');return} try { setBusy(true); setError(''); await onAction(action, id); if (['applySentence','undoSentence'].includes(action)) { setNotice(action === 'applySentence' ? '修改已保存，对话已收起；可在改写记录中查看或撤回。' : '已撤回本次采用，历史记录保留。'); await close(); } } catch (error) { setError(error.message); } finally { setBusy(false); } };
  const relevant = (jobs || []).filter(job => job.type === 'writing.sentence' && !job.conversationOnly && (job.output?.objectId || job.objectId) === object.id);
  const undoable = relevant.find(item => item.output?.review === 'adopted' && item.output.appliedRevision === object.revision);
  const job = (jobs || []).find(item => item.id === jobId);
  const dialogActions = React.useRef(null); dialogActions.current = { openConversation, close, opened: Boolean(selection || jobId), busy };
  React.useEffect(() => { const keys = event => { if (!nativeRender || !event.ctrlKey || !event.altKey || event.key.toLowerCase() !== 'c') return; event.preventDefault(); event.stopPropagation(); const action=dialogActions.current;if(!action.busy)void (action.opened ? action.close() : action.openConversation()).catch(error=>setError(error.message)); }; window.addEventListener('keydown',keys,true);return()=>window.removeEventListener('keydown',keys,true); }, [Boolean(nativeRender)]);
  React.useEffect(() => {
    const keys = event => {
      if (!nativeRender || !job?.native || busy || !event.ctrlKey || !event.altKey) return;
      if (event.key.toLowerCase() === 'd' && job.output?.proposal) { event.preventDefault(); event.stopPropagation(); setNativeTab(tab => tab === 'review' ? 'chat' : 'review'); }
      if (event.key.toLowerCase() === 'a' && job.status === 'succeeded' && job.output?.review === 'pending' && job.output.expectedRevision === object.revision) { event.preventDefault(); event.stopPropagation(); void act('applySentence', job.id); }
      if (event.key.toLowerCase() === 'z' && job.output?.review === 'adopted' && job.output.appliedRevision === object.revision) { event.preventDefault(); event.stopPropagation(); void act('undoSentence', job.id); }
    }; window.addEventListener('keydown', keys, true); return () => window.removeEventListener('keydown', keys, true);
  }, [nativeRender, job?.id, job?.status, job?.output?.review, busy, object.revision]);
  return <><style>{katexStyles}</style><div className="rw-writing-hint"><Icon name="write" size={12} /><span>选句即修改 · 完成即收起</span>{nativeRender && <button className="rw-secondary" disabled={busy} onClick={() => void openConversation()}><Icon name="chat" size={12} />论文修改对话</button>}{undoable && <button className="rw-quiet" disabled={busy} onClick={() => void act('undoSentence',undoable.id)}>撤回上次采用</button>}<button className="rw-quiet" onClick={() => setHistory(!history)}>改写记录{relevant.length ? ` · ${relevant.length}` : ''}</button></div>{notice && <p className="rw-writing-notice" role="status">{notice}</p>}{history && <div className="rw-revision-history">{relevant.length ? [...relevant].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(item => <button key={item.id} onClick={() => { setJobId(item.id); setSelection(null); setHistory(false); setNativeTab('review'); setError(''); if (item.native) void onNativeOpen?.(item.id).catch(error => setError(error.message)); }}><span>{(item.output?.original || item.original || '选句会话').slice(0, 50)}</span><small>{new Date(item.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} · {item.phase}</small>{item.output?.instruction && <small>{item.output.instruction.slice(0, 100)}</small>}</button>) : <p>尚无保存的句子改写。</p>}</div>}
    {editorError && <p role="alert" className="rw-sentence-warning">{editorError}</p>}
    <div ref={element} className="rw-rich-editor" onMouseUp={() => setTimeout(capture, 0)} onKeyUp={event => { if (event.shiftKey) setTimeout(capture, 0); }} />
    {(selection || jobId) && (nativeRender && (!job || job.native) ? <section className={`rw-native-sentence-dialog${nativeTab === 'review' ? ' rw-native-review-open' : ''}`} role="dialog" aria-label="DSH 原生论文修改对话" style={floatingPosition()}>
      <header onPointerDown={event => { if (event.button !== 0 || event.target.closest('button')) return; const box = event.currentTarget.parentElement.getBoundingClientRect(); floatingDrag.current = { x: event.clientX, y: event.clientY, left: box.left, top: box.top }; event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); }} onPointerMove={event => { const drag = floatingDrag.current; if (drag) setFloating({ left: drag.left + event.clientX - drag.x, top: drag.top + event.clientY - drag.y }); }} onPointerUp={event => { floatingDrag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { floatingDrag.current = null; }}>
        <Icon name="chat" size={15} /><strong>论文修改</strong><small>DSH 原生对话</small><button className="rw-icon-button" aria-label="收起论文修改对话" onClick={() => void close().catch(error=>setError(error.message))}><Icon name="close" size={15} /></button>
      </header>
      <div className="rw-writing-conversation-controls"><span title={project.rootPath}>工作区 · {project.title}</span><button className="rw-quiet" disabled={busy} onClick={() => void openConversation({newThread:true})}>新建对话</button>{conversations.length > 1 && <select aria-label="切换论文修改对话" disabled={busy} value={job?.nativeSessionId || ''} onChange={event=>void openConversation({sessionId:event.target.value})}><option value="" disabled>选择对话</option>{conversations.map((thread,index)=><option key={thread.sessionId} value={thread.sessionId}>对话 {conversations.length-index} · {new Date(thread.updatedAt).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}</option>)}</select>}</div>
      {!job?.conversationOnly && <div className="rw-native-sentence-target"><span>当前选句</span>{job?.original || selection?.selectedText}</div>}
      <nav className="rw-native-sentence-tabs" aria-label="选句修改视图"><button aria-pressed={nativeTab === 'chat'} onClick={() => setNativeTab('chat')}>修改对话</button><button aria-pressed={nativeTab === 'review'} disabled={!job?.output?.proposal} onClick={() => setNativeTab('review')}>修改对照与文献依据{job?.output?.review === 'pending' ? ' · 待复核' : ''}</button></nav>
      {error && <p role="alert" className="rw-sentence-warning">{error}</p>}
      <div className="rw-native-sentence-columns"><div className="rw-native-sentence-conversation" hidden={nativeTab !== 'chat'}>{job ? nativeRender({ project, job, onError: setError }) : <p className="rw-native-failure">正在保存选区并准备原生会话…</p>}</div>{job?.output?.proposal && <div className="rw-native-sentence-review" hidden={nativeTab !== 'review'}><RevisionPanel job={job} currentRevision={object.revision} embedded busy={busy} error={error} modelReady onAction={act} onClassify={onClassify} onEditSuggestion={onEditSuggestion} onEditingChange={value=>{suggestionEditing.current=value}} onClose={() => setNativeTab('chat')} /></div>}</div>
    </section> : <RevisionPanel key={`${selection?.from}:${selection?.to}:${selection?.markdown || 'history'}`} anchor={selection} job={job} currentRevision={object.revision} error={error} busy={busy} modelReady={modelReady} onGenerate={generate} onAction={act} onClassify={onClassify} onEditSuggestion={onEditSuggestion} onEditingChange={value=>{suggestionEditing.current=value}} onClose={() => { setSelection(null); setJobId(null); setError(''); }} onImport={onImport} />)}
    {!selection && !jobId && error && <p className="rw-sentence-warning" role="alert">{error}</p>}
  </>;
}
