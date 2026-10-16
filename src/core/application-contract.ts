import type { Book, Memory, State, Session, LocatedPosition,Usage } from './types.ts';
import type { RuntimeUIEvent } from './runtime.ts';
import type { ApplicationActions } from './application.ts';

export type ReadonlyData<T> = T extends object ? { readonly [K in keyof T]: ReadonlyData<T[K]> } : T;
type BookMetadata = Omit<Book, 'text'|'residentRanges'> & { textLength: number };
export type BookView = ReadonlyData<BookMetadata>;
export type MemoryView = ReadonlyData<Omit<Memory, 'text'>>;
export type ApplicationSnapshot = ReadonlyData<{
  revision: number;
  questionProgress?:{questionId:string;status:string;receiptPending:boolean;blockedReason?:string}[];
  readingViews?:{bookId:string;progress:ReturnType<typeof import('./published-views.ts').viewProgress>}[];
  state: Omit<State, 'books'|'readingDrafts'|'queryCheckpoints'|'companionReadingReceipts'|'companionCorrectionRepairs'|'memories'|'usage'> & { books: BookMetadata[]; memories: Omit<Memory,'text'>[];usage:Omit<Usage,'maintenanceDispatch'>[] };
  session?: Session;
  busy: boolean; status: string; progress?: { done: number; total: number };
  activities:import('./types.ts').ReadingActivity[];
  maintenanceProgress:import('./types.ts').MaintenanceProgress[];
  lastLatency?: number; lastObservation: string; recoveryRevision: number;
  readingFlow?: {pendingChars:number;activeChars:number;oldestPendingAt?:number;backgroundWaitingSince?:number;foregroundPending:number;deferredExpressions:number;sceneSavePending:boolean;sceneSaveBookIds:string[];sceneRestoreBookIds:string[]};
  readingControl?:{state:'running'|'paused'|'stopping';inFlight:number};
  locatedPosition?: LocatedPosition;
  webPausedReason: string; connectionAvailable: boolean;
  recording: boolean; voiceDraft: string; captureStarting: boolean; voiceActive: boolean;
}>;
export const applicationCommands = [
  'importText', 'selectBook', 'readBookRange', 'setArchived', 'setKnown', 'confirmLocatedPosition', 'setFrontMatterIncluded', 'locatePosition', 'startReading', 'setReadingMode', 'prepare',
  'prepareBackground', 'finishReading', 'pause', 'stop', 'pauseReadingSafely', 'resumeReadingSafely', 'stopReadingSafely', 'quiet', 'newDiscussion', 'renameConversation',
  'listParagraphComments', 'postParagraphComment', 'resumeSceneParticipation', 'setParagraphCommentLiked', 'requestParagraphReply', 'askAboutParagraphComment', 'ask', 'askWithFuture', 'expandReply', 'retryQuestion', 'recoverQuestionReceipt', 'resumeTerminatedMaintenance', 'resumeMaintenance', 'correctTranscript', 'correctMemory', 'reviewFacts', 'reviewFact', 'resumeFactReview', 'cancelFactReview', 'forgetMemory',
  'deleteChat', 'setCommonHabit', 'updatePartner', 'addService', 'selectService', 'updateService',
  'enableService', 'updateLimits', 'selectSearch', 'setSearchEndpoint', 'enableSearch', 'disableSearch',
  'setWebResult', 'startCapture', 'stopCapture', 'selectReadingSource', 'startOrSendVoice', 'cancelVoice',
  'previewBackup', 'restoreBackup', 'exportBackup', 'readWorkDossier', 'readMemoryBody', 'discoverKnowledgeDocuments',
] as const;
export type ApplicationCommand = typeof applicationCommands[number];
export type CommandArgs<K extends ApplicationCommand> = Parameters<ApplicationActions[K]>;
export type CommandResult<K extends ApplicationCommand> = Awaited<ReturnType<ApplicationActions[K]>>;
export interface ApplicationClient {
  readonly snapshot: ApplicationSnapshot;
  subscribe(listener: () => void): () => void;
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
