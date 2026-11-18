export const CHANGE_LABELS = { unchanged: '未修改', wording: '词语表达', structure: '句式调整', meaning: '意思改变' };
const scientificVoice = '沿用作者的术语、语气和句式习惯。让句子直接说清研究对象、做法、发现或解释，用具体主语和动词。删掉空泛铺垫、固定套话、机械排比、无依据拔高和重复总结，保留有实际作用的过渡及限定。术语按原定义使用，避免为了显得不同而机械换词。通读成稿后，对照原文核对数字、单位、归因、范围和确定程度。';
export const MANUSCRIPT_SECTION_RULE = '章节约束优先于重排和补证据的建议。正文分设方法与结果时，方法部分写研究对象、数据来源、纳排标准、分析流程和指标定义。估计值、组间差异、效应量、显著性和结果图表中的发现留在结果部分，禁止把这些结果前移、复制或改述进方法部分。需要衔接时，说明将报告的指标或指向相应结果小节。若方法原文已混入结果，在修改说明中标出应移至的结果小节，等两处都能编辑时再移动。';
export const SCIENTIFIC_STYLE = '提高科学表达的准确性、清晰度与逻辑性。保留原意、数字、单位、比较对象、否定、适用条件、确定程度与引用。保留影响结论的真实局限与不确定性，不掩盖不利结果。不补造数据或文献，按原有证据表达相关性、因果和确定程度。用已有结果讲清贡献，删去针对假想质疑的辩解。资料缺口和核实建议放在修改说明中。无须修改的句子原样保留。' + MANUSCRIPT_SECTION_RULE + scientificVoice;
export const PROMPT_TEMPLATES = [
  { id: 'scientific', title: '科学润色（默认）', prompt: SCIENTIFIC_STYLE },
  { id: 'concise', title: '精简与去 AI 味', prompt: SCIENTIFIC_STYLE + '本轮重点：压缩重复与空话，使用具体主语和动词，不按词语黑名单机械替换，不删除独立信息。' },
  { id: 'logic', title: '句式与逻辑衔接', prompt: SCIENTIFIC_STYLE + '本轮重点：调整句式与信息顺序，使论点、证据和解释衔接自然，不更改因果关系或论证强度。' },
  { id: 'evidence', title: '证据与科学措辞', prompt: SCIENTIFIC_STYLE + '本轮重点：核对量化表述、比较基准、适用范围和证据强度。没有直接支持的文献不列为依据，疑点列在说明中。' },
];
export const DEFAULT_REVISION_PROMPT = PROMPT_TEMPLATES[0].prompt;

// Review methods consulted when writing the Workbench prompts:
// https://github.com/K-Dense-AI/scientific-agent-skills/blob/main/skills/peer-review/SKILL.md
// https://github.com/SakanaAI/AI-Scientist/blob/main/ai_scientist/perform_review.py
export const MANUSCRIPT_REVISION_GUIDANCE = [
  '以作者投稿前完善稿件为目标。先找出已经成立、最值得发表的贡献和直接证据，围绕它组织正文。若原来的主张过宽，从有依据的结果中重建主线。局部问题按其实际影响处理，保留已有证据支撑的工作。',
  MANUSCRIPT_SECTION_RULE,
  '优先使用稿件、图表、附录和本轮材料中实际可核验的数据、方法细节与文献，让正文具体而饱满。说明每项补入证据的出处及适用范围，区分本研究的结果与外部文献的发现，禁止编造数字、实验、引文或出处。',
  '资料不足时，先用现有证据把主张写到成立的范围，给出能用的表述。只有具体缺项实质影响核心结论、且无法用现有材料或收窄表述处理时，才单独列出最小核对事项。保留影响理解的真实局限、反向结果和不确定性。',
  scientificVoice,
].join('\n');
export const MANUSCRIPT_REVIEW_GUIDANCE = MANUSCRIPT_REVISION_GUIDANCE + '\n每条审阅建议引用所在段落的连续原句，说明这段能更好地讲清什么，并给出现在就能执行的改法，例如可采用的句式、调整后的段落顺序，或可补入的具体证据及其位置。';

