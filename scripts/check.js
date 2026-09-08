import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const extensions = new Set(['.js', '.mjs', '.cjs']);

async function sourceFiles(directory) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      files.push(...await sourceFiles(path));
    } else if (entry.isFile() && extensions.has(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

const files = (await Promise.all(['src', 'public', 'scripts'].map((name) => sourceFiles(join(root, name))))).flat();
let failed = false;
for (const path of files) {
  const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
  if (result.error) console.error(`Cannot check ${relative(root, path)}: ${result.error.message}`);
  if (result.error || result.status !== 0) failed = true;
}
console.log(`${failed ? 'Failed' : 'Passed'} syntax checks for ${files.length} JavaScript files.`);
process.exitCode = failed ? 1 : 0;
