import type {Chat,Memory} from './types.ts';

/** Display/navigation data only. Full provenance remains in the domain store. */
export type MemorySummary=Pick<Memory,'id'|'bookId'|'partnerId'|'kind'|'bodyRef'|'documentTitle'|'documentState'|'createdAt'|'forgotten'|'source'|'historicalOnly'|'backgroundOrigin'|'correctionOf'|'replacedBy'|'invalidatedBy'|'revisionKind'|'navigationCues'|'reviewDisposition'|'reviewReason'|'revisionReason'|'sourceQuote'>&{evidenceCount:number};
export function memorySummary(memory:Memory):MemorySummary{
  const {id,bookId,partnerId,kind,bodyRef,documentTitle,documentState,createdAt,forgotten,source,historicalOnly,backgroundOrigin,correctionOf,replacedBy,invalidatedBy,revisionKind,navigationCues,reviewDisposition,reviewReason,revisionReason,sourceQuote}=memory;
  return{id,bookId,partnerId,kind,bodyRef,documentTitle,documentState,createdAt,forgotten,source,historicalOnly,backgroundOrigin,correctionOf,replacedBy,invalidatedBy,revisionKind,navigationCues,reviewDisposition,reviewReason,revisionReason,sourceQuote,evidenceCount:(memory.sourceEvidence??memory.evidence).length};
}
export type ChatSummary=Omit<Chat,'evidence'|'basis'|'memoryIds'|'contextChatIds'|'habitIds'|'historicalCommentIds'|'readingReaction'|'publication'|'memoryResult'>&{
  readingReaction?:Pick<NonNullable<Chat['readingReaction']>,'status'|'reason'|'usageId'>;
  publication?:Pick<NonNullable<Chat['publication']>,'status'|'reason'|'dueAt'|'destination'>;
  memoryResult?:Pick<NonNullable<Chat['memoryResult']>,'status'>;
};
export function chatSummary(chat:Chat):ChatSummary{
  const {evidence,basis,memoryIds,contextChatIds,habitIds,historicalCommentIds,readingReaction,publication,memoryResult,...visible}=chat;
  return{...visible,...(readingReaction?{readingReaction:{status:readingReaction.status,reason:readingReaction.reason,usageId:readingReaction.usageId}}:{}),...(publication?{publication:{status:publication.status,reason:publication.reason,dueAt:publication.dueAt,destination:publication.destination}}:{}),...(memoryResult?{memoryResult:{status:memoryResult.status}}:{})};
}
