import React from 'react';
import { Icon } from './icons.jsx';

export function WorkspaceBrowser({ api, project, onSelect, onRefresh, onReveal }) {
  const canonical=path=>(path||'').replace(/\\/g,'/').toLowerCase();
  const wordRoles=new Map((project.objects||[]).filter(item=>/\.docx$/i.test(item.metadata?.workspaceFile||'')).map(item=>[canonical(item.metadata.workspaceFile),item.metadata.wordEditable?'workspace':'original']));
  const [directory, setDirectory] = React.useState(''), [offset, setOffset] = React.useState(0), [tick, setTick] = React.useState(0);
  const [listing, setListing] = React.useState(null), [error, setError] = React.useState(''), [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    let cancelled = false; setListing(null); setError('');
    api.workspaceTree(project.id, directory, offset).then(value => { if (!cancelled) setListing(value); }).catch(error => { if (!cancelled) setError(error.message); });
    return () => { cancelled = true; };
  }, [api, project.id, directory, offset, tick]);
  const navigate = path => { setDirectory(path); setOffset(0); };
  const action = async fn => { setBusy(true); try { await fn(); } catch (error) { setError(error.message); } finally { setBusy(false); } };
  return <div className="rw-workspace-browser">
    <p className="rw-workspace-root">{project.rootPath}</p>
    <div className="rw-workspace-actions"><button className="rw-secondary" disabled={busy} onClick={() => void action(async () => { await onRefresh(); setTick(x => x + 1); })}>重新扫描工作区</button><button className="rw-quiet" onClick={onReveal}>在资源管理器中打开</button></div>
    <nav className="rw-workspace-breadcrumb"><button onClick={() => navigate('')}>工作区</button>{directory.split(/[\\/]/).filter(Boolean).map((part, index, parts) => <React.Fragment key={index}><span>/</span><button onClick={() => navigate(parts.slice(0, index + 1).join('/'))}>{part}</button></React.Fragment>)}</nav>
    {error && <p role="alert" className="rw-native-failure">{error}</p>}
    {!listing && <p role="status">正在读取目录…</p>}
    <div className="rw-workspace-files">{listing?.entries?.map(entry => {const role=!entry.directory&&/\.docx$/i.test(entry.name)?wordRoles.get(canonical(entry.relativePath))||'original':null;return <button key={entry.relativePath} className="rw-workspace-file" disabled={busy || !entry.directory && !entry.kind} onClick={() => entry.directory ? navigate(entry.relativePath) : void action(() => onSelect(entry))}><Icon name={entry.directory ? 'folder' : 'file'} size={17} /><span>{entry.name}<small>{entry.directory ? '文件夹' : `${(entry.bytes / 1024).toFixed(1)} KB${entry.kind ? '' : ' · 保留原格式'}`}</small></span>{role&&<small className="rw-document-role" data-role={role}>{role==='workspace'?'工作区版本':'原稿'}</small>}{entry.directory && <Icon name="chevron" size={12} />}</button>})}</div>
    {listing?.total > listing?.limit && <div className="rw-workspace-actions"><button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - listing.limit))}>上一页</button><span>{offset + 1}–{Math.min(offset + listing.limit, listing.total)} / {listing.total}</span><button disabled={offset + listing.limit >= listing.total} onClick={() => setOffset(offset + listing.limit)}>下一页</button></div>}
    <p className="rw-context-muted">目录大小写自动匹配。原始数据保留只读，过程文件写入 {project.workspace?.directories?.temp || 'temp'}；正文和内容版本保存到对应的工作区目录。</p>
  </div>;
}
