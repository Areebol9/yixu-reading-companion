import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadingEngine } from '../src/core/engine.ts';
import { ReadingRuntime } from '../src/core/runtime.ts';
import { LocalApplication } from '../src/core/application.ts';
import { initialState } from '../src/core/state.ts';
import { importBook, readingStart } from '../src/core/books.ts';
import type { State } from '../src/core/types.ts';

const before = '登记记录甲：设备AX三件保存在甲柜，编号一至三。';
const current = '登记记录乙：设备AX三件已经转移至乙柜，数量未变。';
const next = '登记记录丙：设备AX三件检修完成，负责人已经签收。';
async function fixture() {
  const state = initialState(), book = await importBook('定位工程资料', '第一章 登记\n' + [before, current, next].join('\n') + '\n第二章 未读\nPOSITIONING-FUTURE-SENTINEL');
  state.books.push(book); state.settings.services[0].enabled = true; state.settings.minReadChars = 1;
  let saved: State | undefined;
  const messages: string[] = [], calls: { method: string; payload: any }[] = [];
  const store = { async load() { return saved; }, async save(s: State) { saved = structuredClone(s); } };
  const engine = new ReadingEngine(state, store, { async complete(_service, input) {
    const text = JSON.stringify(input); messages.push(text);
    assert.equal(text.includes('POSITIONING-FUTURE-SENTINEL'), false);
    assert.equal(text.includes('UNPREPARED-COMMENT'), false);
    return { content: JSON.stringify({ reply: '', thoughts: [], wantsLong: false }), input: 10, output: 5, estimated: false, elapsedMs: 1 };
  } });
  const runtime = new ReadingRuntime(engine, { available: true, async request<T>(method, payload) {
    calls.push({ method, payload }); return (method === 'readingSources' ? [{ id: 'qidian', installed: true }] : {}) as T;
  } });
  const app = new LocalApplication(runtime, async <T>() => ({} as T));
  const last = (method: string) => calls.filter(c => c.method === method).at(-1)?.payload;
  const observe = (text: string, kind = 'body') => runtime.receive('observation', { captureToken: last('startCapture').captureToken, sourceId: 'qidian', kind, text });
  return { app, engine, runtime, state, store, book, calls, messages, last, observe, saved: () => saved! };
}

test('首次定位不授权前文或调用模型，确认后准备并在同一采集会话接续新页', async () => {
  const f = await fixture();
  await f.app.command('startCapture', f.book.id, 'qidian');
  const token = f.last('startCapture').captureToken;
  assert.equal(f.last('readingStatus').ready, false);
  await f.observe(current);
  const location = f.app.snapshot.locatedPosition!;
  assert.equal(location.bookId, f.book.id); assert.ok(location.excerpt.includes('设备AX'));
  assert.equal(f.book.position, 0); assert.deepEqual(f.book.known, []); assert.deepEqual(f.book.prepared, []);
  assert.equal(f.messages.length, 0); assert.equal(f.state.usage.length, 0);
  assert.equal('locatedPosition' in f.saved(), false);
  assert.throws(() => { (location as any).position = f.book.text.length; }, TypeError);
  await assert.rejects(f.app.command('prepare', f.book.id), /确认已经读到/);
  await f.runtime.receive('source', { captureToken: token, sourceId: 'qidian', active: false });
  assert.equal(f.app.snapshot.locatedPosition?.id, location.id);
  await f.app.command('confirmLocatedPosition', f.book.id, location.id);
  assert.deepEqual(f.book.known, [{ start: readingStart(f.book), end: location.position }]);
  assert.equal(f.app.snapshot.locatedPosition, undefined); assert.equal(f.engine.session?.prepared, false);
  await f.observe('UNPREPARED-COMMENT', 'comment');
  await f.app.command('prepare', f.book.id);
  assert.equal(f.engine.session?.prepared, true); assert.ok(f.messages[0].includes(before)); assert.ok(f.messages[0].includes('转移至乙柜'));
  assert.equal(f.messages[0].includes(next), false); assert.deepEqual(f.book.prepared, f.book.known);
  await f.runtime.receive('source', { captureToken: token, sourceId: 'qidian', active: true });
  await f.observe(next);
  assert.equal(f.messages.length, 2); assert.ok(f.messages[1].includes('检修完成'));
  assert.equal(f.calls.filter(c => c.method === 'startCapture').length, 1);
  assert.equal(f.engine.session?.observing, true); assert.equal(f.app.snapshot.locatedPosition, undefined);
  f.runtime.dispose();
});

test('旧定位、错误来源、换书或暂停后不能借定位结果确认前文', async () => {
  const f = await fixture(); await f.app.command('startCapture', f.book.id, 'qidian');
  await f.observe(before); const old = f.app.snapshot.locatedPosition!;
  await f.runtime.receive('observation', { captureToken: 'old-capture', sourceId: 'qidian', text: next });
  assert.equal(f.app.snapshot.locatedPosition?.id, old.id);
  await f.observe(current); const currentLocation = f.app.snapshot.locatedPosition!;
  await assert.rejects(f.app.command('confirmLocatedPosition', f.book.id, old.id), /定位结果已更新/);
  assert.deepEqual(f.book.known, []);
  await f.observe('页面不属于已导入作品，无法在当前原文定位。');
  assert.equal(f.app.snapshot.locatedPosition, undefined);
  await assert.rejects(f.app.command('confirmLocatedPosition', f.book.id, currentLocation.id), /定位结果已更新/);
  await f.observe(current); const paused = f.app.snapshot.locatedPosition!;
  await f.app.command('pause');
  await assert.rejects(f.app.command('confirmLocatedPosition', f.book.id, paused.id), /定位结果已更新/);
  await f.app.command('startCapture', f.book.id, 'qidian'); await f.observe(current);
  const prior = f.app.snapshot.locatedPosition!;
  const other = await f.app.command('importText', '其他工程书', '第一章\n另一批设备登记在丙柜，尚待检修。');
  await f.app.command('selectBook', other.bookId);
  assert.equal(f.app.snapshot.locatedPosition, undefined);
  await assert.rejects(f.app.command('confirmLocatedPosition', f.book.id, prior.id), /定位结果已更新/);
  assert.equal(f.messages.length, 0); assert.deepEqual(f.book.known, []); f.runtime.dispose();
});

test('已有未完成前文可直接补齐，定位预览不改变原范围，重启只恢复已确认资料', async () => {
  const f = await fixture(), start = readingStart(f.book), firstEnd = f.book.text.indexOf(current), end = f.book.text.indexOf(next);
  await f.app.command('setKnown', f.book.id, end); f.book.prepared = [{ start, end: firstEnd }];
  await f.app.command('startCapture', f.book.id, 'qidian'); await f.observe(next);
  assert.equal(f.engine.session?.prepared, false); assert.equal(f.book.position, end);
  assert.deepEqual(f.book.known, [{ start, end }]);
  await f.app.command('prepare', f.book.id);
  assert.equal(f.messages.length, 1); assert.equal(f.messages[0].includes(next), false);
  assert.equal(f.engine.session?.prepared, true); assert.equal(f.app.snapshot.locatedPosition, undefined);
  const restored = new ReadingEngine(f.saved(), f.store, f.engine.model);
  await restored.startReading(f.book.id);
  assert.equal(restored.session?.prepared, true); assert.equal(restored.session?.observing, false);
  assert.deepEqual(restored.book(f.book.id).known, [{ start, end }]);
  restored.stop(); f.runtime.dispose();
});
