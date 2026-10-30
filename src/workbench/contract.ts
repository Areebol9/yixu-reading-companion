import type { ApplicationSnapshot, BookView, CommandResult } from '../core/application-contract.ts';
import type { MemoryDiscoveryResult } from '../core/memory-discovery.ts';
import type {ReadingObservationSaved,Range,ReadingRecoveryTarget,ReadingRecoveryExecution} from '../core/types.ts';

export type WorkbenchMode = 'offline' | 'live';
export type WorkbenchDraft={text:string;parentId?:string;updatedAt:number};
export type WorkbenchParagraphComment = CommandResult<'listParagraphComments'>['items'][number];
export type ReplyRating = 'accurate' | 'resonant' | 'verify';
export type WorkbenchPage = {
  bookId: string; version: string; start: number; end: number; text: string;
  chapterIndex: number; chapterTitle: string; pageNumber: number; totalPages: number;
  position: number; navigationRevision: number;
  firstReadingSection: boolean;
  previousChapterStart?: number; nextChapterStart?: number;
  authorized: boolean; prepared: boolean;
  coverage?: { allowedChars: number; preparedChars: number; missingChars: number; status: 'none' | 'partial' | 'complete' };
};
export type WorkbenchEvent = {
  id: string; kind: 'action' | 'model' | 'tool' | 'reading' | 'reply' | 'visible' | 'rating' | 'error' | 'status';
  title: string; detail?: string; at: number; clockMs: number; clockDomain: string;
  mode: WorkbenchMode; requestId?: string; chatId?: string; elapsedMs?: number;
  readingFlow?: ApplicationSnapshot['readingFlow'];
  /** Receipt from the normal body observation persistence path; never inferred from DOM. */
  readingObservation?:ReadingObservationSaved;
};
export type WorkbenchReadingObservation={sourceVisible:boolean;visibleRange?:Range;identity:{instanceId:string;sessionId?:string;observation?:number};saved?:ReadingObservationSaved;activeEntries:number};
/** Identity of the rendered page which produced one actual viewport capture. */
export type WorkbenchSourceIdentity={archiveId:string;bookId:string;version:string;start:number;end:number;navigationRevision:number};
export type WorkbenchSourceCapture={source:WorkbenchSourceIdentity;producerId:string;sourceEpoch:string;sequence:number;visible:boolean;range?:Range;startFollowing?:boolean;readingMode?:'manual'|'developer-auto'};
export type WorkbenchSourceReceipt={status:'accepted'|'obsolete';reason?:'page-changed'|'superseded'|'source-replaced'};
/** Bytes prepared by the normal export path; browser download completion is separate. */
export type WorkbenchExportPrepared={id:string;archiveId:string;kind:'record'|'backup';name:string;sha256:string;preparedAt:number;status:'prepared'};
export type WorkbenchExportOptions={exportId?:string};
export type WorkbenchExportFile={name:string;text:string}|{name:string;download:{id:string;path:string;bytes:number;sha256:string;url?:string;token?:string}};
export type WorkbenchRating = { chatId: string; values: ReplyRating[]; note: string; helpful: boolean; at: number };
export type ReplyTiming = {
  chatId: string; questionId?: string; actionStartedAt?: number; readyAt: number;
  visibleAt?: number; visibleRange?: { start: number; end: number };
  firstVisibleMs?: number; userMarkedHelpful?: boolean;
};
export type WorkbenchSession = { id: string; mode: WorkbenchMode; title: string; createdAt: number; archivedAt?: number; storageLocation?: 'browser'|'host' };
export type WorkbenchService = {
  id: string; name?: string; baseUrl: string; model: string; contextLimit: number;
  maxOutput?: number; hasKey: boolean; scope: 'shared' | 'workbench';
  effort?: import('../core/types.ts').ModelEffort;
  thinking?: import('../core/types.ts').Service['thinking'];temperature?:number;topP?:number;
  inputPrice?: number; outputPrice?: number;
  providerCapabilities?: import('../core/types.ts').Service['providerCapabilities'];
  binding?:true; transport?: 'native-codex' | 'native-http'; dataLocation?: string;
};
export type WorkbenchSource = { id: string; title: string; description?: string; readThrough?: number; available?: boolean; historical?: boolean };
export type WorkbenchSettings = {
  serviceId?: string;
  baseUrl: string; model: string; apiKey?: string; maxOutput: number;thinking?:import('../core/types.ts').Service['thinking'];temperature?:number|null;topP?:number|null;
  tokenLimit: number; contextLimit: number; effort: import('../core/types.ts').ModelEffort; pageChars: number;
};
export type AutoReadingSettings={bookId:string;version:string;targetChapterIndex:number;charactersPerMinute:number;tokenLimit:number;budgetMode:'estimate'|'manual'};
export type AutoReadingState={settings?:AutoReadingSettings;phase:'stopped'|'starting'|'reading'|'finishing'|'complete';reason?:string;startedAt?:number;startPosition?:number;targetPosition?:number};
export type WorkbenchBudget={tokenLimit:number;actualTokens:number;reservedTokens:number;tokens:number;remainingTokens:number;source:'ledger'|'archive'};
export type AutoReadingEstimate={total:number;additional:number;margin:number;remainingChars:number;basis:string;sampleCount:number};
/** Renderer transport bookkeeping only; never part of the saved reading archive. */
export type WorkbenchClientOperation={id:string;epoch:string;command:string;role:'conversation'|'maintenance';bookId?:string;startedAt:number;state:'confirming'|'waiting'};
export type WorkbenchSnapshot = { pageLoading?:boolean;
  readingDelivery?:ReturnType<typeof import('./reading-delivery.ts').readingDelivery>;
  autoReading?:AutoReadingState;
  budget?:WorkbenchBudget;
  streamingReplies?:{partnerId?:string;requestId:string;questionId:string;bookId:string;conversationId:string;paragraphCommentId?:string;text:string;state?:'generating'|'saving'|'incomplete'}[];
  sessionId: string; mode: WorkbenchMode; sessions: WorkbenchSession[];
  app: ApplicationSnapshot; selectedBookId: string; book?: BookView; page?: WorkbenchPage;
  events: WorkbenchEvent[]; ratings: Record<string, WorkbenchRating>; timings: Record<string, ReplyTiming>;
  eventHistory?:{count:number;beforeId?:string;hasEarlier:boolean};
  drafts:Record<string,WorkbenchDraft>;
  settings: WorkbenchSettings; services: WorkbenchService[]; sources: WorkbenchSource[];
  selectedService?: WorkbenchService;
  hasKey: boolean; busyAction: boolean; error: string; notice: string;
  coreLabel: string; importedHistory?: string;
  following: boolean; modelReady: boolean; backgroundModelReady?: boolean;
  historicalSourcesLoaded?:boolean;
  sessionArchived?:boolean;
  readingObservation?:WorkbenchReadingObservation;
  exportPrepared?:WorkbenchExportPrepared;
  /** Transport observation, never a fabricated host pause or reading-control state. */
  connectionError?:string;
  clientOperations?:WorkbenchClientOperation[];
  /** Rotated by host attach/reconnect; renderer must register this source generation. */
  sourceConnectionEpoch?:string;
  /** The one explicitly activated screen; passive registrations never take ownership. */
  sourceOwner?:{producerId:string;epoch:string};
};
export interface WorkbenchClient {
  /** Reopen the state connection and query existing operations without resubmitting them. */
  reconnect?():Promise<void>;
  /** Platform clock, outside the domain command queue; aborting it has no business side effect. */
  waitReadingDelay?(milliseconds:number,signal:AbortSignal):Promise<void>;
  getSnapshot(): WorkbenchSnapshot;
  subscribe(listener: () => void): () => void;
  importTxt(name: string, text: string): Promise<void>;
  importBackup(raw: string): Promise<void>;
  saveDraft(key:string,value:WorkbenchDraft|null):Promise<void>;
  /** Renderer transport capability; file bytes are not an application command argument. */
  importFile?(file:File):Promise<void>;
  extendBookSourceFile?(bookId:string,file:File,title?:string):Promise<void>;
  importSource(id: string): Promise<void>;
  selectBook(id: string): Promise<void>;
  renameBook(id:string,title:string):Promise<void>;
  getBookProjectLocations():Promise<import('../host/contract.ts').BookProjectLocations>;
  setBookProjectRootDirectory(directory:string):Promise<import('../host/contract.ts').BookProjectLocations>;
  recognizeBookDirectory(bookId:string,useModel:boolean):Promise<{entries:number;unresolved:boolean}>;
  extendBookSource(id:string,raw:string,title?:string):Promise<void>;
  jumpTo(position: number): Promise<void>;
  turnPage(delta: number): Promise<void>;
  estimateAutoReading(targetChapterIndex:number):Promise<AutoReadingEstimate>;
  configureAutoReading(settings:AutoReadingSettings):Promise<void>;
  startAutoReading(capture:WorkbenchSourceCapture,settings:AutoReadingSettings):Promise<void>;
  stopAutoReading(reason?:string):Promise<void>;
  advanceAutoReading():Promise<void>;
  /** Host-local/platform compatibility. The PC renderer uses captureReadingSource. */
  recordReadingPosition(position: number): void;
  provideToCurrent(): Promise<void>;
  startReading(): Promise<void>;
  startFollowing(range: { start: number; end: number }): Promise<void>;
  followVisible(range: { start: number; end: number }): Promise<void>;
  setSourceVisible(visible: boolean,range?:{start:number;end:number}): void;
  /** Passive and idempotent within the current archive connection generation. */
  registerReadingSource(producerId:string,archiveId:string,connectionEpoch:string):Promise<string>;
  /** Returns the active capture epoch; undefined means onlyIfUnowned found another owner. */
  activateReadingSource(producerId:string,sourceEpoch:string,onlyIfUnowned?:boolean):Promise<string|undefined>;
  releaseReadingSource(producerId:string,sourceEpoch:string):Promise<boolean>;
  captureReadingSource(capture:WorkbenchSourceCapture):Promise<WorkbenchSourceReceipt>;
  preparePrevious(through: number, from?: number): Promise<void>;
  refreshReadingViews(viewIds:string[]):Promise<void>;
  sendMessage(text: string, long?: boolean, conversationId?: string): Promise<void>;
  retryQuestion(chatId: string): Promise<void>;
  recoverReading(target:ReadingRecoveryTarget,expectedExecution:Exclude<ReadingRecoveryExecution,'none'>):Promise<void>;
  recoverQuestionReceipt(chatId:string):Promise<void>;
  resumeSceneParticipation(bookId: string,requestId?:string): Promise<void>;
  resumeTerminatedMaintenance(input:import('../core/types.ts').TerminatedMaintenanceResume):Promise<void>;
  resumeMaintenance(jobId:string):Promise<void>;
  closeLostMaintenance(jobId:string):Promise<void>;
  dismissMaintenance(jobId:string):Promise<void>;
  restoreMaintenance(jobId:string):Promise<void>;
  expandReply(chatId: string): Promise<void>;
  newDiscussion(): Promise<string>;
  listConversationMessages(bookId:string,query:import('../core/conversation-messages.ts').ConversationMessageQuery):Promise<import('../core/conversation-messages.ts').ConversationMessagePage>;
  continueConversation(bookId:string):Promise<string>;
  renameConversation(id: string, title: string): Promise<void>;
  updatePartner(name: string, traits: string): Promise<void>;
  reconcileBookAnalysis(bookId:string):Promise<unknown>;
  updatePartnerProfile(partnerId:string,profile:{personaTemplateId?:string;name?:string;preferences?:import('../core/types.ts').Partner['preferences'];avatar?:import('../core/types.ts').Partner['avatar']}):Promise<void>;
  adoptPartnerPersona(partnerId:string,templateId:string):Promise<void>;
  createPartner(templateId:string):Promise<string>;
  selectPartner(partnerId:string):Promise<void>;
  setPartnerAvatar(partnerId:string,dataUrl:string):Promise<string>;
  getPartnerAvatar(assetId:string):Promise<string|undefined>;
  correctMemory(id: string, text: string): Promise<void>;
  forgetMemory(id: string): Promise<void>;
  markNote(note: string, chatId?: string): void;
  setQuiet(value: boolean): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  markReply(chatId: string, rating: ReplyRating, note?: string): void;
  markHelpful(chatId: string): void;
  recordVisible(chatId: string, start: number, end: number): boolean | Promise<boolean>;
  updateSettings(settings: WorkbenchSettings): Promise<void>;
  setLanguage(language:'zh-CN'|'en', initializeDefaultPersona?:boolean):Promise<void>;
  useService(sourceId: string): Promise<WorkbenchService>;
  discardServiceSelection(): void;
  refreshServices(): Promise<void>;
  createSession(mode: WorkbenchMode): Promise<void>;
  switchMode(mode: WorkbenchMode): Promise<void>;
  openSession(id: string): Promise<void>;
  archiveSession(id:string):Promise<void>;
  archiveOtherSessions():Promise<void>;
  exportArchivedBackup(id:string):Promise<WorkbenchExportFile>;
  loadHistoricalSources():Promise<void>;
  exportHistoricalSource(id:string):Promise<{name:string;text:string}>;
  exportSession(options?:WorkbenchExportOptions): Promise<WorkbenchExportFile>;
  exportBackup(options?:WorkbenchExportOptions): Promise<WorkbenchExportFile>;
  readMemoryBody(bookId: string, memoryId: string): Promise<string>;
  readMemoryEvidence(bookId:string,memoryId:string):Promise<{start:number;end:number}[]>;
  listProcessEvents(beforeId?:string):Promise<{events:WorkbenchEvent[];beforeId?:string;hasEarlier:boolean}>;
  discoverKnowledgeDocuments(bookId: string, query?: { topic?: string; subject?: string; cursor?: string }): Promise<MemoryDiscoveryResult>;
  listParagraphComments(bookId: string, query?: { ranges?: { start: number; end: number }[]; cursor?: string }): Promise<CommandResult<'listParagraphComments'>>;
  postParagraphComment(bookId:string,input:import('../core/paragraph-comments.ts').UserParagraphComment):Promise<string>;
  confirmParagraphRead(bookId: string, range: { start: number; end: number }, version: string): Promise<void>;
  setParagraphCommentLiked(bookId:string,commentId:string,liked:boolean):Promise<void>;
  setMessageEmojiReaction(bookId:string,targetId:string,emoji:string,active:boolean):Promise<void>;
  clearUnreadMessages(bookId:string,input:{partnerId:string;targetIds:string[]}):Promise<number>;
  recordMessagePresentation(bookId:string,targetId:string,kind:'notified'|'seen'):Promise<boolean>;
  requestParagraphReply(bookId:string,commentId:string):Promise<void>;
  askAboutParagraphComment(bookId: string, commentId: string, text: string): Promise<void>;
  clearNotice(): void;
  dispose(): Promise<void>;
}

