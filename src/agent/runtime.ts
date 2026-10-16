import {isCompanionRecallDescriptionUpgrade} from '../core/reading-agent.ts';
import {lengthRepairApplied,readingLengthFeedback} from '../core/maintenance-recovery.ts';
import { Context } from '@deepseek-ai/cordis';
import Timer from '@deepseek-ai/cordis-plugin-timer';
import Projection from '@deepseek-ai/dsh-session-projection';
import Llm, { createUserMessage, LlmAdapter, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm';
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import Sessions, { SessionId } from '@deepseek-ai/dsh-session';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Agent from '@deepseek-ai/dsh-agent';
import type { AgentHandle } from '@deepseek-ai/dsh-agent';
import Loop from '@deepseek-ai/dsh-agent-loop';
import { id } from '../core/books.ts';
import { ModelOutputError } from '../core/model.ts';
import {normalizeReadingSubmission,isReadingViewCapacityUpgrade,readingFeedback,readingJsonErrorLocation,isReasoningOnlyLengthResponse} from '../core/reading-output.ts';
import type {ReadingSubmission,ReadingAcceptance} from '../core/reading-output.ts';
import type { AgentRunRequest, AgentRunner } from '../core/agent-port.ts';
import {completeSubmitObject} from '../core/agent-port.ts';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { AgentModelReply, ModelMessage, ModelToolCall } from '../core/types.ts';
import {readingRequestPayloadHash} from '../core/terminated-reading-continuation.ts';

function hasCallAllowance(input:{maxCalls:number|'host-admitted'},calls:number):boolean {
  return input.maxCalls==='host-admitted'||calls<input.maxCalls;
}
export function modelMessages(options: GenerateOptions): ModelMessage[] {
  return options.messages.map(message => {
    let content = '', reasoning = ''; const tool_calls: ModelToolCall[] = [];
    for (const block of message.content) {
      if (block.type === 'text') content += block.text;
      else if (block.type === 'reasoning' && message.role === 'assistant') reasoning += block.text;
      else if (block.type === 'tool-call' && message.role === 'assistant') tool_calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments } });
      else if (block.type === 'tool-addition') content += `\n可用工具：${block.toolName}`;
      else if (block.type === 'tool-removal') content += `\n已停用工具：${block.toolName}`;
      else throw new Error('当前共读渠道不支持该类Agent内容');
    }
    return { role: message.role === 'developer' ? 'user' : message.role, content,
      ...(tool_calls.length ? { tool_calls } : {}), ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(message.role === 'tool' ? { tool_call_id: message.toolCallId } : {}),
    };
  });
}

