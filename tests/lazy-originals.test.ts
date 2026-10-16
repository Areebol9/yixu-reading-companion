import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { importBook, bookLength } from '../src/core/books.ts';
import { assertReadable, readText, searchText } from '../src/core/context.ts';
import { initialState } from '../src/core/state.ts';
import { ReadingEngine } from '../src/core/engine.ts';
import { ReadingRuntime } from '../src/core/runtime.ts';
import { LocalApplication } from '../src/core/application.ts';
import { NativeStore } from '../src/native/store.ts';
import { restoreBackup } from '../src/core/backup.ts';
import type { State, ModelPort } from '../src/core/types.ts';
import type { NativeRequest } from '../src/native/channel.ts';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; }
async function fixture(firstText = '第一章 登记\n甲厂数量为3。\n第二章 未读\n甲厂后续标记。') {
  const originals = await Promise.all([importBook('工程甲', firstText), importBook('工程乙', '第一章 登记\n乙厂数量为9。\n第二章 未读\n乙厂后续标记。')]);
  const state = initialState(); state.books = originals;
  for (const book of state.books) { book.position = book.chapters[1].start; book.known = [{ start: 0, end: book.position }]; }
  state.settings.services[0].enabled = true;
  const disk = new Map<string, string>(); let saved: State | null = null;
  const reads: string[] = [], messages: string[] = [];
  const controls: { beforeRead?: (version: string) => Promise<void> } = {};
  const request: NativeRequest = async <T>(method: string, payload: any): Promise<T> => {
    if (method === 'putBookText') { assert.equal(createHash('sha256').update(payload.text).digest('hex'), payload.version); disk.set(payload.version, payload.text); return null as T; }
    if (method === 'saveState') { saved = structuredClone(payload); return null as T; }
    if (method === 'loadState') return structuredClone(saved) as T;
    if (method === 'readBookText') { reads.push(payload.version); await controls.beforeRead?.(payload.version); return disk.get(payload.version) as T; }
    throw new Error(method);
  };
  const first = new NativeStore(request); await first.save(state);
  const store = new NativeStore(request), loaded = (await store.load())!;
  const model: ModelPort = { async complete(_service, input) { messages.push(JSON.stringify(input)); return { content: JSON.stringify({ reply: '工程核对完成。', thoughts: [], wantsLong: false }), input: 1, output: 1, estimated: false, elapsedMs: 1 }; } };
  const engine = new ReadingEngine(loaded, store, model), runtime = new ReadingRuntime(engine, { available: false, async request() { throw new Error('unused'); } });
  const app = new LocalApplication(runtime, async () => { throw new Error('unused'); });
  return { engine, runtime, app, reads, messages, originals, controls, disk };
}

test('多书启动只载元数据；读取、定位和切书按需装入，日常快照仍保留真实长度', async () => {
  const f = await fixture(), [a,b] = f.engine.state.books;
  assert.deepEqual(f.reads, []); assert.ok(f.engine.state.books.every(b => b.text === ''));
  assert.equal(f.app.snapshot.state.books[0].textLength, f.originals[0].text.length);
  assertReadable(a, a.known[0]); assert.throws(() => readText(a, a.known[0]), /尚未载入/); assert.throws(() => searchText(a, '数量'), /尚未载入/);
  await assert.rejects(f.engine.setKnown(a.id, bookLength(a) + 1), /范围无效/);
  await f.engine.startReading(a.id); assert.equal(a.text, f.originals[0].text); assert.equal(b.text, '');
  await f.engine.startReading(b.id); assert.equal(a.text, ''); assert.equal(b.text, f.originals[1].text);
  await f.engine.withOriginal(a.id, async book => { assert.equal(book.text, f.originals[0].text); await f.engine.persist(); assert.ok(b.text); });
  assert.equal(a.text, ''); assert.ok(b.text);
  await f.engine.ask(b.id, '数量是多少'); assert.equal(f.messages.length, 1); assert.ok(!f.messages[0].includes('甲厂')); assert.ok(!f.messages[0].includes('乙厂后续标记'));
  f.runtime.dispose();
});

test('迟到的原文读取在切书后退出，正在读的新书和已读边界保持有效', async () => {
  const f = await fixture(), [a,b] = f.engine.state.books, entered = deferred(), release = deferred();
  f.controls.beforeRead = async version => { if (version === a.version) { entered.resolve(); await release.promise; } };
  const first = f.engine.startReading(a.id); const cancelled = assert.rejects(first, { name: 'AbortError' }); await entered.promise;
  await f.engine.startReading(b.id); release.resolve(); await cancelled;
  assert.equal(a.text, ''); assert.ok(b.text); assert.equal(f.engine.session?.bookId, b.id); assert.deepEqual(b.known, f.originals[1].known);
  f.runtime.dispose();
});

test('旧书首次迁移遇到切书，先按完整原文识别简介再释放，不能把已释放的空文本认成没有简介', async () => {
  const f = await fixture('内容简介：\n后文工程结局标记。\n第一章 登记\n甲厂数量为3。\n第二章 变更\n甲厂数量为5。');
  const [a,b] = f.engine.state.books, entered = deferred(), release = deferred(); delete a.frontMatterEnd;
  f.controls.beforeRead = async version => { if (version === a.version) { entered.resolve(); await release.promise; } };
  const opening = f.engine.startReading(a.id), cancelled = assert.rejects(opening, { name: 'AbortError' });
  await entered.promise; await f.engine.startReading(b.id); release.resolve(); await cancelled;
  assert.equal(a.frontMatterEnd, f.originals[0].frontMatterEnd); assert.ok(a.frontMatterEnd! > 0);
  assert.equal(a.text, ''); assert.deepEqual(a.known, []); assert.ok(b.text); f.runtime.dispose();
});

test('原文加载失败保存问题供重试；长度异常不会进入模型，修复后沿用原问题', async () => {
  const f = await fixture(), a = f.engine.state.books[0];
  f.disk.set(a.version, '损坏');
  await assert.rejects(f.engine.ask(a.id, '数量是多少'), /长度校验/);
  assert.equal(f.messages.length, 0); assert.equal(f.engine.state.chats.length, 1); assert.equal(f.engine.state.chats[0].delivery, 'failed');
  assert.equal(a.text, ''); f.disk.set(a.version, f.originals[0].text);
  await f.engine.retryQuestion(f.engine.state.chats[0].id);
  assert.equal(f.engine.state.chats.length, 2); assert.equal(f.engine.state.chats[0].delivery, 'answered');
  f.runtime.dispose();
});

test('未载入的全文仍完整导出，恢复按正文重新计算长度，不把导出缓存留在书架', async () => {
  const f = await fixture(), [a,b] = f.engine.state.books;
  await f.engine.startReading(a.id);
  const raw = await f.app.command('exportBackup', false), exported = JSON.parse(raw);
  assert.equal(exported.books[0].text, f.originals[0].text); assert.equal(exported.books[1].text, f.originals[1].text);
  assert.ok(a.text); assert.equal(b.text, ''); assert.equal('secrets' in exported, false);
  exported.books[0].textLength = 1;
  const restored = await restoreBackup(JSON.stringify(exported), initialState()); assert.equal(bookLength(restored.books[0]), f.originals[0].text.length);
  assert.ok(restored.settings.services.every(s => !s.enabled)); f.runtime.dispose();
});
