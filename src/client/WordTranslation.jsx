import React from 'react';
import { Icon } from './icons.jsx';

const running = status => ['queued','running'].includes(status);
const stateLabels = { queued:'等待翻译', running:'翻译中', ready:'待采用', adopted:'已采用', failed:'待续译', empty:'无译文' };
const readable = text => text.replace(/⟦\d+⟧/g, ' ‹› ');

const dispatchStates = {queued:'待调度', pending:'待继续', running:'运行中', retrying:'重试中', planned:'已规划', done:'已完成', reused:'沿用已有译文', unverified:'待核对', failed:'失败'};
const dispatchTasks = {'document-brief':'统一术语与文体','part-plan':'部分规划','section-plan':'小节规划',
  'paragraph-translation':'翻译初稿','part-review':'跨小节复核','section-review':'英文衔接与 Humanizer 复核'};
const unitKinds = {heading:'标题', caption:'题注', 'table-cell':'表格文字', paragraph:'段落'};
const isWorking = node => node.state === 'running' || node.state === 'retrying';
const isFinished = node => node.state === 'done' || node.state === 'reused';

function DispatchState({node}) {
  return <span className="rw-dispatch-state" data-state={node.state}>
    {dispatchStates[node.state]}{node.task && ' · ' + dispatchTasks[node.task]}
  </span>;
}

function TranslationSchedule({schedule}) {
  const [open, setOpen] = React.useState(false);
  if (!schedule) return <small className="rw-translation-history-note">此任务没有保存子智能体调度记录。</small>;
  const {document:brief, parts} = schedule;
  const sections = parts.flatMap(part => part.sections);
  const workers = [brief, ...parts, ...sections, ...sections.flatMap(section => section.paragraphs)];
  const active = workers.filter(isWorking).length;
  const failed = workers.filter(node => node.state === 'failed').length;
  const reused = workers.filter(node => node.state === 'reused').length;
  const progress = nodes => {
    const busy = nodes.filter(isWorking).length;
    return busy ? ' · ' + busy + ' 运行中' : '';
  };
  return <details className="rw-translation-schedule" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>子智能体调度 <span>已完成 {workers.filter(isFinished).length}/{workers.length}
      {reused > 0 && ' · ' + reused + ' 项沿用已有译文'}
      {active > 0 && ' · ' + active + ' 运行中'}{failed > 0 && ' · ' + failed + ' 失败'}</span></summary>
    {open && <div className="rw-dispatch-tree">
      <div>全文术语与文体 <DispatchState node={brief}/></div>
      {brief.error && <small>{brief.error}</small>}
      {parts.map(part => <details key={part.id}>
        <summary>部分 · {part.title} <DispatchState node={part}/>
          {progress(part.sections.flatMap(section => [section, ...section.paragraphs]))}</summary>
        {part.error && <small>{part.error}</small>}
        {part.sections.map(section => <details key={section.id}>
          <summary>小节 · {section.title} <DispatchState node={section}/>
            <span> · 已译 {section.paragraphs.filter(isFinished).length}/{section.paragraphs.length}{progress(section.paragraphs)}</span></summary>
          {(section.error || section.sectionError) && <small>本节待续译 · {section.error || section.sectionError}</small>}
          <ol>{section.paragraphs.map(node => <li key={node.id}>
            {unitKinds[node.kind]} · {node.excerpt} <DispatchState node={node}/>
            {node.error && <small>{node.error}</small>}
          </li>)}</ol>
        </details>)}
      </details>)}
    </div>}
  </details>;
}