class TaskModel<T> extends LlmAdapter {
  input: AgentRunRequest<T>; calls = 0; error?: unknown; finalContent?: string; submissionContent?:string; submissionArguments?:string;
  recoveredSubmission=false; recoveredResult?:T;
  readingExitArguments?:string; readingProposal?:string; readingReaction?:string;
  readingExitValidationRejection?:string;
  readingSubmission?:ReadingSubmission;readingAcceptance?:ReadingAcceptance<T>;
  private resumeSeed?:ModelMessage[];
  private resumeSchemaUpgrade=false;
  lengthRepairUnresolved=false;
  constructor(input: AgentRunRequest<T>) { super(); this.input = input; }
  override async resolveModel(provider: string, model: string) {
    const service = this.input.service, effort = ReasoningEffortId(service.effort);
    return { provider, id: model, name: model, context: { contextWindow: service.contextLimit }, defaultMaxTokens: service.maxOutput,
      reasoning: { efforts: [{ id: effort, name: service.effort }], defaultEffort: effort } };
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    try {
      this.input.assertCurrent(); options.signal?.throwIfAborted();
      this.calls++;
      if (typeof this.input.maxCalls==='number'&&this.calls > this.input.maxCalls) throw new Error('本轮已达到模型处理次数上限，已有记录保留');
      let messages = modelMessages(options);
      const finalAnswer = typeof this.input.maxCalls==='number'&&!!this.input.answerBudget && this.calls === this.input.maxCalls;
      const preparing=!!this.input.preparation&&!this.input.preparation.ready();
      if(preparing)messages.push({role:'user',content:this.input.preparation!.instruction});
      if (this.input.answerBudget&&typeof this.input.maxCalls==='number') {
        const remaining = this.input.maxCalls - this.calls;
        messages.push({ role: 'user', content: `本任务本次为第${this.calls}/${this.input.maxCalls}次调用，之后剩余${remaining}次。` +
          (finalAnswer ? '这是最后一次，请根据此前已取得的资料交付完整回答，不再请求取材；资料不足的部分明确保留。' + this.input.answerBudget.instruction :
          remaining === 1 ? '这是最后一次取材机会；下一次只完成回答，请只取得回答所必需的材料。' : '已有资料足够时直接回答。') });
      }
      const allowedTools = (options.tools ?? []).filter(t => preparing?t.name===this.input.preparation!.toolName:!finalAnswer ||
        this.input.answerBudget!.allowSubmit && t.name === this.input.submit.name ||
        !!this.input.readingExit && t.name === this.input.readingExit.name);
      let modelTools=allowedTools.map(t => ({ name: t.name, description: t.description, parameters:this.input.readingExit&&t.name===this.input.readingExit.name?this.input.readingExit.parameters:t.parameters }));
      if(this.input.resumePayload){
        const original=this.input.resumePayload;
        if(!this.resumeSeed){
          if(original.tools.length!==modelTools.length)throw Error('原维护工具集合与本版本不兼容，未派发接续');
          for(const tool of original.tools){const current=modelTools.find(candidate=>candidate.name===tool.name);if(!current)throw Error('原维护工具 '+tool.name+' 的实际schema与本版本不兼容，未派发接续');if(await readingRequestPayloadHash([],[tool])!==await readingRequestPayloadHash([],[current])){if(!isReadingViewCapacityUpgrade(tool,current)&&!isCompanionRecallDescriptionUpgrade(tool,current))throw Error('原维护工具 '+tool.name+' 的实际schema与本版本不兼容，未派发接续');this.resumeSchemaUpgrade=true;}}
          this.resumeSeed=structuredClone(messages);
        }
        if(JSON.stringify(messages.slice(0,this.resumeSeed.length))!==JSON.stringify(this.resumeSeed))throw Error('接续运行器初始载体已变化，未拼接或替换原历史');
        messages=[...structuredClone(original.messages),...messages.slice(this.resumeSeed.length)];modelTools=structuredClone(this.resumeSchemaUpgrade?modelTools:original.tools);
      }
      this.lengthRepairUnresolved=lengthRepairApplied(messages,this.input.service);
      const response = await this.input.request(messages, modelTools, options.signal!);
      this.input.assertCurrent(); options.signal?.throwIfAborted();
      if (finalAnswer && response.toolCalls.some(c => !allowedTools.some(t => t.name === c.function.name))) throw new Error('模型在最后一次回答机会仍请求取材，原答与原问题保留');
      let calls=response.toolCalls,finish=response.finish;
      // Opted-in legacy tasks may already have a complete explicit body in
      // the original lone submit. Consume it before SDK operation validation.
      if(this.input.readingExit?.allowProposal&&this.input.readingExit.parseLegacySubmit&&finish==='tool_calls'&&calls.length===1&&calls[0].function.name===this.input.submit.name){
        const result=this.input.readingExit.parseLegacySubmit(calls[0].function.arguments);
        if(result!==undefined){this.recoveredResult=result;this.recoveredSubmission=true;calls=[];finish='stop';}
      }
      if (response.finish === 'stop') this.finalContent = response.content;
      this.submissionContent=!this.recoveredSubmission&&response.finish==='tool_calls'&&response.toolCalls.length===1&&response.toolCalls[0].function.name===this.input.submit.name&&response.content.trim()?response.content:undefined;
      this.submissionArguments=!this.recoveredSubmission&&response.finish==='tool_calls'&&response.toolCalls.length===1&&response.toolCalls[0].function.name===this.input.submit.name?completeSubmitObject(response.toolCalls[0].function.arguments):undefined;
      // Malformed operation syntax must not force another paid call to retain
      // the final prose. The domain already saved the untouched raw receipt.
      this.readingExitArguments=undefined;this.readingProposal=undefined;this.readingReaction=undefined;this.readingExitValidationRejection=undefined;
      this.readingSubmission=undefined;this.readingAcceptance=undefined;
      if(this.input.readingExit?.accept){
        const submission=normalizeReadingSubmission(response);
        if(submission){
          this.readingSubmission=submission;this.readingAcceptance=await this.input.readingExit.accept(submission);
          if(submission.kind==='finish'&&finish==='tool_calls')calls=calls.filter(c=>c.function.name===this.input.readingExit!.name).map(c=>{
            // Damaged/non-object arguments remain untouched in the paid raw
            // receipt. A neutral SDK event transports the domain rejection.
            try{const value=JSON.parse(c.function.arguments);if(value&&typeof value==='object'&&!Array.isArray(value))return c;}catch{}
            return{...c,function:{...c.function,arguments:'{}'}};
          });
          if(submission.kind==='reaction')calls=calls.map(c=>c.function.name===this.input.readingExit!.reaction?.name?{...c,function:{...c.function,arguments:JSON.stringify({text:'表达回执'})}}:c);
        }
      }
      if(this.input.readingExit&&!this.input.readingExit.accept&&finish==='tool_calls'){
        const reactionName=this.input.readingExit.reaction?.name??'react_to_reading';
        const exits=calls.filter(c=>c.function.name===this.input.readingExit!.name),proposals=calls.filter(c=>c.function.name===this.input.submit.name),reactions=calls.filter(c=>c.function.name===reactionName);
        if(exits.length>1)throw Error('阅读正文完成出口重复，原答保持；未选取任一正文');
        if(exits.length===1&&proposals.length<=1&&calls.length===exits.length+proposals.length+reactions.length){
          const args=JSON.parse(exits[0].function.arguments);
          // Only an intact, settled final carrier with no body can continue.
          // Stop before emitting reasoning/text/tools or applying any proposal.
          if(args&&typeof args==='object'&&!Array.isArray(args)&&(Object.keys(args).length===0||Object.keys(args).length===1&&typeof args.text==='string'&&!args.text.trim())&&!response.estimated&&Number.isSafeInteger(response.input)&&response.input>=0&&Number.isSafeInteger(response.output)&&response.output>=0){
            const {content,input,output,estimated,elapsedMs}=response;
            throw new ModelOutputError('模型已结算但完成出口缺少阅读正文',{content,input,output,estimated,elapsedMs},'missing-reading-body');
          }
          this.readingExitArguments=exits[0].function.arguments;
          try{this.input.readingExit.validate(args);}
          catch(error){this.readingExitValidationRejection=error instanceof Error?error.message:String(error);}
          this.readingProposal=proposals[0]?.function.arguments;
          if(reactions.length&&this.readingExitValidationRejection===undefined){
            this.readingReaction=reactions.length===1?reactions[0].function.arguments:JSON.stringify(reactions.map(call=>call.function.arguments));
          }
          calls=exits;
        }else if(reactions.length&&!this.input.readingExit.reaction){
          // Quiet tasks never expose or execute a reaction tool. Unexpected
          // optional calls do not interfere with a complete reading body.
          calls=calls.filter(call=>call.function.name!==reactionName);
          if(!calls.length)throw Error('阅读反应未应用：当前任务未开放反应，且缺少同包完整阅读正文');
        }
      }
      if(!this.input.readingExit&&this.submissionArguments!==undefined&&this.input.finalizeSubmission&&response.content.trim()){
        try{JSON.parse(completeSubmitObject(calls[0].function.arguments));}
        catch{this.recoveredResult=this.input.finalizeSubmission(response.content,undefined,this.submissionArguments);this.recoveredSubmission=true;this.submissionContent=undefined;calls=[];finish='stop';}
      }
      if(this.input.readingExit&&!this.input.readingExit.accept&&this.readingExitArguments===undefined)calls=calls.map(call=>{
        if(call.function.name===this.input.readingExit!.reaction?.name){
          // Canonical rejection only: never send damaged optional arguments to
          // SDK parsing/validation or to the domain reaction helper.
          return{...call,function:{...call.function,arguments:JSON.stringify({text:'未应用'})}};
        }
        if(call.function.name!==this.input.submit.name)return call;
        // A proposal without a body is never applied. Dispatch its explicit
        // rejection even when the optional metadata JSON is damaged.
        return{...call,function:{...call.function,arguments:'{}'}};
      });
      const blocks: ContentBlock[] = [];
      if (response.reasoning) blocks.push({ type: 'reasoning', text: response.reasoning });
      if (response.content) blocks.push({ type: 'text', text: response.content });
      for (const call of calls) blocks.push({ type: 'tool-call', id: ToolCallId(call.id), name: call.function.name,
        arguments:call.function.name===this.input.submit.name?completeSubmitObject(call.function.arguments):call.function.arguments });
      for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index]; yield { type: 'block-start', index, blockType: block.type };
        if (block.type === 'text' || block.type === 'reasoning') yield { type: block.type === 'text' ? 'text-delta' : 'reasoning-delta', index, text: block.text };
        else if (block.type === 'tool-call') yield { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments };
        yield { type: 'block-end', index, block };
      }
      if (!response.estimated) yield { type: 'usage', usage: { inputTokens: response.input, outputTokens: response.output, totalTokens: response.input + response.output } };
      yield { type: 'finish', reason: { kind: finish === 'tool_calls' ? 'tool-calls' : 'stop' } };
    } catch (error) {
      this.error = error;
      if(this.input.readingExit&&error instanceof ModelOutputError&&(['missing-reading-body','invalid-reading-json','invalid-reading-fields'].includes(error.reason??'')||this.input.lengthRecovery==='maintenance'&&error.reason==='reading-output-length')){
        // The host has already persisted this settled response and its fees.
        // Let Harness commit its actual assistant bytes before same-task
        // feedback, instead of losing the answer through a thrown stream.
        const response=error.response as AgentModelReply,blocks:ContentBlock[]=[];
        if(error.reason==='reading-output-length'){if(!response.estimated)yield{type:'usage',usage:{inputTokens:response.input,outputTokens:response.output,totalTokens:response.input+response.output}};yield{type:'finish',reason:{kind:'stop'}};return;}
        if(response.content)blocks.push({type:'text',text:response.content});
        for(const call of response.toolCalls??[])blocks.push({type:'tool-call',id:ToolCallId(call.id),name:call.function.name,arguments:call.function.arguments});
        for(const [index,block]of blocks.entries()){
          yield{type:'block-start',index,blockType:block.type};
          if(block.type==='text')yield{type:'text-delta',index,text:block.text};
          else if(block.type==='tool-call')yield{type:'tool-call-delta',index,id:block.id,name:block.name,argumentsDelta:block.arguments};
          yield{type:'block-end',index,block};
        }
        if(!response.estimated)yield{type:'usage',usage:{inputTokens:response.input,outputTokens:response.output,totalTokens:response.input+response.output}};
        yield{type:'finish',reason:{kind:response.toolCalls?.length?'tool-calls':'stop'}};return;
      }
      throw error;
    }
  }
}

