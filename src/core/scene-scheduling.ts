import {chapterAt,chapterContentEnd,covers,mergeRanges} from './books.ts';
import type {Book,Range,SceneOpportunity,State} from './types.ts';
import {alignOriginalParagraphRanges,originalParagraphRanges,selectOriginalParagraphRanges} from './original-paragraphs.ts';

/** Shared with the reader's existing window setting; never inferred from a scroll fragment. */
export const DEFAULT_READING_WINDOW_CHARS=1400;
type SceneSchedulingOptions={windowChars?:number;flush?:boolean};
const readingWindowChars=(value:number|undefined)=>value!==undefined&&Number.isSafeInteger(value)&&value>0?value:DEFAULT_READING_WINDOW_CHARS;
const limitedAutomaticRequests=(state:State)=>state.partners.find(partner=>partner.id===state.partnerId)?.preferences?.limitAutomaticRequests!==false;

/** Plan from the actual observation; request history is not reading progress. */
export function nextSceneOpportunity(state:State,book:Book,visible:Range[],available:Range[],options:SceneSchedulingOptions={}):{ranges:Range[];opportunity:SceneOpportunity}|undefined{
  const last=visible.at(-1);if(!last)return;
  const first=mergeRanges(available)[0];if(!first)return;
  const chapter=chapterAt(book,first.start),endOfContent=chapterContentEnd(book,chapter),currentChapter=chapterAt(book,Math.max(last.start,last.end-1));
  const known=mergeRanges(book.known.map(r=>({start:Math.max(r.start,chapter.start),end:Math.min(r.end,chapter.end)})).filter(r=>r.end>r.start));
  const observations=book.sceneObserved?.find(o=>o.partnerId===state.partnerId)?.ranges??(book.sceneObserved?[]:known);
  const observed=mergeRanges(observations.flatMap(o=>known.map(k=>({start:Math.max(o.start,k.start),end:Math.min(o.end,k.end)}))).filter(r=>r.end>r.start));
  const seen=observed.reduce((n,r)=>n+r.end-r.start,0);
  const fresh=available.map(range=>({start:Math.max(range.start,chapter.start),end:Math.min(range.end,chapter.end)})).filter(range=>range.end>range.start);
  if(!fresh.length)return;
  const complete=alignOriginalParagraphRanges(book,fresh,book.known);
  if(!complete.length)return;
  const windowChars=readingWindowChars(options.windowChars),limited=limitedAutomaticRequests(state),reachedEnd=complete.at(-1)!.end>=endOfContent;
  // Retain earlier observed paragraphs after scrolling away. A chapter exit or
  // its actual end releases the remainder without granting any skipped text.
  if(limited&&!options.flush&&!reachedEnd&&chapter.index===currentChapter.index&&complete.reduce((sum,range)=>sum+range.end-range.start,0)<windowChars)return;
  const ranges=selectOriginalParagraphRanges(book,complete,limited?windowChars:4000,book.known);
  if(!ranges.length)return;
  const end=ranges.at(-1)!.end,atEnd=end>=endOfContent;
  return{ranges,opportunity:{chapterIndex:chapter.index,slot:atEnd?'end':end,position:end,seenChars:seen}};
}
/** Prepare one nearby gap in full paragraphs; every plan stays anchored to the visible page. */
export function nextScenePreview(state:State,book:Book,visible:Range[],covered:Range[],options:SceneSchedulingOptions={}):{ranges:Range[];opportunity:SceneOpportunity}|undefined{
  const last=visible.at(-1);if(!last)return;
  const chapter=chapterAt(book,Math.max(last.start,last.end-1)),endOfContent=chapterContentEnd(book,chapter);
  if(last.end>=endOfContent)return;
  const capacity=readingWindowChars(options.windowChars),limited=limitedAutomaticRequests(state);
  const nearbyEnd=Math.min(endOfContent,last.end+capacity);
  const paragraphs=originalParagraphRanges(book,{start:chapter.contentStart??chapter.start,end:endOfContent})
    .filter(paragraph=>paragraph.end>last.end&&paragraph.start<nearbyEnd);
  // Current, already-read paragraphs belong to the current-reading batch.
  // Including them in a new preview would hold their expressions behind
  // unrelated future paragraphs from the same model input.
  const completed=mergeRanges(covered),first=paragraphs.findIndex(paragraph=>!covers(completed,paragraph)&&!covers(book.known,paragraph));
  if(first<0)return;
  const selected:Range[]=[];
  for(const paragraph of paragraphs.slice(first)){if(covers(completed,paragraph)||covers(book.known,paragraph))break;selected.push(paragraph);}
  const start=selected[0].start,target=selected.at(-1)!,preview={start,end:target.end,targetStart:target.start};
  if(limited&&target.end<endOfContent&&selected.reduce((sum,range)=>sum+range.end-range.start,0)<capacity)return;
  if(covers(book.known,preview))return;
  const known=mergeRanges(book.known.map(r=>({start:Math.max(r.start,chapter.start),end:Math.min(r.end,chapter.end)})).filter(r=>r.end>r.start));
  const observations=book.sceneObserved?.find(o=>o.partnerId===state.partnerId)?.ranges??(book.sceneObserved?[]:known);
  const observed=mergeRanges(observations.flatMap(o=>known.map(k=>({start:Math.max(o.start,k.start),end:Math.min(o.end,k.end)}))).filter(r=>r.end>r.start));
  const seen=observed.reduce((n,r)=>n+r.end-r.start,0);
  if(!seen)return;
  if(limited&&alignOriginalParagraphRanges(book,observed,known).reduce((sum,range)=>sum+range.end-range.start,0)<capacity)return;
  return{ranges:[{start,end:target.end}],opportunity:{chapterIndex:chapter.index,slot:target.end>=endOfContent?'end':target.end,position:target.end,seenChars:seen,preview}};
}
/** This scope belongs only to an automatic scene; ordinary questions and maintenance never inherit it. */
export function scenePreviewRanges(material:{taskRole?:string;sceneOpportunity?:SceneOpportunity}):Range[]{
  const preview=material.taskRole==='scene'?material.sceneOpportunity?.preview:undefined;
  return preview?[{start:preview.start,end:preview.end}]:[];
}
export function scenePreviewReady(book:Book,opportunity?:SceneOpportunity):boolean{
  return !opportunity?.preview||covers(book.known,opportunity.preview);
}
export function validateSceneOpportunity(book:Book,value:SceneOpportunity):void{
  const chapter=book.chapters.find(c=>c.index===value?.chapterIndex);
  if(!value||Object.keys(value).some(k=>!['chapterIndex','slot','position','seenChars','preview'].includes(k))||!chapter||!(value.slot==='end'||Number.isSafeInteger(value.slot)&&Number(value.slot)>0)||!Number.isSafeInteger(value.position)||value.position<=chapter.start||value.position>chapter.end||!Number.isSafeInteger(value.seenChars)||value.seenChars<1||value.seenChars>chapter.end-chapter.start)throw Error('自然现场机会的章节、段末或获准累计身份无效');
  const p=value.preview;
  if(p&&(Object.keys(p).some(k=>!['start','end','targetStart'].includes(k))||![p.start,p.end,p.targetStart].every(Number.isSafeInteger)||p.start<chapter.start||p.targetStart<p.start||p.targetStart>=p.end||p.end!==value.position||p.end>chapterContentEnd(book,chapter)))throw Error('现场预读须绑定本章原段和同一发表段末');
}
