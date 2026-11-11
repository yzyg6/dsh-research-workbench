export const TASKS = ['writing', 'figure', 'reading'];
export const TASK_LABELS = { writing: '论文写作', figure: '数据与制图', reading: '文献阅读' };
export const PANES = ['main', 'context', 'chat'];
export function defaultLayout(task = 'writing') {
  return { order: ['main', 'context', 'chat'], weights: { main: 58, context: 20, chat: 32 }, collapsed: { context: task !== 'reading' }, maximized: null };
}
export function normalizeLayout(value, task = 'writing') {
  const fallback = defaultLayout(task);
  if (!value || typeof value !== 'object') return fallback;
  const order = Array.isArray(value.order) && value.order.length === 3 && new Set(value.order).size === 3 && value.order.every((key) => PANES.includes(key)) ? [...value.order] : fallback.order;
  const weights = Object.fromEntries(PANES.map((key) => [key, Number.isFinite(value.weights?.[key]) ? Math.max(15, Math.min(85, value.weights[key])) : fallback.weights[key]]));
  const collapsed = Object.fromEntries(PANES.map((key) => [key, typeof value.collapsed?.[key] === 'boolean' ? value.collapsed[key] : Boolean(fallback.collapsed[key])]));
  if (PANES.every((key) => collapsed[key])) collapsed.main = false;
  return { order, weights, collapsed, maximized: PANES.includes(value.maximized) && !collapsed[value.maximized] ? value.maximized : null };
}
export function defaultTaskState(task) {
  return { layout: defaultLayout(task), selectedObjectId: null, scrollTop: 0, cursor: 0, editMode: false };
}
export function objectForTask(project, task) {
  const selected = project.objects.find((object) => object.id === project.taskStates[task]?.value.selectedObjectId);
  return selected || project.objects.find((object) => object.kind === ({ writing: 'manuscript', figure: 'data', reading: 'note' })[task]) || project.objects[0] || null;
}
export function visiblePanes(layout) {
  return layout.maximized ? [layout.maximized] : layout.order.filter((key) => !layout.collapsed[key]);
}
