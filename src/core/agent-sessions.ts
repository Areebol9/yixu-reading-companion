import type {AgentSessionStore,AgentSessionSnapshot,NativeSessionReference,AgentDelegationRecord} from './agent-port.ts';
import type {AgentSessionRecord,QueryMaterial,State,Store,Range} from './types.ts';
import {resolveStorageMaterials,validateTaskMaterialRef} from './storage-records.ts';
import {queryMaterialStamp} from './query-checkpoints.ts';
import {dependencyStampsEqual} from './dependency-chat-sources.ts';
import {resolveBookVersion,bookVersionAllowsRanges,bookVersionPrefixLength} from './book-versions.ts';
import {inheritDependencyPreparation} from './dependency-nodes.ts';
import {validateMaterialProjection} from './material-projection.ts';
import {isEvidenceAllowed} from './context.ts';
import {covers,mergeRanges} from './books.ts';
import {registerAgentSessionAppend,registerNativeSessionProjection,validateNativeSessionReference,validateConversationContexts} from './agent-session-storage.ts';
export {assertAgentSessionSuccessor} from './agent-session-storage.ts';

const writes=new WeakMap<State,Map<string,Promise<unknown>>>();
const capturedSources=new WeakMap<QueryMaterial,QueryMaterial>();
function captureSources(material:QueryMaterial):QueryMaterial{let copy=capturedSources.get(material);if(!copy){copy=structuredClone(material);inheritDependencyPreparation(material,copy);capturedSources.set(material,copy);}return copy;}

