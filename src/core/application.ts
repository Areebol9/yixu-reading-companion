import type {KnowledgeDocumentQuery} from './knowledge-distribution.ts';
import {currentPublishedViews,viewProgress} from './published-views.ts';
import {resolveStorageMaterials} from './storage-records.ts';
import { bookLength, importBook, locateObservation } from './books.ts';
import {AnalysisCore} from './analysis-core.ts';
import type {WorkDossierRequest} from './work-dossier.ts';
import type {AnswerScope} from './answer-materials.ts';
import { deleteChat, forgetMemory, isEvidenceAllowed, memoryIsForgotten } from './context.ts';
import { hydrateMemoryBodies, releasePersistedMemoryBodies, requireMemoryText } from './memory-bodies.ts';
import { restoreBackup } from './backup.ts';
import { validateService } from './services.ts';
import { setCostLimit } from './accounting.ts';
import { applicationCommands, freezeData } from './application-contract.ts';
import type { ApplicationClient, ApplicationCommand, ApplicationSnapshot, CommandArgs, CommandResult } from './application-contract.ts';
import type { ReadingRuntime } from './runtime.ts';
import type { HabitKey, Range, Service, ReadingMode } from './types.ts';

export type ApplicationHost = <T>(method: string, payload: unknown) => Promise<T>;
export type ServicePatch = Partial<Pick<Service, 'name' | 'model' | 'baseUrl' | 'effort' | 'contextLimit' | 'maxOutput' | 'thinking' | 'fallback'>> & { enabled?: false; inputPrice?: number | null; outputPrice?: number | null };
export type LimitsPatch = { tokenLimit?: number; costLimit?: number | null; readingEffort?: 'medium' | 'high' };

