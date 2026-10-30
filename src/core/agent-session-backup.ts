import type {AgentSessionRecord,State,Store} from './types.ts';
import {resolveStorageMaterials,validateTaskMaterialRef} from './storage-records.ts';
import type {NativeSessionReference,AgentSessionSnapshot} from './agent-port.ts';
import {validateNativeSessionReference} from './agent-session-storage.ts';
import {hashText} from './text-hash.ts';
import {bookVersionPrefixLength} from './book-versions.ts';

/** Call on the export copy only. An empty domain placeholder is never a complete native backup. */
export async function resolveNativeAgentSessionsForBackup(state:State,readNative:((reference:NativeSessionReference)=>Promise<AgentSessionSnapshot>)|undefined,readSpills?:Store['readNativeAgentSpills']):Promise<void>{
  for(const record of state.agentSessions??[]){if(!record.native)continue;const nativeId=record.nativeSessionId??record.id;validateNativeSessionReference(record.native,nativeId);if(!readNative)throw Error('正常备份尚未接通原生会话读取端口，未导出不完整日志');if(!record.material)throw Error('原生会话领域来源尚未载入');
    const snapshot=await readNative(record.native);if((snapshot.header as {id?:unknown})?.id!==nativeId||JSON.stringify(snapshot.header)!==JSON.stringify(record.native.header)||snapshot.events.length<record.native.eventCount||snapshot.events.some((event,index)=>(event as {seq?:unknown})?.seq!==index))throw Error('原生备份日志身份或水位不符');
    const spillBodies:NonNullable<NonNullable<AgentSessionRecord['material']>['spillBodies']>=[];
    if(record.native.spills?.length){if(!readSpills)throw Error('正常备份缺少完整长结果读取端口');for await(const body of readSpills(record.native)){let text='';for await(const chunk of body.text)text+=chunk;spillBodies.push({...body,text});}}
    if(record.native.spills?.some(entry=>!spillBodies.some(body=>body.locator===entry.locator&&body.hash===entry.hash&&body.bytes===entry.bytes)))throw Error('正常备份未收齐原生完整长结果');
    record.material={...record.material,snapshot:{header:snapshot.header,events:snapshot.events.slice(0,record.native.eventCount)},...(spillBodies.length?{spillBodies}:{})};delete record.materialRef;
  }
}

const identity=(record:AgentSessionRecord)=>JSON.stringify([record.id,record.bookId,record.version,record.partnerId,record.taskKey,record.createdAt,record.previousSessionId,record.nativeSessionId,record.nativeStartEventCount,record.conversationId,record.contextRole,record.inheritedFrom,record.delegation&&[record.delegation.parentSessionId,record.delegation.operationKey,record.delegation.prompt,record.delegation.label,record.delegation.delivery,record.delegation.context,record.delegation.presetId,record.delegation.inheritedPresetId,record.delegation.dependencies,record.delegation.authority,record.delegation.authorizedService]]);
function delegationProgress(local:AgentSessionRecord,incoming:AgentSessionRecord){
  const a=local.delegation,b=incoming.delegation;if(!a||!b)return{};
  const rank={prepared:0,accepted:1,unknown:2,failed:2,'result-received':3,complete:4};
  if(a.acceptedMessageId&&b.acceptedMessageId&&a.acceptedMessageId!==b.acceptedMessageId||a.resultRef&&b.resultRef&&a.resultRef!==b.resultRef||a.stopReason&&b.stopReason&&a.stopReason!==b.stopReason&&rank[a.status]===rank[b.status])throw Error('子任务交付回执发生冲突');
  const selected=rank[a.status]>=rank[b.status]?a:b;
  return{delegation:{...selected,...(a.acceptedMessageId||b.acceptedMessageId?{acceptedMessageId:a.acceptedMessageId??b.acceptedMessageId}:{}),...(a.resultRef||b.resultRef?{resultRef:a.resultRef??b.resultRef}:{})}};
}
function delegatedMaterial(local:AgentSessionRecord,incoming:AgentSessionRecord){
  const a=local.material?.delegatedResult,b=incoming.material?.delegatedResult;
  if(a&&b&&JSON.stringify(a)!==JSON.stringify(b))throw Error('同一子任务的已提交结果回执冲突');
  return a??b;
}
function inheritedMaterial(local:AgentSessionRecord,incoming:AgentSessionRecord){const a=local.material?.inheritedMaterial,b=incoming.material?.inheritedMaterial;if(a&&b&&JSON.stringify(a)!==JSON.stringify(b))throw Error('同一子任务继承历史的冻结来源冲突');return a??b;}
function lifecycle(local:AgentSessionRecord,incoming:AgentSessionRecord){
  const invalid=[local,incoming].filter(record=>record.status==='invalidated').sort((a,b)=>(b.invalidation?.at??0)-(a.invalidation?.at??0))[0];
  return invalid?{status:'invalidated' as const,invalidation:invalid.invalidation}:local.status==='complete'||incoming.status==='complete'?{status:'complete' as const}:{status:'open' as const};
}

