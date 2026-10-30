import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {startClientAgentControl} from '../scripts/client-agent-control.mjs';
import {createLocalBridge} from '../scripts/local-bridge.mjs';
import {companionCoordinator} from '../scripts/companion-host/registry.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.YIXU_PORT ?? 0);
const coordinator = companionCoordinator(root);
const server = createLocalBridge({port, workspaceRoot: root, distRoot: resolve(root, 'dist'), defaultDocument: 'workbench.html'});
let stopping = false, startupFailed = false, agentControl;
const nativeRequests = new Map();
const send = value => { if (process.connected) process.send(value); };
server.once('error', error => { startupFailed = !server.listening; send({type: 'fatal', message: error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用；原服务保持。请关闭属于本客户端的旧入口，或设置 YIXU_PORT。` : error.message}); process.exitCode = 1; });
function nativeControl(action, data) {
  if (!process.connected) return Promise.reject(Error('桌面父进程连接不可用。'));
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { nativeRequests.delete(id); reject(Error('原生窗口操作暂未返回。')); }, action === 'start-auto-reading' ? 120000 : 15000);
    nativeRequests.set(id, {resolve, reject, timer});
    send({type: 'native-control', id, action, data});
  });
}
server.listen(port, '127.0.0.1', async () => {
  try {
    const pageOrigin = `http://127.0.0.1:${server.address().port}`;
    agentControl = await startClientAgentControl({dataRoot: process.env.YIXU_CLIENT_DATA_ROOT, coordinator, pageOrigin, nativeControl});
    send({type: 'ready', url: pageOrigin + '/workbench.html'});
  } catch (error) { startupFailed = true; send({type: 'fatal', message: error.message}); process.exitCode = 1; }
});
async function control(action) {
  if (action === 'status') return {...await coordinator.ownedHosts(), stopping, startupFailed};
  if (action === 'pause') return await coordinator.pauseOwned();
  if (action === 'shutdown') {
    if (stopping) throw Error('正在保存并退出，请等待当前操作完成。');
    stopping = true;
    try {
      const result = await coordinator.shutdownOwned();
      await agentControl?.close();
      await new Promise((done, reject) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : done()));
      // A failed bind never started this server. Controlled cleanup still succeeds.
      process.exitCode = 0;
      return result;
    } catch (error) { stopping = false; throw error; }
  }
  throw Error('未知桌面命令。');
}
process.on('message', async message => {
  if (message?.type === 'native-response') {
    const pending = nativeRequests.get(message.id); if (!pending) return;
    nativeRequests.delete(message.id); clearTimeout(pending.timer);
    message.error ? pending.reject(Error(message.error)) : pending.resolve(message.value); return;
  }
  if (!message || message.type !== 'control' || typeof message.id !== 'string') return;
  try {
    const value = await control(message.action);
    send({type: 'response', id: message.id, value});
    if (message.action === 'shutdown') process.disconnect();
  } catch (error) { send({type: 'response', id: message.id, error: error.message}); }
});
process.once('disconnect', () => {
  if (!stopping) control('shutdown').catch(error => { console.error('保存退出未完成：' + error.message); process.exitCode = 1; });
});
