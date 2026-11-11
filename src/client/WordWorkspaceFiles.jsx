import React from 'react';
import {Icon} from './icons.jsx';

/** Project metadata only; no document bodies are loaded to display this list. */
export function WordWorkspaceFiles({project,object,busy,error,onSelect,onClose,onBrowse,onAdvanced}){
  const [query,setQuery]=React.useState('');
  const documents=project.objects?.filter(item=>item.kind==='manuscript'&&item.encoding==='binary'&&/\.docx$/i.test(item.metadata?.workspaceFile||item.title))||[];
  const matches=documents.filter(item=>`${item.title} ${item.metadata?.workspaceFile||''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <section className="rw-word-files" aria-label="工作区 Word 文件" onKeyDown={event=>{if(event.key==='Escape'&&!busy){event.preventDefault();event.stopPropagation();onClose()}}}>
    <header><Icon name="folder" size={18}/><strong>打开文稿</strong><button className="rw-icon-button" disabled={busy} aria-label="返回 Word 正文" title="返回正文" onClick={onClose}><Icon name="close" size={16}/></button></header>
    <p>从当前项目选择文稿，切换前保存未保存的修改。</p>
    <input autoFocus type="search" aria-label="查找工作区 Word 文件" placeholder="查找文稿名称" value={query} disabled={busy} onChange={event=>setQuery(event.target.value)}/>
    {error&&<p className="rw-sentence-warning" role="alert">{error}</p>}
    {busy&&<p role="status">正在保存并打开文稿…</p>}
    <div className="rw-word-files-list">{matches.slice(0,100).map(item=><button key={item.id} disabled={busy} aria-current={item.id===object.id?'page':undefined} title={item.metadata?.workspaceFile||item.title} onClick={()=>onSelect(item)}><Icon name="file" size={17}/><span><strong>{item.title}</strong><small>{item.metadata?.workspaceFile||'paper'} · {item.metadata?.wordEditable?'工作区版本':'原稿'}</small></span>{item.id===object.id&&<small>当前</small>}</button>)}{!matches.length&&<p>没有匹配的 Word 文稿。</p>}{matches.length>100&&<p>匹配文稿较多，请输入名称缩小范围。</p>}</div>
    <footer>{onBrowse&&<button className="rw-secondary" disabled={busy} onClick={onBrowse}>工作区文件</button>}<button className="rw-quiet" disabled={busy} onClick={onAdvanced}>Word 文件功能</button><span title={project.rootPath}>{project.title}</span></footer>
  </section>;
}
