import {hashText} from './text-hash.ts';
import {id,mergeRanges,subtractRanges,covers,bookLength} from './books.ts';
import {chatAllowsMemory,isEvidenceAllowed} from './context.ts';
import {memoryContentIdentity,prepareMemoryIdentities} from './memory-identity.ts';
import type {Book,Memory,PublishedView,Range,State,ViewProposal,ViewPublication} from './types.ts';
import {canonicalMaintenanceViewTargets,isMaintenanceViewTarget} from './types.ts';

export const viewProposalSchema={type:'array',items:{type:'object',properties:{operation:{type:'string',enum:['publish','keep']},kind:{type:'string',enum:['overview','current','topic','arc']},key:{type:'string',minLength:1,maxLength:100},text:{type:'string',minLength:1,maxLength:1800},sourceMemoryIds:{type:'array',minItems:0,items:{type:'string'}},sourceIds:{type:'array',items:{type:'string',pattern:'^p[1-9][0-9]*$'}},chatIds:{type:'array',items:{type:'string'}},sourceViewIds:{type:'array',items:{type:'string'}},mergePreviousIds:{type:'array',minItems:1,items:{type:'string'},description:'仅overview/current归并额外旧头；主前继仍填previousId并保持其key。额外前继必须本轮实际取得全文、同kind、同时列入sourceViewIds；只退役明确合并的旧发布头。'},previousId:{type:'string',description:'承接已给原概要v编号。其采用m在本包变为tN时，即使保留正文也须填写对应v，并在sourceMemoryIds采用新tN；keep另以sourceViewIds继承原v。'}},required:['kind','key','sourceMemoryIds'],allOf:[{anyOf:[{properties:{sourceMemoryIds:{minItems:1}}},{required:['sourceIds'],properties:{sourceIds:{minItems:1}}},{required:['chatIds'],properties:{chatIds:{minItems:1}}},{required:['sourceViewIds'],properties:{sourceViewIds:{minItems:1}}}]},{oneOf:[{required:['operation','previousId','sourceViewIds'],properties:{operation:{const:'keep'}},not:{required:['text']},anyOf:[{properties:{sourceMemoryIds:{minItems:1}}},{required:['sourceIds'],properties:{sourceIds:{minItems:1}}},{required:['chatIds'],properties:{chatIds:{minItems:1}}}]},{required:['text'],not:{required:['operation'],properties:{operation:{const:'keep'}}}}]}],additionalProperties:false}};
export function parseViewProposals(value:unknown):ViewProposal[]|undefined{
  if(value===undefined)return;if(!Array.isArray(value))throw Error('views须为派生视图数组');
  const keys=new Set<string>();return value.map((v:ViewProposal)=>{
    if(!v||typeof v!=='object'||Object.keys(v).some(k=>!['operation','kind','key','text','sourceMemoryIds','sourceViewIds','previousId','mergePreviousIds','sourceIds','chatIds'].includes(k))||!['overview','current','topic','arc'].includes(v.kind)||typeof v.key!=='string'||!v.key.trim()||v.key.length>100||v.operation!==undefined&&!['publish','keep'].includes(v.operation))throw Error('派生视图类型或作用域无效');
    if(v.operation==='keep'?(!v.previousId||v.text!==undefined):typeof v.text!=='string'||!v.text.trim()||v.text.length>1800)throw Error('publish须有完整简明text；keep须有previousId且不重写text');
    if(v.mergePreviousIds!==undefined&&(!['overview','current'].includes(v.kind)||!v.previousId||!Array.isArray(v.mergePreviousIds)||!v.mergePreviousIds.length||v.mergePreviousIds.some(id=>typeof id!=='string'||!id||id===v.previousId||!v.sourceViewIds?.includes(id))))throw Error('核心概要归并须主previousId及额外mergePreviousIds，额外前继须同时明确列入sourceViewIds');
    if(!Array.isArray(v.sourceMemoryIds)||v.sourceMemoryIds.some(x=>typeof x!=='string'||!x)||v.sourceViewIds!==undefined&&(!Array.isArray(v.sourceViewIds)||v.sourceViewIds.some(x=>typeof x!=='string'||!x)))throw Error('视图须绑定实际来源，旧视图仅为派生输入');
    if(v.sourceIds!==undefined&&(!Array.isArray(v.sourceIds)||v.sourceIds.some(id=>typeof id!=='string'||!/^p[1-9]\d*$/.test(id)))||v.chatIds!==undefined&&(!Array.isArray(v.chatIds)||v.chatIds.some(id=>typeof id!=='string'||!id)))throw Error('视图原文或真实交流来源无效');
    if(!v.sourceMemoryIds.length&&!v.sourceViewIds?.length&&!v.sourceIds?.length&&!v.chatIds?.length)throw Error('派生视图须采用本次实际取得的来源');
    const key=v.kind+':'+v.key;if(keys.has(key))throw Error('同一次发布不能重复同类视图作用域');keys.add(key);return{...structuredClone(v),sourceMemoryIds:[...new Set(v.sourceMemoryIds)],...(v.sourceIds?{sourceIds:[...new Set(v.sourceIds)]}:{}),...(v.chatIds?{chatIds:[...new Set(v.chatIds)]}:{}),...(v.sourceViewIds?{sourceViewIds:[...new Set(v.sourceViewIds)]}:{}),...(v.mergePreviousIds?{mergePreviousIds:[...new Set(v.mergePreviousIds)]}:{})};
  });
}
export function validatePublishedViews(state:State):void{
  for(const name of ['publishedViews','viewPublications','maintenanceJobs'] as const)if(state[name]!==undefined&&!Array.isArray(state[name]))throw Error('派生视图或维护集合无效');
  const ids=new Set<string>();
  for(const v of state.publishedViews??[]){
    const book=state.books.find(b=>b.id===v.bookId);
    if(!book||book.version!==v.version||!state.partners.some(p=>p.id===v.partnerId)||typeof v.id!=='string'||!v.id||ids.has(v.id)||!['overview','current','topic','arc'].includes(v.kind)||typeof v.key!=='string'||!v.key||typeof v.text!=='string'||!v.text.trim()||v.text.length>1800||!Array.isArray(v.memorySources)||!Array.isArray(v.originalSources)||!Array.isArray(v.viewSources)||!Array.isArray(v.ranges)||!Array.isArray(v.chatIds)||!Array.isArray(v.evidence)||!Array.isArray(v.contextChatIds))throw Error('已发布派生视图的版本、范围或来源无效');
    ids.add(v.id);
    const validRange=(r:Range)=>r&&Number.isSafeInteger(r.start)&&Number.isSafeInteger(r.end)&&r.start>=0&&r.end>r.start&&r.end<=bookLength(book);
    if(v.ranges.some(r=>!validRange(r)||!covers(v.evidence,r))||v.evidence.some(e=>!validRange(e)||e.bookId!==book.id||e.version!==book.version)||v.chatIds.some(id=>!v.contextChatIds.includes(id))||v.contextChatIds.some(id=>!state.chats.some(c=>c.id===id&&c.bookId===book.id)))throw Error('视图覆盖或交流范围不属于形成来源');
    for(const s of v.memorySources)if(!state.memories.some(m=>m.id===s.id&&m.bookId===v.bookId&&m.partnerId===v.partnerId)||!/^[a-f0-9]{64}$/.test(s.hash))throw Error('派生视图认识来源身份无效');
    if(v.adoptedMemorySources!==undefined){
      if(!Array.isArray(v.adoptedMemorySources)||new Set(v.adoptedMemorySources.map(source=>source?.id)).size!==v.adoptedMemorySources.length)throw Error('视图明确采用的完整认识版本无效');
      for(const source of v.adoptedMemorySources){
        if(!source||typeof source.id!=='string'||!/^[a-f0-9]{64}$/.test(source.hash))throw Error('视图明确采用的完整认识版本无效');
        const directlyProvided=v.memorySources.some(provided=>provided.id===source.id&&provided.hash===source.hash);
        const inherited=v.viewSources.some(id=>state.publishedViews?.some(parent=>parent.id===id&&parent.adoptedMemorySources?.some(adopted=>adopted.id===source.id&&adopted.hash===source.hash)));
        if(!directlyProvided&&!inherited)throw Error('视图明确采用的完整认识版本不属于实际来源');
      }
    }
    for(const s of v.originalSources)if(s.evidence.bookId!==book.id||s.evidence.version!==book.version||!/^[a-f0-9]{64}$/.test(s.hash)||s.evidence.start<0||s.evidence.end<=s.evidence.start||s.evidence.end>(book.textLength??book.text.length))throw Error('派生视图原文来源无效');
  }
  for(const v of state.publishedViews??[]){
    if(v.viewSources.some(id=>!ids.has(id))||v.previousId&&!ids.has(v.previousId))throw Error('派生视图历史身份缺失');
    if(v.mergePreviousIds!==undefined&&(!Array.isArray(v.mergePreviousIds)||!v.mergePreviousIds.length||new Set(v.mergePreviousIds).size!==v.mergePreviousIds.length||!v.mergePreviousIds.every(id=>typeof id==='string'&&ids.has(id))||!viewLineage(state,v)))throw Error('核心概要明确归并前继或祖先链无效');
  }
  for(const p of state.viewPublications??[])if(!state.books.some(b=>b.id===p.bookId&&b.version===p.version)||p.id!==JSON.stringify([p.bookId,p.version,p.partnerId])||!Number.isSafeInteger(p.revision)||p.revision<1||!Array.isArray(p.viewIds)||p.viewIds.some(id=>!state.publishedViews?.some(v=>v.id===id&&v.bookId===p.bookId&&v.version===p.version&&v.partnerId===p.partnerId)))throw Error('视图发布清单无效');
  const jobs=new Set<string>();for(const j of state.maintenanceJobs??[]){if(j.viewReviewRanges!==undefined&&(!Array.isArray(j.viewReviewRanges)||JSON.stringify(j.viewReviewRanges)!==JSON.stringify(mergeRanges(j.viewReviewRanges))||j.viewReviewRanges.some(r=>!Number.isSafeInteger(r.start)||!Number.isSafeInteger(r.end)||r.start<0||r.end<=r.start)))throw Error('维护概要补核范围无效');if(j.sceneRecordIds!==undefined&&(!Array.isArray(j.sceneRecordIds)||new Set(j.sceneRecordIds).size!==j.sceneRecordIds.length||j.sceneRecordIds.some(id=>typeof id!=='string'||!id)))throw Error('维护现场成果引用无效');if(!state.books.some(b=>b.id===j.bookId&&b.version===j.version)||typeof j.id!=='string'||!j.id||jobs.has(j.id)||!['pending','running','blocked'].includes(j.status)||!Array.isArray(j.ranges)||!Array.isArray(j.chatIds)||j.viewTargets!==undefined&&(!Array.isArray(j.viewTargets)||JSON.stringify(j.viewTargets)!==JSON.stringify(canonicalMaintenanceViewTargets(j.viewTargets))||j.viewTargets.some(target=>!isMaintenanceViewTarget(target)||target.startsWith('view:')&&!state.publishedViews?.some(view=>view.id===target.slice(5)&&view.bookId===j.bookId&&view.version===j.version&&view.partnerId===j.partnerId))))throw Error('持续认识维护记录无效');jobs.add(j.id);}
}
export function publicationId(book:Book,partnerId:string):string{return JSON.stringify([book.id,book.version,partnerId]);}
export function viewAllowed(state:State,book:Book,view:PublishedView,seen=new Set<string>(),memo=new Map<string,boolean>()):boolean{
  if(memo.has(view.id))return memo.get(view.id)!;
  if(view.bookId!==book.id||view.version!==book.version||view.partnerId!==state.partnerId||seen.has(view.id)||!isEvidenceAllowed(book,view.evidence))return false;
  seen.add(view.id);
  const valid=view.memorySources.every(s=>{const m=state.memories.find(m=>m.id===s.id);if(!m||m.forgotten||m.invalidatedBy||m.bookId!==book.id||m.partnerId!==view.partnerId||!isEvidenceAllowed(book,m.evidence))return false;try{return memoryContentIdentity(m).hash===s.hash;}catch{return false;}})&&view.contextChatIds.every(id=>{const c=state.chats.find(c=>c.id===id);return!!c&&chatAllowsMemory(state,c)&&!c.excluded&&!c.outdatedBy&&!c.replacedBy&&c.bookId===book.id&&isEvidenceAllowed(book,c.evidence);})&&view.viewSources.every(id=>{const source=state.publishedViews?.find(v=>v.id===id);return!!source&&viewAllowed(state,book,source,new Set(seen),memo);});
  memo.set(view.id,valid);return valid;
}
export function currentPublishedViews(state:State,book:Book):PublishedView[]{
  const p=state.viewPublications?.find(p=>p.id===publicationId(book,state.partnerId));
  const memo=new Map<string,boolean>();return(p?.viewIds??[]).map(id=>state.publishedViews?.find(v=>v.id===id)).filter((v):v is PublishedView=>!!v&&viewAllowed(state,book,v,new Set(),memo));
}
/** Core projections are book-wide responsibilities. Multiple live roots are
 * unresolved legacy branches, never separate topics selected by recency. */
