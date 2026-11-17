import React from 'react';
import { reviewConnections, reviewDegree, REVIEW_DEGREES } from '../shared/review-relations.mjs';
import { Icon } from './icons.jsx';

const reviewStatusLabels = { adopted: '已解决', undone: '待处理', pending: '待采用', dismissed: '暂不修改' };

export function ReviewResolutionBadge({ state }) {
  const label = reviewStatusLabels[state];
  if (!label) return null;
  return <span className="rw-review-resolution" data-state={state}>{state === 'adopted' && <Icon name="check" size={11}/>} {label}</span>;
}

export function ReviewDegreeBadge({ item }) {
  const { kind, estimated } = reviewDegree(item);
  return <span className="rw-review-degree" data-kind={kind || undefined}
    title={estimated && kind ? '按这条审阅建议的修改范围初判。生成改稿后可在对照中核对。' : undefined}>
    {kind ? REVIEW_DEGREES[kind] : '程度待核对'}{estimated && kind && <small>初判</small>}
  </span>;
}

function GraphNode({ item, onJump }) {
  return <button type="button" className="rw-review-graph-node" data-kind={reviewDegree(item).kind || undefined}
    title={item.issue} onClick={() => onJump(item.id)}>
    <strong>{item.id}</strong><span>{item.path.at(-1)}</span>
    {item.decision?.review === 'adopted' && <ReviewResolutionBadge state="adopted"/>}
  </button>;
}

function RelationBranch({ title, items, direction, onJump }) {
  if (!items.length) return null;
  return <div className="rw-review-graph-branch" data-direction={direction}>
    <h4>{title}</h4>
    <ul>{items.map(({ node, reason }) => <li key={node.id}>
      <GraphNode item={node} onJump={onJump}/><p>{reason}</p>
    </li>)}</ul>
  </div>;
}

export function ReviewRelationGraph({ graphRef, findings, plan, relations, focusId, onFocus, onJump, sectionName }) {
  const focus = findings.find(item => item.id === focusId) || findings[0];
  if (!focus) return null;
  const { before, after, together, groups } = reviewConnections(focus.id, findings, plan, relations);
  const sections = (focus.links || []).map(id => ({ id, title: sectionName(id), items: findings.filter(item => item.workerId === id) }))
    .filter(section => section.title);
  return <details ref={graphRef} className="rw-review-relations">
    <summary><strong>建议关联图</strong><span>{findings.length} 条建议</span></summary>
    <label className="rw-review-graph-picker">聚焦建议
      <select aria-label="聚焦审阅建议" value={focus.id} onChange={event => onFocus(event.target.value)}>
        {findings.map(item => <option key={item.id} value={item.id}>{item.id} · {item.path.at(-1)} · {item.issue.slice(0, 26)}</option>)}
      </select>
    </label>
    <div className="rw-review-graph" aria-label="建议关系">
      <RelationBranch title="前置建议" direction="before" items={before} onJump={onJump}/>
      <div className="rw-review-graph-focus" data-kind={reviewDegree(focus).kind || undefined}>
        <div><strong>{focus.id} · {focus.path.at(-1)}</strong><span className="rw-review-badges"><ReviewDegreeBadge item={focus}/>
          {focus.decision?.review === 'adopted' && <ReviewResolutionBadge state="adopted"/>}</span></div>
        <p>{focus.issue}</p>
        <button type="button" className="rw-quiet" onClick={() => onJump(focus.id)}>查看这条建议</button>
      </div>
      <RelationBranch title="后续建议" direction="after" items={after} onJump={onJump}/>
      <RelationBranch title="同步核对" direction="together" items={together} onJump={onJump}/>
      {groups.length > 0 && <div className="rw-review-graph-branch" data-direction="together">
        <h4>共用修改步骤</h4>
        <ul>{groups.map(({ step, nodes }, index) => <li key={index}>
          <p>{step}</p><div className="rw-review-graph-nodes">
            {nodes.map(node => <GraphNode key={node.id} item={node} onJump={onJump}/>)}
          </div>
        </li>)}</ul>
      </div>}
      {sections.length > 0 && <details className="rw-review-cross-sections">
        <summary>关联小节 · {sections.length}</summary>
        <ul>{sections.map(section => <li key={section.id}>
          <strong>{section.title}</strong><div className="rw-review-graph-nodes">
            {section.items.map(node => <GraphNode key={node.id} item={node} onJump={onJump}/>)}
          </div>
        </li>)}</ul>
      </details>}
      {!before.length && !after.length && !together.length && !groups.length && !sections.length && <p>这条建议暂无已记录的关联。</p>}
    </div>
  </details>;
}
