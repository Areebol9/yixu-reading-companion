import {IncrementalModelBlocks,receiveModelStream} from './model-stream.ts';
import {readingLengthFeedback,readingLengthRecoveryCheckpoint,readingLengthRecoveryProgress,READING_LENGTH_NO_PROGRESS,READING_SUBMISSION_NO_PROGRESS} from '../core/maintenance-recovery.ts';
import type {ReadingLengthRecoveryCheckpoint} from '../core/maintenance-recovery.ts';
import {Context} from '@deepseek-ai/cordis';
import Timer from '@deepseek-ai/cordis-plugin-timer';
import Projection from '@deepseek-ai/dsh-session-projection';
import Llm,{createUserMessage,createAssistantMessage,createSystemMessage,createToolResultMessage,LlmAdapter,ReasoningEffortId,ToolCallId} from '@deepseek-ai/dsh-llm';
import type {ContentBlock,GenerateOptions,StreamChunk} from '@deepseek-ai/dsh-llm';
import Sessions,{SessionId} from '@deepseek-ai/dsh-session';
import type {Session,SessionSeq} from '@deepseek-ai/dsh-session';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import type {ToolDefinition,ToolRunContext} from '@deepseek-ai/dsh-tools';
import Agent from '@deepseek-ai/dsh-agent';
import type {AgentHandle} from '@deepseek-ai/dsh-agent';
import Loop from '@deepseek-ai/dsh-agent-loop';
import {id} from '../core/books.ts';
import {ModelOutputError} from '../core/model.ts';
import {normalizeReadingSubmission,readingFeedback,readingJsonErrorLocation} from '../core/reading-output.ts';
import type {ReadingAcceptance} from '../core/reading-output.ts';
import {nativeSessionHeadersEqual} from '../core/agent-port.ts';
import type {AgentRunRequest,AgentRunner,AgentOperation,AgentSessionRecovery,AgentSessionStore,AgentSessionSnapshot,NativeSessionReference} from '../core/agent-port.ts';
import type {AgentModelReply,ModelMessage,ModelToolCall} from '../core/types.ts';
import {readingRequestPayloadHash} from '../core/terminated-reading-continuation.ts';
import {ProductSessionPersistence,inspectAgentSession,inspectNativeSession,migrateProductSession,nativeSessionSnapshot,createNativeSessionReader,reconcileNativeResumePrefix,projectCompletedConversationSurface} from './session-persistence.ts';
import {validateStoredEvents,materializeCreateHeader} from '@deepseek-ai/dsh-session-persistence';
import {ReadingCompactionEngine} from './compaction.ts';
import {installTaskCapabilities,waitForNativeTask,allowsTaskPlanning} from './task-capabilities.ts';
import {DelegationCoordinator} from './delegation.ts';
import {scopeOf} from '@deepseek-ai/dsh-scope';
import {installReadToolOwner} from './read-tool-owner.ts';
import {encodeMaterialInput,MATERIAL_CONTINUATION} from '../core/material-input.ts';
import {hashText} from '../core/text-hash.ts';
import {samePhysicalPath} from '../host/path-identity.ts';

/** A normal-save upgrade imports actual transport carriers, without repairing their bytes. */
function bootstrapHistory(session:Session,messages:ModelMessage[],service:AgentRunRequest<unknown>['service'],provider:string):{calls:number;pending:ModelMessage[]}{
  // Only actual returned assistants and their complete tool-result groups are
  // historical. A request's trailing input belongs to the next native turn.
  let lastAssistant=-1;for(let index=messages.length-1;index>=0;index--)if(messages[index].role==='assistant'){lastAssistant=index;break;}
  if(lastAssistant<0)return{calls:0,pending:messages.filter(message=>message.role!=='system')};
  let end=lastAssistant+1;while(messages[end]?.role==='tool')end++;
  const pending=messages.slice(end);if(pending.some(message=>message.role!=='user'))throw Error('原运输历史的待输入不是可接续用户材料');
  let step=0,stepOpen=false,modelCalls=0;const turn=1,calls=new Map<string,ReturnType<Session['append']>['seq']>();
  session.append('turn/start',{turn});
  for(const message of messages.slice(0,end)){
    if(!stepOpen){step++;session.append('step/start',{turn,step});stepOpen=true;}
    if(message.role==='system')session.append('system/message',{turn,step,message:createSystemMessage(message.content)},{surfaceOp:'append'});
    else if(message.role==='user')session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:message.content}]}),{surfaceOp:'append'});
    else if(message.role==='assistant'){
      if(calls.size)throw Error('原运输历史的上一工具结果尚未收齐');modelCalls++;const content:ContentBlock[]=[];
      if(message.reasoning_content)content.push({type:'reasoning',text:message.reasoning_content});if(message.content)content.push({type:'text',text:message.content});
      for(const call of message.tool_calls??[])content.push({type:'tool-call',id:ToolCallId(call.id),name:call.function.name,arguments:call.function.arguments});
      session.append('assistant/message',{turn,step,message:createAssistantMessage({content,source:{provider,model:service.model}}),stream:[]},{surfaceOp:'append'});
      for(const call of message.tool_calls??[]){const event=session.append('tool/call',{turn,step,callId:ToolCallId(call.id),name:call.function.name,arguments:call.function.arguments});calls.set(call.id,event.seq);}
      if(!message.tool_calls?.length){session.append('step/end',{turn,step});stepOpen=false;}
    }else if(message.role==='tool'){
      const callId=message.tool_call_id;if(!callId||!calls.has(callId))throw Error('原运输历史的工具结果缺少实际调用');
      session.append('tool/result',{turn,step,message:createToolResultMessage({callId:ToolCallId(callId),content:[{type:'text',text:message.content}],isError:false})},{surfaceOp:'append',sourceEventSeqs:[calls.get(callId)!]});calls.delete(callId);
      if(!calls.size){session.append('step/end',{turn,step});stepOpen=false;}
    }
  }
  if(calls.size||stepOpen)throw Error('原运输历史仍有未定工具结果，须先核验原请求');
  session.append('turn/end',{turn,reason:{kind:'completed'}});return{calls:modelCalls,pending};
}

export function modelMessages(options:GenerateOptions):ModelMessage[]{
  const messages=options.messages.map(message=>{
    if(message.role==='developer')throw Error('当前Chat Completions渠道未声明原生toolUpdate开发者消息能力');
    let content='',reasoning='';const tool_calls:ModelToolCall[]=[];
    for(const block of message.content){
      if(block.type==='text')content+=block.text;
      else if(block.type==='reasoning'&&message.role==='assistant')reasoning+=block.text;
      else if(block.type==='tool-call'&&message.role==='assistant')tool_calls.push({id:block.id,type:'function',function:{name:block.name,arguments:block.arguments}});
      else if(block.type==='tool-addition'||block.type==='tool-removal')throw Error('当前Chat Completions渠道不支持原生toolUpdate内容');
      else throw Error('当前共读渠道不支持该类Agent内容');
    }
    return{role:message.role,content,...(tool_calls.length?{tool_calls}:{}),...(message.role==='assistant'?{reasoning_content:reasoning}:{}),...(message.role==='tool'?{tool_call_id:message.toolCallId}:{})};
  });
  return options.system?[{role:'system',content:options.system},...messages]:messages;
}

