import { test } from 'node:test';
import assert from 'node:assert/strict';
import { covers, importBook, locateObservation, subtractRanges } from '../src/core/books.ts';
import { completePrelude, planReading, readyToRead } from '../src/core/reading-units.ts';
import { ReadingEngine } from '../src/core/engine.ts';
import { restoreBackup } from '../src/core/backup.ts';
import { initialState } from '../src/core/state.ts';
import {readingProgress} from '../src/core/reading-progress.ts';
import type { ModelMessage, State } from '../src/core/types.ts';

const first = '记录甲：三台设备已经登记，负责人已完成签收。';
const second = '记录乙：新增五台设备，其中两台送往乙柜，其余三台留在甲柜。';
const third = '记录丙：另一批设备另行登记，负责人尚未签收。';
const raw = '第一章 登记\n' + first + second + '\n第二章 核查\n' + third;
const payload = (messages: ModelMessage[]) => messages.flatMap(m => { try { return [JSON.parse(m.content)]; } catch { return []; } }).find(p => p.currentRange);
const reply = { content: JSON.stringify({ reply: '', thoughts: [], wantsLong: false }), input: 10, output: 10, estimated: false, elapsedMs: 1 };

test('进度目录分别报告已获准、已处理与缓冲，缺口不合并，未获准背景不影响输出',async()=>{
  const book=await importBook('进度工程资料',raw),split=book.chapters[1].start;
  book.known=[{start:0,end:20},{start:30,end:split}];book.prepared=[{start:0,end:15},{start:30,end:split-4}];book.buffered=[{start:split-4,end:split}];
  const progress=readingProgress(book);
  assert.equal(progress.availableOriginal.continuousFromStartThrough,20);
  assert.equal(progress.processedOriginal.continuousFromStartThrough,15);
  assert.deepEqual(progress.awaitingTextCompletion.ranges,book.buffered);
  assert.deepEqual(readingProgress(book,'reading',[],[]).awaitingTextCompletion.ranges,[]);
  book.backgroundPrepared=[...book.prepared,{start:split,end:raw.length}];
  assert.deepEqual(readingProgress(book,'background').processedOriginal,progress.processedOriginal);
  assert.deepEqual(readingProgress(book),progress);
  assert.equal(readingProgress(book,'background',[{start:split,end:raw.length}]).processedOriginal.ranges.at(-1)?.end,raw.length);
  book.known=Array.from({length:12},(_,i)=>({start:i*5,end:i*5+2}));book.prepared=[];book.buffered=[];
  const fragmented=readingProgress(book).availableOriginal;
  assert.equal(fragmented.ranges.length,8);assert.equal(fragmented.rangeCount,12);assert.equal(fragmented.rangesComplete,false);
});

test('获准范围停在半句时只计划完整部分，补齐小缺口时提供整句上下文', async () => {
  const book = await importBook('调度资料', raw), cut = raw.indexOf('其中') + 2;
  book.known = [{ start: 0, end: cut }];
  const plan = planReading(book, book.known, book.known);
  const firstEnd = raw.indexOf(second);
  assert.deepEqual(plan.batches, [[{ start: 0, end: firstEnd }]]);
  assert.deepEqual(plan.buffered, [{ start: firstEnd, end: cut }]);
  book.known = [{ start: 0, end: raw.indexOf('\n第二章') }];
  const hole = { start: raw.indexOf('五台'), end: raw.indexOf('五台') + 2 };
  const repair = planReading(book, book.known, [hole]);
  assert.equal(book.text.slice(repair.batches[0][0].start, repair.batches[0][0].end), second);
  assert.deepEqual(repair.buffered, []);
});

test('规划按章、按额度组织，跳读缺口和未授权后文不进入材料', async () => {
  const book = await importBook('调度资料', raw), end = raw.indexOf(second), next = raw.indexOf('第二章');
  const allowed = [{ start: 0, end }, { start: next, end: raw.length }];
  const plan = planReading(book, allowed, allowed);
  assert.equal(plan.batches.length, 2);
  for (const batch of plan.batches) for (const r of batch) assert.ok(covers(allowed, r));
  assert.equal(plan.batches.flat().map(r => raw.slice(r.start, r.end)).join('').includes(second), false);
  const long = await importBook('长段资料', '甲'.repeat(15000));
  const bounded = planReading(long, [{ start: 0, end: long.text.length }], [{ start: 0, end: long.text.length }]);
  assert.ok(bounded.batches.every(b => b.reduce((n, r) => n + r.end - r.start, 0) <= 6000));
  assert.deepEqual(bounded.buffered, []);
});

