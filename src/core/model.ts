import {parseViewProposals} from './published-views.ts';
import {lengthRepairApplied} from './maintenance-recovery.ts';
import type { AgentModelReply, MemoryQuery, ModelMessage, ModelPort, ModelReply, ModelTool, ModelToolCall, QueryHostReceipt, ReadingReply, ReadingStrategy, Service, State, StateWriteVersion, Usage } from './types.ts';
import { parseCompanionWorkspace, companionThoughtLimit, assertCompanionProposals } from './companion-schema.ts';
import { id } from './books.ts';
import {parseKnowledgeDistribution} from './knowledge-distribution.ts';
import {parseParagraphComments,parseReadingExpression} from './paragraph-comments.ts';
import { ModelRequestError,ModelReceiptSaveError } from './errors.ts';
import { accounting, estimateCost } from './accounting.ts';
import { parseBasis } from './basis.ts';
import {parseStructuralBasis} from './basis.ts';
import {parseDocumentEdits,parseDocumentSourceIds} from './document-revision.ts';
import { parseNarrative } from './narrative.ts';
import {parseSemanticNote} from './semantic-notes.ts';
import { READING_THOUGHT_LIMIT,parseOriginalHistoryQuery } from './types.ts';
import { parseDiscussionQuery } from './discussion-recall.ts';
import { READING_BRIEF_LIMIT } from './reading-brief.ts';
import { parseArcUpdates } from './arc-state.ts';
import {parseEntityRoots,parseWorldNote} from './world-schema.ts';
import { parseStageNarrative, parseStateUpdates } from './stage-state.ts';