export function coreViewHeads(state:State,book:Book):PublishedView[]{return currentPublishedViews(state,book).filter(view=>view.kind==='overview'||view.kind==='current');}
/** Only explicit succession/merge edges carry responsibility. General supplied
 * viewSources are exposure, never proof that another projection was merged. */
function viewLineage(state:State,view:PublishedView):Set<string>|undefined{
 const ancestors=new Set<string>(),active=new Set<string>();
 const visit=(node:PublishedView):boolean=>{
  if(active.has(node.id))return false;if(ancestors.has(node.id))return true;
  active.add(node.id);
  for(const [parentId,merge] of [...(node.previousId?[[node.previousId,false] as const]:[]),...(node.mergePreviousIds??[]).map(id=>[id,true] as const)]){
   const parent=state.publishedViews?.find(v=>v.id===parentId);
   if(!parent||parent.bookId!==node.bookId||parent.version!==node.version||parent.partnerId!==node.partnerId||parent.kind!==node.kind||(!merge&&parent.key!==node.key)||(merge&&(!['overview','current'].includes(node.kind)||!node.previousId||parentId===node.previousId||!node.viewSources.includes(parentId)))||!visit(parent))return false;
  }
  active.delete(node.id);ancestors.add(node.id);return true;
 };
 return visit(view)?ancestors:undefined;
}
export function viewDescendsFrom(state:State,view:PublishedView,ancestorId:string):boolean{return view.id!==ancestorId&&!!viewLineage(state,view)?.has(ancestorId);}
/** Recovery may merge confirmed repeated initialization of the same core
 * responsibility, not arbitrary similarly named projections. */
