import type {AgentReadTool} from '../core/agent-port.ts';
import type {Context} from '@deepseek-ai/cordis';
import {ToolOutputError,validateJsonSchemaValue} from '@deepseek-ai/dsh-tools';
import type {ToolExecution,ToolDefinition} from '@deepseek-ai/dsh-tools';
import {deepFreeze,snapshotJsonValue} from '@deepseek-ai/dsh-util-values';
import type {JsonValue} from '@deepseek-ai/dsh-util-values';

/** Candidates are private to their tool call; never freeze domain-owned records. */
function freezeCandidate(value:unknown):unknown {
  if(value&&typeof value==='object'){
    if(!Array.isArray(value)&&Object.getPrototypeOf(value)!==Object.prototype)throw Error('读取候选须为独立JSON资料');
    for(const child of Object.values(value))freezeCandidate(child);
    Object.freeze(value);
  }
  return value;
}

/** DSH's ordered post-execute is the owner; no second scheduler or tool loop. */
export function installReadToolOwner(scope:Context,agent:ToolExecution['agent'],checkpoint:()=>Promise<void>,assertOpen:(signal:AbortSignal)=>void,output:ToolDefinition['output']){
  const pending=new Map<ToolExecution['token'],{read:AgentReadTool;candidate:unknown;signal:AbortSignal}>();
  scope.on('tools/post-execute',async(execution,result,next)=>{
    const prepared=pending.get(execution.token);
    if(execution.agent!==agent||!prepared)return next();
    pending.delete(execution.token);
    const decision=await next();
    if(result.isError||decision.kind!=='accept'||Object.hasOwn(decision,'content')||Object.hasOwn(decision,'value'))return decision;
    await checkpoint();assertOpen(prepared.signal);assertOpen(execution.signal);
    const value=snapshotJsonValue(await prepared.read.apply(prepared.candidate,prepared.signal));
    if(value===undefined)throw new ToolOutputError(execution.name,['value is not lossless JSON']);
    const violations=validateJsonSchemaValue(output.schema,value as JsonValue,'value');
    if(violations.length)throw new ToolOutputError(execution.name,violations);
    await checkpoint();assertOpen(prepared.signal);assertOpen(execution.signal);
    // Native root calls need content so the outer official spill policy can
    // still bound it. PTC needs its real value; its official dispatch-log hook
    // owns text spilling after ordered finalization, without delaying bindings.
    if(execution.parent!==undefined)return {kind:'accept',value:value as JsonValue,additionalContexts:decision.additionalContexts};
    const content=snapshotJsonValue(output.render(execution.arguments,deepFreeze(value as JsonValue)));
    if(content===undefined)throw new ToolOutputError(execution.name,['output.render returned non-lossless JSON']);
    return {kind:'accept',content,additionalContexts:decision.additionalContexts};
  });
  scope.on('tools/result',execution=>{if(execution.agent===agent)pending.delete(execution.token);});
  return async(read:AgentReadTool,args:unknown,execution:ToolExecution)=>{
    assertOpen(execution.signal);
    const candidate=freezeCandidate(await read.prepare(args,execution.signal));
    assertOpen(execution.signal);
    pending.set(execution.token,{read,candidate,signal:execution.signal});
    return {prepared:true};
  };
}
