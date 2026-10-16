import { TransientServiceError, ModelRequestError, modelEnvelopeError } from '../core/errors.ts';
type NativeHost = { request(id: string, method: string, payload: string): void };
declare global {
  interface Window {
    YixuNative?: NativeHost;
    yixuNativeResult?: (id: string, result: string, error?: string) => void;
    yixuNativeEvent?: (name: string, payload: string) => void;
  }
}
const waiting = new Map<string, { method:string; resolve: (v: unknown) => void; reject: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
if (typeof window !== 'undefined') window.yixuNativeResult = (id, result, error) => {
  const pending = waiting.get(id); if (!pending) return;
  clearTimeout(pending.timer); waiting.delete(id);
  if (error) pending.reject(pending.method==='model'?modelEnvelopeError({error}):error.startsWith('NETWORK:') ? new TransientServiceError(error.slice(8)) : new Error(error));
  else { try { const value=JSON.parse(result);if(pending.method==='model'&&value.error)pending.reject(modelEnvelopeError(value));else pending.resolve(value); } catch { pending.reject(pending.method==='model'?modelEnvelopeError({}):new Error('设备返回了无法读取的数据')); } }
};
export const isNative = () => typeof window !== 'undefined' && !!window.YixuNative;
export async function nativeCall<T>(method: string, payload: unknown = {}, signal?: AbortSignal): Promise<T> {
  if (!window.YixuNative) throw method==='model'?new ModelRequestError('设备模型入口不可用，请求未发出','not-dispatched'):new Error('此功能需要安装 Android 客户端');
  if(method==='model'&&signal?.aborted)throw new ModelRequestError('模型请求尚未发出，任务已停止','not-dispatched');
  signal?.throwIfAborted();
  const id = crypto.randomUUID();
  return new Promise<T>((resolve, reject) => {
    const unknown=()=>new ModelRequestError('模型请求已停止等待，结果或结算尚未确定；已保留原任务，不会自动重问','unknown');
    const cancel = () => { window.YixuNative?.request(crypto.randomUUID(), 'cancel', JSON.stringify({ id })); done(method==='model'?unknown():new DOMException('已停止', 'AbortError')); };
    const done = (error?: unknown, value?: unknown) => {
      const pending = waiting.get(id); if (!pending) return;
      clearTimeout(pending.timer); waiting.delete(id); signal?.removeEventListener('abort', cancel);
      error ? reject(error) : resolve(value as T);
    };
    const timer = setTimeout(() => { window.YixuNative?.request(crypto.randomUUID(), 'cancel', JSON.stringify({ id })); done(method === 'model' ? unknown() : new Error('设备请求超时')); }, 150_000);
    waiting.set(id, { method, resolve: v => { signal?.removeEventListener('abort', cancel); resolve(v as T); }, reject: e => { signal?.removeEventListener('abort', cancel); reject(e); }, timer });
    signal?.addEventListener('abort', cancel, { once: true });
    try{window.YixuNative!.request(id, method, JSON.stringify(payload));}catch(error){done(method==='model'?unknown():error);}
  });
}
export async function hostCall<T>(method: string, payload: unknown, signal?: AbortSignal): Promise<T> {
  if (isNative()) return nativeCall<T>(method, payload, signal);
  if(method==='model'&&signal?.aborted)throw new ModelRequestError('模型请求尚未发出，任务已停止','not-dispatched');
  let response: Response;
  try { response = await fetch('/api/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Yixu-Client': 'local-app' }, body: JSON.stringify(payload), signal }); }
  catch (error) { if(method==='model')throw modelEnvelopeError({});signal?.throwIfAborted();throw error; }
  let result;
  try{result=await response.json();}catch(error){if(method==='model')throw modelEnvelopeError({});throw error;}
  if(method==='model'&&!response.ok)throw modelEnvelopeError(result);
  if (!response.ok && result.retryable === true) throw new TransientServiceError(result.error ?? '模型连接暂不可用');
  if (!response.ok) throw new Error(result.error ?? '本地服务暂不可用');
  return result;
}
