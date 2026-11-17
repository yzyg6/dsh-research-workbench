import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = join(root, '_scratch/out/startup-ui-tests'); await mkdir(out, { recursive: true });
const require = createRequire(join(root, '_scratch/tmp/ui-deps/package.json'));
const React = require('react'), { create, act } = require('react-test-renderer');
const reactPath = require.resolve('react'), file = join(out, 'app.cjs');
require('esbuild').buildSync({ entryPoints: [join(root, 'src/client/App.jsx')], outfile: file, bundle: true, platform: 'node', format: 'cjs', loader: { '.css': 'text' }, alias: { react: reactPath }, external: [reactPath], nodePaths: [join(root, '_scratch/tmp/ui-deps/node_modules'), join(root, '_scratch/tmp/editor-deps/node_modules')], logLevel: 'silent' });
const { App } = require(file);
function environment(t) {
  const previous = Object.fromEntries(['window', 'document', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const values = new Map(); let writes = 0;
  Object.assign(globalThis, { window: new EventTarget(), document: Object.assign(new EventTarget(), { visibilityState: 'visible' }), localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => { writes++; values.set(key, value); } }, IS_REACT_ACT_ENVIRONMENT: true });
  t.after(() => { for (const [key, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  return () => writes;
}

test('failed startup offers an in-page retry and a successful retry clears the connection error', async t => {
  environment(t); let attempts = 0, signal, renderer;
  const api = { async bootstrap(options) { signal = options.signal; if (++attempts === 1) throw Error('合成连接中断'); return { projects: [], activeProjectId: null }; } };
  try {
    await act(async () => { renderer = create(React.createElement(App, { api })); });
    assert(JSON.stringify(renderer.toJSON()).includes('合成连接中断'));
    const retry = renderer.root.findAllByType('button').find(button => button.children.includes('重新连接'));
    assert(retry);
    const originalSignal = signal;
    await act(async () => { retry.props.onClick(); });
    assert.equal(attempts, 2); assert.equal(originalSignal.aborted, true);
    assert(!JSON.stringify(renderer.toJSON()).includes('合成连接中断'));
    assert(!renderer.root.findAllByType('button').some(button => button.children.includes('重新连接')));
  } finally { if (renderer) await act(async () => renderer.unmount()); }
  assert.equal(signal.aborted, true);
});

test('a late startup response after closing the panel cannot overwrite the draft recovery cache', async t => {
  const writes = environment(t); let finish, signal, renderer;
  const api = { bootstrap(options) { signal = options.signal; return new Promise(resolve => { finish = resolve; }); } };
  await act(async () => { renderer = create(React.createElement(App, { api })); });
  await act(async () => renderer.unmount());
  const before = writes();
  await act(async () => { finish({ projects: [], activeProjectId: null }); });
  assert.equal(signal.aborted, true); assert.equal(writes(), before);
});
