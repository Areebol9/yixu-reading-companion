import {parseDocumentOrganization} from './document-organization.ts';
import type {ModelStreamObserver} from './provider-stream.ts';
import {compileProviderTools} from './provider-schema.ts';
import type {ProviderReceipt,ProviderTermination,ProviderSchemaReceipt} from './provider-capabilities.ts';
import {isProviderTermination,validateProviderCapabilities,verifyProviderTermination} from './provider-capabilities.ts';
import {parseViewProposals} from './published-views.ts';
import type { AgentModelReply, MemoryQuery, ModelMessage, ModelPort, ModelReply, ModelTool, ModelToolCall, QueryHostReceipt, CloseReadingAttemptInput, CloseReadingAttemptResult, ReadingReply, ReadingStrategy, Service, State, StateWriteVersion, Usage } from './types.ts';
import { parseCompanionWorkspace, companionThoughtLimit, assertCompanionProposals } from './companion-schema.ts';
import { id } from './books.ts';
import {parseKnowledgeDistribution} from './knowledge-distribution.ts';
import {parseParagraphComments,parseReadingExpression} from './paragraph-comments.ts';
import { ModelRequestError,ModelReceiptSaveError,ProviderTerminalError } from './errors.ts';
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
import {parsePartnerMaintenance} from './partner-persona-tools.ts';
import {modelRequestParameters} from './model-parameters.ts';

