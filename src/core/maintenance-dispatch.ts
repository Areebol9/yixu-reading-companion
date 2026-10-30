import {bookLength,covers,mergeRanges} from './books.ts';
import {chatAllowsMemory,isEvidenceAllowed} from './context.ts';
import {queryMaterialStamp} from './query-checkpoints.ts';
import {validateMaterialProjection} from './material-projection.ts';
import {validateTaskMaterialRef} from './storage-records.ts';
import {ReadingReferences} from './reading-references.ts';
import {publishedViewChecker} from './published-views.ts';
import {memoryReadableByPartner} from './book-document-ownership.ts';
import {linkDependencyProjectionOwners} from './dependency-nodes.ts';
import {ordinaryReadingTask,readingPayloadScheme,readingRequestPayloadHash} from './terminated-reading-continuation.ts';
import {hashText} from './text-hash.ts';
import type {MaintenanceDispatch,State,Usage} from './types.ts';
import {canonicalMaintenanceViewTargets} from './types.ts';
import {resolveBookVersion} from './book-versions.ts';
import {dependencyStampsEqual} from './dependency-chat-sources.ts';
import {maintenanceProgressFacts} from './maintenance-progress.ts';

export function maintenanceTaskCommitted(state:State,task:{bookId:string;version:string;partnerId:string;maintenanceJobId?:string;maintenanceClaim?:string}):boolean{
  return !!task.maintenanceJobId&&!!task.maintenanceClaim&&state.usage.some(usage=>{
    const d=usage.maintenanceDispatch,key=usage.requestKey&&ordinaryReadingTask(usage.requestKey);
    return !!d?.committed&&!!key&&key.bookId===task.bookId&&key.version===task.version&&key.partnerId===task.partnerId&&d.request.maintenanceJobId===task.maintenanceJobId&&d.claim.hash===task.maintenanceClaim;
  });
}

