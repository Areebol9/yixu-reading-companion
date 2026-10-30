'use strict';
const {spawnSync, spawn} = require('node:child_process');
const {existsSync} = require('node:fs');
const {createHash} = require('node:crypto');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
function runNode(args) {
  const result = spawnSync(process.execPath, args, {cwd: root, stdio: 'inherit', windowsHide: true});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
try {
  const childEnv = {...process.env, YIXU_NODE_EXE: process.execPath};
  if (!childEnv.YIXU_DATA_DIR) {
    const base = childEnv.LOCALAPPDATA || childEnv.APPDATA;
    if (!base) throw Error('请使用 YIXU_DATA_DIR 指定可写的开发数据目录。');
    const identity = createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 12);
    childEnv.YIXU_DATA_DIR = path.join(base, 'YixuReading', 'Development', identity);
  }
  if (process.env.YIXU_CORE_SOURCE) {
    runNode([path.join(root, 'scripts', 'sync-client-core.mjs'), '--source', process.env.YIXU_CORE_SOURCE, '--apply']);
  }
  const npmCLI = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(npmCLI)) throw Error('请通过 npm run desktop:dev 启动开发模式。');
  runNode([npmCLI, 'run', 'build']);
  const electron = require('electron');
  const child = spawn(electron, [root, '--developer'], {cwd: root, stdio: 'inherit', windowsHide: true, env: childEnv});
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
} catch (error) {
  console.error('开发客户端启动未完成：' + error.message);
  process.exitCode = 1;
}