export function WordTranslationPanel({ api, active, project, object, editMode, busy, onStart, onSaved, onOpenTarget, onLocate }) {
  const [journal, setJournal] = React.useState(project.journal || '');
  const [scope, setScope] = React.useState('document');
  const [snapshot, setSnapshot] = React.useState(null);
  const [jobId, setJobId] = React.useState('');
  const [chapterId, setChapterId] = React.useState('');
  const [setup, setSetup] = React.useState(false);
  const [refresh, setRefresh] = React.useState(0);
  const [pending, setPending] = React.useState(false);
  const [fault, setFault] = React.useState('');
  const [offline, setOffline] = React.useState('');
  const [editor, setEditor] = React.useState(null);
  const [confirmAll, setConfirmAll] = React.useState(false);
  const owner = { projectId:project.id, objectId:object.id, jobId:snapshot?.id };
  const chapter = snapshot?.current;
  const chapters = snapshot?.chapters || [];
  const generating = running(snapshot?.status);
  const ready = chapters.filter(item => item.state === 'ready');
  const adopted = chapters.filter(item => item.state === 'adopted');
  const translated = chapters.reduce((count, item) => count + item.translated, 0);
  const units = chapters.reduce((count, item) => count + item.count, 0);
  const stale = snapshot?.stale || snapshot?.id && snapshot.sourceRevision !== object.revision;
  const blocked = busy || pending || generating || stale;
  const imageIssues = chapter?.images.filter(image => image.state !== 'clear') || [];
  const canRetry = snapshot?.id && !generating && !stale && chapters.some(item => ['failed','queued','running'].includes(item.state));

  React.useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer;
    async function read() {
      try {
        const next = await api.translationStatus({ projectId:project.id, objectId:object.id, jobId, chapterId }, controller.signal);
        if (controller.signal.aborted) return;
        setSnapshot(next);
        setOffline('');
        if (running(next.status) || !next.available) timer = setTimeout(read, next.available ? 950 : 2000);
      } catch (error) {
        if (controller.signal.aborted) return;
        setOffline(error.message);
        timer = setTimeout(read, 2200);
      }
    }
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, active, project.id, object.id, object.revision, jobId, chapterId, refresh]);

  const run = async (operation, done) => {
    setPending(true);
    setFault('');
    try {
      const next = await operation();
      done?.(next);
    } catch (error) { setFault(error.message); }
    finally { setPending(false); setRefresh(value => value + 1); }
  };
  const start = event => {
    event.preventDefault();
    void run(() => onStart({ scope, journal, operationKey:crypto.randomUUID() }), next => {
      setJobId(next.jobId);
      setChapterId('');
      setSetup(false);
    });
  };
  const action = (name, fields) => api.mutate(name, { ...owner, ...fields });
  const adopt = all => void run(() => action('adoptWordTranslation', {
    updatedAt:snapshot.updatedAt, ...(!all && { chapterId:chapter.id }),
  }), next => { onSaved(next); setConfirmAll(false); setChapterId(chapter.id); });
  const saveEdit = () => void run(async () => {
    await action('editWordTranslation', {
      chapterId:chapter.id, unitId:editor.id, previous:editor.previous, english:editor.text,
    });
    return api.translationStatus({ ...owner, chapterId:chapter.id });
  }, next => { setSnapshot(next); setEditor(null); });

  return <section className="rw-translation" hidden={!active} aria-label="英文翻译">
    <header className="rw-translation-header">
      <h3><Icon name="write" size={14}/>中英对照</h3>
      {snapshot?.id && <button className="rw-quiet" disabled={pending || Boolean(editor)} onClick={() => setSetup(value => !value)}>{setup ? '收起设置' : '新建翻译'}</button>}
      {snapshot?.history?.length > 1 && <select aria-label="翻译历史" disabled={pending || Boolean(editor)} value={snapshot.id} onChange={event => {
        setJobId(event.target.value); setChapterId(''); setConfirmAll(false); setFault('');
      }}>{snapshot.history.map(item => <option key={item.id} value={item.id}>{item.scope === 'document' ? '全文' : '选区'} · {item.journal || '通用学术英文'} · {new Date(item.createdAt).toLocaleString('zh-CN')}</option>)}</select>}
    </header>
    {(!snapshot?.id || setup) && <form className="rw-translation-setup" onSubmit={start}>
      <label>翻译范围<select aria-label="翻译范围" value={scope} onChange={event => setScope(event.target.value)} disabled={pending}>
        <option value="document">全文</option><option value="selection" disabled={!editMode}>Word 选区</option>
      </select></label>
      <label>目标期刊<input value={journal} maxLength={200} placeholder="通用学术英文" onChange={event => setJournal(event.target.value)} disabled={pending}/></label>
      <button className="rw-primary" disabled={busy || pending || !snapshot?.available || scope === 'selection' && !editMode}>生成英文译文</button>
      {scope === 'selection' && <small>先在正文或表格中选中文字。</small>}
      {snapshot && !snapshot.available && <small role="status">请连接 DSH 模型后开始翻译。</small>}
    </form>}
    {offline && <p className="rw-error" role="alert">{offline}</p>}
    {fault && <p className="rw-error" role="alert">{fault}</p>}
    {snapshot?.id && <>
      <div className="rw-translation-progress" role="status">
        <span>{snapshot.journal || '通用学术英文'} · 已译 {translated}/{units} 段 · 已采用 {adopted.length}/{chapters.filter(item => item.count).length} 节</span>
        {generating && <span>{snapshot.phase}</span>}
        {snapshot.target && snapshot.scope === 'document' && adopted.length < chapters.filter(item => item.count).length &&
          <span>英文 Word 中有 {chapters.filter(item => item.count && item.state !== 'adopted').length} 节保留中文</span>}
        {generating && <button className="rw-quiet" disabled={pending} onClick={() => void run(() => action('pauseWordTranslation'))}>暂停</button>}
        {canRetry && <button className="rw-secondary" disabled={pending || !snapshot.available} onClick={() => void run(() => action('retryWordTranslation'))}>继续翻译</button>}
      </div>
      <TranslationSchedule key={snapshot.id} schedule={snapshot.schedule}/>
      {stale && <p className="rw-error" role="status">中文稿已更新，可查看旧译文，采用请基于当前版本重新翻译。</p>}
      {snapshot.error && <p className="rw-error" role="alert">{snapshot.error}</p>}
      <div className="rw-translation-chapter">
        <select aria-label="选择翻译章节" value={chapter?.id || ''} disabled={pending || Boolean(editor)} onChange={event => {
          setChapterId(event.target.value); setFault(''); setConfirmAll(false);
        }}>{chapters.map(item => <option key={item.id} value={item.id}>{item.title} · {stateLabels[item.state]}</option>)}</select>
        {chapter?.error && <p className="rw-error" role="alert">{chapter.error}</p>}
      </div>
      <div className="rw-translation-scroll">
        {imageIssues.length > 0 && <details className="rw-translation-images">
          <summary>{imageIssues.length} 张图的文字需核对</summary>
          <ul>{imageIssues.map(image => <li key={image.index}>图 {image.index} · {image.state === 'chinese' ? '检测到中文' : '待人工核对'}{image.description && ' · ' + image.description}</li>)}</ul>
        </details>}
        {chapter?.units.some(unit => unit.source.includes('⟦')) && <small className="rw-translation-hint">‹› 标记原 Word 中的对象或格式边界，编辑译文时请保留对应编号。</small>}
        <div className="rw-translation-columns" aria-hidden="true"><strong>中文原文</strong><strong>英文译文</strong></div>
        {chapter?.units.map((unit, index) => <article key={unit.id} className="rw-translation-row" aria-label={`第 ${index + 1} 段中英对照`}>
          <div><p>{readable(unit.source)}</p>{unit.path && editMode && <button className="rw-quiet" disabled={busy} onClick={() => void run(() => onLocate(unit.path))}>定位原文</button>}</div>
          <div>
            {editor?.id === unit.id ? <>
              <textarea aria-label="编辑英文译文" lang="en" value={editor.text} onChange={event => setEditor({ ...editor, text:event.target.value })}/>
              <div className="rw-translation-actions"><button className="rw-secondary" disabled={blocked} onClick={saveEdit}>保存译文</button><button className="rw-quiet" disabled={pending} onClick={() => setEditor(null)}>取消</button></div>
            </> : <>
              <p lang="en">{unit.english ? readable(unit.english) : '待翻译'}</p>
              {unit.retainedDraft && <small>复核改动未通过校验，已保留通过校验的初译。</small>}
              {chapter.state === 'ready' && unit.english && <button className="rw-quiet" disabled={blocked || Boolean(editor)} onClick={() => setEditor({ id:unit.id, text:unit.english, previous:unit.english })}>编辑译文</button>}
            </>}
          </div>
        </article>)}
      </div>
      <footer className="rw-translation-actions">
        {chapter?.state === 'ready' && <button className="rw-primary" disabled={blocked || Boolean(editor)} onClick={() => adopt(false)}>{snapshot.scope === 'selection' && chapters.length === 1 ? '采用选区译文' : '采用本节'}</button>}
        {ready.length > 1 && !confirmAll && <button className="rw-secondary" disabled={blocked || Boolean(editor)} onClick={() => setConfirmAll(true)}>采用全部已生成章节</button>}
        {confirmAll && <><button className="rw-primary" disabled={blocked || Boolean(editor)} onClick={() => adopt(true)}>确认采用 {ready.length} 节</button><button className="rw-quiet" disabled={pending} onClick={() => setConfirmAll(false)}>取消</button></>}
        {snapshot.target && <button className="rw-secondary" disabled={busy || pending || Boolean(editor)} onClick={() => void run(() => onOpenTarget(snapshot.target.id))}>打开英文 Word</button>}
      </footer>
    </>}
  </section>;
}
