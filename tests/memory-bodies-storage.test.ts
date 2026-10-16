import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../src/core/state.ts';
import { NativeStore } from '../src/native/store.ts';
import type { NativeRequest } from '../src/native/channel.ts';
import type { Memory, MemoryBody, State } from '../src/core/types.ts';
import { acknowledgeSavedMemoryBodies, BoundedMemoryBodyCache, hydrateMemoryBodies, prepareMemoryBodySnapshot, releasePersistedMemoryBodies, requireMemoryText } from '../src/core/memory-bodies.ts';
import { hashText } from '../src/core/text-hash.ts';

function memory(id = 'old', text = '旧阅读档案：人物希望保留这段经历。'): Memory {
  return { id, text, bookId: 'book', partnerId: 'partner', kind: 'opinion', evidence: [], parents: [], chatIds: [], createdAt: 1, forgotten: false, source: 'reading' };
}
function disk(seed?: State, before?: (method: string) => Promise<void>) {
  let snapshot = seed && structuredClone(seed);
  const bodies = new Map<string, MemoryBody>(), calls: string[] = [], snapshots: State[] = [];
  const request: NativeRequest = async <T>(method: string, data: any): Promise<T> => {
    calls.push(method); await before?.(method);
    if (method === 'loadState') return structuredClone(snapshot ?? null) as T;
    if (method === 'putMemoryBody') { assert.equal(data.hash, await hashText(data.text)); bodies.set(data.key, structuredClone(data)); return undefined as T; }
    if (method === 'readMemoryBodies') return data.refs.map((ref: any) => bodies.get(ref.key)).filter(Boolean) as T;
    if (method === 'saveState') {
      assert(data.memories.every((item: Memory) => item.text === undefined && bodies.has(item.bodyRef!.key)));
      snapshot = structuredClone(data); snapshots.push(snapshot!); return undefined as T;
    }
    throw Error('unexpected method: ' + method);
  };
  return { request, bodies, calls, snapshots, snapshot: () => snapshot };
}
function deferred() { let resolve!: () => void; return { promise: new Promise<void>(r => resolve = r), resolve: () => resolve() }; }

test('成功保存只给live加正文引用；重启仅加载元信息，按需取正文且缓存有界', async () => {
  const state = initialState(); state.memories = [memory()];
  const target = disk(), store = new NativeStore(target.request);
  await store.save(state); assert.equal(state.memories[0].text, memory().text); assert(state.memories[0].bodyRef);
  assert.equal(target.snapshot()!.memories[0].text, undefined);
  releasePersistedMemoryBodies(state); assert.throws(() => requireMemoryText(state.memories[0]), /尚未载入/);
  const restarted = new NativeStore(target.request), loaded = (await restarted.load())!;
  assert.equal(loaded.memories[0].text, undefined); assert(!target.calls.includes('readMemoryBodies'));
  await hydrateMemoryBodies(restarted, loaded.memories); assert.equal(loaded.memories[0].text, memory().text);
  releasePersistedMemoryBodies(loaded); await hydrateMemoryBodies(restarted, loaded.memories);
  assert.equal(target.calls.filter(call => call === 'readMemoryBodies').length, 1);
  await restarted.save(loaded); assert.equal(target.snapshot()!.memories[0].text, undefined);
});

test('旧inline档案在正文与元信息都成功保存后迁移，旧稿和回执字段全文保留', async () => {
  const state = initialState(); state.memories = [memory()];
  Object.assign(state, { readingDrafts: [{ id: 'draft', raw: '原始旧稿全文🙂' }], queryCheckpoints: [{ id: 'query', raw: '查询原稿全文' }], companionReadingReceipts: [{ id: 'receipt', raw: '原始回执全文' }] });
  let fail = true;
  const target = disk(state, async method => { if (method === 'saveState' && fail) throw Error('状态保存失败'); });
  const store = new NativeStore(target.request);
  await assert.rejects(store.load(), /保存失败/); assert.equal(target.snapshot()!.memories[0].text, memory().text);
  fail = false; const migrated = (await store.load())!;
  assert.equal(migrated.memories[0].text, undefined);
  for (const key of ['readingDrafts', 'queryCheckpoints', 'companionReadingReceipts'] as const) assert.deepEqual(migrated[key], state[key]);
  assert.equal(target.calls.filter(call => call === 'putMemoryBody').length, 1);
  await hydrateMemoryBodies(store, migrated.memories); assert.equal(migrated.memories[0].text, state.memories[0].text);
});

