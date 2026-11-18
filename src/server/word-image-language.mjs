import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const detector = fileURLToPath(new URL('./word-image-language.ps1', import.meta.url));

export async function translationImageStates(word, projectId, path, images, signal) {
  if (!images.length) return {};
  const states = {};
  let directory;
  try {
    directory = await mkdtemp(join(dirname(await word.temporary(projectId)), 'scan-'));
    const { files } = await word.inspect({ path, translation:{ images, directory } });
    const raster = [];
    for (const file of files) {
      if (file.path.endsWith('.svg')) {
        const svg = await readFile(file.path, 'utf8');
        const labels = [...svg.matchAll(/<(?:text|title|desc)\b[^>]*>([\s\S]*?)<\/(?:text|title|desc)>/gi)].map(item => item[1].replace(/<[^>]*>/g, ''));
        if (labels.length) states[file.part] = labels.some(text => /\p{Script=Han}/u.test(text)) ? 'chinese' : 'clear';
      } else raster.push(file);
    }
    if (raster.length && process.platform === 'win32') {
      const manifest = join(directory, 'images.json');
      await writeFile(manifest, JSON.stringify(raster), 'utf8');
      const result = await run('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',detector,manifest], {
        windowsHide:true, timeout:45000, maxBuffer:128 * 1024, signal,
      });
      const checked = JSON.parse(result.stdout);
      for (const { part } of raster) if (['chinese','clear'].includes(checked[part])) states[part] = checked[part];
    }
  } catch { signal.throwIfAborted(); /* Unsupported images remain marked for visual checking. */ }
  finally {
    if (directory) {
      for (const name of await readdir(directory).catch(() => [])) await unlink(join(directory, name)).catch(() => {});
      await rmdir(directory).catch(() => {});
    }
  }
  return states;
}
