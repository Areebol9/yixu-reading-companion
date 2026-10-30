import {bookTextSlice,covers,mergeRanges} from './books.ts';
import type {Book,Range} from './types.ts';

export type OriginalParagraph=Range&{text:string};

/** Original line breaks define paragraphs; offsets remain original UTF-16 coordinates. */
export function originalParagraphs(text:string,start=0):OriginalParagraph[]{
  return [...text.matchAll(/[^\r\n]+/gu)].filter(match=>match[0].trim()).map(match=>{
    const body=match[0].trimEnd();return{start:start+match.index!,end:start+match.index!+body.length,text:body};
  });
}

function paragraphUnits(book:Book,targets:Range[]){
  return book.chapters.filter(chapter=>targets.some(range=>range.start<chapter.end&&chapter.start<range.end)).flatMap(chapter=>{
    // Boundary planning may inspect a locally loaded chapter. It never grants it.
    const paragraphs=originalParagraphs(bookTextSlice(book,chapter.start,chapter.end),chapter.start);
    return paragraphs.map((paragraph,index)=>({...paragraph,paddingStart:paragraphs[index-1]?.end??chapter.start,paddingEnd:paragraphs[index+1]?.start??chapter.end}));
  });
}

/** Complete original paragraphs intersecting bounds; the original chapter must be loaded. */
export function originalParagraphRanges(book:Book,bounds:Range):Range[]{
  return paragraphUnits(book,[bounds]).filter(paragraph=>paragraph.start<bounds.end&&bounds.start<paragraph.end).map(({start,end})=>({start,end}));
}

function permittedParagraphUnits(book:Book,targets:Range[],allowed:Range[]){
  const wanted=mergeRanges(targets),grants=mergeRanges(allowed);
  return paragraphUnits(book,wanted).flatMap(paragraph=>{
    if(!wanted.some(range=>range.start<paragraph.end&&paragraph.start<range.end))return[];
    const grant=grants.find(range=>covers([range],paragraph));if(!grant)return[];
    // Include only granted separators, so completed batches do not strand newlines.
    return[{start:Math.max(grant.start,paragraph.paddingStart),end:Math.min(grant.end,paragraph.paddingEnd)}];
  });
}

/** Expand targets only to complete paragraphs already covered by permission. */
export function alignOriginalParagraphRanges(book:Book,targets:Range[],allowed:Range[]=targets):Range[]{
  return mergeRanges(permittedParagraphUnits(book,targets,allowed));
}

/** Character capacity is a soft estimate. One whole paragraph may exceed it. */
export function selectOriginalParagraphRanges(book:Book,targets:Range[],capacity:number,allowed:Range[]=targets):Range[]{
  return originalParagraphBatches(book,targets,capacity,allowed)[0]??[];
}

/** Ordered paragraph batches; callers retain responsibility for chapter grouping. */
export function originalParagraphBatches(book:Book,targets:Range[],capacity:number,allowed:Range[]=targets):Range[][]{
  if(!Number.isSafeInteger(capacity)||capacity<1)throw Error('正文容量无效');
  const batches:Range[][]=[];let selected:Range[]=[];
  for(const paragraph of permittedParagraphUnits(book,targets,allowed)){
    const next=mergeRanges([...selected,paragraph]);
    if(selected.length&&next.reduce((sum,range)=>sum+range.end-range.start,0)>capacity){batches.push(selected);selected=[paragraph];}
    else selected=next;
  }
  if(selected.length)batches.push(selected);
  return batches;
}
