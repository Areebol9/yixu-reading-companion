import {bookVersionAllowsRange,bookVersionPrefixLength} from './book-versions.ts';
import {chatBelongsToPartner} from './discussion-recall.ts';
import {consumedCompanionReadingReceipt} from './companion-receipts.ts';
import {ordinaryReadingTask,consumedMaintenanceAncestors} from './terminated-reading-continuation.ts';
import {isSettledReadingLength,READING_LENGTH_NO_PROGRESS,READING_SUBMISSION_NO_PROGRESS} from './maintenance-recovery.ts';
import {maintenanceTaskCommitted,validateMaintenanceDispatchHeaders} from './maintenance-dispatch.ts';
import {isProviderTermination} from './provider-capabilities.ts';
import {isEvidenceAllowed} from './context.ts';
import {scenePreviewRanges,scenePreviewReady} from './scene-scheduling.ts';
import type {AgentModelReply,ModelReply,AgentSessionRecord,Book,Chat,CompanionReadingReceipt,MaintenanceJob,QueryCheckpoint,ReadingActivity,ReadingDraft,ReadingRecoveryCapability,ReadingRecoveryDecision,ReadingRecoveryTarget,State,Usage,Range} from './types.ts';
export type {ReadingRecoveryCapability,ReadingRecoveryDecision,ReadingRecoveryTarget,ReadingRecoveryExecution} from './types.ts';

export type ReadingRecoveryOptions={
  receiptReader?:boolean;closing?:boolean;running?:boolean;inFlightRequestIds?:ReadonlySet<string>;runningMaintenanceBookIds?:ReadonlySet<string>;
  modelDispatchAllowed?:boolean;sessionActive?:boolean;activeBookId?:string;paused?:boolean;
  sceneInstanceId?:string;
  automaticRecoveryEnabled?:boolean;automaticRunning?:boolean;automaticStoppedReason?:string;
};
export type ReadingRecoveryLookup={
  target:ReadingRecoveryTarget;book?:Book;question?:Chat;checkpoint?:QueryCheckpoint;job?:MaintenanceJob;usage?:Usage;
  draft?:ReadingDraft;receipt?:CompanionReadingReceipt;materialOwner?:ReadingDraft|CompanionReadingReceipt|QueryCheckpoint|NonNullable<Usage['maintenanceDispatch']>;
  agentSession?:AgentSessionRecord;
};

export function maintenanceAdmissionCondition(state:State,failure:NonNullable<Usage['dispatchFailure']>,inFlightRequestIds:ReadonlySet<string>=new Set()):string|undefined{
  if(failure.recovery!=='condition-change'||!failure.blockerRequestIds?.length)return;
  return JSON.stringify(failure.blockerRequestIds.map(id=>{const usage=state.usage.find(usage=>usage.id===id);return[id,usage?.status,usage?.dispatchState,usage?.modelOutcome?.kind,inFlightRequestIds.has(id)];}));
}
export function maintenanceAdmissionChanged(state:State,usage:Usage,inFlightRequestIds:ReadonlySet<string>=new Set()):boolean{
  const failure=usage.dispatchFailure;if(!failure||failure.recovery!=='condition-change'||!failure.blockerRequestIds?.length||!usage.dispatchFailureCondition)return false;
  const settled=failure.blockerRequestIds.every(id=>{const blocker=state.usage.find(value=>value.id===id);return !!blocker&&!inFlightRequestIds.has(id)&&(blocker.status==='failed'&&blocker.dispatchState==='not-dispatched'||blocker.status==='complete'&&blocker.dispatchState==='response-received'&&blocker.modelOutcome?.kind!=='settlement-pending');});
  return settled&&maintenanceAdmissionCondition(state,failure,inFlightRequestIds)!==usage.dispatchFailureCondition;
}

/** The original claim remains authoritative even after a queue remainder has
 * moved. This inventory is shared by admission decisions and the real executor. */
