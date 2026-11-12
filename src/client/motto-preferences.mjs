const KEY='dsh-research-workbench:mottos:v1';
export const DEFAULT_MOTTO_FONT='毛体';
export const MAO_FONT_FAMILY='草檀斋毛泽东字体';
export const MOTTO_FONTS=Object.freeze(['毛体',MAO_FONT_FAMILY,'系统字体','宋体','楷体','华文行楷','微软雅黑','Microsoft YaHei UI','Segoe UI']);
export function mottoFont(value){
  const name=(value??DEFAULT_MOTTO_FONT);
  if(typeof name!=='string'||!name.trim()||name.length>100||/[\x00-\x1f\x7f]/.test(name))throw Error('请填写不超过 100 字的本机字体名称。');
  return name.trim();
}
export function mottoFontFamily(value){
  const name=mottoFont(value),fallback="var(--rw-ui,system-ui),sans-serif";
  if(name==='系统字体')return fallback;
  const families=name===DEFAULT_MOTTO_FONT?[MAO_FONT_FAMILY,'毛体','毛泽东字体','毛泽东书法字体','毛泽东书法体','方正毛体简体','FZMaoTi-G02S','MaoTi','Mao Ti']:[name];
  return families.map(name=>JSON.stringify(name)).join(',')+','+fallback;
}
export const DEFAULT_MOTTOS=Object.freeze([
  '世上无难事，只要肯登攀。——毛泽东《水调歌头·重上井冈山》',
  '雄关漫道真如铁，而今迈步从头越。——毛泽东《忆秦娥·娄山关》',
  '一万年太久，只争朝夕。——毛泽东《满江红·和郭沫若同志》',
  '红军不怕远征难，万水千山只等闲。——毛泽东《七律·长征》',
  '为有牺牲多壮志，敢教日月换新天。——毛泽东《七律·到韶山》',
  '下定决心，不怕牺牲，排除万难，去争取胜利。——毛泽东《愚公移山》',
]);
// Verified excerpts, not complete poems. Keep source links out of the moving UI.
export const MOTTO_SOURCES=Object.freeze([
  'https://www.dswxyjy.org.cn/n1/2019/0621/c423733-31173717.html',
  'https://cpc.people.com.cn/n1/2026/1026/c443712-40821588.html',
  'https://www.ccdi.gov.cn/specialn/lswhyl/202303/t20230317_253307.html',
  'https://www.12371.cn/2022/04/13/ARTI1649850555301885.shtml',
  'https://www.12371.cn/special/zgjs/ssjs/',
  'https://www.12371.cn/special/zgjs/ygysjs/',
]);
export function parseMottoLines(value){
  const items=value.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  if(items.length>30)throw Error('最多保存 30 句标语。');
  if(items.some(line=>Array.from(line).length>180))throw Error('每句标语请控制在 180 字以内。');
  return items;
}
export function mottoInterval(value){const seconds=Number(value);if(!Number.isInteger(seconds)||seconds<5||seconds>3600)throw Error('切换间隔请设为 5 至 3600 秒。');return seconds}
export function mottoDisplayText(line){return line.replace(/——[^—]+《[^》]+》$/u,'').trim()}
export function defaultMottoPreferences(){return {enabled:true,paused:false,intervalSeconds:30,fontFamily:DEFAULT_MOTTO_FONT,items:[...DEFAULT_MOTTOS]}}
export function readMottoPreferences(storage){
  try{
    const value=JSON.parse((storage??globalThis.localStorage)?.getItem(KEY)||'null');
    if(!value||!Array.isArray(value.items)||value.items.some(item=>typeof item!=='string'))return defaultMottoPreferences();
    const items=parseMottoLines(value.items.join('\n'));
    let fontFamily;try{fontFamily=mottoFont(value.fontFamily)}catch{fontFamily=DEFAULT_MOTTO_FONT}
    return {enabled:value.enabled!==false,paused:value.paused===true,intervalSeconds:mottoInterval(value.intervalSeconds??30),fontFamily,items};
  }catch{return defaultMottoPreferences()}
}
export function writeMottoPreferences(value,storage){
  try{
    const target=storage??globalThis.localStorage;if(!target)return false;
    const items=parseMottoLines(value.items.join('\n'));
    target.setItem(KEY,JSON.stringify({enabled:Boolean(value.enabled),paused:Boolean(value.paused),intervalSeconds:mottoInterval(value.intervalSeconds??30),fontFamily:mottoFont(value.fontFamily),items}));return true;
  }catch{return false}
}
