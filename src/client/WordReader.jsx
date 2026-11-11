import React from 'react';

const MATH_TAGS=new Set(['mrow','mtext','mo','mi','mn','mfrac','msup','msub','msubsup','msqrt','mroot','munderover','munder','mover','mtable','mtr','mtd']);
function MathNode({node}){if(typeof node==='string')return node;if(!node||!MATH_TAGS.has(node.tag))return null;return React.createElement(node.tag,null,(node.children||[]).map((child,i)=><MathNode key={i} node={child}/>))}
function WordImage({image,url}){
  const element=React.useRef(null),[src,setSrc]=React.useState(''),[error,setError]=React.useState('');
  React.useEffect(()=>{
    if(!image.id)return;const controller=new AbortController();let blobUrl,started=false,closed=false;
    const load=async()=>{if(started)return;started=true;try{const result=await fetch(url,{signal:controller.signal,cache:'no-store'});if(!result.ok)throw Error();const blob=await result.blob();if(closed)return;blobUrl=URL.createObjectURL(blob);setSrc(blobUrl)}catch{if(!closed)setError('图片加载未完成，可在原 Word 查看。')}};
    const observer=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){observer.disconnect();void load()}},{rootMargin:'160px'}):null;
    if(observer&&element.current)observer.observe(element.current);else void load();
    const img=element.current;return()=>{closed=true;controller.abort();observer?.disconnect();img?.removeAttribute('src');if(blobUrl)URL.revokeObjectURL(blobUrl)};
  },[image.id,url]);
  if(image.unavailable)return <span className="rw-word-image-note">{image.unavailable}</span>;
  return <figure className="rw-word-image"><img ref={element} src={src||undefined} alt={error||'Word 内嵌图片'} width={image.width} height={image.height} decoding="async" style={{aspectRatio:`${image.width}/${image.height}`}}/>{error&&<figcaption>{error}</figcaption>}</figure>;
}
function Runs({runs,imageUrl}){return(runs||[]).map((run,i)=>{
  if(run.image)return <WordImage key={i} image={run.image} url={run.image.id?imageUrl(run.image.id):''}/>;
  if(run.math)return <math key={i} xmlns="http://www.w3.org/1998/Math/MathML"><MathNode node={run.math}/></math>;
  let text=run.text||'';if(run.bold)text=<strong>{text}</strong>;if(run.italic)text=<em>{text}</em>;if(run.underline)text=<u>{text}</u>;if(run.position==='superscript')text=<sup>{text}</sup>;if(run.position==='subscript')text=<sub>{text}</sub>;if(/^https?:\/\//.test(run.href||''))text=<a href={run.href} target="_blank" rel="noopener noreferrer">{text}</a>;return <React.Fragment key={i}>{text}</React.Fragment>;
})}
export const WordBlocks=React.memo(function WordBlocks({blocks,imageUrl}){return(blocks||[]).map((block,i)=>{
  if(block.type==='paragraph'){const Tag=block.level?`h${Math.min(6,Math.max(1,block.level))}`:'div';return <Tag className="rw-word-paragraph" key={i} style={{textAlign:block.align==='both'?'justify':block.align,paddingLeft:block.indent?`${block.indent*1.2}em`:undefined}}>{block.marker&&<span className="rw-word-list-marker">{block.marker} </span>}<Runs runs={block.runs} imageUrl={imageUrl}/></Tag>}
  if(block.type==='table')return <div key={i} className="rw-word-table-wrap">{block.continuation&&<small>续表</small>}<table className="rw-word-table"><tbody>{block.rows.map((row,n)=><tr key={n}>{row.cells.map((cell,c)=>{const Tag=row.header?'th':'td';return <Tag key={c} colSpan={cell.colspan||1} rowSpan={cell.rowspan||1}><WordBlocks blocks={cell.blocks} imageUrl={imageUrl}/></Tag>})}</tr>)}</tbody></table></div>;
  return null;
})});

export function WordReader({api,project,object,initialSegment=0,onPosition,onOpenNative,onOpenMarkdown}){
  const [status,setStatus]=React.useState(null),[page,setPage]=React.useState(null),[segment,setSegment]=React.useState(initialSegment),[error,setError]=React.useState(''),[attempt,setAttempt]=React.useState(0);
  const scroll=React.useRef(null);
  React.useEffect(()=>{
    let cancelled=false,timer,leaseId;
    setStatus(null);setPage(null);setError('');
    const release=id=>{if(id)void api.mutate('cancelWordPreview',{projectId:project.id,objectId:object.id,leaseId:id}).catch(()=>{})};
    const update=result=>{if(cancelled)return;setStatus(result);if(result.state==='ready')setSegment(n=>Math.min(n,Math.max(0,result.segments-1)));else if(['queued','running'].includes(result.state))timer=setTimeout(poll,500)};
    const poll=async()=>{if(cancelled)return;if(document.visibilityState==='hidden'){timer=setTimeout(poll,1000);return}try{update(await api.wordStatus(project.id,object.id))}catch(e){if(!cancelled)setError(e.message)}};
    void api.mutate('prepareWordPreview',{projectId:project.id,objectId:object.id}).then(result=>{leaseId=result.actionResult.leaseId;if(cancelled)release(leaseId);else update(result.actionResult)}).catch(e=>{if(!cancelled)setError(e.message)});
    return()=>{cancelled=true;clearTimeout(timer);release(leaseId)};
  },[api,project.id,object.id,object.revision,attempt]);
  React.useEffect(()=>{
    if(status?.state!=='ready')return;const controller=new AbortController();setPage(null);setError('');if(scroll.current)scroll.current.scrollTop=0;
    api.wordPage(project.id,object.id,segment,controller.signal).then(value=>{if(!controller.signal.aborted)setPage(value)}).catch(e=>{if(!controller.signal.aborted)setError(e.message)});
    return()=>controller.abort();
  },[api,project.id,object.id,object.revision,status?.state,segment]);
  const imageUrl=React.useCallback(image=>api.wordImageUrl(project.id,object.id,image),[api,project.id,object.id,object.revision]);
  const navigate=n=>{if(n<0||n>=(status?.segments||0)||n===segment)return;setPage(null);setSegment(n);onPosition?.(n)};
  const ready=status?.state==='ready';
  return <section className="rw-word-reader" aria-label="Word 工作台阅读器">
    <div className="rw-word-toolbar"><div><strong>{object.title}</strong><small>Word 阅读 · {object.metadata?.wordEditable?'当前工作副本':'原始文稿'}</small></div><button className="rw-quiet" onClick={onOpenNative}>原应用编辑</button>{onOpenMarkdown&&<button className="rw-secondary" onClick={onOpenMarkdown}>打开可编辑 MD</button>}</div>
    <div className="rw-word-navigation"><span>按内容分段加载 · 保留原 Word</span>{ready&&<><button aria-label="上一阅读分段" disabled={segment===0} onClick={()=>navigate(segment-1)}>上一段</button><label>第 <input aria-label="Word 阅读分段" type="number" min={1} max={status.segments} value={segment+1} onChange={event=>{const n=Number(event.target.value)-1;if(Number.isInteger(n))navigate(n)}}/> / {status.segments} 段</label><button aria-label="下一阅读分段" disabled={segment+1>=status.segments} onClick={()=>navigate(segment+1)}>下一段</button></>}</div>
    {!ready&&!error&&['queued','running',undefined].includes(status?.state)&&<p className="rw-word-status" role="status">{status?.phase||'正在准备 Word 阅读…'} · 可继续切换其他资料</p>}
    {(error||['failed','cancelled','missing'].includes(status?.state))&&<div className="rw-native-failure" role="alert"><p>{error||status.error||'阅读已停止，可重新打开。'}</p><button className="rw-secondary" onClick={()=>setAttempt(n=>n+1)}>重新加载 Word</button><button className="rw-quiet" onClick={onOpenNative}>使用原应用打开</button></div>}
    {ready&&<div ref={scroll} className="rw-word-scroll"><article className="rw-word-page" aria-label={`Word 内容分段 ${segment+1}`}>{page?<WordBlocks blocks={page.blocks} imageUrl={imageUrl}/>:<p role="status">正在读取当前分段…</p>}</article>{status.warnings?.length>0&&<details className="rw-word-warnings"><summary>阅读提示 · {status.warnings.length}</summary>{status.warnings.map((warning,i)=><p key={i}>{warning}</p>)}</details>}</div>}
    <footer className="rw-word-footer">轻量阅读分段不等于 Word 原始页码；论文写作页可切换直接编辑，或使用原应用。{ready&&<span>{status.counts.paragraphs} 段 · {status.counts.tables} 表 · {status.counts.images} 图 · {status.counts.formulas} 公式</span>}</footer>
  </section>;
}
