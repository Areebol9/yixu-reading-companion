import {hashText} from './text-hash.ts';
import type {LocalAttemptFenceIdentity,LocalAttemptFenceTermination,ModelMessage,ModelTool,Range,State,Usage} from './types.ts';

export const readingPayloadScheme='core-reading-messages-tools-v1' as const;
export type TerminatedReadingContinuation = {
  unknownUsageId:string;
  requestKey:string;
  /** Default task allowance, or host batch admission; the unresolved attempt stays counted. */
  maxCalls:6|'host-admitted';
  originalPayload:{messages:ModelMessage[];tools:ModelTool[]};
  terminationEvidence:string;
  /** Host attestation of the original payload, required for legacy usage records. */
  payloadEvidence:string;
  localAttemptFence?:LocalAttemptFenceIdentity;
};
export type ReadingContinuationAudit = {
  unknownUsageId:string;requestKey:string;maxCalls:6|'host-admitted';
  payloadScheme:typeof readingPayloadScheme;originalPayloadHash:string;
  terminationEvidence:string;payloadEvidence:string;
  localAttemptFence?:LocalAttemptFenceIdentity;
};

function fenceIdentity(proof:LocalAttemptFenceIdentity,terminationEvidence:string,payloadEvidence:string,usage:Usage,inputHash:string){
  let certificate:any,payload:any;try{certificate=JSON.parse(terminationEvidence);payload=JSON.parse(payloadEvidence);}catch{throw Error('本地尝试关闭证书不是完整可核验记录');}
  const closed=Date.parse(proof.closedAt),reservation=certificate.originalCoreReservation,hold=certificate.holdReservation;
  if(![proof.cohortId,proof.protocolSHA,proof.fenceSHA].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v))||!Number.isFinite(closed)||closed<usage.time||new Date(closed).toISOString()!==proof.closedAt||certificate.schema!=='local-reading-attempt-fence/v1'||certificate.requestId!==usage.id||certificate.serviceId!==usage.serviceId||certificate.inputHash!==inputHash||certificate.cohortId!==proof.cohortId||certificate.protocolSHA!==proof.protocolSHA||certificate.closedAt!==proof.closedAt||certificate.providerOutcome!=='unknown'||payload.requestId!==usage.id||payload.serviceId!==usage.serviceId||payload.inputHash!==inputHash||!reservation||reservation.inputTokens!==usage.input||reservation.outputTokens!==usage.output||reservation.totalTokens!==usage.input+usage.output||!hold||![hold.inputTokens,hold.outputTokens,hold.totalTokens].every(v=>Number.isSafeInteger(v)&&v>=0)||hold.totalTokens!==hold.inputTokens+hold.outputTokens||hold.inputTokens<reservation.inputTokens||hold.outputTokens<reservation.outputTokens)throw Error('本地尝试关闭证书与原调用、预留或精确输入不符');
  return{certificate,payload};
}
/** This proves a present local fence, never a historical non-dispatch or CLI exit. */
export async function validateLocalAttemptFence(proof:LocalAttemptFenceTermination,usage:Usage,payload:{messages:ModelMessage[];tools:ModelTool[]},inputHash:string):Promise<void>{
  if(proof.kind!=='local-attempt-fence'||proof.providerOutcome!=='unknown'||proof.serviceId!==usage.serviceId)throw Error('本地尝试关闭证书的提供方结果或渠道身份无效');
  const evidence=fenceIdentity(proof,proof.terminationEvidence,proof.payloadEvidence,usage,inputHash);
  const payloadSHA=await hashText(JSON.stringify(payload));
  if(await hashText(proof.terminationEvidence)!==proof.fenceSHA||await readingRequestPayloadHash(payload.messages,payload.tools)!==inputHash||evidence.payload.payloadSHA!==payloadSHA||evidence.certificate.payloadSHA!==payloadSHA)throw Error('本地尝试关闭证书正文或完整输入哈希不符');
}