/** Dispatch identity is owned by its original usage, independently of later jobs. */
export function validateMaintenanceDispatchHeaders(state:State):void{
  for(const usage of state.usage){
    const d=usage.maintenanceDispatch;if(!d)continue;
    const task=usage.requestKey&&ordinaryReadingTask(usage.requestKey),key=usage.requestKey&&JSON.parse(usage.requestKey);
    if(!task||key.length!==8||key[5]!=='maintenance'||usage.questionId||usage.taskId||d.payloadScheme!==readingPayloadScheme||!/^[a-f0-9]{64}$/.test(d.payloadHash)||d.payloadHash!==usage.coreReadingPayload?.hash||usage.coreReadingPayload?.scheme!==d.payloadScheme||!d.request||d.request.source!=='reading'||typeof d.request.input!=='string'||d.request.maintenanceJobId!==key[6]||d.request.maintenanceClaim!==key[7]||JSON.stringify(d.request.ranges)!==JSON.stringify(key[4])||!d.claim||d.claim.hash!==key[7]||typeof d.dependencyStamp!=='string'||!d.dependencyStamp)throw Error('维护派发的原调用、请求或claim身份无效');
    const c=d.claim;
    if(c.viewReviewVersion!==undefined&&c.viewReviewVersion!==1)throw Error('维护概要检查合同无效');
    if(c.viewReviewRanges!==undefined&&(!Array.isArray(c.viewReviewRanges)||c.viewReviewRanges.some(r=>!r||!Number.isSafeInteger(r.start)||!Number.isSafeInteger(r.end)||r.start<0||r.end<=r.start)||JSON.stringify(c.viewReviewRanges)!==JSON.stringify(mergeRanges(c.viewReviewRanges))))throw Error('维护概要补核claim身份无效');
    if(c.sceneRecordIds!==undefined&&(!Array.isArray(c.sceneRecordIds)||new Set(c.sceneRecordIds).size!==c.sceneRecordIds.length||c.sceneRecordIds.some(id=>typeof id!=='string'||!id)))throw Error('维护现场成果claim身份无效');
    if(!Array.isArray(c.ranges)||c.ranges.some(r=>!r||!Number.isSafeInteger(r.start)||!Number.isSafeInteger(r.end)||r.start<0||r.end<=r.start||!covers(d.request.ranges,r))||JSON.stringify(c.ranges)!==JSON.stringify(mergeRanges(c.ranges))||!Array.isArray(c.chatIds)||new Set(c.chatIds).size!==c.chatIds.length||c.chatIds.some(id=>typeof id!=='string'||!id)||!Array.isArray(c.viewTargets)||JSON.stringify(c.viewTargets)!==JSON.stringify(canonicalMaintenanceViewTargets(c.viewTargets)))throw Error('维护派发的实际消费快照无效');
    if(d.materialRef)validateTaskMaterialRef(d.materialRef);
    if(!d.material&&!d.materialRef)throw Error('维护派发未保存实际材料');
    if(d.material&&(d.material.kind!=='maintenance-dispatch-v1'||!d.material.material||!Array.isArray(d.material.payload?.messages)||!Array.isArray(d.material.payload?.tools)))throw Error('维护派发材料载体无效');
    const ids=(value:unknown):value is string[]=>Array.isArray(value)&&new Set(value).size===value.length&&value.every(id=>typeof id==='string'&&!!id);
    if(d.progress!==undefined&&(!Array.isArray(d.progress)||new Set(d.progress.map(p=>p?.operationKey)).size!==d.progress.length))throw Error('维护部分提交的操作身份重复或无效');
    for(const progress of d.progress??[]){
      if(!progress||typeof progress.operationKey!=='string'||!progress.operationKey||!Number.isFinite(progress.at)||progress.at<0||!ids(progress.memoryIds)||!ids(progress.viewIds)||usage.status!=='complete'||usage.dispatchState!=='response-received'||usage.modelOutcome)throw Error('维护部分成果缺少完整原响应或真实操作身份');
      if(progress.memoryIds.some(id=>!state.memories.some(memory=>memory.id===id&&memory.bookId===task.bookId))||progress.viewIds.some(id=>!state.publishedViews?.some(view=>view.id===id&&view.bookId===task.bookId)))throw Error('维护部分成果没有对应的同书已保存文档或概要');
      if(progress.documents!==undefined&&(!Array.isArray(progress.documents)||new Set(progress.documents.map(doc=>doc?.index)).size!==progress.documents.length||progress.documents.some(doc=>!doc||!Number.isSafeInteger(doc.index)||doc.index<0||typeof doc.hash!=='string'||!/^[a-f0-9]{64}$/.test(doc.hash)||doc.memoryId!==undefined&&(!progress.memoryIds.includes(doc.memoryId)||!state.memories.some(memory=>memory.id===doc.memoryId)))))throw Error('维护已存文档的原候选索引或版本指纹无效');
      if(progress.views?.some(view=>!Number.isSafeInteger(view.index)||view.index<0||!/^[a-f0-9]{64}$/.test(view.hash)||!ids(view.viewIds)||view.viewIds.some(id=>!progress.viewIds.includes(id))))throw Error('维护已存概要的候选索引或版本指纹无效');
    }
    for(const fact of maintenanceProgressFacts(d)){
      const p=fact.processed,ranges=(value:unknown):value is import('./types.ts').Range[]=>Array.isArray(value)&&value.every(r=>r&&Number.isSafeInteger(r.start)&&Number.isSafeInteger(r.end)&&r.start>=0&&r.end>r.start);
      if(!p||!ranges(p.ranges)||p.ranges.some(r=>!covers(c.ranges,r))||!ids(p.chatIds)||p.chatIds.some(id=>!c.chatIds.includes(id))||!Array.isArray(p.viewTargets)||JSON.stringify(p.viewTargets)!==JSON.stringify(canonicalMaintenanceViewTargets(p.viewTargets))||p.viewTargets.some(target=>!c.viewTargets.includes(target)&&!(target.startsWith('view:')&&state.publishedViews?.some(view=>view.id===target.slice(5)&&view.bookId===task.bookId)))||p.sceneRecordIds!==undefined&&(!ids(p.sceneRecordIds)||p.sceneRecordIds.some(id=>!c.sceneRecordIds?.includes(id)))||p.viewReviewRanges!==undefined&&(!ranges(p.viewReviewRanges)||p.viewReviewRanges.some(r=>!covers([...c.ranges,...(c.viewReviewRanges??[])],r))))throw Error('维护实际消费子集超出原冻结任务或概要版本无效');
    }
    if(d.committed){
      const c=d.committed,ids=(value:unknown)=>Array.isArray(value)&&new Set(value).size===value.length&&value.every(id=>typeof id==='string'&&!!id);
      if(usage.status!=='complete'||usage.dispatchState!=='response-received'||usage.modelOutcome||!Number.isFinite(c.at)||c.at<0||!ids(c.memoryIds)||!ids(c.viewIds)||[c.draftId,c.readingId,c.publicationId].some(id=>id!==undefined&&(typeof id!=='string'||!id)))throw Error('维护派发的实际提交事实无效');
    }
  }
  for(const job of state.maintenanceJobs??[]){
    if(!job.pendingDispatch)continue;
    const usage=state.usage.find(u=>u.id===job.pendingDispatch!.usageId),key=usage?.requestKey&&ordinaryReadingTask(usage.requestKey);
    if(!usage?.maintenanceDispatch||usage.maintenanceDispatch.committed||!key||key.bookId!==job.bookId||key.version!==job.version||key.partnerId!==job.partnerId||usage.maintenanceDispatch.request.maintenanceJobId!==job.id)throw Error('维护owner的原派发指针无效');
  }
}

