import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importBook } from '../src/core/books.ts';
import { correctMemory, forgetMemory, isCurrentMemory, usableMemories } from '../src/core/context.ts';
import { initialState } from '../src/core/state.ts';
import { ReadingEngine } from '../src/core/engine.ts';
import { ChatModel } from '../src/core/model.ts';
import { restoreBackup } from '../src/core/backup.ts';
import type { Memory, ModelMessage, ModelPort, ModelReply, State } from '../src/core/types.ts';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; }
function reviewed(messages: ModelMessage[], text: string | null = '设备甲共有3件。'): ModelReply {
  const payload = JSON.parse(messages[1].content), source = payload.sources.find((s: any) => s.text.includes('设备甲共有3件'));
  return { content: JSON.stringify({ items: [{ id: 'm0', text, sourceIds: text === null ? [] : [source.id], reason: '核对数量' }] }), input: 7, output: 8, estimated: false, elapsedMs: 1 };
}
async function fixture(complete: ModelPort['complete'] = async (_s,m) => reviewed(m)) {
  const state = initialState(), book = await importBook('工程事实', '第一章 登记\n设备甲共有3件。\n设备乙共有7件。\n第二章 未读\nFUTURE-MARKER');
  book.position = book.chapters[0].end; book.known = [{ start: 0, end: book.position }]; book.prepared = [...book.known]; state.books = [book]; state.settings.services[0].enabled = true;
  const evidence = [{ bookId: book.id, version: book.version, ...book.known[0] }];
  const original: Memory = { id: 'actual-original-record', bookId: book.id, partnerId: state.partnerId, kind: 'story', text: '设备甲有4件。', evidence, parents: [], chatIds: [], createdAt: 1, forgotten: false, source: 'preparation' };
  const dependent: Memory = { ...original, id: 'dependent', kind: 'opinion', text: '四件需要更多空间。', parents: [original.id], basis: { memoryIds: [original.id], chatIds: [] } };
  state.memories = [original, dependent];
  state.chats = [{ id: 'old-reply', bookId: book.id, sessionId: 'history', role: 'assistant', text: '按四件安排。', evidence, createdAt: 2, excluded: false, memoryIds: [original.id] }];
  state.conversations = [{ id: 'history', bookId: book.id, title: '工程记录', start: 0, end: book.position, manualTitle: false, createdAt: 1 }];
  const writes: State[] = [], controls = { failRevision: false };
  const engine = new ReadingEngine(state, { async load() { return state; }, async save(next) {
    if (controls.failRevision && next.memories.some(m => m.source === 'review')) throw new Error('写盘失败'); writes.push(structuredClone(next));
  } }, { complete });
  return { engine, state, book, original, dependent, writes, controls };
}

test('事实核对先保存后发布，旧事实与相关判断退出，真实历史及完整遗忘关系保留', async () => {
  const f = await fixture(); const result = await f.engine.reviewFacts(f.book.id);
  assert.deepEqual(result, { reviewed: 1, unsupported: 0 });
  const replacement = f.state.memories.find(m => m.id === f.original.replacedBy)!;
  assert.equal(replacement.text, '设备甲共有3件。'); assert.equal(replacement.source, 'review'); assert.equal(replacement.correctionOf, f.original.id);
  assert.equal(replacement.reviewDisposition, 'supported'); assert.ok(isCurrentMemory(replacement));
  assert.equal(replacement.sourceQuote?.text, '设备甲共有3件。');
  assert.equal(f.book.text.slice(replacement.sourceQuote!.evidence.start, replacement.sourceQuote!.evidence.end), replacement.sourceQuote?.text);
  assert.ok(!isCurrentMemory(f.dependent)); assert.ok(f.state.chats[0].outdatedBy); assert.equal(f.state.chats[0].text, '按四件安排。');
  assert.ok(f.writes.some(s => s.memories.some(m => m.id === replacement.id))); assert.equal(f.state.usage[0].status, 'complete');
  forgetMemory(f.state, f.original.id); assert.equal(replacement.forgotten, true); assert.deepEqual(usableMemories(f.state, f.book), []); f.engine.stop();
});

test('不能由本轮原文支持的事实保留历史但退出输入，用户明确更正可以恢复为用户记录', async () => {
  const f = await fixture(async (_s,m) => reviewed(m, null)); await f.engine.reviewFacts(f.book.id);
  const suspended = f.state.memories.find(m => m.id === f.original.replacedBy)!;
  assert.equal(suspended.reviewDisposition, 'unsupported'); assert.equal(suspended.text, f.original.text); assert.ok(!isCurrentMemory(suspended));
  const correction = correctMemory(f.state, suspended.id, suspended.text);
  assert.ok(isCurrentMemory(correction)); assert.equal(correction.source, 'correction'); assert.equal(correction.reviewDisposition, undefined); f.engine.stop();
});

