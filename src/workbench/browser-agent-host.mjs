import * as asyncHooks from '../../third_party/deepseek-harness/src/node/builtin_modules/implemented/async_hooks.ts';
import {createAlsRuntime} from '../../third_party/deepseek-harness/src/polyfill/async-context/als-runtime.ts';
import {installAsyncContextHooks} from '../../third_party/deepseek-harness/src/polyfill/async-context/async-context-hooks.ts';

const hostKey=Symbol.for('yixu.workbench.agent-host.v1');
/** Pinned Harness host. Native fetch/crypto continue to perform browser operations. */
export function browserAgentHost(sharedModules={}){
 if(!globalThis[hostKey]){
  const nativeTimeout=globalThis.setTimeout.bind(globalThis),nativeInterval=globalThis.setInterval.bind(globalThis);
  globalThis.setTimeout=(callback,delay,...args)=>{if(typeof callback!=='function')throw new TypeError('Agent timers require callbacks');return nativeTimeout(asyncHooks.bindAsyncContext(()=>callback(...args)),delay);};
  globalThis.setInterval=(callback,delay,...args)=>{if(typeof callback!=='function')throw new TypeError('Agent timers require callbacks');return nativeInterval(asyncHooks.bindAsyncContext(()=>callback(...args)),delay);};
  installAsyncContextHooks();
  globalThis[hostKey]={als:createAlsRuntime(asyncHooks.alsCausality),asyncHooks};
 }
 const modules=Object.freeze({
  'node:async_hooks':asyncHooks,
  'node:crypto':{randomUUID:()=>crypto.randomUUID()},
  'node:util/types':{isPromise:value=>value instanceof Promise},
  'node:path':{isAbsolute:path=>{if(typeof path!=='string')throw new TypeError('Path must be a string');return path.startsWith('/');}},
  'node:fs':Object.freeze({}),'node:os':Object.freeze({}),
  'node:module':{createRequire:()=>specifier=>{if(specifier!=='../package.json')throw Error('Agent package metadata request is not declared');return {version:'0.1.7-rc.2'};}},
  ...sharedModules,
 });
 return {...globalThis[hostKey],require(name){if(!Object.hasOwn(modules,name))throw Error('Agent browser module is not declared: '+name);return modules[name];}};
}
