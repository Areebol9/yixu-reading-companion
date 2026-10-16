import {subtractRanges} from './books.ts';
import {currentPublishedViews,maintenanceViewTargetComplete} from './published-views.ts';
import {ordinaryReadingTask} from './terminated-reading-continuation.ts';
import type {MaintenanceJob,ModelMessage,ModelReply,State,Usage} from './types.ts';

/** A committed owner retires work, never settles an ancestor's unknown fees. */
export function remainingMaintenanceJob(state:State,job:MaintenanceJob):MaintenanceJob|undefined{
 const book=state.books.find(b=>b.id===job.bookId&&b.version===job.version);if(!book)return job;
 const commits=state.usage.flatMap(u=>{const d=u.maintenanceDispatch,k=u.requestKey&&ordinaryReadingTask(u.requestKey);return d?.committed&&k&&k.bookId===job.bookId&&k.version===job.version&&k.partnerId===job.partnerId?[d]:[];});
 const owned=commits.filter(d=>d.request.maintenanceJobId===job.id);
 const pointer=state.usage.find(u=>u.id===job.pendingDispatch?.usageId);
 // A view published by another owner cannot close an unknown/frozen dispatch.
 if(pointer?.maintenanceDispatch&&!pointer.maintenanceDispatch.committed&&!owned.some(d=>d.claim.hash===pointer.maintenanceDispatch!.claim.hash))return job;
 const ranges=subtractRanges(job.ranges,owned.flatMap(d=>d.claim.ranges)),viewReviewRanges=subtractRanges(job.viewReviewRanges??[],owned.flatMap(d=>d.claim.viewReviewRanges??[]));
 const chatIds=job.chatIds.filter(id=>!owned.some(d=>d.claim.chatIds.includes(id))),sceneRecordIds=(job.sceneRecordIds??[]).filter(id=>!commits.some(d=>d.claim.sceneRecordIds?.includes(id)));
 const scoped={...state,partnerId:job.partnerId},published=currentPublishedViews(scoped,book);
 const viewTargets=(job.viewTargets??[]).filter(t=>!owned.some(d=>d.claim.viewTargets.includes(t))&&!maintenanceViewTargetComplete(scoped,book,t,published));
 if(!ranges.length&&!viewReviewRanges.length&&!chatIds.length&&!sceneRecordIds.length&&!viewTargets.length)return undefined;
 if(JSON.stringify([ranges,viewReviewRanges,chatIds,sceneRecordIds,viewTargets])===JSON.stringify([job.ranges,job.viewReviewRanges??[],job.chatIds,job.sceneRecordIds??[],job.viewTargets??[]]))return job;
 // A dispatched, uncommitted claim stays frozen until its own candidate is resolved.
 return {...job,ranges,viewReviewRanges,chatIds,sceneRecordIds,viewTargets,pendingDispatch:undefined,draftId:undefined};
}
export const isSettledReadingLength=(usage:Usage)=>usage.status==='complete'&&usage.dispatchState==='response-received'&&usage.modelOutcome?.kind==='invalid-output'&&
 (usage.modelOutcome.feedbackReason==='reading-output-length'||usage.modelOutcome.reason==='模型输出达到长度上限，未执行不完整工具请求');
export function lengthRepairMarker(policy:{model:string;maxOutput:number}):string{return `reading-output-length-repair:v1:${policy.model}:${policy.maxOutput}`;}
export function lengthRepairApplied(messages:readonly ModelMessage[],policy:{model:string;maxOutput:number}):boolean{return messages.some(m=>m.role!=='assistant'&&m.content.includes(lengthRepairMarker(policy)));}
export function readingLengthFeedback(policy:{model:string;maxOutput:number},response?:ModelReply){return{accepted:false,reason:'reading-output-length',repair:lengthRepairMarker(policy),partialRetained:!!response?.rawTerminal,
 ...(response?.rawTerminal?{originalTerminal:response.rawTerminal}:{}),
 instruction:'原调用已结算并因finish_reason=length停止；截断工具均未执行。保留本任务全部实际材料与原工具历史，完整核对，只提交必要变化：完整文档无变化时documents=[]；有局部变化可revise，不必develop重写全文；overview/current仍须按实际来源精选发布或有据keep。正文上限是允许值而非写满要求。思考与提交共享当前输出预算，请为完整合法提交留足预算。'+(!response?.rawTerminal?'旧版本未保存截断响应，无法重建原assistant；不得伪造或拼接残缺结果。':'原始截断载体仅供核对失败原因，不能当已完成内容或执行其工具。')};}
