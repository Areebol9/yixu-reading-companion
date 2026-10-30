import {BasicCompactionEngine} from '@deepseek-ai/dsh-compaction-basic';
import type {Agent} from '@deepseek-ai/dsh-agent';
import {BlockAssembler,contentHasImage,LlmError} from '@deepseek-ai/dsh-llm';
import type {ContentBlock,GenerateOptions,Message,ToolSchema} from '@deepseek-ai/dsh-llm';

/** A task checkpoint is execution context, never a new reading result or permission. */
const CHECKPOINT_INSTRUCTION=[
  '请把以上伴读任务的执行上下文整理为可准确接续的检查点。只输出检查点，不调用工具、不完成阅读任务、不发表新的理解或回应。',
  '按以下顺序保留各节；空项写“无”。用中文简洁记录，保留必要原话、标识、版本、范围、请求身份及错误原文。',
  '## 当前目标与用户要求\n保留用户最新目标、明确纠正、停止条件及仍有效的约束。',
  '## 已完成与已提交\n区分实际已读材料、候选、已提交认识/概要、已发表表达和已收到但未提交的原答；列出可核查身份。',
  '## 未决责任与恢复位置\n保留未完成问题、工具调用及结果、原请求/回执、unknown、失败和待修正事项；注明下一步，不能把未知改为成功或重发许可。',
  '## 材料与版本入口\n记录后续需要的正文范围、认识/概要/交流ID及版本、取回入口、具体读写依赖和冲突。摘要不替代完整正文或授予更新权限；需要原文时沿工具重新核取。',
  '## 当前判断与真实交流\n保留当前现场、已有看法和变化理由、尚未解决的分歧。严格区分用户原话、伙伴原话、小说事实、私人候选和真实共同经历；必要原话逐字保留，不补造对白或经历。',
  '## 接续动作与限制\n记录下一项获准动作、权限/来源限制和需等待的条件。原账本及领域状态继续权威，检查点不能取消未决责任、扩展阅读许可或把压缩摘要当成完整材料曝光。',
  '已有检查点时保留仍有效事实，合并新变化；原始事件和原答继续保留，检查点只服务本任务接续。不要推测未出现的结果。',
].join('\n\n');

/** Conversation continuity preserves experience and meaning. Execution receipts
 * remain in the native log/domain ledger, rather than becoming a speaking style. */
const CONVERSATION_CHECKPOINT_INSTRUCTION=[
  '整理这段交流，使同一伙伴能够自然接着与用户交谈。只输出供后续交流使用的摘要，不向用户发言，不新增观点或经历。',
  '保留当前正在谈的话题、用户最新问题、尚未回应或尚有分歧的事情；保留理解这些内容所必需的近期原话及对应消息标识。',
  '分清用户的想法、伙伴的想法和书中已知事实，保留看法发生变化的依据，以及双方确实有过的交流和阅读经历。未发表的候选、预读内容和后台推断不能写成共同经历。',
  '保留仍有效的相处约定、用户明确要求及与当前话题有关的个人信息。人格以当前提供的配置为准，不从旧回复中重新规定口吻或固定表达格式。',
  '需要以后精确引用的旧交流、书内认识和原文，保留其真实标识、位置和回查入口。摘要不替代原文、不扩大阅读许可、不授予修改文档的权限。',
  '已有摘要时结合新交流更新，保留仍有用的旧内容。不要把已完成请求的回执、账目或保存步骤排成面向伙伴的工作清单；若本轮确有未完成操作，仅保留继续它必需的身份和事实。',
].join('\n\n');

type SummarizationInput={readonly messages:readonly Message[];readonly tools?:readonly ToolSchema[]};

/** Only the official summarize hook changes; pairing, selection, pricing and commit remain upstream. */
export class ReadingCompactionEngine extends BasicCompactionEngine{
  contextKind:'conversation'|'task'='task';
  protected override async summarize(input:SummarizationInput,agent:Agent,signal?:AbortSignal){
    const latest=agent.session.requestHeader()?.config;
    const target=this.config.summarizationProvider
      ?{provider:this.config.summarizationProvider,model:this.config.summarizationModel}
      :(agent.options.provider&&agent.options.model?{provider:agent.options.provider,model:agent.options.model}:latest);
    if(!target)throw Error('伴读检查点缺少原任务模型路由');
    const options:GenerateOptions={provider:target.provider,model:target.model,
      messages:[...input.messages,{role:'user',content:[{type:'text',text:this.contextKind==='conversation'?CONVERSATION_CHECKPOINT_INSTRUCTION:CHECKPOINT_INSTRUCTION}]}],
      toolHistory:agent.session.toolHistory(),...(input.tools===undefined?{}:{tools:[...input.tools]}),
      maxTokens:this.config.maxTokens,sessionId:agent.session.id,purpose:'compaction',...(signal?{signal}:{})};
    const assembler=new BlockAssembler();for await(const chunk of this.ctx.llm.stream(options))assembler.push(chunk);
    const finish=assembler.finish;
    if(finish.kind==='error'||finish.kind==='aborted')throw new LlmError(finish.failure.message,finish.failure.code,finish.failure);
    if(finish.kind==='max-tokens')throw Object.assign(Error('伴读检查点达到输出上限，未采用不完整摘要'),{code:'MAX_TOKENS'});
    const rawOutput=assembler.blocks();
    if(contentHasImage(rawOutput))throw new LlmError('伴读检查点不接受图像输出','UNSUPPORTED_CONTENT');
    const summary=rawOutput.filter((block):block is Extract<ContentBlock,{type:'text'}>=>block.type==='text');
    if(!summary.some(block=>block.text.trim()))throw Error('伴读检查点没有正文，原上下文保留');
    return{summary,rawOutput,llmStreamCall:true as const,provider:options.provider,model:options.model,
      maxTokens:options.maxTokens,...(assembler.usage===undefined?{}:{usage:assembler.usage})};
  }
}
