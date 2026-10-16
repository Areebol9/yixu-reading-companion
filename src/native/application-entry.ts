import { hostRequest } from './environment-access.ts';
import { HarnessFactReviewer } from '../agent/fact-reviewer.ts';
import { HarnessRuntime } from '../agent/runtime.ts';
import { NativeStore } from './store.ts';
import { ReadingEngine } from '../core/engine.ts';
import { ReadingRuntime } from '../core/runtime.ts';
import { LocalApplication } from '../core/application.ts';
import { ApplicationServer } from '../core/application-wire.ts';
import { ChatModel } from '../core/model.ts';
import { attachWebTools } from '../core/web-tools.ts';
import { recoverInterruptedState } from '../core/startup.ts';
import { validateMigration } from '../core/migration.ts';
import type { StartupRecovery } from '../core/startup.ts';
import type { State } from '../core/types.ts';

const store = new NativeStore(hostRequest);
let server: ApplicationServer | undefined, runtime: ReadingRuntime | undefined;
let initializing = false, needsMigration = false;
function send(method: string, payload: unknown) { __hostSend(JSON.stringify({ method, payload })); }
function fail(error: unknown) { send('applicationFailure', { message: String((error as Error)?.message ?? error) }); }
async function start(state: State, initialRecovery?: StartupRecovery) {
  const recovery = initialRecovery ?? recoverInterruptedState(state);
  if (recovery.changed) await store.save(state);
  const engine = new ReadingEngine(state, store, new ChatModel((request, signal) => hostRequest('model', request, signal)));
  const harness = new HarnessRuntime();
  engine.factReviewer = new HarnessFactReviewer(harness); engine.agent = harness;
  runtime = new ReadingRuntime(engine, { available: true, request: hostRequest });
  attachWebTools(engine, hostRequest);
  const application = new LocalApplication(runtime, hostRequest);
  server = new ApplicationServer(application, (kind, payload) => send(kind === 'frame' ? 'applicationFrame' : 'applicationResult', payload));
  needsMigration = false;
  send('applicationReady', { needsMigration: false, recovery, frame: server.frame(), runtime: 'QuickJS-NG' });
  try { const network = await hostRequest<{ online: boolean }>('networkStatus'); engine.setNetworkAvailable(network.online); }
  catch (error) { engine.setNetworkAvailable(false); runtime.reportError(error); }
}
Object.assign(globalThis, {
  __applicationCommand: (request: unknown) => { if (!server) return fail(new Error('运行核心尚未就绪')); void server.receive(request); },
  __applicationAck: (epoch: string, sequence: number) => server?.acknowledge(epoch, sequence),
  __applicationEvent: (name: string, value: unknown) => { if (runtime) void runtime.receive(name, value).catch(e => runtime!.reportError(e)); },
  __applicationInitialize: async (requestId: string, value: State | null) => {
    if (initializing || !needsMigration || server) { send('applicationInitialized', { id: requestId, error: '资料已经初始化，请重新连接' }); return; }
    initializing = true;
    try {
      const migrated = await validateMigration(value);
      await store.save(migrated.state); await start(migrated.state, migrated.recovery);
      send('applicationInitialized', { id: requestId, ok: true });
    } catch (error) { send('applicationInitialized', { id: requestId, error: String((error as Error).message) }); }
    finally { initializing = false; }
  },
});
void store.load().then(async state => {
  if (state) await start(state);
  else { needsMigration = true; send('applicationReady', { needsMigration: true, runtime: 'QuickJS-NG' }); }
}).catch(fail);
