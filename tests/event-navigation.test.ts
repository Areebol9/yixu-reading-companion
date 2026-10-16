import test from 'node:test';
import assert from 'node:assert/strict';
import { importBook } from '../src/core/books.ts';
import { initialState } from '../src/core/state.ts';
import { searchOriginalHistory } from '../src/core/context.ts';
import { readOriginalBatch, searchOriginalHistoryBatch } from '../src/core/event-navigation.ts';
import { searchMemories } from '../src/core/recall.ts';
import type { Memory } from '../src/core/types.ts';

test('同轮早晚事件查询各保原请求、字句、来源及续页，权限或条件变化拒绝旧cursor', async () => {
  const original = Array.from({ length: 14 }, (_, i) => `ENGINE MOCK history event record ${i}. ${'x'.repeat(440)}\n`).join('');
  const book = await importBook('ENGINE MOCK event navigation', original + 'UNREAD SECRET history event');
  book.frontMatterIncluded = true; book.known = [{ start: 0, end: original.length }];
  const early = { query: 'history event', order: 'source-asc' as const };
  const later = { query: 'history event', order: 'source-desc' as const };
  const batch = searchOriginalHistoryBatch(book, [early, later, early]);
  assert.equal(batch.groups.length, 3);
  for (const [index, group] of batch.groups.entries()) {
    assert.equal(group.requestIndex, index);
    assert.deepEqual(group.request, [early, later, early][index]);
    const { requestIndex, request, ...page } = group;
    assert.deepEqual(page, searchOriginalHistory(book, request));
    for (const item of group.items) {
      assert.equal(item.text, book.text.slice(item.evidence.start, item.evidence.end));
      assert.ok(item.evidence.end <= original.length);
      assert.ok(!item.text.includes('UNREAD SECRET'));
    }
  }
  assert.ok(batch.groups[0].items[0].evidence.start < batch.groups[1].items[0].evidence.start);
  const cursor = batch.groups[0].nextCursor!;
  const continuation = searchOriginalHistoryBatch(book, [{ ...early, cursor }]);
  assert.ok(!continuation.groups[0].items.some(item => batch.groups[0].items.some(previous => item.evidence.start === previous.evidence.start)));
  for (const changed of [{ ...early, cursor, query: 'record' }, { ...later, cursor }, { ...early, cursor, range: { start: 0, end: 2000 } }]) {
    assert.throws(() => searchOriginalHistoryBatch(book, [changed]), /条件或权限/);
  }
  book.version = 'changed-version';
  assert.throws(() => searchOriginalHistoryBatch(book, [{ ...early, cursor }]), /条件或权限/);
  book.version = batch.groups[0].items[0].evidence.version;
  book.known = [{ start: 0, end: 500 }, { start: 1000, end: original.length }];
  assert.throws(() => searchOriginalHistoryBatch(book, [{ ...early, cursor }]), /条件或权限/);
  const scoped = searchOriginalHistoryBatch(book, [{ query: 'history event', range: { start: 490, end: 1600 } }]);
  assert.ok(scoped.groups[0].items.every(item => item.evidence.end <= 500 || item.evidence.start >= 1000));
  assert.throws(() => searchOriginalHistoryBatch(book, []), /1 至 3/);
  assert.throws(() => searchOriginalHistoryBatch(book, [early, early, early, early]), /1 至 3/);
});

test('批量展开原文各段独立保坐标，拒绝许可空洞与超预算；临时许可仍须实际覆盖', async () => {
  const book = await importBook('ENGINE MOCK original batches', 'a'.repeat(6000) + 'PRIVATE GAP' + 'b'.repeat(12000));
  book.frontMatterIncluded = true; book.known = [{ start: 0, end: 6000 }, { start: 6011, end: book.text.length }];
  const ranges = [{ start: 6011, end: 12011 }, { start: 0, end: 6000 }, { start: 12011, end: 16011 }];
  const batch = readOriginalBatch(book, ranges);
  assert.equal(batch.totalChars, 16000);
  for (const [index, item] of batch.items.entries()) {
    assert.equal(item.requestIndex, index); assert.deepEqual(item.range, ranges[index]);
    assert.equal(item.text, book.text.slice(item.range.start, item.range.end));
    assert.deepEqual(item.evidence, { ...ranges[index], bookId: book.id, version: book.version });
    assert.ok(!item.text.includes('PRIVATE GAP'));
  }
  assert.throws(() => readOriginalBatch(book, [{ start: 5990, end: 6020 }]), /允许阅读/);
  assert.throws(() => readOriginalBatch(book, [{ start: 5990, end: 6020 }], [{ start: 6000, end: 6005 }]), /允许阅读/);
  assert.equal(readOriginalBatch(book, [{ start: 5990, end: 6020 }], [{ start: 6000, end: 6011 }]).items[0].text, book.text.slice(5990, 6020));
  assert.throws(() => readOriginalBatch(book, [{ start: 0, end: 6001 }]), /6000/);
  assert.throws(() => readOriginalBatch(book, [ranges[0], ranges[1], { start: 12011, end: 18011 }]), /16000/);
  assert.throws(() => readOriginalBatch(book, [{ start: -1, end: 1 }]), /有效坐标/);
  assert.throws(() => readOriginalBatch(book, []), /1 至 4/);
  assert.throws(() => readOriginalBatch(book, Array(5).fill({ start: 0, end: 1 })), /1 至 4/);
});