/** The event prefix and the domain's acquired sources advance in one save. */
export function agentSessionStore(input:{
  state():State;
  owner:{id:string;bookId:string;version:string;partnerId:string;taskKey:string;nativeSessionId?:string;nativeStartEventCount?:number;conversationId?:string;contextRole?:AgentSessionRecord['contextRole'];previousSessionId?:string;inheritedFrom?:AgentSessionRecord['inheritedFrom'];delegation?:AgentDelegationRecord};
  /** Only an already completed native prefix may seed another independent task. */
  initialNative?:NativeSessionReference;
  snapshot():{material:QueryMaterial;dependencyStamp:string}|Promise<{material:QueryMaterial;dependencyStamp:string}>;
  read?:Store['readTaskMaterials'];
  save(record:AgentSessionRecord):Promise<void>;
}):AgentSessionStore{
  const nativeId=input.owner.nativeSessionId??input.owner.id,initialNative=input.initialNative?structuredClone(input.initialNative):undefined;
  if(initialNative){validateNativeSessionReference(initialNative,nativeId);if(initialNative.eventCount>0&&initialNative.closedEventCount!==initialNative.eventCount)throw Error('持续上下文只能接续已收妥的原生轮次');if(input.owner.nativeStartEventCount!==initialNative.eventCount)throw Error('持续上下文起点与原生完整前缀不符');}
  const current=()=>input.state().agentSessions?.find(s=>s.id===input.owner.id);
  const loaded=async()=>{const record=current();if(record){if(['id','bookId','version','partnerId','taskKey','nativeStartEventCount','conversationId','contextRole'].some(key=>record[key as keyof typeof input.owner]!==input.owner[key as keyof typeof input.owner])||(record.nativeSessionId??record.id)!==nativeId)throw Error('Agent会话的原任务归属已变化');await resolveStorageMaterials([record],input.read);}return record;};
  const serial=<T>(operation:()=>Promise<T>):Promise<T>=>{
    const state=input.state();let owners=writes.get(state);if(!owners){owners=new Map();writes.set(state,owners);}
    const pending=(owners.get(nativeId)??Promise.resolve()).catch(()=>{}).then(operation);
    owners.set(nativeId,pending);void pending.finally(()=>{if(owners!.get(nativeId)===pending)owners!.delete(nativeId);}).catch(()=>{});return pending;
  };
  const write=async(snapshot:AgentSessionSnapshot,previous?:AgentSessionRecord,events?:unknown[])=>{
    const sources=previous&&previous.status!=='open'?{material:previous.material!.material,dependencyStamp:previous.material!.dependencyStamp}:await input.snapshot(),now=Date.now();
    const record:AgentSessionRecord={...input.owner,...(previous?.delegation?{delegation:previous.delegation}:{}),...(previous?.inheritedFrom?{inheritedFrom:previous.inheritedFrom}:{}),status:previous?.status??'open',...(previous?.invalidation?{invalidation:previous.invalidation}:{}),...(previous?.previousSessionId?{previousSessionId:previous.previousSessionId}:{}),createdAt:previous?.createdAt??now,updatedAt:now,material:{kind:'agent-session-v1',snapshot,material:captureSources(sources.material),dependencyStamp:sources.dependencyStamp,...(previous?.material?.migrationSource?{migrationSource:previous.material.migrationSource}:{}),...(previous?.material?.delegatedResult?{delegatedResult:previous.material.delegatedResult}:{}),...(previous?.material?.inheritedMaterial?{inheritedMaterial:previous.material.inheritedMaterial}:{})}};
    if(previous&&events)registerAgentSessionAppend(previous,record,events);
    await input.save(record);
  };
  return{
    async loadNative(){const record=await loaded();if(record?.native)validateNativeSessionReference(record.native,nativeId);return record?.native?structuredClone(record.native):initialNative?structuredClone(initialNative):undefined;},
    saveNative(reference:NativeSessionReference){const captured=structuredClone(reference);return serial(async()=>{
      validateNativeSessionReference(captured,nativeId);const previous=await loaded(),sources=previous&&previous.status!=='open'?{material:previous.material!.material,dependencyStamp:previous.material!.dependencyStamp}:await input.snapshot(),now=Date.now();
      if(captured.eventCount<(input.owner.nativeStartEventCount??0))throw Error('原生会话水位低于本任务接续起点');
      if(previous?.native&&previous.native.eventCount>captured.eventCount)throw Error('原生会话水位倒退，未覆盖现有进度');
      const originalSnapshot=previous?.material?.snapshot;
      const migrationSource=previous?.material?.migrationSource??(!previous?.native&&captured.migration?originalSnapshot:undefined);
      const snapshot=previous?.native&&originalSnapshot?.events.length===0?originalSnapshot:{header:captured.header,events:[]};
      const record:AgentSessionRecord={...input.owner,...(previous?.delegation?{delegation:previous.delegation}:{}),...(previous?.inheritedFrom?{inheritedFrom:previous.inheritedFrom}:{}),status:previous?.status??'open',...(previous?.invalidation?{invalidation:previous.invalidation}:{}),...(previous?.previousSessionId?{previousSessionId:previous.previousSessionId}:{}),createdAt:previous?.createdAt??now,updatedAt:now,native:captured,material:{kind:'agent-session-v1',snapshot,material:captureSources(sources.material),dependencyStamp:sources.dependencyStamp,...(migrationSource?{migrationSource}:{}),...(previous?.material?.delegatedResult?{delegatedResult:previous.material.delegatedResult}:{}),...(previous?.material?.inheritedMaterial?{inheritedMaterial:previous.material.inheritedMaterial}:{})}};
      if(previous){if(previous.material?.snapshot===snapshot)registerAgentSessionAppend(previous,record,[]);else registerNativeSessionProjection(previous,record);}await input.save(record);
    });},
    async load(id){if(id!==nativeId)throw Error('Agent会话身份不符');const record=await loaded();return record?.material?structuredClone(record.material.snapshot):undefined;},
    create(id,snapshot){const captured=structuredClone(snapshot);return serial(async()=>{if(id!==nativeId)throw Error('Agent会话身份已变化');const previous=await loaded();if(previous){if(JSON.stringify(previous.material!.snapshot)===JSON.stringify(captured))return;throw Error('Agent会话已存在');}if((captured.header as {id?:string})?.id!==id||!Array.isArray(captured.events)||captured.events.some((event,index)=>(event as {seq?:unknown})?.seq!==index))throw Error('Agent事件保存序列无效');await write(captured);});},
    append(id,expectedCount,events){const captured=structuredClone(events);return serial(async()=>{
      const record=await loaded();if(id!==nativeId||!record?.material||!Number.isSafeInteger(expectedCount)||expectedCount<0)throw Error('Agent事件保存前缀已变化');
      if(record.status!=='open'&&captured.some(event=>!['tool/result','step/end','turn/end','yixu/terminal-result'].includes(String((event as {type?:unknown})?.type))))throw Error('封闭会话只可追加原工具收妥尾部，不能新增模型工作');
      if(captured.some((event,index)=>(event as {seq?:unknown})?.seq!==expectedCount+index))throw Error('Agent事件保存序列无效');
      const previous=record.material.snapshot.events;
      if(previous.length!==expectedCount){if(previous.length>=expectedCount+captured.length&&JSON.stringify(previous.slice(expectedCount,expectedCount+captured.length))===JSON.stringify(captured))return;throw Error('Agent事件保存前缀已变化');}
      if(!captured.length)return;
      await write({header:record.material.snapshot.header,events:[...previous,...captured]},record,captured);
    });}
  };
}