export function unconsumedMaintenanceWork(state:State,job:MaintenanceJob,inFlightRequestIds:ReadonlySet<string>=new Set()):{attempts:Usage[];hasMaterial:boolean}{
  const consumedAncestors=new Set(consumedMaintenanceAncestors(state).map(usage=>usage.id));
  const claimHash=(usage:Usage)=>{const dispatch=usage.maintenanceDispatch,task=usage.requestKey&&ordinaryReadingTask(usage.requestKey);let key:unknown;try{key=usage.requestKey&&JSON.parse(usage.requestKey);}catch{}
    return dispatch&&task&&Array.isArray(key)&&key.length===8&&key[5]==='maintenance'&&key[6]===job.id&&key[7]===dispatch.claim.hash&&dispatch.request.maintenanceJobId===job.id&&dispatch.request.maintenanceClaim===dispatch.claim.hash&&task.bookId===job.bookId&&task.version===job.version&&task.partnerId===job.partnerId?dispatch.claim.hash:undefined;};
  const committed=new Set(state.usage.flatMap(usage=>{const hash=claimHash(usage);return usage.status==='complete'&&usage.dispatchState==='response-received'&&!usage.modelOutcome&&usage.maintenanceDispatch?.committed&&hash?[hash]:[];}));
  const attempts=state.usage.filter(usage=>{let key:unknown;try{key=usage.requestKey&&JSON.parse(usage.requestKey);}catch{}
    if(usage.maintenanceDispatch?.request.maintenanceJobId!==job.id&&(!Array.isArray(key)||key[6]!==job.id))return false;
    if(!inFlightRequestIds.has(usage.id)&&consumedAncestors.has(usage.id))return false;
    const hash=claimHash(usage);return inFlightRequestIds.has(usage.id)||usage.status!=='complete'||usage.dispatchState!=='response-received'||usage.modelOutcome?.kind==='settlement-pending'||!hash||!committed.has(hash);});
  const hasMaterial=!!state.readingDrafts?.some(value=>value.maintenanceJobId===job.id&&!maintenanceTaskCommitted(state,value))||!!state.companionReadingReceipts?.some(value=>value.request.maintenanceJobId===job.id&&!maintenanceTaskCommitted(state,{bookId:value.bookId,version:value.version,partnerId:value.partnerId,...value.request}));
  return{attempts,hasMaterial};
}

/** One lookup of domain owners. Returned references remain owned by State;
 * callers cannot publish changes or acquire dispatch permission by looking. */
export function lookupReadingRecovery(state:State,target:ReadingRecoveryTarget):ReadingRecoveryLookup{
  if(target.kind==='question'){
    const question=state.chats.find(chat=>chat.id===target.questionId&&chat.role==='user'),checkpoint=state.queryCheckpoints?.find(value=>value.questionId===target.questionId);
    const usage=target.requestId?state.usage.find(value=>value.id===target.requestId):state.usage.find(value=>value.id===checkpoint?.pendingReceipt?.usageId)??state.usage.filter(value=>value.questionId===target.questionId).at(-1);
    return{target,question,checkpoint,usage,book:state.books.find(book=>book.id===(question?.bookId??checkpoint?.bookId)),materialOwner:checkpoint};
  }
  if(target.kind==='scene'){
    const usage=state.usage.find(value=>value.id===target.requestId),draft=state.readingDrafts?.find(value=>value.id===target.requestId),receipt=state.companionReadingReceipts?.find(value=>value.id===target.requestId);
    return{target,usage,draft,receipt,book:state.books.find(book=>book.id===target.bookId),materialOwner:draft??receipt,agentSession:state.agentSessions?.find(record=>record.id===usage?.agentSessionId)};
  }
  const job=state.maintenanceJobs?.find(value=>value.id===target.jobId),usage=state.usage.find(value=>value.id===(target.requestId??job?.pendingDispatch?.usageId));
  const draft=usage&&state.readingDrafts?.find(value=>value.id===usage.id&&value.maintenanceJobId===target.jobId),receipt=usage&&state.companionReadingReceipts?.find(value=>value.id===usage.id&&value.request.maintenanceJobId===target.jobId);
  return{target,job,usage,draft,receipt,book:state.books.find(book=>book.id===(job?.bookId??(usage?.requestKey?ordinaryReadingTask(usage.requestKey)?.bookId:undefined))),materialOwner:draft??receipt??usage?.maintenanceDispatch};
}

const uncertain=(usage:Usage|undefined)=>usage?.status==='unknown'||usage?.status==='reserved'||usage?.modelOutcome?.kind==='settlement-pending';
const complete=(usage:Usage|undefined)=>usage?.status==='complete'&&usage.dispatchState==='response-received'&&usage.modelOutcome?.kind!=='settlement-pending';
const versionAllows=(book:Book|undefined,version:string,ranges:readonly Range[])=>!!book&&bookVersionPrefixLength(book,version)!==undefined&&ranges.every(range=>bookVersionAllowsRange(book,version,range));
const carrierAllows=(book:Book|undefined,carrier:ReadingDraft|CompanionReadingReceipt|QueryCheckpoint|undefined)=>!carrier||versionAllows(book,carrier.version,'request'in carrier?carrier.request.ranges:'ranges'in carrier?carrier.ranges:carrier.material?.ranges??[])&&(carrier.material?.refs??[]).every(range=>range.bookId===book?.id&&bookVersionAllowsRange(book!,range.version,range));
const isSceneRead=(state:State,id:string)=>state.readings?.some(record=>record.draftId===id||record.supersededReceiptIds?.includes(id));
const nativeReceived=(state:State,usage:Usage|undefined)=>usage?.status==='complete'&&usage.modelOutcome?.kind==='settlement-pending'&&!!usage.agentResponse&&state.settings.services.some(service=>service.id===usage.serviceId&&service.providerCapabilities?.transport==='native-http');
const pendingSceneExpression=(chat:Chat,requestId:string)=>chat.role==='assistant'&&['deferred','save-failed'].includes(chat.publication?.status??'')&&(chat.publication?.scene?.usageId??chat.readingReaction?.usageId)===requestId;
/** Raw results have no durable draft/receipt owner yet. Only the exact open
 * original session and its recorded call can supply that missing owner. */
