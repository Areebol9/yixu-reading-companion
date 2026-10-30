import {detectBookStructure} from './book-structure.ts';
import {directoryFromModel,directoryModelMessages} from './book-directory.ts';
import {hasUnreadPresentation} from './message-reactions.ts';
import {validateModelParameters} from './model-parameters.ts';
import {memoryReadableByPartner} from './book-document-ownership.ts';
import {bookAnalysisOperationCarriers,planBookAnalysisReconciliation,applyBookAnalysisReconciliation} from './book-analysis-reconciliation.ts';
import {replacePartnerPersonaFromTemplate,adoptPartnerTemplate,createPartnerFromTemplate,getPartnerPersonaSnapshot,getPartnerPersonaParameters,revisePartnerPersonaParameters,validatePartnerPreferences,initializeDefaultPartnerLanguage} from './partner-persona.ts';
import {partnerAvatarAsset} from './partner-avatar.ts';
import type {KnowledgeDocumentQuery} from './knowledge-distribution.ts';
import {currentPublishedViews,viewProgress} from './published-views.ts';
import {resolveStorageMaterials,storageMaterialOwners} from './storage-records.ts';
import { bookLength, importBook, bookSourceFile, locateObservation,mergeRanges } from './books.ts';
import {AnalysisCore} from './analysis-core.ts';
import type {WorkDossierRequest} from './work-dossier.ts';
import type {AnswerScope} from './answer-materials.ts';
import { deleteChat, forgetMemory, isEvidenceAllowed, memoryIsForgotten } from './context.ts';
import { hydrateMemoryBodies, releasePersistedMemoryBodies, requireMemoryText } from './memory-bodies.ts';
import { restoreBackup,collectPartnerAvatarAssets } from './backup.ts';
import { resolveNativeAgentSessionsForBackup } from './agent-session-backup.ts';
import {CommittedApplicationProjection,CommittedPublishedRepliesProjection,recentPublishedReplies} from './application-projection.ts';
import { validateService, validateServiceCapacity } from './services.ts';
import { applicationCommands, freezeData } from './application-contract.ts';
import type { ApplicationClient, ApplicationCommand, ApplicationSnapshot, ApplicationChange,CommandArgs, CommandResult } from './application-contract.ts';
import type { ReadingRuntime } from './runtime.ts';
import type { HabitKey, Range, Service, ReadingMode, State,Settings } from './types.ts';
import {prepareBookSourceExtension} from './book-versions.ts';
import {applyMessageEmojiReaction,localReaderActorId,messageEmojiReactionTargetIds,resolveMessageEmojiReactionTarget} from './message-reactions.ts';
import {ConversationMessageProjection,listConversationMessages} from './conversation-messages.ts';
import type {ConversationMessageQuery} from './conversation-messages.ts';
import {memorySummary} from './ui-records.ts';

export type ApplicationHost = <T>(method: string, payload: unknown) => Promise<T>;
export type ServicePatch = Partial<Pick<Service, 'name' | 'model' | 'baseUrl' | 'effort' | 'contextLimit' | 'maxOutput' | 'thinking' | 'fallback'>> & { enabled?: false; inputPrice?: number | null; outputPrice?: number | null; temperature?:number|null;topP?:number|null };
export type LimitsPatch = { tokenLimit?: number; costLimit?: number | null; readingEffort?: import('./types.ts').ModelEffort };
export type ModelSettingsInput={serviceId?:string;metadata?:Service;patch:ServicePatch;key:string;limits?:LimitsPatch};
type HostServiceMetadata=Pick<Service,'id'|'baseUrl'|'model'|'contextLimit'>&Partial<Service>&{hasKey:boolean;transport?:'native-codex'|'native-http'};
function serviceFromHost(authority:HostServiceMetadata):Service{
  return{id:authority.id,name:authority.name??authority.id,baseUrl:authority.baseUrl,model:authority.model,contextLimit:authority.contextLimit,maxOutput:authority.maxOutput??4096,effort:authority.effort??'high',enabled:false,fallback:false,secretRef:authority.secretRef??authority.id,thinking:authority.thinking??(authority.id.startsWith('custom-')?'none':'deepseek'),...(authority.binding?{binding:true}:{}),...(authority.temperature!==undefined?{temperature:authority.temperature}:{}),...(authority.topP!==undefined?{topP:authority.topP}:{}),...(authority.inputPrice!==undefined?{inputPrice:authority.inputPrice}:{}),...(authority.outputPrice!==undefined?{outputPrice:authority.outputPrice}:{}),...(authority.providerCapabilities?{providerCapabilities:structuredClone(authority.providerCapabilities)}:{})};
}
function customService(id:string):Service{return{id,name:'自定义兼容服务',baseUrl:'',model:'',contextLimit:32000,effort:'high',maxOutput:4096,enabled:false,fallback:false,secretRef:id,thinking:'none'};}
function validateServicePatch(patch:ServicePatch){
  const fields=['name','model','baseUrl','effort','contextLimit','maxOutput','inputPrice','outputPrice','thinking','fallback','enabled','temperature','topP'];
  if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(k=>!fields.includes(k))||patch.enabled!==undefined&&patch.enabled!==false)throw Error('服务修改字段无效');
}
function patchService(settings:Settings,serviceId:string,patch:ServicePatch):Service{
  const service=settings.services.find(s=>s.id===serviceId);if(!service)throw Error('模型服务不存在');
  if(service.binding)throw Error('伙伴已绑定的模型配置独立保留，请在伙伴页面重新选择渠道');
  const next={...service,...patch};if('baseUrl'in patch||'model'in patch)next.enabled=false;
  if(next.inputPrice===null)delete next.inputPrice;if(next.outputPrice===null)delete next.outputPrice;if(next.temperature===null)delete next.temperature;if(next.topP===null)delete next.topP;
  if(typeof next.name!=='string'||typeof next.baseUrl!=='string'||typeof next.model!=='string'||typeof next.fallback!=='boolean')throw Error('服务配置字段无效');
  if(!['low','medium','high','max'].includes(next.effort)||![undefined,'none','deepseek'].includes(next.thinking))throw Error('思考配置无效');
  validateServiceCapacity(next);validateModelParameters({...next,temperature:next.temperature??undefined,topP:next.topP??undefined});
  for(const price of [next.inputPrice,next.outputPrice])if(price!==undefined&&(!Number.isFinite(price)||price<0))throw Error('单价应为非负金额');
  if(!serviceId.startsWith('custom-')&&next.baseUrl!==service.baseUrl)throw Error('预置渠道地址固定');
  Object.assign(service,next);if('inputPrice'in patch&&patch.inputPrice==null)delete service.inputPrice;if('outputPrice'in patch&&patch.outputPrice==null)delete service.outputPrice;
  for(const key of ['temperature','topP'] as const)if(patch[key]===null)delete service[key];
  return service;
}
function patchLimits(settings:Settings,patch:LimitsPatch){
  if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(k=>!['tokenLimit','costLimit','readingEffort'].includes(k)))throw Error('用量设置字段无效');
  if(patch.tokenLimit!==undefined){if(!Number.isFinite(patch.tokenLimit)||patch.tokenLimit<0)throw Error('用量上限无效');settings.tokenLimit=patch.tokenLimit;}
  if(patch.costLimit!=null&&(!Number.isFinite(patch.costLimit)||patch.costLimit<0))throw Error('费用上限应为非负金额');
  if(patch.readingEffort!==undefined){if(!['low','medium','high','max'].includes(patch.readingEffort))throw Error('阅读思考强度无效');settings.readingEffort=patch.readingEffort;}
}
const costOption=(patch:LimitsPatch)=>Object.hasOwn(patch,'costLimit')?{costLimit:patch.costLimit}:undefined;

