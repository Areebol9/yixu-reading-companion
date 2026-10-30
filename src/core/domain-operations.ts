import type {AgentOperation} from './agent-port.ts';
import type {DomainOperationReceipt,State,Store,Usage} from './types.ts';
import {resolveStorageMaterials} from './storage-records.ts';

/** The native tool identity points at an already settled paid response. It
 * never grants a new dispatch or closes an ancestor's unknown reservation. */
export function operationUsage(state:State,operation:AgentOperation):Usage{
  const expected=JSON.stringify([operation.agentSessionId,operation.requestId??operation.agentCallId,operation.toolCallId??'terminal']);
  const usage=state.usage.find(usage=>usage.id===operation.requestId);
  if(!usage||operation.key!==expected||usage.agentSessionId!==operation.agentSessionId||usage.agentCallId!==operation.agentCallId||usage.status!=='complete'||usage.dispatchState!=='response-received'||usage.modelOutcome)throw Error('领域操作未对应本任务已结算的真实原调用');
  return usage;
}
export async function recoverDomainOperation(state:State,operation:AgentOperation,read?:Store['readTaskMaterials']):Promise<DomainOperationReceipt|undefined>{
  const usage=operationUsage(state,operation);if(!usage.agentResponse)return;
  await resolveStorageMaterials([usage.agentResponse],read);
  const receipt=usage.agentResponse.material?.operations?.find(receipt=>receipt.operation.key===operation.key);
  if(receipt&&(['key','agentSessionId','agentCallId','requestId','toolCallId'] as const).some(key=>receipt.operation[key]!==operation[key]))throw Error('领域操作键与原工具回执身份不符');
  return receipt;
}
