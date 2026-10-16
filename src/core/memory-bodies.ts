import type { HydratedMemory, Memory, MemoryBody, MemoryBodyRef, State, Store } from './types.ts';
import { hashText } from './text-hash.ts';
import { recordVerifiedMemoryIdentity, releaseMemoryIdentityText } from './memory-identity.ts';

const verified = new WeakMap<Memory, { text: string; key: string }>();
export function requireMemoryText(memory: Memory): string {
  if (typeof memory.text !== 'string') throw Error('阅读档案正文尚未载入，请先读取所需档案');
  return memory.text;
}
export function assertHydratedMemory(memory: Memory): asserts memory is HydratedMemory { requireMemoryText(memory); }
export function memoryTextLength(memory: Memory): number {
  if (typeof memory.text === 'string') return memory.text.length;
  if (memory.bodyRef) { validateMemoryBodyRef(memory.bodyRef); return memory.bodyRef.chars; }
  throw Error('阅读档案正文缺失');
}
export function validateMemoryBodyRef(ref: MemoryBodyRef): void {
  if (!ref || !/^[0-9a-f]{64}$/.test(ref.hash) || ref.key !== 'memory-body-' + ref.hash || !Number.isSafeInteger(ref.chars) || ref.chars < 0) throw Error('阅读档案正文引用无效');
}
export async function validateMemoryBody(body: MemoryBody, ref: MemoryBodyRef): Promise<void> {
  validateMemoryBodyRef(ref);
  if (!body || body.key !== ref.key || body.hash !== ref.hash || typeof body.text !== 'string' || body.text.length !== ref.chars || await hashText(body.text) !== ref.hash) throw Error('阅读档案正文缺失或校验失败');
}

/** A small per-store cache; historical bodies do not accumulate with the archive. */
export class BoundedMemoryBodyCache {
  private entries = new Map<string, MemoryBody>();
  private chars = 0;
  private maxEntries: number;
  private maxChars: number;
  constructor(maxEntries = 64, maxChars = 1_000_000) { this.maxEntries = maxEntries; this.maxChars = maxChars; }
  private remember(body: MemoryBody) {
    const old = this.entries.get(body.key);
    if (old) { this.chars -= old.text.length; this.entries.delete(body.key); }
    if (body.text.length > this.maxChars) return;
    this.entries.set(body.key, { ...body }); this.chars += body.text.length;
    while (this.entries.size > this.maxEntries || this.chars > this.maxChars) {
      const first = this.entries.keys().next().value!;
      this.chars -= this.entries.get(first)!.text.length; this.entries.delete(first);
    }
  }
  async read(refs: readonly MemoryBodyRef[], fetch: (missing: readonly MemoryBodyRef[]) => Promise<MemoryBody[]>): Promise<MemoryBody[]> {
    const unique = new Map<string, MemoryBodyRef>();
    for (const ref of refs) { validateMemoryBodyRef(ref); const previous = unique.get(ref.key); if (previous && previous.chars !== ref.chars) throw Error('阅读档案正文长度引用不一致'); unique.set(ref.key, ref); }
    const missing = [...unique.values()].filter(ref => !this.entries.has(ref.key));
    const fetched = missing.length ? await fetch(missing) : [];
    const found = new Map(fetched.map(body => [body.key, body]));
    // Validate the complete batch before changing the cache or callers' memories.
    for (const ref of missing) await validateMemoryBody(found.get(ref.key)!, ref);
    const result = refs.map(ref => this.entries.get(ref.key) ?? found.get(ref.key)!);
    for (let i = 0; i < refs.length; i++) if (result[i].text.length !== refs[i].chars) throw Error('阅读档案正文长度校验失败');
    for (const body of result) this.remember(body);
    return result.map(body => ({ ...body }));
  }
}

