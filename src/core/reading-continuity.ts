import {documentScope,memoryReadableByPartner,sameDocumentOwner} from './book-document-ownership.ts';
import {bookVersionPrefixLength} from './book-versions.ts';
import {bookVersionAllowsRanges,resolveBookVersion} from './book-versions.ts';
import {chapterAt,chapterContentStart,chapterContentEnd,mergeRanges,readingStart,subtractRanges} from './books.ts';
import {coreViewHeads,viewAllowed,viewDescendsFrom,viewReviewedMemorySource,resolveMaintenanceViewTargets,createPublishedViewCheck} from './published-views.ts';
import type {PublishedViewCheck} from './published-views.ts';
import {ordinaryReadingTask} from './terminated-reading-continuation.ts';
import type {Book,PublishedView,Range,State,MaintenanceClaim,MaintenanceJob,MaintenanceViewTarget} from './types.ts';
import {isCurrentUnderstanding,isEvidenceAllowed,memoryIsForgotten} from './context.ts';
import type {MemoryPlan} from './memory-plan.ts';
import {requireMemoryText,memoryTextLength} from './memory-bodies.ts';
import {maintenanceProgressFacts,maintenanceDocumentSources} from './maintenance-progress.ts';

export const intersectRanges=(a:readonly Range[],b:readonly Range[])=>mergeRanges(a.flatMap(r=>b.flatMap(s=>{const start=Math.max(r.start,s.start),end=Math.min(r.end,s.end);return end>start?[{start,end}]:[];})));
/** Chapter navigation is never a permission or progress fact. */
export function authorizedChapterBodies(book:Book){
 const known=mergeRanges(book.known),boundary=readingStart(book);
 return book.chapters.flatMap(chapter=>{const start=Math.max(boundary,chapterContentStart(book,chapter)),end=chapterContentEnd(book,chapter);if(end<=start)return[];
  const allowed:Range[]=[];for(const range of known){if(range.end<=start)continue;if(range.start>=end)break;allowed.push({start:Math.max(start,range.start),end:Math.min(end,range.end)});}
  return[{chapter,body:{start,end},allowed}];
 });
}
export const corePublishedViews=coreViewHeads;
export function maintenanceCoreTargets(state:State,book:Book):MaintenanceViewTarget[]{const views=corePublishedViews(state,book);return(['overview','current'] as const).flatMap(kind=>{const heads=views.filter(v=>v.kind===kind);return heads.length?heads.map(view=>`view:${view.id}` as const):[kind];});}
/** Existing range-review obligations retain their original targets. New text
 * does not create a mandatory overview/current pair; actual document changes
 * identify affected views when their results are saved. */
export function maintenanceDefaultViewTargets(state:State,book:Book,scope:Pick<MaintenanceClaim,'ranges'|'viewReviewRanges'>):MaintenanceViewTarget[]{
 return scope.viewReviewRanges?.length?maintenanceCoreTargets(state,book):[];
}
/** Reuse the full document behind an actual prior reading commit, following its
 * legitimate development chain. No memory formation coordinate is a new grant. */
export function maintenanceReviewMaterials(state:State,book:Book,ranges:Range[]){
 const sources=(state.readings??[]).filter(r=>r.bookId===book.id&&bookVersionAllowsRanges(book,r.version,r.ranges)&&!r.expressionOnly&&r.processing==='model'&&intersectRanges(r.ranges,ranges).length).flatMap(record=>{
  const resolved=record.memoryIds.map(id=>{let m=state.memories.find(m=>m.id===id);const seen=new Set<string>();while(m?.replacedBy&&!seen.has(m.id)){seen.add(m.id);const next=state.memories.find(n=>n.id===m!.replacedBy);if(!next||next.revisionKind!=='development')break;m=next;}return m&&m.bookId===book.id&&memoryReadableByPartner(state,m)&&isCurrentUnderstanding(m,undefined,book)&&!memoryIsForgotten(state,m)&&isEvidenceAllowed(book,m.evidence)?m.id:undefined;});
  const ids=resolved.filter((id):id is string=>!!id);return ids.length&&ids.length===record.memoryIds.length?[{ranges:intersectRanges(record.ranges,ranges),memoryIds:[...new Set(ids)]}]:[];
 });
 return{sources,memoryIds:[...new Set(sources.flatMap(s=>s.memoryIds))],originalRanges:subtractRanges(ranges,mergeRanges(sources.flatMap(s=>s.ranges)))};
}
/** Deferred view work retains its causal documents in the existing execution
 * receipts. No extra queue/state is needed, and consumed chats stay consumed. */
