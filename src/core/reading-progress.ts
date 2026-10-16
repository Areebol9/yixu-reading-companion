import {mergeRanges,readingStart,subtractRanges} from './books.ts';
import {readableParts,readableRanges} from './context.ts';
import type {Book,Memory,Range} from './types.ts';

/** Compare only actual permission in the requested range; titles/layout do not
 * become obligations merely because the page renders a complete chapter. */
export function readingCoverage(book:{readonly known:readonly Readonly<Range>[];readonly prepared:readonly Readonly<Range>[]},range:Range){
  const allowed=mergeRanges(book.known.flatMap(r=>{const start=Math.max(r.start,range.start),end=Math.min(r.end,range.end);return end>start?[{start,end}]:[];}));
  const allowedChars=allowed.reduce((n,r)=>n+r.end-r.start,0),missingChars=subtractRanges(allowed,book.prepared.map(r=>({...r}))).reduce((n,r)=>n+r.end-r.start,0);
  return{allowedChars,preparedChars:allowedChars-missingChars,missingChars,status:(!allowedChars?'none':missingChars?'partial':'complete') as 'none'|'partial'|'complete'};
}

/** A bounded map of actual reading coverage, not newly supplied story evidence.
 * Disjoint ranges stay disjoint; unseen background progress is never reported. */
export function readingProgress(book:Book,source:Memory['source']='reading',extra:Range[]=[],deferred:Range[]=book.buffered??[]){
  const permitted=readableRanges(book,extra);
  const visible=(ranges:Range[])=>mergeRanges(ranges.flatMap(r=>readableParts(book,r,extra)));
  const describe=(ranges:Range[])=>{
    let through=readingStart(book);
    for(const r of ranges){if(r.start>through)break;through=Math.max(through,r.end);}
    return {ranges:ranges.length<=8?ranges:[...ranges.slice(0,2),...ranges.slice(-6)],rangesComplete:ranges.length<=8,
      rangeCount:ranges.length,continuousFromStartThrough:through>readingStart(book)?through:undefined};
  };
  return {
    availableOriginal:describe(permitted),
    processedOriginal:describe(visible(source==='background'?book.backgroundPrepared??[]:book.prepared)),
    awaitingTextCompletion:describe(visible(deferred)),
  };
}
