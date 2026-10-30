import type { Book, Chat, Memory, State, Session, LocatedPosition,Usage } from './types.ts';
import type { RuntimeUIEvent } from './runtime.ts';
import type { ApplicationActions } from './application.ts';
import type {ConversationMessageWindow,ConversationMessageStatistics} from './conversation-messages.ts';
import type {ChatSummary,MemorySummary} from './ui-records.ts';

export type ReadonlyData<T> = T extends object ? { readonly [K in keyof T]: ReadonlyData<T[K]> } : T;
type BookMetadata = Omit<Book, 'text'|'residentRanges'> & { textLength: number };
export type BookView = ReadonlyData<BookMetadata>;
export type MemoryView = ReadonlyData<MemorySummary>;
export type PublishedReplyView = ReadonlyData<Pick<Chat,'id'|'bookId'|'sessionId'|'text'|'createdAt'|'presentation'|'anchor'|'presentationReceipt'|'replyTo'>&{textTruncated?:true}>;
export type ApplicationChange=import('./engine-events.ts').EngineChange&{derived?:boolean};
export type ApplicationSnapshot = ReadonlyData<{
  revision: number;
  /** Heavy read models may follow the committed messages in separate frames. */
  derivedRevision?:number;
  projectionPending?:boolean;
  projectionError?:string;
  conversationContinuity?:{bookId:string;partnerId:string;conversationId:string;previousConversationId?:string}[];
  /** Live recent windows only; older full messages are read by their real ID cursor. */
  conversationMessages?:ConversationMessageWindow[];
  conversationStatistics?:ConversationMessageStatistics;
  /** Current partner: unread publications since presentation tracking began
   * per book (all publications for a fresh archive), and 20 recent seen replies.
   * The first saved receipt's conversation anchors the continuous range. */
  recentPublications?: PublishedReplyView[];
  questionProgress?:{questionId:string;status:string;receiptPending:boolean;pendingRequestId?:string;blockedReason?:string}[];
  readingViews?:{bookId:string;progress:ReturnType<typeof import('./published-views.ts').viewProgress>}[];
  state: Omit<State, 'books'|'readingDrafts'|'queryCheckpoints'|'companionReadingReceipts'|'companionCorrectionRepairs'|'agentSessions'|'memories'|'chats'|'usage'> & { books: BookMetadata[]; memories: MemorySummary[];chats:ChatSummary[];usage:Omit<Usage,'maintenanceDispatch'|'agentResponse'>[] };
  session?: Session;
  busy: boolean; status: string; progress?: { done: number; total: number };
  activities:import('./types.ts').ReadingActivity[];
  maintenanceProgress:import('./types.ts').MaintenanceProgress[];
  lastLatency?: number; lastObservation: string; recoveryRevision: number;
  readingFlow?: {maintenanceRecovery?:{jobId:string;state:'running'|'queued'|'external-required'|'pending';requestId?:string;failure?:import('./types.ts').ModelDispatchFailure}[];pendingChars:number;activeChars:number;oldestPendingAt?:number;backgroundWaitingSince?:number;foregroundPending:number;deferredExpressions:number;sceneSavePending:boolean;sceneSaveBookIds:string[];sceneRestoreBookIds:string[];sceneReceiptBookIds:string[]};
  readingControl?:{state:'running'|'paused'|'stopping';inFlight:number};
  locatedPosition?: LocatedPosition;
  webPausedReason: string; connectionAvailable: boolean;
  recording: boolean; voiceDraft: string; captureStarting: boolean; voiceActive: boolean;
}>;
export const applicationCommands = [
  'reconcileBookAnalysis', 'importText', 'recognizeBookDirectory', 'selectBook', 'renameBook', 'extendBookSource', 'readBookRange', 'setArchived', 'setKnown', 'confirmLocatedPosition', 'setFrontMatterIncluded', 'locatePosition', 'startReading', 'setReadingMode', 'prepare',
  'prepareBackground', 'finishReading', 'pause', 'stop', 'pauseReadingSafely', 'resumeReadingSafely', 'stopReadingSafely', 'quiet', 'newDiscussion', 'continueConversation', 'renameConversation',
  'listParagraphComments', 'postParagraphComment', 'resumeSceneParticipation', 'setParagraphCommentLiked', 'setMessageEmojiReaction', 'recordMessagePresentation', 'clearUnreadMessages', 'requestParagraphReply', 'askAboutParagraphComment', 'ask', 'askWithFuture', 'expandReply', 'retryQuestion', 'recoverQuestionReceipt', 'recoverReading', 'resumeTerminatedMaintenance', 'resumeMaintenance', 'closeLostMaintenance', 'dismissMaintenance', 'restoreMaintenance', 'correctTranscript', 'correctMemory', 'reviewFacts', 'reviewFact', 'resumeFactReview', 'cancelFactReview', 'forgetMemory',
  'deleteChat', 'setCommonHabit', 'updatePartner', 'updatePartnerProfile', 'adoptPartnerPersona', 'createPartner', 'selectPartner', 'setPartnerAvatar', 'getPartnerAvatar', 'addService', 'selectService', 'updateService',
  'enableService', 'saveModelSettings', 'updateLimits', 'setLanguage', 'selectSearch', 'setSearchEndpoint', 'enableSearch', 'disableSearch',
  'setWebResult', 'startCapture', 'stopCapture', 'selectReadingSource', 'startOrSendVoice', 'cancelVoice',
  'previewBackup', 'restoreBackup', 'exportBackup', 'readWorkDossier', 'readMemoryBody', 'readMemoryEvidence', 'discoverKnowledgeDocuments','listConversationMessages',
] as const;
export type ApplicationCommand = typeof applicationCommands[number];
export type CommandArgs<K extends ApplicationCommand> = Parameters<ApplicationActions[K]>;
export type CommandResult<K extends ApplicationCommand> = Awaited<ReturnType<ApplicationActions[K]>>;
export interface ApplicationClient {
  readonly snapshot: ApplicationSnapshot;
  subscribe(listener: (change?:ApplicationChange) => void): () => void;
  takeUIEvents(): RuntimeUIEvent[];
  command<K extends ApplicationCommand>(name: K, ...args: CommandArgs<K>): Promise<CommandResult<K>>;
}

export function freezeData<T>(value: T): ReadonlyData<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value as ReadonlyData<T>;
}
