import { isNative, nativeCall } from './bridge.ts';
import { RemoteApplication } from './remote-application.ts';
import type { ApplicationClient } from '../core/application-contract.ts';
import type { ApplicationFrame, ApplicationResult } from '../core/application-wire.ts';
import type { StartupRecovery } from '../core/startup.ts';

type Connection = { needsMigration: boolean; frame?: ApplicationFrame; recovery?: StartupRecovery };
async function connectNative() {
  let client: RemoteApplication | undefined, latest: ApplicationFrame | undefined;
  window.yixuNativeEvent = (name, raw) => {
    try {
      const value = JSON.parse(raw);
      if (name === 'applicationFrame') { latest = value; client?.receive(value); }
      if (name === 'applicationResult') client?.result(value as ApplicationResult);
      if (name === 'applicationFailure') client?.fail(value.message);
    } catch (error) { client?.fail((error as Error).message); }
  };
  let connected = await nativeCall<Connection>('applicationConnect');
  if (connected.needsMigration) {
    if (localStorage.getItem('yixu-native-owner-v1')) throw new Error('原生资料暂不可用，已停止自动导入旧副本。请保留当前数据并检查备份。');
    const { LocalStore } = await import('./storage.ts');
    const legacy = await new LocalStore().load();
    connected = await nativeCall<Connection>('applicationInitialize', { state: legacy ?? null });
  }
  if (!connected.frame) throw new Error('共读核心没有提供可用记录');
  localStorage.setItem('yixu-native-owner-v1', 'true');
  const frame = latest?.epoch === connected.frame.epoch && latest.snapshot.revision > connected.frame.snapshot.revision ? latest : connected.frame;
  client = new RemoteApplication(frame, request => {
    if (!window.YixuNative) throw new Error('设备通信已断开');
    window.YixuNative.request(request.id, 'applicationCommand', JSON.stringify(request));
  }, (epoch, sequence) => { void nativeCall('applicationAck', { epoch, sequence }).catch(() => {}); });
  return { application: client as ApplicationClient, startupRecovery: connected.recovery ?? { changed: false, questions: 0, temporaryQuestions: 0, unknownCalls: 0 } };
}

async function initialize() {
  try { return isNative() ? await connectNative() : await import('./desktop-runtime.ts'); }
  catch (error) {
    const root = document.getElementById('root');
    if (root) {
      const panel = document.createElement('div'); panel.style.cssText = 'padding:48px 24px;line-height:1.8;color:#222';
      const heading = document.createElement('h2'); heading.textContent = '暂时无法打开共读记录';
      const detail = document.createElement('p'); detail.textContent = (error as Error).message;
      const retry = document.createElement('button'); retry.textContent = '重新连接'; retry.onclick = () => location.reload();
      panel.append(heading, detail, retry); root.replaceChildren(panel);
    }
    throw error;
  }
}
const initialized = await initialize();
export const application = initialized.application;
export const startupRecovery = initialized.startupRecovery;
