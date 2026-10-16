import {chapterAt,chapterContentStart,chapterContentEnd,mergeRanges,readingStart,subtractRanges} from './books.ts';
import {coreViewHeads,viewAllowed,viewVersionUpdates,viewDescendsFrom} from './published-views.ts';
import {ordinaryReadingTask} from './terminated-reading-continuation.ts';
import type {Book,PublishedView,Range,State,MaintenanceClaim,MaintenanceViewTarget} from './types.ts';
import {isCurrentUnderstanding,isEvidenceAllowed,memoryIsForgotten} from './context.ts';
import type {MemoryPlan} from './memory-plan.ts';
import {requireMemoryText} from './memory-bodies.ts';

export const intersectRanges=(a:readonly Range[],b:readonly Range[])=>mergeRanges(a.flatMap(r=>b.flatMap(s=>{const start=Math.max(r.start,s.start),end=Math.min(r.end,s.end);return end>start?[{start,end}]:[];})));
/** Chapter navigation is never a permission or progress fact. */
export function authorizedChapterBodies(book:Book){
 return book.chapters.flatMap(chapter=>{const start=Math.max(readingStart(book),chapterContentStart(book,chapter)),end=chapterContentEnd(book,chapter);return end>start?[{chapter,body:{start,end},allowed:intersectRanges(book.known,[{start,end}])}]:[];});
}
export const corePublishedViews=coreViewHeads;
export function maintenanceCoreTargets(state:State,book:Book):MaintenanceViewTarget[]{const views=corePublishedViews(state,book);return(['overview','current'] as const).flatMap(kind=>{const heads=views.filter(v=>v.kind===kind);return heads.length?heads.map(view=>`view:${view.id}` as const):[kind];});}
/** Reuse the full document behind an actual prior reading commit, following its
 * legitimate development chain. No memory formation coordinate is a new grant. */
export function maintenanceReviewMaterials(state:State,book:Book,ranges:Range[]){
 const sources=(state.readings??[]).filter(r=>r.bookId===book.id&&r.version===book.version&&r.partnerId===state.partnerId&&!r.expressionOnly&&r.processing==='model'&&intersectRanges(r.ranges,ranges).length).flatMap(record=>{
  const resolved=record.memoryIds.map(id=>{let m=state.memories.find(m=>m.id===id);const seen=new Set<string>();while(m?.replacedBy&&!seen.has(m.id)){seen.add(m.id);const next=state.memories.find(n=>n.id===m!.replacedBy);if(!next||next.revisionKind!=='development')break;m=next;}return m&&m.bookId===book.id&&m.partnerId===state.partnerId&&isCurrentUnderstanding(m,undefined,book)&&!memoryIsForgotten(state,m)&&isEvidenceAllowed(book,m.evidence)?m.id:undefined;});
  const ids=resolved.filter((id):id is string=>!!id);return ids.length&&ids.length===record.memoryIds.length?[{ranges:intersectRanges(record.ranges,ranges),memoryIds:[...new Set(ids)]}]:[];
 });
 return{sources,memoryIds:[...new Set(sources.flatMap(s=>s.memoryIds))],originalRanges:subtractRanges(ranges,mergeRanges(sources.flatMap(s=>s.ranges)))};
}
/** Shared acceptance/commit diagnosis. Existing text may stay byte-for-byte,
 * but each core view must explicitly use this batch's actual new basis. */
export function isChatOnlyMaintenanceClaim(claim:MaintenanceClaim|undefined):boolean{return claim?.viewReviewVersion===1&&claim.chatIds.length>0&&!claim.ranges.length&&!claim.sceneRecordIds?.length&&!claim.viewReviewRanges?.length;}
/** New original text is deep-maintained by a complete understanding proposal,
 * not by publishing its short views. An unchanged complete proposal may reuse
 * its existing identity; pure view/chat checks do not manufacture documents. */
