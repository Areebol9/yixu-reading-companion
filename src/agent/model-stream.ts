import {ToolCallId} from '@deepseek-ai/dsh-llm';
import type {ContentBlock,StreamChunk} from '@deepseek-ai/dsh-llm';
import type {AgentModelReply} from '../core/types.ts';
import type {ModelStreamDelta,ModelStreamObserver} from '../core/provider-stream.ts';

/** Drain actual arrivals while the request is pending. Rejection is observed
 * immediately and rethrown after its already received private deltas. */
export async function* receiveModelStream<T>(request:(observe:ModelStreamObserver)=>Promise<T>):AsyncGenerator<ModelStreamDelta,T>{
  const queue:ModelStreamDelta[]=[];let wake:(()=>void)|undefined,settled=false,result:T|undefined,failure:unknown,failed=false;
  const pending=Promise.resolve().then(()=>request(delta=>{queue.push(delta);wake?.();})).then(value=>{result=value;},error=>{failure=error;failed=true;}).finally(()=>{settled=true;wake?.();});
  try{for(;;){while(queue.length)yield queue.shift()!;if(settled)break;await new Promise<void>(resolve=>{wake=resolve;});wake=undefined;}if(failed)throw failure;return result!;}
  finally{await pending;}
}

/** Official DSH BlockAssembler consumes these exact block/delta carriers. A
 * block-end and finish are withheld until the host has validated the receipt. */
export class IncrementalModelBlocks {
  private readonly entries=new Map<string,{index:number;type:'text'|'reasoning'|'tool-call';id?:string;name?:string;arguments:string}>();
  push(delta:ModelStreamDelta):StreamChunk[]{
    const key=delta.type==='tool-call'?'tool:'+delta.index:delta.type,prior=this.entries.get(key),chunks:StreamChunk[]=[];
    const entry=prior??{index:this.entries.size,type:delta.type,arguments:''};
    if(!prior){this.entries.set(key,entry);chunks.push({type:'block-start',index:entry.index,blockType:delta.type});}
    if(delta.type==='tool-call'){
      const hadId=!!entry.id;
      if(delta.id!==undefined)entry.id=delta.id;if(delta.name!==undefined)entry.name=(entry.name??'')+delta.name;entry.arguments+=delta.argumentsDelta;
      // The native type requires an ID; no invented ID crosses this boundary.
      // Rare providers that send arguments before the ID retain them until it arrives.
      if(entry.id){chunks.push({type:'tool-call-delta',index:entry.index,id:ToolCallId(entry.id),...(entry.name?{name:entry.name}:{}),argumentsDelta:hadId?delta.argumentsDelta:entry.arguments});}
    }else chunks.push({type:delta.type==='text'?'text-delta':'reasoning-delta',index:entry.index,text:delta.text});
    return chunks;
  }
  finish(response:AgentModelReply):StreamChunk[]{
    const blocks:{key:string;block:ContentBlock}[]=[];
    if(response.reasoning)blocks.push({key:'reasoning',block:{type:'reasoning',text:response.reasoning}});
    if(response.content)blocks.push({key:'text',block:{type:'text',text:response.content}});
    for(const [index,call]of response.toolCalls.entries())blocks.push({key:'tool:'+index,block:{type:'tool-call',id:ToolCallId(call.id),name:call.function.name,arguments:call.function.arguments}});
    const keys=new Set(blocks.map(item=>item.key));
    // DSH assembles open tool blocks on normal completion, so a malformed final
    // carrier must fail the attempt rather than accidentally execute its prefix.
    if(response.rawTerminal?.finishReason!=='length'&&[...this.entries].some(([key,entry])=>entry.type==='tool-call'&&!keys.has(key)))throw Error('流式工具片段未取得完整合法原答，未执行工具');
    const chunks:StreamChunk[]=[];
    for(const {key,block}of blocks){
      const prior=this.entries.get(key),index=prior?.index??this.entries.size;
      if(!prior){this.entries.set(key,{index,type:block.type as 'text'|'reasoning'|'tool-call',arguments:''});chunks.push({type:'block-start',index,blockType:block.type});
        if(block.type==='text'||block.type==='reasoning')chunks.push({type:block.type==='text'?'text-delta':'reasoning-delta',index,text:block.text});
        else if(block.type==='tool-call')chunks.push({type:'tool-call-delta',index,id:block.id,name:block.name,argumentsDelta:block.arguments});
      }
      chunks.push({type:'block-end',index,block});
    }
    return chunks;
  }
}