type Received={response:AgentModelReply;agentCallId:string;tools:ReadonlySet<string>;failure?:ModelOutputError};
/** Only provider adaptation lives here. No domain acceptance, tool filtering or added prompts. */
class TaskModel<T> extends LlmAdapter{
  calls=0;nativeSession?:Session;checkpoint?:()=>Promise<void>;reference?:NativeSessionReference;replay?:AgentSessionRecovery;
  readonly recordedCalls=new Set<string>();
  nativeReceiptCall?:string;
  afterDispatch?:(inputTokens:number)=>Promise<void>;
  pruningFailure?:unknown;
  exposureFailure?:unknown;
  last?:Received;failure?:unknown;private readonly replies=new Map<string,Received>();
  constructor(readonly input:AgentRunRequest<T>,private readonly route?:(sessionId:string)=>TaskModel<unknown>|undefined){super();}
  override async resolveModel(provider:string,model:string){const service=this.input.service,effort=ReasoningEffortId(service.effort);return{provider,id:model,name:model,context:{contextWindow:service.contextLimit},defaultMaxTokens:service.maxOutput,reasoning:{efforts:[{id:effort,name:service.effort}],defaultEffort:effort}};}
  received(callId?:string){return callId?this.replies.get(callId):this.last;}
  async *stream(options:GenerateOptions):AsyncIterable<StreamChunk>{
    // In-process spawn inherits the native provider route; the Session owns domain attribution.
    if(options.sessionId&&this.nativeSession&&options.sessionId!==this.nativeSession.id){const child=this.route?.(String(options.sessionId));if(!child||child===this)throw Error('子任务尚未绑定独立领域调用与许可端口');yield*child.stream(options);return;}
    const auxiliary=options.purpose!==undefined;
    if(auxiliary&&!['compaction','session-title'].includes(options.purpose!))throw Error('不支持的Agent辅助用途：'+options.purpose);
    this.input.assertCurrent();options.signal?.throwIfAborted();
    const replay=auxiliary?undefined:this.replay;if(!auxiliary)this.replay=undefined;
    const native=this.nativeSession,agentCallId=replay?.agentCallId??replay?.requestId??id();
    const recorded=this.recordedCalls.has(agentCallId);
    if(!auxiliary&&!recorded)this.calls++;
    if(!auxiliary&&!replay&&typeof this.input.maxCalls==='number'&&this.calls>this.input.maxCalls)throw Error('本轮已达到模型处理次数上限，原记录保留');
    if(native){if(!recorded){const link={agentCallId,ordinal:Math.max(1,this.calls),taskExecutionId:this.input.session?.id??String(native.id),...(options.purpose?{purpose:options.purpose}:{})};if(this.reference)this.reference.calls.push({...link,boundarySeq:native.seq});else native.append('yixu/model-request',link);}await this.checkpoint!();}
    const messages=modelMessages(options),modelTools=(options.tools??[]).map(tool=>({name:tool.name,description:tool.description,parameters:tool.parameters}));
    const surfaceHash=await readingRequestPayloadHash(messages,modelTools),eventSeqs=native?[...native.surface.nodes]:[];
    const liveBlocks=new IncrementalModelBlocks();
    let response:AgentModelReply,failure:ModelOutputError|undefined;
    try{
      if(replay){response=replay.response;if(replay.outcome)failure=new ModelOutputError(replay.outcome.reason,response,replay.outcome.feedbackReason,replay.outcome);}
      else {
        const taskExecutionId=this.input.session?.id??String(options.sessionId??native?.id??'');
        const incoming=receiveModelStream(observe=>this.input.request(messages,modelTools,options.signal!,{agentSessionId:taskExecutionId,taskExecutionId,...(native?{nativeSessionId:String(native.id)}:{}),agentCallId,...(options.purpose?{purpose:options.purpose}:{}),model:options.model,...(options.reasoningEffort?{reasoningEffort:options.reasoningEffort}:{}),...(options.maxTokens!==undefined?{maxTokens:options.maxTokens}:{}),onStream:observe}));
        for(;;){const item=await incoming.next();if(item.done){response=item.value;break;}for(const chunk of liveBlocks.push(item.value))yield chunk;}
      }
    }catch(error){
      if(error instanceof ModelOutputError){failure=error;const raw=error.response as AgentModelReply,terminal=raw.rawTerminal?.message;
        // Partial or structurally invalid calls are evidence, never executable calls.
        response={...raw,reasoning:raw.reasoning??(typeof terminal?.reasoning_content==='string'?terminal.reasoning_content:''),toolCalls:raw.toolCalls??[],finish:raw.toolCalls?.length?'tool_calls':'stop'};
      }else{if(!auxiliary)this.failure=error;const state=native&&await this.input.session?.requestState?.(agentCallId);if(native&&state==='not-dispatched'){if(this.reference)this.reference.calls.find(call=>call.agentCallId===agentCallId)!.notDispatched=true;else native.append('yixu/model-not-dispatched',{agentCallId});if(!auxiliary)this.calls--;await this.checkpoint!();}else if(native&&state==='terminal-no-result'&&this.reference){this.reference.calls.find(call=>call.agentCallId===agentCallId)!.terminalNoResult=true;await this.checkpoint!();}throw error;}
    }
    if(failure){const terminal=response.rawTerminal?.message;response={...response,reasoning:response.reasoning??(typeof terminal?.reasoning_content==='string'?terminal.reasoning_content:''),toolCalls:failure.reason==='reading-output-length'?[]:response.toolCalls??[],finish:failure.reason==='reading-output-length'?'stop':response.finish};}
    this.recordedCalls.add(agentCallId);
    if(!auxiliary)this.failure=undefined;
    if(native){if(!response.requestId)throw Error('已结算模型结果缺少原请求身份');if(this.reference)this.reference.calls.find(call=>call.agentCallId===agentCallId)!.requestId=response.requestId;else native.append('yixu/model-response',{agentCallId,requestId:response.requestId});await this.checkpoint!();}
    if(!replay)try{await this.input.materialExposure?.acknowledge({agentSessionId:this.input.session?.id??String(options.sessionId??native?.id??''),agentCallId,...(response.requestId?{requestId:response.requestId}:{}),...(options.purpose?{purpose:options.purpose}:{}),surfaceHash,eventSeqs},{messages});}catch(error){this.exposureFailure=error;}
    // Post-dispatch retention must never hide an already received original assistant.
    // Surface faults stop the next step after native response recording has completed.
    if(!replay&&!auxiliary)try{await this.afterDispatch?.(response.input);}catch(error){this.pruningFailure=error;}
    this.nativeReceiptCall=agentCallId;
    if(!auxiliary){const received={response,agentCallId,tools:new Set((replay?this.input.resumePayload?.tools??modelTools:modelTools).map(tool=>tool.name)),...(failure?{failure}:{})};this.last=received;for(const call of response.toolCalls)this.replies.set(call.id,received);}
    for(const chunk of liveBlocks.finish(response))yield chunk;
    if(!response.estimated)yield{type:'usage',usage:{inputTokens:response.input,outputTokens:response.output,totalTokens:response.input+response.output}};
    yield{type:'finish',reason:{kind:response.rawTerminal?.finishReason==='length'?'max-tokens':response.finish==='tool_calls'?'tool-calls':'stop'}};
  }
}

