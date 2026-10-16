import { build } from 'vite';
import { readFile, writeFile, mkdir, copyFile, stat } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const vendor = resolve('third_party/deepseek-harness');
export async function buildNativeAgent(entry, output, entrypoints = []) {
  const manifest = JSON.parse(await readFile(join(vendor, 'manifest.json'), 'utf8'));
  for (const file of manifest.files) if (createHash('sha256').update(await readFile(join(vendor, file.path))).digest('hex') !== file.sha256) throw new Error('Agent compatibility source changed: ' + file.path);
  const adaptations = [];
  const bundle = async (entry, format) => {
    const result = await build({ configFile: false, logLevel: 'error', plugins: [{ name: 'quickjs-intrinsic-identity', transform(code, id) {
      if (!/dsh-(util-values|tools)\/lib\/index\.js$/.test(id.replaceAll('\\', '/'))) return;
      const before = 'Function.prototype.toString.call(constructor) === `function ${name}() { [native code] }`';
      if (code.split(before).length !== 2) throw new Error('Agent intrinsic adapter needs review: ' + id);
      adaptations.push({ file: id.replaceAll('\\', '/').split('/node_modules/').at(-1), sourceSha256: createHash('sha256').update(code).digest('hex'), reason: 'Use single-realm intrinsic identity instead of V8 formatting' });
      return { code: code.replace(before, '(constructor === Object || constructor === Array)'), map: null };
    } }], build: { target: 'es2022', minify: false, write: false, lib: { entry, formats: [format], name: 'YixuAgentHost' }, rolldownOptions: { external: id => id.startsWith('node:') } } });
    const chunks = (Array.isArray(result) ? result : [result]).flatMap(r => r.output).filter(c => c.type === 'chunk');
    if (chunks.length !== 1) throw new Error('Native core must remain a single bundled module');
    return chunks[0];
  };
  const compiler = await bundle('third_party/deepseek-harness/src/compile/transform.ts', 'es');
  await mkdir('.local/agent-compiler', { recursive: true });
  await writeFile('.local/agent-compiler/transform.mjs', compiler.code);
  const { lowerModuleSource } = await import(pathToFileURL(resolve('.local/agent-compiler/transform.mjs')).href);
  const bootstrap = await bundle('src/native/agent-bootstrap.mjs', 'iife');
  if (bootstrap.imports.length) throw new Error('Native bootstrap has unresolved modules');
  const program = await bundle(entry, 'es');
  const lowered = lowerModuleSource({ filename: entry, source: program.code });
  const allowed = ['node:path', 'node:module', 'node:fs', 'node:os', 'node:async_hooks', 'node:util/types', 'node:crypto', '../package.json'];
  if (!lowered.lowered || lowered.moduleRequests.some(name => !allowed.includes(name))) throw new Error('Native core introduced an undeclared module');
  const expose = entrypoints.length ? '\nfor(const name of ' + JSON.stringify(entrypoints) + '){const invoke=globalThis[name];if(typeof invoke!=="function")throw new Error("Missing native entry: "+name);globalThis[name]=(...args)=>globalThis.__yixuAgentRuntime.asyncHooks.runAtAsyncContextRoot(()=>invoke(...args));}\n' : '';
  const code = bootstrap.code + '\n(function(require,exports,__dsh$meta,__als){\n' + lowered.code + '\n})(globalThis.__yixuAgentRuntime.require,{},Object.freeze({url:"yixu-native-core"}),globalThis.__yixuAgentRuntime.als);\n' + expose;
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, code);
  const licenseRoot = '.local/native-license-assets/licenses/harness'; await mkdir(licenseRoot, { recursive: true });
  const packages = new Map();
  for (const id of [...Object.keys(bootstrap.modules), ...Object.keys(program.modules)]) {
    const file = resolve(id).replaceAll('\\', '/'), index = file.lastIndexOf('/node_modules/'); if (index < 0) continue;
    const parts = file.slice(index + 14).split('/'), name = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0], root = file.slice(0, index + 14) + name;
    packages.set(name, { root, version: JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version });
  }
  for (const [name, pkg] of packages) {
    let found;
    for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'LICENSE-MIT']) { try { if ((await stat(join(pkg.root, file))).isFile()) { found = file; break; } } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    if (!found) throw new Error('Missing license: ' + name);
    await copyFile(join(pkg.root, found), join(licenseRoot, name.replaceAll('/', '__') + '-' + pkg.version + '.txt'));
  }
  await copyFile(join(vendor, 'LICENSE'), join(licenseRoot, 'DeepSeek-compatibility.txt'));
  const record = { entry, output, upstreamCommit: manifest.commit, adaptations, packages: [...packages].map(([name, p]) => ({ name, version: p.version })), bytes: Buffer.byteLength(code), sha256: createHash('sha256').update(code).digest('hex'), hostModules: lowered.moduleRequests };
  await writeFile(output + '.build.json', JSON.stringify(record, null, 2));
  await writeFile(join(licenseRoot, 'provenance.json'), JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ nativeAgent: output, bytes: record.bytes, adaptations: adaptations.length }));
  return record;
}
