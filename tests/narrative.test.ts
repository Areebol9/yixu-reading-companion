import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importBook } from '../src/core/books.ts';
import { initialState } from '../src/core/state.ts';
import { ReadingEngine } from '../src/core/engine.ts';
import { ChatModel, parseReadingReply } from '../src/core/model.ts';
import { HarnessRuntime } from '../src/agent/runtime.ts';
import { correctMemory, evidence, forgetMemory, usableMemories } from '../src/core/context.ts';
import { chapterContext, narrativeIndex, parseNarrative, readingRecord } from '../src/core/narrative.ts';
import { restoreBackup } from '../src/core/backup.ts';
import { readingSubmit } from '../src/core/reading-agent.ts';
import { searchMemories, selectMemories } from '../src/core/recall.ts';
import { planMemories, readingStageFor } from '../src/core/memory-plan.ts';
import { ReadingSources } from '../src/core/reading-sources.ts';
import type { Memory, State } from '../src/core/types.ts';

const raw = '第一章 登记\n设备甲的用途尚未登记，须等待检修完成后补充说明。\n第二章 补充\n设备甲用于测量温度，仅在校准成功后允许投入使用。';
const empty = { memoryIds: [], chatIds: [] };
const packet = (thoughts: unknown[]) => ({ reply: '', replyBasis: empty, thoughts, reinforce: [], wantsLong: false });
const fields = (messages: { content: string }[]) => messages.flatMap(m => m.content.split('\n\n')).flatMap(s => { try { return [JSON.parse(s)]; } catch { return []; } });

test('错放在条目顶层的可选条件并入结构标注，不为字段位置重写有效回应', () => {
  const result = readingSubmit(() => {}).parse(packet([{ kind: 'story', text: '校准通过后可使用。', basis: empty, condition: '校准通过', narrative: { category: 'rule', subjects: ['设备甲'] } }]));
  assert.equal(result.thoughts[0].narrative?.condition, '校准通过');
  assert.equal('condition' in result.thoughts[0], false);
});

test('正式Harness按章保存材料、条件与线索，阶段查询和更正始终指向有效认识', async () => {
  const state = initialState(), book = await importBook('章节工程资料', raw);
  book.known = [{ start: 0, end: raw.length }]; book.position = raw.length; state.books = [book]; state.settings.services[0].enabled = true;
  const saved: State[] = []; let calls = 0;
  const engine = new ReadingEngine(state, { async load() { return state; }, async save(s) { saved.push(structuredClone(s)); } }, new ChatModel(async request => {
    const input = fields(request.body.messages).find(p => p.currentRange); calls++;
    const old = [...input.memories,...(input.questionIndex??[])].find((m: { kind: string }) => m.kind === 'question');
    if (calls === 2) {
      assert.match(old.id, /^m\d+$/);
      assert.ok(input.chapterContext.some((c: { memoryIds: string[] }) => c.memoryIds.includes(old.id)));
      assert.deepEqual(old.readingStage, [{ start: book.chapters[0].start, end: book.chapters[0].end }]);
    }
    const thoughts = calls === 1 ? [{ kind: 'question', text: '设备甲的用途是什么？', basis: empty, quoteSource: 'p1', narrative: { category: 'thread', subjects: ['设备甲'] } }] :
      [{ kind: 'story', text: '设备甲用于测量温度，仅在校准成功后允许投入使用。', basis: { memoryIds: [old.id], chatIds: [] }, updates: old.id,
        updateReason: '补充登记回答了原用途问题。', quoteSource: 'p1', narrative: { category: 'rule', subjects: ['设备甲'], condition: '仅在校准成功后允许投入使用' } }];
    return { status: 200, body: { choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'submit-' + calls, type: 'function', function: { name: 'submit_reading', arguments: JSON.stringify(packet(thoughts)) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 10 } } };
  }));
  const harness = new HarnessRuntime(); engine.agent = harness;
  try {
    await engine.startReading(book.id); await engine.prepare(book.id);
    assert.equal(calls, 2); assert.equal(state.readings?.length, 2);
    assert.ok(state.readings?.every(r => r.source === 'preparation' && r.memoryIds.length === 1));
    assert.equal(saved.at(-1)?.readings?.length, 2);
    const old = state.memories[0], answer = state.memories[1];
    assert.deepEqual(old.readingStage, [{ start: book.chapters[0].start, end: book.chapters[0].end }]);
    assert.deepEqual(answer.readingStage, [{ start: book.chapters[1].start, end: book.chapters[1].end }]);
    assert.equal(answer.narrative?.condition, '仅在校准成功后允许投入使用');
    assert.deepEqual(searchMemories(state, book, { chapterIndex: 0 }).items.map(m => m.id), [answer.id]);
    const early = { ...book, known: [{ start: 0, end: book.chapters[0].end }] };
    assert.deepEqual(searchMemories(state, early, { chapterIndex: 0 }).items.map(m => m.id), [old.id]);
    assert.equal(searchMemories(state, early, { chapterIndex: 1 }).total, 0);
    const correction = correctMemory(state, answer.id, '使用条件尚需按校准记录确认。');
    assert.equal(correction.narrative, undefined);
    assert.equal(correction.readingStage, undefined);
    assert.deepEqual(searchMemories(state, book, { chapterIndex: 0 }).items.map(m => m.id), [correction.id]);
    const restored = await restoreBackup(JSON.stringify(state), initialState());
    assert.deepEqual(restored.memories.find(m=>m.id===answer.id)?.readingStage, answer.readingStage);
    assert.deepEqual(searchMemories(restored, restored.books[0], { chapterIndex: 1 }).items.map(m => m.id), [correction.id]);
    forgetMemory(state, correction.id);
    assert.equal(searchMemories(state, book, { chapterIndex: 0 }).total, 0);
  } finally { engine.stop(); await harness.dispose(); }
});

