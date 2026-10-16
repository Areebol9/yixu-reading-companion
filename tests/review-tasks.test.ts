import {ModelRequestError} from '../src/core/errors.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importBook } from '../src/core/books.ts';
import { evidence, forgetMemory } from '../src/core/context.ts';
import { ReadingEngine } from '../src/core/engine.ts';
import { initialState } from '../src/core/state.ts';
import { restoreReadingEngine } from '../src/core/runtime.ts';
import { restoreBackup } from '../src/core/backup.ts';
import { validateReviewTasks } from '../src/core/review-tasks.ts';
import type { ModelMessage, ModelPort, State, Store } from '../src/core/types.ts';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function reply(messages: ModelMessage[]) {
  const input = JSON.parse(messages[1].content);
  return { content: JSON.stringify({ items: [{ id: 'm0', text: input.candidates[0].text, sourceIds: [input.sources.find((s: any) => s.text.includes('设备')).id], reason: '与原文一致' }] }), input: 5, output: 6, estimated: false, elapsedMs: 1 };
}
async function fixture(complete: ModelPort['complete'] = async (_s,m) => reply(m)) {
  const state = initialState(), book = await importBook('工程记录', '第一章\n设备甲登记3件。\n设备乙登记7件。\n第二章\nUNREAD-TASK');
  book.known = [{ start: 0, end: book.chapters[0].end }]; book.position = book.chapters[0].end; state.books = [book]; state.settings.services[0].enabled = true;
  state.memories = ['设备甲登记3件。','设备乙登记7件。'].map((text,i) => ({ id: 'fact-'+i, bookId: book.id, partnerId: state.partnerId, kind: 'story', text, evidence: [evidence(book, book.known[0])], source: 'preparation', parents: [], chatIds: [], forgotten: false, createdAt: 1 }));
  let saved = structuredClone(state); const snapshots: State[] = [];
  const store: Store = { async load() { return structuredClone(saved); }, async save(next) { saved = structuredClone(next); snapshots.push(saved); } };
  return { state, book, store, snapshots, saved: () => saved, engine: new ReadingEngine(state, store, { complete }) };
}