export function maintenanceCurrentReviewMemoryIds(state:State,book:Book,ids:readonly string[]):string[]{
 const versions=new Map(state.memories.map(memory=>[memory.id,memory]));
 return [...new Set(ids.map(id=>{
  let memory=versions.get(id);const seen=new Set<string>();
  while(memory?.replacedBy&&!seen.has(memory.id)){
   seen.add(memory.id);const next=versions.get(memory.replacedBy);
   if(!next||next.revisionKind!=='development'||!sameDocumentOwner(memory,next)||!memoryReadableByPartner(state,next)||!isEvidenceAllowed(book,next.evidence))break;
   memory=next;
  }
  // Missing/withdrawn/invalid material remains a responsibility. Its ordinary
  // reader/admission check must report it, not silently mark it reviewed.
  return memory&&memory.bookId===book.id&&memoryReadableByPartner(state,memory)&&isCurrentUnderstanding(memory,undefined,book)&&!memoryIsForgotten(state,memory)&&isEvidenceAllowed(book,memory.evidence)?memory.id:id;
 }))];
}
export type MaintenanceInputScope={ranges:Range[];chatIds:string[];sceneRecordIds:string[]};
export function maintenanceDeferredMemoryIds(state:State,book:Book,job:MaintenanceJob,targets:readonly MaintenanceViewTarget[],inputs?:MaintenanceInputScope,check=createPublishedViewCheck(state,book)):string[]{
 const currentTargets=resolveMaintenanceViewTargets(state,book,targets,check);
 if(!currentTargets.length)return[];
 const ids=[...new Set(maintenanceDocumentSources(state,job.id).filter(receipt=>!inputs||receipt.claim.chatIds.some(id=>inputs.chatIds.includes(id))||receipt.claim.sceneRecordIds?.some(id=>inputs.sceneRecordIds.includes(id))).flatMap(receipt=>receipt.memoryIds))];
 const pending=ids.filter(id=>currentTargets.some(target=>{
  const view=target.startsWith('view:')?state.publishedViews?.find(view=>view.id===target.slice(5)):undefined;
  return !view||!viewReviewedMemorySource(state,book,view,id,check);
 }));
 return maintenanceCurrentReviewMemoryIds(state,book,pending);
}
/** Add whole documents until the configured request allowance is filled.
 * Already-selected range sources share the same budget and count only once. */
export function selectMaintenanceReviewMemoryIds(state:State,candidates:readonly string[],capacity:number,selected:readonly string[]=[],originalChars=0):string[]{
 const ids=[...new Set(selected)],byId=new Map(state.memories.map(memory=>[memory.id,memory]));
 const size=(id:string)=>{const memory=byId.get(id);if(!memory)throw Error('概要待核来源缺失，原责任保留：'+id);return memoryTextLength(memory);};
 let chars=originalChars+ids.reduce((sum,id)=>sum+size(id),0);
 for(const id of new Set(candidates)){
  if(ids.includes(id))continue;const length=size(id);
  if(chars+length>capacity&&(ids.length||originalChars))continue;
  ids.push(id);chars+=length;
 }
 return ids;
}
/** Batch overview review by its actual deduplicated current documents, not by
 * chapter count. One oversized source remains explicit for normal admission;
 * it is never silently omitted or recorded as reviewed. */
export function selectMaintenanceReviewRanges(state:State,book:Book,pending:Range[],capacity:number):Range[]{
 const units=mergeRanges(pending).flatMap(range=>{const edges=[range.start,...book.chapters.map(chapter=>chapter.end).filter(end=>end>range.start&&end<range.end),range.end].sort((a,b)=>a-b);return edges.slice(1).map((end,index)=>({start:edges[index],end})).filter(range=>range.end>range.start);});
 let selected:Range[]=[];
 for(const unit of units){
  const candidate=mergeRanges([...selected,unit]),review=maintenanceReviewMaterials(state,book,candidate);
  const chars=review.originalRanges.reduce((n,r)=>n+r.end-r.start,0)+review.memoryIds.reduce((n,id)=>n+memoryTextLength(state.memories.find(memory=>memory.id===id)!),0);
  if(selected.length&&chars>capacity)break;
  selected=candidate;
 }
 return selected;
}
/** Per-target range debt uses the target's actual source reviews, not merely
 * the existence of a newer view. Shared by recovery, selection and display so
 * discussion/cold recovery does not rely on reading-mode target defaults. */
