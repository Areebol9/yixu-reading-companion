import test from 'node:test';
import assert from 'node:assert/strict';
import { importBook, covers } from '../src/core/books.ts';
import { initialState } from '../src/core/state.ts';
import { ReadingEngine } from '../src/core/engine.ts';
import { ChatModel } from '../src/core/model.ts';
import { HarnessRuntime } from '../src/agent/runtime.ts';
import { planWorkspace, workspaceFor } from '../src/core/companion-workspace.ts';
import type { Book, Memory, Range, State, Store } from '../src/core/types.ts';

let toolSequence = 0;
const tool = (name: string, args: unknown) => ({ status: 200, body: { choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [{ id: 'architecture-mock-' + (++toolSequence), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 17, completion_tokens: 9 } } });
const natural = (content: string) => ({ status: 200, body: { choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 17, completion_tokens: 9 } } });
const packets = (body: any) => body.messages.filter((m: any) => m.role === 'user').flatMap((m: any) => m.content.split('\n\n')).flatMap((content: string) => { try { return [JSON.parse(content)]; } catch { return []; } });
const main = (body: any) => packets(body).find((p: any) => p.currentRange)!;
const isConversation = (body: any) => packets(body).some((p: any) => p.task === 'conversation');
const toolResults = (body: any) => body.messages.filter((m: any) => m.role === 'tool').flatMap((m: any) => { try { return [JSON.parse(m.content)]; } catch { return []; } });
const navigation = (body: any) => toolResults(body).flatMap((p: any) => p.results ?? []).filter((r: any) => r.source === '本题事件原文导航，非事实结论').map((r: any) => JSON.parse(r.text)).at(-1)!;
const recallPages = (body: any) => toolResults(body).flatMap((p: any) => p.results ?? []).flatMap((r: any) => { try { return [JSON.parse(r.text)]; } catch { return []; } });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function within<T>(promise: Promise<T>, stage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('ENGINE MOCK 等待阶段超时：' + stage)), 5000); })]); }
  finally { if (timer) clearTimeout(timer); }
}

async function fixture(book: Book, respond: (body: any, signal: AbortSignal) => unknown | Promise<unknown>) {
  const state = initialState(); state.books = [book];
  state.settings.services[0].enabled = true; state.settings.tokenLimit = 3000000; state.settings.minReadChars = 1; state.settings.defaultQuiet = true;
  let disk = structuredClone(state), saveObserver = (_value: State) => {}; const requests: any[] = [], saves: State[] = [];
  const store: Store = { async load() { return structuredClone(disk); }, async save(value) { disk = structuredClone(value); saves.push(disk); saveObserver(value); } };
  const model = new ChatModel(async (request, signal) => { requests.push(request.body); assert.ok(!JSON.stringify(request.body).includes('UNREAD-ARCHITECTURE-SECRET')); return await respond(request.body, signal) as any; });
  const engine = new ReadingEngine(state, store, model), runtime = new HarnessRuntime(); engine.agent = runtime;
  // Exercise production defaults; do not assign companionCandidate or use the
  // workbench's opt-in switches to make these tools or scheduling available.
  await engine.startReading(book.id);
  return { state, book, engine, requests, saves, onSave(observer: (value: State) => void) { saveObserver = observer; }, get disk() { return structuredClone(disk); }, async close() { engine.stop(); await runtime.dispose(); } };
}

