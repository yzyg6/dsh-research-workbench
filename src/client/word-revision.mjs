import {selectionWithText} from '../shared/word-sentence-update.mjs';

export async function wordPosition(api){return{selection:await api.execute('document.selection',{}),view:await api.uiInspect({})}}
export async function restoreWordPosition(api,position,selection=position?.selection){
  if(selection?.anchor&&selection?.focus){try{await api.execute('select.range',{anchor:selection.anchor,focus:selection.focus})}catch{/* A restored historical paragraph may no longer exist. */}}
  const top=position?.view?.pages?.[0]?.[1];if(!Number.isFinite(top)||!api.request)return;
  for(let n=0;n<3;n++){
    const info=await api.uiInspect({}),current=info.pages?.[0]?.[1],rect=info.canvasRect;
    if(!Number.isFinite(current)||!rect||Math.abs(current-top)<2)return;
    await api.request('ui.wheel',{x:rect[0]+rect[2]/2,y:rect[1]+rect[3]/2,dy:top-current,unit:'point'});
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
