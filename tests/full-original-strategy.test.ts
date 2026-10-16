import test from 'node:test';
import assert from 'node:assert/strict';
import { importBook, covers, mergeRanges } from '../src/core/books.ts';
import { evidence, correctMemory } from '../src/core/context.ts';
import { initialState } from '../src/core/state.ts';
import { ReadingEngine } from '../src/core/engine.ts';
import { ChatModel } from '../src/core/model.ts';
import { HarnessRuntime } from '../src/agent/runtime.ts';
import { createReadingDraft } from '../src/core/reading-drafts.ts';
import { restoreBackup } from '../src/core/backup.ts';
import { recoverInterruptedState } from '../src/core/startup.ts';
import type { Memory, State } from '../src/core/types.ts';

function packets(body: any): any[] {
  return body.messages.filter((m: any) => m.role === 'user').flatMap((m: any) => m.content.split('\n\n')).flatMap((text: string) => {
    try { return [JSON.parse(text)]; } catch { return []; }
  });
}
function material(body: any) { return packets(body).find(p => p.currentRange); }
function providedRanges(p: any) {
  return mergeRanges([p.currentRange, ...(p.additionalReadings ?? []), ...(p.previousReadings ?? []), ...(p.supportingReadings ?? [])].map(({ start, end }: any) => ({ start, end })));
}
function tools(...calls: [string, unknown][]) {
  return { status: 200, body: { choices: [{ finish_reason: 'tool_calls', message: { content: null,
    tool_calls: calls.map(([name, args], i) => ({ id: 'fixture-' + i, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 } } };
}
function natural(text: string) { return { status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: text } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } }; }
function prefixLength(a: string, b: string) { let i = 0; while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++; return i; }
async function fixture(respond: (body: any, turn: number) => any) {
  const state = initialState(), book = await importBook('完整原文工程',
    '第一章 原条件\nALPHA-ALLOWED：设备每月检修一次，项目结束后才能解除保管约束。\n第二章 未授权\nUNREAD-GAP：内部记录不在读者许可中。\n第三章 加入\nJOIN-ALLOWED：设备已经交接，故障原因仍待调查。\n第四章 推进\nNEXT-ALLOWED：负责人开始调查故障原因，保管条件继续。\n第五章 后文\nFUTURE-SECRET：未获准结论。');
  state.books = [book]; book.readingStrategy = 'full-original'; book.known = [{ start: 0, end: book.chapters[0].end }, { start: book.chapters[2].start, end: book.chapters[2].end }];
  book.position = book.chapters[2].end; book.prepared = []; state.settings.services[0].enabled = true;
  state.settings.defaultQuiet = true; state.settings.minReadChars = 1;
  state.usage.push({ id: 'prior-preparation-ledger-fixture', time: 1, serviceId: state.settings.serviceId,
    purpose: '历史准备账本工程fixture', input: 40, output: 10, estimated: false, status: 'complete' });
  let saved = structuredClone(state); const requests: any[] = [];
  const engine = new ReadingEngine(state, { async save(s) { saved = structuredClone(s); } }, new ChatModel(async request => {
    requests.push(structuredClone(request.body)); return respond(request.body, requests.length);
  }));
  const harness = new HarnessRuntime(); engine.agent = harness;
  return { state, book, engine, requests, disk: () => saved, close: async () => { engine.stop(); await harness.dispose(); } };
}
function memory(state: State, kind: Memory['kind'], source: Memory['source'], text: string): Memory {
  const book = state.books[0]; return { id: 'memory-' + state.memories.length, kind, source, text, bookId: book.id, partnerId: state.partnerId,
    evidence: [evidence(book, book.known[0])], readingStage: [{ ...book.known[0] }], parents: [], chatIds: [], createdAt: state.memories.length + 1, forgotten: false };
}

// All responses below are fixed engineering protocol fixtures. They demonstrate
// persistence, material and tool behavior; they do not evaluate literary quality.

test('中途加入直接跟读完整获准原文，初选和召回保留独立认识而排除旧自动剧情，随后交流与恢复保持', async () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture((body, turn) => {
    const p = material(body), raw = JSON.stringify(body);
    assert.ok(raw.includes('ALPHA-ALLOWED')); assert.ok(raw.includes('JOIN-ALLOWED')); assert.ok(raw.includes('NEXT-ALLOWED'));
    assert.equal(raw.includes('UNREAD-GAP'), false); assert.equal(raw.includes('FUTURE-SECRET'), false);
    assert.equal(raw.includes('AUTO-STRUCTURE：自动故事摘要。'), false); assert.equal(raw.includes('AUTO-STRUCTURE：旧简报。'), false);
    if (turn === 1) { assert.ok(raw.includes('COMPLETE-QUESTION：故障原因与完成条件？')); assert.ok(raw.includes('PARTIAL-ANSWER：完成项目才解除保管，故障原因仍未知。')); }
    for (const field of ['readingBrief', 'stageNarratives', 'currentStates', 'stageReadings']) assert.equal(p[field], undefined);
    const submit = body.tools.find((t: any) => t.function.name === 'submit_reading').function.parameters;
    for (const field of ['readingBrief', 'stageNarrative', 'stateUpdates']) assert.equal(field in submit.properties, false);
    if (turn === 1) return tools(['recall_memory', { query: 'AUTO-STRUCTURE', kind: 'story' }]);
    if (turn === 2) {
      const recall = JSON.parse(body.messages.find((m: any) => m.role === 'tool').content);
      assert.equal(JSON.parse(recall.results[0].text).items.length, 0);
      return tools(['submit_reading', { thoughts: [{ kind: 'opinion', text: '工程观点：登记资料不足以确认故障原因。', basis: { memoryIds: [], chatIds: [] }, sourceIds: ['p1'] },
        { kind: 'question', text: '设备故障的原因及完整修复条件是什么？', basis: { memoryIds: [], chatIds: [] }, sourceIds: ['p1'] }] }]);
    }
    return natural('原条件与当前登记均已提供，故障原因仍待调查。');
  });
  for (const [kind, source, text] of [['story', 'reading', 'AUTO-STRUCTURE：自动故事摘要。'], ['context', 'preparation', 'AUTO-STRUCTURE：旧简报。'],
    ['opinion', 'reading', 'INDEPENDENT-OPINION：先保留检修条件。'], ['question', 'reading', 'COMPLETE-QUESTION：故障原因与完成条件？'],
    ['user', 'conversation', 'USER-PREFERENCE：希望保留完整条件。']] as const) f.state.memories.push(memory(f.state, kind, source, text));
  f.state.memories.push({ ...memory(f.state, 'story', 'preparation', 'PARTIAL-ANSWER：完成项目才解除保管，故障原因仍未知。'),
    answersPartOf: f.state.memories.find(m => m.kind === 'question')!.id, parents: [f.state.memories.find(m => m.kind === 'question')!.id] });
  const originalKnown = structuredClone(f.book.known);
  try {
    await f.engine.startReading(f.book.id); assert.equal(f.engine.session!.readingStrategy, 'full-original'); assert.equal(f.engine.session!.prepared, true);
    assert.deepEqual(f.book.prepared, []);
    f.engine.observing(true); const task = f.book.chapters[3]; await f.engine.observe(f.book.id, f.book.text.slice(task.start, task.end), 'body', 'continuous-page');
    assert.equal(f.requests.length, 2); assert.deepEqual(providedRanges(material(f.requests[0])), f.book.known);
    assert.ok(covers(f.book.prepared, task)); assert.equal(covers(f.book.prepared, originalKnown[0]), false);
    assert.equal(f.state.memories.filter(m => m.source === 'reading' && m.kind === 'opinion').length, 2);
    const generated = f.state.memories.find(m => m.text.startsWith('工程观点'))!;
    await f.engine.correctMemory(generated.id, '工程观点：保留条件，原因仍未知。');
    assert.ok(f.state.memories.some(m => m.correctionOf === generated.id && m.source === 'correction'));
    // A live session is frozen; changing a book preference affects a new task
    // session, not this conversation or a saved understanding draft.
    f.book.readingStrategy = 'structured'; await f.engine.ask(f.book.id, '请说明当前掌握了哪些条件。');
    assert.equal(f.requests.length, 3); assert.equal(f.state.chats.filter(c => c.role === 'user').length, 1);
    assert.equal(f.state.chats.filter(c => c.role === 'assistant').length, 1);
    await f.engine.ask(f.book.id, '请另谈一个仍未解决的问题。'); assert.equal(f.requests.length, 4);
    const a = JSON.stringify(material(f.requests[2])), b = JSON.stringify(material(f.requests[3]));
    const firstDynamic = Math.min(...['"currentRange":', '"position":', '"focusRange":'].map(key => a.indexOf(key)).filter(i => i >= 0));
    assert.ok(firstDynamic > a.indexOf('"additionalReadings":')); assert.ok(prefixLength(a, b) >= firstDynamic);
    assert.deepEqual(providedRanges(material(f.requests[2])), providedRanges(material(f.requests[3])));
    const restored = await restoreBackup(JSON.stringify(f.disk()), initialState()); recoverInterruptedState(restored);
    assert.deepEqual(restored.chats, JSON.parse(JSON.stringify(f.state.chats))); assert.deepEqual(restored.memories, JSON.parse(JSON.stringify(f.state.memories)));
    assert.deepEqual(restored.books[0].known, f.book.known); assert.deepEqual(restored.books[0].prepared, f.book.prepared);
  } finally { await f.close(); }
});

test('显式全文准备一次提交可处理范围，无新增thought也成功；finish只处理真实待办并可安静暂停', async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
  const pending = await fixture(async () => { enter(); await released; return tools(['submit_reading', { reply: '' }]); });
  try {
    await pending.engine.startReading(pending.book.id); pending.engine.observing(true);
    const task = pending.book.chapters[3], reading = pending.engine.observe(pending.book.id, pending.book.text.slice(task.start, task.end), 'body', 'continuous-page');
    await entered; pending.engine.quiet(false); const closing = pending.engine.finishReading(pending.book.id); release(); await Promise.all([reading, closing]);
    assert.equal(pending.requests.length, 2); assert.ok(covers(pending.book.prepared, task));
    assert.equal(covers(pending.book.prepared, pending.book.known[0]), false);
  } finally { release(); await pending.close(); }
  const f = await fixture(body => { const p = material(body); assert.deepEqual(providedRanges(p), f.book.known); return tools(['submit_reading', { reply: '' }]); });
  try {
    await f.engine.startReading(f.book.id); await f.engine.finishReading(f.book.id);
    assert.equal(f.requests.length, 0); assert.deepEqual(f.book.prepared, []);
    await f.engine.prepare(f.book.id); assert.equal(f.requests.length, 1);
    assert.deepEqual(f.book.prepared, f.book.known); assert.equal(f.state.memories.length, 0); assert.equal(f.state.readingDrafts?.length ?? 0, 0);
    await f.engine.finishReading(f.book.id); assert.equal(f.requests.length, 1);
    f.engine.quiet(false); await f.engine.finishReading(f.book.id); assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

test('窗口不足明停且保留完整待办与旧账本，未用近期窗口代替全文，也不提前处理缓冲', async () => {
  const f = await fixture(() => { throw Error('窗口不足不应到达模型transport'); });
  f.state.settings.services[0].contextLimit = 4096;
  const usage = structuredClone(f.state.usage), memories = structuredClone(f.state.memories), known = structuredClone(f.book.known);
  try {
    await f.engine.startReading(f.book.id);
    await assert.rejects(f.engine.prepare(f.book.id), /窗口|预算|上下文|完整|额度/);
    assert.equal(f.requests.length, 0); assert.deepEqual(f.book.prepared, []); assert.deepEqual(f.book.known, known); assert.deepEqual(f.state.memories, memories);
    for (const row of usage) assert.deepEqual(f.state.usage.find(u => u.id === row.id), row);
    assert.equal(f.state.readingDrafts?.length ?? 0, 0);
    f.book.buffered = [structuredClone(known[1])];
    f.engine.observing(true); const task = f.book.chapters[3];
    await assert.rejects(f.engine.observe(f.book.id, f.book.text.slice(task.start, task.end), 'body', 'continuous-page'), /窗口|预算|上下文|完整|额度/);
    assert.equal(f.requests.length, 0); assert.ok(covers(f.book.fullOriginalPending ?? [], task)); assert.deepEqual(f.book.prepared, []);
    f.engine.pause(); await f.engine.startReading(f.book.id);
    await assert.rejects(f.engine.finishReading(f.book.id), /窗口|预算|上下文|完整|额度/);
    assert.equal(f.requests.length, 0); assert.ok(covers(f.book.fullOriginalPending ?? [], task));
    f.engine.stop(); await f.engine.persist();
    const restored = await restoreBackup(JSON.stringify(f.disk()), initialState()); recoverInterruptedState(restored);
    assert.ok(covers(restored.books[0].fullOriginalPending ?? [], task));
    // Only this isolated engineering fixture gets a restored model window.
    // Historical tokens/fees and the source comparison runner are untouched.
    restored.settings.services[0].contextLimit = 200_000;
    restored.settings.services[0].enabled = true;
    let calls = 0;
    const rebuilt = new ReadingEngine(restored, { async save() {} }, new ChatModel(async request => {
      calls++; const p = material(request.body); assert.equal(p.focusRange.start, task.start); assert.equal(p.focusRange.end, task.end);
      assert.equal(JSON.stringify(request.body).includes('FUTURE-SECRET'), false);
      assert.equal(JSON.stringify(request.body).includes('JOIN-ALLOWED'), false); assert.ok(JSON.stringify(request.body).includes('ALPHA-ALLOWED'));
      return tools(['submit_reading', { reply: '' }]);
    })), harness = new HarnessRuntime(); rebuilt.agent = harness;
    try {
      await rebuilt.startReading(restored.books[0].id); await rebuilt.finishReading(restored.books[0].id);
      assert.equal(calls, 1); assert.ok(covers(restored.books[0].prepared, task)); assert.deepEqual(restored.books[0].fullOriginalPending ?? [], []);
      assert.equal(covers(restored.books[0].prepared, known[0]), false); assert.equal(covers(restored.books[0].prepared, known[1]), false);
      for (const row of usage) assert.deepEqual(restored.usage.find(u => u.id === row.id), row);
    } finally { rebuilt.stop(); await harness.dispose(); }
  } finally { await f.close(); }
});

test('旧缺省structured草稿与新full-original草稿按形成策略恢复，不因书级切换重生成或丢结构', async () => {
  for (const savedStrategy of [undefined, 'full-original'] as const) {
    const f = await fixture(() => { throw Error('冻结草稿不得再次请求模型'); });
    const range = f.book.known[0], reply = { reply: '', thoughts: [], wantsLong: false,
      ...(savedStrategy ? {} : { readingBrief: '旧结构草稿完整简报。' }) };
    const draft = createReadingDraft(f.state, f.book, { source: 'preparation', ranges: [range], input: '' }, reply, [],
      { messages: [], refs: [evidence(f.book, range)], originalRanges: [range], memoryIds: [], chatIds: [], habitIds: [], passages: [],
        ...(savedStrategy ? { readingStrategy: savedStrategy } : {}) }, 'ready');
    f.state.readingDrafts = [draft];
    // Other already handled ranges avoid generating independent work after the
    // one frozen draft. This is a saved draft recovery test, not migration.
    f.book.prepared = [f.book.known[1]]; f.book.readingStrategy = savedStrategy ? 'structured' : 'full-original';
    try {
      await f.engine.startReading(f.book.id); await f.engine.prepare(f.book.id);
      assert.equal(f.requests.length, 0); assert.equal(f.state.readingDrafts!.length, 0); assert.ok(covers(f.book.prepared, range));
      assert.equal(f.state.memories.some(m => m.text === '旧结构草稿完整简报。'), !savedStrategy);
    } finally { await f.close(); }
  }
});

test('旧reading阶段草稿遇书级全文策略，零模型请求按形成协议保存stage/state后才消费', async () => {
  const f = await fixture(() => { throw Error('旧阶段草稿不得重新生成'); }), range = f.book.known[0];
  f.book.prepared = [f.book.known[1]];
  const draft = createReadingDraft(f.state, f.book, { source: 'reading', ranges: [range], input: '阅读推进，请一起理解current与additionalReadings中的新片段，按原文坐标联系前后；未提供的间隔不补写。允许安静结束。' },
    { reply: '', thoughts: [], wantsLong: false, stageNarrative: { text: '设备保管条件已经确定，事务仍在继续。' },
      stateUpdates: [{ topic: '保管约束', text: '每月检修，项目结束后才解除保管约束。' }] }, [],
    { messages: [], refs: [evidence(f.book, range)], originalRanges: [range], memoryIds: [], chatIds: [], habitIds: [], passages: [], narrativeMode: 'stages' }, 'ready');
  f.state.readingDrafts = [draft];
  try {
    await f.engine.startReading(f.book.id); await f.engine.finishReading(f.book.id);
    assert.equal(f.requests.length, 0); assert.equal(f.state.readingDrafts!.length, 0); assert.ok(covers(f.book.prepared, range));
    assert.equal(f.state.memories.find(m => m.kind === 'stage')!.text, draft.result.stageNarrative!.text);
    assert.equal(f.state.memories.find(m => m.kind === 'state')!.text, draft.result.stateUpdates![0].text);
    assert.equal(f.state.memories.find(m => m.kind === 'state')!.stateProjection!.writeVersion, undefined);
  } finally { await f.close(); }
});