export function maintenancePendingViewReview(state:State,book:Book,ranges:Range[],targets:readonly MaintenanceViewTarget[],check:PublishedViewCheck=createPublishedViewCheck(state,book)):{sourceRanges:Range[];originalRanges:Range[]}{
 const relevant=resolveMaintenanceViewTargets(state,book,targets,check).flatMap(target=>{
  const view=target.startsWith('view:')?state.publishedViews?.find(view=>view.id===target.slice(5)):undefined,kind=view?.kind??target;
  return kind==='overview'||kind==='current'?[{view,kind}]:[];
 });
 if(!relevant.length||!ranges.length)return{sourceRanges:[],originalRanges:[]};
 const review=maintenanceReviewMaterials(state,book,ranges),checked=checkedMaintenanceRanges(state,book,check);
 const sourceRanges=mergeRanges(review.sources.filter(source=>relevant.some(({view})=>!view||source.memoryIds.some(id=>!viewReviewedMemorySource(state,book,view,id,check)))).flatMap(source=>source.ranges));
 const originalRanges=mergeRanges(relevant.flatMap(({kind})=>subtractRanges(review.originalRanges,checked[kind])));
 return{sourceRanges,originalRanges};
}
/** Exact range completion follows the sources actually reviewed by both
 * core successors, independently of other documents still owed by the job. */
export function maintenanceReviewedSourceRanges(state:State,book:Book,ranges:Range[],views:PublishedView[],check=createPublishedViewCheck(state,book)):Range[]{
 const review=maintenanceReviewMaterials(state,book,ranges),core=(['overview','current'] as const).map(kind=>views.filter(view=>view.kind===kind));
 if(core.some(group=>!group.length))return[];
 const unchecked=review.sources.filter(source=>!core.every(group=>group.some(view=>source.memoryIds.every(id=>viewReviewedMemorySource(state,book,view,id,check))))).flatMap(source=>source.ranges);
 return subtractRanges(ranges,unchecked);
}
/** Shared acceptance/commit diagnosis. Existing text may stay byte-for-byte,
 * but each core view must explicitly use this batch's actual new basis. */
export function isChatOnlyMaintenanceClaim(claim:MaintenanceClaim|undefined):boolean{return claim?.viewReviewVersion===1&&claim.chatIds.length>0&&!claim.ranges.length&&!claim.sceneRecordIds?.length&&!claim.viewReviewRanges?.length;}
/** New original text requires actual understanding: changed complete documents
 * or an explicit, verified decision to retain an existing understanding. */
