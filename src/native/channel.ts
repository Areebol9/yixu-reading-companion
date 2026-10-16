import { TransientServiceError, ModelRequestError, modelEnvelopeError } from '../core/errors.ts';

export type NativeRequest = <T>(method: string, payload?: unknown, signal?: AbortSignal) => Promise<T>;
export class NativeChannel {
  private pending = new Map<string, { method: string; finish(error?: unknown, value?: unknown): void }>();
  private send: (wire: string) => void;
  private timeoutMs?: number;
  constructor(send: (wire: string) => void, timeoutMs?: number) { this.send = send; this.timeoutMs = timeoutMs; }
  request: NativeRequest = async <T>(method: string, payload?: unknown, signal?: AbortSignal): Promise<T> => {
    if(method==='model'&&signal?.aborted)throw new ModelRequestError('模型请求尚未发出，任务已停止','not-dispatched');
    signal?.throwIfAborted();
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const finish = (error?: unknown, value?: unknown) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve(value as T);
      };
      const cancel = (error: unknown) => {
        if (!this.pending.has(id)) return;
        try { this.send(JSON.stringify({ method: 'cancel', payload: { id } })); } catch {}
        finish(error);
      };
      const unknown = () => new ModelRequestError('模型请求已停止等待，结果或结算尚未确定；已保留原任务，不会自动重问','unknown');
      const abort = () => cancel(method==='model'?unknown():signal?.reason ?? new DOMException('已停止', 'AbortError'));
      const timer = setTimeout(() => cancel(method === 'model' ? unknown() : new Error('原生请求超时')), this.timeoutMs ?? (method === 'model' ? 1230000 : 150000));
      this.pending.set(id, { method, finish }); signal?.addEventListener('abort', abort, { once: true });
      try { this.send(JSON.stringify({ id, method, payload })); } catch (error) { finish(method==='model'?unknown():error); }
    });
  };
  receive(id: string, wire: string): void {
    try { this.receiveValue(id, JSON.parse(wire)); }
    catch { const pending=this.pending.get(id);pending?.finish(pending.method==='model'?modelEnvelopeError({}):new Error('原生返回的数据无法读取')); }
  }
  receiveValue(id: string, response: any): void {
    const pending = this.pending.get(id); if (!pending) return;
    try {
      if (!response || typeof response !== 'object' || Array.isArray(response) || !('value' in response) && !(typeof response.error === 'string' && response.error)) throw new Error('Invalid native envelope');
      if (pending.method==='model' && (response.error||response.value?.error)) pending.finish(modelEnvelopeError(response.error?response:response.value));
      else if (typeof response.error === 'string' && response.error) pending.finish(response.error.startsWith('NETWORK:') ? new TransientServiceError(response.error.slice(8)) : new Error(response.error));
      else pending.finish(undefined, response.value);
    } catch { pending.finish(pending.method==='model'?modelEnvelopeError({}):new Error('原生返回的数据无法读取')); }
  }
}
