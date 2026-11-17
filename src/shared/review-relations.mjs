export const REVIEW_DEGREES = {
  wording: '措辞调整',
  structure: '结构调整',
  meaning: '科学含义',
};

export const REVIEW_RELATION_LABELS = {
  before: '先修改',
  together: '同步检查',
};

export function reviewDegree(item) {
  if (Object.hasOwn(REVIEW_DEGREES, item.kind)) return { kind: item.kind, estimated: false };
  const action = item.suggestion || item.steps || '';
  const technical = /(?:重新计算|重算|重估|重新分析|补做|敏感性分析|补充实验|补充数据|新增数据|核实数值|核对数值|统一单位|修正单位|修正数值|更正数值|重新定义|改变结论|限定结论|收窄结论|因果推断)/;
  const structure = /(?:调整顺序|重排|前移|后移|移至|移到|单列|另列|拆分|合并|衔接|过渡|分为.{0,12}段|补充.{0,8}定义|梳理.{0,6}论证)/;
  if (technical.test(action)) return { kind: 'meaning', estimated: true };
  if (item.scope === 'chapter' || structure.test(action)) return { kind: 'structure', estimated: true };
  if (/(?:措辞|改写|改为|替换|术语|缩写|表述|明确|精简|删除|表明|补充说明)/.test(action)) return { kind: 'wording', estimated: true };
  return { kind: null, estimated: true };
}

export function reviewConnections(focusId, findings, plan, relations) {
  const nodes = new Map(findings.map(item => [item.id, item]));
  const focus = nodes.get(focusId);
  if (!focus) return { before: [], after: [], together: [], groups: [] };
  const before = [], after = [], together = [];
  for (const { from, to, kind, reason } of relations || []) {
    if (from === to || (from !== focusId && to !== focusId)) continue;
    const node = nodes.get(from === focusId ? to : from);
    if (!node || !Object.hasOwn(REVIEW_RELATION_LABELS, kind)) continue;
    const edge = { node, reason };
    if (kind === 'together') together.push(edge);
    else if (to === focusId) before.push(edge);
    else after.push(edge);
  }
  const groups = (plan || []).filter(group => group.findings.includes(focusId)).map(group => ({
    step: group.step,
    nodes: [...new Set(group.findings)].filter(id => id !== focusId).map(id => nodes.get(id)).filter(Boolean),
  })).filter(group => group.nodes.length);
  return { before, after, together, groups };
}