export class AgentSessionSourceChangedError extends Error{}
export function assertAgentSessionUsable(state:State,record:AgentSessionRecord,scope?:{bookId:string;version:string;ranges:readonly Range[]}):void{
  const currentBook=state.books.find(b=>b.id===record.bookId),book=currentBook&&resolveBookVersion(currentBook,record.version),body=record.material;
  if(record.status!=='open'||record.partnerId!==state.partnerId||!book||!body||body.kind!=='agent-session-v1'||!Array.isArray(body.snapshot.events))throw Error('Agent原会话或材料不可接续');
  validateMaterialProjection(state,book,body.material);
  if(body.inheritedMaterial){validateMaterialProjection(state,book,body.inheritedMaterial);if(!isEvidenceAllowed(book,body.inheritedMaterial.refs)||body.inheritedMaterial.originalRanges.some(range=>!covers(book.known,range)))throw Error('继承讨论的原始许可已经变化');}
  if(scope&&(scope.bookId!==book.id||scope.version!==book.version&&(!currentBook||scope.version!==currentBook.version||!bookVersionAllowsRanges(currentBook,record.version,scope.ranges))))throw Error('Agent临时许可不属于本书版本');
  const extra=scope?.ranges??[],allowed=mergeRanges([...book.known,...extra]);
  if(!isEvidenceAllowed(book,body.material.refs,extra)||body.material.originalRanges.some(r=>!covers(allowed,r)))throw Error('Agent原会话的原文许可已经变化');
  if(!dependencyStampsEqual(state,body.material,queryMaterialStamp(state,body.material),body.dependencyStamp))throw new AgentSessionSourceChangedError('Agent原会话的形成来源已经变化');
}

