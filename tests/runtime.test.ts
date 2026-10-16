import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadingRuntime } from '../src/core/runtime.ts';
import { ReadingEngine } from '../src/core/engine.ts';
import { initialState } from '../src/core/state.ts';
import { importBook } from '../src/core/books.ts';
import type { RuntimeHost } from '../src/core/runtime.ts';
import type { ModelPort, Store } from '../src/core/types.ts';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; }
const pages = ['工程登记甲：设备AX数量3件，原存放于甲柜。', '工程登记乙：设备AX已移至乙柜，数量仍为3件。'];
const store: Store = { async load() { return undefined; }, async save() {} };
function packet(reply = '', thoughts: unknown[] = []) { return { content: JSON.stringify({ reply, thoughts, wantsLong: false }), input: 10, output: 10, estimated: false, elapsedMs: 1 }; }
function fakeHost(run?: (method: string, payload: any) => Promise<unknown>) {
  const calls: { method: string; payload: any }[] = [];
  const host: RuntimeHost = { available: true, async request<T>(method, payload) {
    calls.push({ method, payload });
    if (method === 'readingSources') return [{ id: 'qidian', installed: true }, { id: 'other', installed: true }] as T;
    return (await run?.(method, payload) ?? {}) as T;
  } };
  return { host, calls, last: (method: string) => calls.filter(c => c.method === method).at(-1)?.payload };
}
async function fixture(model?: ModelPort, persistence = store) {
  const state = initialState(), book = await importBook('运行核心工程资料', '第一章 登记\n' + pages.join('\n') + '\n第二章 未读\nRUNTIME-FUTURE-SENTINEL');
  book.position = book.text.indexOf(pages[0]); book.known = [{ start: 0, end: book.position }]; book.prepared = [...book.known]; state.books = [book]; state.settings.services[0].enabled = true; state.settings.minReadChars = 1; state.settings.minReactionMs = 0;
  const engine = new ReadingEngine(state, persistence, model ?? { async complete(s, messages) { assert.equal(JSON.stringify(messages).includes('RUNTIME-FUTURE-SENTINEL'), false); return packet('登记数量已核对。', [{ kind: 'story', text: '本次工程登记已处理。' }]); } });
  return { state, book, engine };
}

test('界面订阅移除后仍跟随正文、保存认识并向对应采集会话呈现反应', async () => {
  const { state, book, engine } = await fixture(), transport = fakeHost(), runtime = new ReadingRuntime(engine, transport.host);
  let renders = 0; const detach = runtime.subscribe(() => renders++); await runtime.startCapture(book.id, 'qidian'); detach(); const before = renders;
  const token = transport.last('startCapture').captureToken;
  await runtime.receive('observation', { captureToken: token, sourceId: 'qidian', text: pages[0], kind: 'body' });
  assert.equal(renders, before); assert.equal(state.memories.length, 1); assert.equal(state.chats.length, 1);
  assert.deepEqual(transport.last('reaction'), { captureToken: token, text: '登记数量已核对。' });
  await runtime.receive('openConversation', { captureToken: token, sourceId: 'qidian' });
  assert.deepEqual(runtime.takeUIEvents(), [{ kind: 'openConversation', bookId: book.id, sessionId: engine.session!.id, generation: engine.session!.generation }]); runtime.dispose();
});

test('错误来源和旧采集标识不会串入当前书，停止指令只引用旧任务标识', async () => {
  const { state, book, engine } = await fixture(), transport = fakeHost(), runtime = new ReadingRuntime(engine, transport.host);
  await runtime.startCapture(book.id, 'qidian'); const old = transport.last('startCapture').captureToken, before = book.position;
  await runtime.receive('observation', { captureToken: old, sourceId: 'other', text: pages[0] }); assert.equal(book.position, before);
  await runtime.receive('openConversation', { captureToken: old, sourceId: 'qidian' }); // Queued while the UI is detached.
  const other = await importBook('另一工程书', '第一章 另一登记\n另一批设备为9件。'); other.known = [{ start: 0, end: other.text.length }]; other.prepared = [...other.known]; other.position = other.text.length; state.books.push(other);
  await runtime.startCapture(other.id, 'qidian'); const current = transport.last('startCapture').captureToken; assert.notEqual(old, current);
  assert.ok(transport.calls.some(c => c.method === 'stopCapture' && c.payload.captureToken === old));
  await runtime.receive('stop', { captureToken: old, sourceId: 'qidian' }); await runtime.receive('openConversation', { captureToken: old, sourceId: 'qidian' });
  await runtime.receive('observation', { captureToken: old, sourceId: 'qidian', text: pages[0] });
  assert.equal(engine.session?.active, true); assert.equal(engine.session?.bookId, other.id); assert.equal(state.chats.length, 0); assert.equal(runtime.takeUIEvents().length, 0); runtime.dispose();
});