function rawSceneSessionOwnsCall(usage:Usage,record:AgentSessionRecord|undefined):boolean{
  if(!record||record.status!=='open'||record.id!==usage.agentSessionId||!usage.agentCallId||record.taskKey!==usage.requestKey)return false;
  const task=ordinaryReadingTask(record.taskKey);if(!task||task.bookId!==record.bookId||task.version!==record.version||task.partnerId!==record.partnerId)return false;
  if(record.native){const calls=record.native.calls.filter(call=>call.agentCallId===usage.agentCallId);return calls.length===1&&!calls[0].notDispatched&&(!calls[0].requestId||calls[0].requestId===usage.id);}
  const events=record.material?.snapshot.events as {type?:string;data?:{agentCallId?:string;requestId?:string}}[]|undefined;
  return !!events&&events.filter(event=>event.type==='yixu/model-request'&&event.data?.agentCallId===usage.agentCallId).length===1&&!events.some(event=>event.type==='yixu/model-response'&&event.data?.agentCallId===usage.agentCallId&&event.data?.requestId!==usage.id);
}
/** A cold raw response can precede candidate registration. Its saved tool names
 * identify the final turn; immutable bodies and acceptance are checked on use. */
function rawMaintenanceResult(state:State,job:MaintenanceJob,usage:Usage|undefined):'final'|'receipt'|undefined{
  if(!usage||!complete(usage)||usage.modelOutcome||job.pendingDispatch?.usageId!==usage.id||!usage.maintenanceDispatch||usage.maintenanceDispatch.committed)return;
  try{validateMaintenanceDispatchHeaders({...state,usage:[usage],maintenanceJobs:[job]});}catch{return;}
  const dispatch=usage.maintenanceDispatch,response=usage.agentResponse?.material?.response??dispatch.material?.terminalResponse;
  const finalTools=(names:readonly string[])=>names.filter(name=>name==='finish_reading').length===1&&names.filter(name=>name==='submit_reading').length<=1&&names.every(name=>['finish_reading','submit_reading','react_to_reading'].includes(name));
  const isNativeToolResponse=(value:ModelReply):value is AgentModelReply=>'toolCalls'in value&&Array.isArray(value.toolCalls)&&'finish'in value&&(value.finish==='stop'||value.finish==='tool_calls');
  if(response){
    if('requestId'in response&&response.requestId!==usage.id)return;
    if(isNativeToolResponse(response))return response.finish==='tool_calls'&&finalTools(response.toolCalls.map(call=>call.function.name))?'final':undefined;
    return response.content.trim()?'receipt':undefined;
  }
  if(!usage.agentResponse?.materialRef&&!dispatch.materialRef)return;
  if(usage.modelTools?.length)return finalTools(usage.modelTools)?'final':undefined;
  return'receipt';
}
/** Stored provider proof is a continuation candidate, never receipt settlement.
 * The executor still verifies its digest before a new transport request. */
export function savedProviderNoResult(state:State,usage:Usage):boolean{
  const terminal=usage.providerAttempt?.terminal,receipt=usage.providerAttempt?.receipt,service=state.settings.services.find(service=>service.id===usage.serviceId);
  return usage.status==='unknown'&&usage.dispatchState==='response-received'&&!usage.hostQueryReceipt&&!usage.agentResponse&&!!service&&isProviderTermination(terminal,usage.id)&&!!receipt&&receipt.version==='provider-receipt-v1'&&receipt.status===terminal.status&&service.providerCapabilities?.provider==='deepseek'&&service.providerCapabilities.transport==='native-http'&&terminal.endpoint===service.baseUrl.replace(/\/$/,'')+'/chat/completions'&&!!receipt.body?.error&&typeof receipt.body.error==='object'&&!Array.isArray(receipt.body.error)&&receipt.body.choices===undefined;
}

/** All entry points consume this decision. Source/body integrity and the real
 * submission remain with the original executors; this function performs no I/O,
 * parses no response text, and mutates neither domain state nor settings. */
