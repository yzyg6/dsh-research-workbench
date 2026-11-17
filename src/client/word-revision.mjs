import {selectionWithText} from '../shared/word-sentence-update.mjs';

export async function wordPosition(api){return{selection:await api.execute('document.selection',{}),view:await api.uiInspect({})}}
export async function showWordComments(api) {
  const comments = await api.execute('review.comments', {});
  if (!Array.isArray(comments) || !comments.length) throw Error('当前 Word 版本没有可显示的批注。');
  // The native ribbon command toggles. Its result is the new visibility.
  let pane = await api.execute('view.commentsPane', {});
  if (pane?.value === false) pane = await api.execute('view.commentsPane', {});
  if (pane?.value !== true) throw Error('Word 批注窗格未打开，请在 Word「审阅」中打开批注。');
}
export async function restoreWordPosition(api,position,selection=position?.selection,{waitForScroll=false}={}){
  if(selection?.anchor&&selection?.focus){try{await api.execute('select.range',{anchor:selection.anchor,focus:selection.focus})}catch{/* A restored historical paragraph may no longer exist. */}}
  const top=position?.view?.pages?.[0]?.[1];if(!Number.isFinite(top)||!api.request)return;
  for(let n=0;n<3;n++){
    const info=await api.uiInspect({}),current=info.pages?.[0]?.[1],rect=info.canvasRect;
    if(!Number.isFinite(current)||!rect||Math.abs(current-top)<2)return;
    await api.request('ui.wheel',{x:rect[0]+rect[2]*0.3,y:rect[1]+rect[3]*0.6,dy:top-current,unit:'point'});
    if(waitForScroll){
      // The canvas can acknowledge the input before painting the next frame.
      // Repeating the same delta against the old frame overshoots the target.
      let settled=false;
      for(let frame=0;frame<10;frame++){
        await new Promise(resolve=>setTimeout(resolve,60));
        const painted=(await api.uiInspect({})).pages?.[0]?.[1];
        if(!Number.isFinite(painted)||Math.abs(painted-top)<2)return;
        if(Math.abs(painted-current)>=2){settled=true;break}
      }
      if(!settled)return;
    }
  }
}
/** The server commits the lossless XML patch; reflect just that edit in this engine. */
export async function mirrorWordRevision(api,update,position,acknowledge){
  const range=update.selection;
  await api.execute('select.range',{anchor:range.anchor,focus:range.focus});
  const current=await api.execute('document.selection',{});
  if(current.text!==range.text)throw Error('编辑器中的句子与已保存版本不一致，需要重新同步。');
  if(range.text!==update.replacement){
    await api.execute('text.insert',{text:update.replacement,raw:true});
    const inserted=selectionWithText(range,update.replacement);
    await api.execute('select.range',{anchor:inserted.anchor,focus:inserted.focus});
    const checked=await api.execute('document.selection',{});
    if(checked.text!==update.replacement)throw Error('编辑器更新后的句子与已保存建议不一致。');
    await acknowledge();
  }
  await restoreWordPosition(api,position,range.text===update.replacement?selectionWithText(range,update.replacement):null);
}

const utf8 = new TextEncoder();
const width = text => utf8.encode(text).length;
const styles = runs => {
  const spans=[];
  for(const {len,...format} of runs){
    if(!len)continue;
    const style=JSON.stringify(format);
    if(spans.at(-1)?.style===style)spans.at(-1).len+=len;
    else spans.push({len,style});
  }
  return spans;
};

