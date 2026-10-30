import type {AgentRunner} from '../core/agent-port.ts';
import type {Store} from '../core/types.ts';
import type {WorkbenchSession} from './contract.ts';
import type {WorkbenchExportFile} from './contract.ts';

export interface WorkbenchDataStore extends Store {
  readBookText(version: string): Promise<string>;
  loadObservations<T>(): Promise<T | undefined>;
  saveObservations(value: unknown): Promise<void>;
  saveObservationChanges?(changes:import('./observation-store.ts').ObservationChanges):Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
  readProjectionState?():import('../core/types.ts').State;
}
export interface WorkbenchSessionRepository {
  list(): WorkbenchSession[];
  available(): WorkbenchSession[];
  active(): WorkbenchSession | undefined;
  remember(session: WorkbenchSession): void;
  markActive(id: string): void;
  archive(ids: readonly string[], currentId: string): number;
  flush(): Promise<void>;
  exportArchivedBackup(id: string): Promise<string>;
}
export interface WorkbenchEnvironment {
  sessions: WorkbenchSessionRepository;
  createStore(archiveId: string): WorkbenchDataStore | Promise<WorkbenchDataStore>;
  createHarness(archiveId: string): AgentRunner & {dispose?(): Promise<void>};
  createFactReviewer?(runner:AgentRunner):import('../core/agent-review-port.ts').AgentFactReviewer;
  initializeEngine?(archiveId:string,engine:import('../core/engine.ts').ReadingEngine):Promise<void>;
  bridge<T>(method: string, input?: unknown, signal?: AbortSignal,onStream?:(delta:import('../core/provider-stream.ts').ModelStreamDelta)=>void): Promise<T>;
  initialArchiveId?: string;
  fixedArchiveId?:string;
  browserEvents: boolean;
  developerMode?:boolean;
  projectDirectory?(archiveId: string, bookId: string): Promise<string>;
  sessionDirectory?(archiveId:string,bookId:string):Promise<string>;
  getBookProjectLocations?(archiveId:string):Promise<import('../host/contract.ts').BookProjectLocations>;
  saveBookProjectCopy?(archiveId:string,bookId:string,parentDirectory:string):Promise<{directory:string;title:string}>;
  attachAgentSession?(archiveId: string, bookId: string, sessionId: string): Promise<void>;
  prepareExport?(input:{archiveId:string;kind:'backup'|'record';name:string;exportId?:string;metadata?:Record<string,unknown>;onProgress?:(stage:string)=>void}):Promise<WorkbenchExportFile>;
}