test('等待采集授权时结束共读，迟到的成功回调不会重新启动跟随', { timeout: 4000 }, async () => {
  const { book, engine } = await fixture(), entered = deferred(), release = deferred();
  const transport = fakeHost(async method => { if (method === 'startCapture') { entered.resolve(); await release.promise; } });
  const runtime = new ReadingRuntime(engine, transport.host), starting = runtime.startCapture(book.id, 'qidian'); const failure = starting.catch(e => e);
  await entered.promise; const token = transport.last('startCapture').captureToken; engine.stop(); release.resolve();
  assert.equal((await failure).name, 'AbortError'); assert.equal(engine.session?.observing, false); assert.equal(runtime.captureStarting, false);
  assert.deepEqual(transport.last('stopCapture'), { captureToken: token }); runtime.dispose();
});

test('开始阶段等待保存时暂停，不能在保存返回后擅自开启采集', { timeout: 4000 }, async () => {
  const entered = deferred(), release = deferred(); let held = false;
  const { book, engine } = await fixture(undefined, { async load() { return undefined; }, async save(s) { if (!held && s.resume) { held = true; entered.resolve(); await release.promise; } } });
  const transport = fakeHost(), runtime = new ReadingRuntime(engine, transport.host), starting = runtime.startCapture(book.id, 'qidian'); const failure = starting.catch(e => e);
  await entered.promise; engine.pause(); release.resolve(); assert.equal((await failure).name, 'AbortError');
  assert.equal(transport.calls.some(c => c.method === 'startCapture'), false); runtime.dispose();
});

test('语音结果不依赖界面订阅，表达仍按录音时的位置及原话题处理', async () => {
  const { state, book, engine } = await fixture({ async complete(s, messages) {
    assert.equal(JSON.stringify(messages).includes('RUNTIME-FUTURE-SENTINEL'), false);
    return packet('已按表达时的位置核对。');
  } });
  const transport = fakeHost(), runtime = new ReadingRuntime(engine, transport.host); await runtime.startCapture(book.id, 'qidian');
  const captureToken = transport.last('startCapture').captureToken;
  await runtime.receive('observation', { captureToken, sourceId: 'qidian', text: pages[0] }); const position = book.position, topic = await engine.newDiscussion(book.id);
  await runtime.startOrSendVoice(book.id, topic); const token = transport.last('startVoice').token;
  await runtime.receive('observation', { captureToken, sourceId: 'qidian', text: pages[1] }); assert.ok(book.position > position);
  await runtime.receive('voiceDraft', { token, text: '核对刚才的设备位置。' }); assert.equal(runtime.voiceDraft, '核对刚才的设备位置。'); assert.equal(runtime.recording, false);
  await runtime.startOrSendVoice(book.id, topic); assert.deepEqual(transport.last('stopVoice'), { token });
  await runtime.receive('voice', { token, text: '核对刚才的设备位置。' });
  const message = state.chats.find(c => c.input === 'voice')!; assert.equal(message.sessionId, topic); assert.equal(message.evidence[0].end, position); assert.equal(message.delivery, 'answered'); assert.equal(runtime.voiceActive, false); runtime.dispose();
});

test('取消语音或空转写后可以重新录音，旧回调不会覆盖新录音', async () => {
  const { state, book, engine } = await fixture(), transport = fakeHost(), runtime = new ReadingRuntime(engine, transport.host); await engine.start(book.id);
  await runtime.startOrSendVoice(book.id); const first = transport.last('startVoice').token; await runtime.cancelVoice();
  assert.deepEqual(transport.last('cancelVoice'), { token: first }); await runtime.startOrSendVoice(book.id); const second = transport.last('startVoice').token;
  await runtime.receive('voice', { token: first, text: '旧转写' }); assert.equal(runtime.recording, true); assert.equal(state.chats.length, 0);
  await runtime.receive('voiceDraft', { token: second, text: '' }); assert.equal(runtime.voiceActive, false);
  await runtime.startOrSendVoice(book.id); assert.notEqual(transport.last('startVoice').token, second); assert.equal(runtime.recording, true); runtime.dispose();
});

test('离开来源和安静指令在界面之外生效，无原生能力时不虚构采集', async () => {
  const { book, engine } = await fixture(), transport = fakeHost(), runtime = new ReadingRuntime(engine, transport.host); await runtime.startCapture(book.id, 'qidian'); const captureToken = transport.last('startCapture').captureToken;
  await runtime.receive('quiet', { captureToken, sourceId: 'qidian' }); assert.equal(engine.session?.quiet, true);
  await runtime.receive('source', { captureToken, sourceId: 'qidian', active: false }); assert.match(engine.status, /离开阅读页/);
  await runtime.receive('captureStopped', { captureToken, sourceId: 'qidian' }); assert.equal(engine.session?.observing, false); assert.equal(engine.session?.active, true);
  await assert.rejects(runtime.receive('observation', null), /事件格式/); runtime.dispose();
  const other = await fixture(), browser = new ReadingRuntime(other.engine, { available: false, async request<T>() { throw new Error('must not call'); } });
  await assert.rejects(browser.startCapture(other.book.id, 'qidian'), /原生客户端/); assert.equal(other.engine.session, undefined); browser.dispose();
});