async function recallFixture() {
  const state = initialState(), book = await importBook('ENGINE MOCK opinion batches', '第一章 已读\nENGINE MOCK permitted text.\n第二章 未读\nENGINE MOCK future text.');
  book.frontMatterIncluded = true; book.known = [{ start: 0, end: book.chapters[0].end }]; state.books = [book];
  const base: Memory = { id: 'a', bookId: book.id, partnerId: state.partnerId, kind: 'opinion', text: 'a'.repeat(7000), source: 'reading', evidence: [{ bookId: book.id, version: book.version, ...book.known[0] }], parents: [], chatIds: [], createdAt: 1, forgotten: false };
  state.memories = ['a', 'b', 'c', 'd'].map((id, index) => ({ ...base, id, text: id.repeat(7000), createdAt: index + 1 }));
  return { state, book, base, scope: { opinionNavigation: {} } };
}

test('显式完整看法按请求顺序一次取多稿，24000预算余项可续，未获准编号明确未提供', async () => {
  const { state, book, base, scope } = await recallFixture();
  state.memories.push({ ...base, id: 'future', evidence: [{ ...base.evidence[0], ...book.chapters[1] }] }, { ...base, id: 'forgotten', forgotten: true });
  const ids = ['b', 'a', 'future', 'd', 'forgotten', 'c', 'missing'];
  const first = searchMemories(state, book, { ids, kind: 'opinion', view: 'full' }, [], 'conversation', 'companion', scope);
  assert.deepEqual(first.items.map(item => item.id), ['b', 'a', 'd']);
  assert.deepEqual(first.items.map(item => item.text), ['b'.repeat(7000), 'a'.repeat(7000), 'd'.repeat(7000)]);
  assert.equal(first.total, 4); assert.equal(first.nextOffset, 3); assert.deepEqual(first.remainingIds, ['c']);
  assert.deepEqual(first.unavailableIds, ['future', 'forgotten', 'missing']);
  const next = searchMemories(state, book, { ids, kind: 'opinion', view: 'full', offset: first.nextOffset }, [], 'conversation', 'companion', scope);
  assert.deepEqual(next.items.map(item => item.id), ['c']); assert.deepEqual(next.remainingIds, []); assert.equal(next.nextOffset, undefined);
  const rest = searchMemories(state, book, { ids: first.remainingIds, view: 'full' }, [], 'conversation', 'companion', scope);
  assert.deepEqual(rest.items.map(item => item.id), ['c']);
});

test('首份超24000仍完整，余稿明确留待续页；普通index及旧查询仍原预算', async () => {
  const { state, book, scope } = await recallFixture();
  state.memories[0].text = 'ENGINE MOCK complete long opinion '.repeat(900);
  const first = searchMemories(state, book, { ids: ['a', 'b', 'c'], view: 'full' }, [], 'reading', 'companion', scope);
  assert.equal(first.items.length, 1); assert.equal(first.items[0].text, state.memories[0].text);
  assert.deepEqual(first.remainingIds, ['b', 'c']); assert.equal(first.nextOffset, 1);
  const legacy = searchMemories(state, book, { ids: ['b', 'c'], view: 'full' }, [], 'reading', 'companion');
  assert.equal(legacy.items.length, 1); assert.equal(legacy.remainingIds, undefined);
  const query = searchMemories(state, book, { kind: 'opinion', view: 'full' }, [], 'reading', 'companion', scope);
  assert.equal(query.items.length, 1); assert.equal(query.remainingIds, undefined);
  const index = searchMemories(state, book, { ids: ['b', 'c'], view: 'index' }, [], 'reading', 'companion', scope);
  assert.equal(index.items.length, 2); assert.equal(index.remainingIds, undefined);
});
