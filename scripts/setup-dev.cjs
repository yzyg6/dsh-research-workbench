const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
for (const [name, prefix] of [['ui-deps', 'build'], ['editor-deps', 'editor']]) {
  const cwd = path.join(root, '_scratch/tmp', name);
  fs.mkdirSync(cwd, { recursive: true });
  fs.copyFileSync(path.join(__dirname, `${prefix}-dependencies.json`), path.join(cwd, 'package.json'));
  fs.copyFileSync(path.join(__dirname, `${prefix}-package-lock.json`), path.join(cwd, 'package-lock.json'));
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci'], { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
