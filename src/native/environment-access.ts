import type { hostRequest as NativeRequest } from './environment.ts';
import { configureTextHasher } from '../core/text-hash.ts';

declare global { var __yixuAgentRuntime: { hostRequest: typeof NativeRequest; asyncHooks: { runAtAsyncContextRoot<T>(operation: () => T): T } }; }
if (!globalThis.__yixuAgentRuntime) throw new Error('原生Agent运行环境尚未初始化');
export const hostRequest = globalThis.__yixuAgentRuntime.hostRequest;
configureTextHasher(text => hostRequest<string>('hashText', { text }));
