import {chapterAt,chapterContentEnd,mergeRanges,subtractRanges} from './books.ts';
import {selectOriginalParagraphRanges} from './original-paragraphs.ts';
import type {Book,Chat,MaintenanceJob,Range,State} from './types.ts';

export type MaintenanceBatch={kind:'original'|'exchange'|'review';ranges:Range[];viewReviewRanges:Range[];chatIds:string[];sceneRecordIds:string[]};

/** One selection drives both scheduling and supply. Capacity limits the packet
 * after selection; it is not a reason to wait for more chapters or exchanges. */
export function selectMaintenanceBatch(book:Book,job:MaintenanceJob,state:Pick<State,'chats'|'readings'|'maintenanceJobs'>,options:{requested?:boolean}={}):MaintenanceBatch|undefined {
  const original=mergeRanges(job.ranges),review=mergeRanges(job.viewReviewRanges??[]);
  if(original.length&&job.reason!=='等待读完原段'){
    const chapter=chapterAt(book,original[0].start),ranges=original.filter(range=>range.start<chapter.end).map(range=>({start:range.start,end:Math.min(range.end,chapter.end)}));
    if(options.requested||chapter.end<=book.position||ranges.some(range=>range.end>=chapterContentEnd(book,chapter)))return{kind:'original',ranges,viewReviewRanges:[],chatIds:job.chatIds,sceneRecordIds:job.sceneRecordIds??[]};
  }
  // New exchanges concerning pending original text belong to that text's batch.
  // Late exchanges about already processed text can proceed independently.
  const pending=subtractRanges(mergeRanges((state.maintenanceJobs??[]).filter(item=>!item.dismissed&&item.bookId===book.id&&item.version===book.version).flatMap(item=>item.ranges)),book.prepared);
  const attached=(ranges:readonly Range[])=>ranges.some(range=>pending.some(original=>range.start<original.end&&original.start<range.end));
  const chats=new Map(state.chats.map(chat=>[chat.id,chat])),readings=new Map((state.readings??[]).map(record=>[record.id,record]));
  const chatIds=job.chatIds.filter(id=>{const chat=chats.get(id);return !!chat&&!attached(chat.formationRanges?.length?chat.formationRanges:chat.anchor?[chat.anchor]:chat.expressionAnchor?[chat.expressionAnchor]:chat.evidence);});
  const sceneRecordIds=(job.sceneRecordIds??[]).filter(id=>{const record=readings.get(id);return !!record&&!attached(record.ranges);});
  if(chatIds.length||sceneRecordIds.length)return{kind:'exchange',ranges:[],viewReviewRanges:[],chatIds,sceneRecordIds};
  // Use otherwise idle background time; there is no full-context threshold.
  // Targets belonging only to unfinished original text wait with that text.
  if(review.length||!original.length&&job.viewTargets?.length)return{kind:'review',ranges:[],viewReviewRanges:review,chatIds:[],sceneRecordIds:[]};
}

/** One chapter at a time. Capacity may split batches, never original paragraphs. */
export function selectMaintenanceRanges(book:Book,pending:Range[],capacity:number):Range[] {
  if(!Number.isSafeInteger(capacity)||capacity<1)throw Error('维护正文容量无效');
  const ranges=mergeRanges(pending);if(!ranges.length)return [];
  const chapter=chapterAt(book,ranges[0].start),targets=ranges.filter(range=>range.start<chapter.end).map(range=>({start:range.start,end:Math.min(range.end,chapter.end)}));
  // Full paragraphs are supplied as context later. The committed work still
  // belongs to this job: paragraph padding may already belong to a prior batch.
  const selected=selectOriginalParagraphRanges(book,targets,capacity,book.known);
  return mergeRanges(selected.flatMap(paragraph=>targets.flatMap(target=>{
    const start=Math.max(paragraph.start,target.start),end=Math.min(paragraph.end,target.end);
    return start<end?[{start,end}]:[];
  })));
}

/** Keep a question and its available replies together; do not cut user prose.
 * One oversized exchange is retained whole for the ordinary capacity check. */
export function selectMaintenanceChats(chats:Chat[],ids:string[],through:number|undefined,capacity:number):string[] {
  const candidates=chats.filter(chat=>ids.includes(chat.id)&&(through===undefined||chat.evidence.every(range=>range.end<=through)));
  const byId=new Map(candidates.map(chat=>[chat.id,chat])),groups=new Map<string,Chat[]>();
  for(const chat of candidates){let root=chat;const seen=new Set([chat.id]);while(root.replyTo&&byId.has(root.replyTo)&&!seen.has(root.replyTo)){seen.add(root.replyTo);root=byId.get(root.replyTo)!;}groups.set(root.id,[...(groups.get(root.id)??[]),chat]);}
  const selected:string[]=[];let size=0;
  for(const group of groups.values()){const chars=group.reduce((n,chat)=>n+chat.text.length,0);if(selected.length&&size+chars>capacity)break;selected.push(...group.map(chat=>chat.id));size+=chars;}
  return selected;
}
