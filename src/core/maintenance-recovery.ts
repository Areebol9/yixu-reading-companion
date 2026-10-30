import {mergeRanges,subtractRanges} from './books.ts';
import {currentPublishedViews,maintenanceViewTargetComplete,viewVersionUpdates} from './published-views.ts';
import {ordinaryReadingTask} from './terminated-reading-continuation.ts';
import type {MaintenanceJob,ModelReply,State,Usage} from './types.ts';
import {hashText} from './text-hash.ts';
import {maintenanceProcessed,maintenanceProgressFacts,maintenanceDocumentSources} from './maintenance-progress.ts';
import {maintenanceDeferredMemoryIds,maintenancePendingViewReview} from './reading-continuity.ts';

/** Identify the concrete writes before validating their old-version payload.
 * This is not a replacement parser: malformed candidates still go through the
 * ordinary acceptance path, and read-only historical bases need no new body. */
export function maintenanceWriteIntent(value:any,resolve:(id:string)=>string|undefined):{memoryIds:string[];workspace?:import('./types.ts').ReadingReply['workspace']}{
  if(!value||typeof value!=='object'||Array.isArray(value))return{memoryIds:[]};
  const workspace=value.workspace??Object.fromEntries(['understanding','working','focus'].filter(key=>value[key]!==undefined).map(key=>[key,value[key]]));
  // Navigation changes need their own concurrent-selection check, not another
  // body read. All actual merge/update targets do need version protection.
  const refs=[...(Array.isArray(value.documents)?value.documents:Array.isArray(value.thoughts)?value.thoughts:[]).flatMap((item:any)=>[item?.updates,...(Array.isArray(item?.mergePreviousIds)?item.mergePreviousIds:[])]),workspace?.understanding];
  return{memoryIds:[...new Set(refs.filter((id):id is string=>typeof id==='string').flatMap(id=>{const found=resolve(id);return found?[found]:[];}))],...(workspace&&Object.keys(workspace).length?{workspace}:{})};
}

/** Completed work belongs to the book/partner, not a particular queue item.
 * Frozen uncommitted requests keep their own recovery and fee obligations. */
export function remainingMaintenanceJob(state:State,job:MaintenanceJob):MaintenanceJob|undefined{
 if(job.dismissed)return job;
 const book=state.books.find(b=>b.id===job.bookId&&b.version===job.version);if(!book)return job;
 const commits=state.usage.flatMap(u=>{const d=u.maintenanceDispatch,k=u.requestKey&&ordinaryReadingTask(u.requestKey);return d&&maintenanceProgressFacts(d).length&&k&&k.bookId===job.bookId&&k.version===job.version&&(job.scope==='book'||k.partnerId===job.partnerId)?[d]:[];});
 const owned=commits.filter(d=>d.request.maintenanceJobId===job.id);
 const completedClaims=new Set(owned.filter(d=>d.committed).map(d=>d.claim.hash));
 const pointer=state.usage.find(u=>u.id===job.pendingDispatch?.usageId);
 // A view published by another owner cannot close an unknown/frozen dispatch.
 if(pointer?.maintenanceDispatch&&!pointer.maintenanceDispatch.committed&&!completedClaims.has(pointer.maintenanceDispatch.claim.hash))return job;
 const processed=new Map(commits.map(dispatch=>[dispatch,maintenanceProcessed(dispatch)]));
 const ranges=subtractRanges(job.ranges,commits.flatMap(d=>processed.get(d)!.ranges)),viewReviewRanges=subtractRanges(job.viewReviewRanges??[],commits.flatMap(d=>processed.get(d)!.viewReviewRanges??[]));
 const chatIds=job.chatIds.filter(id=>!commits.some(d=>processed.get(d)!.chatIds.includes(id))),sceneRecordIds=(job.sceneRecordIds??[]).filter(id=>!commits.some(d=>processed.get(d)!.sceneRecordIds?.includes(id)));
 const scoped={...state,partnerId:job.partnerId},published=job.viewTargets?.length?currentPublishedViews(scoped,book):[];
 const hasIncrement=!!(ranges.length||viewReviewRanges.length||chatIds.length||sceneRecordIds.length);
 const viewTargets=(job.viewTargets??[]).filter(t=>{
  if(maintenanceDeferredMemoryIds(scoped,book,job,[t]).length)return true;
  const pending=maintenancePendingViewReview(scoped,book,viewReviewRanges,[t]);if(pending.sourceRanges.length||pending.originalRanges.length)return true;
  if(maintenanceViewTargetComplete(scoped,book,t,published))return false;
  const completed=t.startsWith('view:')&&published.find(view=>view.id===t.slice(5)&&owned.some(d=>maintenanceProgressFacts(d).some(fact=>fact.viewIds.includes(view.id))));
  return hasIncrement||!completed||viewVersionUpdates(scoped,book,completed).length>0;
 });
 // Several settled HTTP attempts may share one frozen claim. A real final
 // receipt closes their partial progress without changing any old request.
 if(!ranges.length&&!viewReviewRanges.length&&!chatIds.length&&!sceneRecordIds.length&&!viewTargets.length)return owned.some(d=>!completedClaims.has(d.claim.hash))?job:undefined;
 if(JSON.stringify([ranges,viewReviewRanges,chatIds,sceneRecordIds,viewTargets])===JSON.stringify([job.ranges,job.viewReviewRanges??[],job.chatIds,job.sceneRecordIds??[],job.viewTargets??[]]))return job;
 // A dispatched, uncommitted claim stays frozen until its own candidate is resolved.
 return {...job,ranges,viewReviewRanges,chatIds,sceneRecordIds,viewTargets,pendingDispatch:undefined,draftId:undefined};
}

