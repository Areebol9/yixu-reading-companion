import type { Book, Chapter, Range } from './types.ts';
import { hashText } from './text-hash.ts';

export function id(): string { return crypto.randomUUID(); }
export function bookLength(book: Pick<Book, 'text' | 'textLength'>): number { return book.textLength ?? book.text.length; }
export function hasBookText(book: Book): boolean { return book.text.length > 0 && book.text.length === bookLength(book); }
export function requireBookText(book: Book): void { if (!hasBookText(book)&&!book.residentRanges?.length) throw new Error('原文尚未载入或长度校验不一致'); }
/** Read exactly resident absolute coordinates. A gap is never represented by
 * padding or an invented empty passage. */
export function bookTextSlice(book:Book,start:number,end=bookLength(book)):string{
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>bookLength(book))throw Error('原文范围无效');
  if(hasBookText(book))return book.text.slice(start,end);
  let at=start,text='';
  for(const piece of [...book.residentRanges??[]].sort((a,b)=>a.start-b.start)){if(piece.end<=at)continue;if(piece.start>at)break;const next=Math.min(end,piece.end);text+=piece.text.slice(at-piece.start,next-piece.start);at=next;if(at===end)return text;}
  if(start===end)return'';throw Error('原文范围尚未载入，不能跨未取得的正文空隙读取');
}
export function readingStart(book: Pick<Book, 'frontMatterEnd' | 'frontMatterIncluded'>): number { return book.frontMatterIncluded ? 0 : book.frontMatterEnd ?? 0; }
export function frontMatterEnd(text: string, chapters: readonly Chapter[]): number {
  if (chapters[0]?.title !== '卷首') return 0;
  const first = chapters.find(c => c.start > 0)?.start ?? 0;
  if (!first) return 0;
  const prefix = text.slice(0, first);
  const synopsis = /^[\t \u3000]*(?:内容|作品|书籍|本书)简介[：:\t \u3000]*$/m.exec(prefix);
  if (!synopsis) return 0;
  // Explicit prologues remain part of the narrative even if the chapter parser did not index them.
  const prologue = /^[\t \u3000]*(?:序章|楔子|引子|正文)(?:[：: \t\u3000][^\n]{0,70})?$/m.exec(prefix);
  if (prologue && prologue.index < synopsis.index) return 0;
  return prologue?.index ?? first;
}
export function applyFrontMatterBoundary(book: Book): boolean {
  const start = readingStart(book);
  if (!start || !book.known.some(r => r.start < start)) return false;
  book.known = mergeRanges(book.known.map(r => ({ start: Math.max(start, r.start), end: r.end })));
  // Earlier preparation may have used the synopsis anywhere in its accumulated context.
  book.prepared = [];
  book.buffered = [];
  if(book.fullOriginalPending)book.fullOriginalPending=mergeRanges(book.fullOriginalPending.map(r=>({start:Math.max(start,r.start),end:r.end})));
  if (book.position <= start) book.position = 0;
  return true;
}
export function normalize(text: string): string {
  return text.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}