/** Only existing public product commands cross the host transport. */
export const workbenchCommands = [
  "reconcileBookAnalysis",
  "importTxt",
  "importBackup",
  "saveDraft",
  "importSource",
  "selectBook",
  "renameBook",
  "getBookProjectLocations",
  "setBookProjectRootDirectory",
  "extendBookSource",
  "recognizeBookDirectory",
  "jumpTo",
  "turnPage",
  "estimateAutoReading",
  "configureAutoReading",
  "startAutoReading",
  "stopAutoReading",
  "advanceAutoReading",
  "recordReadingPosition",
  "provideToCurrent",
  "startReading",
  "startFollowing",
  "followVisible",
  "setSourceVisible",
  "registerReadingSource",
  "activateReadingSource",
  "releaseReadingSource",
  "captureReadingSource",
  "preparePrevious",
  "refreshReadingViews",
  "sendMessage",
  "retryQuestion",
  "recoverReading",
  "recoverQuestionReceipt",
  "resumeSceneParticipation",
  "resumeTerminatedMaintenance",
  "resumeMaintenance",
  "closeLostMaintenance",
  "dismissMaintenance",
  "restoreMaintenance",
  "expandReply",
  "newDiscussion",
  "listConversationMessages",
  "continueConversation",
  "renameConversation",
  "updatePartner", "updatePartnerProfile", "adoptPartnerPersona", "createPartner", "selectPartner", "setPartnerAvatar", "getPartnerAvatar",
  "correctMemory",
  "forgetMemory",
  "markNote",
  "setQuiet",
  "pause",
  "resume",
  "stop",
  "markReply",
  "markHelpful",
  "recordVisible",
  "updateSettings",
  "setLanguage",
  "useService",
  "discardServiceSelection",
  "refreshServices",
  "createSession",
  "switchMode",
  "openSession",
  "archiveSession",
  "archiveOtherSessions",
  "exportArchivedBackup",
  "loadHistoricalSources",
  "exportHistoricalSource",
  "exportSession",
  "exportBackup",
  "readMemoryBody",
  "readMemoryEvidence",
  "listProcessEvents",
  "discoverKnowledgeDocuments",
  "listParagraphComments",
  "postParagraphComment",
  "confirmParagraphRead",
  "setParagraphCommentLiked",
  "setMessageEmojiReaction",
  "recordMessagePresentation",
  "clearUnreadMessages",
  "requestParagraphReply",
  "askAboutParagraphComment",
  "clearNotice"
] as const satisfies readonly (keyof WorkbenchClient)[];
export type WorkbenchCommand = typeof workbenchCommands[number];