// All mutating application operations live beside the engine. The renderer only sends
// explicit commands and receives detached metadata; it never receives original books.
export class ApplicationActions {
  private runtime: ReadingRuntime;
  private host: ApplicationHost;
  private configurationEpoch = 0;
  private directoryEpochs=new Map<string,number>();
  private searchEpoch = 0;
  private restoring = false;
  get replacingData() { return this.restoring; }
  constructor(runtime: ReadingRuntime, host: ApplicationHost) { this.runtime = runtime; this.host = host; }
  private get engine() { return this.runtime.engine; }
  async resumeTerminatedMaintenance(input:import('./types.ts').TerminatedMaintenanceResume){await this.engine.resumeTerminatedMaintenance(input);}
  async resumeMaintenance(jobId:string){await this.engine.resumeMaintenance(jobId);}
  async closeLostMaintenance(jobId:string){await this.engine.closeLostMaintenance(jobId);}
  async dismissMaintenance(jobId:string){await this.engine.dismissMaintenance(jobId);}
  async restoreMaintenance(jobId:string,expected:Exclude<import('./types.ts').ReadingRecoveryExecution,'none'>){await this.engine.restoreMaintenance(jobId,expected);}
  async importText(title: string, text: string, sourceFile?:import('./types.ts').BookSourceFile) {
    const book = await importBook(title, text, sourceFile);
    let bookId = book.id, existing = false;
    await this.engine.editScopedState({collections:{books:'all'}},state => {
      const prior = state.books.find(b => b.version === book.version);
      if (prior) { bookId = prior.id; existing = true; if(book.sourceFile)prior.sourceFile=book.sourceFile; } else state.books.push(book);
    });
    return { bookId, existing };
  }
  async recognizeBookDirectory(bookId:string,useModel:boolean){
    if(typeof useModel!=='boolean')throw Error('请选择目录识别方式');
    const epoch=(this.directoryEpochs.get(bookId)??0)+1;this.directoryEpochs.set(bookId,epoch);
    const book=this.engine.book(bookId),version=book.version,title=book.title;
    const text=book.text.length===bookLength(book)?book.text:await this.engine.store.readBookText?.(version);
    if(typeof text!=='string'||!text)throw Error('本书原文暂时无法读取，原目录已保留');
    const detected=detectBookStructure(title,text);
    const directory=useModel?directoryFromModel(text,version,detected,await this.engine.recognizeBookStructure(bookId,directoryModelMessages(title,detected))):{version,entries:detected.chapters,unresolved:detected.ambiguous,method:'local' as const};
    const current=()=>{const target=this.engine.state.books.find(item=>item.id===bookId);return target?.version===version&&target.title===title&&this.directoryEpochs.get(bookId)===epoch;};
    await this.engine.editScopedState({collections:{books:[bookId]}},state=>{
      const target=state.books.find(item=>item.id===bookId)!;
      target.directory=directory;
      // Before any reading starts, corrected navigation also supplies the real
      // reading sections. Once records depend on section indices, keep them stable.
      const untouched=!target.known.length&&!target.prepared.length&&!state.chats.some(item=>item.bookId===bookId)&&!state.memories.some(item=>item.bookId===bookId)&&!(state.readings??[]).some(item=>item.bookId===bookId)&&!(state.maintenanceJobs??[]).some(item=>item.bookId===bookId)&&!state.usage.some(item=>item.purpose!=='目录结构识别'&&item.requestKey?.includes(JSON.stringify(bookId)))&&!(this.engine.session?.active&&this.engine.session.bookId===bookId);
      if(untouched)target.chapters=directory.entries.map(entry=>({...entry}));
    },current);
    return{entries:directory.entries.length,unresolved:directory.unresolved};
  }
  async selectBook(bookId: string) {
    this.engine.book(bookId);
    if (this.engine.session?.active && this.engine.session.bookId !== bookId) await this.stopReadingSafely();
  }
  async renameBook(bookId:string,title:string){
    this.engine.book(bookId);if(typeof title!=='string'||!title.trim()||title.trim().length>200||/[\r\n\u0000-\u001f]/u.test(title))throw Error('书名须为1至200字的单行文字');
    const value=title.trim();if(this.engine.book(bookId).title===value)return;
    await this.engine.editScopedState({collections:{books:[bookId]}},state=>{state.books.find(book=>book.id===bookId)!.title=value;});
  }
  async extendBookSource(bookId:string,raw:string,title?:string,sourceFile?:import('./types.ts').BookSourceFile){
    if(title!==undefined&&(!title.trim()||title.trim().length>200||/[\r\n\u0000-\u001f]/u.test(title)))throw Error('书名须为1至200字的单行文字');
    const current=this.engine.book(bookId),version=current.version;
    const oldText=this.engine.store.readBookText?await this.engine.store.readBookText(version):current.text;
    const next=await prepareBookSourceExtension(current,oldText,raw,title?.trim()??current.title);
    next.sourceFile=bookSourceFile(sourceFile);
    await this.runtime.stopCapture();await this.engine.pauseReadingSafely();
    if(this.engine.book(bookId).version!==version)throw Error('书籍原文已更换，请重新核对来源');
    await this.engine.installBookSource(next);
    return{bookId,previousVersion:version,version:next.version,chapters:next.chapters.length};
  }
  async setArchived(bookId: string, value: boolean) { this.engine.book(bookId); if (typeof value !== 'boolean') throw new Error('归档状态无效'); await this.engine.editScopedState({collections:{books:[bookId]}},state => { state.books.find(b => b.id === bookId)!.archived = value; }); }
  setKnown(bookId: string, through: number, from?: number) { return this.engine.setKnown(bookId, through, from); }
  readBookRange(bookId:string,range:import('./types.ts').Range){return this.engine.readBookRange(bookId,range);}
  readWorkDossier(bookId:string,request:WorkDossierRequest={}) { return new AnalysisCore(this.engine).dossier(bookId,request); }
  listConversationMessages(bookId:string,query:ConversationMessageQuery) { return listConversationMessages(this.engine.state,bookId,query); }
  confirmLocatedPosition(bookId: string, locationId: string) { return this.engine.confirmLocatedPosition(bookId, locationId); }
  setFrontMatterIncluded(bookId: string, value: boolean) { return this.engine.setFrontMatterIncluded(bookId, value); }
  async locatePosition(bookId: string, text: string) {
    const match = await this.engine.withOriginal(bookId, book => locateObservation(book, text));
    if (match.status !== 'matched') throw new Error('无法唯一对应，请提供更完整的片段');
    await this.engine.setKnown(bookId, match.ranges.at(-1)!.end);
  }
  async startReading(bookId: string) { await this.engine.startReading(bookId); return this.engine.session?.id; }
  setReadingMode(bookId:string,mode:ReadingMode){
    if(this.runtime.captureStarting||this.runtime.voiceActive)throw Error('请先完成当前授权或语音输入，再切换共读资料方式');
    return this.engine.setReadingMode(bookId,mode);
  }
  prepare(bookId: string,viewIds?:string[]) { return this.engine.prepare(bookId,viewIds); }
  async prepareBackground(bookId: string) { await this.runtime.stopCapture(); await this.engine.prepareBackground(bookId); }
  async finishReading(bookId: string) { const finishing=this.engine.finishReading(bookId);await this.runtime.stopCapture(true);await finishing; }
  async pauseReadingSafely() { const paused=this.engine.pauseReadingSafely();await this.runtime.stopCapture();await paused; }
  resumeReadingSafely() { return this.engine.resumeReadingSafely(); }
  async stopReadingSafely() { const stopping=this.engine.stopReadingSafely();await this.runtime.stopCapture();await stopping; }
  async pause() { await this.engine.pause(); }
  async stop() { await this.engine.stop(); }
  async quiet(value: boolean) { await this.engine.quiet(value); }
  newDiscussion(bookId: string) { return this.engine.newDiscussion(bookId); }
  continueConversation(bookId:string) { return this.engine.continueConversation(bookId); }
  async renameConversation(conversationId: string, title: string) {
    const value = title.trim(); if (!value || value.length > 300) throw new Error('对话标题应为 1 至 300 字符');
    await this.engine.editScopedState({collections:{conversations:[conversationId]}},state => {
      const conversation = state.conversations.find(c => c.id === conversationId);
      if (!conversation) throw new Error('未找到这段对话'); conversation.title = value; conversation.manualTitle = true;
    });
  }
  listParagraphComments(bookId:string,query:import('./paragraph-comments.ts').ParagraphCommentQuery={}) { return this.engine.listParagraphComments(bookId,query); }
  postParagraphComment(bookId:string,input:import('./paragraph-comments.ts').UserParagraphComment){return this.engine.postParagraphComment(bookId,input);}
  setParagraphCommentLiked(bookId:string,commentId:string,liked:boolean){return this.engine.setParagraphCommentLiked(bookId,commentId,liked);}
  async setMessageEmojiReaction(bookId:string,targetId:string,emoji:string,active:boolean):Promise<void>{
    const partnerId=this.engine.state.partnerId,ids=messageEmojiReactionTargetIds(this.engine.state,bookId,targetId);
    const valid=()=>{try{return this.engine.state.partnerId===partnerId&&messageEmojiReactionTargetIds(this.engine.state,bookId,targetId).every(id=>ids.includes(id));}catch{return false;}};
    await this.engine.editScopedState({collections:{chats:ids}},state=>{applyMessageEmojiReaction(state,bookId,targetId,{actor:'user',actorId:localReaderActorId},emoji,active);},valid);
  }
  async recordMessagePresentation(bookId:string,targetId:string,kind:'notified'|'seen'):Promise<boolean>{
    if(kind!=='notified'&&kind!=='seen')throw Error('消息呈现记录无效');
    const partnerId=this.engine.state.partnerId,target=resolveMessageEmojiReactionTarget(this.engine.state,bookId,targetId),field=kind==='notified'?'notifiedAt':'seenAt';
    if(target.role!=='assistant')throw Error('只能记录已发表伙伴消息的呈现');
    if(target.presentationReceipt?.[field]!==undefined)return false;
    const valid=()=>{try{const current=resolveMessageEmojiReactionTarget(this.engine.state,bookId,targetId);return this.engine.state.partnerId===partnerId&&current.id===target.id&&current.role==='assistant';}catch{return false;}};
    let recorded=false;
    await this.engine.editScopedState({collections:{chats:[target.id]}},state=>{
      const current=resolveMessageEmojiReactionTarget(state,bookId,targetId);
      if(current.presentationReceipt?.[field]!==undefined)return;
      current.presentationReceipt={...current.presentationReceipt,[field]:Date.now()};recorded=true;
    },valid);
    return recorded;
  }
  async clearUnreadMessages(bookId:string,input:{partnerId:string;targetIds:string[]}):Promise<number>{
    if(!input||typeof input.partnerId!=='string'||!Array.isArray(input.targetIds)||input.targetIds.some(id=>typeof id!=='string'))throw Error('未读消息选择无效');
    const partnerId=input.partnerId;
    if(this.engine.state.partnerId!==partnerId)throw Error('伙伴已切换，请重新打开消息面板');
    // Capture exact displayed targets. A reply arriving after the click remains unread.
    const requested=new Set(input.targetIds);
    const ids=recentPublishedReplies(this.engine.state).filter(reply=>reply.bookId===bookId&&requested.has(reply.id)&&hasUnreadPresentation(reply)).map(reply=>reply.id);
    if(!ids.length)return 0;
    const selected=new Set(ids),now=Date.now();let changed=0;
    await this.engine.editScopedState({collections:{chats:ids}},state=>{
      for(const chat of state.chats)if(selected.has(chat.id)&&hasUnreadPresentation(chat)){
        chat.presentationReceipt={...chat.presentationReceipt,clearedAt:now};changed++;
      }
    },()=>this.engine.state.partnerId===partnerId);
    return changed;
  }
  resumeSceneParticipation(bookId:string){return this.engine.resumeSceneParticipation(bookId);}
  requestParagraphReply(bookId:string,commentId:string,acceptanceOnly=false){return this.engine.requestParagraphReply(bookId,commentId,acceptanceOnly);}
  askAboutParagraphComment(bookId:string,commentId:string,text:string,acceptanceOnly=false) { return this.engine.askAboutParagraphComment(bookId,commentId,text,acceptanceOnly); }
  ask(bookId: string, text: string, long = false, conversationId?: string, options:{scope?:AnswerScope;acceptanceOnly?:boolean}={}) { return this.engine.ask(bookId, text, long, conversationId, options); }
  askWithFuture(bookId: string, text: string, range: Range, evaluationOnly: boolean, conversationId?: string) { return this.engine.askWithFuture(bookId, text, range, evaluationOnly, conversationId); }
  expandReply(chatId:string) { return this.engine.expandReply(chatId); }
  retryQuestion(chatId: string) { return this.engine.retryQuestion(chatId); }
  recoverQuestionReceipt(chatId:string) {return this.engine.recoverQuestionReceipt(chatId);}
  recoverReading(target:import('./types.ts').ReadingRecoveryTarget,execution:Exclude<import('./types.ts').ReadingRecoveryExecution,'none'>){return this.engine.recoverReading(target,execution);}
  correctTranscript(chatId: string, text: string) { return this.engine.correctTranscript(chatId, text); }
  correctMemory(memoryId: string, text: string) { return this.engine.correctMemory(memoryId, text); }
  discoverKnowledgeDocuments(bookId:string,query:KnowledgeDocumentQuery&{cursor?:string}={}) { return this.engine.discoverKnowledgeDocuments(bookId,query); }
  private readableMemory(bookId:string,memoryId:string,base=this.engine.state){
    const memory=base.memories.find(m=>m.id===memoryId);
    if(this.engine.state!==base||!memory||memory.bookId!==bookId||!memoryReadableByPartner(base,memory)||memoryIsForgotten(base,memory)||!isEvidenceAllowed(this.engine.book(bookId),memory.evidence))throw Error('这份阅读档案不在当前作品、伙伴或已读许可内');
    return memory;
  }
  readMemoryEvidence(bookId:string,memoryId:string):Range[]{const memory=this.readableMemory(bookId,memoryId);return mergeRanges(memory.sourceEvidence??memory.evidence);}
  async readMemoryBody(bookId: string, memoryId: string): Promise<string> {
    const base=this.engine.state,memory=this.readableMemory(bookId,memoryId,base),wasResident=typeof memory.text==='string';
    try { await this.engine.hydrateMemories([memoryId]); return requireMemoryText(this.readableMemory(bookId,memoryId,base)); }
    finally { if (!wasResident) releasePersistedMemoryBodies({ ...base, memories: [memory] }); }
  }
  async reviewFacts(bookId: string) { await this.runtime.stopCapture(); return this.engine.reviewFacts(bookId); }
  async resumeFactReview(taskId: string) { await this.runtime.stopCapture(); return this.engine.resumeFactReview(taskId); }
  cancelFactReview(taskId: string) { return this.engine.cancelFactReview(taskId); }
  async reviewFact(memoryId: string) {
    const memory = this.engine.state.memories.find(m => m.id === memoryId);
    if (!memory) throw new Error('未找到这条记忆');
    await this.runtime.stopCapture(); return this.engine.reviewFacts(memory.bookId, memoryId);
  }
  async forgetMemory(memoryId: string) {
    const base = this.engine.state, memory = base.memories.find(m => m.id === memoryId);
    if (!memory) throw Error('未找到这份阅读档案');
    this.engine.invalidateKnowledge();
    const ids = base.memories.filter(m => m.bookId === memory.bookId).map(m => m.id);
    await this.engine.withMemoryBodies(ids, () => this.engine.editState(state => forgetMemory(state, memoryId), () => this.engine.state === base, true));
  }
  async deleteChat(chatId: string) {
    const base = this.engine.state, chat = base.chats.find(c => c.id === chatId);
    this.engine.invalidateKnowledge();
    const ids = chat ? base.memories.filter(m => m.bookId === chat.bookId).map(m => m.id) : [];
    await this.engine.withMemoryBodies(ids, () => this.engine.editState(state => deleteChat(state, chatId), () => this.engine.state === base, true));
  }
  setCommonHabit(key: HabitKey, value?: string) { return this.engine.setCommonHabit(key, value); }
  async updatePartner(partnerId: string, name: string, traits: string) {
    if (!name.trim() || name.length > 100 || traits.length > 12000) throw new Error('伙伴名称或特点长度无效');
    await this.engine.invalidateContext();
    await this.engine.editScopedState({collections:{partners:[partnerId]}},state => {
      const partner = state.partners.find(p => p.id === partnerId); if (!partner) throw new Error('未找到这个伙伴');
      partner.name = name.trim(); partner.traits = traits;
    });
  }
  async updatePartnerProfile(partnerId:string,profile:{personaTemplateId?:string;name?:string;preferences?:import('./types.ts').Partner['preferences'];avatar?:import('./types.ts').Partner['avatar'];modelServiceId?:string;modelParameters?:import('./types.ts').ModelParameterPatch}){
    if(!profile||typeof profile!=='object'||Array.isArray(profile)||Object.keys(profile).some(key=>!['personaTemplateId','name','preferences','avatar','modelServiceId','modelParameters'].includes(key)))throw Error('伙伴配置字段无效');
    if(profile.name!==undefined&&(typeof profile.name!=='string'||!profile.name.trim()||profile.name.trim().length>100))throw Error('请填写100字以内的伙伴名称');
    if(profile.preferences!==undefined)validatePartnerPreferences(profile.preferences);
    if(profile.avatar!==undefined&&(!profile.avatar||profile.avatar.kind!=='preset'||typeof profile.avatar.id!=='string'||!profile.avatar.id))throw Error('请选择预设头像，图片请通过头像上传入口保存');
    if(profile.modelServiceId!==undefined&&(typeof profile.modelServiceId!=='string'||!profile.modelServiceId))throw Error('请选择伙伴使用的模型渠道');
    const owner=this.engine.state.partners.find(p=>p.id===partnerId);if(!owner)throw Error('伙伴不存在');
    const update=structuredClone(profile),personaBefore=getPartnerPersonaParameters(getPartnerPersonaSnapshot(this.engine.state,partnerId));
    const normalized=(value:string|undefined)=>value?.trim()?value:undefined;
    const edits=Object.entries(update.preferences?.persona??{}).filter(([key,value])=>normalized(value)!==normalized(personaBefore[key as keyof typeof personaBefore]));
    const fixedBefore=owner.preferences?.fixedPersona??[],fixedRequested=update.preferences?.fixedPersona??fixedBefore;
    const changedFixed=[...new Set([...fixedBefore,...fixedRequested])].filter(key=>fixedBefore.includes(key)!==fixedRequested.includes(key));
    let modelService:Service|undefined;
    if(update.modelServiceId!==undefined||update.modelParameters!==undefined){
      const sourceId=update.modelServiceId??owner.modelService?.id;if(!sourceId)throw Error('请先为伙伴选择模型，再调整模型参数');
      const selected=await this.host<HostServiceMetadata>('bindModelService',{sourceId,...(update.modelParameters?{parameters:update.modelParameters}:{})});
      modelService=structuredClone(validateService({...serviceFromHost(selected),enabled:true,fallback:false}));
    }
    await this.engine.editScopedState({collections:{partners:[partnerId],partnerPersonaVersions:[]},...(modelService?{fields:['settings'] as const}:{})},state=>{
      const partner=state.partners.find(p=>p.id===partnerId);if(!partner)throw Error('伙伴不存在');
      if(update.name!==undefined)partner.name=update.name.trim();
      if(update.preferences!==undefined){
        const current=getPartnerPersonaParameters(getPartnerPersonaSnapshot(state,partnerId)),fixed=new Set(partner.preferences?.fixedPersona??[]);
        for(const key of changedFixed)if(fixedRequested.includes(key))fixed.add(key);else fixed.delete(key);
        if(edits.length||changedFixed.length)revisePartnerPersonaParameters(state,partnerId,{...current,...Object.fromEntries(edits)},[...fixed]);
        const {persona:_,fixedPersona:__,...preferences}=update.preferences;partner.preferences={...partner.preferences,...preferences};
      }
      if(update.personaTemplateId!==undefined)replacePartnerPersonaFromTemplate(state,partnerId,update.personaTemplateId);
      if(update.avatar)partner.avatar=update.avatar;
      if(modelService){partner.modelService=modelService;state.settings.services.push(structuredClone(modelService));}
    });
  }
  async initializePartnerModels(service?:Service){
    const selected=service??this.engine.state.settings.services.find(item=>item.id===this.engine.state.settings.serviceId&&item.enabled);
    const ids=this.engine.state.partners.filter(partner=>!partner.modelService).map(partner=>partner.id);
    if(!selected||!ids.length)return;
    const models=new Map<string,Service>();
    for(const id of ids){const authority=await this.host<HostServiceMetadata>('bindModelService',{sourceId:selected.id});models.set(id,structuredClone(validateService({...serviceFromHost(authority),enabled:true,fallback:false})));}
    await this.engine.editScopedState({collections:{partners:ids},fields:['settings']},state=>{for(const partner of state.partners){const model=models.get(partner.id);if(model&&!partner.modelService){partner.modelService=model;state.settings.services.push(structuredClone(model));}}});
  }
  async adoptPartnerPersona(partnerId:string,templateId:string){
    await this.engine.editScopedState({collections:{partners:[partnerId],partnerPersonaVersions:[]}},state=>{adoptPartnerTemplate(state,partnerId,templateId);});
  }
  async createPartner(templateId:string){
    let partnerId='';await this.engine.editScopedState({collections:{partners:'all',partnerPersonaVersions:[]}},state=>{if(state.partners.length===1)state.partners[0].legacyUnlabelled=true;partnerId=createPartnerFromTemplate(state,templateId).id;});await this.initializePartnerModels();return partnerId;
  }
  async setLanguage(language:'zh-CN'|'en',initializeDefaultPersona=false):Promise<void>{
    if(!['zh-CN','en'].includes(language)||typeof initializeDefaultPersona!=='boolean')throw Error('语言设置无效');
    if(!initializeDefaultPersona){await this.engine.editSettings(settings=>{settings.language=language;});return;}
    await this.engine.editScopedState({fields:['settings'],collections:{partners:'all',partnerPersonaVersions:[]}},state=>{
      if(initializeDefaultPersona)initializeDefaultPartnerLanguage(state,language);
      state.settings.language=language;
    });
  }
  async selectPartner(partnerId:string){
    if(!this.engine.state.partners.some(partner=>partner.id===partnerId))throw Error('伙伴不存在');
    if(this.engine.state.partnerId===partnerId)return;
    if(this.engine.session?.active||this.engine.busy)await this.stopReadingSafely();
    await this.engine.editScopedState({fields:['partnerId','resume']},state=>{
      state.partnerId=partnerId;delete state.resume;
    });
  }
  async reconcileBookAnalysis(bookId:string){
    this.engine.book(bookId);
    const base=this.engine.state,partnerId=base.partnerId,inputs=[base.books,base.memories,base.publishedViews,base.viewPublications,base.readings,base.usage,base.maintenanceJobs];
    const current=()=>this.engine.state===base&&this.engine.state.partnerId===partnerId&&[base.books,base.memories,base.publishedViews,base.viewPublications,base.readings,base.usage,base.maintenanceJobs].every((value,index)=>value===inputs[index]);
    const carriers=bookAnalysisOperationCarriers(base,bookId);
    await resolveStorageMaterials(carriers.map(carrier=>carrier.owner),this.engine.store.readTaskMaterials?.bind(this.engine.store));
    const privateCandidates=new Set(carriers.flatMap(carrier=>carrier.usage.maintenanceDispatch?.committed?.memoryIds??[]));
    await hydrateMemoryBodies(this.engine.store,base.memories.filter(memory=>memory.scope==='partner'&&privateCandidates.has(memory.id)));
    if(!current())throw Error('核对成功处理回执时资料已变化，请在当前请求收好后重试');
    if(carriers.some(carrier=>carrier.owner.material?.kind!=='agent-response-v1'))throw Error('成功处理回执原件缺失或类型不符，未修改书籍资料');
    const plan=planBookAnalysisReconciliation(base,bookId,carriers);
    let result!:ReturnType<typeof applyBookAnalysisReconciliation>;
    await this.engine.editScopedState({collections:{books:[bookId],memories:plan.memoryIds,publishedViews:plan.viewIds,viewPublications:plan.publicationIds,maintenanceJobs:plan.maintenanceJobIds}},state=>{result=applyBookAnalysisReconciliation(state,plan);},current);
    return result;
  }
  async setPartnerAvatar(partnerId:string,dataUrl:string){
    if(!this.engine.state.partners.some(partner=>partner.id===partnerId))throw Error('伙伴不存在');
    if(!this.engine.store.writePartnerAvatar)throw Error('当前存储尚不支持上传头像');
    const asset=await partnerAvatarAsset(dataUrl);await this.engine.store.writePartnerAvatar(asset);
    await this.engine.editScopedState({collections:{partners:[partnerId]}},state=>{const partner=state.partners.find(p=>p.id===partnerId);if(!partner)throw Error('伙伴不存在');partner.avatar={kind:'image',assetId:asset.id};});
    return asset.id;
  }
  async getPartnerAvatar(assetId:string){
    if(!this.engine.state.partners.some(p=>p.avatar?.kind==='image'&&p.avatar.assetId===assetId))return undefined;
    return(await this.engine.store.readPartnerAvatar?.(assetId))?.dataUrl;
  }
  async addService() {
    const id = 'custom-' + crypto.randomUUID();
    this.configurationEpoch++;
    await this.engine.editSettings(settings => {
      settings.services.push(customService(id));
      settings.serviceId = id;
    }); return id;
  }
  async selectService(serviceId: string) {
    this.configurationEpoch++;
    await this.engine.editSettings(settings => { if (!settings.services.some(s => s.id === serviceId)) throw new Error('模型服务不存在'); settings.serviceId = serviceId; });
  }
  async updateService(serviceId: string, patch: ServicePatch) {
    validateServicePatch(patch);
    this.configurationEpoch++;
    await this.engine.editSettings(settings => {patchService(settings,serviceId,patch);});
  }
  async enableService(serviceId: string, key: string) {
    const service = this.engine.state.settings.services.find(s => s.id === serviceId); if (!service) throw new Error('模型服务不存在');
    const checked = validateService(service), epoch = ++this.configurationEpoch;
    await this.host('saveSecret', { id: checked.id, key: key.trim(), service: checked });
    const list = await this.host<{ id: string; hasKey: boolean }[]>('services', {});
    if (!list.find(s => s.id === serviceId)?.hasKey) throw new Error('此渠道尚未配置密钥');
    await this.engine.editSettings(settings => {
      if (epoch !== this.configurationEpoch) throw new Error('服务配置已改变，请重新保存启用');
      const current = settings.services.find(s => s.id === serviceId); if (!current) throw new Error('模型服务已变更');
      Object.assign(current, checked, { enabled: true });
    }, () => epoch === this.configurationEpoch);
  }
  async saveModelSettings(input:ModelSettingsInput):Promise<{serviceId:string}>{
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['serviceId','metadata','patch','key','limits'].includes(key))||typeof input.key!=='string'||input.serviceId!==undefined&&typeof input.serviceId!=='string')throw Error('模型设置参数无效');
    validateServicePatch(input.patch);
    const base=this.engine.state,settings=structuredClone(base.settings),limits=input.limits??{};
    patchLimits(settings,limits);
    const epoch=++this.configurationEpoch,current=()=>epoch===this.configurationEpoch&&this.engine.state===base;
    let serviceId=input.serviceId,authority:HostServiceMetadata|undefined;
    if(input.metadata){
      if(input.metadata.secretRef!==input.metadata.id||serviceId!==undefined&&serviceId!==input.metadata.id)throw Error('渠道身份与认证引用不符');
      const list=await this.host<HostServiceMetadata[]>('services',{});if(!current())throw Error('服务配置已改变，请重新保存启用');
      authority=list.find(service=>service.id===input.metadata!.id);if(!authority)throw Error('所选渠道已不在宿主服务列表，请重新选择');
      const metadata=serviceFromHost(authority);
      serviceId=metadata.id;settings.services=settings.services.filter(service=>service.id!==serviceId);settings.services.push(metadata);
    }
    if(serviceId===undefined){serviceId='custom-'+crypto.randomUUID();settings.services.push(customService(serviceId));}
    const checked=validateService(patchService(settings,serviceId,input.patch));
    if(authority?.transport==='native-codex'&&(checked.baseUrl!==authority.baseUrl||checked.model!==authority.model||checked.effort!==(authority.effort??'high')||limits.readingEffort!==undefined&&limits.readingEffort!==(authority.effort??'high')))throw Error('本机渠道须保持原声明的地址、模型与思考强度');
    if(!current())throw Error('服务配置已改变，请重新保存启用');
    await this.host('saveSecret',{id:checked.id,key:input.key.trim(),service:checked});
    const available=await this.host<{id:string;hasKey:boolean}[]>('services',{});
    if(!available.find(service=>service.id===serviceId)?.hasKey)throw Error('此渠道尚未配置密钥');
    await this.engine.editSettings(draft=>{
      if(!current())throw Error('服务配置已改变，请重新保存启用');
      const existing=draft.services.find(service=>service.id===serviceId),enabled={...checked,enabled:true};
      if(existing){Object.assign(existing,enabled);for(const key of ['inputPrice','outputPrice','providerCapabilities','temperature','topP'] as const)if(enabled[key]===undefined)delete existing[key];}else draft.services.push(enabled);
      draft.serviceId=serviceId!;patchLimits(draft,limits);
    },current,costOption(limits));
    await this.initializePartnerModels({...checked,enabled:true,fallback:false});
    return{serviceId};
  }
  async updateLimits(patch: LimitsPatch) {
    this.configurationEpoch++;
    await this.engine.editSettings(settings=>patchLimits(settings,patch),undefined,costOption(patch));
  }
  async selectSearch(provider: 'exa' | 'tavily' | 'searxng') {
    if (!['exa','tavily','searxng'].includes(provider)) throw new Error('搜索服务无效');
    this.searchEpoch++; this.engine.disableWeb();
    await this.engine.editSettings(settings => Object.assign(settings, { searchProvider: provider, searchEnabled: false, searchEndpoint: provider === 'exa' ? 'https://mcp.exa.ai/mcp' : provider === 'tavily' ? 'https://api.tavily.com/search' : '' }));
  }
  async setSearchEndpoint(endpoint: string) {
    this.searchEpoch++; this.engine.disableWeb();
    await this.engine.editSettings(settings => { if (settings.searchProvider !== 'searxng') throw new Error('此搜索渠道地址固定'); settings.searchEndpoint = endpoint; settings.searchEnabled = false; });
  }
  async enableSearch(key: string) {
    const settings = this.engine.state.settings, provider = settings.searchProvider ?? 'exa', endpoint = settings.searchEndpoint, epoch = this.searchEpoch;
    const result = await this.host<{ endpoint: string }>('configureSearch', { provider, endpoint, key });
    await this.engine.editSettings(settings => {
      if (epoch !== this.searchEpoch) throw new Error('搜索设置已改变，请重新启用');
      Object.assign(settings, { searchProvider: provider, searchEndpoint: result.endpoint, searchEnabled: true });
    }, () => epoch === this.searchEpoch); this.engine.resumeWeb();
  }
  async disableSearch() { this.searchEpoch++; this.engine.disableWeb(); await this.engine.editSettings(settings=>{settings.searchEnabled=false;}); }
  async setWebResult(reason?: string) { if (reason) this.engine.pauseWeb(reason); else this.engine.resumeWeb(); }
  startCapture(bookId: string, sourceId: string) { return this.runtime.startCapture(bookId, sourceId); }
  stopCapture() { return this.runtime.stopCapture(); }
  selectReadingSource(bookId: string, sourceId: string) { return this.runtime.selectReadingSource(bookId, sourceId); }
  startOrSendVoice(bookId: string, conversationId?: string) { return this.runtime.startOrSendVoice(bookId, conversationId); }
  cancelVoice() { return this.runtime.cancelVoice(); }
  async previewBackup(raw: string) { const state = await restoreBackup(raw, this.engine.state, this.engine.store); return { books: state.books.length, chats: state.chats.length, hasSecrets: !!JSON.parse(raw).secrets }; }
  async restoreBackup(raw: string, includeKeys: boolean) {
    this.restoring = true;
    try {
    await restoreBackup(raw, this.engine.state, this.engine.store); // Reject an invalid file before ending the active scene.
    this.configurationEpoch++; this.searchEpoch++; this.engine.stop();
    await this.engine.replaceFromBackup(raw);
    let secretError: string | undefined;
    if (includeKeys) {
      const parsed = JSON.parse(raw), state = this.engine.state;
      try {
        for (const [id, key] of Object.entries(parsed.secrets ?? {})) {
          if (typeof key !== 'string' || !key) continue;
          if (id === 'search' && state.settings.searchProvider) await this.host('configureSearch', { provider: state.settings.searchProvider, endpoint: state.settings.searchEndpoint, key });
          else { const service = state.settings.services.find(s => s.id === id); if (service) await this.host('saveSecret', { id, key, service }); }
        }
      } catch { secretError = '资料已恢复，部分服务密钥未能恢复，请在设置中重新配置。'; }
    }
    return { bookId: this.engine.state.books[0]?.id ?? '', secretError };
    } finally { this.restoring = false; }
  }
  async exportBackup(includeKeys: boolean) {
    const base = this.engine.state;
    const inline = base.memories.map(memory => memory.text);
    const copy = structuredClone({ ...base, books: base.books.map(b => ({ ...b, text: '', textLength: bookLength(b) })), memories: base.memories.map(({ text: _text, ...metadata }) => metadata) }); delete (copy as typeof copy & {secrets?:unknown}).secrets;
    const owners=storageMaterialOwners(copy);
    await resolveStorageMaterials(owners,this.engine.store.readTaskMaterials?.bind(this.engine.store));for(const owner of owners)delete owner.materialRef;
    await resolveNativeAgentSessionsForBackup(copy,this.engine.store.readNativeAgentSession?.bind(this.engine.store),this.engine.store.readNativeAgentSpills?.bind(this.engine.store));
    // Export is the explicit full-body operation. Read it in batches into the detached
    // backup, so the active engine does not accumulate every historical body.
    for (let start = 0; start < copy.memories.length; start += 64) {
      if (this.engine.state !== base) throw Error('资料已切换，请重新导出');
      const batch = copy.memories.slice(start, start + 64);
      batch.forEach((memory, index) => { if (typeof inline[start + index] === 'string') (memory as typeof memory & {text?:string}).text = inline[start + index]; });
      await hydrateMemoryBodies(this.engine.store, batch);
      for (const memory of batch) { requireMemoryText(memory); delete memory.bodyRef; }
    }
    for (const book of copy.books) {
      if (this.engine.state !== base) throw new Error('资料已切换，请重新导出');
      book.text = await this.engine.withOriginal(book.id, original => original.text);
    }
    if (this.engine.state !== base) throw new Error('资料已切换，请重新导出');
    const envelope = copy as typeof copy & {exportedAt:string;secrets?:unknown};
    envelope.exportedAt = new Date().toISOString();
    const avatars=await collectPartnerAvatarAssets(this.engine.state,this.engine.store);if(avatars.length)(envelope as unknown as {partnerAvatarAssets:typeof avatars}).partnerAvatarAssets=avatars;
    if (includeKeys) envelope.secrets = await this.host('exportSecrets', { includeKeys: true });
    return JSON.stringify(copy);
  }
}

