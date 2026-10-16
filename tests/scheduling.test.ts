import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importBook, covers, normalize } from '../src/core/books.ts';
import { ReadingEngine } from '../src/core/engine.ts';
import { initialState } from '../src/core/state.ts';
import type { ModelMessage, ModelPort, State, Store } from '../src/core/types.ts';

const pages = ['工程登记甲：设备AX共3件，登记编号为001。', '工程登记乙：设备BY共2件，登记编号为002。'];
const gap = 'UNOBSERVED-GAP-不得由跳页获得';
const future = 'UNREAD-FUTURE-不得由插话获得';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; }
function packet(reply = '', text?: string) { return { content: JSON.stringify({ reply, thoughts: text ? [{ kind: 'story', text }] : [] }), input: 10, output: 10, estimated: false, elapsedMs: 1 }; }
function fields(messages: ModelMessage[]) { return messages.flatMap(m => { try { return [JSON.parse(m.content)]; } catch { return []; } }); }
function task(messages: ModelMessage[]) { return fields(messages).find(m => m.task)?.task ?? 'preparation'; }
function untilAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const rejectAbort = () => reject(new DOMException('transport cancelled', 'AbortError'));
    if (signal.aborted) rejectAbort(); else signal.addEventListener('abort', rejectAbort, { once: true });
  });
}
function storage() { let saved: State | undefined; return { store: { async load() { return saved; }, async save(s: State) { saved = structuredClone(s); } } satisfies Store, latest: () => saved! }; }
async function fixture() {
  const state = initialState(), book = await importBook('调度工程资料', '第一章 登记\n' + pages[0] + '\n' + gap + '\n' + pages[1] + '\n第二章 未读\n' + future);
  book.position = book.text.indexOf(pages[0]); book.known = [{ start: 0, end: book.position }]; book.prepared = [...book.known];
  state.books = [book]; state.settings.services[0].enabled = true; state.settings.minReadChars = 1; state.settings.minReactionMs = 0;
  return { state, book };
}

test('明确问题取消在途理解，多个问题先处理，再接续全部已见片段且不填入跳过的间隔', { timeout: 4000 }, async () => {
  const { state, book } = await fixture(), entered = deferred(), answering = deferred(), releaseAnswer = deferred(), disk = storage();
  const tasks: string[] = []; let cancelled = false;
  const model: ModelPort = { async complete(service, messages, signal) {
    const current = task(messages); tasks.push(current);
    assert.equal(JSON.stringify(messages).includes(gap), false); assert.equal(JSON.stringify(messages).includes(future), false);
    if (tasks.length === 1) { entered.resolve(); try { return await untilAbort(signal); } finally { cancelled = signal.aborted; } }
    if (tasks.length === 2) {
      assert.equal(cancelled, true); assert.equal(book.prepared.some(r => r.end === book.position), false);
      answering.resolve(); await releaseAnswer.promise; return packet('编号002。');
    }
    if (current === 'conversation') return packet('登记2件。');
    const context = fields(messages).find(m => m.currentRange);
    const material = [context.current, ...(context.additionalReadings ?? []).map((r: { text: string }) => r.text)].join('\n');
    assert.ok(normalize(material).includes(normalize(pages[0]))); assert.ok(normalize(material).includes(normalize(pages[1])));
    assert.equal(fields(messages).some(m => m.undeliveredReadingReaction), false);
    return packet('旧内容的重复反应不应显示。', '甲设备3件，乙设备2件。');
  } };
  const engine = new ReadingEngine(state, disk.store, model); await engine.start(book.id); engine.observing(true);
  const reading = engine.observe(book.id, pages[0]); await entered.promise;
  const next = engine.observe(book.id, pages[1]);
  const first = engine.ask(book.id, '核对当前编号。'); await answering.promise;
  const second = engine.ask(book.id, '核对当前数量。'); releaseAnswer.resolve();
  await Promise.all([reading, next, first, second]);
  assert.deepEqual(tasks, ['reading', 'conversation', 'conversation', 'reading']);
  for (const page of pages) { const start = book.text.indexOf(page); assert.ok(covers(book.prepared, { start, end: start + page.length - 1 })); }
  assert.equal(covers(book.prepared, { start: book.text.indexOf(gap), end: book.text.indexOf(gap) + gap.length }), false);
  assert.equal(state.chats.filter(c => c.role === 'user').every(c => c.delivery === 'answered'), true);
  assert.equal(state.chats.filter(c => c.role === 'assistant').length, 2);
  assert.equal(state.usage[0].status, 'unknown'); assert.ok(state.usage[0].input > 0 && state.usage[0].output > 0);
  assert.equal(disk.latest().usage[0].status, 'unknown'); assert.equal(state.memories.length, 1); engine.stop();
});