export function conservativeTokens(messages: ModelMessage[]): number {
  return messages.reduce((n, m) => n + new TextEncoder().encode(m.content + (m.reasoning_content ?? '') + (m.tool_calls ? JSON.stringify(m.tool_calls) : '') + (m.tool_call_id ?? '')).length + 32, 128);
}
export function conservativeRequestTokens(messages: ModelMessage[], tools: ModelTool[] = []): number {
  return conservativeTokens(tools.length ? [...messages, { role: 'system', content: JSON.stringify({ tools: tools.map(tool => ({ type: 'function', function: tool })) }) }] : messages);
}
export class BudgetError extends Error {}
export class ModelOutputError extends Error {
  response: ModelReply;
  reason?: import('./types.ts').ReadingOutputFailure;
  outcome:NonNullable<QueryHostReceipt['outcome']>;
  constructor(message: string, response: ModelReply, reason?: import('./types.ts').ReadingOutputFailure,outcome?:QueryHostReceipt['outcome']) { super(message); this.name = 'ModelOutputError'; this.response = response; this.reason = reason;this.outcome=outcome??{kind:'invalid-output',reason:message,...(reason?{feedbackReason:reason}:{})}; }
}
export function reserveUsage(state: State, service: Service, messages: ModelMessage[], purpose: string, tools: ModelTool[] = []): Usage {
  if (!Number.isFinite(state.settings.tokenLimit) || state.settings.tokenLimit < 0 || state.settings.costLimit !== undefined && (!Number.isFinite(state.settings.costLimit) || state.settings.costLimit < 0)) throw new BudgetError('用量限额无效，请先修正设置');
  const input = conservativeRequestTokens(messages, tools), output = service.maxOutput;
  if (input + output + 1024 > service.contextLimit) throw new BudgetError('本次资料超过渠道上下文限制，请缩小处理批次');
  const summary = accounting(state), used = summary.tokens;
  if (used + input + output > state.settings.tokenLimit) throw new BudgetError('已达到当前用量上限。记录已保留，可在设置中调整后继续');
  const pricing: Usage['pricing'] = service.inputPrice !== undefined && service.outputPrice !== undefined ? { input: service.inputPrice, output: service.outputPrice, currency: 'CNY' } : undefined;
  const cost = estimateCost(input, output, pricing);
  if (state.settings.costLimit !== undefined) {
    if (cost === undefined) throw new BudgetError('当前服务没有可用计价信息，请完善单价或使用 token 上限');
    if (summary.unknown) throw new BudgetError('本次费用预算内存在未定价请求，无法可靠核算剩余额度；可继续使用 token 限额');
    if (summary.cost + cost > state.settings.costLimit) throw new BudgetError('本次请求会超过费用上限，记录已保存');
  }
  const item: Usage = { id: id(), time: Date.now(), serviceId: service.id, purpose, input, output, estimated: true, cost, status: 'reserved', pricing, costBudgetId: state.settings.costBudgetId };
  state.usage.push(item); return item;
}
export function parseReadingReply(raw: string, stateWriteVersion?:StateWriteVersion, readingStrategy?:ReadingStrategy): ReadingReply {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let obj: unknown;
  try { obj = JSON.parse(trimmed); } catch { throw new Error('模型没有返回完整可用的理解结果，本次未写入记忆'); }
  if (!obj || typeof obj !== 'object') throw new Error('模型结果格式无效');
  const v = obj as Record<string, unknown>;
  if (['profile','profileUpdate','companionProfile'].some(key => Object.hasOwn(v,key))) throw Error('模型结果不能提交profile字段');
  const workspace = parseCompanionWorkspace(v.workspace, readingStrategy);
  const paragraphComments=parseParagraphComments(v.paragraphComments),reaction=parseReadingExpression(v.reaction,paragraphComments);
  if (readingStrategy === 'companion' && ['readingBrief','stageNarrative','stateUpdates','arcUpdates','entityRoots'].some(key => v[key] !== undefined)) throw Error('持续伴读只保存普通认识与工作台引用，不提交其他结构正文');
  let read;
  if (v.read && typeof v.read === 'object') {
    const r = v.read as Record<string, unknown>;
    if (Number.isSafeInteger(r.start) && Number.isSafeInteger(r.end) && Number(r.end) > Number(r.start)) read = { start: Number(r.start), end: Number(r.end) };
  }
  const search = typeof v.search === 'string' && v.search.trim() ? v.search.slice(0, 240) : undefined;
  const lookup = typeof v.lookup === 'string' && v.lookup.trim() ? v.lookup.slice(0, 160) : undefined;
  const lookupHistory=v.lookupHistory===undefined?undefined:parseOriginalHistoryQuery(v.lookupHistory);
  const readPage = typeof v.readPage === 'string' && v.readPage.trim() ? v.readPage.slice(0, 2000) : undefined;
  let recall: MemoryQuery | undefined;
  if (v.recall !== undefined) {
    const r = v.recall;
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('记忆检索参数无效');
    const q = r as Record<string, unknown>;
    if (Object.keys(q).some(k => !['query', 'kind', 'offset', 'chapterIndex','ids','stateView','arcView','view','entityIds','worldView','relations'].includes(k)) ||
      q.relations!==undefined&&(q.relations!==true||!q.ids&&!q.entityIds||q.kind!==undefined||q.chapterIndex!==undefined||q.worldView!==undefined||q.stateView!==undefined||q.arcView!==undefined)||q.entityIds!==undefined&&(!Array.isArray(q.entityIds)||!q.entityIds.length||q.entityIds.length>8||q.entityIds.some(id=>typeof id!=='string'||!id||id.length>128)) || q.worldView!==undefined&&!['current','history'].includes(q.worldView as string) || q.ids!==undefined&&(!Array.isArray(q.ids)||!q.ids.length||q.ids.length>8||q.ids.some(id=>typeof id!=='string'||!id||id.length>128)) ||
      q.query !== undefined && (typeof q.query !== 'string' || q.query.length > 160) ||
      q.kind !== undefined && (typeof q.kind !== 'string' || !['story', 'opinion', 'question', 'shared', 'user', 'context','stage','state','arc'].includes(q.kind)) ||
      q.stateView !== undefined && (q.kind !== 'state' || !['current','history'].includes(q.stateView as string)) ||
      q.arcView !== undefined && (q.kind !== 'arc' || !['current','history'].includes(q.arcView as string)) ||
      q.view !== undefined && (readingStrategy!=='companion'&&!['stage','state','arc'].includes(q.kind as string)&&q.entityIds===undefined&&q.relations!==true || !['index','full'].includes(q.view as string)) ||
      q.offset !== undefined && (!Number.isSafeInteger(q.offset) || Number(q.offset) < 0) || q.chapterIndex !== undefined && (!Number.isSafeInteger(q.chapterIndex) || Number(q.chapterIndex) < 0)) throw new Error('记忆检索参数无效');
    recall = { ...(q.relations?{relations:true as const}:{}),...(q.entityIds?{entityIds:q.entityIds as string[]} :{}),...(q.worldView?{worldView:q.worldView as MemoryQuery['worldView']}:{}),query: typeof q.query === 'string' ? q.query.trim() : undefined, kind: q.kind as MemoryQuery['kind'], offset: q.offset as number | undefined, chapterIndex: q.chapterIndex as number | undefined,...(q.ids?{ids:q.ids as string[]}:{}) ,...(q.stateView?{stateView:q.stateView as MemoryQuery['stateView']}:{}) ,...(q.view?{view:q.view as MemoryQuery['view']}:{}) ,...(q.arcView?{arcView:q.arcView as MemoryQuery['arcView']}:{}) };
  }
  // Tool-only intermediate requests are valid. Final understanding still requires every field.
  const history = v.history === undefined ? undefined : parseDiscussionQuery(v.history);
  const toolOnly = !!(read || search || lookup || lookupHistory || recall || history || readPage);
  if (toolOnly) { v.reply ??= ''; v.thoughts ??= []; }
  // This advisory flag grants no permission: omission means no long-reply request.
  if (v.wantsLong === undefined) v.wantsLong = false;
  if (typeof v.reply !== 'string') throw new Error('模型没有提供有效的回应正文，本次未写入记忆');
  if(v.thoughts===undefined)v.thoughts=[];
  if (!Array.isArray(v.thoughts)) throw new Error('模型没有提供有效的理解条目，本次未写入记忆');
  if (typeof v.wantsLong !== 'boolean') throw new Error('模型的展开请求格式无效，本次未写入记忆');
  const kinds = ['story', 'opinion', 'question', 'shared', 'user'];
  if (v.thoughts.length > READING_THOUGHT_LIMIT) throw new Error(`thoughts最多${READING_THOUGHT_LIMIT}条，请合并重复信息并保留重要变化；本次未保存，不会静默截掉末尾条目`);
  const thoughts = v.thoughts.map((t,index) => {
    if (!t || typeof t !== 'object' || !kinds.includes(t.kind)) throw new Error('模型返回的记忆条目无效');
    const revision=parseDocumentEdits(t),revising=revision.edits!==undefined||revision.appendText!==undefined;
    if(revising&&(t.kind!=='opinion'||!t.updates)||t.documentOperation!==undefined&&!['create','develop','revise'].includes(t.documentOperation))throw Error('局部修订仅可接续opinion完整旧版');
    if(t.documentOperation==='revise'&&!revising||t.documentOperation==='create'&&t.updates!==undefined||t.documentOperation==='develop'&&!t.updates||revising&&t.documentOperation!==undefined&&t.documentOperation!=='revise')throw Error('文档操作与正文接续参数不一致，原答保持');
    const text=revising&&t.text===undefined?'':t.text;
    if(typeof text!=='string'||text.length>companionThoughtLimit(workspace,index,t.kind))throw Error('模型返回的记忆条目无效');
    if (t.answersPartOf !== undefined && (typeof t.answersPartOf !== 'string' || !t.answersPartOf || t.answersPartOf.length > 128 || t.updates !== undefined || !['story','opinion'].includes(t.kind))) throw new Error('部分答案关联无效：仅story或opinion可用answersPartOf关联已提供的原问m编号；新的question独立保存，且不同时填写updates');
    if (t.updates !== undefined && (typeof t.updates !== 'string' || !t.updates || t.updates.length > 128 || typeof t.updateReason !== 'string' || !t.updateReason.trim() || t.updateReason.length > 240) || t.updates === undefined && t.updateReason !== undefined) throw new Error('理解更新缺少有效目标或原因');
    if(t.documentTitle!==undefined&&(typeof t.documentTitle!=='string'||t.documentTitle.length>160)||t.navigationCues!==undefined&&(!Array.isArray(t.navigationCues)||t.navigationCues.length>16||t.navigationCues.some((cue:unknown)=>typeof cue!=='string'||!cue.trim()||cue.length>160)))throw Error('文档导航线索无效');
    const knowledgeDistribution=parseKnowledgeDistribution(t.knowledgeDistribution,`thoughts[${index}].knowledgeDistribution`);
    const quote = typeof t.quote === 'string' ? t.quote.trim() : '';
    const document=t.documentOperation!==undefined||revising;
    if(document&&t.quoteSource!==undefined&&(typeof t.quoteSource!=='string'||!/^p[1-9]\d{0,5}$/.test(t.quoteSource)))throw Error('文档quoteSource须为本轮实际p编号，原答保持');
    const quoteSource = typeof t.quoteSource === 'string' && /^p[1-9]\d{0,5}$/.test(t.quoteSource) ? t.quoteSource : undefined;
    const sourceIds = document?parseDocumentSourceIds(t.sourceIds):Array.isArray(t.sourceIds) && t.sourceIds.every((s: unknown) => typeof s === 'string' && /^p[1-9]\d{0,5}$/.test(s)) ? [...new Set(t.sourceIds as string[])] : undefined;
    // A misplaced optional annotation need not regenerate an otherwise valid
    // answer. Canonical nested fields take precedence; the same validator applies.
    const annotation = t.narrative && typeof t.narrative === 'object' && !Array.isArray(t.narrative)
      ? { ...t.narrative, condition: t.narrative.condition ?? t.condition, storyTime: t.narrative.storyTime ?? t.storyTime } : t.narrative;
    const narrative = parseNarrative(annotation, t.kind);
    return { ...parseWorldNote(t),...parseSemanticNote(t,t.kind),kind: t.kind, text, ...revision,...(knowledgeDistribution?{knowledgeDistribution}:{}),...(t.documentOperation!==undefined?{documentOperation:t.documentOperation}:{}), ...(t.documentTitle!==undefined?{documentTitle:t.documentTitle}:{}),...(t.navigationCues!==undefined?{navigationCues:[...new Set(t.navigationCues as string[])]}:{}), basis: document?parseStructuralBasis(t.basis):parseBasis(t.basis), ...(t.updates ? { updates: t.updates, updateReason: t.updateReason.trim() } : {}), ...(t.answersPartOf ? { answersPartOf: t.answersPartOf } : {}), ...(quote.length >= 8 && quote.length <= 200 ? { quote } : {}), ...(quoteSource ? { quoteSource } : {}), ...(sourceIds!==undefined ? { sourceIds } : {}), ...(narrative ? { narrative } : {}) };
  });
  assertCompanionProposals(workspace,thoughts);
  if (v.reply.length > 20000) throw new Error('模型回应过长');
  if(v.readingBrief!==undefined&&(typeof v.readingBrief!=='string'||v.readingBrief.length>READING_BRIEF_LIMIT))throw new Error('阅读简报须为不超过1000字符的文字');
  const reinforce = Array.isArray(v.reinforce) ? [...new Set(v.reinforce.slice(0, 32).filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 128))] : [];
  const writeVersion=stateWriteVersion??(Array.isArray(v.stateUpdates)&&v.stateUpdates.some(u=>u&&typeof u==='object'&&'operations' in u)?2:1);
  return { views:parseViewProposals(v.views),...(paragraphComments?{paragraphComments}:{}),...(reaction?{reaction}:{}),...(workspace ? {workspace} : {}),entityRoots:parseEntityRoots(v.entityRoots),reply: v.reply, thoughts, wantsLong: v.wantsLong, readingBrief: typeof v.readingBrief==='string'?v.readingBrief.trim():undefined, stageNarrative:parseStageNarrative(v.stageNarrative),stateUpdates:parseStateUpdates(v.stateUpdates,writeVersion),arcUpdates:parseArcUpdates(v.arcUpdates), search, lookup, ...(lookupHistory?{lookupHistory}:{}), recall, history, read, readPage, title: typeof v.title === 'string' ? v.title.trim().slice(0, 40) : undefined, replyBasis: parseBasis(v.replyBasis), reinforce };
}
export type Invoke = (request: { serviceId: string; baseUrl: string; secretRef: string; requestId?: string; dispatchRole?:'ordinary'|'explicit-response';body: Record<string, unknown> }, signal: AbortSignal) => Promise<{ status: number; body: Record<string, any> }>;
function checkModelStatus(response: Awaited<ReturnType<Invoke>>, requestId?: string): void {
  if (response.status >= 200 && response.status < 300) return;
  const usage = response.body?.usage;
  const responseUsage = Number.isSafeInteger(usage?.prompt_tokens) && usage.prompt_tokens >= 0 && Number.isSafeInteger(usage?.completion_tokens) && usage.completion_tokens >= 0 ? { input: usage.prompt_tokens, output: usage.completion_tokens } : undefined;
  throw new ModelRequestError(`模型服务返回 ${response.status}，本次结果未确定，已停止自动重问；请核对原请求记录`, 'unknown', { usageId: requestId, responseUsage, responseReceived: true });
}
export class ChatModel implements ModelPort {
  invoke: Invoke;
  readonly readQueryReceipt?: (requestId:string)=>Promise<QueryHostReceipt>;
  constructor(invoke: Invoke,readQueryReceipt?: (requestId:string)=>Promise<QueryHostReceipt>) { this.invoke = invoke;this.readQueryReceipt=readQueryReceipt; }
  private async request(request: Parameters<Invoke>[0], signal: AbortSignal): ReturnType<Invoke> {
    if (signal.aborted) throw new ModelRequestError('模型请求尚未发出，任务已停止', 'not-dispatched', { usageId: request.requestId });
    try { return await this.invoke(request, signal); }
    catch (error) {
      if (error instanceof ModelRequestError || error instanceof ModelOutputError || error instanceof ModelReceiptSaveError) throw error;
      throw new ModelRequestError('模型请求的结果或结算尚未确定，已停止自动重问；原问题、材料和用量记录已保留', 'unknown', { usageId: request.requestId });
    }
  }
  async completeTools(service: Service, messages: ModelMessage[], tools: ModelTool[], signal: AbortSignal, request?: import('./types.ts').ModelRequestIdentity): Promise<AgentModelReply> {
    const start = performance.now();
    const response = await this.request({ serviceId: service.id, baseUrl: service.baseUrl, secretRef: service.secretRef, requestId: request?.requestId,dispatchRole:request?.dispatchRole, body: {
      model: service.model, messages, stream: false, max_tokens: service.maxOutput,
      ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', function: tool })) } : {}),
      ...((service.thinking ?? (service.id.startsWith('custom-') ? 'none' : 'deepseek')) === 'deepseek' ? { thinking: { type: 'enabled' }, reasoning_effort: service.effort } : {}),
    } }, signal);
    checkModelStatus(response, request?.requestId);
    const choice = response.body.choices?.[0], message = choice?.message, usage = response.body.usage;
    const hasInput = Number.isSafeInteger(usage?.prompt_tokens) && usage.prompt_tokens >= 0, hasOutput = Number.isSafeInteger(usage?.completion_tokens) && usage.completion_tokens >= 0;
    const accounted = {
      content: typeof message?.content === 'string' ? message.content : '',
      input: hasInput ? usage.prompt_tokens : conservativeRequestTokens(messages, tools),
      output: hasOutput ? usage.completion_tokens : service.maxOutput, estimated: !hasInput || !hasOutput, elapsedMs: performance.now() - start,
    };
    const refuse = (text: string): never => { throw new ModelOutputError(text, accounted); };
    if (choice?.finish_reason === 'length') {const policy={model:service.model,maxOutput:service.maxOutput};throw new ModelOutputError('模型输出达到长度上限，未执行不完整工具请求', {...accounted,rawTerminal:{finishReason:'length',message:structuredClone(message??{}),usage:structuredClone(usage??{}),requestPolicy:policy}},'reading-output-length',{kind:'invalid-output',reason:'模型输出达到长度上限，未执行不完整工具请求',feedbackReason:'reading-output-length',...(lengthRepairApplied(messages,policy)?{lengthRepair:policy}:{})});}
    if (!message || !['stop', 'tool_calls'].includes(choice?.finish_reason) || message.content !== null && message.content !== undefined && typeof message.content !== 'string') refuse('模型没有返回有效的Agent结果');
    const calls: unknown = message.tool_calls ?? [];
    if (!Array.isArray(calls) || calls.length > 16) refuse('模型工具请求数量无效');
    const parsed: ModelToolCall[] = [], seen = new Set<string>();
    for (const call of calls as any[]) {
      if (!call || typeof call.id !== 'string' || !call.id || call.id.length > 160 || seen.has(call.id) || call.type !== 'function' || typeof call.function?.name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(call.function.name) || typeof call.function.arguments !== 'string' || call.function.arguments.length > 30000) refuse('模型工具请求标识或参数无效');
      // Keep the provider's raw arguments. Harness preserves malformed JSON as
      // text; each domain tool rejects it before acting and returns a tool error
      // to the same bounded loop. Transport failures and length stops still abort.
      seen.add(call.id); parsed.push({ id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } });
    }
    if (message.reasoning_content !== undefined && message.reasoning_content !== null && typeof message.reasoning_content !== 'string') refuse('模型思考续传格式无效');
    if (choice.finish_reason === 'stop' && !parsed.length && !accounted.content.trim() && hasInput && hasOutput && Number.isInteger(response.status) && response.status >= 200 && response.status < 300) throw new ModelOutputError('模型已结算但没有返回阅读正文', accounted, 'missing-reading-body');
    if (choice.finish_reason === 'tool_calls' && !parsed.length || choice.finish_reason === 'stop' && parsed.length || !parsed.length && !accounted.content.trim()) refuse('模型未完成回应或工具请求');
    return { ...accounted, reasoning: message.reasoning_content ?? '', toolCalls: parsed, finish: choice.finish_reason };
  }
  async complete(service: Service, messages: ModelMessage[], signal: AbortSignal, request?: import('./types.ts').ModelRequestIdentity): Promise<ModelReply> {
    const start = performance.now();
    const response = await this.request({ serviceId: service.id, baseUrl: service.baseUrl, secretRef: service.secretRef, requestId: request?.requestId,dispatchRole:request?.dispatchRole, body: {
      model: service.model, messages, stream: false, max_tokens: service.maxOutput,
      ...((service.thinking ?? (service.id.startsWith('custom-') ? 'none' : 'deepseek')) === 'deepseek' ? { thinking: { type: 'enabled' }, reasoning_effort: service.effort } : {}),
      response_format: { type: 'json_object' }
    } }, signal);
    checkModelStatus(response, request?.requestId);
    const choice = response.body.choices?.[0];
    const content = choice?.message?.content;
    const usage = response.body.usage;
    const hasInput = Number.isSafeInteger(usage?.prompt_tokens) && usage.prompt_tokens >= 0;
    const hasOutput = Number.isSafeInteger(usage?.completion_tokens) && usage.completion_tokens >= 0;
    // Missing usage may include hidden thinking tokens; visible text length is not a safe charge estimate.
    const result = { content: typeof content === 'string' ? content : '', input: hasInput ? usage.prompt_tokens : conservativeTokens(messages), output: hasOutput ? usage.completion_tokens : service.maxOutput, estimated: !hasInput || !hasOutput, elapsedMs: performance.now() - start };
    if (choice?.finish_reason === 'length') throw new ModelOutputError('模型输出达到长度上限，未保存不完整结果', result);
    if (choice?.finish_reason !== 'stop') throw new ModelOutputError('模型回应尚未完整结束，未保存不完整结果', result);
    if (!result.content.trim()) throw new ModelOutputError('模型没有返回正文，可能需要增加输出额度', result);
    return result;
  }
}