export async function importBook(title: string, raw: string): Promise<Book> {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!text.trim()) throw new Error('文件中没有可读文字');
  if (text.length > 30_000_000) throw new Error('当前原型单本支持约三千万字符，请分卷导入');
  const version = await hashText(text);
  const starts: { start: number; title: string }[] = [];
  const re = /^(?:[ \t]*)(第[零〇一二三四五六七八九十百千万两\d]+[章回节卷部集][^\n]{0,70}|chapter\s+\d+[^\n]{0,70})$/gim;
  for (const m of text.matchAll(re)) starts.push({ start: m.index!, title: m[1].trim() });
  if (!starts.length || starts[0].start > 0) starts.unshift({ start: 0, title: starts.length ? '卷首' : '正文' });
  const chapters: Chapter[] = starts.map((s, i) => {const end=starts[i+1]?.start??text.length,part=text.slice(s.start,end),lineEnd=part.indexOf('\n'),header=lineEnd>=0&&part.slice(0,lineEnd).trim()===s.title?lineEnd+1:0;return{...s,index:i,end,contentStart:s.start+header+(part.slice(header).match(/^\s*/u)?.[0].length??0),contentEnd:end-part.match(/\s*$/u)![0].length};});
  return { id: id(), title: title.replace(/\.txt$/i, ''), version, text, textLength: text.length, chapters, frontMatterEnd: frontMatterEnd(text, chapters), known: [], position: 0, prepared: [], archived: false, createdAt: Date.now() };
}
export function decodeBook(bytes: ArrayBuffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('gb18030', { fatal: true }).decode(bytes); }
}
export function mergeRanges(ranges: readonly Range[]): Range[] {
  const result: Range[] = [];
  for (const r of ranges.slice().sort((a, b) => a.start - b.start)) {
    if (!Number.isSafeInteger(r.start) || !Number.isSafeInteger(r.end) || r.start < 0 || r.end <= r.start) continue;
    const last = result.at(-1);
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else result.push({ ...r });
  }
  return result;
}
export function covers(ranges: readonly Range[], span: Range): boolean {
  return Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end) && span.start >= 0 && span.end > span.start &&
    mergeRanges(ranges).some(r => r.start <= span.start && r.end >= span.end);
}
export function subtractRanges(allowed: Range[], done: Range[]): Range[] {
  let result = mergeRanges(allowed);
  for (const d of mergeRanges(done)) result = result.flatMap(r => {
    if (d.end <= r.start || d.start >= r.end) return [r];
    return [r.start < d.start ? { start: r.start, end: d.start } : undefined, d.end < r.end ? { start: d.end, end: r.end } : undefined].filter((x): x is Range => !!x);
  });
  return result;
}
export function chunks(ranges: Range[], size = 6000): Range[] {
  return ranges.flatMap(r => { const out: Range[] = []; for (let start = r.start; start < r.end; start += size) out.push({ start, end: Math.min(start + size, r.end) }); return out; });
}
/** Pack small ranges together without reading or authorizing the gaps between them. */
export function rangeBatches(ranges: Range[], size = 6000, maxRanges = 16): Range[][] {
  if (!Number.isSafeInteger(size) || size < 1 || !Number.isSafeInteger(maxRanges) || maxRanges < 1) throw new Error('阅读批次大小无效');
  const batches: Range[][] = []; let current: Range[] = [], remaining = size;
  for (const range of mergeRanges(ranges)) for (let start = range.start; start < range.end;) {
    if (!remaining || current.length >= maxRanges) { batches.push(current); current = []; remaining = size; }
    const end = Math.min(range.end, start + remaining); current.push({ start, end }); remaining -= end - start; start = end;
  }
  if (current.length) batches.push(current);
  return batches;
}
export function chapterAt(book: { readonly chapters: readonly Chapter[] }, offset: number): Chapter {
  return book.chapters.find(c => c.start <= offset && c.end > offset) ?? book.chapters.at(-1)!;
}
type TextIndex = { version: string; text: string; blocks: { normalizedStart: number; originalStart: number; originalEnd: number }[] };
let activeIndex: TextIndex | undefined;
export function releaseTextIndex(version: string): void { if (activeIndex?.version === version) activeIndex = undefined; }
function textIndex(book: Book): TextIndex {
  if (activeIndex?.version === book.version) return activeIndex;
  const parts: string[] = [], blocks: TextIndex['blocks'] = [];
  let count = 0;
  for (let start = 0; start < book.text.length; start += 4096) {
    const end = Math.min(book.text.length, start + 4096), part = normalize(book.text.slice(start, end));
    blocks.push({ normalizedStart: count, originalStart: start, originalEnd: end }); parts.push(part); count += part.length;
  }
  activeIndex = { version: book.version, text: parts.join(''), blocks }; return activeIndex;
}
function originalOffset(book: Book, index: TextIndex, offset: number, end: boolean): number {
  let lo = 0, hi = index.blocks.length - 1;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (index.blocks[mid].normalizedStart <= offset) lo = mid; else hi = mid - 1; }
  const block = index.blocks[lo]; let count = block.normalizedStart;
  for (let pos = block.originalStart; pos < block.originalEnd; pos++) {
    const size = normalize(book.text[pos]).length;
    if (size && count + size > offset) return pos + (end ? 1 : 0);
    count += size;
  }
  return block.originalEnd;
}
// Only one normalized book and sparse coordinates are cached; avoid a per-character JS array on mobile.
// Coordinates stay in original text; normalization is used only to locate evidence.
export function locateObservation(book: Book, observed: string, coverage: 'fragments' | 'continuous-page' = 'fragments'): { status: 'matched'; range: Range; ranges: Range[]; score: number } | { status: 'ambiguous' | 'missing' } {
  requireBookText(book);
  const query = normalize(observed);
  if (query.length < 10) return { status: 'missing' };
  const index = textIndex(book), haystack = index.text;
  const candidates: { start: number; end: number; score: number }[] = [];
  let at = haystack.indexOf(query);
  while (at >= 0 && candidates.length < 8) { candidates.push({ start: at, end: at + query.length, score: 1 }); at = haystack.indexOf(query, at + 1); }
  if (!candidates.length) {
    // OCR fallback requires two long anchors in consistent order; never infer an unobserved tail.
    const n = Math.min(24, Math.floor(query.length / 3));
    if (n < 12) return { status: 'missing' };
    const head = query.slice(0, n), tail = query.slice(-n);
    for (let a = haystack.indexOf(head); a >= 0 && candidates.length < 8; a = haystack.indexOf(head, a + 1)) {
      const b = haystack.indexOf(tail, a + n);
      if (b < 0 || Math.abs(b + n - a - query.length) > Math.max(8, query.length * .1)) continue;
      const segment = haystack.slice(a, b + n);
      const pairs = new Set(Array.from({ length: Math.max(0, query.length - 1) }, (_, i) => query.slice(i, i + 2)));
      const actual = new Set(Array.from({ length: Math.max(0, segment.length - 1) }, (_, i) => segment.slice(i, i + 2)));
      const score = [...pairs].filter(p => actual.has(p)).length / Math.max(pairs.size, actual.size);
      if (score >= .87) candidates.push({ start: a, end: b + n, score });
    }
  }
  if (!candidates.length && query.length >= 24) {
    // Some OCR engines mix simplified/traditional glyphs or insert a character at line ends.
    // Find several internal exact anchors, align only the interval they actually bound,
    // and leave any uncertain leading/trailing text un-authorized.
    const anchors: { q: number; h: number }[] = [], width = 10;
    const stride = Math.max(3, Math.ceil(query.length / 48));
    const positions = new Set<number>();
    for (let q = 0; q <= query.length - width; q += stride) positions.add(q);
    // A stride can step over the only exact anchor after a late OCR error.
    // This remains an observed exact suffix, never an inferred/unseen extension.
    positions.add(query.length - width);
    for (const q of positions) {
      const token = query.slice(q, q + width), hits: number[] = [];
      for (let h = haystack.indexOf(token); h >= 0 && hits.length < 5; h = haystack.indexOf(token, h + 1)) hits.push(h);
      if (hits.length < 5) hits.forEach(h => anchors.push({ q, h }));
    }
    const groups: { offset: number; anchors: typeof anchors }[] = [];
    for (const anchor of anchors) {
      const offset = anchor.h - anchor.q;
      let group = groups.find(g => Math.abs(g.offset - offset) <= Math.max(4, query.length * .04));
      if (!group) { group = { offset, anchors: [] }; groups.push(group); }
      group.anchors.push(anchor);
    }
    for (const group of groups.slice(0, 24)) {
      const ordered = group.anchors.sort((a, b) => a.q - b.q), first = ordered[0], last = ordered.at(-1)!;
      if (last.q - first.q < 14 || last.h <= first.h) continue;
      const expected = query.slice(first.q, last.q + width), actual = haystack.slice(first.h, last.h + width);
      if (expected.length < query.length * .5 || Math.abs(expected.length - actual.length) > expected.length * .08) continue;
      const score = editSimilarity(expected, actual);
      if (score >= .92) candidates.push({ start: first.h, end: last.h + width, score });
    }
  }
  if (!candidates.length) return { status: 'missing' };
  if (candidates.length !== 1) return { status: 'ambiguous' };
  const c = candidates[0];
  const range = { start: originalOffset(book, index, c.start, false), end: originalOffset(book, index, c.end - 1, true) };
  if (normalize(book.text.slice(range.start, range.end)) !== haystack.slice(c.start, c.end)) return { status: 'missing' };
  const tail = query.length >= 80 && observed.includes('\n') ? observedTail(haystack, c.end, normalize(observed.trim().split(/\r?\n/).at(-1)!)) : undefined;
  const ranges = [range];
  if (tail) {
    const extra = { start: originalOffset(book, index, tail.start, false), end: originalOffset(book, index, tail.end - 1, true) };
    if (normalize(book.text.slice(extra.start, extra.end)) === haystack.slice(tail.start, tail.end)) ranges.push(extra);
  }
  // Normalized matching strips both edges. Restore only literally observed,
  // exactly matching punctuation/space; a leading comma on the next page must
  // not leave a false gap that strands the previous page's unfinished sentence.
  const prefix=observed.match(/^[\s\p{P}\p{S}]+/u)?.[0];
  if(prefix&&range.start>=prefix.length&&normalize(book.text.slice(range.start,range.start+40)).startsWith(query.slice(0,10))&&
    book.text.slice(range.start-prefix.length,range.start)===prefix)range.start-=prefix.length;
  const last = ranges.at(-1)!;
  const suffix = observed.match(/[\s\p{P}\p{S}]+$/u)?.[0];
  if (suffix && normalize(book.text.slice(Math.max(last.start, last.end - 40), last.end)).endsWith(query.slice(-10)) &&
    book.text.slice(last.end, last.end + suffix.length) === suffix) last.end += suffix.length;
  // A trusted host may confirm one cropped, single-column reading frame. In that
  // case its uniquely aligned endpoints bound an allowed interval, including OCR
  // omissions inside it. This never joins observations or infers an unseen edge.
  const allowed = coverage === 'continuous-page' ? [{ start: range.start, end: Math.max(...ranges.map(r => r.end)) }] : mergeRanges(ranges);
  return { status: 'matched', range, ranges: allowed, score: tail ? Math.min(c.score, tail.score) : c.score };
}

