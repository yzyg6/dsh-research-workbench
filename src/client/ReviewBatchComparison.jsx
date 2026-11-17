import React from 'react';
import { ReviewDegreeBadge } from './ReviewRelationGraph.jsx';
import { RevisionPanel } from './SentenceEditor.jsx';

const labels = { queued: '等待生成', running: '生成中', ready: '待审核', adopted: '已采用', skipped: '已跳过', failed: '待重试', undone: '待处理（已撤回）' };
const failureLabels = { CITATION_CHANGED: '引用校验未通过', INVALID_PROPOSAL: '改稿内容校验未通过', UNSUPPORTED_EVIDENCE: '证据校验未通过', REVIEW_AGENT_INCOMPLETE: '子智能体回复中断', REVIEW_AGENT_ERROR: '子智能体连接或执行失败' };
const entryLabel = item => item.state === 'failed' ? failureLabels[item.errorCode] || labels.failed : labels[item.state];
const active = status => status === 'queued' || status === 'running';
const reviewedState = status => status === 'adopted' || status === 'skipped';

export function ReviewBatchComparison({ api, owner, currentRevision, busy, onSelect, onBack, onStart, onApply }) {
  const { projectId, objectId, jobId, findingId } = owner;
  const [snapshot, setSnapshot] = React.useState(null);
  const [draft, setDraft] = React.useState(null);
  const [pending, setPending] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [fault, setFault] = React.useState(null);
  const [refresh, setRefresh] = React.useState(0);
  const entries = snapshot?.batch?.items || [];
  const current = entries.find(item => item.findingId === findingId) || entries.find(item => !reviewedState(item.state)) || entries[0];
  const currentIndex = entries.indexOf(current);
  const nextPending = current && [...entries.slice(currentIndex + 1), ...entries.slice(0, currentIndex)].find(item => item.state === 'ready');
  const reviewed = entries.filter(item => reviewedState(item.state)).length;
  const failed = entries.filter(item => item.state === 'failed');
  const predecessors = (snapshot?.relations || []).filter(edge => edge.kind === 'before' && edge.to === current?.findingId);
  const isRunning = active(snapshot?.status);
  const reload = () => setRefresh(value => value + 1);
  const job = draft?.id === current?.jobId ? draft : null;
  const freshJob = !job || job.updatedAt === current?.updatedAt;

  React.useEffect(() => {
    const controller = new AbortController();
    let timer;
    const read = async () => {
      let interval = 3000;
      try {
        const next = await api.reviewBatchStatus({ projectId, objectId, jobId }, controller.signal);
        if (!controller.signal.aborted) {
          setSnapshot(next);
          setFault(previous => previous?.code === 'READ_BATCH' ? null : previous);
        }
        if (active(next.status)) interval = 850;
      } catch (error) {
        if (!controller.signal.aborted) setFault({ code: 'READ_BATCH', message: error.message });
      }
      if (!controller.signal.aborted) timer = setTimeout(read, interval);
    };
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, projectId, objectId, jobId, refresh]);

  React.useEffect(() => {
    if (!current?.jobId) { setDraft(null); return; }
    const controller = new AbortController();
    void api.reviewBatchProposal({ projectId, objectId, jobId, findingId: current.findingId }, controller.signal).then(result => {
      if (!controller.signal.aborted) setDraft(result);
    }).catch(error => { if (!controller.signal.aborted) setFault(error); });
    return () => controller.abort();
  }, [api, projectId, objectId, jobId, current?.findingId, current?.jobId, current?.updatedAt, refresh]);

  const choose = item => { if (item) { setFault(null); onSelect(item.findingId); } };
  const updateDraft = next => {
    if(!next?.id)return;
    setDraft(next);
    const state=next.output?.review;
    setSnapshot(previous=>previous?.batch?{...previous,batch:{...previous.batch,items:previous.batch.items.map(item=>item.jobId===next.id?
      {...item,updatedAt:next.updatedAt,state:state==='pending'?'ready':state}:item)}}:previous);
  };
  const edit = async (id, data) => {
    if(current?.jobId!==id)throw Error('当前对照已切换，请重新选择建议。');
    const next=await api.mutate('editSentenceSuggestion',{projectId,jobId:id,...data});
    updateDraft(next.actionResult?.job);
  };
  const run = async operation => {
    if (pending) return;
    if (current) onSelect(current.findingId);
    setPending(true);
    setFault(null);
    try { const next=await operation();updateDraft(next?.actionResult?.job); }
    catch (error) { setFault(error); }
    finally { setPending(false); reload(); }
  };
  const selection = { projectId, objectId, jobId, findingId: current?.findingId };
  const retry = scope => run(() => onStart({ ...selection, findingIds: [current.findingId], retry: true, scope }));
  const retryFailed = () => run(() => onStart({ projectId, objectId, jobId, findingIds: failed.map(item => item.findingId), retry: true }));
  const skip = () => run(() => api.mutate('skipReviewBatchItem', selection));
  const workBusy = busy || pending;
  const navigationBusy = workBusy || editing;
  const interrupted = snapshot?.stage === 'batch' && ['failed', 'interrupted'].includes(snapshot.status);
  const canRetryFailed = snapshot?.stage === 'ready' || isRunning && snapshot?.stage === 'batch';
  const retryable = canRetryFailed && (current?.state === 'failed' || snapshot.stage === 'ready' && ['ready', 'undone'].includes(current?.state));
  const conflict = fault?.code === 'REVIEW_BATCH_CONFLICT';

  return <section className="rw-review-batch-comparison" aria-label="批量修改逐条对照">
    <div className="rw-review-batch-nav">
      <div className="rw-review-actions"><strong>批量修改对照</strong><button type="button" className="rw-quiet" disabled={navigationBusy} onClick={() => onBack(current?.findingId)}>返回审阅</button></div>
      {entries.length > 0 && <>
        <div className="rw-review-batch-progress" role="status">已审核 {reviewed}/{entries.length} 条{isRunning ? ' · 子智能体生成中' : ''}{failed.length > 0 && ` · ${failed.length} 条可重试`}</div>
        <div className="rw-review-batch-pager">
          <button className="rw-secondary" disabled={navigationBusy || currentIndex < 1} onClick={() => choose(entries[currentIndex - 1])}>上一条</button>
          <select aria-label="选择要审核的修改" value={current?.findingId || ''} disabled={navigationBusy} onChange={event => choose(entries.find(item => item.findingId === event.target.value))}>
            {entries.map((item, index) => <option key={item.findingId} value={item.findingId}>{index + 1}. {item.path.at(-1)} · {item.findingId} · {entryLabel(item)}</option>)}
          </select>
          <button className="rw-secondary" disabled={navigationBusy || currentIndex >= entries.length - 1} onClick={() => choose(entries[currentIndex + 1])}>下一条</button>
        </div>
        {current && <div className="rw-review-batch-target">
          <div><strong>{current.path.join(' › ')} · {current.findingId}</strong><ReviewDegreeBadge item={current}/></div>
          <p>{current.issue}</p>
          <p>{current.suggestion}</p>
          {predecessors.length > 0 && <details><summary>建议先核对 {predecessors.length} 条关联修改</summary><ul>{predecessors.map(edge => {
            const previous = entries.find(item => item.findingId === edge.from);
            return <li key={edge.from}>{previous ? <button className="rw-quiet" disabled={navigationBusy} onClick={() => choose(previous)}>{edge.from} · {labels[previous.state]}</button> : edge.from} {edge.reason}</li>;
          })}</ul></details>}
        </div>}
      </>}
      {interrupted && <button className="rw-secondary" disabled={workBusy} onClick={() => void run(() => api.mutate('resumeManuscriptReview', { projectId, objectId, jobId }))}>继续生成修改稿</button>}
      {(fault || current?.error || snapshot?.error) && <p className="rw-sentence-warning" role="alert">{fault?.message || current?.error || snapshot?.error}</p>}
      <div className="rw-review-actions">
        {nextPending && <button className="rw-secondary" disabled={navigationBusy} onClick={() => choose(nextPending)}>下一条待审核</button>}
        {canRetryFailed && failed.length > 1 && <button className="rw-secondary" disabled={workBusy} onClick={() => void retryFailed()}>重试 {failed.length} 条失败项</button>}
        {retryable && (current.state !== 'ready' || conflict) && <button className="rw-secondary" disabled={workBusy} onClick={() => void retry()}>重新生成这条</button>}
        {retryable && current.scope === 'chapter' && (current.state === 'failed' || conflict) && <button className="rw-secondary" disabled={workBusy} onClick={() => void retry('paragraph')}>按段落生成</button>}
        {!job && current?.state === 'failed' && <button className="rw-quiet" disabled={workBusy} onClick={() => void skip()}>跳过，保留原文</button>}
        {fault && !conflict && !current?.error && <button className="rw-quiet" disabled={workBusy} onClick={() => { setFault(null); reload(); }}>刷新对照</button>}
      </div>
    </div>
    {job ? <div className="rw-native-sentence-review"><RevisionPanel key={job.id} job={job} embedded workingCopy batchReview
      currentRevision={currentRevision} busy={workBusy||!freshJob} modelReady onClose={() => void skip()} onEditSuggestion={edit} onEditingChange={setEditing}
      onAction={(action, id) => void run(() => onApply(action, id, job.updatedAt))}/></div>
      : <p className="rw-review-batch-empty" role="status">{current ? current.state === 'ready' ? '正在读取这条修改稿…' : entryLabel(current) : snapshot ? '这一轮尚无批量修改稿。' : '正在读取批量修改队列…'}</p>}
  </section>;
}