export function submittedUnderstandingMemoryIds(state:State,book:Book,plan:MemoryPlan):string[]{
 const proposed=plan.result?.thoughts.flatMap((thought,index)=>{const id=plan.proposalMemoryIds?.['t'+(index+1)],memory=plan.added.find(m=>m.id===id)??state.memories.find(m=>m.id===id);return thought.kind==='opinion'&&!!thought.text.trim()&&!!id&&plan.ids.includes(id)&&!!memory&&memory.kind==='opinion'&&memory.bookId===book.id&&documentScope(memory)==='book'&&memory.documentState!=='retired'&&!memory.forgotten&&!memory.replacedBy&&!memory.invalidatedBy&&!memory.historicalOnly&&requireMemoryText(memory)===thought.text?[id]:[];})??[];
 const retained=(plan.result?.reinforce??[]).filter(id=>{const m=state.memories.find(m=>m.id===id);return plan.reused.includes(id)&&plan.ids.includes(id)&&m?.kind==='opinion'&&m.bookId===book.id&&documentScope(m)==='book'&&memoryReadableByPartner(state,m)&&isCurrentUnderstanding(m,undefined,book)&&!memoryIsForgotten(state,m)&&isEvidenceAllowed(book,m.evidence);});
 return [...new Set([...proposed,...retained])];
}
export function maintenanceUnderstandingErrors(state:State,book:Book,claim:Pick<MaintenanceClaim,'ranges'>,plan:MemoryPlan):string[]{
 if(!subtractRanges(intersectRanges(claim.ranges,book.known),book.prepared).length)return[];
 if(submittedUnderstandingMemoryIds(state,book,plan).length)return[];
 const privateDocuments=(plan.result?.thoughts??[]).flatMap((thought,index)=>{
  const id=plan.proposalMemoryIds?.['t'+(index+1)],memory=plan.added.find(m=>m.id===id)??state.memories.find(m=>m.id===id);
  return thought.kind==='opinion'&&memory?.bookId===book.id&&plan.ids.includes(memory.id)&&documentScope(memory)==='partner'?['documents['+index+']（t'+(index+1)+'）']:[];
 });
 const privateRetained=(plan.result?.reinforce??[]).flatMap((id,index)=>{const memory=state.memories.find(m=>m.id===id);return memory?.bookId===book.id&&memory.kind==='opinion'&&documentScope(memory)==='partner'?['reinforce['+index+']']:[];});
 if(privateDocuments.length||privateRetained.length)return['本批新正文尚未形成scope:book的书籍理解：'+[...privateDocuments,...privateRetained].join('、')+'对应文档的有效scope为partner（旧记录未标scope时也保留私人归属）。修订继承原scope，不能把私人旧稿改成book；已保存的私人文档与原candidate保持。请沿原candidate在/documents/-追加一篇scope:book、organization.subject明确且有实际原文依据的本批分析，或reinforce本任务确已读全且仍有效的book文档；不要求复制旧全文、迁移私人记录或重交已保存操作。概要按本批viewTargets处理；未安排的概要由原任务保留待核，不阻止本批书籍理解保存。'];
 return ['本批新正文须实际理解：变化写入documents；核对后旧认识仍成立时用reinforce明确保留本任务已完整读过的有效m，无须重交旧全文。概要按本批viewTargets处理；不能仅凭两份概要推进prepared。'];
}
export function maintenanceViewBasisErrors(state:State,book:Book,claim:MaintenanceClaim,added:PublishedView[],newMemoryIds:string[],providedMemoryIds:string[]=[],providedOriginalRanges:Range[]=[],reviewScope?:readonly string[]){
 if(claim.viewReviewVersion!==1||!claim.viewTargets.length)return[];
 const review=maintenanceReviewMaterials(state,book,claim.viewReviewRanges??[]),freshRanges=mergeRanges([...claim.ranges,...(claim.viewReviewRanges??[]),...(claim.sceneRecordIds??[]).flatMap(id=>state.readings?.find(r=>r.id===id)?.ranges??[])]),hasIncrement=!!(freshRanges.length||claim.chatIds.length),errors:string[]=[];
 if(!hasIncrement)return errors;const chatOnly=isChatOnlyMaintenanceClaim(claim);
 if(reviewScope!==undefined)review.memoryIds=review.memoryIds.filter(id=>reviewScope.includes(id));
 const missing=review.memoryIds.filter(id=>!providedMemoryIds.includes(id));if(missing.length)errors.push('概要补核须先实际取得这些完整认识正文（可按作用域精选采纳，无须每份概要采用全部认识）：'+missing.join('、'));
 for(const target of claim.viewTargets){const old=target.startsWith('view:')?state.publishedViews?.find(v=>v.id===target.slice(5)):undefined,kind=old?.kind??target;if(kind!=='overview'&&kind!=='current')continue;const candidates=added.filter(v=>v.kind===kind&&(!old||v.key===old.key||viewDescendsFrom(state,v,old.id)));
  const valid=candidates.some(view=>{const adopted=new Set([...(view.adoptedMemorySources??[]),...(view.reviewedMemorySources??[])].map(s=>s.id));return(chatOnly&&(providedMemoryIds.some(id=>adopted.has(id))||view.originalSources.some(s=>providedOriginalRanges.some(r=>r.start<=s.evidence.start&&r.end>=s.evidence.end)))||newMemoryIds.some(id=>adopted.has(id))||intersectRanges(view.originalSources.map(s=>s.evidence),freshRanges).length||claim.chatIds.some(id=>view.chatIds.includes(id))||review.memoryIds.some(id=>adopted.has(id)));});
  if(!valid)errors.push(kind+(chatOnly?'须以本批实际给入的原文p或完整认识m，或真实交流c有据publish/keep；纯交流核对不要求把chatIds直接选入概要，也不要求制造新t。':'须通过本批实际原文p/交流c、新认识t，或概要补核已取得完整认识m，publish或有据keep；不能只引用原v表示已检查。')+(review.memoryIds.length?'本批补核完整认识已提供后，按本概要作用域精选实际采用的m；不要求全部采纳。':''));
 }
 return errors;
}
/** Only an actual pair of published successors from one committed claim proves
 * the range was checked. Text citations and memory formation ranges do not. */