export type HarnessRuntimeOptions={context:Context;owned?:boolean}|{legacy:'offline'|'unmigrated-platform'};
const TERMINAL='yixu_accept_terminal';
/** The launcher owns production composition; the explicit legacy option is migration-only. */
export class HarnessRuntime implements AgentRunner{
  private pending?:Promise<Context>;private readonly active=new Set<AgentHandle>();private closing=false;
  private readonly compactors=new Map<string,{agent:AgentHandle['agent'];engine:ReadingCompactionEngine}>();
  private readonly adapters=new Map<string,TaskModel<unknown>>();
  private readonly conversations=new Map<string,AgentHandle>();
  private readonly retiredSessions=new Set<string>();
  constructor(private readonly options?:HarnessRuntimeOptions){}
  /** Explicit host consumer; this task-local engine is not agent.ctx.compaction. */
  async compact(sessionId:string,signal:AbortSignal){const task=this.compactors.get(sessionId);if(!task||this.closing)throw Error('该伴读任务当前没有活动的原生压缩实例');return task.engine.compactNow(task.agent,signal);}
  private async context():Promise<Context>{
    if(!this.options)throw Error('Agent运行须注入正式宿主Context；离线技术须显式选择legacy:offline');
    if('context'in this.options)return this.options.context;
    return this.pending??=(async()=>{const ctx=new Context();try{await ctx.plugin(Timer);await ctx.plugin(Projection);await ctx.plugin(Llm);await ctx.plugin(Sessions);await ctx.plugin(Prompt,{includeHarnessIdentity:false,includeRuntimeContext:false,personaPrefix:''});await ctx.plugin(Tools);await ctx.plugin(Agent);await ctx.plugin(ProductSessionPersistence);await ctx.plugin(Loop,{agents:[],maxParallelToolCalls:2});return ctx;}catch(error){await ctx.fiber.dispose();throw error;}})();
  }
  async retireSession(nativeId:string){
    this.retiredSessions.add(nativeId);
    // Retirement can originate inside this turn's own domain callback. Its
    // caller must return before the turn can drain; finally owns that disposal.
    if(this.adapters.has(nativeId))return;
    const handle=this.conversations.get(nativeId);if(!handle)return;
    this.conversations.delete(nativeId);await handle.dispose();this.active.delete(handle);
  }
  async dispose(){this.closing=true;await Promise.all([...this.active].map(handle=>handle.dispose()));this.active.clear();this.conversations.clear();if(this.options&&('legacy'in this.options||this.options.owned))await(await this.context()).fiber.dispose();}
  async run<T>(input:AgentRunRequest<T>):Promise<T>{return this.runBound(input);}
  /** Native SubagentManager owns this Agent and its prompt/teardown. */
  async bindAttached<T>(input:AgentRunRequest<T>,agent:AgentHandle['agent']){
    let readyResolve!:()=>void,readyReject!:(error:unknown)=>void,admit!:()=>void;
    const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;}),admission=new Promise<void>(resolve=>{admit=resolve;});
    const result=this.runBound(input,{agent,ready:readyResolve,admission});void result.catch(readyReject);await ready;return{admit,result};
  }
  private async runBound<T>(input:AgentRunRequest<T>,attached?:{agent:AgentHandle['agent'];ready():void;admission:Promise<void>}):Promise<T>{
    if(this.closing)throw Error('Agent宿主正在关闭');input.assertCurrent();input.signal.throwIfAborted();
    if(input.maxCalls!=='host-admitted'&&(!Number.isInteger(input.maxCalls)||input.maxCalls<1))throw Error('Agent处理次数无效');
    const ctx=await this.context();if(this.closing)throw Error('Agent宿主正在关闭');const taskId=input.session?.id??id(),nativeId=input.session?.nativeId??taskId,startEventCount=input.session?.startEventCount??0,sessionDirectory=input.sessionDirectory??input.projectDirectory,provider='yixu-task-'+nativeId,adapter=new TaskModel(input,sessionId=>this.adapters.get(sessionId));
    if(this.retiredSessions.has(nativeId))throw Error('原生上下文已因权限或身份变化释放，须沿当前合法上下文接续');
    if(!nativeId||!Number.isSafeInteger(startEventCount)||startEventCount<0)throw Error('Agent原生上下文身份或本任务起点无效');
    if(this.adapters.has(nativeId))throw Error('同一原生上下文已有执行任务，须使用独立响应分支');
    const ownsCall=(call:{agentCallId:string;taskExecutionId?:string;boundarySeq?:number})=>call.taskExecutionId!==undefined?call.taskExecutionId===taskId:(call.boundarySeq??0)>=startEventCount;
    const persistence=ctx.get('sessionPersistence')!,legacy=persistence instanceof ProductSessionPersistence;
    if(legacy&&(!this.options||!('legacy'in this.options)))throw Error('正式PC宿主须使用官方SessionPersistence；产品日志仅用于显式迁移/非PC适配');
    if(legacy&&nativeId!==taskId)throw Error('持续原生上下文需要正式SessionPersistence保存端口');
    let transient:AgentSessionSnapshot|undefined;
    const temporary:AgentSessionStore={load:async()=>transient,create:async(_id,value)=>{transient=structuredClone(value);},append:async(_id,count,events)=>{if(!transient||transient.events.length!==count)throw Error('临时Agent事件前缀已变化');transient.events.push(...structuredClone(events));}};
    const domainStore=input.session?.store??temporary;
    const releaseBinding=legacy?persistence.bind(nativeId,domainStore):()=>{},releaseAdapter=ctx.get('llm')!.registerAdapter([provider],adapter);
    let reference:NativeSessionReference|undefined,nativeExists=false,savedNativeState:string|undefined;
    const retainConversation=!legacy&&!attached&&input.task?.role==='companion'&&!!input.session?.nativeId&&nativeId!==taskId;
    const retained=retainConversation?this.conversations.get(nativeId):undefined;
    let turnScope:{dispose():Promise<unknown>}|undefined;
    let handle:AgentHandle|undefined,taskAgent=attached?.agent,result:T|undefined,accepted=false,fatal:unknown;
    let delegation:DelegationCoordinator|undefined;
    const checkpoint=async()=>{try{if(!taskAgent)return;const session=taskAgent.session,watermark=session.seq;let flushed=false;if(ctx.get('sessions')!.get(taskAgent.id)===session){await ctx.get('sessions')!.flush(session);flushed=true;}if(reference){reference.eventCount=session.seq;
      // A domain commit precedes native tool/result. Only an official flush of the exact
      // terminal prefix proves that cold housekeeping may skip opening this session.
      if(flushed&&session.seq===watermark&&watermark>0&&session.eventAt((watermark-1) as SessionSeq)?.type==='turn/end')reference.closedEventCount=watermark;
      if(input.session){if(!domainStore.saveNative)throw Error('领域保存端口尚未支持原生会话引用');const state=JSON.stringify(reference);if(state!==savedNativeState){await domainStore.saveNative(reference);savedNativeState=state;}}}}catch(error){fatal??=error;throw error;}};
    const outcomes=new Map<string,{value:T}>(),acceptedReading=new Map<string,ReadingAcceptance<T>>(),terminalAdmissions=new Set<string>();
    const output={schema:{type:'object' as const,additionalProperties:true},render:(_args:unknown,value:unknown):ContentBlock[]=>[{type:'text',text:JSON.stringify(value)}]};
    const operation=(received:Received,callId?:string):AgentOperation=>({agentSessionId:taskId,taskExecutionId:taskId,nativeSessionId:nativeId,agentCallId:received.agentCallId,...(received.response.requestId?{requestId:received.response.requestId}:{}),...(callId?{toolCallId:callId}:{}),key:JSON.stringify([taskId,received.response.requestId??received.agentCallId,callId??'terminal'])});
    const collectChildNotices=async()=>{
      if(!taskAgent||!delegation)return;
      await ctx.get('subagents')!.waitForChildren(taskAgent);await delegation.settle();
      // These real notices remain in the native log and child domain result store. They are
      // collected by the finishing host task, never replayed as another paid post-commit turn.
      for(const target of ['next-step','next-turn'] as const){const messages=target==='next-step'?taskAgent.inbox.nextStep:taskAgent.inbox.nextTurn;for(let index=messages.length-1;index>=0;index--){const kind=messages[index].source?.kind;if(kind==='subagent-settled'||kind==='tool-jobs')taskAgent.inbox.splice(target,index,1,[]);}}
    };
    const recoverValue=async(received:Received,execution:ToolRunContext,terminal=false)=>{const value=await input.recoverCommit?.(operation(received,terminal?undefined:String(execution.callId)));if(value===undefined)return false;outcomes.set(String(execution.callId),{value});execution.concludeTurn();return true;};
    const acceptValue=async(received:Received,execution:ToolRunContext,value:T,terminal=false)=>{
      await collectChildNotices();
      const op=operation(received,terminal?undefined:String(execution.callId)),recovered=await input.recoverCommit?.(op);
      let committed:T;
      try{committed=recovered!==undefined?recovered:input.commit?await input.commit(value,op):value;}
      catch(error){fatal=error;execution.concludeTurn();throw error;}
      outcomes.set(String(execution.callId),{value:committed});execution.concludeTurn();return{accepted:true};
    };
    const assertOpen=(signal:AbortSignal)=>{if(adapter.exposureFailure)throw adapter.exposureFailure;input.assertCurrent();input.signal.throwIfAborted();signal.throwIfAborted();};
    const refreshMaterialSurface=async()=>{if(taskAgent&&input.materialExposure?.current)await input.materialExposure.current({messages:modelMessages({provider,model:input.service.model,messages:taskAgent.session.deriveMessages()})});};
    const checkReadingFailure=async(failures:string[],response:AgentModelReply,toolCallId:string)=>{
      if(input.lengthRecovery!=='maintenance'||!input.recoveryProgress||!taskAgent)return;
      // Trusted domain progress and durable runtime events own this decision.
      // Failed carrier bytes and JSON error offsets are not successful work.
      const signature=await hashText(JSON.stringify([failures,input.recoveryProgress()]));
      const authorization=input.session?.recoveryAuthorization?.id??'initial';
      for(let seq=startEventCount;seq<taskAgent.session.seq;seq++){
        const event=taskAgent.session.eventAt(seq as SessionSeq);if(event?.type!=='yixu/reading-check')continue;
        if(event.data.signature===signature&&event.data.authorization===authorization&&event.data.requestId!==response.requestId){
          fatal=Error(READING_SUBMISSION_NO_PROGRESS);throw fatal;
        }
      }
      if(!response.requestId)throw Error('提交检查缺少实际请求身份');
      taskAgent.session.append('yixu/reading-check',{signature,authorization,requestId:response.requestId,toolCallId});
      await checkpoint();
    };
    const formatFailure=(error:ModelOutputError)=>['reading-format',error.reason??'invalid-reading-fields',...(error.reason==='invalid-reading-fields'?[error.message]:[])];
    const reading=async(received:Received,execution:ToolRunContext,terminal=false)=>{
      const submission=normalizeReadingSubmission(received.response);if(!submission){await checkReadingFailure(['reading-exit-invalid'],received.response,String(execution.callId));return{accepted:false,errors:['本次完整响应没有唯一合法阅读出口，原答保持'],originalReplyRetained:true};}
      if(submission.kind!=='reaction')await collectChildNotices();
      const op=operation(received,terminal?undefined:String(execution.callId));
      let outcome=acceptedReading.get(op.key);
      if(!outcome){
        // A rejected proposal is ordinary model feedback. A thrown domain
        // failure means saving/source checks failed and cannot be repaired by
        // generating another answer. Preserve the original for local recovery.
        try{outcome=await input.readingExit!.recover?.(op)??await input.readingExit!.accept!(submission,op);}
        catch(error){fatal=error;execution.concludeTurn();throw error;}
        acceptedReading.set(op.key,outcome);
        await checkpoint();
      }
      if(outcome.accepted&&outcome.result!==undefined&&submission.kind!=='reaction'){outcomes.set(String(execution.callId),{value:outcome.result});execution.concludeTurn();}
      const feedback=readingFeedback(outcome);
      if(!outcome.accepted&&input.lengthRecovery==='maintenance'&&input.recoveryProgress&&taskAgent){
        const failures=outcome.issues?.length?[...outcome.issues.map(issue=>JSON.stringify([issue.code,issue.path,issue.target??''])).sort(),...outcome.errors.filter(error=>!error.startsWith('views[')&&!error.startsWith('views尚未')).sort()]:[...outcome.errors].sort();
        await checkReadingFailure(failures,received.response,String(execution.callId));
      }
      // Supplemental bodies are explicit task input, subject to the normal
      // context/budget admission and final frozen-request exposure receipt.
      // Mixing them into a JSON tool control result let native spill cut both
      // the error envelope and document bodies, causing repeated false misses.
      if(feedback.materials&&taskAgent){
        taskAgent.steer(createUserMessage({source:{kind:'yixu-runtime'},content:[{type:'text',text:JSON.stringify({materials:feedback.materials})}]}));
        delete feedback.materials;
        feedback.materialDelivery='补充材料随本任务输入提供；实际核对后沿原candidate局部修改或确认，未提供范围仍按需读取。';
        await checkpoint();
      }
      return feedback;
    };
    const parseFinal=async(received:Received,execution:ToolRunContext)=>{
      if(await recoverValue(received,execution,true))return{accepted:true,recovered:true};
      if(input.preparation&&!input.preparation.ready())return{accepted:false,errors:[input.preparation.instruction],originalReplyRetained:true};
      if(input.readingExit?.accept)return reading(received,execution,true);
      const text=received.response.content;let value:T;
      if(input.acceptJsonFinal){let parsed:unknown;try{parsed=JSON.parse(text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));}catch{if(!input.parseTextFinal)throw Error('模型终态未返回完整结构，原答保持');value=await input.parseTextFinal(text);return acceptValue(received,execution,value,true);}
        try{value=await(input.readingExit?input.readingExit.parse(parsed):input.submit.parse(parsed));}catch(error){if(!input.finalizeSubmission)throw error;value=await input.finalizeSubmission(text);}
      }else if(input.parseTextFinal)value=await input.parseTextFinal(text);else throw Error('Agent尚未提交完整结果，原答保持');
      return acceptValue(received,execution,value,true);
    };
    const feedback=(value:unknown,received?:Received)=>{
      const message=createUserMessage({source:{kind:'yixu-runtime'},content:[{type:'text',text:JSON.stringify(value)}]});taskAgent!.steer(message);
      if(input.session&&received?.response.requestId){const link={requestId:received.response.requestId,messageId:message.id};if(reference)reference.feedbacks.push(link);else taskAgent!.session.append('yixu/feedback',link);}
    };
    const lengthCheckpoints:ReadingLengthRecoveryCheckpoint[]=[];
    const priorLengthCheckpoints=()=>{
      // Read trusted runtime messages linked by durable host receipt facts. Do not
      // search arbitrary task text, assistant output or compaction summaries.
      const requestIds=new Set(reference?.calls.filter(ownsCall).flatMap(call=>call.requestId?[call.requestId]:[])??[]);
      const links=new Map((reference?.feedbacks??[]).filter(link=>requestIds.has(link.requestId)).map(link=>[link.messageId,link.requestId])),messages=new Map<string,ReturnType<typeof createUserMessage>>();
      if(taskAgent)for(let seq=0;seq<taskAgent.session.seq;seq++){
        const event=taskAgent.session.eventAt(seq as SessionSeq);if(!event)continue;
        if(event.type==='yixu/feedback'&&(!reference||requestIds.has(event.data.requestId)))links.set(event.data.messageId,event.data.requestId);
        if(event.type==='user/message')messages.set(event.data.id,event.data);
        if(event.type==='agent/inbox/spliced')for(const message of event.data.inserted)if(message.role==='user')messages.set(message.id,message);
      }
      const checkpoints=[...lengthCheckpoints];for(const[messageId,requestId]of links){
        const message=messages.get(messageId);if(message?.source.kind!=='yixu-runtime')continue;
        for(const block of message.content){if(block.type!=='text')continue;let value:unknown;try{value=JSON.parse(block.text);}catch{continue;}
          const checkpoint=readingLengthRecoveryCheckpoint((value as {lengthRecovery?:unknown}|undefined)?.lengthRecovery);if(checkpoint?.requestId===requestId)checkpoints.push(checkpoint);
        }
      }
      return checkpoints;
    };
    const lengthFeedback=async(response:AgentModelReply)=>{
      if(!response.requestId)throw Error('length原请求身份尚未确认，未新增派发');
      const checkpoints=priorLengthCheckpoints(),progressSignature=await readingLengthRecoveryProgress(input.service,input.recoveryProgress?.()??''),authorizationId=input.session?.recoveryAuthorization?.id??checkpoints.at(-1)?.authorizationId??'initial';
      if(checkpoints.some(prior=>prior.requestId!==response.requestId&&prior.progressSignature===progressSignature&&prior.authorizationId===authorizationId))throw Error(READING_LENGTH_NO_PROGRESS);
      const checkpoint:ReadingLengthRecoveryCheckpoint={version:'reading-length-recovery-v2',requestId:response.requestId,progressSignature,authorizationId};lengthCheckpoints.push(checkpoint);
      return readingLengthFeedback(input.service,response,checkpoint);
    };
    const hasAllowance=()=>input.maxCalls==='host-admitted'||adapter.calls<input.maxCalls;
    const abort=()=>taskAgent?.cancel({kind:'user'});input.signal.addEventListener('abort',abort,{once:true});
    try{
      this.adapters.set(nativeId,adapter as TaskModel<unknown>);
      if(retained){
        reference=await domainStore.loadNative?.();nativeExists=true;
        if(!reference||reference.sessionId!==nativeId||!nativeSessionHeadersEqual(reference.header,retained.agent.session.header))throw Error('活动对话与本轮领域会话身份不符');
        if(reference.eventCount!==retained.agent.session.seq)throw Error('活动对话的领域日志水位尚未收妥');
        if(sessionDirectory&&!await samePhysicalPath(retained.agent.session.header.cwd,sessionDirectory))throw Error('活动对话不属于本书工程');
      }else if(!legacy&&!attached){
        reference=await domainStore.loadNative?.();const stat=await persistence.stat(SessionId(nativeId));nativeExists=!!stat;
        if(reference&&reference.sessionId!==nativeId)throw Error('原生上下文与本任务绑定不符');
        if(startEventCount>0&&(!reference||reference.eventCount<startEventCount))throw Error('持续上下文缺少本任务接续起点');
        const migratedDirectory=reference?.relocations?.length?reference.relocations[reference.relocations.length-1].projectDirectory:reference?.migration?.headerMapping?.projectDirectory;
        if(migratedDirectory&&!await samePhysicalPath(migratedDirectory,sessionDirectory))throw Error('原生迁移已绑定其他书籍工程，未重写会话头');
        if(stat&&sessionDirectory&&!await samePhysicalPath(stat.header.cwd,sessionDirectory))throw Error('已有官方会话归属与本书工程不符，未静改会话头');
        if(stat){
          if(reference){if(!nativeSessionHeadersEqual(reference.header,stat.header))throw Error('原生会话与领域引用头不一致');}
          else{const source=await domainStore.load(nativeId);if(!source)throw Error('同名原生会话缺少领域归属，未接管');const migrated=await migrateProductSession(nativeId,source,sessionDirectory),stored=await createNativeSessionReader(ctx)(migrated.reference);if(JSON.stringify(stored)!==JSON.stringify(migrated.snapshot))throw Error('已存在原生会话与本次迁移内容不同，未覆盖');reference=migrated.reference;await domainStore.saveNative?.(reference);}
        }else{
          const source=await domainStore.load(nativeId);
          if(source?.events.length){
            let imported:AgentSessionSnapshot;
            if(reference){const header=materializeCreateHeader(source.header as Parameters<typeof materializeCreateHeader>[0]);validateStoredEvents(header,structuredClone(source.events) as Parameters<typeof validateStoredEvents>[1]);if(source.events.length<reference.eventCount||JSON.stringify(header)!==JSON.stringify(reference.header))throw Error('原生恢复缺少已确认完整日志');imported=source;}
            else{const migrated=await migrateProductSession(nativeId,source,sessionDirectory);imported=migrated.snapshot;reference=migrated.reference;}
            await using writer=await persistence.create(materializeCreateHeader(imported.header as Parameters<typeof materializeCreateHeader>[0]));await writer.append(imported.events as Parameters<typeof writer.append>[0]);await writer.flush();nativeExists=true;await domainStore.saveNative?.(reference!);
          }else if(reference||input.session?.mode==='resume')throw Error('原生会话文件缺失，尚无完整备份可恢复，未创建空任务');
        }
      }
      const setup=async(scope:Parameters<NonNullable<Parameters<Context['agents']['create']>[0]['setup']>>[0],agent:AgentHandle['agent'])=>{
        // Cordis service isolation plus native agent scope: one policy per authorized task.
        if(!legacy){const isolated=scope.isolate('compaction');await isolated.plugin(ReadingCompactionEngine,{maxTokens:input.service.maxOutput,headroomTokens:input.service.maxOutput});const engine=isolated.get('compaction');if(!engine)throw Error('本任务原生压缩实例尚未就绪');(engine as ReadingCompactionEngine).contextKind=input.task?.role==='companion'?'conversation':'task';this.compactors.set(taskId,{agent,engine:engine as ReadingCompactionEngine});}
        const nativeTools=legacy?[]:await installTaskCapabilities(scope,agent,input);
        if(!legacy){const{installReadingSpill}=await import('./spill.ts');const spill=await installReadingSpill(scope,agent,input as AgentRunRequest<unknown>,()=>reference,checkpoint);nativeTools.push(...spill.tools);adapter.afterDispatch=spill.afterDispatch;}
        if(!legacy&&input.delegation&&allowsTaskPlanning(input)){delegation=new DelegationCoordinator(scope,agent,input.delegation,input as unknown as AgentRunRequest<unknown>,(child,childAgent)=>this.bindAttached(child,childAgent),execution=>{const received=adapter.received(String(execution.callId));if(!received)throw Error('任务委派缺少真实父工具原调用');return operation(received,String(execution.callId));});nativeTools.push(...delegation.install());}
        const allowedNames=new Set([...nativeTools,...input.tools.map(tool=>tool.name),input.submit.name,...(input.readingExit?[input.readingExit.name]:[]),...(input.readingExit?.reaction?[input.readingExit.reaction.name]:[]),TERMINAL]);
        const visible=(name:string)=>{const preparing=input.preparation&&!input.preparation.ready(),final=typeof input.maxCalls==='number'&&adapter.calls>=input.maxCalls-1;return allowedNames.has(name)&&name!==TERMINAL&&(!preparing||name===input.preparation!.toolName)&&(!final||!input.answerBudget||name===input.readingExit?.name||input.answerBudget.allowSubmit&&name===input.submit.name);};
        scope.tools.guard(execution=>execution.agent!==agent?undefined:execution.name===TERMINAL?terminalAdmissions.has(String(execution.callId))?undefined:'该终态入口仅接收原生停止事件':adapter.received(String(execution.callId))?.failure?'原答尚未通过完整性检查，保留原调用但不执行':allowedNames.has(execution.name)&&adapter.received(String(execution.callId))?.tools.has(execution.name)?undefined:'该工具不属于本次真实派发能力');
        scope.systemPrompt.section({name:'yixu:task',order:1,complete:true,interpolate:false,text:input.messages.filter(message=>message.role==='system').map(message=>message.content).join('\n')});
        scope.systemPrompt.context({name:'yixu:task-state',order:300,required:true,interpolate:false,text:()=>JSON.stringify({...(input.preparation&&!input.preparation.ready()?{preparation:input.preparation.instruction}:{}),...(typeof input.maxCalls==='number'?{calls:adapter.calls,remaining:input.maxCalls-adapter.calls,...(input.answerBudget?{instruction:input.maxCalls-adapter.calls<=1?input.answerBudget.instruction:'已有资料足够时直接回答。'}:{})}:{})})});
        scope.systemPrompt.context({name:'yixu:domain-state',order:310,required:true,interpolate:false,text:()=>{const items=input.runtimeContext?.()??[];return items.length?JSON.stringify(items):'';}});
        // Schema selection is part of native assembly, before header and request admission.
        scope.on('system-prompt/assemble',async(_assembly,context,next)=>{const assembly=await next();if(context.scope!==scopeOf(scope))return assembly;return{...assembly,tools:assembly.tools.filter(tool=>visible(tool.name))};});
        scope.on('agent/pre-step',async(payload,next)=>{if(payload.agent!==agent)return next();if(fatal)throw fatal;if(adapter.exposureFailure)throw adapter.exposureFailure;if(adapter.pruningFailure)throw adapter.pruningFailure;input.assertCurrent();if(!hasAllowance()&&!adapter.replay)throw Error('本轮已达到模型处理次数上限，原记录保留');return next();});
        scope.on('agent/error',payload=>{if(payload.agent===agent)fatal??=adapter.failure??payload.error;});
        scope.on('session/event',(session,event)=>{if(!reference||session.id!==nativeId)return;const call=reference.calls.find(item=>item.agentCallId===adapter.nativeReceiptCall);if(call&&(call.purpose==='compaction'?event.type==='compaction/summary':event.type==='assistant/message'))call.resultSeq=event.seq;});
        scope.on('tools/result',(execution,final)=>{if(execution.agent!==agent)return;const outcome=outcomes.get(String(execution.callId));if(outcome&&!final.isError){result=outcome.value;accepted=true;const goals=scope.get('goals'),goal=goals?.get(agent);if(goal&&goal.phase!=='complete')goals!.complete(agent,goal);}});
        const prepareRead=installReadToolOwner(scope,agent,checkpoint,assertOpen,output);
        for(const tool of input.tools){const {read,...definition}=tool;scope.tools.register({...definition,parameters:tool.parameters as ToolDefinition['parameters'],output,...(read?{isConcurrencySafe:(args:unknown)=>read.isConcurrencySafe(args)}:{}),async execute(args,execution){
          if(!args||typeof args!=='object'||Array.isArray(args))throw Error('工具arguments须为完整JSON对象，原串保持且本次未执行');
          const localFailure=(error:unknown):never=>{if(input.isLocalToolFailure?.(error)){fatal??=error;execution.concludeTurn();}throw error;};
          try{
            await refreshMaterialSurface();assertOpen(execution.signal);
            if(read){const currentRead={...read,async apply(candidate:unknown,signal:AbortSignal){try{await refreshMaterialSurface();assertOpen(signal);return await read.apply(candidate,signal);}catch(error){return localFailure(error);}}};return await prepareRead(currentRead,args,execution);}
            await checkpoint();assertOpen(execution.signal);return await tool.execute(args,execution.signal);
          }catch(error){return localFailure(error);}
        }});}
        if(input.readingExit)scope.tools.register({...input.readingExit,parameters:input.readingExit.parameters as ToolDefinition['parameters'],output,async execute(args,execution){
          await checkpoint();assertOpen(execution.signal);const received=adapter.received(String(execution.callId));if(!received)throw Error('完成出口缺少对应原答');
          if(input.readingExit!.accept)return reading(received,execution);
          try{const submission=normalizeReadingSubmission(received.response);if(!submission||submission.kind!=='finish')throw Error('阅读出口须唯一且完整');input.readingExit!.validate(args);const value=await input.readingExit!.parse(args,submission.proposalRaw,submission.reactionRaw);outcomes.set(String(execution.callId),{value});execution.concludeTurn();return{accepted:true};}catch(error){return{accepted:false,errors:[(error as Error).message],originalReplyRetained:true};}
        }});
        if(input.readingExit?.reaction){const reaction=input.readingExit.reaction;scope.tools.register({...reaction,parameters:reaction.parameters as ToolDefinition['parameters'],output,async execute(_args,execution){await checkpoint();assertOpen(execution.signal);const received=adapter.received(String(execution.callId));if(!received)throw Error('表达出口缺少原答');if(received.response.toolCalls.some(call=>call.function.name===input.readingExit!.name))return{deferredToReadingExit:true,originalReplyRetained:true};if(input.readingExit!.accept)return reading(received,execution);return{accepted:false,errors:['表达须与完整阅读出口一并处理'],originalReplyRetained:true};}});}
        if(!input.readingExit||input.readingExit.allowProposal)scope.tools.register({...input.submit,parameters:input.submit.parameters as ToolDefinition['parameters'],output,async execute(args,execution){
          await checkpoint();assertOpen(execution.signal);const received=adapter.received(String(execution.callId));if(!received)throw Error('提交缺少原答');if(await recoverValue(received,execution))return{accepted:true,recovered:true};if(input.preparation&&!input.preparation.ready())return{accepted:false,errors:[input.preparation.instruction]};
          if(input.readingExit){if(received.response.toolCalls.some(call=>call.function.name===input.readingExit!.name))return{deferredToReadingExit:true};const legacy=await input.readingExit.parseLegacySubmit?.(received.response.toolCalls.find(call=>call.id===String(execution.callId))!.function.arguments);if(legacy===undefined)return{accepted:false,errors:['请使用完整阅读出口'],originalReplyRetained:true};outcomes.set(String(execution.callId),{value:legacy});execution.concludeTurn();return{accepted:true};}
          const originalArguments=received.response.toolCalls.find(call=>call.id===String(execution.callId))!.function.arguments;
          // An explicit native submit must validate its untouched carrier, never a repaired candidate or prose fallback.
          JSON.parse(originalArguments);
          let value:T=await input.submit.parse(args);
          if(input.finalizeSubmission)value=await input.finalizeSubmission(received.response.content,value,received.response.toolCalls.find(call=>call.id===String(execution.callId))!.function.arguments);
          return acceptValue(received,execution,value);
        }});
        // A genuine natural-text terminal uses the real tool pipeline without inventing an assistant call.
        scope.tools.register({name:TERMINAL,description:'接受原生自然正文终态（程序入口）',parameters:{type:'object'},output,async execute(_args,execution){await checkpoint();assertOpen(execution.signal);const received=adapter.received();if(!received)throw Error('缺少原生终态');return parseFinal(received,execution);}});
        scope.on('agent/turn-stopping',async({agent:stoppingAgent,signal})=>{
          if(stoppingAgent!==agent)return;
          if(fatal)throw fatal;
          if(accepted)return;const received=adapter.last;if(!received){fatal=adapter.failure??Error('Agent尚无完整原答');throw fatal;}
          if(received.failure){const rejected=received.failure,repairable=['missing-reading-body','invalid-reading-json','invalid-reading-fields'].includes(rejected.reason??'')||input.lengthRecovery==='maintenance'&&rejected.reason==='reading-output-length';
            if(!repairable||!hasAllowance()){fatal=rejected;throw rejected;}
            if(rejected.reason!=='reading-output-length')await checkReadingFailure(formatFailure(rejected),received.response,'terminal:'+received.agentCallId);
            received.failure=undefined;const jsonParseError=rejected.outcome&&'jsonParseError'in rejected.outcome?rejected.outcome.jsonParseError:undefined;
            feedback(rejected.reason==='reading-output-length'?await lengthFeedback(received.response):{accepted:false,reason:rejected.reason,error:rejected.reason==='invalid-reading-json'?'JSON语法无效：'+rejected.message:rejected.message,...(jsonParseError?{jsonParseError,jsonErrorLocation:readingJsonErrorLocation(rejected.response.content,jsonParseError)}:{}),originalReplyRetained:true,instruction:'原答已保存；沿原任务和已取得材料修正，不改写已有原答。'},received);return;
          }
          if(input.preparation&&!input.preparation.ready()){if(!hasAllowance())throw Error('材料准备尚未完成');feedback({preparation:input.preparation.instruction},received);return;}
          const goal=scope.get('goals')?.get(agent);if(goal?.phase==='active'&&goal.activation==='armed')return;
          const callId=ToolCallId('terminal:'+received.agentCallId);terminalAdmissions.add(callId);
          let final:Awaited<ReturnType<typeof agent.ctx.tools.execute>>;try{final=await agent.ctx.tools.execute({callId,name:TERMINAL,arguments:{},agent,signal});}finally{terminalAdmissions.delete(callId);}
          if(legacy)agent.session.append('yixu/terminal-result',{agentCallId:received.agentCallId,...(received.response.requestId?{requestId:received.response.requestId}:{}),operationKey:operation(received).key,accepted});await checkpoint();
          if(!accepted){const outcome=final.isError?{accepted:false,errors:[final.error.message],originalReplyRetained:true}:final.value;if(!hasAllowance()){fatal=Error('原终态尚未通过领域接受，已无剩余调用');throw fatal;}feedback(outcome,received);}
        });
      };
      // Turn contributions live in a disposable child fiber carrying the same
      // native agent scope. Keep the official Agent/Session and write lease,
      // replace every task closure, tool, prompt and listener before next input.
      const setupTurn=async(scope:Context,agent:AgentHandle['agent'])=>{
        if(!retainConversation)return setup(scope,agent);
        const fork=scope.plugin({name:'yixu-conversation-turn',apply:async(current:Context)=>setup(current,agent)});
        turnScope=fork;await fork.await();
      };
      // Historical request schemas stay in their original carrier. New requests use current
      // assembly; actual calls are still validated by the native tool pipeline and domain.
      const agentOptions={provider,model:input.service.model,reasoningEffort:ReasoningEffortId(input.service.effort),maxTokens:input.service.maxOutput};
      let seed:ReturnType<Session['snapshotEvents']>|undefined,bootstrapPending:ModelMessage[]|undefined;
      if(!attached&&input.session?.mode==='bootstrap'&&!nativeExists){
        if(!input.resumePayload)throw Error('正常存档接续缺少原运输历史');
        if(!input.session.recovery&&!input.resumePayload.messages.some(message=>message.role==='assistant'))throw Error('原请求只有待输入材料，须按获准的新原生任务接续，不能导入为已完成历史');
        const prepared=ctx.get('sessions')!.prepare(SessionId(nativeId),{...(sessionDirectory?{meta:{cwd:sessionDirectory}}:{})});
        const history=bootstrapHistory(prepared,input.resumePayload.messages,input.service,provider);adapter.calls=history.calls;bootstrapPending=history.pending;
        if(prepared.seq)seed=prepared.snapshotEvents();
      }
      if(attached){reference=await domainStore.loadNative?.();if(reference&&!nativeSessionHeadersEqual(reference.header,attached.agent.session.header))throw Error('原生子任务会话头与领域引用不一致');if(sessionDirectory&&!await samePhysicalPath(attached.agent.session.header.cwd,sessionDirectory))throw Error('原生子任务归属与本书执行目录不符');nativeExists=true;await setup(attached.agent.ctx,attached.agent);}
      else if(retained){handle=retained;taskAgent=handle.agent;Object.assign(taskAgent.options,agentOptions);await setupTurn(taskAgent.ctx,taskAgent);}
      else{handle=nativeExists||legacy&&input.session?.mode==='resume'?await ctx.get('agents')!.resume({resumeSessionId:SessionId(nativeId),signal:input.signal,agentOptions,setup:setupTurn}):await ctx.get('agents')!.create({sessionId:SessionId(nativeId),...(seed?{seed}:{}),...(sessionDirectory?{meta:{cwd:sessionDirectory}}:{}),signal:input.signal,agentOptions,setup:setupTurn});this.active.add(handle);taskAgent=handle.agent;}
      if(this.closing)throw Error('Agent宿主正在关闭');
      if(input.session?.appendInput&&nativeExists&&reference){
        if(reference.eventCount!==startEventCount||startEventCount>0&&reference.closedEventCount!==startEventCount)throw Error('持续上下文的原任务前缀尚未收妥，未改投下一任务');
        reconcileNativeResumePrefix(taskAgent!.session,reference);
      }
      if(!legacy&&!reference)reference={kind:'dsh-native-session-v1',backend:'jsonl',sessionId:nativeId,formatVersion:4,header:{...structuredClone(taskAgent!.session.header),delegationDepth:taskAgent!.session.header.delegationDepth??0},eventCount:taskAgent!.session.seq,calls:[],feedbacks:[]};
      if(attached&&reference&&!reference.spills&&attached.agent.session.header.isSeeded){
        const parentId=attached.agent.session.header.parentSession,parent=parentId&&this.adapters.get(String(parentId)),calls=new Set<string>();
        for(let seq=0;seq<attached.agent.session.inheritedEventCount;seq++){const event=attached.agent.session.eventAt(seq as SessionSeq);if(event?.type==='tool/call')calls.add(String(event.data.callId));}
        const inherited=parent?.reference?.spills?.filter(entry=>calls.has(entry.callId)).map(entry=>({...entry,sourceSessionId:entry.sourceSessionId??String(parentId)}));if(inherited?.length)reference.spills=inherited;
      }
      adapter.nativeSession=taskAgent!.session;adapter.checkpoint=checkpoint;adapter.reference=reference;
      if(input.projectDirectory){const working=ctx.get('workingDirectory') as {set(agent:AgentHandle['agent'],path:string,signal?:AbortSignal):Promise<string>}|undefined;if(working)await working.set(taskAgent!,input.projectDirectory,input.signal);else if(this.options&&'context'in this.options)throw Error('正式宿主须提供workingDirectory服务');}
      let initialFailure:ModelOutputError|undefined,taskInputRecorded=false;
      if(input.session&&!(retained&&input.session.appendInput&&!input.session.recovery&&startEventCount===taskAgent!.session.seq)){const snapshot=nativeSessionSnapshot(taskAgent!.session);taskInputRecorded=snapshot.events.slice(startEventCount).some(raw=>{const event=raw as import('@deepseek-ai/dsh-session').SessionEvent;return event.type==='user/message'&&event.data.source.kind==='yixu-runtime'||event.type==='agent/inbox/spliced'&&event.data.inserted.some(message=>message.role==='user'&&message.source.kind==='yixu-runtime');});const inspected=reference?inspectNativeSession(snapshot,reference):inspectAgentSession(snapshot),history={calls:inspected.calls.filter(ownsCall)},recovery=input.session.recovery;
        for(const call of history.calls){adapter.recordedCalls.add(call.agentCallId);if(!call.assistantRecorded&&!call.notDispatched&&(!recovery||call.agentCallId!==(recovery.agentCallId??recovery.requestId)&&call.requestId!==recovery.requestId)){const state=await input.session.requestState?.(call.agentCallId);if(!call.requestId&&state==='not-dispatched'){call.notDispatched=true;if(reference)reference.calls.find(item=>item.agentCallId===call.agentCallId)!.notDispatched=true;else taskAgent!.session.append('yixu/model-not-dispatched',{agentCallId:call.agentCallId});}else if(state==='terminal-no-result'&&reference){reference.calls.find(item=>item.agentCallId===call.agentCallId)!.terminalNoResult=true;}else throw Error('原Agent调用尚无已核验完整回执，未新增派发');}}
        adapter.calls=Math.max(adapter.calls,0,...history.calls.filter(call=>!call.notDispatched&&!call.purpose).map(call=>call.ordinal));
        if(recovery){
          const prior=[...history.calls].reverse().find(call=>call.requestId===recovery.requestId||call.agentCallId===(recovery.agentCallId??recovery.requestId));
          const recordedOriginal=!legacy&&!!reference&&prior?.assistantRecorded===true&&prior.requestId===recovery.requestId&&(recovery.agentCallId===undefined||prior.agentCallId===recovery.agentCallId);
          // Missing token usage does not revoke an exact original already in the
          // verified native prefix. It still cannot authorize replay of a missing
          // assistant or provide actual usage; pending settlement is fenced upstream.
          if(recovery.response.requestId!==recovery.requestId||![recovery.response.input,recovery.response.output].every(value=>Number.isSafeInteger(value)&&value>=0)||prior&&(prior.requestId!==undefined&&prior.requestId!==recovery.requestId||recovery.agentCallId!==undefined&&prior.agentCallId!==recovery.agentCallId)||recovery.response.estimated&&!recordedOriginal)throw Error('原Agent回执身份或结算未确认');
          if(!prior?.assistantRecorded)adapter.replay=recovery;
          else if(recovery.outcome&&!prior.feedbackRecorded&&!prior.feedbackPending)initialFailure=new ModelOutputError(recovery.outcome.reason,recovery.response,recovery.outcome.feedbackReason,recovery.outcome);
        }
      }
      if(input.session?.projectCompletedConversation){
        if(legacy||attached||!input.session.appendInput||input.session.recovery||!reference||reference.closedEventCount!==taskAgent!.session.seq||startEventCount<1)throw Error('资料表面整理只适用于新任务接续已完成的同一对话');
        input.assertCurrent();input.signal.throwIfAborted();
        projectCompletedConversationSurface(taskAgent!.session,startEventCount);
        // These are projection-only events between turns, not a new prompt.
        // The checkpoint must preserve that closed-prefix fact for cold retry.
        reference.closedEventCount=taskAgent!.session.seq;
      }
      await checkpoint();input.assertCurrent();input.signal.throwIfAborted();
      const continuationInput=bootstrapPending===undefined?undefined:encodeMaterialInput([...bootstrapPending,{role:'user',content:input.session?.instruction??MATERIAL_CONTINUATION}]);
      const initialLengthFeedback=initialFailure?.reason==='reading-output-length'&&input.lengthRecovery==='maintenance'?await lengthFeedback(initialFailure.response as AgentModelReply):undefined;
      if(initialFailure&&initialFailure.reason!=='reading-output-length')await checkReadingFailure(formatFailure(initialFailure),initialFailure.response as AgentModelReply,'terminal:'+(input.session?.recovery?.agentCallId??input.session?.recovery?.requestId??''));
      const prompt=createUserMessage({source:{kind:'yixu-runtime'},content:[{type:'text',text:initialFailure?JSON.stringify(initialLengthFeedback??{accepted:false,error:initialFailure.reason==='invalid-reading-json'?'JSON语法无效：'+initialFailure.message:initialFailure.message,reason:initialFailure.reason,...(initialFailure.outcome&&'jsonParseError'in initialFailure.outcome&&typeof initialFailure.outcome.jsonParseError==='string'?{jsonParseError:initialFailure.outcome.jsonParseError,jsonErrorLocation:readingJsonErrorLocation(initialFailure.response.content,initialFailure.outcome.jsonParseError)}:{}),originalReplyRetained:true,instruction:input.session?.instruction??'沿原任务修正已保存结果，不重复已取得材料。'}):continuationInput??(input.session&&!input.session.appendInput&&!(input.session.nativeId&&!taskInputRecorded)&&input.session.mode!=='create'?(input.session.instruction??MATERIAL_CONTINUATION):encodeMaterialInput(input.messages.filter(message=>message.role!=='system')))}]});
      if(initialFailure&&input.session?.recovery){const link={requestId:input.session.recovery.requestId,messageId:prompt.id};if(reference)reference.feedbacks.push(link);else taskAgent!.session.append('yixu/feedback',link);}
      if(attached){attached.ready();await attached.admission;}else taskAgent!.followup(prompt);
      if(accepted)await taskAgent!.whenIdle();else await waitForNativeTask(ctx,taskAgent!,input.signal,()=>accepted||fatal!==undefined);
      await checkpoint();if(!accepted){input.assertCurrent();input.signal.throwIfAborted();}
      if(fatal)throw fatal;if(adapter.failure)throw adapter.failure;if(!accepted)throw Error('Agent尚未提交完整结果，原答与历史已保留');return result!;
    }finally{input.signal.removeEventListener('abort',abort);try{if(handle){await ctx.get('subagents')?.drainDescendants([handle.agent]);await handle.agent.whenIdle();await turnScope?.dispose();if(retainConversation&&accepted&&!fatal&&!adapter.failure&&!input.signal.aborted&&!this.closing&&!this.retiredSessions.has(nativeId))this.conversations.set(nativeId,handle);else{this.conversations.delete(nativeId);await handle.dispose();this.active.delete(handle);}}else await turnScope?.dispose();}finally{this.compactors.delete(taskId);this.adapters.delete(nativeId);releaseBinding();releaseAdapter();}}
  }
}