export function conservativeTokens(messages: ModelMessage[]): number {
  // Local conservative reservation units, not provider-measured context tokens.
  return messages.reduce((n, m) => n + new TextEncoder().encode(m.content + (m.reasoning_content ?? '') + (m.tool_calls ? JSON.stringify(m.tool_calls) : '') + (m.tool_call_id ?? '')).length + 32, 128);
}
export function conservativeRequestTokens(messages: ModelMessage[], tools: ModelTool[] = []): number {
  return conservativeTokens(tools.length ? [...messages, { role: 'system', content: JSON.stringify({ tools: tools.map(tool=>({type:'function',function:tool})) }) }] : messages);
}
export class BudgetError extends Error {}
export function parseDocumentScope(value:unknown,label='scope'):'book'|'partner'|undefined{
  if(value===undefined)return undefined;
  if(value!=='book'&&value!=='partner')throw Error(label+'须为book或partner，原答保持');
  return value;
}
export class ModelOutputError extends Error {
  response: ModelReply;
  reason?: import('./types.ts').ReadingOutputFailure;
  outcome:NonNullable<QueryHostReceipt['outcome']>;
  constructor(message: string, response: ModelReply, reason?: import('./types.ts').ReadingOutputFailure,outcome?:QueryHostReceipt['outcome']) { super(message); this.name = 'ModelOutputError'; this.response = response; this.reason = reason;this.outcome=outcome??{kind:'invalid-output',reason:message,...(reason?{feedbackReason:reason}:{})}; }
}
export function reserveUsage(state: State, service: Service, messages: ModelMessage[], purpose: string, tools: ModelTool[] = [], externalTokenAuthority=false): Usage {
  if (!Number.isFinite(state.settings.tokenLimit) || state.settings.tokenLimit < 0 || state.settings.costLimit !== undefined && (!Number.isFinite(state.settings.costLimit) || state.settings.costLimit < 0)) throw new BudgetError('用量限额无效，请先修正设置');
  const input = conservativeRequestTokens(messages, tools), output = service.maxOutput;
  const summary = accounting(state), used = summary.tokens;
  if (!externalTokenAuthority && used + input + output > state.settings.tokenLimit) throw new BudgetError('已达到当前用量上限。记录已保留，可在设置中调整后继续');
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
export function parseReadingReply(raw: string, stateWriteVersion?:StateWriteVersion, readingStrategy?:ReadingStrategy, options:{partnerMaintenance?:boolean}={}): ReadingReply {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let obj: unknown;
  try { obj = JSON.parse(trimmed); } catch { throw new Error('模型没有返回完整可用的理解结果，本次未写入记忆'); }
  if (!obj || typeof obj !== 'object') throw new Error('模型结果格式无效');
  const v = obj as Record<string, unknown>;
  if (['profile','profileUpdate','companionProfile'].some(key => Object.hasOwn(v,key))) throw Error('模型结果不能提交profile字段');
  if(v.partnerMaintenance!==undefined&&!options.partnerMaintenance)throw Error('只有后台维护可以修订伙伴人格与个人主题');
  let partnerMaintenance:ReadingReply['partnerMaintenance'],partnerMaintenanceIssue:ReadingReply['partnerMaintenanceIssue'];
  if(v.partnerMaintenance!==undefined)try{partnerMaintenance=parsePartnerMaintenance(v.partnerMaintenance);}catch(error){partnerMaintenanceIssue={reason:(error as Error).message,proposal:structuredClone(v.partnerMaintenance)};}
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
      q.relations!==undefined&&(q.relations!==true||!q.ids&&!q.entityIds||q.kind!==undefined||q.chapterIndex!==undefined||q.worldView!==undefined||q.stateView!==undefined||q.arcView!==undefined)||q.entityIds!==undefined&&(!Array.isArray(q.entityIds)||!q.entityIds.length||q.entityIds.length>8||q.entityIds.some(id=>typeof id!=='string'||!id||id.length>128)) || q.worldView!==undefined&&!['current','history'].includes(q.worldView as string) || q.ids!==undefined&&(!Array.isArray(q.ids)||!q.ids.length||q.ids.some(id=>typeof id!=='string'||!id||id.length>128)) ||
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
  if (v.thoughts.filter(t=>t?.kind!=='opinion').length > READING_THOUGHT_LIMIT) throw new Error(`非认识文档条目最多${READING_THOUGHT_LIMIT}条，本次未保存，不会静默截掉末尾条目`);
  const thoughts = v.thoughts.map((t,index) => {
    if (!t || typeof t !== 'object' || !kinds.includes(t.kind)) throw new Error('模型返回的记忆条目无效');
    const scope=parseDocumentScope(t.scope,`thoughts[${index}].scope`);
    if(scope==='book'&&['shared','user'].includes(t.kind))throw Error('用户认识与私人共同经历须保留为partner文档');
    const revision=parseDocumentEdits(t),revising=revision.edits!==undefined||revision.appendText!==undefined;
    if(revising&&(t.kind!=='opinion'||!t.updates)||t.documentOperation!==undefined&&!['create','develop','revise','merge','organize','retire','restore'].includes(t.documentOperation))throw Error('局部修订仅可接续opinion完整旧版');
    if(t.documentOperation==='revise'&&!revising||t.documentOperation==='create'&&t.updates!==undefined||t.documentOperation==='develop'&&!t.updates||revising&&t.documentOperation!==undefined&&t.documentOperation!=='revise')throw Error('文档操作与正文接续参数不一致，原答保持');
    if(t.documentOperation==='merge'&&(t.kind!=='opinion'||!t.updates||revising||typeof t.text!=='string'||!t.text.trim()||!Array.isArray(t.mergePreviousIds)||!t.mergePreviousIds.length||t.mergePreviousIds.some((id:unknown)=>typeof id!=='string'||!id||id.length>128)||new Set([t.updates,...t.mergePreviousIds]).size!==t.mergePreviousIds.length+1)||t.documentOperation!=='merge'&&t.mergePreviousIds!==undefined)throw Error('认识归并须明确主前驱、互异额外前驱及完整新正文，不混用局部修订');
    const lifecycle=['organize','retire','restore'].includes(t.documentOperation??'');
    if(lifecycle&&(t.kind!=='opinion'||!t.updates||revising))throw Error('文档整理、退出或恢复须指向完整旧版，不能混入正文修订');
    if(t.replacementIds!==undefined&&(t.documentOperation!=='retire'||!Array.isArray(t.replacementIds)||!t.replacementIds.length||t.replacementIds.some((id:unknown)=>typeof id!=='string'||!id)||new Set(t.replacementIds).size!==t.replacementIds.length))throw Error('承接文档只用于退出操作，须为互异的实际文档编号');
    const text=(revising||lifecycle)&&t.text===undefined?'':t.text;
    const textLimit=companionThoughtLimit(workspace,index,t.kind);
    if(typeof text!=='string'||textLimit!==undefined&&text.length>textLimit)throw Error('模型返回的记忆条目无效');
    if (t.answersPartOf !== undefined && (typeof t.answersPartOf !== 'string' || !t.answersPartOf || t.answersPartOf.length > 128 || t.updates !== undefined || !['story','opinion'].includes(t.kind))) throw new Error('部分答案关联无效：仅story或opinion可用answersPartOf关联已提供的原问m编号；新的question独立保存，且不同时填写updates');
    if (t.updates !== undefined && (typeof t.updates !== 'string' || !t.updates || t.updates.length > 128 || typeof t.updateReason !== 'string' || !t.updateReason.trim() || t.updateReason.length > 240) || t.updates === undefined && t.updateReason !== undefined) throw new Error('理解更新缺少有效目标或原因');
    if(t.documentTitle!==undefined&&(typeof t.documentTitle!=='string'||t.documentTitle.length>160)||t.navigationCues!==undefined&&(!Array.isArray(t.navigationCues)||t.navigationCues.length>16||t.navigationCues.some((cue:unknown)=>typeof cue!=='string'||!cue.trim()||cue.length>160)))throw Error('文档导航线索无效');
    const organization=parseDocumentOrganization(t.organization);
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
    return { ...parseWorldNote(t),...parseSemanticNote(t,t.kind),kind: t.kind, text, ...(scope?{scope}:{}), ...revision,...(organization?{organization}:{}),...(knowledgeDistribution?{knowledgeDistribution}:{}),...(t.documentOperation!==undefined?{documentOperation:t.documentOperation}:{}),...(t.replacementIds?{replacementIds:[...t.replacementIds]}:{}),...(t.mergePreviousIds!==undefined?{mergePreviousIds:[...t.mergePreviousIds]}:{}), ...(t.documentTitle!==undefined?{documentTitle:t.documentTitle}:{}),...(t.navigationCues!==undefined?{navigationCues:[...new Set(t.navigationCues as string[])]}:{}), basis: document?parseStructuralBasis(t.basis):parseBasis(t.basis), ...(t.updates ? { updates: t.updates, updateReason: t.updateReason.trim() } : {}), ...(t.answersPartOf ? { answersPartOf: t.answersPartOf } : {}), ...(quote.length >= 8 && quote.length <= 200 ? { quote } : {}), ...(quoteSource ? { quoteSource } : {}), ...(sourceIds!==undefined ? { sourceIds } : {}), ...(narrative ? { narrative } : {}) };
  });
  assertCompanionProposals(workspace,thoughts);
  if (v.reply.length > 20000) throw new Error('模型回应过长');
  if(v.readingBrief!==undefined&&(typeof v.readingBrief!=='string'||v.readingBrief.length>READING_BRIEF_LIMIT))throw new Error('阅读简报须为不超过1000字符的文字');
  const reinforce = Array.isArray(v.reinforce) ? [...new Set(v.reinforce.slice(0, 32).filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 128))] : [];
  const writeVersion=stateWriteVersion??(Array.isArray(v.stateUpdates)&&v.stateUpdates.some(u=>u&&typeof u==='object'&&'operations' in u)?2:1);
  return { ...(partnerMaintenance?{partnerMaintenance}:{}),...(partnerMaintenanceIssue?{partnerMaintenanceIssue}:{}),views:parseViewProposals(v.views),...(paragraphComments?{paragraphComments}:{}),...(reaction?{reaction}:{}),...(workspace ? {workspace} : {}),entityRoots:parseEntityRoots(v.entityRoots),reply: v.reply, thoughts, wantsLong: v.wantsLong, readingBrief: typeof v.readingBrief==='string'?v.readingBrief.trim():undefined, stageNarrative:parseStageNarrative(v.stageNarrative),stateUpdates:parseStateUpdates(v.stateUpdates,writeVersion),arcUpdates:parseArcUpdates(v.arcUpdates), search, lookup, ...(lookupHistory?{lookupHistory}:{}), recall, history, read, readPage, title: typeof v.title === 'string' ? v.title.trim().slice(0, 40) : undefined, replyBasis: parseBasis(v.replyBasis), reinforce };
}
export type Invoke = (request: { serviceId: string; baseUrl: string; secretRef: string; requestId?: string; dispatchRole?:'ordinary'|'explicit-response';businessPayload?:{messages:ModelMessage[];tools:ModelTool[]};body: Record<string, unknown> }, signal: AbortSignal, onStream?:ModelStreamObserver) => Promise<{ status: number; body: Record<string, any>;rawBody?:string;rawBodyHash?:string;termination?:ProviderTermination;headers?:Record<string,string> }>;
function checkModelStatus(response: Awaited<ReturnType<Invoke>>, requestId?: string, receipt?:ProviderReceipt): void {
  if (response.status >= 200 && response.status < 300) return;
  const usage = response.body?.usage;
  const responseUsage = Number.isSafeInteger(usage?.prompt_tokens) && usage.prompt_tokens >= 0 && Number.isSafeInteger(usage?.completion_tokens) && usage.completion_tokens >= 0 ? { input: usage.prompt_tokens, output: usage.completion_tokens } : undefined;
  if(isProviderTermination(response.termination,requestId)&&response.termination.status===response.status&&receipt)throw new ProviderTerminalError('提供方明确拒绝本次请求，原失败和未结算预留保留',response.termination,receipt,responseUsage);
  const error=response.body?.error,capacityCode=typeof error?.code==='string'&&['context_length_exceeded','context_window_exceeded','max_tokens_exceeded','tokens_limit_exceeded'].includes(error.code)?error.code:undefined;
  if(receipt?.capability?.transport==='native-http'&&capacityCode)throw new ModelRequestError(`提供方返回容量错误 ${capacityCode}（HTTP ${response.status}）；原提供方回执保留，未重发或改变用量预留`, 'unknown', { usageId: requestId, responseUsage, responseReceived: true });
  throw new ModelRequestError(`模型服务返回 ${response.status}，本次结果未确定，已停止自动重问；请核对原请求记录`, 'unknown', { usageId: requestId, responseUsage, responseReceived: true });
}
export function createProviderReceipt(service:Service,response:Awaited<ReturnType<Invoke>>,schema?:ProviderSchemaReceipt):ProviderReceipt{
  const body=response.body,choice=body?.choices?.[0];return{version:'provider-receipt-v1',status:response.status,body:structuredClone(body),bodyEncoding:typeof response.rawBody==='string'?'wire-utf8':'derived-json',...(typeof response.rawBody==='string'?{rawBody:response.rawBody,rawBodyHash:response.rawBodyHash}:{}),...(typeof body?.id==='string'?{responseId:body.id}:{}),...(typeof choice?.finish_reason==='string'?{finishReason:choice.finish_reason}:{}),...(body?.usage&&typeof body.usage==='object'?{usage:structuredClone(body.usage)}:{}),...(service.providerCapabilities?{capability:structuredClone(service.providerCapabilities)}:{}),...(schema?{schema}:{})};
}
function assertProviderHistory(service:Service,messages:ModelMessage[],tools:ModelTool[]):void{
  if(!service.providerCapabilities||service.providerCapabilities.transport!=='native-http')return;
  const pending=new Set<string>();
  for(const message of messages){
    if(message.role==='tool'){if(!message.tool_call_id||!pending.delete(message.tool_call_id))throw Error('工具结果未与真实调用配对，未派发');continue;}
    if(pending.size)throw Error('工具结果尚未收齐，未派发');
    if(message.role==='assistant'){
      if(tools.length&&service.providerCapabilities.reasoningContinuation==='required'&&typeof message.reasoning_content!=='string')throw Error('原助手消息缺少提供方必需的思考续传字段，未派发');
      for(const call of message.tool_calls??[]){if(pending.has(call.id))throw Error('工具调用标识重复，未派发');pending.add(call.id);}
    }
  }
  if(pending.size)throw Error('工具调用尚无结果，未派发');
}
export function parseNativeToolResponse(service:Service,messages:ModelMessage[],tools:ModelTool[],response:Awaited<ReturnType<Invoke>>,elapsedMs:number,requestId?:string,schema?:ProviderSchemaReceipt):AgentModelReply{
    const providerReceipt=createProviderReceipt(service,response,schema);
    checkModelStatus(response, requestId,providerReceipt);
    const choice = response.body.choices?.[0], message = choice?.message, usage = response.body.usage;
    const hasInput = Number.isSafeInteger(usage?.prompt_tokens) && usage.prompt_tokens >= 0, hasOutput = Number.isSafeInteger(usage?.completion_tokens) && usage.completion_tokens >= 0;
    const accounted = {
      content: typeof message?.content === 'string' ? message.content : '',
      input: hasInput ? usage.prompt_tokens : conservativeRequestTokens(messages, tools),
      output: hasOutput ? usage.completion_tokens : service.maxOutput, estimated: !hasInput || !hasOutput, elapsedMs, providerReceipt, ...(requestId?{requestId}:{}),
    };
    const refuse = (text: string): never => { throw new ModelOutputError(text, {...accounted,rawTerminal:{finishReason:String(choice?.finish_reason??'invalid'),message:structuredClone(message??{}),usage:structuredClone(usage??{}),requestPolicy:{model:service.model,maxOutput:service.maxOutput}}}); };
    if (choice?.finish_reason === 'length') {const policy={model:service.model,maxOutput:service.maxOutput};throw new ModelOutputError('模型输出达到长度上限，未执行不完整工具请求', {...accounted,rawTerminal:{finishReason:'length',message:structuredClone(message??{}),usage:structuredClone(usage??{}),requestPolicy:policy}},'reading-output-length');}
    if (!message || !['stop', 'tool_calls'].includes(choice?.finish_reason) || message.content !== null && message.content !== undefined && typeof message.content !== 'string') refuse('模型没有返回有效的Agent结果');
    const calls: unknown = message.tool_calls ?? [];
    if (!Array.isArray(calls)) refuse('模型工具请求格式无效');
    const parsed: ModelToolCall[] = [], seen = new Set<string>();
    for (const call of calls as any[]) {
      if (!call || typeof call.id !== 'string' || !call.id || call.id.length > 160 || seen.has(call.id) || call.type !== 'function' || typeof call.function?.name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(call.function.name) || typeof call.function.arguments !== 'string') refuse('模型工具请求标识或参数无效');
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
export class ChatModel implements ModelPort {
  tokenBudgetAuthority?:'provider-ledger';
  invoke: Invoke;
  readonly readQueryReceipt?: ModelPort['readQueryReceipt'];
  readonly closeReadingAttempt?: (input:CloseReadingAttemptInput)=>Promise<CloseReadingAttemptResult>;
  constructor(invoke: Invoke,readQueryReceipt?: ModelPort['readQueryReceipt'],closeReadingAttempt?: (input:CloseReadingAttemptInput)=>Promise<CloseReadingAttemptResult>) { this.invoke = invoke;this.readQueryReceipt=readQueryReceipt;this.closeReadingAttempt=closeReadingAttempt; }
  private async request(request: Parameters<Invoke>[0], signal: AbortSignal, onStream?:ModelStreamObserver): ReturnType<Invoke> {
    if (signal.aborted) throw new ModelRequestError('模型请求尚未发出，任务已停止', 'not-dispatched', { usageId: request.requestId });
    try { return await this.invoke(request, signal, onStream); }
    catch (error) {
      if (error instanceof ModelRequestError || error instanceof ModelOutputError || error instanceof ModelReceiptSaveError) throw error;
      throw new ModelRequestError('模型请求的结果或结算尚未确定，已停止自动重问；原问题、材料和用量记录已保留', 'unknown', { usageId: request.requestId });
    }
  }
  async completeTools(service: Service, messages: ModelMessage[], tools: ModelTool[], signal: AbortSignal, request?: import('./types.ts').ModelRequestIdentity): Promise<AgentModelReply> {
    const start = performance.now();
    let compiled:Awaited<ReturnType<typeof compileProviderTools>>;
    try{compiled=await compileProviderTools(service,tools);assertProviderHistory(service,messages,tools);}catch(error){throw new ModelRequestError((error as Error).message,'not-dispatched',{usageId:request?.requestId});}
    const response = await this.request({ businessPayload:{messages,tools},serviceId: service.id, baseUrl: service.baseUrl, secretRef: service.secretRef, requestId: request?.requestId,dispatchRole:request?.dispatchRole, body: {
      model: service.model, messages, stream: true, stream_options:{include_usage:true}, max_tokens: service.maxOutput,
      ...(tools.length ? { tools: compiled.tools } : {}),
      ...modelRequestParameters(service),
    } }, signal, request?.onStream);
    if(response.termination&&!await verifyProviderTermination(response.termination,createProviderReceipt(service,response),service,request?.requestId??''))delete response.termination;
    return parseNativeToolResponse(service,messages,tools,response,performance.now()-start,request?.requestId,compiled.schema);
  }
  async complete(service: Service, messages: ModelMessage[], signal: AbortSignal, request?: import('./types.ts').ModelRequestIdentity): Promise<ModelReply> {
    const start = performance.now();
    const response = await this.request({ serviceId: service.id, baseUrl: service.baseUrl, secretRef: service.secretRef, requestId: request?.requestId,dispatchRole:request?.dispatchRole, body: {
      model: service.model, messages, stream: false, max_tokens: service.maxOutput,
      ...modelRequestParameters(service),
      response_format: { type: 'json_object' }
    } }, signal);
    checkModelStatus(response, request?.requestId);
    const choice = response.body.choices?.[0];
    const content = choice?.message?.content;
    const usage = response.body.usage;
    const hasInput = Number.isSafeInteger(usage?.prompt_tokens) && usage.prompt_tokens >= 0;
    const hasOutput = Number.isSafeInteger(usage?.completion_tokens) && usage.completion_tokens >= 0;
    // Missing usage may include hidden thinking tokens; visible text length is not a safe charge estimate.
    const result = { content: typeof content === 'string' ? content : '', input: hasInput ? usage.prompt_tokens : conservativeTokens(messages), output: hasOutput ? usage.completion_tokens : service.maxOutput, estimated: !hasInput || !hasOutput, elapsedMs: performance.now() - start,providerReceipt:createProviderReceipt(service,response) };
    if (choice?.finish_reason === 'length') throw new ModelOutputError('模型输出达到长度上限，未保存不完整结果', result);
    if (choice?.finish_reason !== 'stop') throw new ModelOutputError('模型回应尚未完整结束，未保存不完整结果', result);
    if (!result.content.trim()) throw new ModelOutputError('模型没有返回正文，可能需要增加输出额度', result);
    return result;
  }
}