test('核对写盘失败或期间结束会话，均不发布替换记录', async () => {
  const f = await fixture(); f.controls.failRevision = true;
  await assert.rejects(f.engine.reviewFacts(f.book.id), /写盘失败/); assert.equal(f.original.replacedBy, undefined); assert.equal(f.state.memories.length, 2); assert.equal(f.state.usage[0].status, 'complete'); f.engine.stop();
  const entered = deferred(), release = deferred();
  const other = await fixture(async (_s,m) => { entered.resolve(); await release.promise; return reviewed(m); });
  const job = other.engine.reviewFacts(other.book.id), rejected = assert.rejects(job, { name: 'AbortError' });
  await entered.promise; other.engine.stop(); release.resolve(); await rejected;
  assert.equal(other.original.replacedBy, undefined); assert.equal(other.state.memories.length, 2);
});

test('重复核对合并为同一项工作，旧备份不能复活已修订事实或取消暂不采用状态', async () => {
  const entered = deferred(), release = deferred(); let calls = 0;
  const f = await fixture(async (_s,m) => { calls++; entered.resolve(); await release.promise; return reviewed(m, null); });
  const backup = JSON.stringify(f.state), a = f.engine.reviewFacts(f.book.id), b = f.engine.reviewFacts(f.book.id);
  await entered.promise; release.resolve(); await Promise.all([a,b]); assert.equal(calls, 1);
  const restored = await restoreBackup(backup, f.state), old = restored.memories.find(m => m.id === f.original.id)!;
  assert.ok(old.replacedBy); assert.equal(restored.memories.find(m => m.id === old.replacedBy)!.reviewDisposition, 'unsupported');
  assert.deepEqual(usableMemories(restored, restored.books[0]), []); f.engine.stop();
});

test('核对拒绝越界事实、用户更正和伪造的来源，未读原文不会进入请求', async () => {
  const f = await fixture(async (_s,m) => {
    assert.ok(!JSON.stringify(m).includes('FUTURE-MARKER'));
    return { ...reviewed(m), content: JSON.stringify({ items: [{ id: 'm0', text: '坏资料', sourceIds: ['p999'], reason: '伪造' }] }) };
  });
  const outside = { ...f.original, id: 'future', evidence: [{ ...f.original.evidence[0], start: f.book.position, end: f.book.text.length }] };
  f.state.memories.push(outside);
  await assert.rejects(f.engine.reviewFacts(f.book.id, outside.id), /不能按原文核对/); assert.equal(f.state.usage.length, 0);
  await assert.rejects(f.engine.reviewFacts(f.book.id, f.original.id), /身份或来源无效/); assert.equal(f.original.replacedBy, undefined); f.engine.stop();
});

test('输出截止后保留服务商已返回的实际用量，不丢失账本或自动切换备用', async () => {
  const f = await fixture(); let calls = 0; f.state.settings.services[1].enabled = true; f.state.settings.services[1].fallback = true;
  f.engine.model = new ChatModel(async () => { calls++; return { status: 200, body: { choices: [{ finish_reason: 'length', message: { content: '' } }], usage: { prompt_tokens: 123, completion_tokens: 4096 } } }; });
  await assert.rejects(f.engine.reviewFacts(f.book.id), /输出达到长度上限/);
  assert.equal(calls, 1); assert.equal(f.state.usage[0].input, 123); assert.equal(f.state.usage[0].output, 4096); assert.equal(f.state.usage[0].estimated, false); assert.equal(f.state.usage[0].status, 'complete');
  assert.equal(f.original.replacedBy, undefined); f.engine.stop();
});

test('核对让位于读者问题，完成问题后继续同一条事实，不提交被取消的旧结果', async () => {
  const entered = deferred(), calls: string[] = []; let first = true;
  const f = await fixture(async (_s,m,signal) => {
    const payload = JSON.parse(m[1].content);
    if (payload.candidates) {
      calls.push('review');
      if (first) { first = false; entered.resolve(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
      return reviewed(m);
    }
    calls.push('question'); return { content: JSON.stringify({ reply: '当前原文登记3件。', thoughts: [], wantsLong: false }), input: 2, output: 3, estimated: false, elapsedMs: 1 };
  });
  const work = f.engine.reviewFacts(f.book.id); await entered.promise;
  await Promise.all([work, f.engine.ask(f.book.id, '现在几件？')]);
  assert.deepEqual(calls, ['review','question','review']); assert.equal(f.state.usage[0].status, 'unknown');
  assert.equal(f.state.memories.filter(m => m.source === 'review').length, 1); assert.equal(f.state.chats.filter(c => c.role === 'user').length, 1);
  assert.equal(f.state.chats.find(c => c.role === 'user')?.delivery, 'answered'); f.engine.stop();
});
