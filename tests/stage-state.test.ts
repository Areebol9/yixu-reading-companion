import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importBook, mergeRanges } from '../src/core/books.ts';
import { initialState } from '../src/core/state.ts';
import { correctMemory, evidence, forgetMemory } from '../src/core/context.ts';
import { parseReadingReply } from '../src/core/model.ts';
import { planMemories } from '../src/core/memory-plan.ts';
import { currentStates, permittedStages, permittedStates, stageOriginalRanges, validateStageStateMemories } from '../src/core/stage-state.ts';
import { createReadingDraft, pendingReadingDrafts, validateReadingDrafts } from '../src/core/reading-drafts.ts';
import { restoreBackup } from '../src/core/backup.ts';
import type { Range, ReadingReply, Memory } from '../src/core/types.ts';

const reply = (value: Partial<ReadingReply> = {}): ReadingReply => ({ reply: '', thoughts: [], wantsLong: false, ...value });
async function fixture() {
  const state = initialState(), book = await importBook('阶段状态工程', '第一章 登记\n设备甲在仓库，责任人为甲。\n第二章 间隔\nGAP-UNREAD-BODY不得使用。\n第三章 移交\n设备甲移交给乙，责任改为乙。');
  state.books = [book]; book.known = [{ start: 0, end: book.text.length }]; book.position = book.text.length;
  const plan = (value: ReadingReply, task: Range[], refs: Range[] = task, parents: string[] = [], source: Memory['source'] = 'reading', mode: 'legacy' | 'stages' = 'stages') =>
    planMemories(state, book, value, refs.map(r => evidence(book, r)), parents, [], source, undefined, [], refs, new Map(), task, { narrativeMode: mode });
  return { state, book, plan, first: book.chapters[0], second: book.chapters[1], third: book.chapters[2] };
}

test('新叙事协议只接受语义内容，状态结束须有前身，候选默认仍沿旧简报', async () => {
  assert.throws(() => parseReadingReply(JSON.stringify(reply({ stateUpdates: [{ topic: '设备', text: '已结束', status: 'ended' }] }))), /继起/);
  assert.throws(() => parseReadingReply(JSON.stringify(reply({ stateUpdates: [{ topic: '设备', text: '正文', asOf: [] } as any] }))), /字段/);
  assert.throws(() => parseReadingReply(JSON.stringify(reply({ thoughts: [{ kind: 'state', text: '正文' } as any] }))), /条目/);
  const f = await fixture(), value = reply({ readingBrief: '旧简报', stageNarrative: { text: '新阶段' }, stateUpdates: [{ topic: '设备', text: '状态' }] });
  assert.deepEqual(f.plan(value, [f.first], [f.first], [], 'reading', 'legacy').added.map(m => m.kind), ['context']);
  assert.deepEqual(f.plan(value, [f.first]).added.map(m => m.kind), ['stage', 'state']);
});

