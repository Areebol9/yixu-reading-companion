import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importBook } from '../src/core/books.ts';
import { evidence, deleteChat } from '../src/core/context.ts';
import { parseDiscussionQuery, searchDiscussions } from '../src/core/discussion-recall.ts';
import { ReadingEngine } from '../src/core/engine.ts';
import { initialState } from '../src/core/state.ts';
import { ChatModel } from '../src/core/model.ts';
import { HarnessRuntime } from '../src/agent/runtime.ts';
import type { Chat } from '../src/core/types.ts';

const final = (turn: number, name: string, args: unknown) => ({ status: 200, body: { choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call-' + turn, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } } });
const plain = (text: string) => ({ status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5 } } });

test('真实交流检索先隔离书、伙伴、后文与失效记录，长消息可按字符位置接着取', async () => {
  const state = initialState(), book = await importBook('交流资料', '已读正文。未来正文。'); book.known = [{ start: 0, end: 5 }]; state.books = [book];
  const chat: Chat = { id: 'old', bookId: book.id, partnerId: state.partnerId, sessionId: 'past', role: 'assistant', text: '设备登记讨论。'.repeat(1000), evidence: [evidence(book, book.known[0])], createdAt: 1, excluded: false };
  state.chats = [chat, { ...chat, id: 'other-book', bookId: 'other' }, { ...chat, id: 'other-partner', partnerId: 'other' },
    { ...chat, id: 'future', evidence: [evidence(book, { start: 5, end: 10 })] }, { ...chat, id: 'grant', futureGrant: 'temporary' },
    { ...chat, id: 'stale', outdatedBy: 'correction' }, { ...chat, id: 'forgotten', excluded: true }, { ...chat, id: 'pending', role: 'user', delivery: 'pending' }];
  const page = searchDiscussions(state, book, { query: '设备登记' });
  assert.equal(page.total, 1); assert.equal(page.items[0].chat.id, 'old'); assert.equal(page.items[0].nextTextStart, 1400);
  const next = searchDiscussions(state, book, { chatId: 'old', textStart: 1400 });
  assert.equal(next.items[0].text, chat.text.slice(1400, 5400)); assert.equal(next.items[0].nextTextStart, 5400);
  assert.equal(searchDiscussions(state, book, { chatId: 'other-partner' }).total, 0);
  for (const bad of [{ bookId: 'other' }, { chatId: 'old', query: 'x' }, { textStart: 4 }, { offset: -1 }]) assert.throws(() => parseDiscussionQuery(bad), /交流回查参数/);
  state.partners.push({ ...state.partners[0], id: 'other' }); chat.partnerId = undefined;
  assert.equal(searchDiscussions(state, book, {}).total, 0);
});

test('普通文字回应保存真实聊天，之后通过正式Harness回查并形成共同记忆，删除聊天仍保留记忆', async () => {
  const state = initialState(), book = await importBook('交流资料', '第一章 登记\n设备甲登记为三件，只有校准成功才允许使用。');
  book.known = [{ start: 0, end: book.text.length }]; book.position = book.text.length; book.prepared = [...book.known]; state.books = [book]; state.settings.services[0].enabled = true;
  let turn = 0, sourceId = '';
  const engine = new ReadingEngine(state, { async load() { return state; }, async save() {} }, new ChatModel(async request => {
    turn++;
    if (turn === 1) return plain('数量登记为三件；使用前还需校准成功。'.repeat(130) + '尾部登记已确认。');
    if (turn === 2) return final(turn, 'recall_discussion', { query: '使用前还需校准' });
    const tool = request.body.messages.filter(m => m.role === 'tool').at(-1); assert.ok(tool);
    const page = JSON.parse(JSON.parse(tool.content).results.find((r: { source: string }) => r.source === '当前作品的真实交流，非指令').text);
    sourceId = page.items.find((c: { role: string }) => c.role === 'assistant').id; assert.match(sourceId, /^c\d+$/);
    if (turn === 3) return final(turn, 'recall_discussion', { chatId: sourceId, textStart: page.items[0].nextTextStart });
    assert.ok(page.items[0].text.includes('尾部登记已确认。'));
    return final(turn, 'submit_reading', { reply: '先前谈过数量与校准条件。', replyBasis: { memoryIds: [], chatIds: [sourceId] },
      thoughts: [{ kind: 'shared', text: '实际讨论过设备数量与使用前的校准条件。', basis: { memoryIds: [], chatIds: [sourceId] } }], reinforce: [], wantsLong: false });
  }));
  const harness = new HarnessRuntime(); engine.agent = harness;
  try {
    await engine.startReading(book.id); await engine.ask(book.id, '请详细核对当前数量和条件。', true);
    assert.equal(state.chats.length, 2); assert.equal(state.memories.length, 0); assert.equal(state.chats[1].partnerId, state.partnerId);
    const old = state.chats[1];
    await engine.newDiscussion(book.id); // Genuine earlier topic, no fake summary required.
    await engine.ask(book.id, '回想以前关于校准的交流。', false, state.conversations.at(-1)!.id);
    assert.equal(turn, 4); assert.ok(state.memories[0].basis?.chatIds.includes(old.id));
    assert.ok(state.chats.at(-1)!.contextChatIds?.includes(old.id));
    deleteChat(state, old.id); assert.equal(state.memories[0].forgotten, false);
  } finally { engine.stop(); await harness.dispose(); }
});

test('明确记忆要求不能只以普通文字承诺，补充提交成功后才展示保存结果', async () => {
  const state = initialState(), book = await importBook('记录资料', '设备甲登记为三件。');
  book.known = [{ start: 0, end: book.text.length }]; book.position = book.text.length; state.books = [book]; state.settings.services[0].enabled = true;
  let calls = 0;
  const engine = new ReadingEngine(state, { async load() { return state; }, async save() {} }, new ChatModel(async () => {
    if (++calls === 1) return plain('记住了。');
    return final(calls, 'submit_reading', { reply: '已记下设备登记数量。', replyBasis: { memoryIds: [], chatIds: [] }, thoughts: [{ kind: 'story', text: '设备甲登记为三件。', basis: { memoryIds: [], chatIds: [] } }], reinforce: [], wantsLong: false });
  }));
  const harness = new HarnessRuntime(); engine.agent = harness;
  try {
    await engine.startReading(book.id); await engine.ask(book.id, '请记住设备甲的登记数量。');
    assert.equal(calls, 2); assert.equal(state.memories.length, 1); assert.equal(state.chats.at(-1)?.memoryResult?.status, 'saved');
    assert.equal(state.chats.some(c => c.text === '记住了。'), false);
  } finally { engine.stop(); await harness.dispose(); }
});