/** Only persisted, exact maintenance predecessor edges extend a live authorization. */
export function maintenanceContinuationChain(state:State,audit:ReadingContinuationAudit):Usage[]{
  const root:unknown=JSON.parse(audit.requestKey);
  if(!Array.isArray(root)||root.length!==8||root[5]!=='maintenance')return [];
  const chain:Usage[]=[],seen=new Set<string>();let edge:ReadingContinuationAudit|undefined=audit;
  while(edge){
    if(seen.has(edge.unknownUsageId)||edge.requestKey!==audit.requestKey||edge.payloadScheme!==readingPayloadScheme||!/^[a-f0-9]{64}$/.test(edge.originalPayloadHash)||!edge.terminationEvidence?.trim()||!edge.payloadEvidence?.trim()||![6,'host-admitted'].includes(edge.maxCalls))throw Error('维护接续的祖先审计存在环、断边或不一致证明');
    seen.add(edge.unknownUsageId);
    const usage=state.usage.find(u=>u.id===edge!.unknownUsageId),d=usage?.maintenanceDispatch;
    if(!usage||usage.status!=='unknown'||!['dispatch-started','response-received'].includes(usage.dispatchState??'')||usage.questionId||usage.taskId||usage.requestKey!==audit.requestKey||usage.coreReadingPayload?.scheme!==edge.payloadScheme||usage.coreReadingPayload.hash!==edge.originalPayloadHash||!d||d.committed||d.payloadScheme!==edge.payloadScheme||d.payloadHash!==edge.originalPayloadHash||d.request.source!=='reading'||d.request.maintenanceJobId!==root[6]||d.request.maintenanceClaim!==root[7]||d.claim.hash!==root[7]||JSON.stringify(d.request.ranges)!==JSON.stringify(root[4])||!d.material&&!d.materialRef)throw Error('维护接续的祖先调用、原载体或claim身份不完整');
    if(edge.localAttemptFence)fenceIdentity(edge.localAttemptFence,edge.terminationEvidence,edge.payloadEvidence,usage,edge.originalPayloadHash);
    if(chain.length){const claim=chain[0].maintenanceDispatch!.claim;if(['ranges','chatIds','viewTargets','viewReviewRanges','sceneRecordIds','viewReviewVersion'].some(key=>JSON.stringify(d.claim[key as keyof typeof claim])!==JSON.stringify(claim[key as keyof typeof claim])))throw Error('维护祖先接续不能改变原消费范围、交流或概要目标');}
    chain.push(usage);edge=usage.terminatedReadingContinuation;
  }
  return chain;
}

/** Only the durable current dispatch can carry an unconsumed ancestor exception. */
export function pendingMaintenanceContinuation(state:State,requestKey:string):{owner:Usage;ancestors:Usage[]}|undefined{
  let key:any;try{key=JSON.parse(requestKey);}catch{return;}
  if(!Array.isArray(key)||key.length!==8||key[5]!=='maintenance')return;
  const job=state.maintenanceJobs?.find(j=>j.id===key[6]&&j.bookId===key[0]&&j.version===key[1]&&j.partnerId===key[2]),owner=job?.pendingDispatch&&state.usage.find(u=>u.id===job.pendingDispatch!.usageId),audit=owner?.terminatedReadingContinuation,d=owner?.maintenanceDispatch;
  if(!owner||!audit)return;
  if(!d||d.committed||owner.questionId||owner.taskId||owner.requestKey!==requestKey||audit.requestKey!==requestKey||owner.coreReadingPayload?.scheme!==readingPayloadScheme||owner.coreReadingPayload.hash!==d.payloadHash||d.request.maintenanceJobId!==job!.id||d.request.maintenanceClaim!==key[7]||d.claim.hash!==key[7]||JSON.stringify(d.request.ranges)!==JSON.stringify(key[4])||!d.material&&!d.materialRef)throw Error('当前维护owner未保存同claim接续审计，不能豁免旧unknown');
  const ancestors=maintenanceContinuationChain(state,audit);
  if(!ancestors.length||ancestors.some(a=>a.id===owner.id||a.coreReadingPayload!.hash===d.payloadHash||['ranges','chatIds','viewTargets','viewReviewRanges','sceneRecordIds','viewReviewVersion'].some(k=>JSON.stringify(a.maintenanceDispatch!.claim[k as keyof typeof d.claim])!==JSON.stringify(d.claim[k as keyof typeof d.claim]))))throw Error('当前维护后继与已封闭祖先的claim或新调用身份不符');
  return{owner,ancestors};
}