test('普通默认伴读沿正式Harness成组定位早晚事件、分段展开并同任务查证，未读间隔不进入输入', async () => {
  const early = '第一章 登记\nENGINE MOCK 事件：登记员甲记录校准仍未完成。\n' + '已读登记条件。'.repeat(30) + '\n';
  const gap = '第二章 间隔\nUNREAD-ARCHITECTURE-SECRET：ENGINE MOCK 事件未授权细节。\n' + '未读'.repeat(180) + '\n';
  const lateQuote = 'ENGINE MOCK 事件：操作员乙于次日完成校准。';
  const late = '第三章 校准\n' + lateQuote + '\n' + '已读后续记录。'.repeat(35);
  const book = await importBook('ENGINE MOCK 默认事件导航', early + gap + late);
  book.known = [{ start: 0, end: early.length }, { start: early.length + gap.length, end: book.text.length }]; book.prepared = structuredClone(book.known); book.position = book.text.length;
  let turn = 0, expanded: Range[] = [], supportSource = '';
  const final = 'ENGINE MOCK 核对完成：登记当时仍未校准，次日由操作员乙完成。';
  const f = await fixture(book, body => {
    assert.equal(isConversation(body), true);
    if (++turn === 1) return tool('navigate_reading_event', { queries: [{ query: 'ENGINE MOCK 事件', order: 'source-asc' }, { query: 'ENGINE MOCK 事件', order: 'source-desc' }] });
    if (turn === 2) {
      const nav = navigation(body);
      assert.equal(nav.groups.length, 2);
      const first = nav.groups[0].items[0], later = nav.groups[1].items[0];
      assert.ok(first.end <= early.length); assert.ok(later.start >= early.length + gap.length);
      expanded = [first, later];
      // A location encompassing both permitted fragments must not authorize
      // the intervening page. The same task can correct the request afterward.
      return tool('navigate_reading_event', { ranges: [{ start: first.start, end: later.end }] });
    }
    if (turn === 3) {
      assert.ok(body.messages.some((m: any) => m.role === 'tool' && /允许阅读|获准|未读/.test(m.content)));
      return tool('navigate_reading_event', { ranges: expanded });
    }
    if (turn === 4) {
      const nav = navigation(body); assert.deepEqual(nav.expanded.map((x: any) => x.range), expanded);
      for (const result of toolResults(body).flatMap((p: any) => p.results ?? [])) {
        if (typeof result.text !== 'string') continue;
        for (const match of result.text.matchAll(/【(p[1-9]\d*)】([\s\S]*?)(?=【p[1-9]\d*】|$)/g)) if (match[2].includes(lateQuote)) supportSource = match[1];
      }
      assert.ok(supportSource, '已展开的获准原文须携带本轮实际p编号');
      return tool('check_answer_support', { claims: [{ statement: 'ENGINE MOCK 操作员乙于次日完成校准。', sourceId: supportSource, quote: lateQuote }] });
    }
    assert.equal(turn, 5);
    const checked = toolResults(body).find((p: any) => p.checks);
    assert.equal(checked.checks[0].sourceId, supportSource); assert.equal(checked.checks[0].quote, lateQuote);
    assert.equal(checked.checks[0].evidence.start, book.text.indexOf(lateQuote));
    return natural(final);
  });
  try {
    assert.equal(f.engine.session?.readingStrategy, 'companion');
    await f.engine.ask(book.id, '核对登记当时与次日的校准关系。');
    assert.equal(f.requests.length, 5); assert.equal(f.state.chats.filter(c => c.role === 'assistant').length, 1);
    assert.equal(f.state.chats.find(c => c.role === 'assistant')?.text, final);
    assert.ok(f.state.chats.filter(c => c.role === 'user').every(c => c.delivery === 'answered'));
    assert.deepEqual(f.state.books[0].known, book.known);
  } finally { await f.close(); }
});

