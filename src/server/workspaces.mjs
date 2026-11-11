import {resolve} from 'node:path';
const resolving=new WeakMap();
/** Coalesce registry creation for concurrent file conversations in one paper. */
export function resolveProjectWorkspace(registry,project){
  let pending=resolving.get(registry);if(!pending){pending=new Map();resolving.set(registry,pending)}
  const key=process.platform==='win32'?resolve(project.root_path).toLowerCase():resolve(project.root_path);
  if(!pending.has(key)){const operation=(async()=>await registry.resolveByPath(project.root_path)||await registry.create(project.root_path,project.title))();pending.set(key,operation);void operation.finally(()=>{if(pending.get(key)===operation)pending.delete(key)}).catch(()=>{})}
  return pending.get(key);
}
/** Attach only this plugin's bound sessions, preserving native ids and drafts. */
export async function installProjectWorkspaces(ctx, runtime, onStatus = () => {}) {
  const registry = ctx.workspaceRegistry;
  let stopped = false;
  let tail = Promise.resolve();
  const sync = () => {
    const operation = tail.then(async () => {
      if (stopped) return;
      const projects = runtime.store.db.prepare("SELECT p.id,p.title,p.root_path FROM projects p WHERE NOT EXISTS (SELECT 1 FROM preferences WHERE key='removedProject:'||p.id)").all();
      const bindings = [...runtime.store.db.prepare('SELECT project_id,session_id FROM bindings').all(), ...(runtime.nativeWriting?.sessions() || []),...(runtime.wordFormatting?.sessions()||[])];
      let attached = 0;
      const failedProjects = [];
      for (const project of projects) {
        const owned = bindings.filter((binding) => binding.project_id === project.id);
        if (!owned.length) continue;
        try {
          const workspace = await resolveProjectWorkspace(registry,project);
          for (const binding of owned) {
            // Native registry validates stored cwd before attachment. Never move
            // unrelated sessions or change a session's working directory.
            if (!workspace.sessionIds.includes(binding.session_id)) await workspace.attachSession(binding.session_id);
            attached++;
          }
        } catch { failedProjects.push(project.id); }
      }
      runtime.integrations.nativeWorkspaces = { status: failedProjects.length ? 'partial' : 'ready', attachedSessions: attached, failedProjects };
      onStatus();
    });
    tail = operation.catch(() => { runtime.integrations.nativeWorkspaces = { status: 'unavailable' }; onStatus(); });
    return tail;
  };
  const off = runtime.onMutation(() => void sync());
  ctx.effect(() => () => { stopped = true; off(); return tail; }, 'research-workbench: owned workspace membership');
  await sync();
  return sync;
}