/** Provider uncertainty remains; only a real descendant commit closes domain work. */
export function consumedMaintenanceAncestors(state:State):Usage[]{
  const consumed=new Map<string,Usage>();
  for(const usage of state.usage){
    const dispatch=usage.maintenanceDispatch,audit=usage.terminatedReadingContinuation;
    if(usage.status!=='complete'||usage.dispatchState!=='response-received'||usage.modelOutcome||usage.questionId||usage.taskId||!dispatch?.committed||!audit||usage.requestKey!==audit.requestKey||usage.coreReadingPayload?.scheme!==readingPayloadScheme||dispatch.payloadScheme!==readingPayloadScheme||usage.coreReadingPayload.hash!==dispatch.payloadHash)continue;
    try{
      const key:unknown=JSON.parse(audit.requestKey);
      if(!Array.isArray(key)||key.length!==8||key[5]!=='maintenance'||dispatch.request.maintenanceJobId!==key[6]||dispatch.claim.hash!==key[7]||dispatch.request.maintenanceClaim!==key[7])continue;
      const chain=maintenanceContinuationChain(state,audit);
      if(chain.some(parent=>parent.coreReadingPayload!.hash===dispatch.payloadHash))continue;
      for(const parent of chain)consumed.set(parent.id,parent);
    }catch{ /* An incomplete historical proof never grants a dispatch exception. */ }
  }
  return [...consumed.values()];
}

function canonical(value:unknown):unknown {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,canonical(v)]));
  return value;
}
/** Core input identity. This intentionally excludes provider wire configuration. */
export function readingRequestPayloadText(messages:ModelMessage[],tools:ModelTool[]):string {
  return JSON.stringify(canonical({scheme:readingPayloadScheme,messages,tools}));
}
export function readingRequestPayloadHash(messages:ModelMessage[],tools:ModelTool[]):Promise<string> {
  return hashText(readingRequestPayloadText(messages,tools));
}
export function ordinaryReadingTask(requestKey:string):{bookId:string;version:string;partnerId:string;source:'reading'|'preparation';ranges:Range[];kind?:string;sceneCommentIds?:string[];observationId?:string}|undefined {
  try{
    const key:unknown=JSON.parse(requestKey);
    if(!Array.isArray(key)||![5,6,7,8].includes(key.length)||key.slice(0,3).some(v=>typeof v!=='string'||!v)||!['reading','preparation'].includes(key[3])||!Array.isArray(key[4])||!key[4].length&&!(key.length===8&&key[5]==='maintenance'&&key[3]==='reading')||key.length>=6&&(typeof key[5]!=='string'||!key[5]))return;
    if(key.length===7||key.length===8&&key[5]==='scene'){
      if(key[5]!=='scene'||!Array.isArray(key[6])||key.length===7&&!key[6].length||key[6].some((v:unknown)=>typeof v!=='string'||!v)||new Set(key[6]).size!==key[6].length||JSON.stringify(key[6])!==JSON.stringify([...key[6]].sort())||key.length===8&&(typeof key[7]!=='string'||!/^[a-f0-9]{64}$/.test(key[7])))return;
    }else if(key.length===8&&(key[5]!=='maintenance'||typeof key[6]!=='string'||!key[6]||typeof key[7]!=='string'||!/^[a-f0-9]{64}$/.test(key[7])))return;
    const ranges=key[4];
    if(ranges.some(r=>!r||!Number.isSafeInteger(r.start)||!Number.isSafeInteger(r.end)||r.start<0||r.end<=r.start))return;
    return {bookId:key[0],version:key[1],partnerId:key[2],source:key[3],ranges:ranges.map(({start,end})=>({start,end})),...(key.length>=6?{kind:key[5]}:{}),...(key[5]==='scene'?{sceneCommentIds:key[6]??[],...(key[7]?{observationId:key[7]}:{})}:{})};
  }catch{return;}
}
