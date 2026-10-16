import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importBook } from '../src/core/books.ts';
import { correctMemory, evidence, forgetMemory, matchSourceQuote, usableMemories } from '../src/core/context.ts';
import { restoreBackup } from '../src/core/backup.ts';
import { ReadingEngine } from '../src/core/engine.ts';
import { initialState } from '../src/core/state.ts';
import { ReadingSources } from '../src/core/reading-sources.ts';
import { planMemories } from '../src/core/memory-plan.ts';
import type { ModelMessage } from '../src/core/types.ts';

const original = '设备甲又叫备用甲，登记数量为三件。';
async function fixture() {
  const state = initialState(), book = await importBook('引文工程记录', '第一章 登记\n' + original + '\n' + '已读设备记录。'.repeat(3000) + '\n当前位置已完成核对。\n第二章 未读\nFUTURE-QUOTE-SECRET');
  book.known = [{ start: 0, end: book.chapters[1].start }]; book.position = book.known[0].end; book.prepared = [...book.known];
  state.books = [book]; state.settings.services[0].enabled = true;
  return { state, book };
}

test('逐字短引只匹配获准且实际提供的原文，不拼接缺口、不猜重句位置', async () => {
  const { book } = await fixture(), start = book.text.indexOf(original), end = start + original.length;
  const quote = matchSourceQuote(book, [{ start, end }], original)!;
  assert.equal(quote.text, original); assert.deepEqual(quote.evidence, evidence(book, { start, end }));
  assert.equal(matchSourceQuote(book, [{ start: end, end: end + 20 }], original), undefined);
  assert.equal(matchSourceQuote(book, [{ start, end: start + 5 }, { start: start + 6, end }], original), undefined);
  assert.equal(matchSourceQuote(book, [{ start: book.position, end: book.text.length }], 'FUTURE-QUOTE-SECRET'), undefined);
  assert.equal(matchSourceQuote(book, book.known, '已读设备记录。已读设备记录。'), undefined);
  assert.equal(matchSourceQuote(book, [{ start, end }], original.replace('又叫','前身')), undefined);
});

test('工具回查所得短引随记忆保存并进入后续上下文，错误短引不触发额外模型请求', async () => {
  const { state, book } = await fixture(); let calls = 0; const requests: ModelMessage[][] = [];
  const engine = new ReadingEngine(state, { async load() { return state; }, async save() {} }, { async complete(_service, messages) {
    requests.push(messages); calls++;
    if (calls === 1) {
      assert.equal(JSON.stringify(messages).includes(original), false);
      return { content: JSON.stringify({ lookup: '设备甲' }), input: 10, output: 10, estimated: false, elapsedMs: 1 };
    }
    if (calls === 2) assert.ok(JSON.stringify(messages).includes(original));
    if (calls === 3) {
      const packet = JSON.parse(messages[1].content), source = packet.supportingReadings.find((r: any) => r.text.includes(original));
      assert.equal(source.text, original); assert.equal(source.start, book.text.indexOf(original));
      assert.ok(packet.memories.every((m: any) => m.quote === undefined));
      assert.equal(JSON.stringify(messages).includes('FUTURE-QUOTE-SECRET'), false);
    }
    return { content: JSON.stringify({ reply: '', thoughts: [{ kind: 'story', text: calls === 2 ? '设备甲和备用甲指同一设备。' : '设备登记已有另一条理解。', quote: calls === 2 ? original : '设备甲前身是备用甲，登记数量为三件。' }] }), input: 10, output: 10, estimated: false, elapsedMs: 1 };
  } },{original:'adaptive',memories:'selected'}); // Exercise citation transport independently of the current discussion selector.
  try {
    await engine.startReading(book.id); await engine.ask(book.id, '回查早先设备的别名。');
    assert.equal(calls, 2); assert.equal(state.memories[0].sourceQuote?.text, original);
    await engine.ask(book.id, '沿刚才的登记接着讨论。');
    assert.equal(calls, 3); assert.equal(state.memories[1].sourceQuote, undefined);
  } finally { engine.stop(); }
});

test('备份核对短引文本与位置，更正不继承旧引文，遗忘后原文短引也退出检索', async () => {
  const { state, book } = await fixture();
  const q = matchSourceQuote(book, book.known, original)!;
  const memory = { id: 'quoted-memory', bookId: book.id, partnerId: state.partnerId, kind: 'story' as const, text: '设备甲具有别名。', evidence: [evidence(book, book.known[0])], parents: [], chatIds: [], createdAt: 1, forgotten: false, source: 'reading' as const, sourceQuote: q };
  state.memories.push(memory);
  const restored = await restoreBackup(JSON.stringify(state), initialState());
  assert.deepEqual(restored.memories[0].sourceQuote, q);
  for (const mutate of [(s: typeof state) => { s.memories[0].sourceQuote!.text = '设备甲前身是备用甲。'; }, (s: typeof state) => { s.memories[0].sourceQuote!.evidence.bookId = 'other'; }]) {
    const invalid = structuredClone(state); mutate(invalid); await assert.rejects(restoreBackup(JSON.stringify(invalid), initialState()), /短引/);
  }
  const correction = correctMemory(state, memory.id, '这条理解需要再次核对。');
  assert.equal(correction.sourceQuote, undefined); assert.equal(memory.sourceQuote?.text, original);
  forgetMemory(state, correction.id); assert.equal(usableMemories(state, book).length, 0);
});

test('原文编号随当轮工具追加保持稳定，选择编号直接保存原文且不能指向未提供内容', async () => {
  const { state, book } = await fixture(), sources = new ReadingSources();
  const range = { start: 0, end: 850 }, rendered = sources.render(book, range);
  assert.equal(rendered.replace(/【p\d+】/g, '').replace(/\n/g, ''), book.text.slice(0, 850).replace(/\n/g, ''));
  assert.equal(sources.render(book, range), rendered);
  assert.ok([...sources.passages.values()].every(p => p.text.length <= 200 && p.text === book.text.slice(p.evidence.start, p.evidence.end)));
  const key = [...sources.passages].find(([,p]) => p.text.includes(original))![0];
  const input = { reply: '', thoughts: [{ kind: 'story' as const, text: '设备甲存在别名。', quoteSource: key }], wantsLong: false };
  const plan = planMemories(state, book, input, [evidence(book, range)], [], [], 'reading', undefined, [], [range], sources.passages);
  assert.deepEqual(plan.added[0].sourceQuote, sources.passages.get(key));
  const unknown = planMemories(state, book, { ...input, thoughts: [{ ...input.thoughts[0], quoteSource: 'p99999' }] }, [evidence(book, range)], [], [], 'reading', undefined, [], [range], sources.passages);
  assert.equal(unknown.added[0].sourceQuote, undefined);
  const count = sources.passages.size;
  sources.results(book, [{ source: '获准原文', text: book.text.slice(1000, 1400), start: 1000, end: 1400 }]);
  assert.ok(sources.passages.size > count); assert.equal(sources.render(book, range), rendered);
  assert.throws(() => sources.render(book, { start: book.position, end: book.text.length }), /允许阅读/);
});