for (const focusChange of [false, true]) {
  test(`默认后台完整正文在连续前台队列未清空时推进当前理解，保留${focusChange ? '新关注' : '纯聊天关注'}与最新聊天且原答不重发`, async () => {
    const book = await importBook('ENGINE MOCK 默认并发', '第一章 登记\nENGINE MOCK 登记待校准。\n第二章 校准\nENGINE MOCK 已完成校准，复测在进行。\n第三章 未读\nUNREAD-ARCHITECTURE-SECRET');
    book.known = [{ start: 0, end: book.chapters[0].end }]; book.prepared = structuredClone(book.known); book.position = book.chapters[0].end;
    const backgroundStarted = deferred(), backgroundRelease = deferred(), firstStarted = deferred(), firstRelease = deferred(), secondStarted = deferred(), secondRelease = deferred(), thirdSaved = deferred();
    const pending: Promise<unknown>[] = [], track = <T>(p: Promise<T>) => { pending.push(p); void p.catch(() => {}); return p; };
    let backgroundCalls = 0, foregroundCalls = 0, firstCalls = 0, backgroundSignal: AbortSignal | undefined;
    const backgroundBody = 'ENGINE MOCK 连续理解：登记待校准，现已校准并进入复测，完成移交仍需后续核对。'.repeat(85);
    const f = await fixture(book, async (body, signal) => {
      if (!isConversation(body)) { backgroundCalls++; backgroundSignal = signal; backgroundStarted.resolve(); await backgroundRelease.promise; return natural(backgroundBody); }
      foregroundCalls++;
      const task = packets(body).find((p: any) => p.task === 'conversation');
      if (task.userText.includes('第一问')) {
        if (++firstCalls === 1) { firstStarted.resolve(); await firstRelease.promise; if (focusChange) return tool('recall_memory', { query: 'FOCUS TARGET', kind: 'question', view: 'full' }); }
        if (focusChange) { const page = recallPages(body).find((p: any) => p.request?.view === 'full'); assert.ok(page.items.some((m: any) => m.text.includes('FOCUS TARGET'))); return tool('submit_reading', { reply: 'ENGINE MOCK 第一问已核对并调整关注。', workspace: { focus: [page.items.find((m: any) => m.text.includes('FOCUS TARGET')).id] } }); }
        return natural('ENGINE MOCK 第一问已核对。');
      }
      if (task.userText.includes('第二问')) { secondStarted.resolve(); await secondRelease.promise; return natural('ENGINE MOCK 第二问已核对。'); }
      assert.equal(main(body).workspaceMaterial.understanding.text, backgroundBody);
      return natural('ENGINE MOCK 第三问接续当前完整理解。');
    });
    try {
      f.onSave(value => { if (value.chats.some(c => c.role === 'user' && c.text.includes('第三问'))) thirdSaved.resolve(); });
      const memory = (id: string, kind: Memory['kind'], text: string): Memory => ({ id, kind, text, bookId: book.id, partnerId: f.state.partnerId, source: 'reading', evidence: [{ ...book.known[0], bookId: book.id, version: book.version }], parents: [], chatIds: [], createdAt: 1, forgotten: false });
      const understanding = memory('architecture-seed', 'opinion', 'ENGINE MOCK 登记尚待校准，后续关注复测。'), oldFocus = memory('architecture-focus-old', 'question', 'ENGINE MOCK OLD FOCUS 复测能否完成？'), target = memory('architecture-focus-next', 'question', 'ENGINE MOCK FOCUS TARGET 移交条件能否成立？');
      f.state.memories.push(understanding, oldFocus, target);
      planWorkspace(f.state, book, { understanding: understanding.id, focus: [oldFocus.id] }, { memoryIds: [understanding.id, oldFocus.id] }, { expectedRevision: 0 });
      f.engine.observing(true); const page = book.chapters[1];
      const reading = track(f.engine.observe(book.id, book.text.slice(page.start, page.end), 'body', 'continuous-page'));
      await within(backgroundStarted.promise, '后台正文派发');
      const first = track(f.engine.ask(book.id, '第一问：核对当前关注条件。'));
      await within(firstStarted.promise, '第一前台问题派发');
      const second = track(f.engine.ask(book.id, '第二问：核对当前校准记录。'));
      firstRelease.resolve(); await within(first, '第一问完整保存'); await within(secondStarted.promise, '第二问保持在途');
      const third = track(f.engine.ask(book.id, '第三问：接续当前校准理解。'));
      await within(thirdSaved.promise, '第三问入队并保存');
      const latestChat = workspaceFor(f.state, book).lastChatId;
      assert.ok(f.state.chats.find(c => c.id === latestChat)?.text.includes('第三问'));
      assert.equal(f.engine.readingFlow.foregroundPending, 2);
      backgroundRelease.resolve(); await within(reading, '前台仍在途时后台正文保存');
      const currentBook = f.state.books[0], workspace = workspaceFor(f.state, currentBook), current = f.state.memories.find(m => m.id === workspace.understandingId)!;
      assert.equal(current.text, backgroundBody); assert.equal(current.historicalOnly, undefined);
      assert.deepEqual(workspace.focusIds, [focusChange ? target.id : oldFocus.id]); assert.equal(workspace.lastChatId, latestChat);
      assert.ok(covers(currentBook.prepared, page)); assert.equal(f.state.chats.filter(c => c.role === 'assistant').length, 1);
      assert.equal(f.engine.readingFlow.foregroundPending, 2, '后台完成时前台队列仍有两问');
      assert.equal(backgroundSignal?.aborted, false); assert.equal(backgroundCalls, 1);
      assert.equal(f.state.readings?.filter(r => r.processing === 'model').length, 1);
      assert.deepEqual(f.state.companionReadingReceipts, []); assert.deepEqual(f.state.readingDrafts, []);
      secondRelease.resolve(); await within(second, '第二问继续交付'); await within(third, '第三问接续新理解');
      assert.equal(f.state.chats.filter(c => c.role === 'assistant').length, 3);
      assert.ok(f.state.chats.filter(c => c.role === 'user').every(c => c.delivery === 'answered'));
      assert.equal(foregroundCalls, focusChange ? 4 : 3); assert.equal(backgroundCalls, 1);
      assert.equal(workspaceFor(f.state, currentBook).understandingId, current.id);
      assert.deepEqual(workspaceFor(f.state, currentBook).focusIds, [focusChange ? target.id : oldFocus.id]);
      await f.engine.prepare(book.id); assert.equal(backgroundCalls, 1, '完整已收到正文不能再派发');
    } finally { backgroundRelease.resolve(); firstRelease.resolve(); secondRelease.resolve(); await f.close(); await Promise.allSettled(pending); }
  });
}

