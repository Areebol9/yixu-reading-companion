import {mergeRanges} from './books.ts';
import {canonicalMaintenanceViewTargets} from './types.ts';
import type {MaintenanceDispatch,MaintenanceProcessed,State} from './types.ts';

/** Final commitment settles the frozen execution, not every remaining job target. Progress records only the exact
 * saved subset and must never be promoted to that completion flag. */
export function maintenanceProgressFacts(dispatch:MaintenanceDispatch){
  const facts=(dispatch.progress??[]).map(progress=>({at:progress.at,operationKey:progress.operationKey,memoryIds:progress.memoryIds,viewIds:progress.viewIds,processed:progress.processed}));
  if(dispatch.committed){const committed=dispatch.committed;facts.push({at:committed.at,operationKey:'final:'+dispatch.claim.hash,memoryIds:committed.memoryIds,viewIds:committed.viewIds,processed:committed.processed??dispatch.claim});}
  return facts;
}

/** Actual consumption is independent of whether the original request has
 * finished. Legacy final receipts retain their frozen whole-claim meaning. */
export function maintenanceProcessed(dispatch:MaintenanceDispatch):MaintenanceProcessed{
  const facts=maintenanceProgressFacts(dispatch).map(fact=>fact.processed);
  return{ranges:mergeRanges(facts.flatMap(fact=>fact.ranges)),chatIds:[...new Set(facts.flatMap(fact=>fact.chatIds))],sceneRecordIds:[...new Set(facts.flatMap(fact=>fact.sceneRecordIds??[]))],viewTargets:canonicalMaintenanceViewTargets(facts.flatMap(fact=>fact.viewTargets)),viewReviewRanges:mergeRanges(facts.flatMap(fact=>fact.viewReviewRanges??[]))};
}

/** Non-original analysis has no reading-range receipt to carry its later view
 * basis. Retain its exact committed documents under the existing job identity. */
export function maintenanceDocumentSources(state:Pick<State,'usage'>,jobId:string){
  return state.usage.flatMap(usage=>{const dispatch=usage.maintenanceDispatch,committed=dispatch?.committed;
    return dispatch&&committed?.processed&&dispatch.request.maintenanceJobId===jobId&&usage.status==='complete'&&!usage.modelOutcome&&!dispatch.claim.ranges.length&&!dispatch.claim.viewReviewRanges?.length&&(dispatch.claim.chatIds.length||dispatch.claim.sceneRecordIds?.length)&&committed.memoryIds.length?[{...committed,claim:dispatch.claim}]:[];
  });
}
