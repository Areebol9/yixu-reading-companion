import {readFile, writeFile, mkdir, copyFile, access} from 'node:fs/promises';
import {resolve, dirname, relative, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

// A reviewed, explicit manifest is the only source of files. No directory mirror.
const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const target = resolve(option('--target') ?? here);
const sourceArg = option('--source');
if (!sourceArg) throw Error('请用 --source 指定共享核心研发目录。');
const source = resolve(sourceArg);
if (source === target) throw Error('研发来源与客户端目标须为不同目录。');
const manifestFile = resolve(target, 'client-core-manifest.json');
const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
if (manifest.schema !== 'yixu-client-core-v1' || !Array.isArray(manifest.files)) throw Error('共享核心清单无效。');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function bytes(file) { try { return await readFile(file); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } }
function inside(root, name) {
  const file = resolve(root, name), path = relative(root, file);
  if (!path || path.startsWith('..') || isAbsolute(path) || name.includes('\\')) throw Error('清单路径超出工程目录。');
  return file;
}
const changes = [], conflicts = [];
for (const entry of manifest.files) {
  const input = inside(source, entry.path), output = inside(target, entry.path);
  const current = await bytes(output), next = await readFile(input);
  const currentHash = current ? hash(current) : null, sourceHash = hash(next);
  if (currentHash === sourceHash) continue;
  if (currentHash !== entry.sha256) { conflicts.push(entry.path); continue; }
  changes.push({entry, input, output, next, current, sourceHash});
}
if (conflicts.length) throw Error('客户端共享文件有本地修改，未覆盖：\n' + conflicts.join('\n'));
console.log(JSON.stringify({mode: args.includes('--apply') ? 'apply' : 'check', changed: changes.map(item => item.entry.path)}, null, 2));
if (args.includes('--apply')) {
  const backup = resolve(target, '.local/core-sync-backups', new Date().toISOString().replace(/[:.]/g, '-'));
  for (const item of changes) {
    if (item.current) { const file = inside(backup, item.entry.path); await mkdir(dirname(file), {recursive: true}); await writeFile(file, item.current, {flag:'wx'}); }
    await mkdir(dirname(item.output), {recursive: true});
    await writeFile(item.output, item.next);
    item.entry.sha256 = item.sourceHash;
  }
  // Also record files already identical, including previously absent entries.
  for (const entry of manifest.files) entry.sha256 = hash(await readFile(inside(target, entry.path)));
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
}
