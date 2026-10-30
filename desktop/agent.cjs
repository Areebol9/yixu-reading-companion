'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {randomUUID, createHash} = require('node:crypto');
const {pipeline} = require('node:stream/promises');
const {Readable, Transform} = require('node:stream');
const {clientPaths} = require('./runtime.cjs');
const root = path.resolve(__dirname, '..');
const raw = process.argv.slice(2);
const options = {}, positional = [];
const booleanOptions = new Set(['headless', 'show', 'developer']);
const valueOptions = new Set(['data-dir', 'json', 'command-id', 'archive-id', 'epoch', 'file', 'kind', 'timeout', 'book-id', 'title']);
let context = {};
function parse() {
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item.startsWith('--')) { positional.push(item); continue; }
    const name = item.slice(2);
    if (booleanOptions.has(name)) options[name] = true;
    else if (valueOptions.has(name) && raw[i + 1] !== undefined && !raw[i + 1].startsWith('--')) options[name] = raw[++i];
    else throw Error('未知参数或缺少参数值：' + item);
  }
}
const safe = (key, value) => /^(token|apiKey|authorization|password|secret)$/i.test(key) ? '[redacted]' : value;
const print = value => process.stdout.write(JSON.stringify(value, safe) + '\n');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function fail(message, details = {}) { const error = Error(message); Object.assign(error, details); return error; }
async function main() {
  parse();
  if (options['data-dir']) process.env.YIXU_DATA_DIR = path.resolve(options['data-dir']);
  const config = clientPaths(root);
  const discoveryFile = path.join(config.dataRoot, 'agent-connection.json');
  const timeout = options.timeout === undefined ? 120000 : Number(options.timeout);
  if (!Number.isSafeInteger(timeout) || timeout < 1000) throw Error('--timeout 需为至少1000的毫秒数。');
  async function discovery() {
    let value;
    try { value = JSON.parse(await fsp.readFile(discoveryFile, 'utf8')); }
    catch (error) { throw fail('客户端认证入口尚未就绪，请先执行 start --headless。', {code: 'NOT_READY'}); }
    let url;
    try { url = new URL(value.url); } catch { throw Error('客户端认证入口格式无效。'); }
    if (value.schema !== 'yixu-desktop-agent-v1' || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || !/^[a-f0-9]{64}$/i.test(value.token) || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.instanceId !== 'string') throw Error('客户端认证入口身份无效。');
    return value;
  }
  async function request(input, connection, requestTimeout = timeout) {
    const current = connection ?? await discovery();
    let response;
    try { response = await fetch(new URL('/api/desktop-agent', current.url), {method: 'POST', headers: {Authorization: 'Bearer ' + current.token, 'X-Yixu-Client': 'local-agent', 'Content-Type': 'application/json'}, body: JSON.stringify(input), signal: AbortSignal.timeout(requestTimeout)}); }
    catch { throw fail('客户端连接中断或等待超时。请用原操作编号查询结果，避免重复执行。', {code: 'CONNECTION_UNAVAILABLE', dispatch: input.action === 'command' ? 'unknown' : undefined}); }
    let value;
    try { value = await response.json(); } catch { throw fail('客户端返回的操作结果不完整，请用原操作编号查询进度。', {code: 'CONNECTION_UNAVAILABLE', dispatch: input.action === 'command' ? 'unknown' : undefined}); }
    // Read-only status payloads include the application's current business error.
    // HTTP failures still report transport/control errors for every action.
    const readableStatus = ['status', 'snapshot'].includes(input.action) && value.schema === `yixu-desktop-agent-${input.action}-v1`;
    if (!response.ok || (value.error && !readableStatus)) throw fail(value.error || '客户端操作未完成。', {code: value.code, dispatch: value.dispatch, response: value});
    return value;
  }
  async function identity() {
    const value = await request({action: 'status'});
    const {archiveId, epoch} = value.connection ?? {};
    if (!archiveId || !epoch) throw Error('当前阅读存档正在准备，请稍后再操作。');
    return {archiveId, epoch};
  }
  async function command(name, args) {
    const target = await identity();
    const commandId = options['command-id'] || randomUUID();
    context = {...target, commandId};
    const receipt = await request({action: 'command', ...target, commandId, name, args});
    return {...target, commandId, ...receipt};
  }
  async function waitReceipt(accepted) {
    let value = accepted;
    const deadline = Date.now() + timeout;
    while (value.state === 'accepted' || value.state === 'running') {
      if (Date.now() >= deadline) throw fail('原操作仍在处理中，请保留commandId并查询operation；未重新提交。', {dispatch: 'accepted'});
      await sleep(150);
      value = await request({action: 'operation', archiveId: accepted.archiveId, epoch: accepted.epoch, commandId: accepted.commandId});
    }
    if (value.state !== 'complete' || !value.receipt) throw Error('暂时无法取得这次操作的结果，请查询原操作进度。');
    if (value.receipt.error) throw Error(value.receipt.error);
    return value.receipt.value;
  }
  const action = positional[0];
  if (!action || action === 'help') return {ok: true, commands: ['start --headless [--developer]', 'status', 'snapshot', 'auto-read --json <settings>', 'command <name> --json "<args array>"', 'operation <commandId> --archive-id <id> --epoch <epoch>', 'import <path> [--kind text|backup]', 'extend-source <path> --book-id <id> [--title <title>]', 'export --file <path> [--kind backup|record]', 'pause', 'open', 'hide', 'quit'], options: {dataDirectory: '--data-dir <path>', timeoutMilliseconds: '--timeout <ms>'}};
  if (action === 'start') {
    try {
      const existing = await request({action: 'status'}, undefined, Math.min(timeout, 5000));
      if (options.developer && !existing.nativeState?.developerMode) throw Error('当前实例为普通模式。请先正常退出，或用另一明确数据目录启动开发者模式。');
      if (options.show) await request({action: 'open'});
      return {ok: true, reused: true, ...existing};
    } catch (error) { if (!['NOT_READY', 'CONNECTION_UNAVAILABLE'].includes(error.code)) throw error; }
    const electron = ['runtime/electron/Yixu Reading Companion.exe', 'runtime/electron/electron.exe', 'node_modules/electron/dist/electron.exe'].map(relative => path.join(root, relative)).find(filename => fs.existsSync(filename));
    if (!electron) throw Error('未找到完整Electron运行时。');
    if (!fs.existsSync(path.join(root, 'dist/workbench.html'))) throw Error('阅读界面尚未构建，请先运行 npm run build。');
    const logs = path.join(config.dataRoot, 'client-launcher'); await fsp.mkdir(logs, {recursive: true});
    const log = fs.openSync(path.join(logs, 'agent-launch.log'), 'a');
    let ended;
    const child = spawn(electron, [root, options.show ? '--show' : '--yixu-headless', ...(options.developer ? ['--developer'] : [])], {cwd: root, detached: true, windowsHide: false, stdio: ['ignore', log, log], env: {...process.env, YIXU_NODE_EXE: process.execPath}});
    fs.closeSync(log);
    child.once('error', error => { ended = {error: error.message}; });
    child.once('exit', (code, signal) => { ended = {code, signal}; });
    child.unref();
    const deadline = Date.now() + timeout;
    let lastError;
    while (Date.now() < deadline) {
      try { const value = await request({action: 'status'}, undefined, Math.max(1000, deadline - Date.now())); return {ok: true, reused: false, ...value}; }
      catch (error) { lastError = error; }
      if (ended) throw Error('客户端启动未完成，请查看数据目录内 client-launcher/agent-launch.log。');
      await sleep(200);
    }
    throw Error('客户端认证入口尚未就绪，请查看启动日志；本命令未重复启动。' + (lastError?.code ? ' ' + lastError.code : ''));
  }
  if (action === 'quit') {
    const original = await discovery();
    context = {instanceId: original.instanceId, pid: original.pid};
    const acknowledgement = await request({action: 'quit'}, original);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      let sameInstance = true;
      try { sameInstance = JSON.parse(await fsp.readFile(discoveryFile, 'utf8')).instanceId === original.instanceId; }
      catch (error) { if (error.code === 'ENOENT') sameInstance = false; }
      let running = true;
      try { process.kill(original.pid, 0); } catch (error) { if (error.code === 'ESRCH') running = false; }
      if (!sameInstance && !running) return {ok: true, ...context, ...acknowledgement, exited: true};
      await sleep(100);
    }
    throw fail('客户端正在等待已发出的回复并保存，完成后自动退出。请稍后查询退出状态。', {code: 'EXIT_PENDING', dispatch: 'accepted'});
  }
  if (['status', 'snapshot', 'pause', 'open', 'hide'].includes(action)) return {ok: true, ...await request({action})};
  if (action === 'auto-read') {
    const settings = JSON.parse(options.json ?? '{}');
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw Error('--json 必须为自动阅读设置对象。');
    return {ok: true, ...await request({action: 'auto-read', settings})};
  }
  if (action === 'command') {
    if (!positional[1]) throw Error('请提供要执行的命令名称。');
    const args = JSON.parse(options.json ?? '[]');
    if (!Array.isArray(args)) throw Error('--json 必须为参数数组。');
    return {ok: true, ...await command(positional[1], args)};
  }
  if (action === 'operation') {
    const commandId = positional[1] || options['command-id'];
    const archiveId = options['archive-id'], epoch = options.epoch;
    if (!commandId || !archiveId || !epoch) throw Error('查询操作结果需提供原commandId、--archive-id和--epoch。');
    context = {commandId, archiveId, epoch};
    return {ok: true, ...context, ...await request({action: 'operation', ...context})};
  }
  if (action === 'import' || action === 'extend-source') {
    if (!positional[1]) throw Error('请提供要导入的文件路径。');
    const filename = path.resolve(positional[1]), connection = await discovery(), target = await identity();
    const kind = action === 'extend-source' ? 'book-source' : options.kind || (/\.json$/i.test(filename) ? 'backup' : 'text');
    if (kind === 'book-source' && !/^[a-f0-9-]{36}$/i.test(options['book-id'] || '')) throw Error('接续原书需要 --book-id 指定当前作品。');
    if (!['backup', 'text', 'book-source'].includes(kind)) throw Error('--kind 只支持 text 或 backup。');
    const info = await fsp.stat(filename); if (!info.isFile()) throw Error('导入路径必须是普通文件。');
    context = {...target, importFile: filename};
    const url = new URL('/api/desktop-agent/import', connection.url);
    for (const [key, value] of Object.entries({...target, kind, name: path.basename(filename), ...(kind === 'book-source' ? {bookId: options['book-id'], ...(options.title ? {title: options.title} : {})} : {})})) url.searchParams.set(key, value);
    let response;
    try { response = await fetch(url, {method: 'POST', headers: {Authorization: 'Bearer ' + connection.token, 'X-Yixu-Client': 'local-agent', 'Content-Type': 'application/octet-stream'}, body: fs.createReadStream(filename), duplex: 'half', signal: AbortSignal.timeout(timeout)}); }
    catch { throw fail('导入连接中断，结果待核对；请查看当前存档与原导入记录，未自动重传。', {dispatch: 'unknown'}); }
    const value = await response.json();
    if (!response.ok || value.error) throw fail(value.error || '导入未完成。', {dispatch: value.dispatch, response: value});
    return {ok: true, ...target, ...value};
  }
  if (action === 'export') {
    if (!options.file) throw Error('请用 --file 指定新导出文件路径。');
    const kind = options.kind || 'backup';
    if (!['backup', 'record'].includes(kind)) throw Error('--kind 只支持 backup 或 record。');
    const filename = path.resolve(options.file);
    if (fs.existsSync(filename)) throw Error('目标文件已存在，请使用新的文件名以保留原件。');
    const accepted = await command(kind === 'backup' ? 'exportBackup' : 'exportSession', []);
    const result = await waitReceipt(accepted);
    if (!result?.download?.id) throw Error('原导出未返回完整下载文件。');
    const connection = await discovery(), url = new URL('/api/desktop-agent/download/' + encodeURIComponent(result.download.id), connection.url);
    url.searchParams.set('archiveId', accepted.archiveId); url.searchParams.set('epoch', accepted.epoch);
    const response = await fetch(url, {headers: {Authorization: 'Bearer ' + connection.token, 'X-Yixu-Client': 'local-agent'}, signal: AbortSignal.timeout(timeout)});
    if (!response.ok || !response.body) throw Error('已准备的导出文件暂不可下载，请保留原commandId查询；未重做导出。');
    await fsp.mkdir(path.dirname(filename), {recursive: true});
    const digest = createHash('sha256'); let bytes = 0;
    await pipeline(Readable.fromWeb(response.body), new Transform({transform(chunk, _encoding, done) { bytes += chunk.length; digest.update(chunk); done(null, chunk); }}), fs.createWriteStream(filename, {flags: 'wx', mode: 0o600}));
    const sha256 = digest.digest('hex'), expected = result.download.sha256 || response.headers.get('x-content-sha256');
    if (expected && sha256 !== expected) throw Error('导出文件摘要不符，已保留本次文件供核对；请勿作为完整备份使用。');
    return {ok: true, ...context, file: filename, bytes, sha256, downloadId: result.download.id};
  }
  throw Error('未知命令，请执行 help 查看可用命令。');
}
main().then(print).catch(error => { print({ok: false, ...context, error: error.message, ...(error.code ? {code: error.code} : {}), ...(error.dispatch ? {dispatch: error.dispatch} : {}), ...(error.response ? {response: error.response} : {})}); process.exitCode = 1; });