export function validateAgentSessionHeaders(state:State):void{
  validateConversationContexts(state);
  const seen=new Set<string>();
  for(const record of state.agentSessions??[]){
    if(!record||!record.id||seen.has(record.id)||!state.books.some(b=>b.id===record.bookId&&bookVersionPrefixLength(b,record.version)!==undefined)||!state.partners.some(p=>p.id===record.partnerId)||typeof record.taskKey!=='string'||!record.taskKey||!['open','complete','invalidated'].includes(record.status)||![record.createdAt,record.updatedAt].every(n=>Number.isFinite(n)&&n>=0)||!record.material&&!record.materialRef)throw Error('Agent会话的任务归属或保存身份无效');
    if(record.status==='invalidated'&&(!record.invalidation||!['permission','correction','forgotten','source','not-dispatched'].includes(record.invalidation.reason)||!Number.isFinite(record.invalidation.at)||record.invalidation.at<0)||record.status!=='invalidated'&&record.invalidation)throw Error('Agent失效原因或状态无效');
    if(record.previousSessionId){const previous=state.agentSessions?.find(item=>item.id===record.previousSessionId);if(!previous||previous.id===record.id||previous.status!=='invalidated'||previous.bookId!==record.bookId||previous.version!==record.version||previous.partnerId!==record.partnerId||previous.taskKey!==record.taskKey)throw Error('清洁会话须关联同一原任务的失效会话');}
    if(record.delegation){const delegated=record.delegation,parent=state.agentSessions?.find(item=>item.id===delegated.parentSessionId);
      if(!delegated.authority||!Array.isArray(delegated.authority.ranges)||delegated.authority.ranges.some(range=>!Number.isSafeInteger(range.start)||!Number.isSafeInteger(range.end)||range.start<0||range.end<=range.start))throw Error('子任务委派许可上限无效');
      if(delegated.dependencies&&(!Array.isArray(delegated.dependencies)||delegated.dependencies.some(item=>typeof item.childSessionId!=='string'||!item.childSessionId||typeof item.resultRef!=='string'||!item.resultRef)))throw Error('子任务依赖结果引用无效');
      if(delegated.context!==undefined&&!['fresh','inherit-completed'].includes(delegated.context)||delegated.context==='inherit-completed'&&(typeof delegated.inheritedPresetId!=='string'||!delegated.inheritedPresetId)||delegated.context!=='inherit-completed'&&delegated.inheritedPresetId!==undefined)throw Error('子任务继承上下文与真实预设身份无效');
      if(delegated.presetId!==undefined&&(typeof delegated.presetId!=='string'||!delegated.presetId))throw Error('子任务真实预设身份无效');
      if(delegated.context==='inherit-completed'&&(!record.inheritedFrom||record.inheritedFrom.parentSessionId!==delegated.parentSessionId||!Number.isSafeInteger(record.inheritedFrom.eventCount)||record.inheritedFrom.eventCount<1||!!record.material&&!record.material.inheritedMaterial)||delegated.context!=='inherit-completed'&&!!record.inheritedFrom)throw Error('子任务继承历史缺少冻结的真实前缀来源');
      if(delegated.authorizedService){const service=delegated.authorizedService;if('apiKey'in service||'secretRef'in service||typeof service.id!=='string'||!service.id||typeof service.model!=='string'||!service.model||typeof service.baseUrl!=='string'||!Number.isSafeInteger(service.contextLimit)||service.contextLimit<1||!Number.isSafeInteger(service.maxOutput)||service.maxOutput<1||typeof service.effort!=='string')throw Error('子任务原授权模型条件无效');}
      if(!parent||parent.id===record.id||parent.bookId!==record.bookId||parent.version!==record.version||parent.partnerId!==record.partnerId||parent.taskKey!==record.taskKey||![delegated.operationKey,delegated.prompt,delegated.label].every(value=>typeof value==='string'&&value.length>0)||!['caller','parent'].includes(delegated.delivery)||!['prepared','accepted','result-received','complete','failed','unknown'].includes(delegated.status)||delegated.acceptedMessageId!==undefined&&(typeof delegated.acceptedMessageId!=='string'||!delegated.acceptedMessageId)||delegated.resultRef!==undefined&&(typeof delegated.resultRef!=='string'||!delegated.resultRef)||delegated.stopReason!==undefined&&typeof delegated.stopReason!=='string')throw Error('子任务的原责任或交付身份无效');
    }
    seen.add(record.id);
    const nativeId=record.nativeSessionId??record.id;
    if(record.nativeSessionId!==undefined&&(typeof record.nativeSessionId!=='string'||!record.nativeSessionId)||record.nativeStartEventCount!==undefined&&(!Number.isSafeInteger(record.nativeStartEventCount)||record.nativeStartEventCount<0||!record.native||record.nativeStartEventCount>record.native.eventCount))throw Error('Agent任务的原生上下文身份或接续起点无效');
    if(record.native)validateNativeSessionReference(record.native,nativeId);
    for(const call of record.native?.calls??[]){const attempts=state.usage.filter(usage=>usage.agentCallId===call.agentCallId&&(call.taskExecutionId?usage.agentSessionId===call.taskExecutionId:call.boundarySeq<(record.nativeStartEventCount??0)?usage.id===call.requestId:usage.agentSessionId===record.id));if(call.requestId&&!attempts.some(usage=>usage.id===call.requestId)||call.notDispatched&&attempts.some(usage=>usage.dispatchState!=='not-dispatched')||attempts.some(usage=>usage.nativeSessionId!==undefined&&usage.nativeSessionId!==nativeId))throw Error('原生调用关联与原用量账本不一致');}
    if(record.materialRef)validateTaskMaterialRef(record.materialRef);
    if(record.material&&(record.material.kind!=='agent-session-v1'||!record.material.snapshot||!Array.isArray(record.material.snapshot.events)||!record.material.material||typeof record.material.dependencyStamp!=='string'))throw Error('Agent会话事件或领域材料无效');
    if(record.material?.spillBodies){const locators=new Set<string>();for(const body of record.material.spillBodies){if(body.kind!=='agent-session-spill-v1'||typeof body.text!=='string'||locators.has(body.locator)||new TextEncoder().encode(body.text).length!==body.bytes||!record.native?.spills?.some(entry=>entry.locator===body.locator&&entry.hash===body.hash&&entry.bytes===body.bytes))throw Error('导入长结果正文与原生来源索引不符');locators.add(body.locator);}}
    if(record.material?.delegatedResult){const {operation:op,result}=record.material.delegatedResult,usage=state.usage.find(item=>item.id===op.requestId);
      if(!record.delegation||op.agentSessionId!==record.id||op.key!==JSON.stringify([op.agentSessionId,op.requestId??op.agentCallId,op.toolCallId??'terminal'])||!usage||usage.agentSessionId!==record.id||usage.agentCallId!==op.agentCallId||usage.status!=='complete'||usage.dispatchState!=='response-received'||typeof result.conclusion!=='string'||!result.conclusion.trim()||typeof result.resultRef!=='string'||!result.resultRef)throw Error('子任务结果没有已结算的原操作身份');
    }
  }
  for(const usage of state.usage){
    if(!!usage.agentSessionId!==!!usage.agentCallId)throw Error('Agent派发的会话与调用身份须成对保存');
    if(usage.taskExecutionId!==undefined&&usage.taskExecutionId!==usage.agentSessionId)throw Error('Agent派发的执行任务与原回执归属不符');
    const task=usage.agentSessionId&&state.agentSessions?.find(record=>record.id===usage.agentSessionId);
    if(usage.nativeSessionId!==undefined&&(typeof usage.nativeSessionId!=='string'||!usage.nativeSessionId||task&&(task.nativeSessionId??task.id)!==usage.nativeSessionId))throw Error('Agent派发的原生上下文与执行任务不符');
    const active=state.maintenanceJobs?.some(j=>j.pendingDispatch?.usageId===usage.id)||(state.queryCheckpoints??[]).some(q=>q.status!=='consumed'&&(q.pendingReceipt?.usageId===usage.id||q.usageIds.at(-1)===usage.id));
    if(active&&usage.agentSessionId&&!seen.has(usage.agentSessionId))throw Error('活动Agent派发的原会话尚未保存');
  }
}