export function coreViewMergeGroups(state:State,book:Book){
 const heads=coreViewHeads(state,book);
 return(['overview','current'] as const).flatMap(kind=>{
  const group=heads.filter(view=>view.kind===kind);if(group.length<2)return[];
  const roots=state.usage.flatMap(usage=>{const dispatch=usage.maintenanceDispatch;return usage.status==='complete'&&!usage.modelOutcome&&dispatch?.committed&&dispatch.claim.viewTargets.includes(kind)?dispatch.committed.viewIds.flatMap(id=>{const view=state.publishedViews?.find(v=>v.id===id&&v.bookId===book.id&&v.version===book.version&&v.partnerId===state.partnerId&&v.kind===kind&&!v.previousId);return view?[view]:[];}):[];});
  const proven=group.filter(head=>roots.some(root=>root.id===head.id||viewDescendsFrom(state,head,root.id)));return proven.length>1?[{kind,heads:proven}]:[];
 });
}
export function resolveMaintenanceViewTargets(state:State,book:Book,targets:readonly import('./types.ts').MaintenanceViewTarget[]):import('./types.ts').MaintenanceViewTarget[]{
 const published=currentPublishedViews(state,book);
 return canonicalMaintenanceViewTargets(targets.flatMap(target=>{
  const successors=target.startsWith('view:')?published.filter(view=>view.id===target.slice(5)||viewDescendsFrom(state,view,target.slice(5))):published.filter(view=>view.kind===target);
  return successors.length?successors.map(view=>('view:'+view.id) as import('./types.ts').MaintenanceViewTarget):[target];
 }));
}
/** Explicit adoption is the version-check fact; exposure remains the permission fence. */
export function viewVersionUpdates(state:State,book:Book,view:PublishedView):{previousId:string;currentId:string}[]{
  if(!viewAllowed(state,book,view))return [];
  const adopted=view.adoptedMemorySources??[],updates=new Map<string,{previousId:string;currentId:string}>();
  for(const source of adopted){
    let memory=state.memories.find(m=>m.id===source.id),seen=new Set<string>();if(!memory||memoryContentIdentity(memory).hash!==source.hash)continue;
    while(memory.replacedBy){
      if(seen.has(memory.id))break;seen.add(memory.id);
      const next:Memory|undefined=state.memories.find(m=>m.id===memory!.replacedBy);
      if(!next||next.revisionKind!=='development'||next.forgotten||next.invalidatedBy||next.reviewDisposition==='unsupported'||next.bookId!==view.bookId||next.partnerId!==view.partnerId||!isEvidenceAllowed(book,next.evidence))break;
      memory=next;
    }
    if(memory.id!==source.id&&!adopted.some(s=>s.id===memory!.id&&s.hash===memoryContentIdentity(memory!).hash))updates.set(memory.id,{previousId:source.id,currentId:memory.id});
  }
  return [...updates.values()];
}
export function maintenanceViewTargetStatus(state:State,book:Book,target:import('./types.ts').MaintenanceViewTarget,added:PublishedView[]){
  if(!target.startsWith('view:')){const complete=added.some(view=>view.kind===target);return{complete,scopeMatched:complete,previousIdMatched:complete,missingMemoryIds:[] as string[]};}
  const old=state.publishedViews?.find(view=>view.id===target.slice(5));if(!old)return{complete:false,scopeMatched:false,previousIdMatched:false,missingMemoryIds:[] as string[]};
  const updates=viewVersionUpdates(state,book,old);
  const candidates=added.filter(view=>view.kind===old.kind&&(view.key===old.key||viewDescendsFrom(state,view,old.id))).map(view=>{
    const missingMemoryIds=updates.filter(update=>{const memory=state.memories.find(m=>m.id===update.currentId)!;return!view.adoptedMemorySources?.some(source=>source.id===memory.id&&source.hash===memoryContentIdentity(memory).hash);}).map(update=>update.currentId);
    const previousIdMatched=viewDescendsFrom(state,view,old.id);return{complete:previousIdMatched&&!missingMemoryIds.length,scopeMatched:true,previousIdMatched,missingMemoryIds};
  });
  return candidates.find(candidate=>candidate.complete)??candidates.sort((a,b)=>(Number(!a.previousIdMatched)+a.missingMemoryIds.length)-(Number(!b.previousIdMatched)+b.missingMemoryIds.length))[0]??{complete:false,scopeMatched:false,previousIdMatched:false,missingMemoryIds:updates.map(update=>update.currentId)};
}
export function maintenanceViewTargetComplete(state:State,book:Book,target:import('./types.ts').MaintenanceViewTarget,added:PublishedView[]):boolean{return maintenanceViewTargetStatus(state,book,target,added).complete;}
export function viewMaintenanceTargets(state:State,book:Book):import('./types.ts').MaintenanceViewTarget[]{return canonicalMaintenanceViewTargets(currentPublishedViews(state,book).filter(view=>viewVersionUpdates(state,book,view).length).map(view=>`view:${view.id}` as const));}
/** Views newly affected by this plan, including a view that was already behind
 * and whose current successor is being revised again. Historical unrelated debt
 * stays with its own future claim. */
