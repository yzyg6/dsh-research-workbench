const STORAGE_KEY = 'dsh-research-workbench:document-positions:v1';

function records() {
  const saved = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) || '[]');
  return Array.isArray(saved) ? saved : [];
}

export function readDocumentPosition(project, object, view) {
  if (!object) return null;
  try {
    return records().find(entry => entry.projectId === project.id && entry.objectId === object.id && entry.view === view && entry.revision === object.revision)?.position ?? null;
  } catch { return null; }
}

export function rememberDocumentPosition(project, object, view, position) {
  if (!object) return;
  try {
    const entries = records().filter(entry => entry.projectId !== project.id || entry.objectId !== object.id || entry.view !== view);
    entries.unshift({ projectId: project.id, objectId: object.id, revision: object.revision, view, position });
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, 60)));
  } catch { /* A disabled local store must not interrupt editing. */ }
}
