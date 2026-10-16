import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importBook } from '../src/core/books.ts';
import { initialState } from '../src/core/state.ts';
import { evidence, correctMemory, forgetMemory } from '../src/core/context.ts';
import { planMemories } from '../src/core/memory-plan.ts';
import { currentStates, validateStageStateMemories } from '../src/core/stage-state.ts';
import { applyFactReview, createFactReview, factReviewBook, parseFactReview, reviewableFact, reviewSourceFingerprint } from '../src/core/fact-review.ts';
import { pruneReviewSources } from '../src/core/review-tasks.ts';
import { restoreBackup } from '../src/core/backup.ts';
import type { ReadingReply, Range } from '../src/core/types.ts';

const reply = (value: Partial<ReadingReply>): ReadingReply => ({ reply: '', thoughts: [], wantsLong: false, ...value });
async function fixture() {
  const state = initialState(), book = await importBook('阶段原文复核工程', '第一章 登记\n设备甲在仓库，责任人为甲。\n第二章 未接触\nGAP-UNKNOWN原文禁止读取。\n第三章 移交\n设备甲交给乙，离开仓库。');
  state.books = [book]; book.known = [{ start: 0, end: book.text.length }]; book.position = book.text.length;
  const range = (i: number): Range => ({ start: book.chapters[i].start, end: book.chapters[i].end });
  const plan = (value: ReadingReply, task: Range[], refs: Range[] = task, parents: string[] = []) => planMemories(state, book, value, refs.map(r => evidence(book, r)), parents, [], 'reading', undefined, [], refs, new Map(), task, { narrativeMode: 'stages' });
  return { state, book, range, plan };
}
function supported(review: ReturnType<typeof createFactReview>, text: string, flags: Record<string, unknown> = {}) {
  const sourceIds=[review.sources[0].id],parts=review.statePartsMode==='establish'?(flags.stateStatus==='ended'?{stateParts:[],stateEnd:{text,sourceIds}}:{stateParts:[{text,sourceIds}]}):{};
  return parseFactReview(review, JSON.stringify({ items: [{ id: review.candidates[0].id, text, sourceIds, reason: '依据原阶段原文核实。',...parts, ...flags }] }));
}

test('stage/state复核严格使用完整旧evidence交集，保留缺口与指纹，越界旧采集不可复用', async () => {
  const f = await fixture(), source = f.plan(reply({ stageNarrative: { text: '登记后移交。' }, stateUpdates: [{ topic: '位置', text: '从仓库移交给乙。' }] }), [f.range(0)], [f.range(0), f.range(2)]).added[1]; f.state.memories.push(source);
  const review = createFactReview(f.book, [source]);
  assert.deepEqual(review.readWithin, [f.range(0), f.range(2)]); assert.deepEqual(factReviewBook(f.book, review).known, review.readWithin);
  assert.ok(!review.sources.some(s => s.text.includes('GAP-UNKNOWN')));
  assert.throws(() => createFactReview(f.book, [source], [evidence(f.book, f.range(1))]), /允许范围/);
  assert.notEqual(await reviewSourceFingerprint(review, f.book), await reviewSourceFingerprint({ ...review, readWithin: [{ start: 0, end: f.book.text.length }] }, f.book));
  f.state.tasks = [{ id: 'review-task', kind: 'fact-review', bookId: f.book.id, version: f.book.version, partnerId: f.state.partnerId, createdAt: 1, updatedAt: 1, status: 'interrupted', items: [{ memoryId: source.id, status: 'pending', reviewSources: { fingerprint: 'a'.repeat(64), sources: [{ id: 'p0', evidence: evidence(f.book, f.range(1)) }] } }] }];
  assert.equal(pruneReviewSources(f.state), true); assert.equal(f.state.tasks[0].items[0].reviewSources, undefined);
  const result = supported(review, '依据原文，设备已移交。'); source.stateProjection!.topic = '篡改主题'; assert.throws(() => applyFactReview(f.state, review, result), /已更新/);
});

