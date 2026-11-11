/** Display-only changes. Never run document formatting or save commands. */
export async function setWordRibbon(api,collapsed){
  const info=await api.uiInspect({});
  if(Boolean(info.ui?.ribbonCollapsed)!==collapsed)await api.execute('ui.collapseRibbon',{});
  return collapsed;
}
export function isWordOpenPage(info){return Boolean(info.ui?.backstage)&&['home','open'].includes(info.ui.backstagePage||'home')}
export async function showWordDocument(api){await api.execute('ui.backstage',{value:false})}
export function wordZoom(info){
  if(['pageWidth','onePage','multiplePages','textWidth'].includes(info?.view?.fit))return info.view.fit;
  const percent=info?.view?.zoom*100;return Number.isFinite(percent)&&percent>=10&&percent<=500?percent:95;
}
export async function setWordZoom(api,value=95){await api.execute('view.zoom',{value})}
const RIBBON_KEY='dsh-research-workbench:word-ribbon-collapsed:v1';
export function readWordRibbon(){try{return globalThis.localStorage?.getItem(RIBBON_KEY)!=='0'}catch{return true}}
export function rememberWordRibbon(collapsed){try{globalThis.localStorage?.setItem(RIBBON_KEY,collapsed?'1':'0')}catch{}}
