import type {Range,State} from '../core/types.ts';
import type {ReplyTiming} from './contract.ts';

/** Engineering delivery facts, not an assessment of the content or user's attention. */
export function readingDelivery(state:State,bookId:string|undefined,since:number|undefined,timings:Record<string,ReplyTiming>,ranges?:readonly Range[]){
  if(!bookId||since===undefined)return undefined;
  const inScope=(formed:readonly Range[]|undefined)=>ranges===undefined||!!formed?.some(a=>ranges.some(b=>a.start<b.end&&b.start<a.end));
  const chats=state.chats.filter(chat=>chat.bookId===bookId&&chat.role==='assistant'&&chat.createdAt>=since&&inScope(chat.anchor?[chat.anchor]:chat.expressionAnchor?[chat.expressionAnchor]:chat.formationRanges));
  const judgments=(state.readings??[]).filter(record=>record.bookId===bookId&&record.createdAt>=since&&record.expressionOnly&&inScope(record.ranges));
  const usages=state.usage.filter(usage=>{if(usage.time<since||usage.purpose!=='现场参与'||!usage.requestKey)return false;try{const key=JSON.parse(usage.requestKey);return key[0]===bookId&&Array.isArray(key[4])&&inScope(key[4]);}catch{return false;}});
  const candidates=chats.filter(chat=>!!chat.readingReaction),published=chats.filter(chat=>chat.publication?.status==='published'&&!chat.excluded);
  const immediate=published.filter(chat=>chat.presentation!=='paragraph'),converted=published.filter(chat=>chat.presentation==='paragraph'&&chat.readingReaction);
  const deferred=candidates.filter(chat=>chat.publication?.status==='deferred');
  const lastJudgment=judgments.reduce((time,record)=>Math.max(time,record.createdAt),0);
  return{since,...(ranges!==undefined?{ranges:ranges.map(range=>({...range}))}:{}),sceneRequests:usages.filter(usage=>usage.dispatchState!=='not-dispatched').length,
    notDispatched:usages.filter(usage=>usage.dispatchState==='not-dispatched').length,
    judgments:judgments.length,quietDecisions:judgments.filter(record=>record.sceneJudgment==='quiet').length,
    savedImmediateCandidates:candidates.length,chatPublished:immediate.length,
    clientVisible:immediate.filter(chat=>timings[chat.id]?.visibleAt!==undefined).length,
    visibilityUnconfirmed:immediate.filter(chat=>timings[chat.id]?.visibleAt===undefined).length,
    directParagraphs:published.filter(chat=>chat.presentation==='paragraph'&&!chat.readingReaction).length,
    convertedToParagraph:converted.length,deferred:deferred.length,
    obsolete:candidates.filter(chat=>chat.publication?.status==='obsolete').length,
    saveFailed:candidates.filter(chat=>chat.publication?.status==='save-failed').length,
    lastJudgmentAt:lastJudgment||undefined,
    // Conversion is permitted (including quiet mode), but must remain visible
    // to an audit. This observation never controls scrolling or model dispatch.
    allSavedImmediateMissed:candidates.length>0&&!immediate.length&&!deferred.length&&candidates.every(chat=>chat.presentation==='paragraph'||chat.publication?.status==='obsolete')};
}

/** Only committed, immutable collection records may be cached here. The live
 * engine mutates records in place, so callers without a committed source must
 * use readingDelivery directly. Scope and visible receipts also invalidate it. */
export class ReadingDeliveryProjection {
  private inputs?:unknown[];
  private value?:ReturnType<typeof readingDelivery>;
  read(state:State,bookId:string|undefined,since:number|undefined,timings:Record<string,ReplyTiming>,ranges?:readonly Range[]){
    const inputs=[state.chats,state.readings,state.usage,bookId,since,timings,JSON.stringify(ranges)];
    if(!this.inputs||inputs.some((input,index)=>input!==this.inputs![index])){
      this.value=readingDelivery(state,bookId,since,timings,ranges);this.inputs=inputs;
    }
    return this.value;
  }
}