export function checkedMaintenanceRanges(state:State,book:Book,check=createPublishedViewCheck(state,book)){
 if(check.checkedRanges)return check.checkedRanges;
 // All candidates belong to this one synchronous permission/source check.
 // Reuse each graph verdict only here; the next call sees all in-place edits.
 // A later adopted-memory revision creates new work, without revoking an
 // earlier genuine review. Its actual publication/source permission still applies.
 const current=corePublishedViews(state,book,check),byKind:{overview:Range[];current:Range[]}={overview:[],current:[]};
 for(const u of state.usage){const d=u.maintenanceDispatch,task=u.requestKey&&ordinaryReadingTask(u.requestKey);if(!d||d.claim.viewReviewVersion!==1||u.status!=='complete'||u.modelOutcome||!task||task.bookId!==book.id||bookVersionPrefixLength(book,task.version)===undefined)continue;
  for(const fact of maintenanceProgressFacts(d)){
   const processed=fact.processed,reviewed=[...processed.ranges,...(processed.viewReviewRanges??[])];if(!reviewed.length||!reviewed.every(r=>bookVersionAllowsRanges(book,task.version,[r])))continue;
   for(const kind of ['overview','current'] as const){
    const view=fact.viewIds.map(id=>check.views.get(id)).find(view=>view?.kind===kind&&viewAllowed(state,book,view,new Set(),check.memo,check)&&current.some(live=>live.kind===kind&&(live.id===view.id||check.descends(live,view.id)))&&(processed.viewReviewRanges?.length||processed.viewTargets.some(t=>t===kind||t.startsWith('view:')&&check.views.get(t.slice(5))?.kind===kind)));
    if(view)byKind[kind].push(...intersectRanges(book.known,reviewed));
   }
  }
 }
 return check.checkedRanges={overview:mergeRanges(byKind.overview),current:mergeRanges(byKind.current),both:intersectRanges(byKind.overview,byKind.current)};
}
/** At chapter N, understood original text must cover the granted bodies through
 * N-2. Dispatch urgency only needs this progress, without checking view sources. */
export function readingUnderstandingProgress(book:Book,position=book.position){
 const chapters=authorizedChapterBodies(book),focus=chapterAt(book,Math.max(0,position-1)),at=chapters.findIndex(c=>c.chapter.index===focus.index),riskRanges=mergeRanges(chapters.slice(0,Math.max(0,at-1)).flatMap(c=>c.allowed)),nearRanges=mergeRanges(chapters.slice(0,Math.max(0,at)).flatMap(c=>c.allowed)),deepMissing=subtractRanges(riskRanges,book.prepared),nearDeepMissing=subtractRanges(nearRanges,book.prepared);
 return{chapter:at<0?undefined:at+1,riskRanges,nearRanges,authorizedRanges:mergeRanges(chapters.flatMap(c=>c.allowed)),deepMissing,nearDeepMissing,blocked:!!deepMissing.length,urgent:!!nearDeepMissing.length};
}
export function readingContinuity(state:State,book:Book,position=book.position,check=createPublishedViewCheck(state,book)){
 const {nearRanges,authorizedRanges,...progress}=readingUnderstandingProgress(book,position),checked=checkedMaintenanceRanges(state,book,check),viewMissing=subtractRanges(progress.riskRanges,checked.both),nearViewMissing=subtractRanges(nearRanges,checked.both),reviewRanges=subtractRanges(intersectRanges(authorizedRanges,book.prepared),checked.both);
 return{...progress,viewMissing,nearViewMissing,reviewRanges,overviewChecked:checked.overview,currentChecked:checked.current};
}
