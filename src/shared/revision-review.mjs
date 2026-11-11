export const CHANGE_LABELS = { unchanged: '未修改', wording: '词语表达', structure: '句式调整', meaning: '意思改变' };
export const SCIENTIFIC_STYLE = '提高科学表达的准确性、清晰度与逻辑性，保持全文术语一致。保留原意、数字、单位、比较对象、否定、适用条件、确定程度与引用；不得把相关写成因果、可能写成确定，不补造数据或文献。删除空泛铺垫、重复总结、机械排比、夸大意义和模板化连接，保留作者语气及必要的专业术语。直接陈述问题、方法、结果与证据支持的贡献，避免无依据的自我辩护、预设质疑和重复免责声明；保留影响结论的真实局限与不确定性，不掩盖不利结果。资料缺口和核实建议放在修改说明中，不擅自加入正文。无须修改的句子原样保留。';
export const PROMPT_TEMPLATES = [
  { id: 'scientific', title: '科学润色（默认）', prompt: SCIENTIFIC_STYLE },
  { id: 'concise', title: '精简与去 AI 味', prompt: SCIENTIFIC_STYLE + '本轮重点：压缩重复与空话，使用具体主语和动词，不按词语黑名单机械替换，不删除独立信息。' },
  { id: 'logic', title: '句式与逻辑衔接', prompt: SCIENTIFIC_STYLE + '本轮重点：调整句式与信息顺序，使论点、证据和解释衔接自然，不更改因果关系或论证强度。' },
  { id: 'evidence', title: '证据与科学措辞', prompt: SCIENTIFIC_STYLE + '本轮重点：核对量化表述、比较基准、适用范围和证据强度。没有直接支持的文献不列为依据，疑点列在说明中。' },
];
export const DEFAULT_REVISION_PROMPT = PROMPT_TEMPLATES[0].prompt;
export const CLASSIFICATION_INSTRUCTION = '请另提供 sentenceChanges 数组，按顺序完整覆盖原文和 replacement，每项包含 before、after、kind（unchanged/wording/structure/meaning）、reason。相邻多句可合为一组以表达拆句/并句；before 拼接必须等于原文，after 拼接必须等于 replacement。unchanged 为完全相同；wording 仅词语表达变化；structure 为句式调整且含义不变；meaning 为事实、范围、关系或确定程度改变。不要仅凭字面相似度判断语义。';

export function splitSentences(text) {
  if (typeof Intl.Segmenter === 'function') return [...new Intl.Segmenter('zh', { granularity: 'sentence' }).segment(text)].map(item=>item.segment);
  return text.match(/[^。！？!?\n]+[。！？!?]+[”’"']*\s*|[^。！？!?\n]+(?:\n|$)|\n/g) || (text ? [text] : []);
}
const normalized = value => value.replace(/\s/g, '');
const tokens = text => text.match(/\d+(?:\.\d+)?%?|[A-Za-z][A-Za-z0-9-]*|[\u3400-\u9fff]{2,12}/g) || [];
function similarity(a, b) {
  if (a === b) return 1;
  const grams = text => { const set = new Set(); for (let i = 0; i < text.length - 1; i++) set.add(text.slice(i, i + 2)); return set; };
  const x = grams(normalized(a)), y = grams(normalized(b));
  return (2 * [...x].filter(value => y.has(value)).length) / Math.max(1, x.size + y.size);
}
function classify(before, after) {
  if (before === after) return { kind: 'unchanged', source: 'exact', reason: '文字完全一致' };
  const facts = value => (value.match(/\d+(?:\.\d+)?%?|不|未|无|没有|可能|一定|显著|导致|相关|因果|所有|部分|仅|\b(?:not|no|may|must|all|some|causes?|associated)\b/gi) || []).join('|');
  const risk = !before || !after || facts(before) !== facts(after);
  return { kind: risk ? 'meaning' : similarity(before, after) >= .72 ? 'wording' : 'structure', source: 'estimate', reason: risk ? '增删或事实/限定词变化，含义待核对' : '按文字变化初步标记，语义待核对' };
}
export function validateSentenceChanges(changes, before, after) {
  return Array.isArray(changes) && changes.length > 0 && changes.length <= 300 && changes.every(row => row && typeof row.before === 'string' && typeof row.after === 'string' && Object.hasOwn(CHANGE_LABELS,row.kind) && typeof row.reason === 'string' && row.reason.length <= 1000 && (row.before || row.after) && (row.kind !== 'unchanged' || row.before === row.after) && (row.before !== row.after || row.kind === 'unchanged')) && changes.map(row => row.before).join('') === before && changes.map(row => row.after).join('') === after;
}
export function compareSentences(before, after, supplied) {
  if (validateSentenceChanges(supplied, before, after)) return supplied.map(row => ({ ...row, source: ['author','estimate','exact'].includes(row.source) ? row.source : 'model' }));
  const left = splitSentences(before), right = splitSentences(after);
  // Bounded global alignment keeps unchanged neighbours aligned after insertion/deletion.
  if (left.length * right.length > 90000) return [{ before, after, ...classify(before, after) }];
  const dp = Array.from({ length: left.length + 1 }, () => new Float32Array(right.length + 1));
  for (let i = 0; i <= left.length; i++) dp[i][0] = i;
  for (let j = 0; j <= right.length; j++) dp[0][j] = j;
  for (let i = 1; i <= left.length; i++) for (let j = 1; j <= right.length; j++) dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+(left[i-1] === right[j-1] ? 0 : 1.4-similarity(left[i-1],right[j-1])));
  let i = left.length, j = right.length; const rows = [];
  while (i || j) {
    let a = '', b = '';
    if (i && j && Math.abs(dp[i][j] - (dp[i-1][j-1]+(left[i-1] === right[j-1] ? 0 : 1.4-similarity(left[i-1],right[j-1])))) < .001) { a=left[--i]; b=right[--j]; }
    else if (i && (!j || dp[i-1][j] <= dp[i][j-1])) a=left[--i]; else b=right[--j];
    rows.push({ before: a, after: b, ...classify(a,b) });
  }
  return rows.reverse();
}

/** Candidates are lexical matches in the frozen article, never asserted dependencies. */
export function relatedPassages(article, before, after) {
  if (!before || before === after) return [];
  let start=0,end=0;
  while(start<Math.min(before.length,after.length)&&before[start]===after[start])start++;
  while(end<Math.min(before.length,after.length)-start&&before[before.length-1-end]===after[after.length-1-end])end++;
  const changed=before.slice(Math.max(0,start-5),before.length-end+5)+' '+after.slice(Math.max(0,start-5),after.length-end+5);
  const keys=[...new Set([...tokens(changed),...(before.match(/\[[^\]]+\]/g)||[])])].filter(x=>x.length>=2||/^\d$/.test(x)).slice(0,35);
  let heading='正文'; const result=[];
  article.split(/\n+/).forEach((text,index)=>{
    if (/^(?:#{1,6}\s|\d+(?:\.\d+)*\s|摘要|Abstract|结论|讨论|结果|方法|引言|参考文献)/i.test(text)) heading=text.slice(0,70);
    if (!text.trim() || (before.trim()&&text.includes(before.trim())) || (after.trim()&&text.includes(after.trim()))) return;
    const matched=keys.filter(key=>text.includes(key));
    if(matched.length)result.push({ paragraph:index+1, heading, text:text.slice(0,800), matched, reason:'与本次修改共享术语、数值或引用，请核对是否需要同步。' });
  });
  return result.slice(0,30);
}