test('阶段原文修订保留覆盖与导航，可修延续标记；状态结束标记只允许有前身且其他身份冻结', async () => {
  const f = await fixture(), first = f.plan(reply({ stageNarrative: { text: '登记阶段尚在延续。', continues: true } }), [f.range(0)]); f.state.memories.push(...first.added);
  const stage = first.added[0], stageReview = createFactReview(f.book, [stage]);
  const [stageId] = applyFactReview(f.state, stageReview, supported(stageReview, '设备登记完成。', { stageContinues: false }));
  const nextStage = f.state.memories.find(m => m.id === stageId)!; assert.equal(nextStage.stageNarrative!.continues, false); assert.deepEqual(nextStage.stageNarrative!.ranges, stage.stageNarrative!.ranges);
  const original = f.plan(reply({ stateUpdates: [{ topic: '位置', text: '在仓库。' }] }), [f.range(0)]).added[0]; f.state.memories.push(original);
  const review = createFactReview(f.book, [original]);
  assert.throws(() => supported(review, original.text, { stateStatus: 'ended' }), /标记无效/);
  assert.throws(() => supported(review, original.text, { stageContinues: false }), /标记无效/);
  const changed = f.plan(reply({ stateUpdates: [{ topic: '位置', text: '设备已移交。', stateChangeOf: original.id }] }), [f.range(2)], [f.range(0), f.range(2)], [original.id]).added[0]; f.state.memories.push(changed);
  const changedReview = createFactReview(f.book, [changed]), [changedId] = applyFactReview(f.state, changedReview, supported(changedReview, changed.text, { stateStatus: 'ended' }));
  const revised = f.state.memories.find(m => m.id === changedId)!; assert.equal(revised.stateProjection!.topic, '位置'); assert.equal(revised.stateProjection!.status, 'ended'); assert.equal(revised.stateChangeOf, original.id); validateStageStateMemories(f.state);
  await restoreBackup(JSON.stringify(f.state), initialState());
});

test('前后状态各自原文复核后按可见修订身份接续，较早许可保留当时头且不泄露后继', async () => {
  const f = await fixture(), old = f.plan(reply({ stateUpdates: [{ topic: '位置', text: '设备甲在仓库。' }] }), [f.range(0)]).added[0]; f.state.memories.push(old);
  const next = f.plan(reply({ stateUpdates: [{ topic: '位置', text: '设备甲交给乙。', stateChangeOf: old.id }] }), [f.range(2)], [f.range(0), f.range(2)], [old.id]).added[0]; f.state.memories.push(next);
  const reviewOld = createFactReview(f.book, [old]), [oldRevisionId] = applyFactReview(f.state, reviewOld, supported(reviewOld, old.text)); assert.ok(next.invalidatedBy); assert.equal(reviewableFact(f.state, f.book, next), true);
  const reviewNext = createFactReview(f.book, [next]), [nextRevisionId] = applyFactReview(f.state, reviewNext, supported(reviewNext, next.text));
  assert.deepEqual(currentStates(f.state, f.book).map(m => m.id), [nextRevisionId]);
  assert.equal(currentStates(f.state, f.book)[0].stateChangeOf, oldRevisionId); assert.equal(f.state.memories.find(m => m.id === nextRevisionId)!.stateChangeOf, old.id);
  const earlier = { ...f.book, known: [f.range(0)] }, heads = currentStates(f.state, earlier); assert.deepEqual(heads.map(m => m.id), [oldRevisionId]); assert.ok(!JSON.stringify(heads).includes(nextRevisionId));
  const restored = await restoreBackup(JSON.stringify(f.state), initialState()); assert.deepEqual(currentStates(restored, restored.books[0]).map(m => m.id), [nextRevisionId]);
});

test('复核不能恢复用户已更正或遗忘的阶段状态，unsupported仍保留原历史并暂停引用', async () => {
  const f = await fixture(), old = f.plan(reply({ stateUpdates: [{ topic: '位置', text: '仓库位置记录。' }] }), [f.range(0)]).added[0]; f.state.memories.push(old);
  const review = createFactReview(f.book, [old]), result = supported(review, old.text); correctMemory(f.state, old.id, '用户明确更正位置。'); assert.throws(() => applyFactReview(f.state, review, result), /已更新/);
  const other = f.plan(reply({ stateUpdates: [{ topic: '责任', text: '责任为甲。' }] }), [f.range(0)]).added[0]; f.state.memories.push(other);
  const forgottenReview = createFactReview(f.book, [other]), forgottenResult = supported(forgottenReview, other.text); forgetMemory(f.state, other.id); assert.throws(() => applyFactReview(f.state, forgottenReview, forgottenResult), /已更新/);
  const candidate = f.plan(reply({ stageNarrative: { text: '本阶段的设备属性没有依据。' } }), [f.range(0)]).added[0]; f.state.memories.push(candidate);
  const candidateReview = createFactReview(f.book, [candidate]), denied = parseFactReview(candidateReview, JSON.stringify({ items: [{ id: 'm0', text: null, sourceIds: [], reason: '本阶段原文不足以支持。' }] }));
  const [id] = applyFactReview(f.state, candidateReview, denied); assert.equal(f.state.memories.find(m => m.id === id)!.reviewDisposition, 'unsupported'); assert.equal(f.state.memories.find(m => m.id === candidate.id)!.text, candidate.text);
});