/** Recover only a visible OCR line next to an already unique page match. The
 * caller may fill the intervening gap only for a trusted continuous frame. */
function observedTail(haystack: string, boundary: number, line: string): { start: number; end: number; score: number } | undefined {
  if (line.length < 14 || line.length > 80) return;
  const limit = Math.min(3, Math.floor(line.length * .2));
  const lo = Math.max(0, boundary - line.length - limit), hi = Math.min(haystack.length, boundary + line.length + 32);
  const anchors = Array.from({ length: line.length - 6 }, (_, i) => line.slice(i, i + 7));
  let best = limit + 1; const matches: { start: number; end: number; score: number }[] = [];
  for (let start = lo; start < hi; start++) for (let size = line.length - limit; size <= line.length + limit; size++) {
    const end = start + size;
    if (end > hi) continue;
    const text = haystack.slice(start, end);
    if (!anchors.some(anchor => text.includes(anchor))) continue;
    const score = editSimilarity(line, text, limit), distance = Math.round((1 - score) * Math.max(line.length, size));
    if (distance > limit || distance > best) continue;
    if (distance < best) { best = distance; matches.length = 0; }
    matches.push({ start, end, score });
  }
  if (!matches.length) return;
  // Intersect equally plausible alignments; never authorize an uncertain last
  // character or jump to another occurrence of a repeated line.
  const start = Math.max(...matches.map(m => m.start)), end = Math.min(...matches.map(m => m.end));
  if (end <= boundary || end - start < Math.max(7, line.length * .6)) return;
  return { start, end, score: Math.min(...matches.map(m => m.score)) };
}