test('正文写入或元信息失败保全live原文；保存等待期间改变正文不给它错误引用', async () => {
  const state = initialState(); state.memories = [memory()]; let failBody = true, failMetadata = true;
  const target = disk(undefined, async method => { if (method === 'putMemoryBody' && failBody) { failBody = false; throw Error('正文写入失败'); } if (method === 'saveState' && failMetadata) { failMetadata = false; throw Error('元信息保存失败'); } });
  const store = new NativeStore(target.request);
  await assert.rejects(store.save(state), /正文/); await assert.rejects(store.save(state), /元信息/);
  assert.equal(state.memories[0].bodyRef, undefined); assert.equal(state.memories[0].text, memory().text);
  releasePersistedMemoryBodies(state); assert.equal(state.memories[0].text, memory().text);
  await store.save(state); assert(state.memories[0].bodyRef);

  const next = initialState(); next.memories = [memory('new', '保存调用时正文')]; const entered = deferred(), release = deferred(); let held = false;
  const delayed = disk(undefined, async method => { if (method === 'saveState' && !held) { held = true; entered.resolve(); await release.promise; } });
  const concurrent = new NativeStore(delayed.request), first = concurrent.save(next); await entered.promise;
  next.memories[0].text = '等待期间形成的新正文'; next.settings.tokenLimit = 1234;
  assert.equal(next.memories[0].bodyRef, undefined); release.resolve(); await first;
  assert.equal(next.memories[0].bodyRef, undefined); assert.equal(delayed.snapshot()!.settings.tokenLimit, 100000);
  const second = concurrent.save(next); await second;
  assert.equal(next.memories[0].bodyRef!.hash, await hashText('等待期间形成的新正文'));
  assert.equal(delayed.snapshots[1].settings.tokenLimit, 1234);
});

test('懒读拒绝正文缺失、错hash、错长度和穿越key，整批失败不产生伪空文本', async () => {
  const state = initialState(); state.memories = [memory('a', '甲'), memory('b', '乙')];
  const prepared = await prepareMemoryBodySnapshot(state);
  for (const damage of ['missing', 'hash', 'chars']) {
    const unloaded = structuredClone(prepared.state), bodies = prepared.bodies.map(body => ({ ...body }));
    if (damage === 'missing') bodies.pop(); else if (damage === 'hash') bodies[1].text = '丙'; else unloaded.memories[1].bodyRef!.chars++;
    const store = { async load() { return unloaded; }, async save() {}, async readMemoryBodies() { return bodies; } };
    await assert.rejects(hydrateMemoryBodies(store, unloaded.memories), /缺失|校验/);
    assert(unloaded.memories.every(item => item.text === undefined));
  }
  const bad = structuredClone(prepared.state); bad.memories[0].bodyRef!.key = '../state.json';
  await assert.rejects(hydrateMemoryBodies({ async load() { return bad; }, async save() {}, async readMemoryBodies() { return []; } }, bad.memories), /引用无效/);
});

test('正文缓存逐出旧body，单个超预算正文读取后不常驻；未保存改文不被卸载', async () => {
  const state = initialState(); state.memories = [memory('a', '123'), memory('b', '456'), memory('c', '123456789')];
  const prepared = await prepareMemoryBodySnapshot(state), cache = new BoundedMemoryBodyCache(1, 5); let reads = 0;
  const fetch = async (refs: any) => { reads++; return refs.map((ref: any) => prepared.bodies.find(body => body.key === ref.key)!); };
  await cache.read([prepared.state.memories[0].bodyRef!], fetch); await cache.read([prepared.state.memories[0].bodyRef!], fetch); assert.equal(reads, 1);
  await cache.read([prepared.state.memories[1].bodyRef!], fetch); await cache.read([prepared.state.memories[0].bodyRef!], fetch); assert.equal(reads, 3);
  await cache.read([prepared.state.memories[2].bodyRef!], fetch); await cache.read([prepared.state.memories[2].bodyRef!], fetch); assert.equal(reads, 5);
  prepared.commit(); state.memories[0].text = '还未保存的修改'; releasePersistedMemoryBodies(state, new Set(['b']));
  assert.equal(state.memories[0].text, '还未保存的修改'); assert.equal(state.memories[1].text, '456'); assert.equal(state.memories[2].text, undefined);
});

test('保存草稿成功后承认同文活态；未完成保存或并发改文不被提前卸载', async () => {
  const live = initialState(); live.memories = [memory('same', '同文'), memory('changed', '保存调用时正文')];
  const draft = structuredClone(live), prepared = await prepareMemoryBodySnapshot(draft);
  acknowledgeSavedMemoryBodies(live, draft); releasePersistedMemoryBodies(live);
  assert.equal(live.memories[0].text, '同文'); assert.equal(live.memories[0].bodyRef, undefined);
  prepared.commit(); live.memories[1].text = '保存等待中的新正文';
  acknowledgeSavedMemoryBodies(live, draft); releasePersistedMemoryBodies(live);
  assert.equal(live.memories[0].text, undefined); assert.equal(live.memories[0].bodyRef!.hash, await hashText('同文'));
  assert.equal(live.memories[1].text, '保存等待中的新正文'); assert.equal(live.memories[1].bodyRef, undefined);
});
