import { hostRequest } from './environment.ts';
import * as asyncHooks from '../../third_party/deepseek-harness/src/node/builtin_modules/implemented/async_hooks.ts';
import { createAlsRuntime } from '../../third_party/deepseek-harness/src/polyfill/async-context/als-runtime.ts';
import { installAsyncContextHooks } from '../../third_party/deepseek-harness/src/polyfill/async-context/async-context-hooks.ts';

// Mobile host for the pinned agent kernel; only declared modules are exposed.
globalThis.console ??= { log() {}, info() {}, warn() {}, error() {}, debug() {} };
globalThis.queueMicrotask ??= callback => { void Promise.resolve().then(callback); };
globalThis.fetch ??= () => Promise.reject(new Error('Agent must use the configured model and web tools'));
globalThis.AbortSignal ??= new AbortController().signal.constructor;
AbortSignal.any ??= signals => {
  const controller = new AbortController(), listeners = [];
  const stop = signal => { for (const [source, callback] of listeners) source.removeEventListener('abort', callback); controller.abort(signal.reason); };
  for (const signal of signals) {
    if (signal.aborted) { stop(signal); break; }
    const callback = () => stop(signal); listeners.push([signal, callback]); signal.addEventListener('abort', callback, { once: true });
  }
  return controller.signal;
};
const nativeTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => nativeTimeout(asyncHooks.bindAsyncContext(() => callback(...args)), delay);
installAsyncContextHooks();
for (const name of ['__yixuResolve', '__yixuResolveValue', '__yixuTimer']) {
  const invoke = globalThis[name]; globalThis[name] = (...args) => asyncHooks.runAtAsyncContextRoot(() => invoke(...args));
}
const modules = Object.freeze({
  'node:async_hooks': asyncHooks,
  'node:crypto': { randomUUID: () => crypto.randomUUID() },
  'node:util/types': { isPromise: value => value instanceof Promise },
  'node:path': { isAbsolute: path => { if (typeof path !== 'string') throw new TypeError('Path must be a string'); return path.startsWith('/'); } },
  // These two imports contain no live bindings after the kernel's tree shaking.
  'node:fs': Object.freeze({}), 'node:os': Object.freeze({}),
  'node:module': { createRequire: () => specifier => { if (specifier !== '../package.json') throw new Error('Undeclared package metadata request'); return { version: '0.1.7-rc.2' }; } },
});
globalThis.__yixuAgentRuntime = {
  als: createAlsRuntime(asyncHooks.alsCausality), asyncHooks, hostRequest,
  require(name) { if (!Object.hasOwn(modules, name)) throw new Error('Undeclared agent module: ' + name); return modules[name]; },
};