function editSimilarity(a: string, b: string, limit = Math.ceil(Math.max(a.length, b.length) * .08)): number {
  const infinity = a.length + b.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = new Array<number>(b.length + 1).fill(infinity); current[0] = i;
    let best = infinity;
    for (let j = Math.max(1, i - limit); j <= Math.min(b.length, i + limit); j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, current[j]);
    }
    if (best > limit) return 0;
    previous = current;
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

/** The last printable character boundary is navigation metadata, not a grant. */
export function chapterContentStart(book:Book,chapter:Chapter):number{
  if(chapter.contentStart!==undefined)return chapter.contentStart;
  try{const prefix=bookTextSlice(book,chapter.start,Math.min(chapter.end,chapter.start+1024)),lineEnd=prefix.indexOf('\n'),header=lineEnd>=0&&prefix.slice(0,lineEnd).trim()===chapter.title?lineEnd+1:0;return chapter.start+header+(prefix.slice(header).match(/^\s*/u)?.[0].length??0);}catch{return /^(?:第.+[章回节卷部集]|chapter\s+\d)/iu.test(chapter.title)?Math.min(chapter.end,chapter.start+chapter.title.length+1):chapter.start;}
}
export function chapterContentEnd(book:Book,chapter:Chapter):number{
  if(chapter.contentEnd!==undefined)return chapter.contentEnd;
  // Existing books may not yet carry the metadata; inspect only a resident tail
  // locally. None of that planning text is added to known or supplied to models.
  try{const start=Math.max(chapter.start,chapter.end-1024),tail=bookTextSlice(book,start,chapter.end);return Math.max(chapter.start,chapter.end-tail.match(/\s*$/u)![0].length);}catch{return chapter.end;}
}