test('后台取材后的下一供应商轮在连续前台完成两问后实际派发，第三问在途与后续排队仍保持单前台单后台', async () => {
  const book = await importBook('ENGINE MOCK 后台公平派发', '第一章 登记\nENGINE MOCK 原登记条件。\n第二章 校准\nENGINE MOCK 校准完成，复测仍在进行。\n第三章 未读\nUNREAD-ARCHITECTURE-SECRET');
  book.known = [{ start: 0, end: book.chapters[0].end }]; book.prepared = structuredClone(book.known); book.position = book.chapters[0].end;
  const backgroundStarted = deferred(), firstBackgroundRelease = deferred(), waiting = deferred(), firstStarted = deferred(), firstRelease = deferred(), secondStarted = deferred(), secondRelease = deferred(), thirdStarted = deferred(), thirdRelease = deferred(), allQuestionsSaved = deferred(), secondBackgroundDispatched = deferred();
  const pending: Promise<unknown>[] = [], track = <T>(p: Promise<T>) => { pending.push(p); void p.catch(() => {}); return p; };
  const bodyText = 'ENGINE MOCK 后台完整理解：保留原登记条件，校准已完成，复测仍在进行。'.repeat(80);
  let foregroundCalls = 0, backgroundCalls = 0, activeForeground = 0, activeBackground = 0, maxActive = 0, unsubscribe = () => {};
  let waitingSnapshot: ReadingEngine['readingFlow'] | undefined;
  const f = await fixture(book, async body => {
    const foreground = isConversation(body);
    if (foreground) activeForeground++; else activeBackground++;
    maxActive = Math.max(maxActive, activeForeground + activeBackground);
    assert.ok(activeForeground <= 1); assert.ok(activeBackground <= 1); assert.ok(activeForeground + activeBackground <= 2);
    try {
      if (!foreground) {
        if (++backgroundCalls === 1) { backgroundStarted.resolve(); await firstBackgroundRelease.promise; const range = main(body).currentRange; return tool('read_original', { start: range.start, end: range.end }); }
        assert.equal(backgroundCalls, 2);
        assert.ok(body.messages.some((m: any) => m.role === 'tool' && m.content.includes('ENGINE MOCK 校准完成，复测仍在进行。')));
        assert.equal(f.state.chats.filter(c => c.role === 'assistant').length, 2);
        assert.equal(f.engine.readingFlow.foregroundPending, 2);
        secondBackgroundDispatched.resolve();
        await thirdStarted.promise;
        assert.equal(activeForeground, 1); assert.equal(activeBackground, 1);
        return tool('finish_reading', { text: bodyText });
      }
      foregroundCalls++;
      const task = packets(body).find((p: any) => p.task === 'conversation');
      if (task.userText.includes('第一问')) { firstStarted.resolve(); await firstRelease.promise; return natural('ENGINE MOCK 第一问已回答。'); }
      if (task.userText.includes('第二问')) { secondStarted.resolve(); await secondRelease.promise; return natural('ENGINE MOCK 第二问已回答。'); }
      if (task.userText.includes('第三问')) { thirdStarted.resolve(); await thirdRelease.promise; return natural('ENGINE MOCK 第三问已回答。'); }
      assert.equal(main(body).workspaceMaterial.understanding.text, bodyText);
      return natural('ENGINE MOCK 第四问已接续后台新理解。');
    } finally { if (foreground) activeForeground--; else activeBackground--; }
  });
  try {
    f.onSave(state => { if (state.chats.filter(c => c.role === 'user').length === 4) allQuestionsSaved.resolve(); });
    unsubscribe = f.engine.subscribe(() => { const flow = f.engine.readingFlow; if (flow.backgroundWaitingSince && flow.foregroundPending >= 3) { waitingSnapshot = { ...flow }; waiting.resolve(); } });
    f.engine.observing(true); const page = book.chapters[1], reading = track(f.engine.observe(book.id, book.text.slice(page.start, page.end), 'body', 'continuous-page'));
    await within(backgroundStarted.promise, '后台第一轮派发');
    const first = track(f.engine.ask(book.id, '第一问：核对登记。')); await within(firstStarted.promise, '第一问在途');
    const second = track(f.engine.ask(book.id, '第二问：核对校准。'));
    const third = track(f.engine.ask(book.id, '第三问：核对复测。'));
    const fourth = track(f.engine.ask(book.id, '第四问：接续完整理解。'));
    await within(allQuestionsSaved.promise, '后续三问入队'); firstBackgroundRelease.resolve();
    await within(waiting.promise, '后台第二轮在真实dispatch阶段让位');
    assert.ok(waitingSnapshot?.backgroundWaitingSince); assert.ok(waitingSnapshot!.foregroundPending >= 3); assert.ok(waitingSnapshot!.activeChars > 0);
    assert.equal(backgroundCalls, 1);
    firstRelease.resolve(); await within(first, '第一问保存'); await within(secondStarted.promise, '第二问在途'); assert.equal(backgroundCalls, 1);
    secondRelease.resolve(); await within(second, '第二问保存');
    await within(secondBackgroundDispatched.promise, '两问完成后后台第二轮派发'); await within(thirdStarted.promise, '第三问在途');
    await within(reading, '第三问未结束时后台交稿保存');
    assert.equal(backgroundCalls, 2); assert.equal(foregroundCalls, 3); assert.equal(maxActive, 2);
    assert.equal(f.engine.readingFlow.foregroundPending, 2); assert.ok(covers(f.state.books[0].prepared, page));
    assert.equal(f.state.memories.find(m => m.id === workspaceFor(f.state, f.state.books[0]).understandingId)?.text, bodyText);
    thirdRelease.resolve(); await within(third, '第三问继续回答'); await within(fourth, '第四问正常接续');
    assert.equal(foregroundCalls, 4); assert.equal(f.state.chats.filter(c => c.role === 'assistant').length, 4);
    assert.ok(f.state.chats.filter(c => c.role === 'user').every(c => c.delivery === 'answered'));
    assert.equal(f.requests.length, 6); await f.engine.prepare(book.id); assert.equal(f.requests.length, 6);
    assert.equal(activeForeground, 0); assert.equal(activeBackground, 0);
  } finally { unsubscribe(); firstBackgroundRelease.resolve(); firstRelease.resolve(); secondRelease.resolve(); thirdRelease.resolve(); await f.close(); await Promise.allSettled(pending); }
});
