import type {ReadingActivity,ReadingRecoveryDecision,ReadingRecoveryTarget,State} from './types.ts';
import {ordinaryReadingTask} from './terminated-reading-continuation.ts';
import {chatBelongsToPartner} from './discussion-recall.ts';
import {maintenanceProgressFacts} from './maintenance-progress.ts';
import {decideReadingRecovery,listReadingRecoveryTargets,lookupReadingRecovery,readingRecoveryTarget,type ReadingRecoveryOptions} from './recovery-capabilities.ts';

const runningStages=new Set<ReadingActivity['stage']>(['preparing','waiting-model','tools','validating','saving']);
const terminalStages=new Set<ReadingActivity['stage']>(['complete','quiet','obsolete']);

/** Render actual owners plus the shared recovery inventory. Recovery category,
 * action, automatic permission and task/fee responsibility come from one pure
 * decision; this projection only supplies display identity and progress. */
export function projectReadingActivities(state:State,live:ReadingActivity[],recent:ReadingActivity[],paused=false,options:ReadingRecoveryOptions&{decisionForTarget?:(target:ReadingRecoveryTarget)=>ReadingRecoveryDecision}={}):ReadingActivity[]{
  const visibleOwner=(activity:ReadingActivity)=>activity.partnerId===state.partnerId||activity.kind==='maintenance'&&state.maintenanceJobs?.some(job=>job.id===activity.jobId&&job.bookId===activity.bookId&&job.scope==='book');
  const decisionForTarget=(target:ReadingRecoveryTarget,running=false)=>options.decisionForTarget?.(target)??decideReadingRecovery(state,target,{...options,running:options.running||running});
  const byId=new Map<string,ReadingActivity>();
  for(const activity of live){
    if(!visibleOwner(activity))continue;
    byId.set(activity.id,{...structuredClone(activity),responsibility:runningStages.has(activity.stage)?'running':terminalStages.has(activity.stage)?'history':'unfinished'});
  }
  const put=(activity:ReadingActivity)=>{const owner=byId.get(activity.id);if(!owner)byId.set(activity.id,activity);else{if(!owner.sessionId&&activity.sessionId)owner.sessionId=activity.sessionId;if(activity.recovery)owner.recovery=activity.recovery;}};
  const base=(id:string,bookId:string,kind:ReadingActivity['kind'],purpose:ReadingActivity['purpose'],at:number):ReadingActivity=>({id,bookId,partnerId:state.partnerId,kind,purpose,stage:'queued',responsibility:'unfinished',since:at,startedAt:at,updatedAt:at});
  const targets=new Map(listReadingRecoveryTargets(state).map(target=>[JSON.stringify(target),target]));
  // Retain the bounded failed carriers which explicitly exited automatic scene
  // waiting. Their partial original results remain inspectable as history.
  for(const receipt of state.companionReadingReceipts??[]){const usage=state.usage.find(usage=>usage.id===receipt.id);if(receipt.partnerId===state.partnerId&&receipt.request.input==='现场参与'&&usage?.readingTaskFailure?.disposition==='history'){const target:ReadingRecoveryTarget={kind:'scene',bookId:receipt.bookId,requestId:receipt.id};targets.set(JSON.stringify(target),target);}}
  for(const target of targets.values()){
    const {question,checkpoint,job,usage,draft,receipt,book}=lookupReadingRecovery(state,target),task=usage?.requestKey?ordinaryReadingTask(usage.requestKey):undefined;
    const bookId=book?.id??question?.bookId??job?.bookId??(target.kind==='scene'?target.bookId:task?.bookId);if(!bookId)continue;
    const preliminary=decisionForTarget(target);
    const separateRequest=target.kind==='question'?!!target.requestId&&lookupReadingRecovery(state,{kind:'question',questionId:target.questionId}).usage?.id!==target.requestId:target.kind==='maintenance'?!!target.requestId&&job?.pendingDispatch?.usageId!==target.requestId:preliminary.responsibility==='settlement';
    const identity=separateRequest&&usage?'request:'+usage.id:target.kind==='question'?'question:'+target.questionId:target.kind==='maintenance'?'maintenance:'+target.jobId:'scene:'+(usage?.requestKey??target.requestId);
    const owner=byId.get(identity),recovery=owner?.responsibility==='running'&&!options.decisionForTarget?decisionForTarget(target,true):preliminary;
    const purpose=target.kind==='question'?(question?.presentation==='paragraph'?'paragraph-reply':'answer'):target.kind==='maintenance'?'deep-maintenance':'scene-judgment';
    const activity=base(identity,bookId,target.kind,purpose,question?.createdAt??job?.createdAt??draft?.createdAt??receipt?.createdAt??usage?.time??0);
    if(job)activity.partnerId=job.partnerId;
    activity.sessionId=question?.sessionId??draft?.material?.sceneOrigin?.sessionId??receipt?.material?.sceneOrigin?.sessionId;
    activity.questionId=target.kind==='question'?target.questionId:undefined;activity.jobId=target.kind==='maintenance'?target.jobId:undefined;activity.requestId=usage?.id??(target.kind==='scene'?target.requestId:undefined);
    activity.recovery=recovery;activity.responsibility=recovery.responsibility;
    activity.reason=recovery.availability==='running'?recovery.reason:job?.status==='blocked'||job?.status==='paused'?job.reason??recovery.reason:draft?.blockedReason??(receipt?.status==='blocked'?receipt.blockedReason:undefined)??checkpoint?.blockedReason??recovery.reason;
    if(recovery.availability==='running')activity.stage='preparing';
    else if(recovery.kind==='settlement')activity.stage='unknown';
    else if(recovery.kind==='history')activity.stage=usage?.readingTaskFailure?'failed':'obsolete';
    else if(job?.status==='paused')activity.stage='paused';
    else if(job?.status==='blocked'||draft?.blockedReason||receipt?.status==='blocked'||question?.delivery==='failed')activity.stage='failed';
    else if(paused||question?.delivery==='stopped')activity.stage='paused';
    if(job){
      const facts=state.usage.flatMap(item=>item.maintenanceDispatch?.request.maintenanceJobId===job.id?maintenanceProgressFacts(item.maintenanceDispatch):[]),chats=new Set(facts.flatMap(fact=>fact.processed.chatIds)),views=new Set(facts.flatMap(fact=>fact.processed.viewTargets));
      activity.progress={chars:job.ranges.reduce((total,range)=>total+range.end-range.start,0),savedDocuments:new Set(facts.flatMap(fact=>fact.memoryIds)).size,savedViews:new Set(facts.flatMap(fact=>fact.viewIds)).size,pendingChats:job.chatIds.filter(id=>!chats.has(id)).length,pendingViews:(job.viewTargets??[]).filter(id=>!views.has(id)).length};
    }
    put(activity);
  }
  // Publication is already a saved expression lifecycle, not another reading
  // recovery task. Keep its actual due/save state and original chat identity.
  for(const chat of state.chats)if(chatBelongsToPartner(state,chat)&&chat.role==='assistant'&&['deferred','save-failed'].includes(chat.publication?.status??'')){
    const activity=base('expression:'+chat.id,chat.bookId,'expression',chat.presentation==='paragraph'||chat.publication?.destination==='paragraph'?'paragraph-comment':'expression',chat.createdAt);
    activity.sessionId=chat.sessionId;activity.chatId=chat.id;activity.requestId=chat.publication?.scene?.usageId??chat.readingReaction?.usageId;activity.stage=chat.publication?.status==='save-failed'?'failed':'waiting-publish';activity.reason=chat.publication?.reason;put(activity);
  }
  for(const activity of recent)if(visibleOwner(activity)&&state.books.some(book=>book.id===activity.bookId))put({...structuredClone(activity),responsibility:'history'});
  return [...byId.values()].map(activity=>{
    const target=readingRecoveryTarget(activity),recovery=activity.recovery??(target?decisionForTarget(target,activity.responsibility==='running'):undefined);
    if(!recovery)return activity;
    const waiting=activity.stage==='paused'&&!['history','settlement'].includes(recovery.responsibility);
    const stage=waiting?'paused':recovery.automaticState==='queued'?'queued':recovery.automaticState==='running'&&!runningStages.has(activity.stage)?'saving':recovery.automaticState==='stopped'?'failed':activity.stage;
    return{...activity,stage,recovery,responsibility:waiting?'unfinished':recovery.responsibility,...(waiting?{reason:activity.reason??'伴读已暂停，已有原答和进度保留，等待继续原任务'}:recovery.automaticState?{reason:recovery.reason}:{})};
  });
}
