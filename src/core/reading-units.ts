import {bookTextSlice} from './books.ts';
import { bookLength, chapterAt, covers, mergeRanges, requireBookText, subtractRanges } from './books.ts';
import type { Book, Range, ReadingStrategy } from './types.ts';
import {originalParagraphBatches,originalParagraphRanges} from './original-paragraphs.ts';

/** Ready to follow new pages; deferred material has NOT been understood. */
export function readyToRead(book: { readonly known: readonly Range[]; readonly prepared: readonly Range[]; readonly buffered?: readonly Range[] }): boolean {
  return book.known.length > 0 && !subtractRanges([...book.known], [...book.prepared, ...(book.buffered ?? [])]).length;
}
/** Permission readiness is distinct from model-processing coverage. */
export function canFollowReading(book:{readonly known:readonly Readonly<Range>[];readonly prepared:readonly Readonly<Range>[];readonly buffered?:readonly Readonly<Range>[]},strategy:ReadingStrategy='structured'):boolean{
  if(strategy==='companion')return true;
  if(strategy==='structured')return readyToRead(book);
  return strategy==='full-original'&&book.known.length>0&&book.known.every(r=>Number.isSafeInteger(r.start)&&Number.isSafeInteger(r.end)&&r.start>=0&&r.end>r.start);
}

// These are scheduling boundaries, not a claim that a sentence is semantically complete.
// Scan bounded, already permitted windows, rather than rebuilding an index of the whole novel.
function boundaries(text: string, start: number, end: number): number[] {
  const result: number[] = [];
  const re = /(?:[。！？!?；;]+|\.(?=[\s”’」』）】"'])|\n+)[”’」』）】"']*[\t \u3000\n]*/gu;
  for (const match of text.slice(start, end).matchAll(re)) result.push(start + match.index! + match[0].length);
  return result;
}

export type ReadingPlan = { batches: Range[][]; buffered: Range[]; layout: Range[] };

/** Companion preparation shares original paragraphs with the reading page and maintenance. */
export function planOriginalParagraphReading(book:Book,allowed:Range[],pending:Range[],size=6000):ReadingPlan{
  if(!Number.isSafeInteger(size)||size<1)throw Error('阅读批次大小无效');
  const grants=mergeRanges(allowed),wanted=mergeRanges(pending.flatMap(range=>grants.map(grant=>({start:Math.max(range.start,grant.start),end:Math.min(range.end,grant.end)})))),batches:Range[][]=[],layout:Range[]=[];
  for(const chapter of book.chapters){
    const targets=mergeRanges(wanted.map(range=>({start:Math.max(range.start,chapter.start),end:Math.min(range.end,chapter.end)})));if(!targets.length)continue;
    const paragraphs=originalParagraphRanges(book,{start:chapter.start,end:chapter.end});
    const whitespace=subtractRanges(targets,paragraphs);layout.push(...whitespace);
    if(paragraphs.length===1&&bookTextSlice(book,paragraphs[0].start,paragraphs[0].end).trim()===chapter.title){layout.push(...targets);continue;}
    batches.push(...originalParagraphBatches(book,targets,size,grants));
  }
  return{batches,layout:mergeRanges(layout),buffered:subtractRanges(wanted,[...batches.flat(),...layout])};
}

/** Revisit the permitted sentence around a hole. Stop an unfinished edge at the
 * permission boundary; never borrow unseen text to complete it. Keep chapters
 * separate and bound even unusually long, unpunctuated paragraphs. */
export function planReading(book: Book, allowed: Range[], pending: Range[], size = 6000): ReadingPlan {
  requireBookText(book);
  if (!Number.isSafeInteger(size) || size < 1) throw new Error('阅读批次大小无效');
  const grants = mergeRanges(allowed), wanted = mergeRanges(pending), batches: Range[][] = [], layout: Range[] = [];
  let current: Range[] = [], currentChapter = -1;
  const flush = () => { if (current.length) batches.push(current); current = []; };
  const append = (range: Range, chapter: number) => {
    if (chapter !== currentChapter) { flush(); currentChapter = chapter; }
    if (covers(current, range) || covers(batches.at(-1) ?? [], range)) return;
    const merged = mergeRanges([...current, range]);
    if (merged.reduce((n, r) => n + r.end - r.start, 0) > size || merged.length > 16) flush();
    current = mergeRanges([...current, range]);
  };
  for (const request of wanted) for (const grant of grants) {
    let from = Math.max(request.start, grant.start), until = Math.min(request.end, grant.end);
    while (from < until) {
      const chapter = chapterAt(book, from), stop = Math.min(until, chapter.end);
      const lo = Math.max(grant.start, chapter.start, from - size);
      let cursor = boundaries(book.text, lo, from).at(-1) ?? lo;
      while (cursor < stop) {
        const end = Math.min(cursor + size, grant.end, chapter.end);
        const points = boundaries(book.text, cursor, end);
        // A whole authorized chapter/file has a real end, even without final punctuation.
        if (end === chapter.end || end === bookLength(book)) points.push(end);
        const boundary = points.find(p => p >= stop) ?? points.at(-1);
        let next = boundary ?? (end - cursor === size ? end : cursor);
        if (cursor === chapter.start && bookTextSlice(book,cursor, next).trim() === chapter.title && end - cursor === size) next = end;
        if (next <= cursor) break;
        if (next > from) {
          const material = bookTextSlice(book,cursor, next).trim();
          if (!material || cursor === chapter.start && next === chapter.end && material === chapter.title) layout.push({ start: cursor, end: next });
          else if (material && !(cursor === chapter.start && material === chapter.title)) append({ start: cursor, end: next }, chapter.index);
        }
        cursor = next;
      }
      from = stop;
    }
  }
  flush();
  return { batches, layout: mergeRanges(layout), buffered: subtractRanges(wanted, [...batches.flat(), ...layout]) };
}

/** Do not reintroduce a cropped tail through the automatic context prelude. */
export function completePrelude(book: Book, ranges: Range[]): Range[] {
  return mergeRanges(planReading(book, ranges, ranges).batches.flat());
}

/** Preparation can read an already authorized span in larger, ordered batches.
 * Only single, touching ranges combine; fragments and gaps retain their units.
 * This does not mark anything understood or apply to independent backgrounds. */
export function packPreparation(batches: Range[][], size: number): Range[][] {
  if (!Number.isSafeInteger(size) || size < 6000 || size > 24000) throw new Error('前文准备批次范围无效');
  const packed: Range[][] = [];
  for (const batch of batches) {
    const previous = packed.at(-1);
    if (batch.length === 1 && previous?.length === 1 && previous[0].end === batch[0].start && batch[0].end - previous[0].start <= size) {
      previous[0] = { start: previous[0].start, end: batch[0].end };
    } else packed.push(batch.map(r => ({ ...r })));
  }
  return packed;
}
