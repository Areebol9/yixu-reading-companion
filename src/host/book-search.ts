import {createHash} from 'node:crypto';
import {normalize} from '../core/books.ts';
import type {BookTextQuery, BookTextMatches, Range} from '../core/types.ts';

type Unit = {text: string; start: number; end: number};
const removed = /[\s\p{P}\p{S}]/gu;
const cased = /\p{Cased}/u, ignored = /\p{Case_Ignorable}/u;
/** Same NFKC/remove/lowercase semantics as books.normalize, retaining UTF-16 origins. */
async function* normalizedUnits(read: (start: number, end: number) => Promise<string>, range: Range): AsyncGenerator<Unit> {
  const segmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
  let raw = '', offset = range.start, beforeCased = false;
  let sigma: {start: number; end: number; before: boolean; marks: Unit[]} | undefined;
  for (let cursor = range.start; cursor < range.end;) {
    const end = Math.min(range.end, cursor + 65536); raw += await read(cursor, end); cursor = end;
    const segments = [...segmenter.segment(raw)], complete = cursor === range.end ? segments.length : Math.max(0, segments.length - 1);
    let consumed = 0;
    for (let index = 0; index < complete; index++) {
      const item = segments[index], start = offset + item.index, finish = start + item.segment.length;
      for (const char of item.segment.normalize('NFKC').replace(removed, '')) {
        const unit = {text: char.toLowerCase(), start, end: finish};
        if (sigma) {
          if (ignored.test(char)) { sigma.marks.push(unit); continue; }
          yield {text: sigma.before && !cased.test(char) ? 'ς' : 'σ', start: sigma.start, end: sigma.end};
          yield* sigma.marks; sigma = undefined;
        }
        if (char === 'Σ') sigma = {start, end: finish, before: beforeCased, marks: []}; else yield unit;
        if (!ignored.test(char)) beforeCased = cased.test(char);
      }
      consumed = item.index + item.segment.length;
    }
    raw = raw.slice(consumed); offset += consumed;
  }
  if (sigma) { yield {text: sigma.before ? 'ς' : 'σ', start: sigma.start, end: sigma.end}; yield* sigma.marks; }
}
async function* literalUnits(read: (start: number, end: number) => Promise<string>, range: Range): AsyncGenerator<Unit> {
  for (let cursor = range.start; cursor < range.end;) {
    const end = Math.min(range.end, cursor + 65536), text = await read(cursor, end);
    for (let index = 0; index < text.length; index++) yield {text: text[index], start: cursor + index, end: cursor + index + 1};
    cursor = end;
  }
}
export async function searchStoredBook(version: string, length: number, query: BookTextQuery, read: (start: number, end: number) => Promise<string>): Promise<BookTextMatches> {
  if (!query || typeof query.query !== 'string' || !['literal', 'normalized'].includes(query.mode) || !Number.isSafeInteger(query.limit) || query.limit < 1 || !Array.isArray(query.ranges)) throw Error('原文查询条件无效');
  for (let index = 0; index < query.ranges.length; index++) {
    const range = query.ranges[index];
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end <= range.start || range.end > length || index > 0 && range.start < query.ranges[index - 1].end) throw Error('原文查询范围无效');
  }
  const needle = query.mode === 'normalized' ? normalize(query.query) : query.query;
  if (!needle) throw Error('原文查询不能为空');
  const binding = createHash('sha256').update(JSON.stringify([version, query.query, query.mode, query.ranges])).digest('hex');
  let after = -1;
  if (query.cursor) { const cursor = JSON.parse(query.cursor); if (cursor.binding !== binding || !Number.isSafeInteger(cursor.after) || cursor.after < 0) throw Error('原文续页条件或许可范围已变化'); after = cursor.after; }
  const prefix = new Array<number>(needle.length).fill(0);
  for (let i = 1, j = 0; i < needle.length; i++) { while (j && needle[i] !== needle[j]) j = prefix[j - 1]; if (needle[i] === needle[j]) j++; prefix[i] = j; }
  const results: Range[] = [];
  for (const range of query.ranges) {
    if (range.end <= after) continue;
    let matched = 0, origins: Range[] = [], total = 0, previous = '';
    const units = query.mode === 'normalized' ? normalizedUnits(read, range) : literalUnits(read, range);
    for await (const unit of units) for (let i = 0; i < unit.text.length; i++) {
      const char = unit.text[i]; origins[total++ % needle.length] = {start: unit.start, end: unit.end};
      while (matched && char !== needle[matched]) matched = prefix[matched - 1];
      if (char === needle[matched]) matched++;
      if (matched === needle.length) {
        const hit = {start: origins[(total - needle.length) % needle.length].start, end: unit.end}, key = hit.start + ':' + hit.end; matched = prefix[matched - 1];
        if (hit.start <= after || key === previous) continue; previous = key;
        if (results.length === query.limit) return {version, ranges: results, exhausted: false, nextCursor: JSON.stringify({binding, after: results.at(-1)!.start})};
        results.push(hit);
      }
    }
  }
  return {version, ranges: results, exhausted: true};
}