// All mutating application operations live beside the engine. The renderer only sends
// explicit commands and receives detached metadata; it never receives original books.
export class ApplicationActions {
  private runtime: ReadingRuntime;
  private host: ApplicationHost;
  private configurationEpoch = 0;
  private searchEpoch = 0;
  private restoring = false;
  get replacingData() { return this.restoring; }
  constructor(runtime: ReadingRuntime, host: ApplicationHost) { this.runtime = runtime; this.host = host; }
  private get engine() { return this.runtime.engine; }
  async resumeTerminatedMaintenance(input:import('./types.ts').TerminatedMaintenanceResume){await this.engine.resumeTerminatedMaintenance(input);}
  async resumeMaintenance(jobId:string){await this.engine.resumeMaintenance(jobId);}
  async importText(title: string, text: string) {
    const book = await importBook(title, text);
    let bookId = book.id, existing = false;
    await this.engine.editState(state => {
      const prior = state.books.find(b => b.version === book.version);
      if (prior) { bookId = prior.id; existing = true; } else state.books.push(book);
    });
    return { bookId, existing };
  }
  async selectBook(bookId: string) {
    this.engine.book(bookId);
    if (this.engine.session?.active && this.engine.session.bookId !== bookId) await this.stop();
  }
  async setArchived(bookId: string, value: boolean) { this.engine.book(bookId); if (typeof value !== 'boolean') throw new Error('归档状态无效'); await this.engine.editState(state => { state.books.find(b => b.id === bookId)!.archived = value; }); }
  setKnown(bookId: string, through: number, from?: number) { return this.engine.setKnown(bookId, through, from); }
  readBookRange(bookId:string,range:import('./types.ts').Range){return this.engine.readBookRange(bookId,range);}
  readWorkDossier(bookId:string,request:WorkDossierRequest={}) { return new AnalysisCore(this.engine).dossier(bookId,request); }
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
  prepare(bookId: string) { return this.engine.prepare(bookId); }
  async prepareBackground(bookId: string) { await this.runtime.stopCapture(); await this.engine.prepareBackground(bookId); }
  async finishReading(bookId: string) { await this.runtime.stopCapture(); await this.engine.finishReading(bookId); }
  async pauseReadingSafely() { const paused=this.engine.pauseReadingSafely();await this.runtime.stopCapture();await paused; }
  resumeReadingSafely() { return this.engine.resumeReadingSafely(); }
  async stopReadingSafely() { const stopping=this.engine.stopReadingSafely();await this.runtime.stopCapture();await stopping; }
  async pause() { this.engine.pause(); await this.engine.persist(); }
  async stop() { this.engine.stop(); await this.engine.persist(); }
  async quiet(value: boolean) { this.engine.quiet(value); await this.engine.persist(); }
  newDiscussion(bookId: string) { return this.engine.newDiscussion(bookId); }
  async renameConversation(conversationId: string, title: string) {
    const value = title.trim(); if (!value || value.length > 300) throw new Error('对话标题应为 1 至 300 字符');
    await this.engine.editState(state => {
      const conversation = state.conversations.find(c => c.id === conversationId);
      if (!conversation) throw new Error('未找到这段对话'); conversation.title = value; conversation.manualTitle = true;
    });
  }
  listParagraphComments(bookId:string,query:import('./paragraph-comments.ts').ParagraphCommentQuery={}) { return this.engine.listParagraphComments(bookId,query); }
  postParagraphComment(bookId:string,input:import('./paragraph-comments.ts').UserParagraphComment){return this.engine.postParagraphComment(bookId,input);}
  setParagraphCommentLiked(bookId:string,commentId:string,liked:boolean){return this.engine.setParagraphCommentLiked(bookId,commentId,liked);}
  resumeSceneParticipation(bookId:string){return this.engine.resumeSceneParticipation(bookId);}
  requestParagraphReply(bookId:string,commentId:string){return this.engine.requestParagraphReply(bookId,commentId);}
  askAboutParagraphComment(bookId:string,commentId:string,text:string) { return this.engine.askAboutParagraphComment(bookId,commentId,text); }
  ask(bookId: string, text: string, long = false, conversationId?: string, options:{scope?:AnswerScope}={}) { return this.engine.ask(bookId, text, long, conversationId, options); }
  askWithFuture(bookId: string, text: string, range: Range, evaluationOnly: boolean, conversationId?: string) { return this.engine.askWithFuture(bookId, text, range, evaluationOnly, conversationId); }
  expandReply(chatId:string) { return this.engine.expandReply(chatId); }
  retryQuestion(chatId: string) { return this.engine.retryQuestion(chatId); }
  recoverQuestionReceipt(chatId:string) {return this.engine.recoverQuestionReceipt(chatId);}
  correctTranscript(chatId: string, text: string) { return this.engine.correctTranscript(chatId, text); }
  correctMemory(memoryId: string, text: string) { return this.engine.correctMemory(memoryId, text); }
  discoverKnowledgeDocuments(bookId:string,query:KnowledgeDocumentQuery&{cursor?:string}={}) { return this.engine.discoverKnowledgeDocuments(bookId,query); }
  async readMemoryBody(bookId: string, memoryId: string): Promise<string> {
    const base = this.engine.state, book = this.engine.book(bookId), partnerId = base.partnerId;
    const allowed = () => {
      const memory = base.memories.find(m => m.id === memoryId);
      if (this.engine.state !== base || base.partnerId !== partnerId || !memory || memory.bookId !== book.id || memory.partnerId !== partnerId || memoryIsForgotten(base, memory) || !isEvidenceAllowed(this.engine.book(bookId), memory.evidence)) throw Error('这份阅读档案不在当前作品、伙伴或已读许可内');
      return memory;
    };
    const memory = allowed(), wasResident = typeof memory.text === 'string';
    try { await this.engine.hydrateMemories([memoryId]); return requireMemoryText(allowed()); }
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
    this.engine.invalidateKnowledge();
    await this.engine.editState(state => {
      const partner = state.partners.find(p => p.id === partnerId); if (!partner) throw new Error('未找到这个伙伴');
      partner.name = name.trim(); partner.traits = traits;
    }, undefined, true);
  }
  async addService() {
    const id = 'custom-' + crypto.randomUUID();
    await this.engine.editState(state => {
      state.settings.services.push({ id, name: '自定义兼容服务', baseUrl: '', model: '', contextLimit: 32000, effort: 'high', maxOutput: 4096, enabled: false, fallback: false, secretRef: id, thinking: 'none' });
      state.settings.serviceId = id;
    }); return id;
  }
  async selectService(serviceId: string) {
    await this.engine.editState(state => { if (!state.settings.services.some(s => s.id === serviceId)) throw new Error('模型服务不存在'); state.settings.serviceId = serviceId; });
  }
  async updateService(serviceId: string, patch: ServicePatch) {
    const fields = ['name','model','baseUrl','effort','contextLimit','maxOutput','inputPrice','outputPrice','thinking','fallback','enabled'];
    if (Object.keys(patch).some(k => !fields.includes(k)) || patch.enabled !== undefined && patch.enabled !== false) throw new Error('服务修改字段无效');
    this.configurationEpoch++;
    await this.engine.editState(state => {
      const service = state.settings.services.find(s => s.id === serviceId); if (!service) throw new Error('模型服务不存在');
      const next = { ...service, ...patch };
      if ('baseUrl' in patch || 'model' in patch) next.enabled = false;
      if (next.inputPrice === null) delete next.inputPrice;
      if (next.outputPrice === null) delete next.outputPrice;
      if (typeof next.name !== 'string' || typeof next.baseUrl !== 'string' || typeof next.model !== 'string' || typeof next.fallback !== 'boolean') throw new Error('服务配置字段无效');
      if (!['medium','high'].includes(next.effort) || ![undefined,'none','deepseek'].includes(next.thinking)) throw new Error('思考配置无效');
      if (!Number.isSafeInteger(next.contextLimit) || next.contextLimit < 4096 || next.contextLimit > (serviceId === 'wechat' ? 200000 : 1000000)) throw new Error('上下文限制无效');
      if (!Number.isSafeInteger(next.maxOutput) || next.maxOutput < 256 || next.maxOutput > 16384) throw new Error('输出限制无效');
      for (const price of [next.inputPrice, next.outputPrice]) if (price !== undefined && (!Number.isFinite(price) || price < 0)) throw new Error('单价应为非负金额');
      if (!serviceId.startsWith('custom-') && next.baseUrl !== service.baseUrl) throw new Error('预置渠道地址固定');
      Object.assign(service, next);
      if ('inputPrice' in patch && patch.inputPrice == null) delete service.inputPrice;
      if ('outputPrice' in patch && patch.outputPrice == null) delete service.outputPrice;
    });
  }
  async enableService(serviceId: string, key: string) {
    const service = this.engine.state.settings.services.find(s => s.id === serviceId); if (!service) throw new Error('模型服务不存在');
    const checked = validateService(service), epoch = this.configurationEpoch;
    await this.host('saveSecret', { id: checked.id, key: key.trim(), service: checked });
    const list = await this.host<{ id: string; hasKey: boolean }[]>('services', {});
    if (!list.find(s => s.id === serviceId)?.hasKey) throw new Error('此渠道尚未配置密钥');
    await this.engine.editState(state => {
      if (epoch !== this.configurationEpoch) throw new Error('服务配置已改变，请重新保存启用');
      const current = state.settings.services.find(s => s.id === serviceId); if (!current) throw new Error('模型服务已变更');
      Object.assign(current, checked, { enabled: true });
    }, () => epoch === this.configurationEpoch);
  }
  async updateLimits(patch: LimitsPatch) {
    if (Object.keys(patch).some(k => !['tokenLimit','costLimit','readingEffort'].includes(k))) throw new Error('用量设置字段无效');
    await this.engine.editState(state => {
      if (patch.tokenLimit !== undefined) { if (!Number.isFinite(patch.tokenLimit) || patch.tokenLimit < 0) throw new Error('用量上限无效'); state.settings.tokenLimit = patch.tokenLimit; }
      if ('costLimit' in patch) setCostLimit(state, patch.costLimit ?? undefined);
      if (patch.readingEffort !== undefined) { if (!['medium','high'].includes(patch.readingEffort)) throw new Error('阅读思考强度无效'); state.settings.readingEffort = patch.readingEffort; }
    });
  }
  async selectSearch(provider: 'exa' | 'tavily' | 'searxng') {
    if (!['exa','tavily','searxng'].includes(provider)) throw new Error('搜索服务无效');
    this.searchEpoch++; this.engine.disableWeb();
    await this.engine.editState(state => Object.assign(state.settings, { searchProvider: provider, searchEnabled: false, searchEndpoint: provider === 'exa' ? 'https://mcp.exa.ai/mcp' : provider === 'tavily' ? 'https://api.tavily.com/search' : '' }));
  }
  async setSearchEndpoint(endpoint: string) {
    this.searchEpoch++; this.engine.disableWeb();
    await this.engine.editState(state => { if (state.settings.searchProvider !== 'searxng') throw new Error('此搜索渠道地址固定'); state.settings.searchEndpoint = endpoint; state.settings.searchEnabled = false; });
  }
  async enableSearch(key: string) {
    const settings = this.engine.state.settings, provider = settings.searchProvider ?? 'exa', endpoint = settings.searchEndpoint, epoch = this.searchEpoch;
    const result = await this.host<{ endpoint: string }>('configureSearch', { provider, endpoint, key });
    await this.engine.editState(state => {
      if (epoch !== this.searchEpoch) throw new Error('搜索设置已改变，请重新启用');
      Object.assign(state.settings, { searchProvider: provider, searchEndpoint: result.endpoint, searchEnabled: true });
    }, () => epoch === this.searchEpoch); this.engine.resumeWeb();
  }
  async disableSearch() { this.searchEpoch++; this.engine.disableWeb(); await this.engine.persist(); }
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
    const owners=[...(copy.readingDrafts??[]),...(copy.companionReadingReceipts??[]),...(copy.queryCheckpoints??[]),...(copy.queryCheckpoints??[]).flatMap(q=>q.pendingReceipt?[q.pendingReceipt]:[]),...copy.usage.flatMap(u=>u.maintenanceDispatch?[u.maintenanceDispatch]:[])];
    await resolveStorageMaterials(owners,this.engine.store.readTaskMaterials?.bind(this.engine.store));for(const owner of owners)delete owner.materialRef;
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
    if (includeKeys) envelope.secrets = await this.host('exportSecrets', { includeKeys: true });
    return JSON.stringify(copy);
  }
}