/** A backup may extend the same event stream, never rewrite its saved prefix. */
export async function mergeAgentSessions(target:State,current:State,store:Store):Promise<void>{
  const records=new Map((target.agentSessions??[]).map(record=>[record.id,record]));
  for(const saved of current.agentSessions??[]){
    const book=target.books.find(book=>book.id===saved.bookId);
    if(!book||bookVersionPrefixLength(book,saved.version)===undefined||!target.partners.some(partner=>partner.id===saved.partnerId))continue;
    const local=structuredClone(saved),incoming=records.get(local.id);
    if(!incoming){records.set(local.id,local);continue;}
    if(identity(local)!==identity(incoming))throw Error('同一Agent会话的原任务身份冲突，未覆盖现有存档');
    await resolveStorageMaterials([local],store.readTaskMaterials?.bind(store));
    if(incoming.native){validateNativeSessionReference(incoming.native,incoming.nativeSessionId??incoming.id);if(!incoming.material||incoming.material.snapshot.events.length<incoming.native.eventCount)throw Error('导入档缺少原生会话完整事件，未将占位当成备份');}
    if(local.native&&!incoming.native){if(!incoming.material||await hashText(JSON.stringify(incoming.material.snapshot))!==local.native.migration?.sourceSnapshotHash)throw Error('旧备份与原生迁移来源不一致，未重绑会话');records.set(local.id,{...local,...lifecycle(local,incoming),...delegationProgress(local,incoming)});continue;}
    if(!local.native&&incoming.native){if(await hashText(JSON.stringify(local.material!.snapshot))!==incoming.native.migration?.sourceSnapshotHash)throw Error('原生备份与当前原会话迁移来源不一致');records.set(local.id,{...incoming,...lifecycle(local,incoming),...delegationProgress(local,incoming),updatedAt:Math.max(local.updatedAt,incoming.updatedAt)});continue;}
    if(local.native){if(!store.readNativeAgentSession)throw Error('原生会话合并须先读取权威日志');const snapshot=await store.readNativeAgentSession(local.native);if((snapshot.header as {id?:unknown})?.id!==(local.nativeSessionId??local.id)||JSON.stringify(snapshot.header)!==JSON.stringify(local.native.header)||snapshot.events.length<local.native.eventCount||snapshot.events.some((event,index)=>(event as {seq?:unknown})?.seq!==index))throw Error('本地原生会话的原任务水位或完整前缀不符');local.material={...local.material!,snapshot:{header:snapshot.header,events:snapshot.events.slice(0,local.native.eventCount)}};}
    if(incoming.native&&(!incoming.material||incoming.material.snapshot.events.length<incoming.native.eventCount))throw Error('导入档缺少原生会话完整事件，未将占位当成备份');
    if(local.native&&incoming.native&&JSON.stringify(local.native.header)!==JSON.stringify(incoming.native.header))throw Error('原生会话的原始头冲突');
    const left=local.material!.snapshot,right=incoming.material!.snapshot;
    if(JSON.stringify(left.header)!==JSON.stringify(right.header))throw Error('同一Agent会话的原始头冲突，未覆盖现有存档');
    for(let index=0;index<Math.min(left.events.length,right.events.length);index++){
      if(JSON.stringify(left.events[index])!==JSON.stringify(right.events[index]))throw Error('Agent会话事件出现分叉，原记录保持');
    }
    const selected=left.events.length>=right.events.length?local:incoming,delegatedResult=delegatedMaterial(local,incoming),inherited=inheritedMaterial(local,incoming);
    records.set(local.id,{...selected,...lifecycle(local,incoming),...delegationProgress(local,incoming),...(delegatedResult||inherited?{material:{...selected.material!,...(delegatedResult?{delegatedResult}:{}),...(inherited?{inheritedMaterial:inherited}:{})}}:{}),updatedAt:Math.max(local.updatedAt,incoming.updatedAt)});
  }
  if(records.size||target.agentSessions)target.agentSessions=[...records.values()];
}

