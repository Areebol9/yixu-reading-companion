import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importBook, covers } from '../src/core/books.ts';
import { evidence, memorySources, usableMemories, correctMemory } from '../src/core/context.ts';
import { initialState } from '../src/core/state.ts';
import { ReadingSources } from '../src/core/reading-sources.ts';
import { readingSubmit } from '../src/core/reading-agent.ts';
import { planMemories } from '../src/core/memory-plan.ts';
import { applyFactReview, createFactReview } from '../src/core/fact-review.ts';
import { restoreBackup } from '../src/core/backup.ts';
import { recoverInterruptedState } from '../src/core/startup.ts';
import { ReadingEngine } from '../src/core/engine.ts';
import { HarnessRuntime } from '../src/agent/runtime.ts';
import type { Memory, ReadingReply } from '../src/core/types.ts';

async function fixture() {
  const state = initialState();
  const book = await importBook('来源与阶段工程资料', '第一章 登记\n设备甲编号A3，登记数量3件。\n' + '早期记录保存在甲区。\n'.repeat(20) +
    '第二章 后来说明\n设备甲已转移到乙区，旧标签仍沿用A3。\n' + '后续登记有单独的日期。\n'.repeat(20) + '第三章 尚未允许\nFUTURE-SOURCE');
  const early = { start: 0, end: book.chapters[1].start }, later = { start: book.chapters[1].start, end: book.chapters[2].start };
  book.known = [{ start: 0, end: later.end }]; book.prepared = [...book.known]; book.position = later.end; state.books.push(book);
  const old: Memory = { id: 'old', bookId: book.id, partnerId: state.partnerId, kind: 'story', text: '设备甲登记3件。',
    evidence: [evidence(book, early)], parents: [], chatIds: [], createdAt: 1, forgotten: false, source: 'reading' };
  return { state, book, early, later, old };
}

test('模型选中的原文片段作为精确来源，仍以整轮接触范围限制可用阶段', async () => {
  const { state, book, early, later } = await fixture(), sources = new ReadingSources();
  sources.render(book, early); const ids = [...sources.passages.keys()].slice(0, 2);
  sources.render(book, later);
  const reply = readingSubmit(() => {}).parse({ reply: '', replyBasis: { memoryIds: [], chatIds: [] },
    thoughts: [{ kind: 'story', text: '设备甲登记3件。', basis: { memoryIds: [], chatIds: [] }, sourceIds: ids }], reinforce: [], wantsLong: false });
  const plan = planMemories(state, book, reply, [evidence(book, book.known[0])], [], [], 'reading', undefined, [], book.known, sources.passages);
  const memory = plan.added[0]; state.memories.push(memory);
  assert.ok(memorySources(memory).length); assert.ok(memorySources(memory).every(r => r.end <= early.end));
  assert.ok(covers(memory.evidence, later));
  book.known = [early]; assert.equal(usableMemories(state, book).length, 0);
  book.known = [{ start: 0, end: later.end }]; assert.equal(usableMemories(state, book).length, 1);
  const bad: ReadingReply = { ...reply, thoughts: [{ ...reply.thoughts[0], text: '设备甲有早期登记。', sourceIds: ['p99999'] }] };
  assert.equal(planMemories(state, book, bad, memory.evidence, [], [], 'reading', undefined, [], book.known, sources.passages).added[0].sourceEvidence, undefined);
});

test('备份保留精确来源，不能借来源字段越过使用范围；用户更正不继承旧依据', async () => {
  const { state, book, early, later, old } = await fixture();
  old.sourceEvidence = [evidence(book, { start: 0, end: 20 })]; state.memories.push(old);
  const restored = await restoreBackup(JSON.stringify(state), initialState());
  assert.deepEqual(restored.memories[0].sourceEvidence, old.sourceEvidence);
  const invalid = structuredClone(state); invalid.memories[0].sourceEvidence = [evidence(book, later)];
  await assert.rejects(restoreBackup(JSON.stringify(invalid), initialState()), /原文依据/);
  const corrected = correctMemory(state, old.id, '设备甲的数量需按另一份登记解释。');
  assert.equal(corrected.sourceEvidence, undefined); assert.ok(covers(corrected.evidence, early)); assert.ok(covers(corrected.evidence, later));
  const legacy = { ...old, sourceEvidence: undefined, sourceQuote: { text: book.text.slice(0, 20), evidence: evidence(book, { start: 0, end: 20 }) } };
  assert.deepEqual(memorySources(legacy), [legacy.sourceQuote.evidence]);
});