/** One application owns the kernel; every operation gets a disposable, book-scoped task. */
export class HarnessRuntime implements AgentRunner {
  private pending?: Promise<Context>;
  private async kernel(): Promise<Context> {
    this.pending ??= (async () => {
      const ctx = new Context();
      try {
        await ctx.plugin(Timer); await ctx.plugin(Projection); await ctx.plugin(Llm); await ctx.plugin(Sessions);
        await ctx.plugin(Prompt, { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: '' });
        await ctx.plugin(Tools); await ctx.plugin(Agent); await ctx.plugin(Loop, { agents: [], maxParallelToolCalls: 1 });
        return ctx;
      } catch (error) { await ctx.fiber.dispose(); this.pending = undefined; throw error; }
    })();
    return this.pending;
  }
  async dispose(): Promise<void> { const pending = this.pending; this.pending = undefined; if (pending) await (await pending).fiber.dispose(); }
  async run<T>(input: AgentRunRequest<T>): Promise<T> {
    input.assertCurrent(); input.signal.throwIfAborted();
    if (input.maxCalls!=='host-admitted'&&(!Number.isInteger(input.maxCalls) || input.maxCalls < 1 || input.maxCalls > 12)) throw new Error('Agent处理次数无效');
    const ctx = await this.kernel(); input.assertCurrent(); input.signal.throwIfAborted();
    const taskId = id(), provider = 'yixu-task-' + taskId, adapter = new TaskModel(input);
    const releaseAdapter = ctx.llm.registerAdapter([provider], adapter);
    let result: T | undefined, accepted = false, handle: AgentHandle | undefined;
    const output = { schema: { type: 'object' as const, additionalProperties: true }, render: (_args: unknown, value: unknown): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value) }] };
    const aborted = () => handle?.agent.cancel({ kind: 'user' });
    input.signal.addEventListener('abort', aborted, { once: true });
    const assertOpen = (signal: AbortSignal) => { input.assertCurrent(); input.signal.throwIfAborted(); signal.throwIfAborted(); if(adapter.error)throw adapter.error;if (accepted) throw new Error('本轮已提交结果'); };
    try {
      handle = await ctx.agents.create({ sessionId: SessionId(taskId), signal: input.signal, agentOptions: { provider, model: input.service.model, reasoningEffort: ReasoningEffortId(input.service.effort), maxTokens: input.service.maxOutput }, setup: scope => {
        scope.systemPrompt.section({ name: 'yixu:task', order: 1, complete: true, interpolate: false, text: input.messages.filter(m => m.role === 'system').map(m => m.content).join('\n') });
        scope.on('agent/pre-step', async (_payload, next) => { input.assertCurrent(); return accepted||adapter.error ? { kind: 'reject' } : next(); });
        for (const tool of input.tools) scope.tools.register({ name: tool.name, description: tool.description, parameters: tool.parameters as ToolDefinition['parameters'], output,
          async execute(args, execution) { assertOpen(execution.signal); const value = await tool.execute(args, execution.signal); assertOpen(execution.signal); return value; }
        });
        // The model still receives the domain's complete original schema in
        // TaskModel.stream. Domain validation must produce the tool feedback:
        // SDK shape rejection would omit independently saved expressions.
        if(input.readingExit)scope.tools.register({name:input.readingExit.name,description:input.readingExit.description,parameters:{type:'object',additionalProperties:true} as ToolDefinition['parameters'],output,
          async execute(args,execution){assertOpen(execution.signal);
            if(input.readingExit!.accept){const outcome=adapter.readingAcceptance;if(!outcome||adapter.readingSubmission?.kind!=='finish')return{accepted:false,errors:['须独立提交完整阅读终态'],originalReplyRetained:true};if(outcome.accepted&&outcome.result!==undefined){result=outcome.result;accepted=true;}return readingFeedback(outcome);}
            if(adapter.readingExitValidationRejection!==undefined)return{accepted:false,reason:adapter.readingExitValidationRejection,originalReplyRetained:true};if(adapter.readingExitArguments===undefined)return{accepted:false,reason:'请先完成取材，再独立提交完整阅读正文'};
            try{result=input.readingExit!.parse(args,adapter.readingProposal,adapter.readingReaction);}
            catch(error){if(input.signal.aborted)throw input.signal.reason;return{accepted:false,reason:error instanceof Error?error.message:String(error),originalReplyRetained:true};}
            accepted=true;return{accepted:true};}
        });
        if(input.readingExit?.reaction){const reaction=input.readingExit.reaction;scope.tools.register({name:reaction.name,description:reaction.description,parameters:reaction.parameters as ToolDefinition['parameters'],output,
          async execute(_args,execution){assertOpen(execution.signal);if(input.readingExit?.accept){const outcome=adapter.readingAcceptance;return outcome&&adapter.readingSubmission?.kind==='reaction'?readingFeedback(outcome):{accepted:false,errors:['反应载体重复或不完整，阅读任务继续']};}return{accepted:false,reason:'阅读反应未应用；仅与唯一finish_reading同一最终响应的反应可由任务独立核验'};}
        });}
        if(!input.readingExit||input.readingExit.allowProposal)scope.tools.register({ name: input.submit.name, description: input.submit.description, parameters: input.submit.parameters as ToolDefinition['parameters'], output,
          async execute(args, execution) {
            assertOpen(execution.signal);
            if(input.preparation&&!input.preparation.ready())return{accepted:false,reason:input.preparation.instruction};
            if(input.readingExit)return{accepted:false,reason:'附加提议未应用；请用完整自然正文结束，或同包finish_reading与submit_reading'};
            try{result=input.submit.parse(args);}
            catch(error){if(adapter.submissionArguments===undefined||!input.finalizeSubmission||!adapter.submissionContent?.trim())throw error;try{result=input.finalizeSubmission(adapter.submissionContent,undefined,adapter.submissionArguments);}catch(failure){adapter.error=failure;throw failure;}accepted=true;return{accepted:true,structuralProposalAccepted:false};}
            if(input.finalizeSubmission)result=input.finalizeSubmission(adapter.submissionContent??'',result,adapter.submissionArguments);
            accepted=true;return{accepted:true};
          }
        });
      } });
      input.assertCurrent(); input.signal.throwIfAborted();
      // Initial domain context consists of user data/tasks; model/tool history is
      // subsequently owned by Harness, retaining native call IDs and reasoning.
      const context = input.messages.filter(m => m.role !== 'system');
      if (context.some(m => m.role !== 'user')) throw new Error('Agent初始任务包含未支持的历史格式');
      handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: context.map(m => m.content).join('\n\n') }] }));
      for(;;){
        await handle.agent.whenIdle(); input.assertCurrent(); input.signal.throwIfAborted();
        if(input.readingExit?.accept&&!adapter.error&&!accepted&&adapter.readingSubmission?.kind!=='reaction'&&adapter.readingAcceptance){
          const outcome=adapter.readingAcceptance;
          if(outcome.accepted&&outcome.result!==undefined){result=outcome.result;accepted=true;break;}
          if(adapter.finalContent!==undefined&&hasCallAllowance(input,adapter.calls)){
            adapter.finalContent=undefined;adapter.readingAcceptance=undefined;
            handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:JSON.stringify({accepted:false,errors:outcome.errors,expressionDelivery:outcome.expressionDelivery,originalReplyRetained:true,instruction:'按本任务字段继续同一次阅读提交。已经保存或交付的表达无需重复，已有全文继续可用。'})}]}));continue;
          }
        }
        if(input.preparation&&!input.preparation.ready()&&!adapter.error&&!accepted&&hasCallAllowance(input,adapter.calls)){
          // Preserve the same native history and count. A premature free-text
          // response does not become the user's answer before material selection.
          adapter.finalContent=undefined;adapter.submissionContent=undefined;adapter.submissionArguments=undefined;
          handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:input.preparation.instruction}]}));
          continue;
        }
        if(!input.readingExit||accepted||!(adapter.error instanceof ModelOutputError)||!(['missing-reading-body','invalid-reading-json','invalid-reading-fields'].includes(adapter.error.reason??'')||input.lengthRecovery==='maintenance'&&adapter.error.reason==='reading-output-length')||!hasCallAllowance(input,adapter.calls))break;
        // The paid response was settled by the domain before this boundary.
        // Keep this task, prior material/tool history and the original call cap.
        const rejected=adapter.error;
        if(rejected.reason==='reading-output-length'&&(adapter.lengthRepairUnresolved||isReasoningOnlyLengthResponse(rejected.response)))break;
        adapter.error=undefined;adapter.finalContent=undefined;adapter.submissionContent=undefined;adapter.submissionArguments=undefined;
        adapter.recoveredSubmission=false;adapter.recoveredResult=undefined;
        adapter.readingExitArguments=undefined;adapter.readingProposal=undefined;
        if(rejected.reason==='reading-output-length'){handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:JSON.stringify(readingLengthFeedback(input.service,rejected.response))}]}));continue;}
        const instruction=rejected.reason==='invalid-reading-json'?'上一响应已完整结算，原assistant回答已保留；JSON语法无效。请按下列准确解析错误修正原提交，不需要重新取回已有全文。':rejected.reason==='invalid-reading-fields'?'上一响应已完整结算，原assistant回答已保留；提交字段或工具载体无效。请按具体原因修正原提交。':'上一响应已结算，但缺少完整阅读正文。请依据本任务已有资料完成正文，使用本任务finish_reading所列正文出口，或直接返回完整自然正文。不得把reasoning作为正文。';
        const jsonParseError=rejected.outcome&&'jsonParseError'in rejected.outcome?rejected.outcome.jsonParseError:undefined;
        const jsonErrorLocation=rejected.reason==='invalid-reading-json'&&jsonParseError?readingJsonErrorLocation(rejected.response.content,jsonParseError):undefined;
        handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:JSON.stringify({accepted:false,reason:rejected.reason,error:rejected.message,...(jsonParseError?{jsonParseError}:{}),...(jsonErrorLocation?{jsonErrorLocation}:{}),originalReplyRetained:true,instruction})}]}));
      }
      if (adapter.error) throw adapter.error;
      if(input.readingExit?.accept&&!accepted&&adapter.readingAcceptance)throw Error(adapter.readingAcceptance.errors.join('\n')||'阅读提交尚未完成，原答已保留');
      if(input.preparation&&!input.preparation.ready())throw Error('本题的材料选择尚未完成，原问题与已取得资料保留');
      if(adapter.recoveredSubmission){result=adapter.recoveredResult;accepted=true;}
      if (!accepted && input.acceptJsonFinal && adapter.finalContent !== undefined) {
        let value: unknown, parsed = false;
        try { value = JSON.parse(adapter.finalContent.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
        catch {
          if (!input.parseTextFinal) throw new Error('模型结束时未返回完整的结构化理解，已有记录保留');
          result = input.parseTextFinal(adapter.finalContent); parsed = true;
        }
        // Both routes remain subject to domain parsing and required-evidence checks.
        if (!parsed) {
          try{result=input.readingExit?input.readingExit.parse(value):input.submit.parse(value);}
          catch(error){if(!input.finalizeSubmission)throw error;result=input.finalizeSubmission(adapter.finalContent);}
        }
        accepted = true;
      }
      if (!accepted) throw new Error('Agent尚未提交完整结果，已有记录保留');
      return result!;
    } finally {
      input.signal.removeEventListener('abort', aborted);
      try { if (handle) await handle.dispose(); } finally { releaseAdapter(); }
    }
  }
}