/** Raw replies are private evidence; importing them does not execute their tools. */
export function validateAgentResponses(state:State):void{
  for(const usage of state.usage){
    const retained=usage.agentResponse;if(!retained)continue;
    if(!usage.agentSessionId||!usage.agentCallId||usage.status!=='complete'||usage.dispatchState!=='response-received'||!retained.material&&!retained.materialRef)throw Error('Agent原答没有已结算的原调用身份');
    if(retained.materialRef)validateTaskMaterialRef(retained.materialRef);
    if(!retained.material)continue;
    const body=retained.material,response=body.response;
    if(body.kind!=='agent-response-v1'||!response||typeof response.content!=='string'||typeof response.estimated!=='boolean'||![response.input,response.output].every(value=>Number.isSafeInteger(value)&&value>=0)||!Number.isFinite(response.elapsedMs)||response.elapsedMs<0||response.input!==usage.input||response.output!==usage.output||'requestId'in response&&response.requestId!==usage.id)throw Error('Agent原答与已结算用量不符');
    if('toolCalls'in response&&(!Array.isArray(response.toolCalls)||response.toolCalls.some(call=>!call||typeof call.id!=='string'||call.type!=='function'||!call.function||typeof call.function.name!=='string'||typeof call.function.arguments!=='string')))throw Error('Agent原工具调用载体无效');
    const seen=new Set<string>();
    const task=state.agentSessions?.find(record=>record.id===usage.agentSessionId),nativeId=usage.nativeSessionId??task?.nativeSessionId??usage.agentSessionId;
    for(const receipt of body.operations??[]){const op=receipt.operation;
      if(!op||op.agentSessionId!==usage.agentSessionId||op.taskExecutionId!==undefined&&op.taskExecutionId!==(usage.taskExecutionId??usage.agentSessionId)||op.nativeSessionId!==undefined&&op.nativeSessionId!==nativeId||op.agentCallId!==usage.agentCallId||op.requestId!==usage.id||op.key!==JSON.stringify([op.agentSessionId,op.requestId,op.toolCallId??'terminal'])||seen.has(op.key)||!/^[a-f0-9]{64}$/.test(receipt.submissionHash)||!Number.isFinite(receipt.at)||receipt.at<0||!receipt.acceptance||typeof receipt.acceptance.accepted!=='boolean')throw Error('领域操作回执与原调用不符');
      if(op.toolCallId&&(!('toolCalls'in response)||!response.toolCalls.some(call=>call.id===op.toolCallId)))throw Error('领域操作回执缺少真实模型工具调用');
      seen.add(op.key);
    }
  }
}