/** Full verification happens only for the active dispatch or explicit restoration. */
export async function validateMaintenanceDispatch(state:State,usage:Usage,usable=true):Promise<MaintenanceDispatch>{
  validateMaintenanceDispatchHeaders({...state,usage:[usage],maintenanceJobs:[]});
  const d=usage.maintenanceDispatch!,body=d.material;if(!body)throw Error('原维护材料尚未取回');
  if(await readingRequestPayloadHash(body.payload.messages,body.payload.tools)!==d.payloadHash)throw Error('原维护实际载体与派发Core指纹不符');
  if(await hashText(JSON.stringify([d.request.maintenanceJobId,d.claim.ranges,d.claim.chatIds,...(d.claim.viewTargets.length?[d.claim.viewTargets]:[]),...(d.claim.sceneRecordIds?.length?[{sceneRecordIds:d.claim.sceneRecordIds}]:[]),...(d.claim.viewReviewRanges?.length?[{viewReviewRanges:d.claim.viewReviewRanges}]:[]),...(d.claim.viewReviewVersion?[{viewReviewVersion:d.claim.viewReviewVersion}]:[])]))!==d.claim.hash)throw Error('原维护消费快照与claim指纹不符');
  const task=ordinaryReadingTask(usage.requestKey!)!,book=resolveBookVersion(state.books.find(b=>b.id===task.bookId),task.version),m=body.material;
  const job=state.maintenanceJobs?.find(job=>job.id===d.request.maintenanceJobId);
  if(job?.scope==='book'&&job.partnerId===task.partnerId&&state.partnerId!==task.partnerId){const source={...state,partnerId:task.partnerId};linkDependencyProjectionOwners(source,state);state=source;}
  if(usable&&(!book||task.partnerId!==state.partnerId)||m.taskRole!=='maintenance'||m.maintenanceJobId!==d.request.maintenanceJobId||m.readingStrategy!=='companion'||m.outputProtocol!=='reading-documents-v1'||JSON.stringify(m.ranges)!==JSON.stringify(d.request.ranges)||JSON.stringify(m.maintenanceViewTargets??[])!==JSON.stringify(d.claim.viewTargets)||JSON.stringify(m.sceneRecordIds??[])!==JSON.stringify(d.claim.sceneRecordIds??[])||JSON.stringify(m.maintenanceReviewRanges??[])!==JSON.stringify(d.claim.viewReviewRanges??[]))throw Error('原维护作品、伙伴或形成参数已变化');
  if(m.maintenanceReviewBatch!==undefined&&(m.maintenanceReviewBatch!==true||!Array.isArray(m.maintenanceReviewMemoryIds)||new Set(m.maintenanceReviewMemoryIds).size!==m.maintenanceReviewMemoryIds.length||m.maintenanceReviewMemoryIds.some(id=>typeof id!=='string'||!id)))throw Error('维护来源分批材料缺少准确版本集合');
  validateMaterialProjection({...state,partnerId:task.partnerId},{id:task.bookId,version:task.version},m,usable);
  if(!Array.isArray(m.refs)||!Array.isArray(m.originalRanges)||!Array.isArray(m.memoryIds)||!Array.isArray(m.chatIds)||!Array.isArray(m.habitIds)||!Array.isArray(m.passages)||!Array.isArray(m.messages)||m.messages.some(message=>message.role!=='user'||typeof message.content!=='string')||!Array.isArray(m.readUrls)||!Array.isArray(m.webSources)||!m.references||m.pendingHabits)throw Error('原维护的完整形成材料不齐');
  new ReadingReferences().restore(m.references);
  if(!usable)return d;
  if(!book)throw Error('原维护作品版本已不可恢复');
  if(d.claim.viewReviewRanges?.some(r=>!covers(book.known,r)||!covers(book.prepared,r)))throw Error('原概要补核许可或完整理解覆盖已变化');
  if(m.maintenanceReviewMemoryIds?.some(id=>!state.memories.some(memory=>memory.id===id&&memory.bookId===book.id&&memoryReadableByPartner(state,memory,task.partnerId)&&!memory.forgotten&&!memory.invalidatedBy&&isEvidenceAllowed(book,memory.evidence))))throw Error('原概要补核认识来源已失效');
  if(!isEvidenceAllowed(book,m.refs)||d.request.ranges.some(r=>!covers(book.known,r)||r.end>bookLength(book))||m.originalRanges.some(r=>!isEvidenceAllowed(book,[{...r,bookId:book.id,version:book.version}])))throw Error('原维护形成来源的许可已变化');
  if([...m.memoryIds,...(m.partialMemoryIds??[])].some(id=>!state.memories.some(memory=>memory.id===id&&memory.bookId===book.id&&memoryReadableByPartner(state,memory,task.partnerId)&&!memory.forgotten&&!memory.invalidatedBy&&isEvidenceAllowed(book,memory.evidence)))||m.chatIds.some(id=>!state.chats.some(chat=>chat.id===id&&chat.bookId===book.id&&!chat.excluded&&!chat.outdatedBy&&!chat.replacedBy&&chatAllowsMemory(state,chat)&&isEvidenceAllowed(book,chat.evidence)))||d.claim.chatIds.some(id=>!m.chatIds.includes(id)))throw Error('原维护取得的认识或交流来源已失效');
  const viewReadable=publishedViewChecker(state,book);
  if(m.viewIds?.some(id=>{const view=state.publishedViews?.find(v=>v.id===id);return !view||!viewReadable(view);})||!dependencyStampsEqual(state,m,queryMaterialStamp(state,m),d.dependencyStamp))throw Error('原维护材料的来源版本已经变化，不能套用当前资料');
  return d;
}