test('进程中断后核对逐条接续，修订与进度同时保存，重启不发请求也不新建共读', async () => {
  const entered = deferred(); let calls = 0;
  const f = await fixture(async (_s,m,signal) => {
    calls++; if (calls === 2) { entered.resolve(); await new Promise((_,reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
    return reply(m);
  });
  const work = f.engine.reviewFacts(f.book.id), stopped = assert.rejects(work, ModelRequestError); await entered.promise;
  const crash = structuredClone(f.saved()), taskId = crash.tasks![0].id;
  assert.equal(crash.tasks![0].items[0].status, 'reviewed'); assert.equal(crash.tasks![0].items[1].status, 'pending');
  assert.equal(crash.tasks![0].status, 'running'); assert.equal(crash.usage[1].status, 'reserved'); assert.equal(crash.usage[1].taskId, taskId);
  assert.equal(crash.conversations.length, 0); assert.equal(f.engine.session, undefined); assert.equal(crash.resume, undefined);
  for (const snapshot of f.snapshots) for (const item of snapshot.tasks?.[0].items ?? []) {
    assert.equal(!!snapshot.memories.find(m => m.correctionOf === item.memoryId), item.status === 'reviewed');
  }
  f.engine.pause(); await stopped;
  let resumedCalls = 0, saved = crash;
  const restored = await restoreReadingEngine({ async load() { return crash; }, async save(s) { saved = structuredClone(s); } }, { async complete(_s,m) { resumedCalls++; assert.equal(JSON.parse(m[1].content).candidates[0].text, '设备乙登记7件。'); return reply(m); } });
  assert.equal(resumedCalls, 0); assert.equal(restored.recovery.interruptedTasks, 1); assert.equal(saved.usage[1].status, 'unknown');
  await assert.rejects(restored.engine.resumeFactReview(taskId));
  assert.equal(resumedCalls, 0); assert.equal(saved.tasks![0].status, 'interrupted'); assert.equal(saved.conversations.length, 0); assert.equal(saved.usage.length, 2);
  validateReviewTasks(saved); restored.engine.stop();
});

test('核对可读取非共读书籍的延迟原文，不改变当前共读或制造共同经历', async () => {
  const f = await fixture(), other = await importBook('另一本', '第一章\nOTHER-BOOK-PRIVATE');
  other.known = [{ start: 0, end: other.text.length }]; other.position = other.text.length; f.state.books.push(other);
  const texts = new Map(f.state.books.map(b => [b.version,b.text]));
  for (const b of f.state.books) { b.textLength = b.text.length; b.text = ''; }
  let calls = 0;
  const engine = new ReadingEngine(f.state, { ...f.store, async readBookText(version) { return texts.get(version)!; } }, { async complete(_s,m) { calls++; assert.ok(!JSON.stringify(m).includes('OTHER-BOOK-PRIVATE')); return reply(m); } });
  await engine.startReading(other.id); const conversationId = engine.session!.id, resume = structuredClone(f.state.resume);
  await engine.reviewFacts(f.book.id);
  assert.equal(calls, 2); assert.equal(f.book.text, ''); assert.equal(engine.session!.bookId, other.id); assert.equal(engine.session!.id, conversationId);
  assert.deepEqual(f.state.resume, resume); assert.equal(f.state.conversations.length, 1); assert.equal(f.state.chats.length, 0); engine.stop();
});

test('中断后遗忘或权限变化的条目跳过，取消剩余任务不撤销已保存修订', async () => {
  const entered = deferred(); let calls = 0;
  const f = await fixture(async (_s,m,signal) => { calls++; if (calls === 2) { entered.resolve(); await new Promise((_,reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } return reply(m); });
  const work = f.engine.reviewFacts(f.book.id), stopped = assert.rejects(work, ModelRequestError); await entered.promise; f.engine.pause(); await stopped;
  const task = f.state.tasks![0]; assert.equal(task.status, 'interrupted');
  const restricted = structuredClone(f.state); restricted.books[0].known = [{ start: 0, end: 3 }];
  const restrictedEngine = new ReadingEngine(restricted, f.store, { async complete() { throw new Error('must not read revoked text'); } });
  await restrictedEngine.resumeFactReview(task.id); assert.equal(restricted.tasks![0].items[1].status, 'skipped'); restrictedEngine.stop();
  forgetMemory(f.state, 'fact-1');
  const snapshot = JSON.stringify(f.state); await f.engine.resumeFactReview(task.id);
  assert.equal(calls, 2); assert.equal(task.status, 'complete'); assert.equal(task.items[1].status, 'skipped'); assert.equal(f.state.memories.filter(m => m.source === 'review').length, 1);
  const cancelled = await restoreBackup(snapshot, initialState()); cancelled.settings.services[0].enabled = true;
  const engine = new ReadingEngine(cancelled, f.store, { async complete() { throw new Error('must not call'); } });
  await engine.cancelFactReview(task.id); assert.equal(cancelled.tasks![0].status, 'cancelled');
  await assert.rejects(engine.resumeFactReview(task.id), /不能继续/); assert.equal(cancelled.memories.filter(m => m.source === 'review').length, 1);
  engine.stop(); f.engine.stop();
});

test('写盘失败不推进任务检查点，显式继续复用合法结果再处理下一条', async () => {
  const f = await fixture(); let fail = true, calls = 0;
  const engine = new ReadingEngine(f.state, { ...f.store, async save(s) { if (fail && s.memories.some(m => m.source === 'review')) throw new Error('disk unavailable'); await f.store.save(s); } }, { async complete(_s,m) { calls++; return reply(m); } });
  await assert.rejects(engine.reviewFacts(f.book.id), /disk unavailable/);
  const task = f.state.tasks![0]; assert.equal(task.status, 'interrupted'); assert.equal(task.stopReason, 'error'); assert.ok(task.items.every(i => i.status === 'pending'));
  assert.equal(f.state.usage[0].status, 'complete'); assert.equal(calls, 1); assert.equal(f.state.memories.length, 2);
  fail = false; await engine.resumeFactReview(task.id); assert.equal(calls, 2); assert.equal(task.status, 'complete'); engine.stop();
});

test('旧备份保留本地已完成的核对任务，伪造跨书记忆或已完成检查点被拒绝', async () => {
  const f = await fixture(); const before = JSON.stringify(f.state); await f.engine.reviewFacts(f.book.id);
  const restored = await restoreBackup(before, f.state); assert.equal(restored.tasks![0].status, 'complete'); validateReviewTasks(restored);
  const bad = structuredClone(f.state); bad.tasks![0].items[0].revisionId = 'invented';
  await assert.rejects(restoreBackup(JSON.stringify(bad), initialState()), /进度与实际修订不一致/);
  const pending = structuredClone(f.state); pending.tasks![0].items[0] = { memoryId: 'fact-0', status: 'pending' };
  await assert.rejects(restoreBackup(JSON.stringify(pending), initialState()), /已完成任务仍含未完成条目/);
  f.engine.stop();
});
