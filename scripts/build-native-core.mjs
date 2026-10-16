import { mkdir, copyFile, readFile } from 'node:fs/promises';
import { buildNativeAgent } from './native-agent-build.mjs';
for (const name of ['core-js-pure','htmlparser2','entities','domhandler','domelementtype','domutils','dom-serializer']) {
  const pkg = JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8'));
  const target = `.local/native-license-assets/licenses/${name}-${pkg.version}`;
  await mkdir(target, { recursive: true });
  await copyFile(`node_modules/${name}/LICENSE`, `${target}/LICENSE`);
}
// Both entries now exercise the actual Harness and need the same QuickJS host
// lowering. Build production last so its existing license provenance remains
// the main entry, while each artifact retains its own build manifest.
await buildNativeAgent('src/native/probe.ts', '.local/native-probe-assets/core-probe.js', ['__yixuResolve','__yixuResolveValue','__yixuTimer']);
await buildNativeAgent('src/native/companion-probe.ts', '.local/native-probe-assets/core-companion-probe.js', ['__yixuResolve','__yixuResolveValue','__yixuTimer']);
await buildNativeAgent('src/native/reading-empty-probe.ts', '.local/native-probe-assets/core-reading-empty-probe.js', ['__yixuResolve','__yixuResolveValue','__yixuTimer']);
await buildNativeAgent('src/native/application-entry.ts', '.local/native-core-assets/reading-core.js', ['__applicationCommand', '__applicationAck', '__applicationEvent', '__applicationInitialize']);
