import React from 'react';
import { CHANGE_LABELS, compareSentences, PROMPT_TEMPLATES } from '../shared/revision-review.mjs';
import {wordDifferences} from './word-diff.mjs';

export function PromptPicker({value,onChange,disabled}){
  return <label className="rw-prompt-picker">修改模板<select aria-label="修改提示词模板" disabled={disabled} value={value} onChange={event=>onChange(event.target.value)}>{PROMPT_TEMPLATES.map(item=><option key={item.id} value={item.id}>{item.title}</option>)}</select></label>;
}
export function SentenceComparison({before,after,changes,onClassify,busy,compact=false}){
  const [error,setError]=React.useState(''),[saving,setSaving]=React.useState(false),[showUnchanged,setShowUnchanged]=React.useState(!compact);
  const classify=async data=>{setSaving(true);setError('');try{await onClassify(data)}catch(e){setError(e.message)}finally{setSaving(false)}};
  const rows=React.useMemo(()=>compareSentences(before,after,changes).map(row=>({...row,words:wordDifferences(row.before,row.after)})),[before,after,changes]);
  const highlight=parts=>parts.map((part,index)=>part.changed?<mark className="rw-word-change" key={index}>{part.text}</mark>:part.text);
  return <div className="rw-colored-comparison"><div className="rw-change-legend" aria-label="修改程度图例">{Object.entries(CHANGE_LABELS).map(([kind,label])=><span key={kind} data-kind={kind}>{label}</span>)}</div>
    <p className="rw-review-help">自动分类供复核，可手动更正。</p>{error&&<p role="alert">{error}</p>}
    {compact&&<label className="rw-change-filter"><input type="checkbox" checked={showUnchanged} onChange={event=>setShowUnchanged(event.target.checked)}/>显示未修改句子（{rows.filter(row=>row.kind==='unchanged').length}）</label>}<div className="rw-change-head"><b>修改前</b><b>修改后</b></div>
    {rows.map((row,index)=>(showUnchanged||row.kind!=='unchanged')&&<div className="rw-change-row" key={index} data-kind={row.kind}>
      <div className="rw-change-meta"><span>{CHANGE_LABELS[row.kind]} · {row.source==='exact'?'文字一致':row.source==='author'?'作者确认':row.source==='model'?'模型判断':'初判待核对'}</span>{onClassify&&row.before!==row.after&&<select aria-label={`第 ${index+1} 句修改分类`} value={row.kind} disabled={busy||saving} onChange={event=>void classify({index,before:row.before,after:row.after,kind:event.target.value})}>{Object.entries(CHANGE_LABELS).filter(([kind])=>kind!=='unchanged').map(([kind,label])=><option key={kind} value={kind}>{label}</option>)}</select>}</div>
      <div className="rw-change-pair"><p aria-label="修改前">{row.before?highlight(row.words.before):<em>新增</em>}</p><p aria-label="修改后">{row.after?highlight(row.words.after):<em>删除</em>}</p></div>
      <small>{row.reason}</small>
    </div>)}
  </div>;
}
export function DocumentHistory({api,project,object,onRestore}){
  const [data,setData]=React.useState(null),[detail,setDetail]=React.useState(null),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false),[confirm,setConfirm]=React.useState(false);
  const request=React.useRef(0),owner=React.useRef(0);
  React.useEffect(()=>{let cancelled=false;owner.current++;setData(null);setDetail(null);setError('');setConfirm(false);
    api.mutate('documentHistory',{projectId:project.id,objectId:object.id}).then(next=>{if(!cancelled)setData(next.actionResult)}).catch(e=>{if(!cancelled)setError(e.message)});return()=>{cancelled=true;owner.current++;request.current++};
  },[api,project.id,object.id,object.revision]);
  const select=async commit=>{const seq=++request.current;setConfirm(false);setDetail(null);setError('');try{const next=await api.mutate('documentHistoryDetail',{projectId:project.id,objectId:object.id,commit});if(seq===request.current)setDetail(next.actionResult)}catch(e){if(seq===request.current)setError(e.message)}};
  const loadMore=async()=>{const current=owner.current;setBusy(true);try{const next=await api.mutate('documentHistory',{projectId:project.id,objectId:object.id,offset:data.entries.length});if(current===owner.current)setData(value=>({...next.actionResult,entries:[...value.entries,...next.actionResult.entries]}))}catch(e){if(current===owner.current)setError(e.message)}finally{setBusy(false)}};
  return <section className="rw-git-history" aria-label="文档 Git 历史"><header><strong>文档 Git 历史</strong><small>保存、采用、撤回均归档；恢复会新增版本。</small></header>
    {error&&<p role="alert" className="rw-sentence-warning">{error}</p>}{!data&&!error&&<p role="status">正在读取本地历史…</p>}
    {data&&<><details className="rw-history-location"><summary>本地存储位置</summary><code>{data.path}</code><p>从启用时开始记录；此前未存档的修改无法还原。</p></details><ol className="rw-git-tree">{data.entries.map(entry=><li key={entry.commit} data-selected={detail?.commit===entry.commit}><button onClick={()=>void select(entry.commit)} disabled={busy}><strong>{entry.action}</strong><small>{entry.commit.slice(0,8)} · r{entry.revision}{entry.commit===data.head?' · 当前':''}</small><time>{new Date(entry.at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}</time>{entry.restoredFrom&&<small>↶ 恢复自 {entry.restoredFrom.slice(0,8)}</small>}</button></li>)}</ol>{data.hasMore&&<button disabled={busy} onClick={()=>void loadMore()}>加载更早的版本</button>}</>}
    {detail&&<article className="rw-git-detail"><h4>{detail.action}</h4>{!detail.parents.length&&<p>初始快照</p>}{detail.parents.length>0&&detail.before===detail.text&&<p>正文文字未变化。文档字节的变化可能涉及格式、图表或元数据；完整文件已归档。</p>}<SentenceComparison compact before={detail.before} after={detail.text}/>{detail.commit!==data?.head&&onRestore&&<div className="rw-history-restore">{confirm?<><p>将此版本恢复到工作副本，并归档当前内容。后续历史仍保留。</p><button className="rw-primary" disabled={busy} onClick={async()=>{setBusy(true);try{await onRestore(detail.commit);setConfirm(false)}catch(e){setError(e.message)}finally{setBusy(false)}}}>确认恢复此版本</button><button disabled={busy} onClick={()=>setConfirm(false)}>取消</button></>:<button className="rw-secondary" disabled={busy} onClick={()=>setConfirm(true)}>恢复为新版本</button>}</div>}</article>}
  </section>;
}
export function RelatedReminders({api,project,object,onLocate,onCount}){
  const [items,setItems]=React.useState([]),[error,setError]=React.useState(''),[loading,setLoading]=React.useState(true);
  React.useEffect(()=>{let cancelled=false;setLoading(true);setError('');api.mutate('reviewReminders',{projectId:project.id,objectId:object.id}).then(next=>{if(!cancelled){setItems(next.actionResult.reminders);onCount?.(next.actionResult.reminders.filter(item=>!item.checked).length)}}).catch(e=>{if(!cancelled)setError(e.message)}).finally(()=>{if(!cancelled)setLoading(false)});return()=>{cancelled=true}},[api,project.id,object.id,object.revision]);
  const check=async(item,checked)=>{try{await api.mutate('checkReminder',{projectId:project.id,objectId:object.id,id:item.id,checked});setItems(values=>{const next=values.map(value=>value.id===item.id?{...value,checked}:value);onCount?.(next.filter(value=>!value.checked).length);return next})}catch(e){setError(e.message)}};
  return <section className="rw-related-reminders" aria-label="修改关联提醒"><header><strong>关联提醒 · {items.filter(item=>!item.checked).length} 待核对</strong><p>按已保存修改匹配正文中的术语、数值和引用，以下是候选关联，不自动改动其他段落。</p></header>{loading&&<p role="status">正在检查当前正文…</p>}{error&&<p role="alert">{error}</p>}{!loading&&!error&&!items.length&&<p>暂无命中的关联段落。保存或采用修改后会重新检查。</p>}{items.map(item=><article key={item.id} data-checked={item.checked}><strong>{item.heading} · 第 {item.paragraph} 段</strong><p className="rw-reminder-terms">匹配：{item.matched.join('、')}</p><blockquote>{item.text}</blockquote><details><summary>触发此次提醒的修改</summary><p>原句：{item.original}</p><p>改句：{item.replacement}</p></details><div>{onLocate&&<button className="rw-secondary" onClick={()=>onLocate(item.text)}>在正文查找</button>}<label><input type="checkbox" checked={item.checked} onChange={event=>void check(item,event.target.checked)}/>已核对</label></div></article>)}</section>;
}
