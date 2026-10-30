import type {Book,Chat,Evidence,FormationSources,Memory,Range,ReadingRecord,ReadingReply,State,WebReference} from './types.ts';
import type {MemoryPlan,planMemories} from './memory-plan.ts';

/** Source permissions and parent edges, without conversation prose or raw model
 * responses. The host chooses the authorized book/partner/dependency scope. */
export type ComputationChat=Pick<Chat,'id'|'bookId'|'partnerId'|'presentation'|'anchor'|'excluded'|'futureGrant'|'memoryAllowed'|'replyTo'|'paragraphCommentId'|'memoryIds'|'contextChatIds'|'basis'|'evidence'|'outdatedBy'|'replacedBy'|'habitIds'>;
export function computationChat(chat:Chat):ComputationChat{
  const {id,bookId,partnerId,presentation,anchor,excluded,futureGrant,memoryAllowed,replyTo,paragraphCommentId,memoryIds,contextChatIds,basis,evidence,outdatedBy,replacedBy,habitIds}=chat;
  return{id,bookId,partnerId,presentation,anchor,excluded,futureGrant,memoryAllowed,replyTo,paragraphCommentId,memoryIds,contextChatIds,basis,evidence,outdatedBy,replacedBy,habitIds};
}
export type ComputationReading=Pick<ReadingRecord,'bookId'|'version'|'partnerId'|'source'|'ranges'|'processing'|'worldCandidate'|'arcCandidate'>;
export function computationReading(record:ReadingRecord):ComputationReading{
  const {bookId,version,partnerId,source,ranges,processing,worldCandidate,arcCandidate}=record;
  return{bookId,version,partnerId,source,ranges,processing,worldCandidate,arcCandidate};
}
export type MemoryComputationScope={
  /** The existing absolute-coordinate source lease. A full original is never
   * transported; residentRanges contain only this task's actual source slices. */
  book:Pick<Book,'id'|'version'|'known'|'sourceLineage'|'frontMatterEnd'|'frontMatterIncluded'|'readingStrategy'|'narrativeMode'|'arcCandidate'|'worldCandidate'|'residentRanges'>&{textLength:number;text?:''};
  partnerId:string;
  partners:Pick<State['partners'][number],'id'|'legacyUnlabelled'>[];
  /** Same-book metadata and only explicitly loaded/authorized document bodies.
   * Keep predecessor/subject/withdrawal metadata needed by the task's closure. */
  memories:Memory[];
  chats:ComputationChat[];
  forgotten:State['forgotten'];
  habits?:State['habits'];
  readings?:ComputationReading[];
  entityRoots?:State['entityRoots'];
  publishedViews?:State['publishedViews'];
  /** Task-local complete source closure, built and permission-checked from real
   * records by buildMemoryComputationScope. Never a historical record rewrite. */
  formationSources?:FormationSources;
};
export type MemoryComputationInput={
  scope:MemoryComputationScope;
  result:ReadingReply;
  refs:Evidence[];
  parents:string[];
  chatIds:string[];
  source:Memory['source'];
  webSources?:WebReference[];
  habitIds?:string[];
  originalRanges?:Range[];
  passages?:[string,NonNullable<Memory['sourceQuote']>][];
  readingStage?:Range[];
  options?:Parameters<typeof planMemories>[12];
  /** Defaults to true. A caller that adds further dependent operations may
   * validate that final plan again through validateDocumentSubjects. */
  validateSubjects?:boolean;
};
export type DocumentSubjectsComputationInput={memories:Memory[];plan:Pick<MemoryPlan,'added'|'developments'>};
export type DomainComputationOptions={signal?:AbortSignal;lane?:'foreground'|'background'};
/** Pure candidate computation only. The engine owns source/version checks,
 * receipts, publication and the sole persistent State before and after awaiting. */
export interface DomainComputationPort{
  planMemories(input:MemoryComputationInput,options?:DomainComputationOptions):Promise<MemoryPlan>;
  validateDocumentSubjects(input:DocumentSubjectsComputationInput,options?:DomainComputationOptions):Promise<void>;
  dispose():Promise<void>;
}
export class ComputationScopeError extends Error{
  constructor(message:string,readonly requiredMemoryIds?:string[],readonly requiredChatIds?:string[]){super(message);this.name='ComputationScopeError';}
}