test('多主题完整投影接续，保留旧状态与未更新主题，权限先过滤并隐藏未获准继起', async () => {
  const f = await fixture();
  const initial = f.plan(reply({ stageNarrative: { text: '登记设备甲位置与责任。', continues: true }, stateUpdates: [{ topic: '位置', text: '设备甲在仓库。' }, { topic: '责任', text: '责任人为甲。' }] }), [f.first]);
  f.state.memories.push(...initial.added);
  const old = initial.added.find(m => m.stateProjection?.topic === '位置')!, untouched = initial.added.find(m => m.stateProjection?.topic === '责任')!, saved = structuredClone(untouched);
  const next = f.plan(reply({ stageNarrative: { text: '设备移交，位置改变。' }, stateUpdates: [{ topic: ' 位置 ', text: '设备已离开仓库并移交乙。', stateChangeOf: old.id, status: 'ended' }] }), [f.third], [f.first, f.third], [old.id]);
  f.state.memories.push(...next.added);
  assert.deepEqual(untouched, saved); assert.equal(old.replacedBy, undefined); assert.equal(old.invalidatedBy, undefined);
  assert.equal(next.added.at(-1)!.stateChangeOf, old.id); assert.ok(next.added.at(-1)!.parents.includes(old.id)); assert.equal(next.added.at(-1)!.basis, undefined);
  assert.deepEqual(currentStates(f.state, f.book).map(m => m.id).sort(), [untouched.id, next.added.at(-1)!.id].sort());
  assert.equal(currentStates(f.state, f.book).find(m => m.stateProjection?.topic === '位置')!.stateProjection!.status, 'ended');
  assert.ok(permittedStates(f.state, f.book).some(m => m.id === old.id));
  const narrow = { ...f.book, known: [{ start: f.first.start, end: f.first.end }] };
  assert.deepEqual(currentStates(f.state, narrow).map(m => m.id).sort(), [old.id, untouched.id].sort());
  assert.ok(!JSON.stringify(currentStates(f.state, narrow)).includes(next.added.at(-1)!.id));
  assert.equal(permittedStages(f.state, narrow).length, 1);
  f.book.position = f.first.end; assert.equal(currentStates(f.state, f.book).find(m => m.stateProjection?.topic === '位置')!.id, next.added.at(-1)!.id);
  assert.equal(currentStates(f.state, f.book, { through: f.first.end }).find(m => m.stateProjection?.topic === '位置')!.id, old.id);
});

test('同主题须显式接续完整当前头，分叉可见时拒绝，隐藏后继不影响冲突判断', async () => {
  const f = await fixture(), initial = f.plan(reply({ stateUpdates: [{ topic: '位置', text: '在仓库' }] }), [f.first]); f.state.memories.push(...initial.added);
  const old = initial.added[0];
  assert.throws(() => f.plan(reply({ stateUpdates: [{ topic: '位置', text: '到站' }] }), [f.third]), /显式接续/);
  assert.throws(() => f.plan(reply({ stateUpdates: [{ topic: '位置', text: '到站', stateChangeOf: old.id }] }), [f.third]), /完整提供/);
  const next = f.plan(reply({ stateUpdates: [{ topic: '位置', text: '到站', stateChangeOf: old.id }] }), [f.third], [f.first, f.third], [old.id]).added[0]; f.state.memories.push(next);
  assert.throws(() => f.plan(reply({ stateUpdates: [{ topic: '位置', text: '再发展', stateChangeOf: old.id }] }), [f.third], [f.first, f.third], [old.id]), /当前状态/);
  f.state.memories.push({ ...structuredClone(next), id: 'visible-fork' }); assert.throws(() => currentStates(f.state, f.book), /分支|分叉/);
  assert.deepEqual(currentStates(f.state, { ...f.book, known: [f.first] }).map(m => m.id), [old.id]);
});

test('state获知范围包含工具后章与父资料，17个不连续区间可备份且未冒充精确出处', async () => {
  const f = await fixture(), refs = [f.first, f.third]; f.book.known = refs;
  const planned = f.plan(reply({ stageNarrative: { text: '只记录第一阶段。' }, stateUpdates: [{ topic: '位置', text: '结合实际取得的后章，位置已改变。' }] }), [f.first], refs);
  const stage = planned.added[0], projection = planned.added[1]; f.state.memories.push(...planned.added);
  assert.deepEqual(stage.stageNarrative!.ranges, [{ start: f.first.start, end: f.first.end }]); assert.deepEqual(projection.stateProjection!.asOf, mergeRanges(refs.map(({start,end})=>({start,end}))));
  assert.equal(stage.sourceEvidence, undefined); assert.equal(projection.sourceEvidence, undefined);
  assert.equal(currentStates(f.state, { ...f.book, known: [f.first] }).length, 0); assert.equal(stageOriginalRanges(f.state, { ...f.book, known: [f.first] }, stage.id).length, 0);
  assert.deepEqual(stageOriginalRanges(f.state, f.book, stage.id), [{ start: f.first.start, end: f.first.end }]);
  const many = await fixture(), slices = Array.from({ length: 17 }, (_, i) => ({ start: i * 3, end: i * 3 + 1 })); many.book.known = slices; many.book.position = 1;
  const p = many.plan(reply({ stateUpdates: [{ topic: '零散记录', text: '依实际获准的零散记录形成。' }] }), [slices[0]], slices); many.state.memories.push(...p.added);
  assert.equal(p.added[0].stateProjection!.asOf.length, 17); validateStageStateMemories(many.state);
  assert.equal((await restoreBackup(JSON.stringify(many.state), initialState())).memories[0].stateProjection!.asOf.length, 17);
});