test('形成阶段与引用早期原文分开，不从旧数据猜阶段或缩减权限', async () => {
  const state = initialState(), book = await importBook('阶段工程资料',raw);
  book.known = [{start:0,end:raw.length}]; state.books=[book];
  const early = {start:book.chapters[0].start,end:book.chapters[0].end};
  const current = {start:book.chapters[1].start,end:book.chapters[1].end};
  const sources = new ReadingSources(); sources.render(book,early);
  const result = readingSubmit(()=>{}).parse(packet([{kind:'opinion',text:'此前等待用途登记，现在应结合补充记录理解。',basis:empty,quoteSource:'p1'}]));
  const plan = planMemories(state,book,result,[evidence(book,book.known[0])],[],[],'reading',undefined,[],[early,current],sources.passages,[current]);
  const note = plan.added[0]; state.memories.push(note);
  assert.deepEqual(note.readingStage,[current]);
  assert.equal(note.sourceQuote!.evidence.end <= early.end,true);
  assert.deepEqual(note.evidence,[evidence(book,book.known[0])]);
  assert.equal(usableMemories(state,{...book,known:[early]}).length,0);
  assert.deepEqual(readingStageFor([current],[]),[]);
  const restored = await restoreBackup(JSON.stringify(state),initialState());
  assert.deepEqual(restored.memories[0].readingStage,[current]);
  const old = structuredClone(state); delete old.memories[0].readingStage;
  assert.equal((await restoreBackup(JSON.stringify(old),initialState())).memories[0].readingStage,undefined);
  const invalid = structuredClone(state); invalid.memories[0].readingStage=[{start:raw.length,end:raw.length+1}];
  await assert.rejects(restoreBackup(JSON.stringify(invalid),initialState()),/形成阶段/);
});

test('较早认识可按主体取回，标注不自动合并身份；错误可选标注不触发额外请求', async () => {
  const state = initialState(), book = await importBook('章节工程资料', raw);
  book.known = [{ start: 0, end: raw.length }]; state.books = [book];
  const memory: Memory = { id: 'early', bookId: book.id, partnerId: state.partnerId, kind: 'story', text: '校准成功后才允许投入使用。',
    evidence: [evidence(book, book.known[0])], parents: [], chatIds: [], forgotten: false, source: 'reading', createdAt: 1,
    narrative: { category: 'rule', subjects: ['设备甲', '温度计AX'], condition: '校准成功' } };
  state.memories.push(memory, ...Array.from({ length: 40 }, (_, i) => ({ ...memory, id: 'other-' + i, text: `批次${i}的其他记录。`, narrative: undefined, createdAt: i + 2 })));
  assert.equal(searchMemories(state, book, { query: '温度计AX' }).items[0].id, 'early');
  assert.ok(selectMemories(state, book, { start: 0, end: 1 }, '温度计AX现在可以使用吗？').some(m => m.id === 'early'));
  assert.equal(parseNarrative({ category: 'relation', subjects: ['设备甲'] }, 'opinion'), undefined);
  const parsed = parseReadingReply(JSON.stringify(packet([{ kind: 'story', text: '保留原记录。', basis: empty, narrative: { category: 'view', subjects: ['设备甲'] } }])));
  assert.equal(parsed.thoughts[0].text, '保留原记录。'); assert.equal(parsed.thoughts[0].narrative, undefined);
});

test('材料与认识同批保存失败时不发布记录，书前范围重置和旧备份不会伪造覆盖', async () => {
  const state = initialState(), book = await importBook('章节工程资料', raw); state.books = [book];
  book.known = [{ start: 0, end: book.chapters[0].end }]; book.position = book.known[0].end; state.settings.services[0].enabled = true;
  const engine = new ReadingEngine(state, { async load() { return state; }, async save(s) { if (s.readings?.length) throw new Error('disk fail'); } }, { async complete() { return { content: JSON.stringify(packet([])), input: 1, output: 1, elapsedMs: 1, estimated: false }; } });
  try {
    await engine.startReading(book.id); await assert.rejects(engine.prepare(book.id), /disk fail/);
    assert.equal(state.readings, undefined); assert.deepEqual(book.prepared, []);
  } finally { engine.stop(); }
  state.readings = [readingRecord(book, state.partnerId, book.known, [])];
  const restored = await restoreBackup(JSON.stringify(state), initialState());
  assert.equal(narrativeIndex(restored, restored.books[0], []).coverage.size, 0);
  const noRecords = { ...state, readings: undefined };
  assert.ok(chapterContext(noRecords, book, [], book.known[0]).every(c => !c.processedRanges.length));
  state.readings[0].version = 'incorrect';
  await assert.rejects(restoreBackup(JSON.stringify(state), initialState()), /章节材料/);
});
