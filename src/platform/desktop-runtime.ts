import { attachWebTools } from '../core/web-tools.ts';
import { ReadingRuntime, restoreReadingEngine } from '../core/runtime.ts';
import { ChatModel } from '../core/model.ts';
import { LocalStore } from './storage.ts';
import { hostCall, isNative, nativeCall } from './bridge.ts';
import { LocalApplication } from '../core/application.ts';
import { HarnessRuntime } from '../agent/runtime.ts';

const restored = await restoreReadingEngine(new LocalStore(), new ChatModel((request, signal) => hostCall('model', request, signal)));
const engine = restored.engine;
engine.agent = new HarnessRuntime();
export const startupRecovery = restored.recovery;
const runtime = new ReadingRuntime(engine, { available: isNative(), request: (method, payload) => nativeCall(method, payload) });
export const application = new LocalApplication(runtime, (method, payload) => hostCall(method, payload));

attachWebTools(engine, hostCall);

// Installed before React mounts and retained when the UI unsubscribes.
window.yixuNativeEvent = (name, raw) => {
  try { void runtime.receive(name, JSON.parse(raw)).catch(e => runtime.reportError(e)); }
  catch (error) { runtime.reportError(error); }
};
if (isNative()) void nativeCall<{ online: boolean }>('networkStatus').then(value => engine.setNetworkAvailable(value.online)).catch(() => {});
else engine.setNetworkAvailable(navigator.onLine);
window.addEventListener('online', () => engine.setNetworkAvailable(true));
window.addEventListener('offline', () => engine.setNetworkAvailable(false));