export function decideReadingRecovery(state:State,target:ReadingRecoveryTarget,options:ReadingRecoveryOptions={}):ReadingRecoveryDecision{
  const shared=target.kind==='maintenance'?state.maintenanceJobs?.find(job=>job.id===target.jobId&&job.scope==='book'):undefined;if(shared&&shared.partnerId!==state.partnerId)state={...state,partnerId:shared.partnerId};
  const found=lookupReadingRecovery(state,target),{book,question,checkpoint,job,usage,draft,receipt,agentSession}=found,decisionTarget=usage&&target.kind!=='scene'?{...target,requestId:usage.id}:target;
  const decision=(kind:ReadingRecoveryCapability['kind'],execution:ReadingRecoveryDecision['execution'],reason:string,action?:ReadingRecoveryCapability['action'],automatic=false,availability:ReadingRecoveryDecision['availability']=execution==='none'?'blocked':'available',trigger?:ReadingRecoveryDecision['trigger']):ReadingRecoveryDecision=>{
    const result:ReadingRecoveryDecision={target:decisionTarget,kind,execution,automatic,availability,responsibility:availability==='running'?'running':kind==='history'?'history':'unfinished',reason,...(action?{action}:{}),...(trigger?{trigger}:{})};
    if(automatic&&availability==='running')result.automaticState='running';
    else if(availability==='available'&&(automatic||options.automaticStoppedReason)){
      const stopped=options.automaticStoppedReason??(execution!=='continue'&&options.automaticRecoveryEnabled===false?'自动处理已暂停，可手动处理原结果':undefined);
      if(stopped){result.automatic=false;result.automaticState='stopped';result.reason=stopped;}
      else result.automaticState='queued';
    }
    return result;
  };
  const history=(reason:string)=>decision('history','none',reason,undefined,false,'history');
  const blocked=(reason:string)=>decision('user','none',reason);
  const settlement=(reason:string,action?:ReadingRecoveryCapability['action'],automatic=false,completed=false):ReadingRecoveryDecision=>({...decision('settlement',action?'receipt':'none',reason,action,automatic),responsibility:completed?'settlement':'unfinished'});
  const running=()=>decision('condition','none',options.automaticRunning?'正在自动处理原任务，完成后会更新结果':'原任务仍由当前执行者处理',undefined,!!options.automaticRunning,'running');
  const allowContinue=(bookId:string)=>options.modelDispatchAllowed===true&&options.sessionActive===true&&options.activeBookId===bookId&&!options.paused&&!options.closing;
  const rawTask=usage?.requestKey?ordinaryReadingTask(usage.requestKey):undefined;
  const material=draft?.material??receipt?.material??checkpoint?.material??usage?.maintenanceDispatch?.material?.material??agentSession?.material?.material;
  const materialPermitted=(extra:readonly Range[]=[])=>!material?.refs?.length||!!book&&isEvidenceAllowed(book,material.refs,extra);
  const rangesPermitted=(version:string,ranges:readonly Range[],extra:readonly Range[]=[])=>!ranges.length||!!book&&isEvidenceAllowed(book,ranges.map(range=>({...range,bookId:book.id,version})),extra);
  if(target.requestId&&!usage)return blocked('指定的原调用记录不存在，不能改用当前调用');

  if(target.kind==='question'){
    if(usage&&usage.questionId!==target.questionId)return blocked('原请求不属于这个问题');
    if(question&&!chatBelongsToPartner(state,question)||checkpoint&&checkpoint.partnerId!==state.partnerId)return blocked('原问题不属于当前伙伴');
    const closed=checkpoint?.status==='consumed'||question?.delivery==='answered'||!!question&&state.chats.some(chat=>chat.role==='assistant'&&chat.replyTo===question.id&&!chat.excluded&&!chat.outdatedBy&&!chat.replacedBy);
    if(closed)return uncertain(usage)?settlement('原问题已保存；这次原调用的费用仍待核实',undefined,false,true):history('原问题已经保存完整回应');
    if(!question)return uncertain(usage)?settlement('原问题已退出，原调用与费用记录仍保留',undefined,false,true):history('原问题已退出当前任务');
    if(options.closing)return blocked('正在等待回复并保存阅读记录');
    if(options.running||usage&&options.inFlightRequestIds?.has(usage.id))return running();
    if(target.requestId&&lookupReadingRecovery(state,{kind:'question',questionId:target.questionId}).usage?.id!==target.requestId)return uncertain(usage)?settlement('这次历史调用只核验自己的原回执，不替换当前问题候选',options.receiptReader&&usage?.status!=='reserved'?'recover-question':undefined,false,true):history('这次历史调用不再拥有当前问题的候选');
    if(!book||!carrierAllows(book,checkpoint)||question.evidence.some(range=>range.bookId!==book.id||!bookVersionAllowsRange(book,range.version,range)))return blocked('原问题的身份或正文版本不适用当前接续');
    const otherUnresolved=state.usage.some(value=>value.id!==usage?.id&&value.questionId===target.questionId&&uncertain(value)&&value.dispatchState!=='not-dispatched'&&!savedProviderNoResult(state,value));
    if(otherUnresolved&&(!uncertain(usage)||usage&&savedProviderNoResult(state,usage)))return settlement('原问题仍有另一笔未定调用，核清前不能新增派发');
    if(usage&&(usage.dispatchState==='not-dispatched'&&usage.status!=='reserved'||savedProviderNoResult(state,usage))){
      if(state.usage.some(value=>value.id!==usage.id&&value.questionId===target.questionId&&uncertain(value)&&value.dispatchState!=='not-dispatched'&&!savedProviderNoResult(state,value)))return settlement('原问题仍有另一笔未定调用，核清前不能新增派发');
      if((!checkpoint||checkpoint.status==='acquired')&&!question.excluded&&!question.outdatedBy&&!question.replacedBy&&!question.futureGrant&&isEvidenceAllowed(book,question.evidence)&&materialPermitted())return decision('user','continue','沿已保存的未派发或提供方终止证据核验后继续原问题','retry-question');
    }
    if(uncertain(usage))return settlement('核验原调用回执；结果或结算未确定时不重发',options.receiptReader&&usage?.status!=='reserved'?'recover-question':undefined,nativeReceived(state,usage)&&!!options.receiptReader);
    if(question.excluded||question.outdatedBy||question.replacedBy||question.futureGrant||!isEvidenceAllowed(book,question.evidence)||!materialPermitted())return blocked('原问题的正文许可或形成来源已撤回，原问与原答保持');
    if(checkpoint&&['received','ready'].includes(checkpoint.status)&&checkpoint.blockedReason&&complete(usage)&&state.agentSessions?.some(session=>session.status==='open'&&session.bookId===question.bookId&&session.partnerId===state.partnerId&&session.taskKey===JSON.stringify(['question',question.id,'main'])))return decision('user','continue','沿原问题的已结算原答和原生会话明确续交','retry-question');
    if(checkpoint&&['received','ready'].includes(checkpoint.status))return decision('local','local-result','验收并保存原问题已收到的完整结果','retry-question',true);
    return decision('user','continue','沿原问题和已取材料明确继续','retry-question');
  }

  if(target.kind==='scene'){
    if(!usage&&!draft&&!receipt)return history('原现场没有仍待提交的结果');
    if(rawTask&&(rawTask.bookId!==target.bookId||rawTask.partnerId!==state.partnerId)||draft&&(draft.bookId!==target.bookId||draft.partnerId!==state.partnerId)||receipt&&(receipt.bookId!==target.bookId||receipt.partnerId!==state.partnerId))return blocked('原现场不属于当前作品或伙伴');
    if(usage?.questionId)return blocked('明确问题由其原问题入口接续');
    if(usage?.maintenanceDispatch||usage?.taskId)return blocked('这次原调用由其维护或核对任务接续');
    const pending=draft&&!draft.continuation?state.chats.filter(chat=>chat.bookId===target.bookId&&chatBelongsToPartner(state,chat)&&pendingSceneExpression(chat,target.requestId)):[];
    const consumed=!!isSceneRead(state,target.requestId)||!!receipt&&!draft&&consumedCompanionReadingReceipt(state,receipt)||!!usage?.requestKey&&state.readings?.some(record=>[record.draftId,...(record.supersededReceiptIds??[])].some(id=>id&&state.usage.some(original=>original.id===id&&original.requestKey===usage.requestKey)));
    const historicalTask=!!usage?.requestKey&&state.usage.some(original=>original.requestKey===usage.requestKey&&original.readingTaskFailure?.disposition==='history');
    if(consumed&&!pending.length)return uncertain(usage)?settlement('原现场已有真实后继成果；这次原调用费用仍待确认',undefined,false,true):history('原现场已由其真实成果或后继提交消费');
    if(historicalTask&&!pending.length)return uncertain(usage)?settlement('自动现场已退出等待，原调用费用仍待核实',undefined,false,true):history('独立合法成果已保存，过时自动现场的其余原答与错误保留历史');
    if(!book||rawTask&&!versionAllows(book,rawTask.version,rawTask.ranges)||!carrierAllows(book,draft??receipt))return blocked('原现场的正文版本或前缀范围不属于当前作品');
    if(options.closing)return blocked('正在等待回复并保存阅读记录');
    if(options.running||usage&&options.inFlightRequestIds?.has(usage.id))return running();
    const preview=scenePreviewRanges({taskRole:'scene',sceneOpportunity:material?.sceneOpportunity??draft?.sceneOpportunity??receipt?.request.sceneOpportunity});
    if(!materialPermitted(preview)||rawTask&&!rangesPermitted(rawTask.version,rawTask.ranges,preview))return blocked('原现场实际形成范围的许可已撤回，原答保持');
    if(uncertain(usage))return settlement('只核验原现场回执；未定原调用不重复派发',options.receiptReader&&usage?.status!=='reserved'&&!!rawTask&&!!usage?.agentSessionId?'recover-scene':undefined,nativeReceived(state,usage)&&!!options.receiptReader);
    if(!draft&&!receipt&&usage?.agentResponse&&!rawSceneSessionOwnsCall(usage,agentSession))return agentSession?.status==='complete'?history('原现场会话已完成，原答保留历史'):blocked('原答未绑定仍开放且调用身份吻合的原现场会话');
    if(pending.length&&complete(usage)&&!usage?.modelOutcome){
      if(!scenePreviewReady(book,material?.sceneOpportunity??draft?.sceneOpportunity))return decision('condition','none','等待实际读完原现场预读的完整段落');
      const oldScene=options.sessionActive===false||options.activeBookId!==undefined&&options.activeBookId!==target.bookId||options.sceneInstanceId!==undefined&&pending.some(chat=>!!chat.publication?.scene&&chat.publication.scene.instanceId!==options.sceneInstanceId);
      const failed=pending.some(chat=>chat.publication?.status==='save-failed');
      if(!oldScene&&!failed)return decision('condition','none','原稿已保存，等待同一现场满足发表条件');
      return decision('local','local-result','补存原现场尚未保存的发表结果；过时即时表达保留原件并结束等待','recover-scene',true);
    }
    if(complete(usage)&&!usage?.modelOutcome&&(draft&&!draft.continuation||receipt||usage?.agentResponse&&usage.agentSessionId&&usage.agentCallId))return decision('local','local-result','验收原现场完整原答并保存合法独立成果','recover-scene',true);
    if(draft||receipt)return blocked('原结果的结算与派发身份尚待核齐，原件已保留');
    return history('自动现场已停止；原答、错误与费用记录保留历史');
  }

  // Maintenance owns a frozen job/claim. Historical fee rows may outlive it.
  if(usage&&usage.maintenanceDispatch?.request.maintenanceJobId!==target.jobId){let key:unknown;try{key=usage.requestKey&&JSON.parse(usage.requestKey);}catch{}if(!Array.isArray(key)||key[5]!=='maintenance'||key[6]!==target.jobId||job&&(key[0]!==job.bookId||key[1]!==job.version||key[2]!==job.partnerId))return blocked('原请求不属于这个维护任务');}
  if(!job)return uncertain(usage)?settlement('原维护已有后继，原调用费用仍待核实',undefined,false,true):history('原维护任务已完成或退出');
  if(job.partnerId!==state.partnerId)return blocked('原维护不属于当前伙伴');
  if(job.dismissed){
    if(usage&&options.inFlightRequestIds?.has(usage.id))return running();
    return uncertain(usage)?settlement('这项整理已移出待办；原调用结果及费用仍待确认',options.receiptReader&&usage?.status!=='reserved'?'resume-maintenance':undefined,false,true):history('这项整理已由用户移出待办，原材料、原答与费用记录保留');
  }
  if(target.requestId&&job.pendingDispatch?.usageId!==target.requestId){
    if(options.closing)return blocked('正在等待回复并保存阅读记录');
    if(options.running||usage&&options.inFlightRequestIds?.has(usage.id))return running();
    return uncertain(usage)?settlement('这次历史调用只核验自己的原回执，不替换当前维护候选',options.receiptReader&&usage?.status!=='reserved'?'resume-maintenance':undefined,false,true):history('这次历史调用不再拥有当前维护的派发指针');
  }
  if(job.partnerId!==state.partnerId||!versionAllows(book,job.version,[...job.ranges,...(job.viewReviewRanges??[])])||!carrierAllows(book,draft??receipt))return blocked('原维护的伙伴、正文版本或前缀范围不适用');
  const sameClaim=!!usage?.maintenanceDispatch&&state.usage.some(value=>value.maintenanceDispatch?.request.maintenanceJobId===job.id&&value.maintenanceDispatch.claim.hash===usage.maintenanceDispatch!.claim.hash&&!!value.maintenanceDispatch.committed);
  if(usage?.maintenanceDispatch?.committed||sameClaim)return uncertain(usage)?settlement('原维护claim已提交，原调用费用仍待确认',undefined,false,true):history('原维护的真实claim已提交');
  if(options.closing)return blocked('正在等待回复并保存阅读记录');
  // A persisted job retains unfinished work across pause and cold start.
  // Only its live executor or actual in-flight request owns running work.
  if(options.running||usage&&options.inFlightRequestIds?.has(usage.id))return running();
  // A book may have one writer, but that writer owns only its exact job.
  // Preserve the concurrency condition without promoting waiting/failed jobs
  // into running activities or hiding their original failure.
  if(options.runningMaintenanceBookIds?.has(job.bookId))return decision('condition','none',job.status==='blocked'&&job.reason?`${job.reason}；等待同书正在进行的后台整理结束后再接续本项`:'等待同书正在进行的后台整理结束，本项尚未开始');
  if(uncertain(usage)){
    if(usage&&savedProviderNoResult(state,usage)){
      const consumed=new Set(consumedMaintenanceAncestors(state).map(value=>value.id)),others=unconsumedMaintenanceWork(state,job,options.inFlightRequestIds).attempts;
      if(!others.some(value=>value.id!==usage.id&&!consumed.has(value.id)&&uncertain(value)&&!savedProviderNoResult(state,value))&&rangesPermitted(job.version,[...job.ranges,...(job.viewReviewRanges??[])])&&materialPermitted())return decision('user','continue','沿已保存的提供方终止证据核验后继续同一维护任务','resume-maintenance');
    }
    return settlement('只核验原维护回执；未定原调用不重复派发',options.receiptReader&&usage?.status!=='reserved'?'resume-maintenance':undefined,nativeReceived(state,usage)&&!!options.receiptReader);
  }
  if(!rangesPermitted(job.version,[...job.ranges,...(job.viewReviewRanges??[])])||!materialPermitted())return blocked('原维护的正文许可或形成范围已撤回，原任务与原答保持');
  if(complete(usage)&&!usage?.modelOutcome&&(draft?.association==='ready'&&!draft.continuation||receipt?.status==='received'))return decision('local','local-result','优先提交原维护已收到的完整结果','resume-maintenance',true);
  const consumedIds=new Set(consumedMaintenanceAncestors(state).map(value=>value.id));
  const {attempts,hasMaterial}=unconsumedMaintenanceWork(state,job,options.inFlightRequestIds);
  if(attempts.some(value=>!consumedIds.has(value.id)&&uncertain(value)))return settlement('原维护仍有未定调用；核清原回执前不能新增派发');
  if(!draft&&!receipt){
    const raw=rawMaintenanceResult(state,job,usage);
    if(raw==='final'&&options.receiptReader)return decision('local','local-result','核验并补存原维护已收到的完整原答','resume-maintenance',true);
    if(raw==='receipt')return settlement('原维护已收到原答，先核验原回执及完整候选',options.receiptReader?'resume-maintenance':undefined);
  }
  const stopped=job.reason===READING_LENGTH_NO_PROGRESS||job.reason===READING_SUBMISSION_NO_PROGRESS;
  // Normal lifecycle suspension retains this exact job/claim. All unresolved
  // attempts, permissions and local results were checked above; a new reading
  // start grants dispatch through the same admission gate as other recovery.
  let trigger:ReadingRecoveryDecision['trigger']=job.status==='paused'?'paused':undefined;
  if(job.status==='blocked'&&!stopped){
    if(!job.pendingDispatch&&!hasMaterial&&attempts.every(value=>value.status==='failed'&&value.dispatchState==='not-dispatched'))trigger='never-dispatched';
    else if(usage?.status==='failed'&&usage.dispatchState==='not-dispatched'&&maintenanceAdmissionChanged(state,usage,options.inFlightRequestIds))trigger=usage.agentSessionId&&usage.maintenanceDispatch?'session-not-dispatched':!hasMaterial&&attempts.every(value=>value.status==='failed'&&value.dispatchState==='not-dispatched')?'never-dispatched':undefined;
    else if(usage&&isSettledReadingLength(usage))trigger='length';
  }
  const automatic=!!trigger&&allowContinue(job.bookId);
  return decision(usage?.dispatchFailure?.recovery==='condition-change'?'condition':'user','continue',stopped?'原任务已停止重复失败；需明确检查后接续':trigger==='paused'?'整理已随阅读暂停保存，开始阅读后沿原答继续':trigger?'原阻断条件已解除，可沿同一维护责任接续':'沿原维护任务、原答与当前必要材料明确续交','resume-maintenance',automatic,'available',trigger);
}