export class LocalApplication implements ApplicationClient {
  private runtime: ReadingRuntime;
  private actions: ApplicationActions;
  private cached?: ApplicationSnapshot;
  private revision = 0;
  private listeners = new Set<() => void>();
  constructor(runtime: ReadingRuntime, host: ApplicationHost) {
    this.runtime = runtime; this.actions = new ApplicationActions(runtime, host);
    runtime.subscribe(() => { this.cached = undefined; this.revision++; this.listeners.forEach(listener => listener()); });
  }
  get snapshot(): ApplicationSnapshot {
    if (!this.cached) {
      const engine = this.runtime.engine;
      const {readingDrafts,queryCheckpoints,companionReadingReceipts,companionCorrectionRepairs,...visibleState}=engine.state;
      const state = structuredClone({ ...visibleState,usage:engine.state.usage.map(({maintenanceDispatch,...usage})=>usage),publishedViews:engine.state.books.flatMap(book=>currentPublishedViews(engine.state,book)),chats:engine.state.chats.filter(c=>c.presentation!=='paragraph'), memories: engine.state.memories.map(({ text: _text, ...memory }) => memory), books: engine.state.books.map(({ text,residentRanges, ...book }) => ({ ...book, textLength: bookLength({ text, ...book }) })) });
      this.cached = freezeData({ revision: this.revision, state,questionProgress:(engine.state.queryCheckpoints??[]).filter(q=>q.status!=='consumed').map(q=>({questionId:q.questionId,status:q.status,receiptPending:!!q.pendingReceipt,blockedReason:q.blockedReason})),readingViews:engine.state.books.map(book=>({bookId:book.id,progress:viewProgress(engine.state,book)})),session: engine.session ? { ...engine.session } : undefined,
        activities:engine.activities,maintenanceProgress:engine.maintenanceProgress,busy: engine.busy, status: engine.status, progress: engine.progress ? { ...engine.progress } : undefined, readingFlow:engine.readingFlow,readingControl:engine.readingControl,
        lastLatency: engine.lastLatency, lastObservation: engine.lastObservation, locatedPosition: engine.locatedPosition ? { ...engine.locatedPosition } : undefined, recoveryRevision: engine.recoveryRevision,
        webPausedReason: engine.webPausedReason, connectionAvailable: engine.connectionAvailable,
        recording: this.runtime.recording, voiceDraft: this.runtime.voiceDraft, captureStarting: this.runtime.captureStarting, voiceActive: this.runtime.voiceActive });
    }
    return this.cached;
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  takeUIEvents() { return this.runtime.takeUIEvents(); }
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
