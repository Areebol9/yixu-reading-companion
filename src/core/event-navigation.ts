import { evidence, readText, searchOriginalHistory } from './context.ts';
import { parseOriginalHistoryQuery } from './types.ts';
import type { Book, Evidence, OriginalHistoryQuery, Range } from './types.ts';

export type OriginalHistoryBatch = {
  groups: ({ requestIndex: number; request: OriginalHistoryQuery } & ReturnType<typeof searchOriginalHistory>)[];
  notice: string;
};

/** Each query keeps its own scope, order and continuation. Hits are original
 * locations, so grouping does not assert that they describe the same event. */
export function searchOriginalHistoryBatch(book: Book, requests: OriginalHistoryQuery[], extra: Range[] = []): OriginalHistoryBatch {
  if (!Array.isArray(requests) || requests.length < 1 || requests.length > 3) throw Error('历史原文批量查询须包含 1 至 3 项');
  const parsed = requests.map(parseOriginalHistoryQuery);
  const groups = parsed.map((request, requestIndex) => ({ requestIndex, request, ...searchOriginalHistory(book, request, extra) }));
  return { groups, notice: '各组仅为本次许可内的原文定位；按原请求分别续页。不同组命中不自动构成同一事件或事件含义，未命中不证明事件不存在。' };
}

export type OriginalReadBatch = {
  items: { requestIndex: number; range: Range; text: string; evidence: Evidence }[];
  totalChars: number;
  notice: string;
};

/** Read independent exact spans. A span crossing an unread gap is rejected;
 * callers must name the permitted spans separately rather than join the gap. */
export function readOriginalBatch(book: Book, ranges: Range[], extra: Range[] = []): OriginalReadBatch {
  if (!Array.isArray(ranges) || ranges.length < 1 || ranges.length > 4) throw Error('批量原文读取须包含 1 至 4 段');
  let totalChars = 0;
  const parsed = ranges.map(range => {
    if (!range || typeof range !== 'object' || Array.isArray(range) || Object.keys(range).some(k => !['start', 'end'].includes(k)) ||
      !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end <= range.start || range.end - range.start > 6000) throw Error('每段原文须使用有效坐标且不超过 6000 字符');
    totalChars += range.end - range.start;
    return { start: range.start, end: range.end };
  });
  if (totalChars > 16000) throw Error('批量原文总长度不得超过 16000 字符');
  const items = parsed.map((range, requestIndex) => ({ requestIndex, range, text: readText(book, range, extra), evidence: evidence(book, range) }));
  return { items, totalChars, notice: '各段保留独立原文坐标和原字句；段间未读取的文字不作连续原文或事件结论。' };
}