export function affectedMaintenanceViewTargets(state:State,book:Book,developments:readonly {previousId:string;nextId:string}[]){
  const changed=new Set(developments.map(d=>d.previousId));
  return canonicalMaintenanceViewTargets(currentPublishedViews(state,book).filter(view=>(view.adoptedMemorySources??[]).some(source=>changed.has(source.id))||viewVersionUpdates(state,book,view).some(update=>changed.has(update.currentId))).map(view=>('view:'+view.id) as import('./types.ts').MaintenanceViewTarget));
}
export function maintenanceProgress(state:State,book:Book):import('./types.ts').MaintenanceProgress{
  const size=(ranges:Range[])=>mergeRanges(ranges).reduce((n,r)=>n+r.end-r.start,0),jobs=(state.maintenanceJobs??[]).filter(j=>j.bookId===book.id&&j.version===book.version&&j.partnerId===state.partnerId),missing=subtractRanges(book.known,book.prepared),intersect=(ranges:Range[])=>mergeRanges(missing.flatMap(r=>ranges.flatMap(w=>{const start=Math.max(r.start,w.start),end=Math.min(r.end,w.end);return end>start?[{start,end}]:[];}))),working=intersect(jobs.filter(j=>j.status==='running').flatMap(j=>state.usage.find(u=>u.id===j.pendingDispatch?.usageId)?.maintenanceDispatch?.claim.ranges??[])),blocked=intersect(jobs.filter(j=>j.status==='blocked').flatMap(j=>j.ranges)),queued=subtractRanges(intersect(jobs.flatMap(j=>j.ranges)),[...working,...blocked]);
  return{bookId:book.id,knownChars:size(book.known),preparedChars:size(subtractRanges(book.known,missing)),missingChars:size(missing),workingChars:size(working),queuedChars:size(queued),blockedChars:size(blocked),overviewPending:resolveMaintenanceViewTargets(state,book,[...viewMaintenanceTargets(state,book),...jobs.flatMap(j=>j.viewTargets??[])]).length,blockedJobs:jobs.filter(j=>j.status==='blocked').length,queuedJobs:jobs.filter(j=>j.status==='pending').length,workingJobs:jobs.filter(j=>j.status==='running').length};
}
export function viewProgress(state:State,book:Book){
  const views=currentPublishedViews(state,book),coverage=mergeRanges(views.flatMap(v=>v.ranges));
  return{views:views.map(v=>({id:v.id,kind:v.kind,key:v.key,text:v.text,ranges:v.ranges,chatIds:v.chatIds,createdAt:v.createdAt,lagging:!!viewVersionUpdates(state,book,v).length,adoptedMemories:v.adoptedMemorySources?.map(source=>{const memory=state.memories.find(m=>m.id===source.id)!;return{id:source.id,hash:source.hash,title:memory.documentTitle,formationRanges:memory.readingStage??[]};})})),coveredRanges:coverage,uncheckedRanges:subtractRanges(book.known,coverage),unabsorbedChatIds:state.chats.filter(c=>c.bookId===book.id&&chatAllowsMemory(state,c)&&!c.excluded&&!c.outdatedBy&&!c.replacedBy&&isEvidenceAllowed(book,c.evidence)&&!views.some(v=>v.chatIds.includes(c.id))).map(c=>c.id),maintenance:(state.maintenanceJobs??[]).filter(j=>j.bookId===book.id&&j.version===book.version&&j.partnerId===state.partnerId).map(j=>({id:j.id,status:j.status,ranges:j.ranges,chatIds:j.chatIds,viewTargets:j.viewTargets,targetLabels:j.viewTargets?.map(target=>{const view=target.startsWith('view:')?state.publishedViews?.find(v=>v.id===target.slice(5)):undefined;return{kind:view?.kind??target as 'overview'|'current',key:view?.key};}),reason:j.reason}))};
}
export async function planPublishedViews(state:State,book:Book,proposals:ViewProposal[]|undefined,memories:Memory[],viewIds:string[],chatIds:string[],passages:Map<string,NonNullable<Memory['sourceQuote']>>,exposure:import('./types.ts').Evidence[],lineage?:{memoryIds:string[];chatIds:string[];evidence:import('./types.ts').Evidence[];reviewMemoryIds?:string[];submittedMemoryIds?:string[]}):Promise<{added:PublishedView[];publication?:ViewPublication}>{
  if(!proposals?.length)return{added:[]};
  if([...chatIds,...(lineage?.chatIds??[])].some(id=>{const chat=state.chats.find(c=>c.id===id);return !chat||!chatAllowsMemory(state,chat);}))throw Error('视图形成的交流来源未允许后续采用');
  const added:PublishedView[]=[],prior=state.viewPublications?.find(p=>p.id===publicationId(book,state.partnerId)),ids=[...(prior?.viewIds??[])];
  for(const proposal of proposals){
    const old=proposal.previousId?state.publishedViews?.find(v=>v.id===proposal.previousId&&viewIds.includes(v.id)&&viewAllowed(state,book,v)):undefined;
    if(proposal.previousId&&!old||proposal.operation==='keep'&&!old||old&&(old.kind!==proposal.kind||old.key!==proposal.key))throw Error('视图previousId不属于本次实际提供的同一作用域');
    const merging=(proposal.mergePreviousIds??[]).map(id=>state.publishedViews?.find(v=>v.id===id&&viewIds.includes(id)&&viewAllowed(state,book,v)));
    if(merging.length&&(!old||!['overview','current'].includes(proposal.kind)||merging.some(v=>!v||v.kind!==proposal.kind||v.id===old.id||!proposal.sourceViewIds?.includes(v.id))))throw Error('mergePreviousIds须逐一绑定本包实际取得全文且明确sourceViewIds采用的同类额外概要');
    const heads=currentPublishedViews(state,book).filter(v=>v.kind===proposal.kind),core=proposal.kind==='overview'||proposal.kind==='current';
    if(core&&heads.length&&(!old||!heads.some(v=>v.id===old.id)))throw Error('已有核心概要，须以本轮实际提供的当前头填写previousId并保持其key；不得重新初始化或承接过时头');
    const mergeGroup=core?coreViewMergeGroups(state,book).find(group=>group.kind===proposal.kind&&group.heads.some(head=>head.id===old?.id)):undefined;
    if(merging.length&&(!mergeGroup||merging.some(view=>!mergeGroup.heads.some(head=>head.id===view!.id))))throw Error('只能明确归并已核同职责初始化来源的分叉组；其它作用域保持原发布头');
    if(mergeGroup&&mergeGroup.heads.some(head=>head.id!==old?.id&&!merging.some(v=>v!.id===head.id)))throw Error('核心概要存在多个待归并头；须实际取得该初始化分叉组全部头，以previousId承接主头，其余填mergePreviousIds并同时列入sourceViewIds，不能分别更新后继续保留分叉');
    if(mergeGroup&&added.some(view=>mergeGroup.heads.some(head=>viewDescendsFrom(state,view,head.id))))throw Error('同次初始化分叉组只提交一份有据归并后继');
    if(!core&&heads.some(v=>v.key===proposal.key&&v.id!==old?.id))throw Error('同一概要作用域已有发布头，须取得其全文并以previousId承接，不能无前继断链覆盖');
    const sources=proposal.sourceMemoryIds.map(id=>memories.find(m=>m.id===id));if(sources.some(m=>!m||m.forgotten||m.invalidatedBy||!isEvidenceAllowed(book,m.evidence)))throw Error('视图引用的认识版本未实际取得或不合法');
    const inherited=(proposal.sourceViewIds??[]).map(id=>state.publishedViews?.find(v=>v.id===id&&viewIds.includes(id)&&viewAllowed(state,book,v)));if(inherited.some(v=>!v))throw Error('视图只能继承本次实际提供的有效派生视图');
    if(proposal.operation==='keep'&&!proposal.sourceViewIds?.includes(old!.id))throw Error('keep须明确继承已核对的原视图，previousId本身不授来源资格');
    const parents=inherited as PublishedView[];const originals=(proposal.sourceIds??[]).map(id=>passages.get(id));if(originals.some(p=>!p))throw Error('视图原文p编号未实际提供');const updates=old?viewVersionUpdates(state,book,old):[];const checkedVersion=sources.some(memory=>updates.some(update=>update.currentId===memory!.id)||memory!.revisionKind==='development'&&[...(old?.adoptedMemorySources??[]).map(source=>source.id),...updates.map(update=>update.currentId)].includes(memory!.correctionOf??''));if(proposal.operation==='keep'&&!originals.length&&!proposal.chatIds?.length&&!checkedVersion&&!sources.some(m=>lineage?.reviewMemoryIds?.includes(m!.id)||lineage?.submittedMemoryIds?.includes(m!.id)))throw Error('keep须实际核对新原文、真实交流或旧视图待核对的新完整认识版本');const checkedChats=(proposal.chatIds??[]);if(checkedChats.some(id=>!chatIds.includes(id)))throw Error('视图交流编号未实际提供');
    const dependencies=[...new Map([...memories,...state.memories.filter(m=>lineage?.memoryIds.includes(m.id))].map(m=>[m.id,m])).values()];await prepareMemoryIdentities(dependencies);
    const adoptedMemorySources=[...new Map([...sources.map(m=>({id:m!.id,hash:memoryContentIdentity(m!).hash})),...parents.flatMap(v=>v.adoptedMemorySources??[])].map(source=>[source.id,source])).values()];
    const view:PublishedView={id:id(),bookId:book.id,version:book.version,partnerId:state.partnerId,kind:proposal.kind,key:proposal.key,text:proposal.operation==='keep'?old!.text:proposal.text!,createdAt:Date.now(),...(old?{previousId:old.id}:{}),...(merging.length?{mergePreviousIds:merging.map(v=>v!.id)}:{}),memorySources:dependencies.map(m=>({id:m.id,hash:memoryContentIdentity(m).hash})),originalSources:await Promise.all(originals.map(async p=>({evidence:{...p!.evidence},hash:await hashText(p!.text)}))),viewSources:[...new Set(viewIds)],evidence:mergeRanges([...exposure,...(lineage?.evidence??[]),...dependencies.flatMap(m=>m.evidence),...parents.flatMap(v=>v.evidence)]).map(r=>({...r,bookId:book.id,version:book.version})),contextChatIds:[...new Set([...chatIds,...(lineage?.chatIds??[]),...parents.flatMap(v=>v.contextChatIds)])],ranges:mergeRanges([...originals.map(p=>p!.evidence),...parents.flatMap(v=>v.ranges)]),chatIds:[...new Set([...checkedChats,...parents.flatMap(v=>v.chatIds)])]};
    view.adoptedMemorySources=adoptedMemorySources;
    // Updating one projection does not claim other topics were revisited.
    for(let i=ids.length-1;i>=0;i--){const existing=state.publishedViews?.find(v=>v.id===ids[i]);if(existing&&viewDescendsFrom(state,view,existing.id))ids.splice(i,1);}ids.push(view.id);added.push(view);
  }
  return{added,publication:{id:publicationId(book,state.partnerId),bookId:book.id,version:book.version,partnerId:state.partnerId,revision:(prior?.revision??0)+1,viewIds:ids}};
}
