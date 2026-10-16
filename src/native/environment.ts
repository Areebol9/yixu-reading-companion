// Narrow host adapter for the APIs exercised by the shared core.
// This is not a browser polyfill; networking and arbitrary files are not exposed.
import { NativeChannel } from './channel.ts';
import URLConstructor from 'core-js-pure/actual/url/index.js';
import { configureTextHasher } from '../core/text-hash.ts';
declare global {
  var __hostSend: (message: string) => void;
  var __hostSync: (message: string) => string;
  var __yixuResolve: (id: string, response: string) => void;
  var __yixuResolveValue: (id: string, response: unknown) => void;
  var __yixuTimer: (id: number) => void;
}
let timerId = 0;
const channel = new NativeChannel(wire => __hostSend(wire));
const timers = new Map<number, () => void>();
export const hostRequest = channel.request;
configureTextHasher(text => hostRequest<string>('hashText', { text }));
globalThis.__yixuResolve = (id, wire) => channel.receive(id, wire);
globalThis.__yixuResolveValue = (id, response) => channel.receiveValue(id, response);
globalThis.__yixuTimer = id => { const action = timers.get(id); timers.delete(id); action?.(); };
function sync(method: string, payload: Record<string, unknown> = {}): any { const result = JSON.parse(__hostSync(JSON.stringify({ ...payload, method }))); if (result?.error) throw new Error(result.error); return result; }
class NativeDOMException extends Error { constructor(message = '', name = 'Error') { super(message); this.name = name; } }
class NativeAbortSignal {
  aborted = false; reason: unknown;
  private listeners = new Map<() => void, boolean>();
  addEventListener(type: string, listener: () => void, options?: { once?: boolean }) { if (type === 'abort') this.listeners.set(listener, !!options?.once); }
  removeEventListener(type: string, listener: () => void) { if (type === 'abort') this.listeners.delete(listener); }
  throwIfAborted() { if (this.aborted) throw this.reason; }
  abort(reason: unknown) {
    if (this.aborted) return;
    this.aborted = true; this.reason = reason;
    for (const [listener, once] of [...this.listeners]) { if (once) this.listeners.delete(listener); listener(); }
  }
}
class NativeAbortController {
  signal = new NativeAbortSignal();
  abort(reason: unknown = new NativeDOMException('已停止', 'AbortError')) { this.signal.abort(reason); }
}
class NativeTextEncoder {
  encoding = 'utf-8';
  encode(value = ''): Uint8Array {
    const bytes: number[] = [];
    for (const character of String(value)) {
      let code = character.codePointAt(0)!;
      if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
      if (code < 0x80) bytes.push(code);
      else if (code < 0x800) bytes.push(0xc0 | code >> 6, 0x80 | code & 63);
      else if (code < 0x10000) bytes.push(0xe0 | code >> 12, 0x80 | code >> 6 & 63, 0x80 | code & 63);
      else bytes.push(0xf0 | code >> 18, 0x80 | code >> 12 & 63, 0x80 | code >> 6 & 63, 0x80 | code & 63);
    }
    return new Uint8Array(bytes);
  }
}
Object.assign(globalThis, {
  DOMException: NativeDOMException, AbortController: NativeAbortController,
  TextEncoder: NativeTextEncoder,
  URL: URLConstructor,
  performance: { now: () => sync('now') },
  structuredClone: <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)),
  setTimeout: (action: (...args: any[]) => void, delay = 0, ...args: any[]) => {
    const id = ++timerId; timers.set(id, () => action(...args)); __hostSend(JSON.stringify({ method: 'timer', id, delay })); return id;
  },
  clearTimeout: (id?: number) => { if (id === undefined) return; timers.delete(id); __hostSend(JSON.stringify({ method: 'cancelTimer', id })); },
  crypto: {
    randomUUID: () => sync('uuid'),
    getRandomValues: <T extends ArrayBufferView>(value: T): T => {
      if (!(value instanceof Int8Array || value instanceof Uint8Array || value instanceof Uint8ClampedArray || value instanceof Int16Array || value instanceof Uint16Array || value instanceof Int32Array || value instanceof Uint32Array || value instanceof BigInt64Array || value instanceof BigUint64Array)) throw new TypeError('Expected an integer typed array');
      if (value.byteLength > 65536) throw new NativeDOMException('Random byte request exceeds 65536', 'QuotaExceededError');
      const target = new Uint8Array(value.buffer, value.byteOffset, value.byteLength), bytes = sync('randomBytes', { length: value.byteLength });
      if (!Array.isArray(bytes) || bytes.length !== target.length || bytes.some(b => !Number.isInteger(b) || b < 0 || b > 255)) throw new Error('Invalid native random bytes');
      target.set(bytes); return value;
    },
    subtle: { digest: async (algorithm: string, data: ArrayBuffer | ArrayBufferView) => {
      if (algorithm !== 'SHA-256') throw new Error('Unsupported digest');
      const input = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
      return new Uint8Array(await hostRequest<number[]>('sha256', { bytes: Array.from(input) })).buffer;
    } }
  }
});