test('核对选中早期引文不会抹掉本次读过的后期资料，未展示的目录资料也不冒充已读', async () => {
  const { state, book, early, later, old } = await fixture(); state.memories.push(old);
  const review = createFactReview(book, [old]), first = review.sources[0];
  const late = { id: 'late', text: book.text.slice(later.start, later.start + 35), evidence: evidence(book, { start: later.start, end: later.start + 35 }) };
  review.sources.push(late); review.exposure = [first.evidence, late.evidence];
  const result = [{ originalId: old.id, before: old.text, text: old.text, evidence: [first.evidence], reason: '本次已回查所示原文' }];
  const [id] = applyFactReview(state, review, result), updated = state.memories.find(m => m.id === id)!;
  assert.deepEqual(updated.sourceEvidence, [first.evidence]); assert.ok(covers(updated.evidence, late.evidence));
  book.known = [early]; assert.equal(usableMemories(state, book).some(m => m.id === id), false);

  const other = await fixture(); other.state.memories.push(other.old);
  const selective = createFactReview(other.book, [other.old]), shown = selective.sources[0];
  selective.sources.push({ ...late, evidence: evidence(other.book, late.evidence) }); selective.exposure = [shown.evidence];
  const [selectedId] = applyFactReview(other.state, selective, [{ ...result[0], evidence: [shown.evidence] }]);
  const selected = other.state.memories.find(m => m.id === selectedId)!;
  assert.equal(covers(selected.evidence, other.later), false);
  other.book.known = [other.early]; assert.ok(usableMemories(other.state, other.book).some(m => m.id === selectedId));
});

test('已有关联来源时从相关原文开始核对，保留旧记录完整阶段范围', async () => {
  const { book, early, later, old } = await fixture();
  old.evidence = [evidence(book, { start: early.start, end: later.end })];
  old.sourceEvidence = [evidence(book, { start: 0, end: 24 })];
  const review = createFactReview(book, [old]);
  assert.deepEqual(review.candidates[0].evidence, old.evidence);
  assert.ok(review.sources.every(s => s.evidence.end < later.end));
  assert.ok(review.sources.some(s => s.text.includes('设备甲')));
});

test('旧核对记录缺少接触范围时保守接续当前存档范围，不冒认早期就知道', async () => {
  const { state, book, early, later, old } = await fixture();
  const reviewed: Memory = { ...old, id: 'legacy-review', source: 'review', correctionOf: old.id,
    reviewDisposition: 'supported', reviewReason: '旧版本核对', parents: [old.id], basis: { memoryIds: [], chatIds: [] } };
  old.replacedBy = reviewed.id; state.memories.push(old, reviewed);
  const first = recoverInterruptedState(state);
  assert.equal(first.changed, true); assert.deepEqual(reviewed.sourceEvidence, [evidence(book, early)]);
  assert.ok(covers(reviewed.evidence, later)); assert.equal(recoverInterruptedState(state).changed, false);
  book.known = [early]; assert.equal(usableMemories(state, book).some(m => m.id === reviewed.id), false);
});

test('正式Agent提交保留来源编号，下一轮只传精确出处，权限仍由完整范围约束', async () => {
  const { state, book, early, later } = await fixture(); state.settings.services[0].enabled = true;
  let calls = 0; const harness = new HarnessRuntime();
  const engine = new ReadingEngine(state, { async load() { return undefined; }, async save() {} }, {
    async complete() { throw new Error('Expected native tool protocol'); },
    async completeTools(_service, messages) {
      calls++;
      const sourceId = messages.filter(m => m.role === 'user').map(m => m.content).join('\n').match(/【(p\d+)】/)![1];
      if (calls === 2) {
        const fields = messages.filter(m => m.role === 'user').flatMap(m => m.content.split('\n\n')).flatMap(text => { try { return [JSON.parse(text)]; } catch { return []; } });
        const visible = fields.find(f => Array.isArray(f.memories))!.memories.find((m: any) => m.text === '设备甲登记3件。');
        assert.ok(visible); assert.ok(visible.references.every((r: any) => r.end <= early.end));
      }
      return { content: '', input: 1, output: 1, estimated: false, elapsedMs: 1, reasoning: '', finish: 'tool_calls' as const,
        toolCalls: [{ id: 'source-call-' + calls, type: 'function' as const, function: { name: 'submit_reading', arguments: JSON.stringify({
          reply: '已接上登记。', replyBasis: { memoryIds: [], chatIds: [] },
          thoughts: calls === 1 ? [{ kind: 'story', text: '设备甲登记3件。', basis: { memoryIds: [], chatIds: [] }, sourceIds: [sourceId] }] : [], reinforce: [], wantsLong: false,
        }) } }] };
    },
  });
  engine.agent = harness;
  try {
    await engine.startReading(book.id); await engine.ask(book.id, '核对设备甲的登记。');
    const memory = state.memories[0]; assert.ok(memory.sourceEvidence?.length); assert.ok(covers(memory.evidence, later));
    await engine.ask(book.id, '接着看设备登记。'); assert.equal(calls, 2);
    book.known = [early]; assert.equal(usableMemories(state, book).some(m => m.id === memory.id), false);
  } finally { engine.stop(); await harness.dispose(); }
});
