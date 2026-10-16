import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importBook, covers, normalize } from '../src/core/books.ts';
import { ReadingEngine } from '../src/core/engine.ts';
import { initialState } from '../src/core/state.ts';
import type { ModelMessage, ModelPort, Store } from '../src/core/types.ts';

const oldPage = '第一章 登记\n记录甲已经检查完毕，共三项，所有数量与编号均已登记在册。记录乙注明设备处于静止状态，后续安排另行通知。';
const holeStart = oldPage.indexOf('共三项'), holeEnd = holeStart + 4;
const skipped = '\nUNOBSERVED-GAP：未出现在阅读画面中的独立记录。\n';
const nextPage = '记录丙补充了新一批设备的清单，负责人已经签收，当前正在核实实际数量。随后记录丁明确此次检查仅限当前设备，其他项目仍需另行安排。';
const reply = () => ({ content: JSON.stringify({ reply: '', thoughts: [], wantsLong: false }), input: 10, output: 10, estimated: false, elapsedMs: 1 });
async function fixture(forward = false) {
  const state = initialState(), book = await importBook('阅读调度资料', oldPage + (forward ? '完成了。' : skipped + nextPage + '\nFUTURE-SECRET'));
  book.known = forward ? [{ start: 0, end: oldPage.length }] : [{ start: 0, end: holeStart }, { start: holeEnd, end: oldPage.length }];
  book.prepared = [...book.known]; book.position = oldPage.length; state.books = [book];
  state.settings.services[0].enabled = true; state.settings.minReadChars = 40;
  const requests: ModelMessage[][] = []; let saved = structuredClone(state);
  const store: Store = { async load() { return saved; }, async save(value) { saved = structuredClone(value); } };
  const model: ModelPort = { async complete(_service, messages) { requests.push(messages); return reply(); } };
  const engine = new ReadingEngine(state, store, model);
  await engine.startReading(book.id); engine.observing(true);
  return { state, book, engine, requests, saved: () => saved };
}

test('重读补进四字缺口不独立调用模型，后续新页与缺口合并且不跨过未读间隔', async () => {
  const f = await fixture();
  try {
    await f.engine.observe(f.book.id, oldPage);
    assert.equal(f.requests.length, 0); assert.equal(f.state.usage.length, 0);
    assert.ok(covers(f.saved().books[0].known, { start: holeStart, end: holeEnd }));
    assert.equal(covers(f.book.prepared, { start: holeStart, end: holeEnd }), false);
    await f.engine.observe(f.book.id, nextPage);
    assert.equal(f.requests.length, 1);
    const input = f.requests[0].flatMap(m => { try { return [JSON.parse(m.content)]; } catch { return []; } }).find(p => p.currentRange);
    assert.equal(normalize(input.current), normalize(nextPage));
    assert.ok(input.additionalReadings[0].text.includes('记录甲已经检查完毕，共三项'));
    assert.ok(input.additionalReadings[0].text.endsWith('登记在册。'));
    assert.ok(covers(f.book.prepared, { start: holeStart, end: holeEnd }));
    assert.equal(covers(f.book.known, { start: oldPage.length, end: oldPage.length + skipped.length }), false);
    assert.equal(JSON.stringify(f.requests).includes('UNOBSERVED-GAP'), false);
    assert.equal(JSON.stringify(f.requests).includes('FUTURE-SECRET'), false);
  } finally { f.engine.stop(); }
});

test('向前读到的短句仍在停顿后处理，不被历史缺口合并规则压住', { timeout: 5000 }, async () => {
  const f = await fixture(true);
  try {
    await f.engine.observe(f.book.id, f.book.text);
    assert.equal(f.requests.length, 1);
    const payload = JSON.parse(f.requests[0][1].content);
    assert.ok(payload.previousReadings.some((r: { text: string }) => r.text.includes('记录乙')));
    assert.ok(payload.current.length < 10);
    assert.ok(covers(f.book.prepared, { start: oldPage.length, end: f.book.text.length - 1 }));
  } finally { f.engine.stop(); }
});

test('收尾准备仍处理待合并的历史缺口，安静模式不额外生成发言', async () => {
  const f = await fixture();
  try {
    f.engine.quiet(true); await f.engine.observe(f.book.id, oldPage);
    assert.equal(f.requests.length, 0);
    await f.engine.finishReading(f.book.id);
    assert.equal(f.requests.length, 1); assert.equal(f.state.chats.length, 0);
    assert.ok(covers(f.book.prepared, { start: holeStart, end: holeEnd }));
  } finally { f.engine.stop(); }
});