export class LocalApplication implements ApplicationClient {
  private runtime: ReadingRuntime;
  private actions: ApplicationActions;
  private cached?: ApplicationSnapshot;
  private revision = 0;
  private listeners = new Set<(change?:ApplicationChange) => void>();
  private readonly committedProjection = new CommittedApplicationProjection();
  private readonly conversationProjection = new ConversationMessageProjection();
  private readonly readCommittedState?:()=>State;
  private readonly publicationProjection=new CommittedPublishedRepliesProjection();
  private deriveEpoch=0;
  private derivedTimer?:ReturnType<typeof setTimeout>;
  private runtimeUnsubscribe:()=>void;
  private projectionEvents:ReturnType<ReadingRuntime['takeUIEvents']>=[];
  constructor(runtime: ReadingRuntime, host: ApplicationHost, readCommittedState?:()=>State) {
    this.runtime = runtime; this.actions = new ApplicationActions(runtime, host);
    this.readCommittedState=readCommittedState;
    this.runtimeUnsubscribe=runtime.subscribe(change => {
      this.revision++;
      if(!this.readCommittedState){this.cached=undefined;this.listeners.forEach(listener=>listener(change));return;}
      const previous=this.cached,source=this.readCommittedState(),engine=runtime.engine;
      const projection=this.committedProjection.readImmediate(source,change?.reset?undefined:change?.changes);
      this.cached=freezeData({...previous,...projection,revision:this.revision,projectionPending:true,projectionError:undefined,
        activities:previous?.activities??[],recentPublications:this.committedProjection.withdrawalsPending?[]:previous?.recentPublications??[],conversationContinuity:previous?.conversationContinuity??[],
        readingFlow:previous?.readingFlow??{pendingChars:0,activeChars:0,foregroundPending:0,deferredExpressions:0,sceneSavePending:false,sceneSaveBookIds:[],sceneRestoreBookIds:[],sceneReceiptBookIds:[]},
        session:engine.session?{...engine.session}:undefined,busy:engine.busy,status:engine.status,progress:engine.progress?{...engine.progress}:undefined,readingControl:engine.readingControl,
        lastLatency:engine.lastLatency,lastObservation:engine.lastObservation,locatedPosition:engine.locatedPosition?{...engine.locatedPosition}:undefined,recoveryRevision:engine.recoveryRevision,
        webPausedReason:engine.webPausedReason,connectionAvailable:engine.connectionAvailable,
        recording:runtime.recording,voiceDraft:runtime.voiceDraft,captureStarting:runtime.captureStarting,voiceActive:runtime.voiceActive});
      this.listeners.forEach(listener=>listener(change));this.scheduleDerived(source);
    });
  }
  private scheduleDerived(source:State){
    const epoch=++this.deriveEpoch,revision=this.revision;if(this.derivedTimer)clearTimeout(this.derivedTimer);
    const steps=this.committedProjection.readSteps(source),engine=this.runtime.engine;
    let projection:ReturnType<CommittedApplicationProjection['read']>,activities:typeof engine.activities,readingFlow:ReturnType<typeof engine.readingFlowFor>,recentPublications:ReturnType<CommittedPublishedRepliesProjection['read']>,conversationContinuity:ReturnType<typeof engine.conversationContinuity>,stage=0;
    const advance=()=>{
      try{
      if(epoch!==this.deriveEpoch)return;
      if(stage===0){const step=steps.next();if(step.done){projection=step.value;stage++;}}
      else if(stage===1){activities=engine.activities;stage++;}
      else if(stage===2){readingFlow=engine.readingFlowFor(activities);stage++;}
      else if(stage===3){recentPublications=this.publicationProjection.read(source);stage++;}
      else if(stage===4){conversationContinuity=engine.conversationContinuity();stage++;}
      else{this.cached=freezeData({...this.cached!,...projection!,revision:++this.revision,activities:activities!,readingFlow:readingFlow!,recentPublications:recentPublications!,conversationContinuity:conversationContinuity!,projectionPending:false,derivedRevision:revision});this.listeners.forEach(listener=>listener({derived:true}));return;}
      this.derivedTimer=setTimeout(advance,0);
      }catch(error){
        if(epoch!==this.deriveEpoch)return;
        const text='阅读资料显示未刷新：'+(error instanceof Error?error.message:String(error));
        this.cached=freezeData({...this.cached!,revision:++this.revision,projectionPending:false,projectionError:text});
        this.projectionEvents.push({kind:'error',text});this.listeners.forEach(listener=>listener({derived:true}));
      }
    };
    this.derivedTimer=setTimeout(advance,0);
  }
  dispose(){this.runtimeUnsubscribe();this.deriveEpoch++;if(this.derivedTimer)clearTimeout(this.derivedTimer);this.listeners.clear();}
  get snapshot(): ApplicationSnapshot {
    if (!this.cached) {
      const engine = this.runtime.engine,activities=engine.activities,readingFlow=engine.readingFlowFor(activities);
      if(this.readCommittedState){
        const committed=this.readCommittedState(),projection=this.committedProjection.read(committed);
        const recentPublications=this.publicationProjection.read(committed);
        this.cached=freezeData({revision:this.revision,...projection,recentPublications,conversationContinuity:engine.conversationContinuity(),
          session:engine.session?{...engine.session}:undefined,
          activities,busy:engine.busy,status:engine.status,progress:engine.progress?{...engine.progress}:undefined,readingFlow,readingControl:engine.readingControl,
          lastLatency:engine.lastLatency,lastObservation:engine.lastObservation,locatedPosition:engine.locatedPosition?{...engine.locatedPosition}:undefined,recoveryRevision:engine.recoveryRevision,
          webPausedReason:engine.webPausedReason,connectionAvailable:engine.connectionAvailable,
          recording:this.runtime.recording,voiceDraft:this.runtime.voiceDraft,captureStarting:this.runtime.captureStarting,voiceActive:this.runtime.voiceActive});
        return this.cached;
      }
      const {readingDrafts,queryCheckpoints,companionReadingReceipts,companionCorrectionRepairs,agentSessions,...visibleState}=engine.state;
      const conversation=this.conversationProjection.read(engine.state,false);
      const state = structuredClone({ ...visibleState,usage:engine.state.usage.map(({maintenanceDispatch,agentResponse,...usage})=>usage),publishedViews:engine.state.books.flatMap(book=>currentPublishedViews(engine.state,book)).map(({formationSources,...view})=>view),chats:conversation.chats, memories: engine.state.memories.map(memorySummary), books: engine.state.books.map(({ text,residentRanges, ...book }) => ({ ...book, textLength: bookLength({ text, ...book }) })) });
      this.cached = freezeData({ revision: this.revision, state,conversationMessages:conversation.conversationMessages,conversationStatistics:conversation.conversationStatistics,conversationContinuity:engine.conversationContinuity(),recentPublications:recentPublishedReplies(engine.state),questionProgress:(engine.state.queryCheckpoints??[]).filter(q=>q.status!=='consumed').map(q=>({questionId:q.questionId,status:q.status,receiptPending:!!q.pendingReceipt,pendingRequestId:q.pendingReceipt?.usageId,blockedReason:q.blockedReason})),readingViews:engine.state.books.map(book=>({bookId:book.id,progress:viewProgress(engine.state,book)})),session: engine.session ? { ...engine.session } : undefined,
        activities,maintenanceProgress:engine.maintenanceProgress,busy: engine.busy, status: engine.status, progress: engine.progress ? { ...engine.progress } : undefined, readingFlow,readingControl:engine.readingControl,
        lastLatency: engine.lastLatency, lastObservation: engine.lastObservation, locatedPosition: engine.locatedPosition ? { ...engine.locatedPosition } : undefined, recoveryRevision: engine.recoveryRevision,
        webPausedReason: engine.webPausedReason, connectionAvailable: engine.connectionAvailable,
        recording: this.runtime.recording, voiceDraft: this.runtime.voiceDraft, captureStarting: this.runtime.captureStarting, voiceActive: this.runtime.voiceActive });
    }
    return this.cached;
  }
  subscribe(listener: (change?:ApplicationChange) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  takeUIEvents() { return [...this.runtime.takeUIEvents(),...this.projectionEvents.splice(0)]; }
  async initializePartnerModels(){await this.actions.initializePartnerModels();}
  async command<K extends ApplicationCommand>(name: K, ...args: CommandArgs<K>): Promise<CommandResult<K>> {
    if (!applicationCommands.includes(name)) throw new Error('未知的应用操作');
    if (this.actions.replacingData && name !== 'stop') throw new Error('正在恢复备份，请稍候再操作');
    // Validation has restored omitted optional arguments to undefined. Preserve those
    // defaults; serializing the argument array again would turn them back into null.
    // Primitive strings are immutable, so full novels need no additional JSON copy.
    const copied = args.map(value => value && typeof value === 'object' ? structuredClone(value) : value);
    const result = await (this.actions[name] as (...args: unknown[]) => unknown).apply(this.actions, copied);
    return (result === undefined ? undefined : structuredClone(result)) as CommandResult<K>;
  }
}
