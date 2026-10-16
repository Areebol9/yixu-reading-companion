import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importBook, covers } from '../src/core/books.ts';
import { ReadingEngine } from '../src/core/engine.ts';
import { initialState } from '../src/core/state.ts';
import { restoreReadingEngine } from '../src/core/runtime.ts';
import { recoverInterruptedState } from '../src/core/startup.ts';
import { restoreBackup } from '../src/core/backup.ts';
import type { ModelPort, State, Store } from '../src/core/types.ts';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; }
function storage(initial?: State) {
  let disk = initial && structuredClone(initial);
  return { store: { async load() { return disk && structuredClone(disk); }, async save(s) { disk = structuredClone(s); } } satisfies Store, snapshot: () => structuredClone(disk!) };
}
function packet(text = '工程记录已核对。') { return { content: JSON.stringify({ reply: text, thoughts: [], wantsLong: false }), input: 10, output: 10, estimated: false, elapsedMs: 1 }; }
function untilAbort(signal: AbortSignal): Promise<never> { return new Promise((_, reject) => { const abort = () => reject(new DOMException('terminated', 'AbortError')); if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); }); }
async function fixture() {
  const state = initialState(), book = await importBook('重启工程资料', '第一章 已读\n设备AX登记3件。\n第二章 后续\nRESTART-FUTURE-SENTINEL');
  book.position = book.chapters[0].end; book.known = [{ start: 0, end: book.position }]; book.prepared = [...book.known]; state.books = [book]; state.settings.services[0].enabled = true;
  return { state, book };
}

test('进程在问题请求中终止：重启保留未知用量、不自动调用，接续同一条表达及原位置', { timeout: 4000 }, async () => {
  const { state, book } = await fixture(), disk = storage(), entered = deferred();
  const first = new ReadingEngine(state, disk.store, { async complete(s, m, signal) { entered.resolve(); return untilAbort(signal); } });
  await first.startReading(book.id); first.quiet(true);
  const asked = first.ask(book.id, '核对AX的登记数量。').catch(e => e); await entered.promise;
  const crash = disk.snapshot(), question = crash.chats[0]; assert.equal(question.delivery, 'pending'); assert.equal(crash.usage[0].status, 'reserved');
  first.stop(); await asked; // Old process writes cannot alter the captured crash image.
  const restartDisk = storage(crash); let calls = 0;
  const model: ModelPort = { async complete(s, messages) { calls++; assert.equal(JSON.stringify(messages).includes('RESTART-FUTURE-SENTINEL'), false); return packet(); } };
  const { engine, recovery } = await restoreReadingEngine(restartDisk.store, model);
  assert.equal(calls, 0); assert.equal(engine.session, undefined); assert.equal(recovery.questions, 1); assert.equal(recovery.unknownCalls, 1);
  assert.equal(restartDisk.snapshot().chats[0].delivery, 'failed'); assert.equal(restartDisk.snapshot().usage[0].status, 'unknown');
  assert.equal(engine.state.usage[0].input, crash.usage[0].input); assert.equal(engine.state.usage[0].output, crash.usage[0].output);
  await engine.startReading(book.id); assert.equal(engine.session?.id, question.sessionId); assert.equal(engine.session?.quiet, true); assert.equal(engine.session?.observing, false);
  await engine.retryQuestion(question.id);
  assert.equal(calls, 1); assert.equal(engine.state.chats.filter(c => c.role === 'user').length, 1); assert.equal(engine.state.chats[0].delivery, 'answered');
  assert.deepEqual(engine.state.chats[0].evidence, question.evidence); engine.stop();
});

test('临时后文授权不跨重启恢复，原问题保留但必须重新授权', { timeout: 4000 }, async () => {
  const { state, book } = await fixture(), entered = deferred(), disk = storage();
  const first = new ReadingEngine(state, disk.store, { async complete(s, m, signal) { entered.resolve(); return untilAbort(signal); } });
  const asked = first.askWithFuture(book.id, '有限评价后续资料。', book.chapters[1], true).catch(e => e); await entered.promise;
  const crash = disk.snapshot(); first.stop(); await asked;
  let calls = 0; const { engine, recovery } = await restoreReadingEngine(storage(crash).store, { async complete() { calls++; return packet(); } });
  assert.equal(recovery.temporaryQuestions, 1); assert.equal(engine.state.chats[0].delivery, 'stopped'); assert.equal(calls, 0);
  await assert.rejects(engine.retryQuestion(crash.chats[0].id), /完整阅读许可/); assert.equal(calls, 0); assert.equal(engine.state.chats[0].delivery,'stopped');assert.deepEqual(engine.state.chats[0].evidence,crash.chats[0].evidence);assert.deepEqual(engine.book(book.id).known, crash.books[0].known); engine.stop();
});

