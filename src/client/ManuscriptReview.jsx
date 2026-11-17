import React from 'react';
import { MANUSCRIPT_REVIEW_TEMPLATES } from '../shared/revision-review.mjs';
import { PromptTemplateModule } from './WordRevisionModules.jsx';
import { ReviewDegreeBadge, ReviewRelationGraph, ReviewResolutionBadge } from './ReviewRelationGraph.jsx';
import { REVIEW_DEGREES, reviewDegree } from '../shared/review-relations.mjs';

const stateLabel = { waiting: '已分派', reading: '审阅中', read: '初审完成', exchange: '交流中', standby: '待命', responding: '回复中', revising: '改稿中', failed: '可重试' };
const isActive = value => ['queued', 'running'].includes(value);
const instructionLimit = 3000;

export function ManuscriptReviewPanel({ api, projectId, objectId, revision, busy, origin, onStart, onPublish, onShowComments, onLocate, onPrepare, onOpenComparison, onStartBatch, onOpenBatch }) {
  const [snapshot, setSnapshot] = React.useState(null);
  const [selected, setSelected] = React.useState(origin?.jobId || '');
  const [draft, setDraft] = React.useState('');
  const [templateId, setTemplateId] = React.useState(MANUSCRIPT_REVIEW_TEMPLATES[0].id);
  const [target, setTarget] = React.useState(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState('');
  const [newReview, setNewReview] = React.useState(false);
  const [finding, setFinding] = React.useState(origin?.findingId || '');
  const [graphFocus, setGraphFocus] = React.useState(origin?.findingId || '');
  const [copyNotice, setCopyNotice] = React.useState('');
  const [refresh, setRefresh] = React.useState(0);
  const [checked, setChecked] = React.useState([]);
  const requestKey = React.useRef(null);
  const opened = React.useRef(new Map());
  const graph = React.useRef(null);
  const owner = { projectId, objectId, jobId: snapshot?.id };
  const running = isActive(snapshot?.status);
  const canReply = !newReview && ['ready', 'comments'].includes(snapshot?.stage) && !running;
  const template = MANUSCRIPT_REVIEW_TEMPLATES.find(item => item.id === templateId);
  const appendTemplate = Boolean(draft.trim()) && !MANUSCRIPT_REVIEW_TEMPLATES.some(item => item.prompt === draft);
  const nextDraft = appendTemplate ? draft + '\n\n' + template.prompt : template.prompt;
  const templateApplied = draft.includes(template.prompt);
  const ready = snapshot?.available;
  const workerName = id => id === 0 ? '全文审阅汇总' : snapshot?.workers.find(worker => worker.id === id)?.path.at(-1);
  const batchItems = new Map(snapshot?.batch?.items.map(item => [item.findingId, item]));
  const selectable = !newReview && snapshot?.stage === 'ready' && snapshot.status === 'succeeded' && !snapshot.history.some(item => isActive(item.status));
  const eligible = (snapshot?.findings || []).filter(item => !batchItems.has(item.id) && !item.decision.dismissed && !item.decision.jobId
    && snapshot.workers.some(worker => worker.id === item.workerId && worker.childId)).map(item => item.id);
  const selectedFindings = checked.filter(id => eligible.includes(id));
  const resolvedCount = snapshot?.findings?.filter(item => item.decision.review === 'adopted').length || 0;

  React.useEffect(() => {
    const controller = new AbortController();
    let timer;
    const read = async () => {
      let delay = 1600;
      try {
        const next = await api.reviewStatus(projectId, objectId, selected, controller.signal);
        if (!controller.signal.aborted) {
          setSnapshot(next);
          delay = isActive(next.status) ? 800 : 3500;
        }
      } catch (error) {
        if (!controller.signal.aborted) setError(error.message);
      }
      if (!controller.signal.aborted) timer = setTimeout(read, delay);
    };
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, projectId, objectId, revision, selected, refresh]);

  React.useEffect(() => {
    if (origin?.findingId && snapshot?.id === origin.jobId) {
      opened.current.get(origin.findingId)?.scrollIntoView({ block: 'nearest' });
    }
  }, [origin?.findingId, origin?.jobId, snapshot?.id]);

  const commentRevision = snapshot?.commentRevision;
  React.useEffect(() => {
    if (commentRevision) onShowComments?.(commentRevision);
  }, [commentRevision, onShowComments]);

  const run = async (operation, done) => {
    if (pending) return;
    setPending(true);
    setError('');
    try {
      const result = await operation();
      done?.(result);
    } catch (error) {
      setError(error.message);
    } finally {
      setPending(false);
      setRefresh(value => value + 1);
    }
  };
  const action = (name, data = {}) => api.mutate(name, { ...owner, ...data });
  const jump = id => {
    setFinding(id);
    requestAnimationFrame(() => {
      const card = opened.current.get(id);
      card?.scrollIntoView({ block: 'nearest' });
      card?.querySelector('summary')?.focus({ preventScroll: true });
    });
  };
  const showGraph = id => {
    setGraphFocus(id);
    if (graph.current) {
      graph.current.open = true;
      graph.current.scrollIntoView({ block: 'start' });
      graph.current.querySelector('select')?.focus({ preventScroll: true });
    }
  };
  const askWorker = id => {
    setTarget(id);
    setNewReview(false);
  };
  const submit = event => {
    event.preventDefault();
    if (!ready || pending || busy || running) return;
    if (canReply) {
      if (target !== null && draft.trim()) void run(() => action('followManuscriptReview', { target, message: draft }), () => setDraft(''));
      return;
    }
    requestKey.current ||= crypto.randomUUID();
    void run(() => onStart(draft.trim() ? draft : template.prompt, requestKey.current), result => {
      requestKey.current = null;
      setSelected(result.jobId);
      setNewReview(false);
      setDraft('');
    });
  };

  return <section className="rw-manuscript-review" aria-label="论文审阅对话">
    <div className="rw-manuscript-review-scroll">
      {snapshot?.history.length > 0 && <div className="rw-review-actions">
        <label>审阅记录
          <select aria-label="审阅记录" value={selected || snapshot.id} disabled={pending} onChange={event => {
            setSelected(event.target.value);
            setSnapshot(null);
            setError('');
            setTarget(null);
            setNewReview(false);
            setChecked([]);
            requestKey.current = null;
          }}>
            {snapshot.history.map((item, index) => <option key={item.id} value={item.id}>
              {index === 0 ? '最近一轮' : new Date(item.created_at).toLocaleString('zh-CN')} · 版本 {item.revision}
            </option>)}
          </select>
        </label>
        {!newReview && !snapshot.history.some(item => isActive(item.status)) && <button className="rw-secondary" onClick={() => {
          setTarget(null);
          setDraft('');
          setNewReview(true);
        }}>新一轮审阅</button>}
      </div>}
      {!snapshot && !error && <p role="status">正在读取审阅记录…</p>}
      {snapshot && !ready && <p role="status">DSH 子智能体服务暂未就绪。</p>}
      {error && <p className="rw-sentence-warning" role="alert">{error}</p>}
      {!!snapshot?.id && <>
        <p className="rw-review-bubble" data-role="user">{snapshot.instruction}</p>
        <p role="status"><strong>{snapshot.phase}</strong>{snapshot.commentRevision && <> · 已写入工作区版本 {snapshot.commentRevision}</>}</p>
        {snapshot.error && <p className="rw-sentence-warning">{snapshot.error}</p>}
        {snapshot.documentChanged && <p className="rw-native-sentence-notice">这轮意见来自 Word 版本 {snapshot.revision}。写入批注前会核对审阅内容，定位时会检查当前段落。</p>}
        <details className="rw-review-dispatch" open={running || undefined}>
          <summary>子智能体调度 · {snapshot.workers.filter(worker => worker.status === 'standby').length}/{snapshot.workers.length} 待命</summary>
          <ul>{snapshot.workers.map(worker => <li key={worker.id}>
            <div><strong>{worker.path.join(' › ')}</strong><small>{stateLabel[worker.status]}</small></div>
            {worker.summary && <p>{worker.summary}</p>}
            {worker.error && <p>{worker.error}</p>}
            {worker.childId && <small className="rw-review-worker-id" title={worker.childId}>会话 {worker.childId}</small>}
            {canReply && worker.childId && <button className="rw-quiet" onClick={() => askWorker(worker.id)}>向此小节追问</button>}
          </li>)}
          {(snapshot.stage === 'summary' || snapshot.coordinator) && <li><div><strong>全文汇总</strong><small>{snapshot.stage === 'summary' ? running ? '汇总中' : '可继续' : snapshot.replyTarget === 0 ? '回复中' : '待命'}</small></div></li>}</ul>
        </details>
        {running && <button className="rw-secondary" disabled={pending} onClick={() => void run(() => action('pauseManuscriptReview'))}>暂停审阅</button>}
        {['failed', 'interrupted'].includes(snapshot.status) && <button className="rw-secondary" disabled={pending || !ready} onClick={() => void run(() => action('resumeManuscriptReview'))}>{snapshot.stage === 'batch' ? '继续生成修改稿' : '继续审阅'}</button>}
        {snapshot.status === 'draft' && snapshot.stage === 'comments' && <div className="rw-review-actions">
          <button className="rw-primary" disabled={pending || busy || !ready}
            onClick={() => void run(() => onPublish(owner))}>{snapshot.findings.length ? '写入 ' + snapshot.findings.length + ' 条 Word 批注' : '汇总全文意见'}</button>
        </div>}
        {commentRevision && onShowComments && <button type="button" className="rw-secondary" disabled={busy}
          onClick={() => onShowComments(commentRevision, true)}>显示 Word 批注</button>}
        {snapshot.findings?.length > 0 && <ReviewRelationGraph graphRef={graph} findings={snapshot.findings} plan={snapshot.plan}
          relations={snapshot.relations} focusId={graphFocus} onFocus={setGraphFocus} onJump={jump} sectionName={workerName}/>}
        {snapshot.stage==='ready'&&snapshot.findings?.some(item=>!item.kind) && <button type="button" className="rw-secondary"
          disabled={pending||busy||!ready} onClick={()=>void run(()=>action('arrangeReviewRelations'))}>整理修改程度与关联</button>}
        {snapshot.summary && <div className="rw-review-bubble">
          <strong>全文审阅意见</strong><p>{snapshot.summary}</p>
          {snapshot.plan?.length > 0 && <ol>{snapshot.plan.map(({ step, findings }, index) => <li key={index}>{step}
            {findings.map(id => <button key={id} className="rw-quiet" onClick={() => jump(id)}>批注 {id}</button>)}
          </li>)}</ol>}
          {snapshot.summaryPrompt && <details className="rw-review-finding"><summary>全文修改提示词</summary>
            <p>{snapshot.summaryPrompt}</p>
            <button className="rw-secondary" onClick={() => void run(() => navigator.clipboard.writeText(snapshot.summaryPrompt), () => setCopyNotice('summary'))}>
              {copyNotice === 'summary' ? '已复制提示词' : '复制全文提示词'}</button>
          </details>}
        </div>}
        {snapshot.findings?.length > 0 && <><div className="rw-review-findings-header"><h3>审阅批注</h3>
          <span className="rw-review-resolution-count" role="status">已解决 {resolvedCount}/{snapshot.findings.length} 条</span></div>
          {(selectable && eligible.length > 0 || batchItems.size > 0) && <section className="rw-review-batch-actions" aria-label="审阅批量改稿">
            <div><strong>批量改稿</strong><small>{selectedFindings.length ? `已选 ${selectedFindings.length} 条` : batchItems.size ? `${batchItems.size} 条已加入批量对照` : '勾选需要改稿的审阅建议'}</small></div>
            <div className="rw-review-actions">
              {selectable && eligible.length > 0 && <><button className="rw-secondary" disabled={pending} onClick={() => setChecked(selectedFindings.length === eligible.length ? [] : eligible)}>{selectedFindings.length === eligible.length ? '取消全选' : '全选待处理'}</button>
                <button className="rw-primary" disabled={pending || busy || !ready || !selectedFindings.length} onClick={() => void run(() => onStartBatch({ ...owner, findingIds: selectedFindings }), () => { setChecked([]); onOpenBatch(owner.jobId); })}>批量生成修改稿</button></>}
              {batchItems.size > 0 && <button className="rw-secondary" onClick={() => onOpenBatch(owner.jobId)}>查看批量对照</button>}
            </div>
          </section>}
          <div className="rw-change-legend" aria-label="建议修改程度图例">
          {Object.entries(REVIEW_DEGREES).map(([kind,label]) => <span key={kind} data-kind={kind}>{label}</span>)}
        </div></>}
        {snapshot.findings?.map(item => <div key={item.id} className="rw-review-finding-row">
          {selectable && eligible.includes(item.id) && <input type="checkbox" aria-label={`选择批注 ${item.id}`} title={`选择批注 ${item.id}`} disabled={pending || busy} checked={checked.includes(item.id)} onChange={event => {
            const selected = event.target.checked;
            setChecked(previous => selected ? [...previous, item.id] : previous.filter(id => id !== item.id));
          }}/>}<details ref={element => {
          if (element) opened.current.set(item.id, element); else opened.current.delete(item.id);
        }} className="rw-review-finding rw-review-graded" data-finding-id={item.id} data-kind={reviewDegree(item).kind || undefined} open={finding === item.id || undefined} onToggle={event => {
          if (event.currentTarget.open) setFinding(item.id);
          else setFinding(value => value === item.id ? '' : value);
        }}>
          <summary><span className="rw-review-finding-heading"><strong>{item.path.join(' › ')} · {item.id}</strong>
            <span className="rw-review-badges"><ReviewDegreeBadge item={item}/><ReviewResolutionBadge state={item.decision.review === 'adopted' ? 'adopted' : item.decision.dismissed ? 'dismissed' : item.decision.review}/></span></span>
            <span>{item.issue}</span></summary>
          <blockquote>{item.quote}</blockquote>
          <dl><dt>为何修改</dt><dd>{item.reason&&item.reason!==item.issue ? <>{item.issue}<br/>{item.reason}</> : item.issue}</dd>
            <dt>修改建议</dt><dd>{item.suggestion}</dd><dt>修改路径</dt><dd>{item.steps}</dd><dt>修改提示词</dt><dd>{item.prompt}</dd></dl>
          <div className="rw-review-actions">
            <button type="button" className="rw-secondary" onClick={() => showGraph(item.id)}>查看关联图</button>
            <button disabled={pending || busy} className="rw-secondary" onClick={() => void run(() => onLocate({ ...owner, findingId: item.id }))}>定位到 Word</button>
            <button className="rw-secondary" disabled={pending} onClick={() => void run(() => navigator.clipboard.writeText(item.prompt), () => setCopyNotice(item.id))}>
              {copyNotice === item.id ? '已复制提示词' : '复制提示词'}</button>
            {batchItems.has(item.id) && <button className="rw-primary" onClick={() => onOpenBatch(owner.jobId, item.id)}>打开这条批量对照</button>}
            {!batchItems.has(item.id) && !item.decision.dismissed && <button className="rw-primary" disabled={pending || busy || running}
              onClick={() => void run(() => item.decision.review ? onOpenComparison(item.decision.jobId) : onPrepare({ ...owner, findingId: item.id, scope: item.scope }))}>
              {item.decision.review ? '查看对照' : item.scope === 'chapter' ? '准备小节修改' : '准备段落修改'}</button>}
            {!batchItems.has(item.id) && !item.decision.dismissed && item.scope === 'chapter' && !item.decision.review && <button className="rw-secondary" disabled={pending || busy || running}
              onClick={() => void run(() => onPrepare({ ...owner, findingId: item.id, scope: 'paragraph' }))}>仅准备段落修改</button>}
            {!batchItems.has(item.id) && !['adopted', 'undone'].includes(item.decision.review) && <button disabled={pending} className="rw-quiet"
              onClick={() => void run(() => action('decideManuscriptReview', { findingId: item.id, dismissed: !item.decision.dismissed }))}>{item.decision.dismissed ? '恢复待处理' : '暂不修改'}</button>}
            {canReply && <button className="rw-quiet" onClick={() => { askWorker(item.workerId); setDraft('请解释批注 ' + item.id + ' 的依据及优先修改步骤。'); }}>追问这条批注</button>}
          </div>
        </details></div>)}
        {snapshot.messages.map((message, index) => <div className="rw-review-bubble" data-role={message.role} key={index}>
          <strong>{message.role === 'user' ? '你 → ' + workerName(message.target) : workerName(message.target)}</strong><p>{message.text}</p>
        </div>)}
      </>}
    </div>
    {snapshot && (!snapshot.id || newReview || canReply) && <form className="rw-review-composer" onSubmit={submit}>
      {!canReply && <PromptTemplateModule title="审阅重点" icon="read" value={templateId} onChange={setTemplateId}
        onFill={() => setDraft(nextDraft)} disabled={pending || running || busy}
        fillDisabled={templateApplied || nextDraft.length > instructionLimit}
        fillLabel={templateApplied ? '已填入' : appendTemplate ? '追加模板' : '填入模板'}
        fillTitle={nextDraft.length > instructionLimit ? '审阅要求上限为 3000 字符，请精简后追加。' : undefined}
        prompt={template.prompt} templates={MANUSCRIPT_REVIEW_TEMPLATES} pickerLabel="审阅重点模板"/>}
      {canReply && <label>追问对象
        <select value={target ?? ''} onChange={event => setTarget(event.target.value === '' ? null : Number(event.target.value))}>
          <option value="" disabled>选择待命子智能体</option>
          {snapshot.coordinator && <option value={0}>全文审阅汇总</option>}
          {snapshot.workers.filter(worker => worker.childId).map(worker => <option key={worker.id} value={worker.id}>{worker.path.join(' › ')}</option>)}
        </select>
      </label>}
      <textarea aria-label={canReply ? '审阅追问' : '审阅要求'} maxLength={instructionLimit} value={draft} onChange={event => setDraft(event.target.value)}
        placeholder={canReply ? '询问审阅依据、修改顺序或提示词' : '可指定审阅重点，如方法和结果是否衔接'} />
      <div className="rw-review-actions">
        <button type="submit" className="rw-primary" disabled={!ready || pending || busy || running || (canReply && (target === null || !draft.trim()))}>{canReply ? '发送追问' : '开始全文审阅'}</button>
        {newReview && <button type="button" className="rw-secondary" onClick={() => { setNewReview(false); setDraft(''); }}>取消</button>}
      </div>
    </form>}
  </section>;
}