/** Hydrates an explicit batch; absent/corrupt bodies fail without substituting empty text. */
export async function hydrateMemoryBodies(store: Store, memories: readonly Memory[]): Promise<void> {
  const targets = memories.filter(memory => typeof memory.text !== 'string').map(memory => {
    if (!memory.bodyRef) throw Error('阅读档案正文缺失'); validateMemoryBodyRef(memory.bodyRef);
    return { memory, ref: { ...memory.bodyRef } };
  });
  if (!targets.length) return;
  if (!store.readMemoryBodies) throw Error('当前存储不支持读取阅读档案正文');
  const bodies = await store.readMemoryBodies(targets.map(target => target.ref));
  const found = new Map(bodies.map(body => [body.key, body]));
  for (const target of targets) await validateMemoryBody(found.get(target.ref.key)!, target.ref);
  for (const { memory, ref } of targets) {
    if (typeof memory.text === 'string' || memory.bodyRef?.key !== ref.key || memory.bodyRef.chars !== ref.chars) continue;
    memory.text = found.get(ref.key)!.text; verified.set(memory, { text: memory.text, key: ref.key });
    recordVerifiedMemoryIdentity(memory, ref.hash, memory.text);
  }
}

/** Releases only the exact text known to have been successfully persisted/hydrated. */
export function releasePersistedMemoryBodies(state: State, keepIds: ReadonlySet<string> = new Set()): void {
  for (const memory of state.memories) {
    const saved = verified.get(memory);
    if (!keepIds.has(memory.id) && saved && memory.text === saved.text && memory.bodyRef?.key === saved.key) { delete memory.text; verified.delete(memory); releaseMemoryIdentityText(memory); }
  }
}

export function acknowledgeMemoryBody(memory:Memory,text:string,ref:MemoryBodyRef):void{
  validateMemoryBodyRef(ref);if(memory.text!==text||ref.chars!==text.length)return;
  memory.bodyRef={...ref};verified.set(memory,{text,key:ref.key});recordVerifiedMemoryIdentity(memory,ref.hash,text);
}

/** After a successful saved-draft merge, transfer only the exact verified body.
 * A concurrently edited target retains its text and previous reference. */
export function acknowledgeSavedMemoryBodies(targetState: State, savedState: State): void {
  const savedById = new Map(savedState.memories.map(memory => [memory.id, memory]));
  for (const memory of targetState.memories) {
    const saved = savedById.get(memory.id), proof = saved && verified.get(saved), ref = saved?.bodyRef;
    if (!saved || !proof || !ref || typeof saved.text !== 'string' || saved.text !== proof.text || ref.key !== proof.key || memory.text !== saved.text) continue;
    validateMemoryBodyRef(ref);
    if (ref.chars !== proof.text.length) continue;
    memory.bodyRef = { ...ref }; verified.set(memory, { text: proof.text, key: proof.key });
    recordVerifiedMemoryIdentity(memory, ref.hash, proof.text);
  }
}

/** Capture metadata before hashing/waiting. Never clone the historical body strings. */
export async function prepareMemoryBodySnapshot(state: State): Promise<{ state: State; bodies: MemoryBody[]; commit(): void }> {
  const captured = state.memories.map(memory => ({ memory, text: memory.text, ref: memory.bodyRef && { ...memory.bodyRef }, saved: verified.get(memory) }));
  const copy = structuredClone({ ...state, memories: state.memories.map(({ text: _text, ...metadata }) => metadata) }) as State;
  const bodies = new Map<string, MemoryBody>();
  const refs: MemoryBodyRef[] = [];
  for (let i = 0; i < captured.length; i++) {
    const item = captured[i]; let ref = item.ref;
    if (typeof item.text === 'string') {
      const hash = item.saved?.text === item.text && item.saved.key === ref?.key ? item.saved.key.slice('memory-body-'.length) : await hashText(item.text);
      ref = { key: 'memory-body-' + hash, hash, chars: item.text.length };
      bodies.set(ref.key, { key: ref.key, hash, text: item.text });
    }
    if (!ref) throw Error('阅读档案正文缺失，未保存状态');
    validateMemoryBodyRef(ref); copy.memories[i].bodyRef = ref; refs.push(ref);
  }
  return { state: copy, bodies: [...bodies.values()], commit() {
    captured.forEach((item, index) => {
      if (typeof item.text === 'string' && item.memory.text === item.text) {
        item.memory.bodyRef = { ...refs[index] }; verified.set(item.memory, { text: item.text, key: refs[index].key });
        recordVerifiedMemoryIdentity(item.memory, refs[index].hash, item.text);
      }
    });
  } };
}