export function submittedUnderstandingMemoryIds(state:State,book:Book,plan:MemoryPlan):string[]{
 return [...new Set(plan.result?.thoughts.flatMap((thought,index)=>{const id=plan.proposalMemoryIds?.['t'+(index+1)],memory=plan.added.find(m=>m.id===id)??state.memories.find(m=>m.id===id);return thought.kind==='opinion'&&!!thought.text.trim()&&!!id&&plan.ids.includes(id)&&!!memory&&memory.kind==='opinion'&&memory.bookId===book.id&&memory.partnerId===state.partnerId&&!memory.forgotten&&!memory.replacedBy&&!memory.invalidatedBy&&!memory.historicalOnly&&requireMemoryText(memory)===thought.text?[id]:[];})??[])];
}
export function maintenanceUnderstandingErrors(state:State,book:Book,claim:Pick<MaintenanceClaim,'ranges'>,plan:MemoryPlan):string[]{
 if(!subtractRanges(intersectRanges(claim.ranges,book.known),book.prepared).length)return[];
 return submittedUnderstandingMemoryIds(state,book,plan).length?[]:['本批含尚未深处理的新正文，须在documents中提交实际完整认识（create、develop或revise），并同步检查overview/current；不能仅凭两份概要推进prepared。无需按章增建文档；若正文不改变已有认识，可重交核对后的完整正文并复用同一合法文档。原答保持，请补齐完整documents与views后同任务重交。'];
}
export function maintenanceViewBasisErrors(state:State,book:Book,claim:MaintenanceClaim,added:PublishedView[],newMemoryIds:string[],providedMemoryIds:string[]=[],providedOriginalRanges:Range[]=[]){
 if(claim.viewReviewVersion!==1)return[];
 const review=maintenanceReviewMaterials(state,book,claim.viewReviewRanges??[]),freshRanges=mergeRanges([...claim.ranges,...(claim.viewReviewRanges??[]),...(claim.sceneRecordIds??[]).flatMap(id=>state.readings?.find(r=>r.id===id)?.ranges??[])]),hasIncrement=!!(freshRanges.length||claim.chatIds.length),errors:string[]=[];
 if(!hasIncrement)return errors;const chatOnly=isChatOnlyMaintenanceClaim(claim);
 const missing=review.memoryIds.filter(id=>!providedMemoryIds.includes(id));if(missing.length)errors.push('概要补核须先实际取得这些完整认识正文（可按作用域精选采纳，无须每份概要采用全部认识）：'+missing.join('、'));
 for(const target of claim.viewTargets){const old=target.startsWith('view:')?state.publishedViews?.find(v=>v.id===target.slice(5)):undefined,kind=old?.kind??target;if(kind!=='overview'&&kind!=='current')continue;const candidates=added.filter(v=>v.kind===kind&&(!old||v.key===old.key||viewDescendsFrom(state,v,old.id)));
  const valid=candidates.some(view=>{const adopted=new Set(view.adoptedMemorySources?.map(s=>s.id)??[]);return(chatOnly&&(providedMemoryIds.some(id=>adopted.has(id))||view.originalSources.some(s=>providedOriginalRanges.some(r=>r.start<=s.evidence.start&&r.end>=s.evidence.end)))||newMemoryIds.some(id=>adopted.has(id))||intersectRanges(view.originalSources.map(s=>s.evidence),freshRanges).length||claim.chatIds.some(id=>view.chatIds.includes(id))||review.memoryIds.some(id=>adopted.has(id)));});
  if(!valid)errors.push(kind+(chatOnly?'须以本批实际给入的原文p或完整认识m，或真实交流c有据publish/keep；纯交流核对不要求把chatIds直接选入概要，也不要求制造新t。':'须通过本批实际原文p/交流c、新认识t，或概要补核已取得完整认识m，publish或有据keep；不能只引用原v表示已检查。')+(review.memoryIds.length?'本批补核完整认识已提供后，按本概要作用域精选实际采用的m；不要求全部采纳。':''));
 }
 return errors;
}
/** Only an actual pair of published successors from one committed claim proves
 * the range was checked. Text citations and memory formation ranges do not. */
export function checkedMaintenanceRanges(state:State,book:Book){
 const current=corePublishedViews(state,book),byKind:{overview:Range[];current:Range[]}={overview:[],current:[]};
 for(const u of state.usage){const d=u.maintenanceDispatch,task=u.requestKey&&ordinaryReadingTask(u.requestKey);if(!d?.committed||d.claim.viewReviewVersion!==1||u.status!=='complete'||u.modelOutcome||!task||task.bookId!==book.id||task.version!==book.version||task.partnerId!==state.partnerId)continue;
  const pair=(['overview','current'] as const).map(kind=>d.committed!.viewIds.map(id=>state.publishedViews?.find(v=>v.id===id)).find(view=>view?.kind===kind&&viewAllowed(state,book,view)&&current.some(live=>live.kind===kind&&!viewVersionUpdates(state,book,live).length&&(live.id===view.id||viewDescendsFrom(state,live,view.id)))&&d.claim.viewTargets.some(t=>t===kind||t.startsWith('view:')&&state.publishedViews?.find(old=>old.id===t.slice(5))?.kind===kind)));
  if(pair.some(v=>!v))continue;const ranges=intersectRanges(book.known,[...d.claim.ranges,...(d.claim.viewReviewRanges??[])]);byKind.overview.push(...ranges);byKind.current.push(...ranges);
 }
 return{overview:mergeRanges(byKind.overview),current:mergeRanges(byKind.current),both:intersectRanges(byKind.overview,byKind.current)};
}
export function readingContinuity(state:State,book:Book,position=book.position){
 const chapters=authorizedChapterBodies(book),focus=chapterAt(book,Math.max(0,position-1)),at=chapters.findIndex(c=>c.chapter.index===focus.index),checked=checkedMaintenanceRanges(state,book),risk=mergeRanges(chapters.slice(0,Math.max(0,at-1)).flatMap(c=>c.allowed)),near=mergeRanges(chapters.slice(0,Math.max(0,at)).flatMap(c=>c.allowed)),deepMissing=subtractRanges(risk,book.prepared),viewMissing=subtractRanges(risk,checked.both),nearDeepMissing=subtractRanges(near,book.prepared),nearViewMissing=subtractRanges(near,checked.both),reviewRanges=subtractRanges(intersectRanges(mergeRanges(chapters.flatMap(c=>c.allowed)),book.prepared),checked.both);
 return{chapter:at<0?undefined:at+1,riskRanges:risk,deepMissing,viewMissing,nearDeepMissing,nearViewMissing,reviewRanges,blocked:!!(deepMissing.length||viewMissing.length),urgent:!!(nearDeepMissing.length||nearViewMissing.length),overviewChecked:checked.overview,currentChecked:checked.current};
}