test('已观察的纯空白缺口按布局接续，不调用模型、不滞留为未成段正文',async()=>{
  const state=initialState(),book=await importBook('空白补齐资料','第一章 登记\n设备已登记。\n\n\n第二章 签收\n负责人已签收。');
  const end=book.text.indexOf('\n\n\n'),next=end+3;
  state.books=[book];book.known=[{start:0,end:book.text.length}];book.prepared=[{start:0,end},{start:next,end:book.text.length}];book.position=book.text.length;
  const engine=new ReadingEngine(state,{async load(){return state;},async save(){}},{async complete(){throw new Error('Whitespace must not call the model');}});
  try{await engine.startReading(book.id);await engine.prepare(book.id);assert.deepEqual(subtractRanges(book.known,book.prepared),[]);assert.equal(state.readings?.at(-1)?.processing,'layout');}finally{engine.stop();}
});

test('独立卷标题按布局处理，不调用模型且不阻断背景作品完整覆盖', async () => {
  const state = initialState(), book = await importBook('卷标题资料', '第一卷 工程记录\n第一章 登记\n设备甲已经登记。');
  state.books = [book]; state.settings.services[0].enabled = true; let calls = 0;
  const engine = new ReadingEngine(state, { async load() { return state; }, async save() {} }, { async complete() { calls++; return reply; } });
  try {
    await engine.prepareBackground(book.id);
    assert.equal(calls, 1); assert.ok(covers(book.backgroundPrepared!, { start: 0, end: book.text.length }));
    assert.equal(state.readings?.[0].processing, 'layout'); assert.deepEqual(state.readings?.[0].memoryIds, []);
    assert.ok(state.partners[0].backgroundBooks.includes(book.id));
  } finally { engine.stop(); }
});

test('定位只补入确实出现的标点，截屏缺失标点时不借用原文下一字', async () => {
  const book = await importBook('调度资料', raw);
  const full = locateObservation(book, first), partial = locateObservation(book, first.slice(0, -1));
  assert.equal(full.status, 'matched'); assert.equal(partial.status, 'matched');
  if (full.status === 'matched' && partial.status === 'matched') {
    assert.equal(full.ranges.at(-1)!.end, raw.indexOf(second));
    assert.equal(partial.ranges.at(-1)!.end, raw.indexOf(second) - 1);
  }
  const cut = raw.indexOf('其中') + 2;
  assert.equal(completePrelude(book, [{ start: 0, end: cut }]).at(-1)!.end, raw.indexOf(second));
});

test('下页开头的实际逗号和缩进保留定位，旧页半句可接续，未显示的边缘不补入',async()=>{
  const text='第一章 登记\n设备交付前需要继续核对登记记录，随后由当班负责人确认数量无误并签收。\n\n\n';
  const state=initialState(),book=await importBook('边缘工程资料',text),start=text.indexOf('设备'),split=text.indexOf('，');
  state.books=[book];book.known=[{start:0,end:start}];book.prepared=[...book.known];book.position=start;state.settings.services[0].enabled=true;state.settings.minReadChars=1;
  const noComma=locateObservation(book,text.slice(split+1).trimEnd());
  assert.equal(noComma.status,'matched');if(noComma.status==='matched'){assert.equal(noComma.range.start,split+1);assert.equal(noComma.range.end,text.length-3);}
  let calls=0;const engine=new ReadingEngine(state,{async load(){return state;},async save(){}},{async complete(_service,messages){calls++;assert.ok(payload(messages).current.includes('登记记录，随后'));return reply;}});
  try{
    await engine.startReading(book.id);engine.observing(true);
    await engine.observe(book.id,text.slice(start,split),'body','continuous-page');
    assert.equal(calls,0);assert.deepEqual(book.buffered,[{start,end:split}]);
    await engine.observe(book.id,text.slice(split),'body','continuous-page');
    assert.equal(calls,1);assert.deepEqual(subtractRanges(book.known,book.prepared),[]);assert.deepEqual(book.known,[{start:0,end:text.length}]);
  }finally{engine.stop();}
});

test('缓冲经准备、备份和重启保留，后页接成整句后才进入理解', async () => {
  const state = initialState(), book = await importBook('调度资料', raw), cut = raw.indexOf('其中') + 2;
  book.known = [{ start: 0, end: cut }]; book.position = cut; state.books = [book];
  state.settings.services[0].enabled = true; state.settings.minReadChars = 1;
  const requests: ModelMessage[][] = []; let saved = structuredClone(state);
  const store = { async load() { return saved; }, async save(value: State) { saved = structuredClone(value); } };
  const model = { async complete(_service: unknown, messages: ModelMessage[]) { requests.push(messages); return reply; } };
  let engine = new ReadingEngine(state, store, model);
  await engine.startReading(book.id); assert.equal(engine.session?.prepared, false);
  await engine.prepare(book.id);
  assert.equal(engine.session?.prepared, true); assert.equal(readyToRead(book), true);
  assert.equal(requests.length, 1); assert.equal(JSON.stringify(requests).includes('新增五台'), false);
  assert.deepEqual(subtractRanges(book.known, book.prepared), book.buffered);
  engine.stop();
  const restored = await restoreBackup(JSON.stringify(saved), initialState());
  restored.settings.services[0].enabled = true;
  engine = new ReadingEngine(restored, store, model);
  try {
    await engine.startReading(book.id); engine.observing(true);
    assert.equal(engine.session?.prepared, true);
    await engine.observe(book.id, second);
    assert.equal(requests.length, 2); assert.equal(payload(requests[1]).current, second);
    assert.deepEqual(restored.books[0].buffered, []);
    assert.ok(covers(restored.books[0].prepared, { start: raw.indexOf(second), end: raw.indexOf('\n第二章') }));
    assert.equal(JSON.stringify(requests).includes(third), false);
    const tampered = structuredClone(restored); tampered.books[0].buffered = [{ start: raw.length - 2, end: raw.length }];
    await assert.rejects(restoreBackup(JSON.stringify(tampered), initialState()), /缓冲超出/);
  } finally { engine.stop(); }
});

