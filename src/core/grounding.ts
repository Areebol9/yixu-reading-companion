import {bookTextSlice} from './books.ts';
import { chapterAt,covers, mergeRanges } from './books.ts';
import { isEvidenceAllowed, memorySources, readableRanges } from './context.ts';
import { recallTerms } from './recall.ts';
import type { Book, Memory, Range, Service } from './types.ts';

/** Internal material selection for controlled comparisons and future selection
 * policy. It changes neither permissions nor the tools available to the Agent. */
export type DiscussionMaterials = Readonly<{original:'all'|'adaptive'|number;memories:'selected'|'stage'|'none'}>;

/** Whole permitted material for the explicit reading strategy; final request admission owns capacity. */
export function fullOriginalRanges(sourceBook:Book,extra:Range[]=[]):Range[]{
  const ranges=readableRanges(sourceBook,extra).map(({start,end})=>({start,end}));
  if(!ranges.length)throw Error('请先确认可读正文范围');
  return ranges;
}

export function discussionOriginal(book:Book,service:Service|undefined,current:Range,selection:DiscussionMaterials,required=true):Range[]|undefined{
  if(!service){if(!required)return;throw new Error('没有可用的模型服务');}
  if(!['selected','stage','none'].includes(selection.memories)||selection.original!=='all'&&selection.original!=='adaptive'&&(!Number.isSafeInteger(selection.original)||selection.original<1))throw new Error('原文窗口配置无效');
  if(selection.original==='adaptive')return completeOriginal(book,service);
  const allowed=readableRanges(book);
  let start=0;
  if(selection.original!=='all'){
    const isLayout=(chapter:Book['chapters'][number])=>covers(allowed,chapter)&&bookTextSlice(book,chapter.start,chapter.end).trim()===chapter.title;
    let count=0,index=chapterAt(book,Math.max(0,current.end-1)).index;
    for(;index>=0;index--){
      const chapter=book.chapters[index];start=chapter.start;
      // Only a fully authorized title-only span is layout. Partial chapters
      // remain chapters; do not inspect unseen body to decide the window.
      const layout=isLayout(chapter);
      if(!layout&&++count>=selection.original)break;
    }
    // A heading immediately introducing the first selected chapter belongs to
    // its navigation context and adds no unseen body or extra chapter.
    for(let before=index-1;before>=0&&isLayout(book.chapters[before]);before--)start=book.chapters[before].start;
  }
  const end=selection.original==='all'?book.text.length:current.end;
  const ranges=allowed.map(r=>({start:Math.max(start,r.start),end:Math.min(end,r.end)})).filter(r=>r.end>r.start);
  const capacity=Math.min(required?Infinity:12000,Math.floor(Math.max(0,service.contextLimit-service.maxOutput-30000)/3));
  if(!ranges.length||ranges.length>16||ranges.reduce((n,r)=>n+r.end-r.start,0)>capacity){if(!required)return;throw new Error('请求的原文窗口无法在本渠道的材料预算内完整提供');}
  return ranges;
}

/** Conservative first threshold, not a claim about optimal model context size.
 * Use only for explicit discussion; continuous reading remains incremental. */
export function completeOriginal(book: Book, service: Service | undefined): Range[] | undefined {
  if (!service) return;
  const ranges = readableRanges(book);
  const limit = Math.min(16000, Math.floor(Math.max(0, service.contextLimit - service.maxOutput - 30000) / 3));
  const size = ranges.reduce((n, r) => n + r.end - r.start, 0);
  return size > 0 && size <= limit && ranges.length <= 16 ? ranges : undefined;
}

/** Shared original passages supplement selected memories. Full memory exposure
 * fences stay intact; only these actually supplied passages enter originalRanges. */
export function supportingReadings(book: Book, memories: Memory[], provided: Range[], query: string, extra: Range[] = [], charBudget = 1600): Range[] {
  const words = recallTerms(query), candidates = new Map<string, { range: Range; score: number }>();
  for (const memory of memories) for (const source of [...memorySources(memory), ...(memory.sourceQuote ? [memory.sourceQuote.evidence] : [])]) {
    if (!isEvidenceAllowed(book, [source], extra) || covers(provided, source)) continue;
    const range = { start: source.start, end: source.end }, size = range.end - range.start;
    if (size > charBudget) continue; // Do not cut a cited passage in half to fit it.
    const content = recallTerms(bookTextSlice(book,range.start, range.end));
    let score = 0; for (const word of words) if (content.has(word)) score++;
    score /= Math.sqrt(Math.max(8, content.size));
    const key = `${range.start}:${range.end}`;
    const previous = candidates.get(key);
    if (!previous || score > previous.score) candidates.set(key, { range, score });
  }
  let chosen: Range[] = [];
  for (const { range } of [...candidates.values()].sort((a, b) => b.score - a.score || b.range.end - a.range.end)) {
    const merged = mergeRanges([...chosen, range]);
    if (merged.length > 8 || merged.reduce((n, r) => n + r.end - r.start, 0) > charBudget) continue;
    chosen = merged;
  }
  return chosen;
}