/** Reconcile duplicate unclaimed queues before choosing a chapter. Published
 * receipts keep their original identities; a frozen request is never merged. */
export function coalescePendingMaintenanceJobs(state:Pick<State,'usage'>,jobs:MaintenanceJob[]):MaintenanceJob[]{
 const result:MaintenanceJob[]=[],groups=new Map<string,number>();
 for(const job of jobs){
  const dispatch=job.pendingDispatch&&state.usage.find(u=>u.id===job.pendingDispatch!.usageId)?.maintenanceDispatch;
  if(job.dismissed||!job.origin||job.status!=='pending'||job.pendingDispatch&&!dispatch?.committed){result.push(job);continue;}
  const key=JSON.stringify([job.bookId,job.version,job.partnerId,job.origin,job.scope]),index=groups.get(key);
  if(index===undefined){groups.set(key,result.length);result.push(job);continue;}
  const prior=result[index],priorBound=maintenanceDocumentSources(state,prior.id).length>0,jobBound=maintenanceDocumentSources(state,job.id).length>0;
  // Receipts remain immutable and identify their original job. Never erase
  // either causal owner while both still carry their own deferred documents.
  if(priorBound&&jobBound){result.push(job);continue;}
  result[index]={...(jobBound?job:prior),createdAt:Math.min(prior.createdAt,job.createdAt),ranges:mergeRanges([...prior.ranges,...job.ranges]),viewReviewRanges:mergeRanges([...(prior.viewReviewRanges??[]),...(job.viewReviewRanges??[])]),chatIds:[...new Set([...prior.chatIds,...job.chatIds])],sceneRecordIds:[...new Set([...(prior.sceneRecordIds??[]),...(job.sceneRecordIds??[])])],viewTargets:[...new Set([...(prior.viewTargets??[]),...(job.viewTargets??[])])],pendingDispatch:undefined,draftId:undefined};
 }
 return result;
}
export const isSettledReadingLength=(usage:Usage)=>usage.status==='complete'&&usage.dispatchState==='response-received'&&usage.modelOutcome?.kind==='invalid-output'&&
 (usage.modelOutcome.feedbackReason==='reading-output-length'||usage.modelOutcome.reason==='模型输出达到长度上限，未执行不完整工具请求');
export type ReadingLengthRecoveryCheckpoint={version:'reading-length-recovery-v2';requestId:string;progressSignature:string;authorizationId:string};
export const READING_LENGTH_NO_PROGRESS='同一length故障没有新增有效材料、已保存成果或实际写目标变化，已停止该失败路径；原任务、原答和费用保留';
export const READING_SUBMISSION_NO_PROGRESS='同一提交错误在材料和有效成果未变化时再次发生，已停止无效重试；原候选、原答和费用保留';
/** Only host facts enter this digest. Reasoning and failed attempts are not work. */
export async function readingLengthRecoveryProgress(policy:{model:string;maxOutput:number},domainState:string):Promise<string>{
 const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value;
 let state:unknown=domainState;try{state=JSON.parse(domainState);}catch{}
 return hashText(JSON.stringify({version:'reading-length-recovery-v2',model:policy.model,maxOutput:policy.maxOutput,state:canonical(state)}));
}
export function readingLengthRecoveryCheckpoint(value:unknown):ReadingLengthRecoveryCheckpoint|undefined{
 const item=value as Partial<ReadingLengthRecoveryCheckpoint>|undefined;
 return item?.version==='reading-length-recovery-v2'&&typeof item.requestId==='string'&&!!item.requestId&&typeof item.progressSignature==='string'&&/^[a-f0-9]{64}$/.test(item.progressSignature)&&typeof item.authorizationId==='string'&&!!item.authorizationId?item as ReadingLengthRecoveryCheckpoint:undefined;
}
export function readingLengthFeedback(_policy:{model:string;maxOutput:number},response?:ModelReply&{requestId?:string},checkpoint?:ReadingLengthRecoveryCheckpoint){
 // The assembler removes truncated calls. Preserve their exact arguments only as
 // non-executable evidence; text/reasoning already retained in native history stay there.
 const terminal=response?.rawTerminal,calls=terminal?.message.tool_calls;
 const unexecutedCandidates=Array.isArray(calls)?calls.flatMap((call,index)=>{
  if(!call||typeof call!=='object'||!call.function||typeof call.function!=='object')return[];
  const fn=call.function;if(typeof fn.arguments!=='string')return[];
  let parametersParseError:string|undefined;try{JSON.parse(fn.arguments);}catch(error){parametersParseError=(error as Error).message;}
  return[{index,...(typeof call.id==='string'?{id:call.id}:{}),...(typeof fn.name==='string'?{name:fn.name}:{}),arguments:fn.arguments,...(parametersParseError?{parametersParseError}:{})}];
 }):[];
 return{accepted:false,reason:'reading-output-length',partialRetained:!!terminal,
  ...(response?.requestId?{originalRequestId:response.requestId}:{}),...(checkpoint?{lengthRecovery:checkpoint}:{}),
  ...(unexecutedCandidates.length?{unexecutedCandidates,executable:false}:{}),
  instruction:'原调用已结算并因finish_reason=length停止，截断工具均未执行。沿原任务和已有材料继续，必要变化可局部修订或引用已存候选；思考与提交共享输出预算。'+(unexecutedCandidates.length?'unexecutedCandidates是原参数片段，只供核对和重新形成完整请求，不能执行或视作已提交。':terminal?'本次没有可续用的工具参数；原文本和必需思考留在原生历史。':'旧版本未保存截断载体，不能伪造或拼接原答。')};
}