test('更正保留描述与时间身份，完整状态范围随新证据扩大；遗忘仍沿完整依赖停用', async () => {
  const f = await fixture(), first = f.plan(reply({ stageNarrative: { text: '设备登记存在错误。' }, stateUpdates: [{ topic: '位置', text: '旧位置说法。' }] }), [f.first]); f.state.memories.push(...first.added);
  const original = first.added.find(m => m.kind === 'state')!;
  const next = f.plan(reply({ stateUpdates: [{ topic: '位置', text: '后续位置。', stateChangeOf: original.id }] }), [f.third], [f.first, f.third], [original.id]).added[0]; f.state.memories.push(next);
  const corrected = correctMemory(f.state, original.id, '用户校正旧位置记录。');
  assert.equal(corrected.stateProjection!.topic, '位置'); assert.deepEqual(corrected.stateProjection!.asOf, mergeRanges(corrected.evidence.map(({start,end})=>({start,end})))); assert.equal(corrected.invalidatedBy, undefined);
  assert.ok(next.invalidatedBy); assert.equal(corrected.sourceEvidence, undefined); validateStageStateMemories(f.state);
  const stage = correctMemory(f.state, first.added[0].id, '用户校正登记阶段。'); assert.deepEqual(stage.stageNarrative, first.added[0].stageNarrative); assert.equal(stage.sourceEvidence, undefined);
  const restored = await restoreBackup(JSON.stringify(f.state), initialState()); assert.ok(restored.memories.some(m => m.id === corrected.id));
  const dependent = f.plan(reply({ stateUpdates: [{ topic: '新主题', text: '依更正记录形成的新状态。' }] }), [f.third], [f.first, f.third], [corrected.id]).added[0]; f.state.memories.push(dependent);
  forgetMemory(f.state, corrected.id); assert.equal(dependent.forgotten, true); assert.equal(currentStates(f.state, f.book).length, 0);
});

test('草稿保存核心模式及语义依赖，切换默认不改草稿，模式与新元数据篡改使草稿失效', async () => {
  const f = await fixture(), result = reply({ stageNarrative: { text: '登记阶段草稿。' }, stateUpdates: [{ topic: '位置', text: '仓库。' }] });
  const parent = f.plan(reply({ stateUpdates: [{ topic: '依赖', text: '原始依赖状态。' }] }), [f.first]).added[0]; f.state.memories.push(parent);
  const material = { messages: [], refs: [evidence(f.book, f.first)], originalRanges: [f.first], memoryIds: [parent.id], chatIds: [], habitIds: [], passages: [], narrativeMode: 'stages' as const };
  const draft = createReadingDraft(f.state, f.book, { source: 'reading', ranges: [f.first], input: '' }, result, [], material, 'ready'); f.state.readingDrafts = [draft]; validateReadingDrafts(f.state);
  assert.equal(pendingReadingDrafts(f.state, f.book.id)[0].material.narrativeMode, 'stages');
  const restored = await restoreBackup(JSON.stringify(f.state), initialState()); assert.equal(restored.readingDrafts![0].material.narrativeMode, 'stages');
  parent.stateProjection!.status = 'ended'; assert.equal(pendingReadingDrafts(f.state, f.book.id).length, 0); parent.stateProjection!.status = 'active';
  draft.material.narrativeMode = 'legacy'; assert.equal(pendingReadingDrafts(f.state, f.book.id).length, 0);
});