export const MANUSCRIPT_REVIEW_TEMPLATES = [
  {
    id: 'overview', title: '综合审阅（默认）',
    focus: [
      '概括本节回答的问题、最有分量的发现及其出处。明确研究成果对哪些读者有用，这个价值如何由现有结果建立。先让读者看见稿件已经完成的工作。',
      '检查摘要、引言和结论是否围绕同一项贡献，方法中的对象、条件和比较基准能否接到结果。指出结果部分内部应优先呈现的发现、可以写得更具体的句子，以及可用可追溯证据替换的空泛概括。',
      '若某个主张承担了超过证据范围的任务，给出更准确的替换表述，并指出稿件还能围绕哪条已经成立的发现展开。',
    ],
  },
  {
    id: 'argument', title: '论证与章节结构',
    focus: [
      '先确定本节要让读者明白的一件事。按本节的职责安排段落，指出关键信息的位置、需要补过渡的段落和可引用的已有定义。',
      '针对论证跳步或重点被细节淹没的地方，给出章节内的前移、合并或拆分方案。说清段首可怎样起笔、哪句需要承接下节。范围有限的小问题在本段解决。',
      '跨节建议给出已有依据和实施顺序，保留各段的独立信息。研究过程中的重复交代可以压缩，把位置留给影响结论的条件和结果。',
    ],
  },
  {
    id: 'methods', title: '方法与可复现性',
    focus: [
      '从实际结果反查它依赖的样本、数据来源、预处理、指标和计算步骤。找出已有但分散在正文、图注或附录里的方法细节，按输入、处理和输出组织成读者能跟做的叙述。',
      '把可核验的纳排条件、分母、单位、时空尺度、阈值、参数或版本补到第一次需要它的地方。研究设计适用时，再核对缺失值、混杂、数据划分和验证边界，指出会受影响的那项估计。',
      '先用现有的方法记录澄清口径，或让结果表述与实际方法对齐。给出具体改写及出处。只有影响核心结果且仍无法核对的步骤才交给作者确认。',
    ],
  },
  {
    id: 'results', title: '结果与证据强度',
    focus: [
      '挑出最能支撑论文主张的现有结果。在结果部分首次报告相关发现时写清方向、数值、比较基准、分母、单位和适用范围，指出可补入的现有数值或图表单元及其出处。',
      '有完整输入时复算支撑主张的比例、差值或换算，并写出依据。结合已有的效应量、区间、误差条和检验解释结果，明确哪些差异在研究情境下值得关注。保留影响判断的反向或不确定结果。',
      '描述、关联、预测和因果各按实际设计措辞。若原结论超出证据，就用准确的范围与动词把它改成可直接采用的结果句，避免因局部差异放弃可成立的主要发现。',
    ],
  },
  {
    id: 'discussion', title: '贡献与讨论',
    focus: [
      '从已经完成的数据、方法或实证结果里，选出最值得在投稿时重点呈现的贡献。说明它在哪个问题、场景或条件下有用，用实际对照或已核验的相关工作写清推进了什么。',
      '用已有结果解释一个有意义的发现或权衡。已检验的机制写明支持结果，合理解释写明推断依据。不同研究之间的差别先回到对象、尺度、时间和统计口径，给出合乎材料的解释。',
      '把泛泛的意义陈述改成具体发现及其用途。用必要的范围限定交代结论对哪些对象仍成立，保留会影响主要解释的真实局限。对优先权和新颖性只写当前材料能支持的程度。',
    ],
  },
  {
    id: 'terminology', title: '术语与学术表达',
    focus: [
      '核对正文、图表、公式和摘要里同一指标的定义、缩写、符号、单位和统计口径。建议一个能沿用全文的写法，并指出首次定义和需要同步修改的原句。',
      '把指代不明和对象省略的句子改成主语清楚、比较范围明确的句子。使用稿件已有的分母、时间范围或术语定义补足必要信息。百分比、百分点、效应大小和统计显著按各自含义准确表述。',
      '给出符合作者语域的具体句式。优先修改会妨碍理解和传达贡献的表达，保留原文通顺句和专业术语。',
    ],
  },
  {
    id: 'references', title: '图表与引文对应',
    focus: [
      '从已有图表和附录中选取符合本节职责的材料，指出图表号、面板或行列。方法部分可利用示意图和附录澄清流程，结果部分可补入可核验的数值和比较，并写清单位、样本、分母和适用范围。',
      '用正文带读者看图表中与论文贡献直接相关的信息。能从现有方法或图注补足的轴、误差线、分组和缩写释义，给出具体补法和出处。',
      '引文用于支撑能从已读原文核实的主张。题录用于核准作者、年份和编号。需要核实原文时，先缩窄正文表述，并指出哪项主张还需核对。已确证的引用放回它实际支持的句子。',
    ],
  },
].map(({ id, title, focus }) => ({ id, title, prompt: [...focus, '', MANUSCRIPT_REVIEW_GUIDANCE].join('\n') }));
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
