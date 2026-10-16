import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { NativeChannel } from '../src/native/channel.ts';
import { NativeStore } from '../src/native/store.ts';
import { ModelRequestError } from '../src/core/errors.ts';
import { initialState } from '../src/core/state.ts';
import { importBook } from '../src/core/books.ts';
import type { State } from '../src/core/types.ts';
import type { NativeRequest } from '../src/native/channel.ts';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; }
test('原生请求取消后立即结束等待并丢弃迟到结果，已完成请求不再被取消', async () => {
  const sent: any[] = [], channel = new NativeChannel(wire => sent.push(JSON.parse(wire))), controller = new AbortController();
  const pending = channel.request('model', { body: 'engineering' }, controller.signal); const id = sent[0].id;
  controller.abort(); await assert.rejects(pending, error=>error instanceof ModelRequestError&&error.dispatch==='unknown'); assert.deepEqual(sent[1], { method: 'cancel', payload: { id } });
  channel.receive(id, JSON.stringify({ value: 'late' })); assert.equal(sent.length, 2);
  const doneController = new AbortController(), done = channel.request('model', {}, doneController.signal), doneId = sent.at(-1).id;
  channel.receive(doneId, JSON.stringify({ value: 42 })); assert.equal(await done, 42); const count = sent.length; doneController.abort(); assert.equal(sent.length, count);
  const stopped = new AbortController(); stopped.abort(); await assert.rejects(channel.request('model', {}, stopped.signal), error=>error instanceof ModelRequestError&&error.dispatch==='not-dispatched'); assert.equal(sent.length, count);
});

test('原生网络错误和超时可区分，格式错误不能被当作空状态成功返回', async () => {
  const sent: any[] = [], channel = new NativeChannel(wire => sent.push(JSON.parse(wire)), 15);
  const network = channel.request('model'); channel.receive(sent[0].id, JSON.stringify({ error: 'NETWORK:已断网' })); await assert.rejects(network, error=>error instanceof ModelRequestError&&error.dispatch==='unknown');
  for (const body of ['not json', 'null', '{}', '{"error":""}', '"text"']) {
    const pending = channel.request('loadState'); channel.receive(sent.at(-1).id, body); await assert.rejects(pending, /无法读取/);
  }
  const direct = channel.request<string>('readBookText'); channel.receiveValue(sent.at(-1).id, { value: '甲乙🙂\u0000"\\\n' }); assert.equal(await direct, '甲乙🙂\u0000"\\\n');
  const malformed = channel.request('readBookText'); channel.receiveValue(sent.at(-1).id, []); await assert.rejects(malformed, /无法读取/);
  const timeout = channel.request('model'); const id = sent.at(-1).id; await assert.rejects(timeout, error=>error instanceof ModelRequestError&&error.dispatch==='unknown');
  assert.deepEqual(sent.at(-1), { method: 'cancel', payload: { id } });
  const broken = new NativeChannel(() => { throw new Error('宿主已关闭'); }); await assert.rejects(broken.request('loadState'), /宿主已关闭/);
});

test('模型默认等待可接住194秒完整原答，非模型仍150秒；到模型截止保持unknown并丢迟到结果', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent:any[]=[],channel=new NativeChannel(wire=>sent.push(JSON.parse(wire)));
  const model=channel.request('model'),modelId=sent.at(-1).id,other=channel.request('loadState'),otherId=sent.at(-1).id;
  const otherTimeout=assert.rejects(other,/原生请求超时/);
  t.mock.timers.tick(150000);await otherTimeout;
  assert.deepEqual(sent.filter(m=>m.method==='cancel'),[{method:'cancel',payload:{id:otherId}}]);
  t.mock.timers.tick(44722);channel.receiveValue(modelId,{value:'complete received response'});assert.equal(await model,'complete received response');
  const expired=channel.request('model'),expiredId=sent.at(-1).id;
  const modelTimeout=assert.rejects(expired,error=>error instanceof ModelRequestError&&error.dispatch==='unknown');
  t.mock.timers.tick(1229999);assert.equal(sent.some(m=>m.method==='cancel'&&m.payload.id===expiredId),false);
  t.mock.timers.tick(1);await modelTimeout;assert.deepEqual(sent.at(-1),{method:'cancel',payload:{id:expiredId}});
  channel.receiveValue(expiredId,{value:'late'});assert.equal(sent.filter(m=>m.method==='cancel'&&m.payload.id===expiredId).length,1);
});

