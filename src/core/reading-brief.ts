import {bookVersionAllowsRange} from './book-versions.ts';
import { covers,id,mergeRanges,normalize } from './books.ts';
import { evidence,isBackgroundMemory,isCurrentMemory,isEvidenceAllowed,usableMemories ,memoryIsForgotten} from './context.ts';
import type { Book,Evidence,Memory,Range,State } from './types.ts';

export const READING_BRIEF_LIMIT=1000;
const stageEnd=(m:Memory)=>Math.max(0,...(m.readingStage??[]).map(r=>r.end));
const sameLane=(m:Memory,source:Memory['source'])=>isBackgroundMemory(m)===(source==='background');

/** A model-authored working snapshot, not a new factual authority. Normal scope
 * and revision filtering applies before choosing it; revisiting a page does not
 * roll the latest permitted story state backward. */
export function selectReadingBrief(state:State,book:Book,source:Memory['source']='reading',extra:Range[]=[]):Memory|undefined{
  return usableMemories(state,book,extra).filter(m=>m.kind==='context'&&sameLane(m,source))
    .sort((a,b)=>stageEnd(b)-stageEnd(a)||b.createdAt-a.createdAt)[0];
}

/** Explicit archive lookup. A later reading snapshot supersedes the current view,
 * not the historical episode; corrections and forgetting still retire it. */
export function historicalReadingBriefs(state:State,book:Book,extra:Range[]=[]):Memory[]{
  const all=new Map(state.memories.map(m=>[m.id,m]));
  return state.memories.filter(m=>m.kind==='context'&&m.bookId===book.id&&m.partnerId===state.partnerId&&
    !m.forgotten&&!m.invalidatedBy&&isEvidenceAllowed(book,m.evidence,extra)&&
    !memoryIsForgotten(state,m)&&
    (!m.replacedBy||all.get(m.replacedBy)?.kind==='context'&&all.get(m.replacedBy)?.revisionKind==='development'));
}

export function planReadingBrief(state:State,book:Book,text:string|undefined,refs:Evidence[],parents:string[],chatIds:string[],source:Memory['source'],stage:Range[],newIds:string[],habitIds:string[]):{memory:Memory;previous?:Memory}|undefined{
  const value=text?.trim();
  if(!value||!stage.length)return;
  if(value.length>READING_BRIEF_LIMIT)throw new Error('阅读简报过长');
  if(stage.some(r=>!Number.isSafeInteger(r.start)||!Number.isSafeInteger(r.end)||r.end<=r.start||!covers(refs,r)))throw new Error('阅读简报的形成范围无效');
  if(state.forgotten.some(f=>f.bookId===book.id&&normalize(value).includes(normalize(f.text))))return;
  const previous=selectReadingBrief(state,book,source);
  // A page revisit can create ordinary observations; it must not replace the
  // farther reading checkpoint with a summary of an earlier scene.
  if(previous&&(Math.max(...stage.map(r=>r.end))<stageEnd(previous)||previous.text===value))return;
  const linked=previous&&parents.includes(previous.id)&&isCurrentMemory(previous)?previous:undefined;
  const memory:Memory={id:id(),bookId:book.id,partnerId:state.partnerId,kind:'context',text:value,
    evidence:mergeRanges(refs.filter(r=>r.bookId===book.id&&bookVersionAllowsRange(book,r.version,r))).map(r=>evidence(book,r)),
    parents:[...new Set([...parents,...newIds])],chatIds:[...chatIds],createdAt:Date.now(),forgotten:false,source,
    readingStage:mergeRanges(stage),...(habitIds.length?{habitIds:[...habitIds]}:{}),
    ...(linked?{correctionOf:linked.id,revisionKind:'development',revisionReason:'阅读现场与关注点接续。'}:{})};
  return {memory,previous:linked};
}