for (const background of [false, true]) test(`${background ? '独立背景' : '前文'}准备让位后从未完成片段接续，已保存覆盖不重做`, { timeout: 4000 }, async () => {
  const state = initialState(), book = await importBook('分段准备工程资料', '第一章 工程记录\n' + '工程资料：设备登记及数量校验。'.repeat(640) + '\n第二章 未读\n' + future);
  const through = background ? 200 : book.text.indexOf('\n第二章');
  book.position = through; book.known = [{ start: 0, end: through }]; state.books = [book]; state.settings.services[0].enabled = true;
  const entered = deferred(), ranges: { start: number; end: number }[] = []; let calls = 0, cancelled = false;
  const model: ModelPort = { async complete(service, messages, signal) {
    calls++; const current = task(messages), context = fields(messages).find(m => m.currentRange);
    if (current === 'conversation') {
      assert.equal(cancelled, true); assert.equal(engine.progress?.done, 1);
      assert.equal(JSON.stringify(messages).includes(future), false);
      assert.deepEqual(book.known, [{ start: 0, end: through }]);
      return packet('当前登记仍需按原文核对。');
    }
    ranges.push(context.currentRange);
    if (ranges.length === 2) { entered.resolve(); try { return await untilAbort(signal); } finally { cancelled = signal.aborted; } }
    return packet('', '已处理工程片段' + context.currentRange.start);
  } };
  const disk = storage(), engine = new ReadingEngine(state, disk.store, model); await engine.start(book.id);
  const preparation = background ? engine.prepareBackground(book.id) : engine.prepare(book.id); await entered.promise;
  await engine.ask(book.id, '核对当前登记。'); await preparation;
  assert.equal(calls, background ? 5 : 4); assert.deepEqual(ranges[1], ranges[2]); assert.equal(ranges[0].start, 0); assert.equal(ranges[1].start, ranges[0].end);
  assert.ok(ranges[0].end <= 6000); assert.equal(book.text[ranges[0].end - 1], '。');
  assert.ok(covers(background ? book.backgroundPrepared! : book.prepared, { start: 0, end: background ? book.text.length : through }));
  assert.deepEqual(book.known, [{ start: 0, end: through }]); assert.equal(state.usage[1].status, 'unknown');
  assert.equal(state.memories.length, background ? 3 : 2); assert.equal(state.memories.every(m => m.kind !== 'shared'), true); engine.stop();
});

test('打断后的任务遇到切书不再恢复，旧问题与阅读结果都不能进入新书', { timeout: 4000 }, async () => {
  const { state, book } = await fixture(), entered = deferred(), answering = deferred(); let calls = 0;
  const other = await importBook('另一工程资料', '第一章 新登记\n另一批设备为9件。'); other.position = other.text.length; other.known = [{ start: 0, end: other.position }]; other.prepared = [...other.known]; state.books.push(other);
  const model: ModelPort = { async complete(service, messages, signal) {
    calls++; if (calls === 1) entered.resolve(); else answering.resolve(); return untilAbort(signal);
  } };
  const engine = new ReadingEngine(state, storage().store, model); await engine.start(book.id); engine.observing(true);
  const reading = engine.observe(book.id, pages[0]); const readingResult = reading.catch(e => e); await entered.promise;
  const question = engine.ask(book.id, '核对编号。'); const questionResult = question.catch(e => e); await answering.promise;
  await engine.start(other.id); await Promise.all([readingResult, questionResult]);
  assert.equal(calls, 2); assert.equal(engine.session?.bookId, other.id); assert.equal(state.memories.length, 0);
  assert.equal(state.chats.some(c => c.role === 'assistant'), false); assert.equal(state.chats[0].delivery, 'stopped'); engine.stop();
});

test('本地原子保存已开始时完成该保存再回应，不取消并重算已完成的理解', { timeout: 4000 }, async () => {
  const { state, book } = await fixture(), committing = deferred(), releaseSave = deferred(); let paused = false; const tasks: string[] = [];
  const store: Store = { async load() { return undefined; }, async save(s) {
    if (!paused && s.memories.length) { paused = true; committing.resolve(); await releaseSave.promise; }
  } };
  const model: ModelPort = { async complete(service, messages) { const current = task(messages); tasks.push(current); return current === 'reading' ? packet('', '设备AX已登记3件。') : packet('编号001。'); } };
  const engine = new ReadingEngine(state, store, model); await engine.start(book.id); engine.observing(true);
  const reading = engine.observe(book.id, pages[0]); await committing.promise;
  const question = engine.ask(book.id, '核对登记编号。'); releaseSave.resolve(); await Promise.all([reading, question]);
  assert.deepEqual(tasks, ['reading', 'conversation']); assert.equal(state.memories.length, 1);
  assert.equal(state.chats.filter(c => c.role === 'user').every(c => c.delivery === 'answered'), true); engine.stop();
});

test('新问题保存失败时保留失败状态，阅读理解仍可接续', { timeout: 4000 }, async () => {
  const { state, book } = await fixture(), entered = deferred(); let calls = 0, failed = false;
  const store: Store = { async load() { return undefined; }, async save(s) {
    if (!failed && s.chats.some(c => c.role === 'user')) { failed = true; throw new Error('模拟本地写入失败'); }
  } };
  const model: ModelPort = { async complete(service, messages, signal) { calls++; if (calls === 1) { entered.resolve(); return untilAbort(signal); } assert.equal(task(messages), 'reading'); return packet('', '工程登记理解已接续。'); } };
  const engine = new ReadingEngine(state, store, model); await engine.start(book.id); engine.observing(true);
  const reading = engine.observe(book.id, pages[0]); await entered.promise;
  const failure = engine.ask(book.id, '核对编号。').catch(e => e); await reading;
  assert.match((await failure).message, /写入失败/); assert.equal(state.chats[0].delivery, 'failed');
  assert.equal(calls, 2); assert.equal(state.memories.length, 1); engine.stop();
});
