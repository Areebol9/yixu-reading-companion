import type {Context} from '@deepseek-ai/cordis';

/** A reading archive owns shared settings and accounting; books never clone it. */
export type BookProject = {
  schema: 'yixu-book-project-v1'; id: string; archiveId: string; bookId: string;
  title: string; contentVersion: string; directory: string; executionDirectory: string; workspaceId: string;
};
export type BookProjectLocations = {rootDirectory: string; projects: BookProject[]};
export interface ProjectRegistry {
  getLocations(): Promise<BookProjectLocations>;
  setRootDirectory(directory: string): Promise<BookProjectLocations>;
  ensurePartner(partner:{id:string;name:string}):Promise<void>;
  ensure(book: {id: string; title: string; version: string}): Promise<BookProject>;
  list(): Promise<BookProject[]>;
  attachSession(bookId: string, sessionId: string): Promise<void>;
}
/** Both ApplicationClient and the workbench client use this host-owned surface. */
export interface DomainClient {
  readonly snapshot?: unknown;
  getSnapshot?(): unknown;
  subscribe(listener: () => void): () => void;
  takeUIEvents?(): unknown[];
  command(name: string, ...args: unknown[]): Promise<unknown>;
}
export type CommandReceipt = {id: string; value?: unknown; error?: string; sequence?:number};
/** Transport acknowledgement only; the domain task remains owned by its archive. */
export type CommandStatus = {id:string;epoch:string;state:'accepted'|'running'|'complete'|'expired';acceptedAt:number;completedAt?:number;receipt?:CommandReceipt};
export type HostLifecycle = {archiveId:string;epoch:string;phase:'ready'|'stopping'|'closed'|'failed';busy:boolean;activeCommands:number;transfers:number;inFlight:number;unknownRequests:number;following:boolean;readingState?:string;error?:string};
export interface ArchiveRuntime {
  client: DomainClient;
  flush(): Promise<void>;
  /** Closes new work, collects already dispatched requests, then saves. */
  stop(input: {reason: string}): Promise<void>;
  pause?(): Promise<void>;
  dispose(): Promise<void>;
  detachReadingSource(): Promise<void>;
  reconnectClient(): Promise<void>;
  partnerAvatar?(id:string):Promise<string|undefined>;
  download?(id:string):Promise<{name:string;filename:string;sha256:string;bytes:number}|undefined>;
  exportStatus?(id:string):Promise<import('./downloads.ts').ExportProgress|undefined>;
  importFile?(input:{filename:string;kind:'backup'|'text'|'book-source';name:string;sourcePath?:string;bookId?:string;title?:string;bytes:number;sha256:string;progress:(stage:string,details?:Record<string,unknown>)=>Promise<void>}):Promise<void|{connectArchiveId:string}>;
}
export interface HostDomainFactory {
  openArchive(input: {
    archiveId: string; archiveDirectory: string; dshContext: Context;
    projectRegistry: ProjectRegistry; signal: AbortSignal;
  }): Promise<ArchiveRuntime>;
}
export type HostRequest = {id: string; epoch: string; name: string; args: unknown[]};
export type HostFrame = {epoch: string; sequence: number; snapshot: unknown; events: {sequence: number; value: unknown}[]};
export type HostDelta={epoch:string;sequence:number;baseSequence:number;patch:import('./projection-delta.ts').ProjectionDelta;events:HostFrame['events']};
export interface CompanionHostService {
  registerDomainFactory(factory: HostDomainFactory): () => Promise<void>;
  whenReady(): Promise<void>;
  shutdown(): Promise<void>;
  status(): {phase: 'awaiting-domain'|'opening'|'ready'|'failed'|'stopping'|'closed'; error?: string};
}
