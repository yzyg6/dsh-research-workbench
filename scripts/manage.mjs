import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ProjectStore } from '../src/server/store.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const store = new ProjectStore({ root: join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'workbenches/research'), sampleRoot: join(root, 'samples/figure') });
try {
  let state = await store.state();
  if (process.argv.includes('--demo-if-empty') && !state.projects.length) {
    await store.createDemo({ directory: join(root, 'workspace/projects') });
    state = await store.state();
  }
  console.log(JSON.stringify({ metadataRoot: store.root, projects: state.projects.map((project) => ({ id: project.id, title: project.title, rootPath: project.rootPath, bindings: project.bindings })) }, null, 2));
} finally { await store.close(); }