test('只有章标题和半句时无需模型，可等待后页；主动问题仍能讨论已显示部分', async () => {
  const state = initialState(), book = await importBook('调度资料', raw), cut = raw.indexOf('三台') + 2;
  book.known = [{ start: 0, end: cut }]; book.position = cut; state.books = [book]; state.settings.services[0].enabled = true;
  const requests: ModelMessage[][] = [];
  const engine = new ReadingEngine(state, { async load() { return state; }, async save() {} }, { async complete(_service, messages) { requests.push(messages); return reply; } });
  try {
    await engine.startReading(book.id); await engine.prepare(book.id);
    assert.equal(requests.length, 0); assert.equal(engine.session?.prepared, true); assert.deepEqual(book.prepared, []);
    await engine.ask(book.id, '已显示的设备数量是多少？');
    assert.equal(requests.length, 1); assert.ok(payload(requests[0]).current.includes('三台'));
    assert.deepEqual(book.prepared, []);
  } finally { engine.stop(); }
});

test('自动回查不重新引入缓冲尾部，记忆仍按完整获准范围筛选', async () => {
  const state = initialState(), book = await importBook('调度资料', raw), cut = raw.indexOf('其中') + 2;
  book.known = [{ start: 0, end: cut }]; book.position = cut; state.books = [book]; state.settings.services[0].enabled = true;
  state.memories.push({ id: 'retained', bookId: book.id, partnerId: state.partnerId, kind: 'story', text: '已有设备登记记录。',
    evidence: [{ bookId: book.id, version: book.version, start: 0, end: cut }], parents: [], chatIds: [], createdAt: 1, forgotten: false, source: 'reading' });
  let calls = 0;
  const engine = new ReadingEngine(state, { async load() { return state; }, async save() {} }, { async complete(_service, messages) {
    calls++;
    assert.ok(payload(messages).memories.some((m: { text: string }) => m.text === '已有设备登记记录。'));
    if (calls === 1) return { ...reply, content: JSON.stringify({ reply: '', thoughts: [], lookup: '新增五台', read: { start: raw.indexOf(second), end: cut } }) };
    const results = messages.flatMap(m => { try { return JSON.parse(m.content).toolResults ?? []; } catch { return []; } });
    assert.equal(results.some((r: { source: string; text: string }) => r.source === '获准原文' && r.text.includes('新增五台')), false);
    return reply;
  } });
  try { await engine.startReading(book.id); await engine.prepare(book.id); assert.equal(calls, 2); }
  finally { engine.stop(); }
});

test('页尾有缓冲仍可针对完整内容交流，重复画面和段评不把半句标为已处理', async () => {
  const state = initialState(), book = await importBook('调度资料', raw), cut = raw.indexOf('其中') + 2;
  const start = raw.indexOf(first); book.known = [{ start: 0, end: start }]; book.prepared = [...book.known]; book.position = start;
  state.books = [book]; state.settings.services[0].enabled = true; state.settings.minReadChars = 1; state.settings.minReactionMs = 0;
  const shown: string[] = [], requests: ModelMessage[][] = [];
  const engine = new ReadingEngine(state, { async load() { return state; }, async save() {} }, { async complete(_service, messages) {
    requests.push(messages); assert.equal(payload(messages).current.includes('新增五台'), false);
    return { ...reply, content: JSON.stringify({ reply: '工程状态已登记。', thoughts: [] }) };
  } });
  try {
    engine.onReaction = text => shown.push(text);
    await engine.startReading(book.id); engine.observing(true);
    await engine.observe(book.id, raw.slice(0, cut));
    assert.deepEqual(shown, ['工程状态已登记。']); assert.equal(requests.length, 1);
    await engine.observe(book.id, raw.slice(0, cut)); assert.equal(requests.length, 1);
    await engine.observe(book.id, '这份登记有待检查。', 'comment'); assert.equal(requests.length, 2);
    await engine.finishReading(book.id); assert.equal(requests.length, 3);
    assert.deepEqual(book.buffered, [{ start: raw.indexOf(second), end: cut }]);
    assert.equal(covers(book.prepared, book.buffered[0]), false);
  } finally { engine.stop(); }
});
