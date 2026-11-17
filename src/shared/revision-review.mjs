export const CHANGE_LABELS = { unchanged: '未修改', wording: '词语表达', structure: '句式调整', meaning: '意思改变' };
export const SCIENTIFIC_STYLE = '提高科学表达的准确性、清晰度与逻辑性，保持全文术语一致。保留原意、数字、单位、比较对象、否定、适用条件、确定程度与引用；不得把相关写成因果、可能写成确定，不补造数据或文献。删除空泛铺垫、重复总结、机械排比、夸大意义和模板化连接，保留作者语气及必要的专业术语。直接陈述问题、方法、结果与证据支持的贡献，避免无依据的自我辩护、预设质疑和重复免责声明；保留影响结论的真实局限与不确定性，不掩盖不利结果。资料缺口和核实建议放在修改说明中，不擅自加入正文。无须修改的句子原样保留。';
export const PROMPT_TEMPLATES = [
  { id: 'scientific', title: '科学润色（默认）', prompt: SCIENTIFIC_STYLE },
  { id: 'concise', title: '精简与去 AI 味', prompt: SCIENTIFIC_STYLE + '本轮重点：压缩重复与空话，使用具体主语和动词，不按词语黑名单机械替换，不删除独立信息。' },
  { id: 'logic', title: '句式与逻辑衔接', prompt: SCIENTIFIC_STYLE + '本轮重点：调整句式与信息顺序，使论点、证据和解释衔接自然，不更改因果关系或论证强度。' },
  { id: 'evidence', title: '证据与科学措辞', prompt: SCIENTIFIC_STYLE + '本轮重点：核对量化表述、比较基准、适用范围和证据强度。没有直接支持的文献不列为依据，疑点列在说明中。' },
];
export const DEFAULT_REVISION_PROMPT = PROMPT_TEMPLATES[0].prompt;
export const MANUSCRIPT_REVIEW_TEMPLATES = [
  { id: 'overview', title: '综合审阅（默认）', prompt: '审查研究问题、方法、结果和结论是否衔接。优先标出影响结论可靠性、复现性或读者理解的问题，区分必须修改和可选完善。指出相关段落和需要作者核对的资料。' },
  { id: 'argument', title: '论证与章节结构', prompt: '沿研究问题、核心论点、证据和结论梳理论证链。找出跳步、重复、论点与证据错位，以及前后小节无法衔接之处。建议具体的段落顺序、过渡或内容取舍，并指出与其他章节的依赖。' },
  { id: 'methods', title: '方法与可复现性', prompt: '核查数据来源、样本或纳排标准、预处理、变量定义、参数、计算步骤和验证设计是否清楚。对照结果实际采用的方法、单位和统计口径。列出缺失的信息及其影响，明确作者需要补充哪些细节。' },
  { id: 'results', title: '结果与证据强度', prompt: '逐项核对主要结论与稿件中的数据、比较基准、效应量和不确定性是否对应。标出数值或单位不一致、将相关写成因果、超出适用范围，以及不确定结果被写成确定结论的地方。' },
  { id: 'discussion', title: '贡献与讨论', prompt: '核查研究贡献是否由已有结果支撑，讨论是否解释了主要发现、可能机制与适用条件。优先标出与研究问题脱节、超出数据支持或重复复述结果的段落，指出需要加强的比较或解释。' },
  { id: 'terminology', title: '术语与学术表达', prompt: '核对同一概念、缩写、变量、单位和统计措辞在各小节是否统一，检查首次定义和指代是否明确。优先定位影响含义的表述，再指出冗余和歧义，保留原意及科学表述的确定程度。' },
  { id: 'references', title: '图表与引文对应', prompt: '根据稿件可见的图表标题、表格内容、正文引用和参考文献条目，核对编号、单位、比较对象与引文是否对应。指出正文宣称的发现能否追溯到所引材料，将证据不足的地方标为待核对。' },
];
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