export function readingRecoveryTarget(activity:ReadingActivity):ReadingRecoveryTarget|undefined{
  if(activity.kind==='question'&&activity.questionId)return{kind:'question',questionId:activity.questionId,...(activity.requestId?{requestId:activity.requestId}:{})};
  if((activity.kind==='scene'||activity.kind==='expression')&&activity.requestId)return{kind:'scene',bookId:activity.bookId,requestId:activity.requestId};
  if(activity.kind==='maintenance'&&activity.jobId)return{kind:'maintenance',jobId:activity.jobId,...(activity.requestId?{requestId:activity.requestId}:{})};
}

/** The activity surface is only a bridge. A historical presentation cannot
 * hide an unfinished explicit question or reinterpret an unknown ledger row. */
export function readingRecoveryCapability(state:State,activity:ReadingActivity,options:ReadingRecoveryOptions={}):ReadingRecoveryCapability|undefined{
  const target=readingRecoveryTarget(activity);if(!target)return;
  const decision=decideReadingRecovery(state,target,{...options,running:options.running||activity.responsibility==='running'});
  return decision;
}

/** A read-only inventory, deduplicated by the exact existing owner. No record
 * is added, cleared, or promoted to a new task by enumeration. */
export function listReadingRecoveryTargets(state:State,options:{includeHistory?:boolean}={}):ReadingRecoveryTarget[]{
  const targets=new Map<string,ReadingRecoveryTarget>(),put=(target:ReadingRecoveryTarget)=>{targets.set(JSON.stringify(target),target);};
  const usageById=new Map(state.usage.map(usage=>[usage.id,usage])),questions=new Map(state.chats.filter(chat=>chat.role==='user'&&chatBelongsToPartner(state,chat)).map(chat=>[chat.id,chat]));
  const checkpoints=new Map((state.queryCheckpoints??[]).map(checkpoint=>[checkpoint.questionId,checkpoint])),latestQuestions=new Map<string,Usage>();
  const jobs=new Map((state.maintenanceJobs??[]).filter(job=>job.scope==='book'||job.partnerId===state.partnerId).map(job=>[job.id,job]));
  const agentSessions=new Map((state.agentSessions??[]).map(record=>[record.id,record]));
  const consumedIds=new Set<string>(),consumedTaskKeys=new Set<string>(),historicalTaskKeys=new Set<string>();
  const pendingExpressionIds=new Set(state.chats.filter(chat=>chatBelongsToPartner(state,chat)&&chat.role==='assistant'&&['deferred','save-failed'].includes(chat.publication?.status??'')).map(chat=>chat.publication?.scene?.usageId??chat.readingReaction?.usageId).filter((id):id is string=>!!id));
  for(const record of state.readings??[])for(const id of [record.draftId,...(record.supersededReceiptIds??[])])if(id){consumedIds.add(id);const key=usageById.get(id)?.requestKey;if(key)consumedTaskKeys.add(key);}
  for(const draft of state.readingDrafts??[])for(const id of draft.supersededReceiptIds??[])consumedIds.add(id);
  for(const usage of state.usage){if(usage.questionId)latestQuestions.set(usage.questionId,usage);if(usage.readingTaskFailure?.disposition==='history'&&usage.requestKey)historicalTaskKeys.add(usage.requestKey);}
  for(const question of questions.values()){const checkpoint=checkpoints.get(question.id);if(options.includeHistory||['pending','failed','stopped'].includes(question.delivery??'')||checkpoint&&['received','ready'].includes(checkpoint.status))put({kind:'question',questionId:question.id});}
  const sceneDraftIds=new Set<string>();
  for(const draft of state.readingDrafts??[])if(draft.partnerId===state.partnerId&&draft.input==='现场参与'){
    sceneDraftIds.add(draft.id);const usage=usageById.get(draft.id);if(options.includeHistory||pendingExpressionIds.has(draft.id)||!consumedIds.has(draft.id)&&usage?.readingTaskFailure?.disposition!=='history'&&(!usage?.requestKey||!historicalTaskKeys.has(usage.requestKey)))put({kind:'scene',bookId:draft.bookId,requestId:draft.id});
  }
  for(const receipt of state.companionReadingReceipts??[])if(receipt.partnerId===state.partnerId&&receipt.request.input==='现场参与'){
    const usage=usageById.get(receipt.id);if(sceneDraftIds.has(receipt.id))continue;
    if(options.includeHistory||!consumedIds.has(receipt.id)&&usage?.readingTaskFailure?.disposition!=='history'&&(!usage?.requestKey||!historicalTaskKeys.has(usage.requestKey))&&!consumedCompanionReadingReceipt(state,receipt))put({kind:'scene',bookId:receipt.bookId,requestId:receipt.id});
  }
  for(const job of jobs.values())put({kind:'maintenance',jobId:job.id});
  for(const usage of state.usage){
    const unsettled=uncertain(usage);
    if(usage.questionId){
      const question=questions.get(usage.questionId),checkpoint=checkpoints.get(usage.questionId),current=usageById.get(checkpoint?.pendingReceipt?.usageId??'')??latestQuestions.get(usage.questionId);
      if(question&&(options.includeHistory||unsettled&&(current?.id!==usage.id||question.delivery==='answered')))put({kind:'question',questionId:usage.questionId,requestId:usage.id});continue;
    }
    if(!options.includeHistory&&!unsettled&&(consumedIds.has(usage.id)||usage.requestKey&&(consumedTaskKeys.has(usage.requestKey)||historicalTaskKeys.has(usage.requestKey))))continue;
    if(usage.maintenanceDispatch){
      const jobId=usage.maintenanceDispatch.request.maintenanceJobId;if(!jobId)continue;const job=jobs.get(jobId);
      if((options.includeHistory||unsettled)&&job?.pendingDispatch?.usageId!==usage.id){const task=usage.requestKey?ordinaryReadingTask(usage.requestKey):undefined;if(task?.partnerId===state.partnerId)put({kind:'maintenance',jobId,requestId:usage.id});}continue;
    }
    if(!options.includeHistory&&!unsettled&&(!complete(usage)||!usage.agentResponse||!rawSceneSessionOwnsCall(usage,agentSessions.get(usage.agentSessionId??''))))continue;
    const task=usage.requestKey?ordinaryReadingTask(usage.requestKey):undefined;if(!task||task.partnerId!==state.partnerId)continue;
    let role:unknown;try{role=JSON.parse(usage.requestKey!)[5];}catch{}if(role==='scene')put({kind:'scene',bookId:task.bookId,requestId:usage.id});
  }
  return [...targets.values()];
}
