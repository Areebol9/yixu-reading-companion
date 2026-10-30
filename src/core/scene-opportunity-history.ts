import {bookVersionAllowsRanges} from './book-versions.ts';
import {covers,mergeRanges} from './books.ts';
import {chatBelongsToPartner} from './discussion-recall.ts';
import {ordinaryReadingTask} from './terminated-reading-continuation.ts';
import type {Book,State,Range,ReadingRecord} from './types.ts';

/** Request, draft and domain record IDs have distinct owners. */
export function sceneResultRelation(state:State,record:ReadingRecord):ReadingRecord['sceneResult']{
  if(record.sceneResult)return record.sceneResult;
  for(const usage of state.usage){const receipt=usage.agentResponse?.material?.operations?.find(operation=>operation.readingId===record.id);if(receipt)return{requestId:usage.id,chatIds:receipt.chatIds??[]};}
  return undefined;
}

/** New spoken exchanges identify the context of a prepared response. Likes and
 * emoji remain in the next supplied conversation but do not restart a paid
 * preview of the same unread original. */
export function sceneExchangeIdentity(state:State,bookId:string):unknown[]{
  const explicit=new Set((state.queryCheckpoints??[]).map(question=>question.questionId));
  return state.chats.filter(chat=>chat.bookId===bookId&&chatBelongsToPartner(state,chat)&&!chat.excluded&&!chat.outdatedBy&&!chat.replacedBy&&!chat.futureGrant&&
    (chat.role==='user'||explicit.has(chat.replyTo??'')))
    .map(chat=>[chat.id]);
}

/** Completed judgements, including a deliberate quiet result, cover their
 * actual original paragraphs. Unpublished previews additionally belong to the
 * exchange context in which they were prepared. Unread preview ownership is
 * useful for planning previews, but cannot finish the current-reading batch.
 * No viewport counters are stored. */
export function completedSceneRanges(state:State,book:Book,contextKey:string,options:{includeUnreadPreviews?:boolean}={}):Range[]{
  const calls=new Map(state.usage.map(usage=>[usage.id,usage]));
  const receipts=new Map(state.usage.flatMap(usage=>(usage.agentResponse?.material?.operations??[]).filter(operation=>operation.readingId).map(operation=>[operation.readingId!,{usage,chatIds:operation.chatIds??[]}] as const)));
  const expressions=new Map<string,State['chats']>();
  for(const chat of state.chats){const id=chat.publication?.scene?.usageId;if(id){const list=expressions.get(id)??[];list.push(chat);expressions.set(id,list);}}
  return mergeRanges((state.readings??[]).flatMap(record=>{
    if(record.bookId!==book.id||record.partnerId!==state.partnerId||!record.expressionOnly||!record.sceneJudgment||!bookVersionAllowsRanges(book,record.version,record.ranges))return[];
    if(record.sceneOpportunity?.preview&&!covers(book.known,record.sceneOpportunity.preview)&&!options.includeUnreadPreviews)return[];
    const receipt=receipts.get(record.id),usage=record.sceneResult?calls.get(record.sceneResult.requestId):receipt?.usage,task=usage?.requestKey?ordinaryReadingTask(usage.requestKey):undefined;
    const resultIds=new Set(record.sceneResult?.chatIds??receipt?.chatIds??[]),results=[...new Map([...(usage?expressions.get(usage.id)??[]:[]),...state.chats.filter(chat=>resultIds.has(chat.id))].map(chat=>[chat.id,chat])).values()];
    if(results.some(chat=>chat.publication?.status==='published'))return record.ranges;
    // A paid answer awaiting local delivery/save is still owned. An abandoned
    // expression alone is not a completed response to the reader's scene.
    if(record.sceneJudgment!=='quiet'&&!results.some(chat=>chat.publication?.status!=='obsolete'))return[];
    return !record.sceneOpportunity?.preview||task?.observationId===contextKey?record.ranges:[];
  }));
}