test('显式超时override继续同时作用于模型与非模型请求', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent:any[]=[],channel=new NativeChannel(wire=>sent.push(JSON.parse(wire)),123);
  const model=channel.request('model'),other=channel.request('loadState');
  const modelTimeout=assert.rejects(model,error=>error instanceof ModelRequestError&&error.dispatch==='unknown'),otherTimeout=assert.rejects(other,/原生请求超时/);
  t.mock.timers.tick(122);assert.equal(sent.filter(m=>m.method==='cancel').length,0);
  t.mock.timers.tick(1);await Promise.all([modelTimeout,otherTimeout]);assert.equal(sent.filter(m=>m.method==='cancel').length,2);
});

async function fixture() { const state = initialState(), book = await importBook('原生存储工程🙂', '第一章 登记\n工程数量为3。'); state.books = [book]; return { state, book }; }
function disk(before?: (method: string) => Promise<void>) {
  const texts = new Map<string, string>(), calls: string[] = [], snapshots: State[] = [];
  const request: NativeRequest = async <T>(method: string, data: any): Promise<T> => {
    calls.push(method); await before?.(method);
    if (method === 'putBookText') {
      assert.equal(data.version, createHash('sha256').update(data.text).digest('hex')); texts.set(data.version, data.text); return undefined as T;
    }
    if (method === 'saveState') { assert.ok(data.books.every((b: any) => b.text === '' && texts.has(b.version))); snapshots.push(structuredClone(data)); return undefined as T; }
    if (method === 'loadState') return structuredClone(snapshots.at(-1) ?? null) as T;
    if (method === 'readBookText') { const text = texts.get(data.version); if (text === undefined) throw new Error('原文缺失'); return text as T; }
    throw new Error('unexpected method');
  };
  return { request, texts, calls, snapshots };
}

test('原文只在新版本写入，日常保存只有元数据且并发保存各自保留调用时快照', async () => {
  const { state, book } = await fixture(), entered = deferred(), release = deferred(); let held = false;
  const target = disk(async method => { if (method === 'putBookText' && !held) { held = true; entered.resolve(); await release.promise; } });
  const store = new NativeStore(target.request); const first = store.save(state); await entered.promise;
  state.settings.tokenLimit = 45678; const second = store.save(state); release.resolve(); await Promise.all([first, second]);
  assert.deepEqual(target.calls, ['putBookText', 'saveState', 'saveState']); assert.equal(target.snapshots[0].settings.tokenLimit, 100000); assert.equal(target.snapshots[1].settings.tokenLimit, 45678);
  assert.equal(book.text, '第一章 登记\n工程数量为3。'); assert.equal(target.texts.get(book.version), book.text);
  const loaded = await store.load(); assert.equal(loaded?.books[0].text, ''); assert.equal(loaded?.books[0].textLength, book.text.length);
  await store.save(loaded!); assert.equal(target.calls.filter(c => c === 'putBookText').length, 1);
  assert.equal(await store.readBookText(book.version), book.text);
});

test('原文写入失败不提交索引，元数据失败后可重试且不重复上传已保存原文', async () => {
  const { state } = await fixture(); let textFailure = true, metadataFailure = true;
  const target = disk(async method => { if (method === 'putBookText' && textFailure) { textFailure = false; throw new Error('原文保存失败'); } if (method === 'saveState' && metadataFailure) { metadataFailure = false; throw new Error('状态保存失败'); } });
  const store = new NativeStore(target.request);
  await assert.rejects(store.save(state), /原文保存失败/); assert.equal(target.calls.includes('saveState'), false);
  await assert.rejects(store.save(state), /状态保存失败/); assert.equal(target.snapshots.length, 0);
  await store.save(state); assert.equal(target.calls.filter(c => c === 'putBookText').length, 2); assert.equal(target.snapshots.length, 1);
});

test('加载后已有正文不重传，密钥传输包不进入原生日常状态，同版本改文会被拒绝', async () => {
  const { state, book } = await fixture(), target = disk(), first = new NativeStore(target.request);
  Object.assign(state, { secrets: { wechat: 'engineering-secret-marker' }, exportedAt: 'test' });
  await first.save(state); assert.equal('secrets' in target.snapshots[0], false); assert.equal('exportedAt' in target.snapshots[0], false);
  const next = new NativeStore(target.request), loaded = (await next.load())!; await next.save(loaded); assert.equal(target.calls.filter(c => c === 'putBookText').length, 1);
  loaded.books[0].text = 'changed without a matching version'; await assert.rejects(next.save(loaded));
  assert.equal(target.snapshots.at(-1)?.books[0].version, book.version); assert.equal(target.texts.get(book.version), book.text);
});
