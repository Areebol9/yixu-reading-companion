import { publicWebUrl } from './web.ts';
import type { WebPage } from './web.ts';

/** Read only the response to our fixed search/fetch request; ignore server notifications. */
export function mcpText(raw: string, requestId: number = 1): string {
  if (raw.length > 2_000_000) throw new Error('搜索响应超过读取上限');
  const candidates: unknown[] = [];
  try { candidates.push(JSON.parse(raw)); } catch {
    for (const event of raw.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      try { candidates.push(JSON.parse(data)); } catch { /* incomplete non-response event */ }
    }
  }
  const response = candidates.find((item: any) => item?.id === requestId) as any;
  if (!response || response.error || response.result?.isError) throw new Error('匿名搜索服务暂不可用或已到额度上限，可稍后重试');
  if (!Array.isArray(response.result?.content)) throw new Error('搜索服务返回格式已变化');
  const text = response.result.content.filter((item: any) => item?.type === 'text' && typeof item.text === 'string').map((item: any) => item.text).join('\n');
  if (!text.trim()) throw new Error('搜索服务未返回可读资料');
  return text;
}
export function exaSearchPages(raw: string): WebPage[] {
  const result: WebPage[] = [], text = mcpText(raw).replace(/\r\n?/g, '\n');
  for (const block of text.split(/\n\n---\n\n(?=Title:)/)) {
    const title = /^Title:\s*(.+)$/m.exec(block)?.[1], url = /^URL:\s*(\S+)$/m.exec(block)?.[1];
    if (!title || !url) continue;
    try { publicWebUrl(url); } catch { continue; }
    const start = /^(?:Highlights|Text|Content):\s*\n/m.exec(block);
    const extract = start ? block.slice(start.index + start[0].length) : '';
    result.push({ title: title.slice(0, 240), url, extract: extract.slice(0, 2000) });
  }
  return result.slice(0, 5);
}
export function exaFetchedPage(raw: string, url: string): WebPage {
  publicWebUrl(url);
  const text = mcpText(raw);
  return { title: /^#\s+(.+)$/m.exec(text)?.[1]?.slice(0, 240) ?? new URL(url).hostname, url, extract: text.slice(0, 10000) };
}