test('重启保留已提交准备片段，只补未完成部分，所有准备范围仍受已读权限限制', { timeout: 4000 }, async () => {
  const state = initialState(), book = await importBook('准备重启工程资料', '第一章 已读\n' + '工程记录数量核对。'.repeat(1050) + '\n第二章 未读\nUNREAD-PREPARATION');
  book.position = book.chapters[0].end; book.known = [{ start: 0, end: book.position }]; state.books = [book]; state.settings.services[0].enabled = true;
  const disk = storage(), entered = deferred(); let attempts = 0;
  const first = new ReadingEngine(state, disk.store, { async complete(s, m, signal) { attempts++; if (attempts === 2) { entered.resolve(); return untilAbort(signal); } return packet(''); } });
  await first.startReading(book.id); const preparing = first.prepare(book.id).catch(e => e); await entered.promise;
  const crash = disk.snapshot(), committedEnd = crash.books[0].prepared.at(-1)!.end;
  assert.ok(committedEnd > 5900 && committedEnd <= 6000); assert.equal(book.text[committedEnd - 1], '。'); first.stop(); await preparing;
  const ranges: { start: number; end: number }[] = [], { engine } = await restoreReadingEngine(storage(crash).store, { async complete(s, messages) { assert.equal(JSON.stringify(messages).includes('UNREAD-PREPARATION'), false); ranges.push(JSON.parse(messages[1].content).currentRange); return packet(''); } });
  assert.equal(ranges.length, 0); await engine.startReading(book.id); await engine.prepare(book.id);
  assert.equal(ranges.length, 1); assert.equal(ranges[0].start, committedEnd); assert.equal(ranges[0].end, book.position); assert.equal(engine.session?.prepared, true); engine.stop();
});

test('崩溃前经过的跳页范围可以补齐，重启不会授权未看到的间隔', { timeout: 4000 }, async () => {
  const state = initialState(), a = '工程记录甲：AX已经登记3件，记录号码001。', b = '工程记录乙：BY已经登记2件，记录号码002。', gap = 'MISSING-GAP-SHOULD-STAY-UNREAD';
  const book = await importBook('跳页重启', '第一章 登记\n' + a + '\n' + gap + '\n' + b + '\n第二章 未读\nUNREAD-END');
  book.position = book.text.indexOf(a); book.known = [{ start: 0, end: book.position }]; book.prepared = [...book.known]; state.books = [book]; state.settings.services[0].enabled = true; state.settings.minReadChars = 1;
  const disk = storage(), entered = deferred(), first = new ReadingEngine(state, disk.store, { async complete(s, m, signal) { entered.resolve(); return untilAbort(signal); } });
  await first.startReading(book.id); first.observing(true); const reading = first.observe(book.id, a).catch(e => e); await entered.promise;
  const next = first.observe(book.id, b).catch(e => e); await first.persist(); const crash = disk.snapshot(); first.stop(); await Promise.all([reading, next]);
  let calls = 0; const { engine } = await restoreReadingEngine(storage(crash).store, { async complete(s, messages) { calls++; assert.equal(JSON.stringify(messages).includes(gap), false); assert.equal(JSON.stringify(messages).includes('UNREAD-END'), false); assert.ok(JSON.stringify(messages).includes(a.slice(0,-1))); assert.ok(JSON.stringify(messages).includes(b.slice(0,-1))); return packet(''); } });
  await engine.startReading(book.id); await engine.prepare(book.id); assert.equal(calls, 1);
  assert.ok(engine.book(book.id).prepared.every(r => r.end <= book.text.indexOf(gap) || r.start >= book.text.indexOf(b))); engine.stop();
});

test('重启与备份恢复不重发已保存的答案，遗忘及更正后的待处理表达不能恢复', async () => {
  const { state, book } = await fixture(), disk = storage(), first = new ReadingEngine(state, disk.store, { async complete() { return packet(); } });
  await first.startReading(book.id); await first.ask(book.id, '核对已读数量。'); first.stop(); await first.persist();
  const complete = disk.snapshot(); complete.chats[0].delivery = 'pending'; // A legacy inconsistent snapshot already has its committed reply.
  const recovered = recoverInterruptedState(complete); assert.equal(complete.chats[0].delivery, 'answered'); assert.equal(recovered.questions, 0);
  assert.equal(recoverInterruptedState(complete).changed, false);
  const pending = structuredClone(state.chats[0]); pending.id = 'pending-forgotten'; pending.delivery = 'pending'; pending.excluded = true; complete.chats.push(pending);
  const corrected = { ...pending, id: 'pending-corrected', excluded: false, outdatedBy: 'revision' }; complete.chats.push(corrected);
  recoverInterruptedState(complete); assert.equal(pending.delivery, 'stopped'); assert.equal(corrected.delivery, 'stopped');
  const restored = await restoreBackup(JSON.stringify(complete), initialState());
  assert.equal(restored.chats[0].delivery, 'answered'); assert.equal(restored.chats[2].delivery, 'stopped'); assert.equal(restored.settings.services.some(s => s.enabled), false);
});

test('备份中的普通pending表达恢复为可手动接续，启动保存失败时不建立运行实例', async () => {
  const { state, book } = await fixture(); state.conversations.push({ id: 'previous', bookId: book.id, title: '工程讨论', manualTitle: false, start: 0, end: book.position, createdAt: 1 });
  state.chats.push({ id: 'q', bookId: book.id, sessionId: 'previous', role: 'user', text: '核对登记。', evidence: [{ bookId: book.id, version: book.version, start: 0, end: book.position }], createdAt: 1, excluded: false, delivery: 'pending' });
  const restored = await restoreBackup(JSON.stringify(state), initialState()); assert.equal(restored.chats[0].delivery, 'failed');
  let calls = 0;
  await assert.rejects(restoreReadingEngine({ async load() { return structuredClone(state); }, async save() { throw new Error('保存失败'); } }, { async complete() { calls++; return packet(); } }), /保存失败/);
  assert.equal(calls, 0); assert.equal(state.chats[0].delivery, 'pending');
});
