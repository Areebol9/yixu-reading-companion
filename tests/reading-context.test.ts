import { test } from 'node:test';
import assert from 'node:assert/strict';
import { covers, importBook } from '../src/core/books.ts';
import { evidence, precedingReadings } from '../src/core/context.ts';
import { ReadingEngine } from '../src/core/engine.ts';
import { initialState } from '../src/core/state.ts';
import type { Memory, ModelMessage } from '../src/core/types.ts';

test('衔接前文只选本次获准片段，排除本轮材料、未读空白、简介及后文并限制用量', async () => {
  const book = await importBook('衔接工程资料', 'B'.repeat(100) + 'A'.repeat(1700) + 'G'.repeat(100) + 'C'.repeat(500) + 'F'.repeat(400));
  book.frontMatterEnd = 100; book.frontMatterIncluded = false;
  book.known = [{ start: 0, end: 1800 }, { start: 1900, end: 2400 }];
  const before = structuredClone(book.known);
  const material = [{ start: 1600, end: 1700 }, { start: 2300, end: 2400 }];
  const ranges = precedingReadings(book, material);
  assert.ok(ranges.length > 1 && ranges.length <= 8);
  assert.ok(ranges.reduce((sum, r) => sum + r.end - r.start, 0) <= 1200);
  for (const range of ranges) {
    assert.ok(range.start >= 100 && range.end <= 2300 && covers(book.known, range));
    assert.equal(material.some(r => r.start < range.end && range.start < r.end), false);
  }
  assert.equal(ranges.map(r => book.text.slice(r.start, r.end)).join('').match(/[BGF]/), null);
  assert.deepEqual(book.known, before);
  // A long prior range remains bounded even without gaps; tiny fragments cannot add unbounded metadata.
  assert.equal(precedingReadings(book, [{ start: 1750, end: 1800 }]).reduce((n, r) => n + r.end - r.start, 0), 1200);
  book.known = Array.from({ length: 600 }, (_, i) => ({ start: i * 3 + 100, end: i * 3 + 101 }));
  assert.ok(precedingReadings(book, [{ start: 1900, end: 1901 }]).length <= 8);
});

test('短范围讨论直接取得完整获准原文，保留缺口，不以提供原文冒充已准备内容', async () => {
  const state = initialState();
  const prefix = '第一章 登记\nAX设备登记编号固定，当前负责资料核对。';
  const gap = '\nUNREAD-GAP\n';
  const page = '本页记录设备检查过程，操作员核实了编号与保存位置，相关资料可从此前登记内容查看。';
  const tail = '检查结束。';
  const book = await importBook('短增量工程资料', prefix + gap + page + tail + '\nFUTURE-SECRET');
  const pageStart = prefix.length + gap.length, end = pageStart + page.length;
  book.known = [{ start: 0, end: prefix.length }, { start: pageStart, end }];
  book.prepared = [{ start: pageStart, end }]; book.position = end;
  state.books = [book]; state.settings.services[0].enabled = true;
  const old: Memory = { id: 'ax-registration', bookId: book.id, partnerId: state.partnerId, kind: 'story', text: 'AX设备资料核对责任已明确。', evidence: [evidence(book, { start: 0, end: prefix.length })], parents: [], chatIds: [], createdAt: 1, forgotten: false, source: 'reading' };
  state.memories = [old, ...Array.from({ length: 42 }, (_, i) => ({ ...old, id: 'unrelated-' + i, text: '其他工作项目的记录编号' + i, createdAt: i + 10 }))];
  let request: ModelMessage[] = [];
  const engine = new ReadingEngine(state, { async load() { return state; }, async save() {} }, { async complete(_service, messages) {
    request = messages;
    return { content: JSON.stringify({ reply: '', thoughts: [{ kind: 'story', text: '设备检查已经结束。', basis: { memoryIds: [], chatIds: [] } }] }), input: 10, output: 10, estimated: false, elapsedMs: 1 };
  } });
  try {
    await engine.startReading(book.id);
    // Preparation is deliberately incomplete: a direct question still needs all permitted context.
    await engine.ask(book.id, '核对当前记录。');
    const payload = JSON.parse(request[1].content);
    assert.equal(payload.originalMode, 'complete-permitted-text');
    assert.ok([payload.current, ...(payload.additionalReadings ?? []).map((r: { text: string }) => r.text)].some(text => text.includes('AX设备')));
    assert.equal(payload.memories.some((m: { text: string }) => m.text === old.text), false);
    assert.equal(JSON.stringify(request).includes('UNREAD-GAP'), false);
    assert.equal(JSON.stringify(request).includes('FUTURE-SECRET'), false);
    assert.deepEqual(book.prepared, [{ start: pageStart, end }]);
    assert.deepEqual(book.known, [{ start: 0, end: prefix.length }, { start: pageStart, end }]);
    assert.ok(state.memories.at(-1)!.evidence.some(r => r.start === 0 && r.end === prefix.length));
  } finally { engine.stop(); }
});

test('临时许可可以提供其获准前文，结束后不留在通常阅读语境', async () => {
  const book = await importBook('临时语境工程', 'X'.repeat(200) + 'F'.repeat(200));
  book.known = [{ start: 0, end: 100 }];
  const material = [{ start: 300, end: 310 }];
  assert.deepEqual(precedingReadings(book, material, [{ start: 200, end: 310 }]), [{ start: 0, end: 100 }, { start: 200, end: 300 }]);
  assert.deepEqual(precedingReadings(book, material), [{ start: 0, end: 100 }]);
  assert.deepEqual(book.known, [{ start: 0, end: 100 }]);
});
