import {chapterAt,chapterContentEnd,covers,mergeRanges,subtractRanges,bookTextSlice} from './books.ts';
import type {Book,Range,SceneOpportunity,State} from './types.ts';

/** Plan from granted text only. Slots belong to a chapter, not redraw events. */
export function nextSceneOpportunity(state:State,book:Book,visible:Range[],available:Range[]):{ranges:Range[];opportunity:SceneOpportunity}|undefined{
  const last=visible.at(-1);if(!last)return;
  const chapter=chapterAt(book,Math.max(last.start,last.end-1)),endOfContent=chapterContentEnd(book,chapter),length=endOfContent-chapter.start;
  const known=mergeRanges(book.known.map(r=>({start:Math.max(r.start,chapter.start),end:Math.min(r.end,chapter.end)})).filter(r=>r.end>r.start));
  const used=[...new Map(state.usage.filter(u=>u.sceneOpportunity?.chapterIndex===chapter.index&&u.dispatchState!=='not-dispatched'&&u.requestKey&&(()=>{try{const k=JSON.parse(u.requestKey!);return k[0]===book.id&&k[1]===book.version&&k[2]===state.partnerId;}catch{return false;}})()).map(u=>[u.sceneOpportunity!.slot,u.sceneOpportunity!])).values()].filter(o=>o.chapterIndex===chapter.index);
  const observations=book.sceneObserved?.find(o=>o.partnerId===state.partnerId)?.ranges??(book.sceneObserved?[]:known);
  const observed=mergeRanges(observations.flatMap(o=>known.map(k=>({start:Math.max(o.start,k.start),end:Math.min(o.end,k.end)}))).filter(r=>r.end>r.start));
  const seen=observed.reduce((n,r)=>n+r.end-r.start,0),step=Math.max(600,length/5);
  const atEnd=covers(known,{start:Math.max(chapter.start,endOfContent-1),end:endOfContent})&&last.end>=endOfContent;
  if(used.some(o=>o.slot==='end')||!atEnd&&(used.filter(o=>o.slot!=='end').length>=4||seen<step||seen-Math.max(0,...used.map(o=>o.seenChars))<step))return;
  const fresh=available.flatMap(r=>visible.map(v=>({start:Math.max(r.start,v.start,chapter.start),end:Math.min(r.end,v.end,chapter.end)}))).filter(r=>r.end>r.start);
  if(!fresh.length)return;
  const tail=fresh.at(-1)!,text=bookTextSlice(book,tail.start,tail.end);
  // The browser normally supplies complete paragraphs; partial lines wait for a
  // real paragraph/sentence boundary without reading beyond the visible range.
  const endings=[...text.matchAll(/[\n。！？!?][”’」』）)]*/gu)].map(m=>tail.start+m.index!+m[0].length);
  const end=atEnd?tail.end:endings.at(-1);if(end===undefined)return;
  const ranges=mergeRanges(available.map(r=>({start:Math.max(r.start,chapter.start,end-4000),end:Math.min(r.end,end)})).filter(r=>r.end>r.start));
  if(!ranges.length)return;
  const count=used.filter(o=>o.slot!=='end').length;
  return{ranges,opportunity:{chapterIndex:chapter.index,slot:atEnd?'end':count+1 as 1|2|3|4,position:end,seenChars:seen}};
}
export function sameSceneOpportunity(a:SceneOpportunity,b:SceneOpportunity):boolean{return a.chapterIndex===b.chapterIndex&&a.slot===b.slot;}

export function validateSceneOpportunity(book:Book,value:SceneOpportunity):void{
  const chapter=book.chapters.find(c=>c.index===value?.chapterIndex);
  if(!value||Object.keys(value).some(k=>!['chapterIndex','slot','position','seenChars'].includes(k))||!chapter||![1,2,3,4,'end'].includes(value.slot)||!Number.isSafeInteger(value.position)||value.position<=chapter.start||value.position>chapter.end||!Number.isSafeInteger(value.seenChars)||value.seenChars<1||value.seenChars>chapter.end-chapter.start)throw Error('自然现场机会的章节、槽位或获准累计身份无效');
}