function reviewPatch(part, paragraph) {
  if(!paragraph?.runs?.length||paragraph.objects?.some(object=>!['commentStart','commentEnd'].includes(object.type)))throw Error('这一段含有需要重新同步的 Word 对象。');
  const plain=[];
  let bytes=0,units=0;
  for(const character of paragraph.text){
    const next={off:bytes,end:bytes+width(character),unit:units,endUnit:units+character.length,character};
    if(character!=='\ufffc')plain.push(next);
    bytes=next.end;units=next.endUnit;
  }
  if(!plain.length||plain.map(item=>item.character).join('')!==part.before)throw Error('Word 段落与保存的原文不一致。');
  const runs=paragraph.runs.map(run=>({...run})), stops=[];
  let start=0;
  for(const run of runs){stops.push({start,end:start+run.len});start+=run.len;}
  if(start!==bytes)throw Error('Word 字符格式位置不一致。');
  let expected=paragraph.text;
  const moves=[];
  for(const [left,right,text] of [...part.changes].reverse()){
    const insertion=left===right;
    const first=insertion?plain[left-1]||plain[0]:plain[left],last=insertion?first:plain[right-1];
    if(!first||!last)throw Error('Word 文本位置已变化。');
    const from=insertion&&left>0?first.end:first.off, to=insertion?from:last.end;
    const firstUnit=insertion&&left>0?first.endUnit:first.unit,lastUnit=insertion?firstUnit:last.endUnit;
    if(paragraph.text.slice(firstUnit,lastUnit).includes('\ufffc'))throw Error('改动跨越 Word 批注边界。');
    const index=stops.findIndex(run=>insertion&&left>0?run.start<from&&from<=run.end:run.start<=from&&from<run.end&&to<=run.end);
    if(index<0)throw Error('改动跨越 Word 字符格式。');
    runs[index].len+=width(text)-(to-from);
    expected=expected.slice(0,firstUnit)+text+expected.slice(lastUnit);
    const point=off=>({story:'body',path:part.path,off});
    const next=moves.at(-1);
    const gap=next&&paragraph.text.slice(lastUnit,next.unit);
    if(next?.run===index&&!gap.includes('\ufffc')){
      next.anchor=point(from);next.text=text+gap+next.text;next.unit=firstUnit;
    }else moves.push({anchor:point(from),focus:point(to),text,unit:firstUnit,run:index});
  }
  if(expected.replaceAll('\ufffc','')!==part.after)throw Error('Word 局部改动与保存结果不一致。');
  return {moves,expected,runs:styles(runs),objects:paragraph.objects||[]};
}

/** Mirror a committed review edit in the existing document and preserve Word comment anchors. */
export async function mirrorReviewRevision(api,update,position,acknowledge,context){
  const {paragraphs,resolvedCommentId}=update;
  const read=path=>api.execute('document.paragraph',{path}).then(result=>result.paragraph);
  const [prepared,plans]=await Promise.all([
    context || readReviewContext(api),
    Promise.all(paragraphs.map(async part=>reviewPatch(part,await read(part.path)))),
  ]);
  if(prepared.document.trackChanges!==false)throw Error('修订记录模式需要重新同步 Word。');
  let comment;
  if(Number.isInteger(resolvedCommentId)){
    comment=prepared.comments.find(item=>item.id===resolvedCommentId);
    if(!comment||comment.parent!==null)throw Error('编辑器中的审阅批注与 Word 文件不一致。');
  }
  for(const {moves} of plans){
    for(const {anchor,focus,text} of moves){
      await api.execute('select.range',{anchor,focus});
      if(text)await api.execute('text.insert',{text,raw:true});
      else await api.execute('text.delete',{});
    }
  }
  const outcomes=await Promise.allSettled([
    Promise.all(plans.map(async (plan,index)=>{
      const actual=await read(paragraphs[index].path);
      if(actual?.text!==plan.expected||JSON.stringify(styles(actual.runs))!==JSON.stringify(plan.runs)
        ||JSON.stringify(actual.objects||[])!==JSON.stringify(plan.objects))throw Error('编辑器中的文字、格式或批注需要重新同步。');
    })),
    (async()=>{
      if(!comment||comment.resolved)return;
      await api.execute('review.resolveComment',{id:comment.id,value:true});
      const comments=await api.execute('review.comments',{});
      if(!comments.find(item=>item.id===comment.id)?.resolved)throw Error('批注状态需要重新同步。');
    })(),
  ]);
  const failure=outcomes.find(result=>result.status==='rejected');
  if(failure)throw failure.reason;
  await restoreWordPosition(api,position);
  await acknowledge();
}

export async function readReviewContext(api){
  const [document,comments]=await Promise.all([api.execute('document.inspect',{text:false}),api.execute('review.comments',{})]);
  return {document,comments};
}
