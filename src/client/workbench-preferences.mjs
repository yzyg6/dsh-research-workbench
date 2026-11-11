const SIDEBAR_KEY='dsh-research-workbench:sidebar-collapsed:v1';
export function readSidebarCollapsed(storage){
  try{return (storage??globalThis.localStorage)?.getItem(SIDEBAR_KEY)!=='0'}catch{return true}
}
export function rememberSidebarCollapsed(collapsed,storage){
  try{(storage??globalThis.localStorage)?.setItem(SIDEBAR_KEY,collapsed?'1':'0')}catch{/* Presentation still works when browser storage is unavailable. */}
}
const WORD_WIDTH_KEY='dsh-research-workbench:word-sidebar-ratio:v2';
export function readWordSidebarRatio(storage){try{const ratio=Number((storage??globalThis.localStorage)?.getItem(WORD_WIDTH_KEY));return ratio>=.25&&ratio<=.55?ratio:.38}catch{return .38}}
export function rememberWordSidebarRatio(ratio,storage){try{(storage??globalThis.localStorage)?.setItem(WORD_WIDTH_KEY,String(Math.max(.25,Math.min(.55,ratio))))}catch{}}
