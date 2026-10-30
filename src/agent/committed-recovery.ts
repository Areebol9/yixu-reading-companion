import type {Context} from '@deepseek-ai/cordis';
import {SessionId,SessionSeq,interruptedTurnClosers} from '@deepseek-ai/dsh-session';
import type {SessionEvent} from '@deepseek-ai/dsh-session';
import {createToolResultMessage,ToolCallId} from '@deepseek-ai/dsh-llm';
import type {SessionHandle} from '@deepseek-ai/dsh-session-persistence';
import {readingFeedback} from '../core/reading-output.ts';
import type {ReadingEngine} from '../core/engine.ts';
import type {AgentOperation,NativeSessionReference,NativeCallLink} from '../core/agent-port.ts';
import {nativeSessionHeadersEqual} from '../core/agent-port.ts';

type Assistant=SessionEvent<'assistant/message'>;
type Call=SessionEvent<'tool/call'>;
export type CommittedRecoveryReport={sessionId:string;toolResults:number;closers:number;eventCount:number;error?:string};

/** Inspect only the final open turn; balanced histories require just their final batch. */
async function openTail(handle:SessionHandle,count:number):Promise<SessionEvent[]>{
  let offset=count,tail:SessionEvent[]=[];
  while(offset>0){
    const start=Math.max(0,offset-256),read=await handle.read(start,offset-start);
    if(read.events.length!==offset-start||read.events.some((event,index)=>event.seq!==start+index))throw Error('原生冷恢复日志前缀不连续');
    for(let index=read.events.length-1;index>=0;index--){const event=read.events[index];
      if(event.type==='turn/end')return[];
      if(event.type==='turn/start')return[...read.events.slice(index),...tail];
    }
    tail=[...read.events,...tail];offset=start;
  }
  return[];
}
function nativeCall(reference:NativeSessionReference,event:Assistant,count:number):NativeCallLink|undefined{
  const matches=reference.calls.filter((call,index)=>!call.notDispatched&&!call.purpose&&(call.resultSeq!==undefined?call.resultSeq===event.seq:call.boundarySeq<=event.seq&&event.seq<(reference.calls[index+1]?.boundarySeq??count)));
  if(matches.length>1)throw Error('原生答复对应多个领域调用，未猜测原身份');return matches[0];
}
const operation=(sessionId:string,call:NativeCallLink,toolCallId?:string):AgentOperation=>({agentSessionId:sessionId,agentCallId:call.agentCallId,...(call.requestId?{requestId:call.requestId}:{}),...(toolCallId?{toolCallId}:{}),key:JSON.stringify([sessionId,call.requestId??call.agentCallId,toolCallId??'terminal'])});
function assistantFor(events:SessionEvent[],call:Call):Assistant{
  const matches=events.filter((event):event is Assistant=>event.type==='assistant/message'&&event.data.turn===call.data.turn&&event.data.step===call.data.step&&event.data.message.content.some(block=>block.type==='tool-call'&&block.id===call.data.callId&&block.name===call.data.name&&block.arguments===call.data.arguments));
  if(matches.length!==1)throw Error('原工具调用缺少唯一已保存的assistant调用来源');return matches[0];
}

/**
 * Domain receipt reconciliation precedes upstream's interrupted-turn repair.
 * The caller already owns the cold archive; this function never creates an Agent.
 */
