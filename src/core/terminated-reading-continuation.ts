import {hashText} from './text-hash.ts';
import type {ModelMessage,ModelTool,Range,State,Usage} from './types.ts';

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
};
export type ReadingContinuationAudit = {
  unknownUsageId:string;requestKey:string;maxCalls:6|'host-admitted';
  payloadScheme:typeof readingPayloadScheme;originalPayloadHash:string;
  terminationEvidence:string;payloadEvidence:string;
};

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
    if(chain.length){const claim=chain[0].maintenanceDispatch!.claim;if(['ranges','chatIds','viewTargets','viewReviewRanges','sceneRecordIds','viewReviewVersion'].some(key=>JSON.stringify(d.claim[key as keyof typeof claim])!==JSON.stringify(claim[key as keyof typeof claim])))throw Error('维护祖先接续不能改变原消费范围、交流或概要目标');}
    chain.push(usage);edge=usage.terminatedReadingContinuation;
  }
  return chain;
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
export function ordinaryReadingTask(requestKey:string):{bookId:string;version:string;partnerId:string;ranges:Range[]}|undefined {
  try{
    const key:unknown=JSON.parse(requestKey);
    if(!Array.isArray(key)||![5,6,7,8].includes(key.length)||key.slice(0,3).some(v=>typeof v!=='string'||!v)||!['reading','preparation'].includes(key[3])||!Array.isArray(key[4])||!key[4].length||key.length>=6&&(typeof key[5]!=='string'||!key[5])||key.length===7&&(key[5]!=='scene'||!Array.isArray(key[6])||!key[6].length||key[6].some((v:unknown)=>typeof v!=='string'||!v)||new Set(key[6]).size!==key[6].length||JSON.stringify(key[6])!==JSON.stringify([...key[6]].sort()))||key.length===8&&(key[5]!=='maintenance'||typeof key[6]!=='string'||!key[6]||typeof key[7]!=='string'||!/^[a-f0-9]{64}$/.test(key[7])))return;
    const ranges=key[4];
    if(ranges.some(r=>!r||!Number.isSafeInteger(r.start)||!Number.isSafeInteger(r.end)||r.start<0||r.end<=r.start))return;
    return {bookId:key[0],version:key[1],partnerId:key[2],ranges:ranges.map(({start,end})=>({start,end}))};
  }catch{return;}
}
