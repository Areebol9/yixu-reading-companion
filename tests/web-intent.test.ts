import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webIntent } from '../src/core/web-intent.ts';
import { ReadingEngine } from '../src/core/engine.ts';
import { initialState } from '../src/core/state.ts';
import { importBook } from '../src/core/books.ts';

test('明确搜索并阅读来源的中英文请求包含网页读取，否定请求保持约束', () => {
  for (const value of ['请联网查一下铜为什么变绿，并阅读一个来源', 'Please search the web for why copper turns green and read one original source.']) assert.deepEqual(webIntent(value), { forbidden: false, search: true, page: true });
  assert.equal(webIntent('Please search the web, but do not read any page.').page, false);
  assert.equal(webIntent("Please search the web, but don't open the original source.").page, false);
  assert.equal(webIntent("Don't browse. Explain the current text.").forbidden, true);
  assert.equal(webIntent('不要联网，讨论当前正文').forbidden, true);
  assert.equal(webIntent('角色说要阅读来源').page, false);
  assert.deepEqual(webIntent('本次不要保存新记忆，请联网搜索资料并阅读一个来源。'), { forbidden: false, search: true, page: true });
  assert.equal(webIntent('Do not remember this, please search the web.').search, true);
});
test('搜索结果不能替代明确要求的正文读取，只有实际读取成功的来源带标记', async () => {
  const state = initialState(), book = await importBook('工程记录', '第一章 工程\n设备记录仅用于工程检查。');
  book.position = book.text.length; book.known = [{ start: 0, end: book.position }]; book.prepared = [...book.known]; state.books.push(book);
  state.settings.services[0].enabled = true; state.settings.searchEnabled = true;
  let calls = 0, reads = 0;
  const engine = new ReadingEngine(state, { async load() { return undefined; }, async save() {} }, { async complete(service, messages) {
    calls++;
    if (calls === 2) assert.ok(JSON.stringify(messages).includes('ACTUAL-PAGE-TEXT'));
    return { content: JSON.stringify(calls === 1 ? { search: 'copper patina chemistry', reply: '', thoughts: [], wantsLong: false } : { reply: '资料正文已核对。', thoughts: [], wantsLong: false }), input: 10, output: 10, estimated: false, elapsedMs: 1 };
  } });
  engine.search = async () => ({ text: 'SEARCH-SNIPPET', sources: [{ title: '机构资料', url: 'https://example.org/article' }, { title: '另一来源', url: 'https://example.net/article' }] });
  engine.readPage = async url => { reads++; assert.equal(url, 'https://example.org/article'); return 'ACTUAL-PAGE-TEXT'; };
  await engine.startReading(book.id); await engine.ask(book.id, 'Please search the web and read one original source.');
  assert.equal(reads, 1); assert.equal(calls, 2);
  assert.equal(state.chats.at(-1)?.webSources?.[0].read, true); assert.equal(state.chats.at(-1)?.webSources?.[1].read, undefined); engine.stop();
});
