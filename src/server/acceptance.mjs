import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Opt-in local developer fixture. Absent in normal installations. */
export async function nativeAcceptancePlan(store) {
  let plan;
  try { plan = JSON.parse(await readFile(join(store.root, 'diagnostics/native-acceptance-plan.json'), 'utf8')); }
  catch { return null; }
  if (plan.schemaVersion !== 1 || !['seed', 'restore'].includes(plan.mode) || typeof plan.runId !== 'string' || !Array.isArray(plan.projects) || plan.projects.length !== 2) return null;
  if (new Set(plan.projects.map((project) => project.projectId)).size !== 2 || new Set(plan.projects.map((project) => project.role)).size !== 2) return null;
  const entries = [];
  for (const owner of plan.projects) {
    if (!['A', 'B'].includes(owner.role) || !store.db.prepare('SELECT id FROM projects WHERE id=?').get(owner.projectId)) return null;
    for (const [task, label] of [['writing', 'WRITE'], ['figure', 'FIGURE'], ['reading', 'READ']]) entries.push({ projectId: owner.projectId, task, marker: `RW-${owner.role}-${label}-20261109` });
  }
  return { runId: plan.runId, mode: plan.mode, entries };
}
