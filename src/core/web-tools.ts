import { exaFetchedPage, exaSearchPages } from './mcp-search.ts';
import { filterWebPages, formatWebPages, validateSearch } from './web.ts';
import { pageText } from './page-text.ts';
import type { WebPage } from './web.ts';
import type { ReadingEngine } from './engine.ts';
import type { NativeRequest } from '../native/channel.ts';

export function attachWebTools(engine: ReadingEngine, request: NativeRequest) {
  engine.search = async (query, signal) => {
    const book = engine.session && engine.book(engine.session.bookId);
    if (!book || !engine.state.settings.searchEnabled) return { text: '联网当前未开启', sources: [] };
    let permitted: string;
    try { permitted = validateSearch(query, book.title); }
    catch (error) { return { text: '本次查询未执行：' + (error as Error).message, sources: [] }; }
    try {
      const settings = engine.state.settings;
      const response = await request<WebPage[] | { format: 'exa'; content: string }>('search', { query: permitted, provider: settings.searchProvider, endpoint: settings.searchEndpoint }, signal);
      const usable = filterWebPages(Array.isArray(response) ? response : exaSearchPages(response.content), book.title);
      return { text: formatWebPages(usable), sources: usable.map(p => ({ title: p.title, url: p.url })) };
    } catch (e) { signal.throwIfAborted(); engine.pauseWeb((e as Error).message); return { text: '本次联网未取得可用资料：' + (e as Error).message, sources: [] }; }
  };
  engine.readPage = async (url, signal) => {
    if (!engine.state.settings.searchEnabled) return '联网当前未开启';
    const book = engine.book(engine.session!.bookId);
    try {
      const result = await request<{ url: string; html?: string; format?: 'exa'; content?: string }>('readPage', { url }, signal);
      const page = result.format === 'exa' ? exaFetchedPage(result.content!, result.url) : pageText(result.url, result.html!);
      const usable = filterWebPages([page], book.title, 10000);
      if (!usable.length || !usable[0].extract.trim()) throw new Error('网页没有返回符合当前范围的可用正文');
      return formatWebPages(usable);
    } catch (e) { signal.throwIfAborted(); engine.pauseWeb((e as Error).message); return '本次网页未取得可用正文：' + (e as Error).message; }
  };
}