export async function recoverCommittedSessions(input:{context:Context;engine:ReadingEngine;projectDirectory:(bookId:string)=>Promise<string>}):Promise<CommittedRecoveryReport[]>{
  const {context:ctx,engine}=input,reports:CommittedRecoveryReport[]=[];
  for(const record of [...engine.state.agentSessions??[]]){
    if(!record.native||record.status==='invalidated'||record.native.closedEventCount===record.native.eventCount||ctx.agents.get(SessionId(record.id)))continue;
    const reference=structuredClone(record.native),report:CommittedRecoveryReport={sessionId:record.id,toolResults:0,closers:0,eventCount:reference.eventCount};
    try{
      const directory=await input.projectDirectory(record.bookId);
      if((reference.header as {cwd?:string}).cwd!==directory)throw Error('原native会话尚未对应本书工程，未重写原头或接管');
      await using handle=await ctx.sessionPersistence.open(SessionId(record.id),'write');
      if(!nativeSessionHeadersEqual(handle.header,reference.header))throw Error('原生冷恢复头与领域引用不符');
      const stat=await ctx.sessionPersistence.stat(SessionId(record.id));
      const nativeCount=stat?.eventCount;
      if(typeof nativeCount!=='number'||!Number.isFinite(nativeCount)||!Number.isSafeInteger(nativeCount)||nativeCount<reference.eventCount)throw Error('原生冷恢复日志低于已确认水位或水位无效');
      const tail=await openTail(handle,nativeCount),results=tail.filter((event):event is SessionEvent<'tool/result'>=>event.type==='tool/result');
      const additions:SessionEvent[]=[];let committed=false;
      for(const call of tail.filter((event):event is Call=>event.type==='tool/call')){
        // Existing success/error/UNKNOWN/NOT_STARTED records are all immutable.
        const existing=results.filter(event=>event.data.message.source.callId===call.data.callId);
        if(existing.length>1)throw Error('原工具已有多个结果，未替换或猜测原状态');
        if(existing[0]?.data.message.isError||existing[0]?.data.error)continue;
        const assistant=assistantFor(tail,call),link=nativeCall(reference,assistant,nativeCount);if(!link?.requestId)continue;
        const usage=engine.state.usage.find(value=>value.id===link.requestId);
        if(!usage||usage.status!=='complete'||usage.dispatchState!=='response-received'||usage.modelOutcome)continue;
        const resolved=await engine.resolveCommittedOperation(operation(record.id,link,String(call.data.callId)));if(!resolved)continue;
        const raw='toolCalls'in resolved.response?resolved.response.toolCalls.filter(value=>value.id===call.data.callId):[];
        if(raw.length!==1||raw[0].function.name!==call.data.name||raw[0].function.arguments!==call.data.arguments)throw Error('领域原回执与真实工具调用字节不符');
        let value:unknown;
        if(['finish_reading','express_reaction'].includes(call.data.name)){
          if(!resolved.receipt)throw Error('阅读出口缺少原领域接纳回执');value=readingFeedback(resolved.receipt.acceptance);
        }else if(['submit_reading','submit_review'].includes(call.data.name))value={accepted:true};
        else throw Error('已提交原工具的反馈渲染合同尚未声明：'+call.data.name);
        if(existing.length){committed=true;continue;}
        additions.push({type:'tool/result',seq:SessionSeq(nativeCount+additions.length),time:Date.now(),data:{turn:call.data.turn,step:call.data.step,message:createToolResultMessage({callId:ToolCallId(String(call.data.callId)),content:[{type:'text',text:JSON.stringify(value)}],isError:false})},surfaceOp:'append',sourceEventSeqs:[call.seq]});
        committed=true;
      }
      // Natural terminal acceptance has no real tool/call. Confirm its receipt,
      // then close its original turn without inventing a call/result pair.
      if(!committed)for(const assistant of tail.filter((event):event is Assistant=>event.type==='assistant/message'&&!event.data.message.content.some(block=>block.type==='tool-call'))){
        const link=nativeCall(reference,assistant,nativeCount);if(!link?.requestId)continue;
        const usage=engine.state.usage.find(value=>value.id===link.requestId);if(!usage||usage.status!=='complete'||usage.dispatchState!=='response-received'||usage.modelOutcome)continue;
        const resolved=await engine.resolveCommittedOperation(operation(record.id,link));if(!resolved)continue;
        const text=assistant.data.message.content.filter(block=>block.type==='text').map(block=>block.text).join('');
        if(text!==resolved.response.content)throw Error('自然终态与领域原答不符');committed=true;
      }
      let closers:SessionEvent[]=[];
      if(committed){
        closers=interruptedTurnClosers([...tail,...additions]);
        if(additions.length||closers.length)await handle.append([...additions,...closers]);
      }
      const eventCount=nativeCount+additions.length+closers.length;
      const last=closers.at(-1)??additions.at(-1)??tail.at(-1)??(nativeCount?(await handle.read(nativeCount-1,1)).events[0]:undefined);
      const closed=last?.type==='turn/end';
      if(eventCount>reference.eventCount||closed&&reference.closedEventCount!==eventCount){await handle.flush();await engine.acknowledgeNativeRecovery(record.id,reference.eventCount,eventCount,closed);}
      Object.assign(report,{toolResults:additions.length,closers:closers.length,eventCount});
    }catch(error){report.error=error instanceof Error?error.message:String(error);}
    reports.push(report);
  }
  return reports;
}
