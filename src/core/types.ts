export type Range = { start: number; end: number };
export const READING_THOUGHT_LIMIT = 16;
export const READING_STATE_LIMIT = 6;
export const READING_MEMORY_LIMIT = READING_THOUGHT_LIMIT + 32 + 1 + 1 + READING_STATE_LIMIT + 6;
export type ObservationCoverage = 'fragments' | 'continuous-page';
export type ReadingRecoveryTarget=
  |{kind:'question';questionId:string;requestId?:string}
  |{kind:'scene';bookId:string;requestId:string}
  |{kind:'maintenance';jobId:string;requestId?:string};
export type ReadingRecoveryExecution='local-result'|'receipt'|'continue'|'none';
export type ReadingRecoveryCapability={
  kind:'local'|'condition'|'user'|'settlement'|'history';
  action?:'recover-question'|'retry-question'|'recover-scene'|'resume-maintenance'|'close-lost-maintenance';
  reason?:string;
  execution:ReadingRecoveryExecution;
  automatic:boolean;
  automaticState?:'queued'|'running'|'stopped';
  availability:'available'|'running'|'blocked'|'history';
  responsibility:'running'|'unfinished'|'settlement'|'history';
  target?:ReadingRecoveryTarget;
  trigger?:'never-dispatched'|'session-not-dispatched'|'length'|'condition-change'|'paused';
};
export type ReadingRecoveryDecision=ReadingRecoveryCapability&{target:ReadingRecoveryTarget};
/** Transient projection of an existing owner or durable request, never a task store. */
export type ReadingActivity = {
  id:string;bookId:string;partnerId:string;
  sessionId?:string;
  responsibility?:'running'|'unfinished'|'settlement'|'history';
  kind:'scene'|'question'|'maintenance'|'expression';
  stage:'queued'|'preparing'|'waiting-model'|'tools'|'validating'|'saving'|'waiting-publish'|'paused'|'unknown'|'failed'|'complete'|'quiet'|'obsolete';
  purpose:'scene-judgment'|'answer'|'paragraph-reply'|'deep-maintenance'|'expression'|'paragraph-comment';
  since:number;startedAt:number;updatedAt:number;endedAt?:number;reason?:string;
  questionId?:string;jobId?:string;requestId?:string;chatId?:string;
  recovery?:ReadingRecoveryCapability;
  progress?:{chars?:number;completedChars?:number;modelRounds?:number;savedDocuments?:number;savedViews?:number;pendingChats?:number;pendingViews?:number};
};
export type MaintenanceProgress={oldestPending?:{start:number;chapterTitle?:string};pendingChapterCount?:number;bookId:string;knownChars:number;preparedChars:number;missingChars:number;queuedChars:number;workingChars:number;blockedChars:number;overviewPending:number;pendingChatCount:number;blockedJobs:number;queuedJobs:number;workingJobs:number};
// A local position preview, never a reading permission or prepared range.
export type LocatedPosition = { id: string; bookId: string; version: string; position: number; chapter: string; excerpt: string };
export type WebReference = { title: string; url: string; read?: boolean };
export type Evidence = Range & { bookId: string; version: string };
export type Chapter = Range & { title: string; index: number; contentStart?:number;contentEnd?:number;kind?:'volume'|'part'|'chapter'|'section'|'preface'|'epilogue'|'appendix'|'body';level?:number;parentIndex?:number };
export type BookDirectory={version:string;entries:Chapter[];unresolved:boolean;method:'local'|'model'};
export type ReadingStrategy = 'structured' | 'full-original' | 'companion';
export type ReadingMode = 'legacy' | 'stages' | 'full-original' | 'companion';
export type ArcCandidate = 'v1';
export type WorldCandidate = 'v1';
export type ReadingProfile = { readingStrategy: ReadingStrategy; narrativeMode: NarrativeMode; arcCandidate?:ArcCandidate;worldCandidate?:WorldCandidate;analysisTask?:true };
/** Explicit local candidate capabilities; absence preserves the production protocol. */
/** Explicit false values retain older behavior for frozen comparisons. */
export type CompanionCandidate = { earlyReaction?:boolean; historicalSearch?:boolean; focusedExpression?:boolean; fairScheduling?:boolean; workspaceHandoff?:boolean };
/** Local import provenance for display only; never model material. */
export type BookSourceFile = {name:string;path?:string};
export type Book = {
  id: string; title: string; version: string; text: string; textLength?: number; chapters: Chapter[];
  sourceFile?:BookSourceFile;
  /** Navigational hierarchy is independent of stable reading-section indices. */
  directory?:BookDirectory;
  /** Every accepted historical hash names exactly this verified prefix, never
   * the appended text. Revalidated against originals on import/cold recovery. */
  sourceLineage?:{currentVersion:string;prefixes:readonly {version:string;chars:number;chapters:number}[]};
  /** Task-local range lease. Never stored or pushed to a renderer as a full book. */
  residentRanges?: (Range&{text:string})[];
  /** Actual observations for natural scene cadence; never a reading grant. */
  sceneObserved?:{partnerId:string;ranges:Range[]}[];
  known: Range[]; position: number; prepared: Range[]; archived: boolean; createdAt: number;
  backgroundPrepared?: Range[];
  partnerProgress?:{partnerId:string;prepared:Range[];backgroundPrepared?:Range[];buffered?:Range[];fullOriginalPending?:Range[]}[];
  // Authorized unfinished material, retained across sessions; not model understanding.
  buffered?: Range[];
  readingSourceId?: string;
  frontMatterEnd?: number;
  frontMatterIncluded?: boolean;
  /** Internal candidate; absence retains the structured reading path. */
  readingStrategy?: ReadingStrategy;
  narrativeMode?: NarrativeMode;
  arcCandidate?: ArcCandidate;
  worldCandidate?: WorldCandidate;
  /** Actual observed direct-reading tasks not yet durably completed; never all old known text. */
  fullOriginalPending?: Range[];
};
export type MemoryKind = 'story' | 'opinion' | 'question' | 'shared' | 'user' | 'context' | 'stage' | 'state' | 'arc';
export function memoryTextLimit(kind:MemoryKind|undefined):number|undefined {
  return kind==='opinion'?undefined:kind==='context'?1000:1800;
}
export type NarrativeMode = 'legacy' | 'stages';
export type StateWriteVersion = 1 | 2;
export type StageNarrative = { ranges: Range[]; previousStageId?: string; continues: boolean };
export type StatePart = { id: string; text: string; memoryRef?: { memoryId: string; start: number; end: number }; sourceEvidence?: Evidence[] };
export type StateProjection = { topic: string; asOf: Range[]; status: 'active' | 'ended'; writeVersion?: 2; parts?: StatePart[]; end?: { text: string; sourceEvidence: Evidence[] } };
export type StageNarrativeReply = { text: string; continues?: boolean; sourceIds?: string[]; basis?:MemoryBasis };
export type StatePartOperation = { op: 'add' | 'replace' | 'retire'; partId?: string; text?: string; memoryId?: string; start?: number; end?: number; sourceIds?: string[]; reason?: string };
export type StateUpdate = { topic: string; text?: string; status?: 'active' | 'ended'; stateChangeOf?: string; sourceIds?: string[]; operations?: StatePartOperation[]; end?: { text: string; sourceIds: string[] };basis?:MemoryBasis };
export type ArcRelationType = 'shared-event'|'enables'|'blocks'|'information'|'goal-change'|'delayed-effect'|'merge-split'|'feedback';
export type ArcPartRole = 'open'|'progress'|'condition'|'impact';
export type ArcImpact = { type:ArcRelationType; sourceArcId:string; sourceVersionId:string; targetArcId:string; targetVersionId:string; cognition:'observed'|'inferred' };
export type ArcPart = StatePart & { role:ArcPartRole; impact?:ArcImpact };
export type ArcProjection = { arcId:string;label:string;status:'active'|'offstage'|'ended';parts:ArcPart[];end?:{text:string;sourceEvidence:Evidence[]} };
export type ArcOperation = StatePartOperation & { role?:ArcPartRole;impact?:{type:ArcRelationType;targetId:string;cognition:'observed'|'inferred'} };
export type ArcUpdate = {label?:string;arcChangeOf?:string;status?:ArcProjection['status'];operations:ArcOperation[];sourceIds?:string[];reason?:string;end?:{text:string;sourceIds:string[]};basis?:MemoryBasis};
export type NarrativeNote = { category: 'event' | 'relation' | 'rule' | 'thread' | 'view'; subjects: string[]; condition?: string; storyTime?: string };
export type EntityRoot = {id:string;bookId:string;version:string;partnerId:string;source:'reading'|'background';originMemoryId:string};
export type EntityRootProposal = {key:string;memoryId:string};
export type EntityAbout = {entityId:string;role?:string};
export type IdentityClaim = {entityId:string;type:'name'|'same-identity'|'different-identity';name?:string;targetId?:string;cognition:'observed'|'inferred'|'claimed';speakerId?:string;changeOf?:string};
export type Attribution = {holderId:string;mode:'claims'|'believes'|'received'|'explicitly-unaware';speakerId?:string;grounding:'stated'|'inferred';contentRef?:{memoryId:string;start:number;end:number}};
export type RuleLink = {type:'exception-to'|'limited-by';memoryId:string;cognition:'observed'|'inferred'};
export type WorldNote = {about?:EntityAbout[];identityClaim?:IdentityClaim;attribution?:Attribution;ruleLinks?:RuleLink[];worldChangeOf?:string;entityBindings?:{entityId:string;memoryId:string}[]};
export type SemanticMemoryRef={memoryId:string;start:number;end:number};
export type TemporalRelation={relation:'before'|'after'|'overlaps';targetId:string};
export type TemporalAnchor={text:string;cognition:'observed'|'inferred';sourceEvidence:Evidence[];relations?:TemporalRelation[]};
export type TemporalNote={occurrence?:TemporalAnchor;revelation?:{sourceEvidence:Evidence[]};acquisition?:TemporalAnchor};
export type ClueNote={status:'candidate'|'confirmed'|'withdrawn';cognition:'observed'|'inferred';setupRef:SemanticMemoryRef;payoffRefs?:SemanticMemoryRef[];sourceEvidence:Evidence[]};
export type SemanticNote={temporal?:TemporalNote;clue?:ClueNote};
export type TemporalAnchorProposal=Omit<TemporalAnchor,'sourceEvidence'>&{sourceIds:string[]};
export type TemporalNoteProposal={occurrence?:TemporalAnchorProposal;revelation?:{sourceIds:string[]};acquisition?:TemporalAnchorProposal};
export type ClueNoteProposal=Omit<ClueNote,'sourceEvidence'>&{sourceIds:string[]};
export type SemanticNoteProposal={temporal?:TemporalNoteProposal;clue?:ClueNoteProposal};
export type ReadingDelivery={protocol:'reading-text-v1'|'reading-documents-v1';proposal:'none'|'accepted'|'rejected'};
export function isReadingDelivery(value:unknown):value is ReadingDelivery {
  return!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>k==='protocol'||k==='proposal')&&['reading-text-v1','reading-documents-v1'].includes((value as ReadingDelivery).protocol)&&['none','accepted','rejected'].includes((value as ReadingDelivery).proposal);
}
export type SceneOpportunity={chapterIndex:number;slot:number|'end';position:number;seenChars:number;
  /** Task-local original paragraphs. Neither reading progress nor maintenance permission. */
  preview?:Range&{targetStart:number}};
/** Observation permission has actually reached its normal storage boundary. */
export type ReadingObservationSaved=Readonly<{id:string;instanceId:string;bookId:string;version:string;partnerId:string;sessionId:string;observation:number;ranges:ReadonlyArray<Readonly<Range>>;savedAt:number}>;
export type SceneInsight={text:string;sourceIds:string[]};
export type SceneInsightRecord={text:string;evidence:Evidence[];memoryIds:string[];chatIds:string[];viewIds?:string[]};
export type ReadingRecord = { id: string; bookId: string; version: string; partnerId: string; source: 'preparation' | 'reading' | 'background'; ranges: Range[]; memoryIds: string[]; createdAt: number; processing?: 'model' | 'layout'; expressionOnly?:true; sceneResult?:{requestId:string;chatIds:string[]}; sceneCommentIds?:string[]; sceneJudgment?:'quiet'|'expressions'; sceneOpportunity?:SceneOpportunity;sceneInsight?:SceneInsightRecord; expressionContract?:'paragraph-expressions-v1'; draftId?: string;supersededReceiptIds?:string[];arcCandidate?:ArcCandidate;worldCandidate?:WorldCandidate;delivery?:ReadingDelivery };
/** A durable handoff containing references only; understanding stays in ordinary Memory. */
export type CompanionWorkspace = {
  bookId: string; version: string; partnerId: string; source: 'reading' | 'background';
  revision: number; understandingId?: string; focusIds: string[];
  /** Concrete document versions currently used; absence keeps the old single-view handoff. */
  workingIds?: string[]; workingRevision?: number;
  /** Independent field clocks; absent legacy fields use revision. */
  understandingRevision?: number; focusRevision?: number;
  lastReadingId?: string; lastChatId?: string; updatedAt: number;
};
export type WorkspaceVersion = {understandingId?:string;understandingRevision:number;focusRevision:number;workingIds?:string[];workingRevision?:number};
export function isWorkspaceVersion(value:unknown,revision:number|undefined):value is WorkspaceVersion {
  if(!value||typeof value!=='object'||Array.isArray(value)||revision===undefined||!Number.isSafeInteger(revision)||revision<0)return false;
  const v=value as WorkspaceVersion;
  return Object.keys(v).every(k=>['understandingId','understandingRevision','focusRevision','workingIds','workingRevision'].includes(k))&&
    (v.workingIds===undefined||Array.isArray(v.workingIds)&&v.workingIds.every(id=>typeof id==='string'&&id.length>0&&id.length<=128)&&new Set(v.workingIds).size===v.workingIds.length)&&
    (v.workingRevision===undefined||Number.isSafeInteger(v.workingRevision)&&v.workingRevision>=0&&v.workingRevision<=revision)&&
    (v.understandingId===undefined||typeof v.understandingId==='string'&&v.understandingId.length>0&&v.understandingId.length<=128)&&
    [v.understandingRevision,v.focusRevision].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=revision);
}
/** Temporary recovery material, never a current interpretation or a recall source. */
export type CompanionCorrectionRepair = {
  id:string; bookId:string;version:string;partnerId:string;source:CompanionWorkspace['source'];
  /** Repair one concrete working document without replacing the global impression. */
  workingDocument?:true;
  workspaceRevision:number;ranges:Range[];oldMemoryId:string;oldDraft?:Memory;
  memoryIds:string[];chatIds:string[];habitIds:string[];correctionIds:string[];
  dependencyStamp:string;status:'pending'|'blocked'|'complete';createdAt:number;
  /** Explicit foreground focus commits; no understanding or source-authority handoff. */
  focusHandoffs?:{before:CompanionWorkspace;after:CompanionWorkspace;questionId:string;sourceStamp:string}[];
};
export type MemoryBasis = { memoryIds: string[]; chatIds: string[]; habitIds?: string[] };
export type HabitKey = 'replyLength' | 'followupQuestions';
export type CommonHabit = {
  id: string; partnerId: string; key: HabitKey; value: string; createdAt: number;
  sourceChatId?: string; sourceBookId?: string; replaces?: string; retiredBy?: string;
  forgotten: boolean; invalidatedBy?: string;
};
export function documentCapacity(chars:number){return{chars,unit:'UTF-16' as const};}
export type MemoryBodyRef = { key: string; hash: string; chars: number };
export type MemoryBody = { key: string; hash: string; text: string };
/** Coordinates belong to one immutable body; line ends are inclusive. */
export type DocumentLocation = {version:string;hash:string;start?:number;end?:number;startLine?:number;endLine?:number};
export type DocumentEdit = {oldText?:string;location?:DocumentLocation;newText:string;sourceIds?:string[]};
/** Exposure is retained for withdrawal, never inferred from model adoption. */
export type FormationSources = {kind:'formation-sources-v1';materialRef?:TaskMaterialRef;memoryIds:string[];chatIds:string[];viewIds:string[];habitIds?:string[];evidence:Evidence[]};
export type DocumentOperation = 'create'|'develop'|'revise'|'merge'|'organize'|'retire'|'restore';
/** Derived change locations in the full prose, not a second fact store. */
export type DocumentRevision = {previousId:string;changes:{before:Range;after:Range;sourceEvidence:Evidence[]}[]};
export type Memory = WorldNote & SemanticNote & {
  /** Book analysis is shared; persona experience remains private. partnerId records the author. */
  scope?:'book'|'partner';
  historicalCommentIds?:string[];
  id: string; bookId: string; partnerId: string; kind: MemoryKind; text?: string;
  /** Absence of text with a reference means unloaded, never an empty understanding. */
  bodyRef?: MemoryBodyRef;
  /** Optional navigation only; these fields do not establish facts or reading permission. */
  organization?:import('./document-organization.ts').DocumentOrganization;
  documentTitle?: string; navigationCues?: string[]; knowledgeDistribution?:import('./knowledge-distribution.ts').KnowledgeDistribution;
  documentRevision?:DocumentRevision;
  formationSources?:FormationSources;
  /** Concrete write bases, separate from semantic adoption. */
  writeBaseIds?:string[];
  /** A withdrawn current document remains an explicitly readable historical version. */
  documentState?:'retired';
  documentSuccessors?:string[];
  evidence: Evidence[]; parents: string[]; chatIds: string[];
  /** A completed old background interpretation that lost the foreground handoff. Read-only history. */
  historicalOnly?: true;
  createdAt: number; forgotten: boolean; source: 'preparation' | 'reading' | 'conversation' | 'background' | 'correction' | 'review';
  /** Rechecking or correcting independent reading does not make it shared reading. */
  backgroundOrigin?: true;
  correctionOf?: string; replacedBy?: string; invalidatedBy?: string;
  /** Additional explicit predecessors of a merged understanding; the primary is correctionOf. */
  mergePreviousIds?: string[];
  /** Withdrawal lineage only: retired repair material never becomes a claim source. */
  correctionRepairSources?:{memoryIds:string[];chatIds:string[];habitIds:string[]};
  basis?: MemoryBasis;
  webSources?: WebReference[];
  habitIds?: string[];
  reviewDisposition?: 'supported' | 'unsupported';
  reviewReason?: string;
  revisionKind?: 'development';
  revisionReason?: string;
  sourceQuote?: { text: string; evidence: Evidence };
  // Model-selected original passages, separate from the full exposure fence in evidence.
  // A source location is a traceability claim, not proof that the assertion is correct.
  sourceEvidence?: Evidence[];
  // Original reading task being processed when this record was created.
  // Neither event time, full exposure permission, nor a claim of present validity.
  readingStage?: Range[];
  /** Contributes to this still-open question without declaring it resolved. */
  answersPartOf?: string;
  narrative?: NarrativeNote;
  stageNarrative?: StageNarrative;
  stateProjection?: StateProjection;
  /** Normal evolution preserves the preceding state as historical evidence. */
  stateChangeOf?: string;
  arcProjection?: ArcProjection;
  arcChangeOf?: string;
};
export type HydratedMemory = Memory & {text:string};
export type MessageEmojiReaction={actor:'user'|'partner';actorId:string;emoji:string;createdAt:number};
export type Chat = {
  emojiReactions?:MessageEmojiReaction[];
  presentationReceipt?:{notifiedAt?:number;seenAt?:number;clearedAt?:number};
  recoveredFrom?:{requestId:string;sourceTime:number;recoveredAt:number};
  expressionAnchor?:import('./paragraph-comments.ts').ParagraphAnchor;
  expressionContract?:'paragraph-expressions-v1'; historicalCommentIds?:string[]; presentation?:'paragraph'; anchor?:import('./paragraph-comments.ts').ParagraphAnchor;
  formationRanges?:Range[]; formedThrough?:number; sharedChatId?:string; paragraphCommentId?:string;
  /** A reader's interaction with this exact comment, never a fact or general preference. */
  readerInteraction?:{liked:boolean;updatedAt:number};
  /** Durable candidate state, distinct from the model's completed judgment. */
  publication?:{status:'published'|'deferred'|'obsolete'|'save-failed';reason?:string;dueAt?:number;destination?:'paragraph';scene?:{instanceId:string;sessionId:string;generation:number;dialogueRevision:number;usageId:string;requestKey:string;stampHash:string}};
  id: string; bookId: string; sessionId: string; role: 'user' | 'assistant'; text: string;
  partnerId?: string;
  evidence: Evidence[]; createdAt: number; excluded: boolean; futureGrant?: string;
  webSources?: WebReference[];
  delivery?: 'pending' | 'failed' | 'answered' | 'stopped';
  longReply?: boolean;
  answerScope?:'overview'|'focused';
  /** Real dialogue remains visible, but cannot become later model material or memory. */
  memoryAllowed?:false;
  expansionOffered?: boolean;
  expansionOf?: string;
  replyTo?: string;
  memoryIds?: string[]; contextChatIds?: string[]; outdatedBy?: string;
  basis?: MemoryBasis;
  memoryResult?: { status: 'saved' | 'reused' | 'not_saved' | 'temporary'; memoryIds: string[]; habitIds?: string[] };
  habitIds?: string[];
  input?: 'voice'; corrects?: string; replacedBy?: string;
  /** Actual latest response attempt, not inferred historical preparation. */
  responseProfile?: ReadingProfile;
  /** Core release to visible chat/client, not a measured browser paint time. */
  readingReaction?: { requestKey:string; raw:string; status:'saved'|'delivered'|'suppressed'; reason?:string;usageId?:string;attempts?:{raw:string;status:'saved'|'delivered'|'suppressed';reason?:string;usageId?:string}[] };
};
export type TranscriptRevision = { id: string; bookId: string; originalId: string; replacementId: string; createdAt: number };
export type Conversation = {
  partnerId?:string; id:string; bookId:string; title:string; manualTitle:boolean;
  start:number; end:number; createdAt:number; kind?:'reading'|'discussion';
  /** Selection time, independent of publication/reading activity timestamps. */
  lastUsedAt?:number;
  previousConversationId?:string;
  continuationReason?:'user'|'context-compacted'|'restore-pressure'|'context-invalidated';
  context?:{nativeSessionId:string;lastTaskId?:string;previousTaskId?:string};
};
export type PartnerAvatar = {kind:'preset';id:string}|{kind:'image';assetId:string};
export type PartnerAvatarAsset = {id:string;mimeType:'image/png'|'image/jpeg'|'image/webp';dataUrl:string;createdAt:number};
export type PartnerPersonaParameters = {identityBackground?:string;values?:string;thinking?:string;interests?:string;emotions?:string;boundaries?:string;expression?:string};
export type PartnerPreferences = {userAddress?:string;partnerAddress?:string;relationshipRequests?:string;backgroundPersona?:boolean;limitAutomaticRequests?:boolean;persona?:PartnerPersonaParameters;fixedPersona?:Array<keyof PartnerPersonaParameters>};
export type Partner = { legacyUnlabelled?:true; id: string; name: string; traits: string; backgroundBooks: string[]; personaVersionId?:string;templateId?:string;avatar?:PartnerAvatar;preferences?:PartnerPreferences;modelService?:Service };
/** Only explicitly adopted resources belong here; candidates stay outside runtime persona data. */
export type PartnerPersonaExample = {
  readonly id:string;readonly version:string;readonly source:{readonly kind:'fictional'|'external';readonly reference:string};readonly text:string;
  /** Exact accepted persona content. Section bases also capture the effective user dimensions. */
  readonly basis:({readonly text:string;readonly sections?:never}|{readonly sections:readonly {readonly title:string;readonly text:string}[];readonly text?:never})&{readonly parameters?:Readonly<PartnerPersonaParameters>};
};
export type PartnerPersonaTemplate = {id:string;name:string;version:string;text:string;summary?:string;avatar:PartnerAvatar;protectedSections:readonly string[];adoptedExamples?:readonly PartnerPersonaExample[]};
export type PartnerPersonaSource = {kind:'memory'|'chat';id:string;bookId:string;version:string}|{kind:'theme';id:string};
export type PartnerPersonaEdit = {section:string;oldText:string;newText:string};
export type PartnerPersonaRevision = {partnerId:string;baseVersionId:string;edits:PartnerPersonaEdit[];reason:string;sources:PartnerPersonaSource[]};
export type PartnerPersonaVersion = {id:string;partnerId:string;templateId:string;templateVersion:string;previousId?:string;text:string;createdAt:number;reason:string;sources:PartnerPersonaSource[];edits?:PartnerPersonaEdit[];adoptedExamples?:PartnerPersonaExample[]};
/** Captured once per task. A missing version identifies the untouched legacy traits. */
export type PartnerPersonaSnapshot = {partnerId:string;personaVersionId?:string;name:string;text:string;preferences:PartnerPreferences;participation?:'persona'|'none';language?:'zh-CN'|'en';modelService?:Service;adoptedExamples?:PartnerPersonaExample[]};
export type PartnerThemeVersion = {id:string;themeId:string;partnerId:string;previousId?:string;revision:number;title:string;summary:string;text:string;reason:string;sources:PartnerPersonaSource[];createdAt:number;edits?:{oldText:string;newText:string}[];appendText?:string;retired?:true};
export type PartnerThemeRevision = {partnerId:string;themeId?:string;baseVersionId?:string;title?:string;summary?:string;text?:string;edits?:{oldText:string;newText:string}[];appendText?:string;reason:string;sources:PartnerPersonaSource[];retired?:true};
export type PartnerMaintenanceProposal = {persona?:PartnerPersonaRevision;themes?:PartnerThemeRevision[];resolves?:string[]};
export type PartnerMaintenanceCandidate = {id:string;partnerId:string;bookId:string;usageId?:string;proposal:unknown;reason:string;createdAt:number};
export type ModelEffort = 'low' | 'medium' | 'high' | 'max';
export type ModelParameterPatch = Partial<Pick<Service, 'effort' | 'maxOutput' | 'contextLimit'>> & {temperature?:number|null;topP?:number|null};
export type Service = {
  binding?:true;
  id: string; name: string; baseUrl: string; model: string; contextLimit: number;
  effort: ModelEffort; maxOutput: number; enabled: boolean; secretRef: string;
  temperature?:number; topP?:number;
  inputPrice?: number; outputPrice?: number; fallback: boolean;
  thinking?: 'deepseek' | 'none';
  providerCapabilities?: import('./provider-capabilities.ts').ProviderCapabilities;
};
export type ReadingOutputFailure='missing-reading-body'|'invalid-reading-json'|'invalid-reading-fields'|'reading-output-length';
export type ModelOutcome={kind:'invalid-output'|'cap-stop';reason:string;feedbackReason?:ReadingOutputFailure;jsonParseError?:string;lengthRepair?:{model:string;maxOutput:number};reasoningOnlyLength?:{model:string;maxOutput:number}}|{kind:'settlement-pending';reason:string};
/** Safe admission metadata; raw errors, payloads and credentials stay private. */
export interface ModelDispatchFailure {
  category:'budget'|'concurrency'|'lock'|'configuration'|'integrity'|'authentication'|'internal';
  code:string;
  status?:number;
  stage:'configuration-read'|'configuration-validation'|'request-validation'|'ledger-admission'|'ledger-read'|'lock-acquisition'|'lock-release'|'integrity-validation'|'budget-admission'|'ledger-write'|'ledger-transaction'|'receipt-validation';
  errorName?:'Error'|'SyntaxError'|'TypeError'|'RangeError';
  recovery:'condition-change'|'explicit'|'receipt';
  blockerRequestIds?:readonly string[];
}
export type Usage = {
  sceneOpportunity?:SceneOpportunity;
  id: string; time: number; serviceId: string; purpose: string; input: number; output: number;
  estimated: boolean; cost?: number; status: 'reserved' | 'complete' | 'failed' | 'unknown';
  pricing?: { input: number; output: number; currency: 'CNY' };
  costBudgetId?: string;
  taskId?: string;
  reviewMemoryId?: string;
  questionId?:string;
  queryPhase?:'main'|'receipt-repair';
  /** dispatch-started records a local attempt, never provider acceptance. */
  dispatchState?: 'not-dispatched' | 'dispatch-started' | 'response-received';
  dispatchFailure?:ModelDispatchFailure;
  /** Snapshot of the named blockers at rejection, for event-driven recovery. */
  dispatchFailureCondition?:string;
  providerAttempt?: {
    previousRequestId?: string;
    terminal?: import('./provider-capabilities.ts').ProviderTermination;
    receipt?: import('./provider-capabilities.ts').ProviderReceipt;
  };
  dispatchRole?: 'ordinary' | 'explicit-response';
  requestKey?: string;
  /** Core messages/tools identity; provider wire hashes use a separate scheme. */
  coreReadingPayload?:{scheme:'core-reading-messages-tools-v1';hash:string};
  /** One immutable actual maintenance dispatch; its body stays private and cold. */
  maintenanceDispatch?:MaintenanceDispatch;
  /** Stable Harness task and model-attempt identity; never a new spending budget. */
  agentSessionId?:string;
  nativeSessionId?:string;
  taskExecutionId?:string;
  agentCallId?:string;
  /** Settled raw response, retained privately until the Harness has consumed it. */
  agentResponse?:{material?:AgentResponseMaterial;materialRef?:TaskMaterialRef};
  /** Host-certified completed result recovered without a new dispatch. */
  hostQueryReceipt?:{inputHash:string;nativeRequestHash:string;acceptedHash:string;resultHash:string;previousStatus:Usage['status']};
  modelOutcome?:ModelOutcome;
  /** Domain task failure tied to this actual call; provider settlement is unchanged. */
  readingTaskFailure?:{role:'scene';reason:string;kind?:'save-failed'|'source-invalid'|'invalid-output';disposition?:'history'};
  /** Audit only. Loading this record never restores continuation authority. */
  terminatedReadingContinuation?:import('./terminated-reading-continuation.ts').ReadingContinuationAudit;
  elapsedMs?: number;
  modelTools?: readonly string[];
  quoteRequests?: readonly { source: 'missing' | 'invalid' | 'provided'; sourceId?: string; quotedChars?: number }[];
};
export type FactReviewTask = {
  id: string; kind: 'fact-review'; bookId: string; version: string; partnerId: string;
  createdAt: number; updatedAt: number;
  status: 'running' | 'interrupted' | 'complete' | 'cancelled';
  stopReason?: 'user' | 'context-changed' | 'error' | 'restart';
  items: { memoryId: string; status: 'pending' | 'reviewed' | 'skipped'; revisionId?: string; disposition?: 'supported' | 'unsupported';
    /** Frozen on first admission; resuming the same item never resets its calls. */
    reviewBudget?: { transport: 'agent' | 'json'; limit: 4 | 1; usageIds: string[] };
    reviewReady?: { fingerprint: string; result: import('./fact-review.ts').ReviewedFact[]; sources: { id: string; evidence: Evidence }[]; exposure: Evidence[] };
    /** No retained result text after forgetting or failed formation validation. */
    reviewReadyInvalidated?: true;
    /** Coordinates of actually supplied original text; no copied prose or model reasoning. */
    reviewSources?: { fingerprint: string; sources: { id: string; evidence: Evidence }[] } }[];
};
export type Settings = {
  language?:'zh-CN'|'en';
  serviceId: string; services: Service[]; tokenLimit: number; costLimit?: number;
  costBudgetId?: string; costBudgetStartedAt?: number;
  searchEnabled: boolean; searchEndpoint: string; searchSecretRef: string;
  searchProvider?: 'searxng' | 'tavily' | 'exa';
  minReadChars: number; minReactionMs: number; defaultQuiet: boolean;
  readingEffort?: ModelEffort;
};
export type State = {
  /** Fixed archive creation boundary for message visibility; never advanced by reads or new sessions. */
  publicationTrackingStartedAt?:number;
  schema: 1; books: Book[]; memories: Memory[]; chats: Chat[]; conversations: Conversation[];
  partners: Partner[]; partnerId: string; usage: Usage[]; settings: Settings;
  partnerPersonaVersions?:PartnerPersonaVersion[];
  partnerThemes?:PartnerThemeVersion[];
  partnerMaintenanceCandidates?:PartnerMaintenanceCandidate[];
  forgotten: { id: string; bookId: string; text: string; time: number; chatIds?: string[] }[];
  resume?: { bookId: string; conversationId: string; quiet?: boolean };
  transcriptRevisions?: TranscriptRevision[];
  habits?: CommonHabit[];
  tasks?: FactReviewTask[];
  readings?: ReadingRecord[];
  /** Unpublished understanding; never a chat, memory or completed reading range. */
  readingDrafts?: ReadingDraft[];
  /** Same-question retrieval and unpublished results; never a retrieval candidate. */
  queryCheckpoints?: QueryCheckpoint[];
  entityRoots?: EntityRoot[];
  companionWorkspaces?: CompanionWorkspace[];
  companionReadingReceipts?: CompanionReadingReceipt[];
  companionCorrectionRepairs?:CompanionCorrectionRepair[];
  publishedViews?:PublishedView[];
  viewPublications?:ViewPublication[];
  maintenanceJobs?:MaintenanceJob[];
  /** Private resumable agent histories, excluded from UI and retrieval projections. */
  agentSessions?:AgentSessionRecord[];
};
export type AgentSessionMaterial={kind:'agent-session-v1';snapshot:import('./agent-port.ts').AgentSessionSnapshot;material:QueryMaterial;dependencyStamp:string;migrationSource?:import('./agent-port.ts').AgentSessionSnapshot;spillBodies?:AgentSessionSpillBody[];inheritedMaterial?:ReadingDraftMaterial;delegatedResult?:{operation:import('./agent-port.ts').AgentOperation;result:import('./agent-port.ts').AgentDelegatedResult}};
export type DomainOperationReceipt={operation:import('./agent-port.ts').AgentOperation;submissionHash:string;at:number;acceptance:import('./reading-output.ts').ReadingAcceptance<ReadingReply>;readingId?:string;memoryIds?:string[];viewIds?:string[];chatIds?:string[];factReview?:{taskId:string;memoryId:string;result:import('./fact-review.ts').ReviewedFact[];revisionId?:string}};
export type AgentResponseMaterial={kind:'agent-response-v1';response:ModelReply|AgentModelReply;operations?:DomainOperationReceipt[]};
export type AgentSessionRecord={id:string;bookId:string;version:string;partnerId:string;taskKey:string;status:'open'|'complete'|'invalidated';createdAt:number;updatedAt:number;material?:AgentSessionMaterial;materialRef?:TaskMaterialRef;native?:import('./agent-port.ts').NativeSessionReference;nativeImportPending?:true;nativeSessionId?:string;nativeStartEventCount?:number;conversationId?:string;contextRole?:'main'|'branch';inheritedFrom?:{parentSessionId:string;eventCount:number};invalidation?:{reason:'permission'|'correction'|'forgotten'|'source'|'not-dispatched';at:number};previousSessionId?:string;delegation?:import('./agent-port.ts').AgentDelegationRecord};
export type ViewKind='overview'|'current'|'topic'|'arc';
export type PublishedView={formationSources?:FormationSources;writeBaseIds?:string[];scope?:'book'|'partner';id:string;bookId:string;version:string;partnerId:string;kind:ViewKind;key:string;text:string;createdAt:number;previousId?:string;mergePreviousIds?:string[];memorySources:{id:string;hash:string}[];adoptedMemorySources?:{id:string;hash:string}[];reviewedMemorySources?:{id:string;hash:string}[];reviewReason?:string;originalSources:{evidence:Evidence;hash:string}[];viewSources:string[];evidence:Evidence[];contextChatIds:string[];ranges:Range[];chatIds:string[]};
export type ViewPublication={scope?:'book'|'partner';id:string;bookId:string;version:string;partnerId:string;revision:number;viewIds:string[]};
export type ViewProposal={operation?:'publish'|'keep'|'revise';kind:ViewKind;key:string;text?:string;edits?:{oldText:string;newText:string}[];sourceMemoryIds:string[];reviewedMemoryIds?:string[];reviewChanges?:true;replaceSources?:true;reviewReason?:string;dropSourceMemoryIds?:string[];sourceIds?:string[];chatIds?:string[];sourceViewIds?:string[];previousId?:string;mergePreviousIds?:string[]};
export type MaintenanceViewTarget='overview'|'current'|`view:${string}`;
export function isMaintenanceViewTarget(value:unknown):value is MaintenanceViewTarget{return value==='overview'||value==='current'||typeof value==='string'&&value.startsWith('view:')&&value.length>5&&value.length<=133;}
export function canonicalMaintenanceViewTargets(values:readonly MaintenanceViewTarget[]):MaintenanceViewTarget[]{
  if(!Array.isArray(values)||values.some(value=>!isMaintenanceViewTarget(value)))throw Error('维护概要目标身份无效');
  return [...(['overview','current'] as const).filter(kind=>values.includes(kind)),...new Set(values.filter((value):value is `view:${string}`=>value.startsWith('view:')).sort())];
}
export type MaintenanceJob={scope?:'book';id:string;bookId:string;version:string;partnerId:string;origin?:'reading-event';ranges:Range[];viewReviewRanges?:Range[];chatIds:string[];viewTargets?:MaintenanceViewTarget[];sceneRecordIds?:string[];status:'pending'|'running'|'paused'|'blocked';createdAt:number;reason?:string;draftId?:string;pendingDispatch?:{usageId:string};dismissed?:{at:number}};
export type MaintenanceClaim={hash:string;viewReviewVersion?:1;ranges:Range[];viewReviewRanges?:Range[];chatIds:string[];viewTargets:MaintenanceViewTarget[];sceneRecordIds?:string[]};
export type MaintenanceDispatchMaterial={kind:'maintenance-dispatch-v1';material:QueryMaterial;payload:{messages:ModelMessage[];tools:ModelTool[]};terminalResponse?:ModelReply};
export type MaintenanceProcessed={ranges:Range[];chatIds:string[];sceneRecordIds?:string[];viewTargets:MaintenanceViewTarget[];viewReviewRanges?:Range[]};
export type MaintenanceProgressReceipt={operationKey:string;at:number;memoryIds:string[];viewIds:string[];documents?:{index:number;hash:string;memoryId?:string}[];views?:{index:number;hash:string;viewIds:string[]}[];processed:MaintenanceProcessed};
/** committed settles one complete execution; processed is its exact subset.
 * Remaining overview work stays in the same MaintenanceJob. Legacy receipts
 * without processed retain their original whole-claim completion meaning. */
export type MaintenanceDispatch={progress?:MaintenanceProgressReceipt[];payloadScheme:'core-reading-messages-tools-v1';payloadHash:string;request:ReadingDraftRequest;claim:MaintenanceClaim;dependencyStamp:string;material?:MaintenanceDispatchMaterial;materialRef?:TaskMaterialRef;committed?:{at:number;draftId?:string;readingId?:string;memoryIds:string[];viewIds:string[];publicationId?:string;processed?:MaintenanceProcessed}};
export type TerminatedMaintenanceResume={jobId:string;continuation:import('./terminated-reading-continuation.ts').TerminatedReadingContinuation;legacyDispatch?:{dispatch:MaintenanceDispatch;legacyMaterialEvidence:string}};
export type Session = {
  id: string; bookId: string; generation: number; quiet: boolean; active: boolean;
  observing: boolean; observation: number; lastReactionAt: number; prepared: boolean;
  mode: 'reading' | 'discussion';
  /** Next-task selection; each queued job separately copies its scalar profile. Missing is structured. */
  readingStrategy?: ReadingStrategy;
  narrativeMode?: NarrativeMode;
  arcCandidate?: ArcCandidate;
  worldCandidate?: WorldCandidate;
};
export type ModelToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type ModelTool = { name: string; description: string; parameters: Record<string, unknown> };
export type ModelMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: ModelToolCall[]; tool_call_id?: string; reasoning_content?: string };
export type ModelReply = { content: string; input: number; output: number; estimated: boolean; elapsedMs: number;
  providerReceipt?: import('./provider-capabilities.ts').ProviderReceipt;
  /** Untouched terminal carrier for diagnosis/feedback only; partial tools never execute. */
  rawTerminal?:{finishReason:string;message:Record<string,unknown>;usage:Record<string,unknown>;requestPolicy:{model:string;maxOutput:number}};
};
export type AgentModelReply = ModelReply & { requestId?:string; reasoning: string; toolCalls: ModelToolCall[]; finish: 'stop' | 'tool_calls' };
export type ModelRequestIdentity={requestId:string;dispatchRole?:'ordinary'|'explicit-response';onStream?:import('./provider-stream.ts').ModelStreamObserver};
export type ModelPort = {
  tokenBudgetAuthority?:'provider-ledger';
  complete(service: Service, messages: ModelMessage[], signal: AbortSignal, request?: ModelRequestIdentity): Promise<ModelReply>;
  completeTools?(service: Service, messages: ModelMessage[], tools: ModelTool[], signal: AbortSignal, request?: ModelRequestIdentity): Promise<AgentModelReply>;
  /** Read an already completed host receipt. This method never dispatches a model. */
  readQueryReceipt?(requestId:string,receivedResponse?:ModelReply):Promise<QueryHostReceipt>;
  /** Explicitly fence an unresolved local attempt. Never invokes a model. */
  closeReadingAttempt?(input:CloseReadingAttemptInput):Promise<CloseReadingAttemptResult>;
};
export type ReadingAttemptReservation={inputTokens:number;outputTokens:number;totalTokens:number};
export type CloseReadingAttemptInput={requestId:string;serviceId:string;inputHash:string;payload:{messages:ModelMessage[];tools:ModelTool[]};reservation:ReadingAttemptReservation};
export type LocalAttemptFenceIdentity={cohortId:string;protocolSHA:string;closedAt:string;fenceSHA:string};
export type LocalAttemptFenceTermination=LocalAttemptFenceIdentity&{kind:'local-attempt-fence';serviceId:string;providerOutcome:'unknown';terminationEvidence:string;payloadEvidence:string};
export type ReadingAttemptTermination={kind?:never;serviceId:string;hostPayloadHash:string;terminationEvidence:string;payloadEvidence:string}|LocalAttemptFenceTermination;
export type CloseReadingAttemptResult=QueryHostReceipt|{kind:'processing';requestId:string};
export type QueryHostReceipt={requestId:string;inputHash:string;response:ModelReply|AgentModelReply;certificate:{nativeRequestHash:string;acceptedHash:string;resultHash:string;transport?:'subagent-test'};termination?:never;providerTermination?:never;providerReceipt?:never;outcome?:Exclude<ModelOutcome,{kind:'settlement-pending'}>;payload?:{messages:ModelMessage[];tools:ModelTool[]};material?:QueryMaterial;dependencyStamp?:string;legacyMaterialEvidence?:string}|{
 requestId:string;inputHash:string;termination:ReadingAttemptTermination;providerTermination?:never;providerReceipt?:never;response?:never;certificate?:never;outcome?:never;payload?:never;material?:never;dependencyStamp?:never;legacyMaterialEvidence?:never;
}|{
 requestId:string;inputHash:string;providerTermination:import('./provider-capabilities.ts').ProviderTermination;providerReceipt:import('./provider-capabilities.ts').ProviderReceipt;response?:never;certificate?:never;termination?:never;outcome?:never;payload?:never;material?:never;dependencyStamp?:never;legacyMaterialEvidence?:never;
};
export type Store = {
  load(): Promise<State | undefined>; save(state: State): Promise<void>;
  readPartnerAvatar?(id:string):Promise<PartnerAvatarAsset|undefined>;
  writePartnerAvatar?(asset:PartnerAvatarAsset):Promise<void>;
  /** Atomic domain changes, not a diff of an entire State. Bodies are written
   * before their references become visible. Failure preserves the previous head. */
  applyChanges?(changes: StateChangeSet): Promise<void|StorageCommitReceipt>;
  /** Immutable, verified private task bodies. Never exposed through UI snapshots. */
  readTaskMaterials?(refs: readonly TaskMaterialRef[]): Promise<TaskMaterialBody[]>;
  /** Read the authoritative DSH log for an explicit recovery or complete backup. */
  readNativeAgentSession?(reference:import('./agent-port.ts').NativeSessionReference):Promise<import('./agent-port.ts').AgentSessionSnapshot>;
  readNativeConversationCheckpoint?(reference:import('./agent-port.ts').NativeSessionReference):Promise<{summary:string;summarySeq:number}|undefined>;
  readNativeAgentSpills?(reference:import('./agent-port.ts').NativeSessionReference):AsyncIterable<Omit<AgentSessionSpillBody,'text'>&{text:AsyncIterable<string>}>;
  /** Absolute UTF-16 coordinates. Each returned piece must equal the requested
   * range; the immutable version/length are checked before it is used. */
  readBookRanges?(version:string,ranges:readonly Range[]):Promise<BookRangeResult>;
  /** A locator returns candidates only, never reading permission or prose. */
  searchBookText?(version:string,query:BookTextQuery):Promise<BookTextMatches>;
  /** Read and verify explicitly requested immutable prose bodies. */
  readMemoryBodies?(refs: readonly MemoryBodyRef[]): Promise<MemoryBody[]>;
  readMemoryIndex?():Promise<unknown|undefined>;
  writeMemoryIndex?(index:unknown):Promise<void>;
  /** Returns the immutable original after verifying its version hash. */
  readBookText?(version: string): Promise<string>;
  retainBookTexts?(books: readonly Book[]): void;
};
export type BookRangeResult={version:string;length:number;pieces:(Range&{text:string;hash:string})[]};
export type BookTextQuery={query:string;ranges:Range[];mode:'literal'|'normalized';limit:number;cursor?:string};
export type BookTextMatches={version:string;ranges:Range[];exhausted:boolean;nextCursor?:string};
export type TaskMaterialRef={key:string;hash:string;bytes:number};
/** Storage-only event segments; domain readers receive a complete native snapshot. */
export type AgentSessionEventChunk={kind:'agent-session-events-v1';sessionId:string;start:number;events:unknown[];previous?:TaskMaterialRef};
export type AgentSessionManifest={kind:'agent-session-manifest-v1';header:unknown;eventCount:number;tail?:TaskMaterialRef;sources:TaskMaterialRef;dependencyStamp:string;migrationSourceRef?:TaskMaterialRef;spillBodyRefs?:TaskMaterialRef[];inheritedMaterialRef?:TaskMaterialRef;delegatedResult?:AgentSessionMaterial['delegatedResult']};
export type AgentSessionMigrationSource={kind:'agent-session-migration-source-v1';snapshot:import('./agent-port.ts').AgentSessionSnapshot};
export type AgentSessionSpillBody={kind:'agent-session-spill-v1';locator:string;hash:string;bytes:number;text:string};
export type TaskMaterialBody={key:string;hash:string;value:ReadingDraftMaterial|QueryMaterial|MaintenanceDispatchMaterial|AgentSessionMaterial|AgentResponseMaterial|AgentSessionEventChunk|AgentSessionManifest|AgentSessionMigrationSource|AgentSessionSpillBody};
export type StoredCollectionRecord<K extends StateCollection>=K extends 'readingDrafts'|'companionReadingReceipts'|'agentSessions'
  ?Omit<StateCollectionRecord<K>,'material'>&{materialRef:TaskMaterialRef}
  :K extends 'queryCheckpoints'?Omit<QueryCheckpoint,'material'|'pendingReceipt'>&{materialRef?:TaskMaterialRef;pendingReceipt?:Omit<NonNullable<QueryCheckpoint['pendingReceipt']>,'material'>&{materialRef:TaskMaterialRef}}
  :K extends 'usage'?Omit<Usage,'maintenanceDispatch'|'agentResponse'>&{maintenanceDispatch?:Omit<MaintenanceDispatch,'material'>&{materialRef:TaskMaterialRef};agentResponse?:{materialRef:TaskMaterialRef}}
  :StateCollectionRecord<K>;
export type StoredStateChangeSet=Omit<StateChangeSet,'collections'>&{collections:{[K in StateCollection]?:{put?:StoredCollectionRecord<K>[];remove?:string[]}}};
/** Returned only after the authoritative transaction committed these refs. */
export type StorageCommitReceipt={id:string;collections:StoredStateChangeSet['collections']};
export const stateCollections=['books','memories','chats','conversations','partners','partnerPersonaVersions','partnerThemes','partnerMaintenanceCandidates','usage','forgotten','transcriptRevisions','habits','tasks','readings','readingDrafts','queryCheckpoints','entityRoots','companionWorkspaces','companionReadingReceipts','companionCorrectionRepairs','publishedViews','viewPublications','maintenanceJobs','agentSessions'] as const;
export type StateCollection=typeof stateCollections[number];
export type StateCollectionRecord<K extends StateCollection>=NonNullable<State[K]>[number];
export type StateChangeSet={
  id:string;
  collections:{[K in StateCollection]?:{put?:StateCollectionRecord<K>[];remove?:string[]}};
  set?:Pick<Partial<State>,'partnerId'|'settings'|'resume'>;
  unset?:'resume'[];
  memoryBodies?:MemoryBody[];
  taskMaterials?:TaskMaterialBody[];
};
/** Collection storage key; workspaces have a composite identity, other records
 * carry stable IDs. All adapters share this definition. */
export function stateRecordKey(collection:StateCollection,value:StateCollectionRecord<StateCollection>):string {
  if(collection==='companionWorkspaces'){
    const w=value as CompanionWorkspace;return JSON.stringify([w.bookId,w.version,w.partnerId,w.source]);
  }
  return (value as {id:string}).id;
}
export type Understanding = WorldNote & SemanticNoteProposal & { scope?:'book'|'partner'; kind: Exclude<MemoryKind,'context'|'stage'|'state'|'arc'>; text: string; organization?:import('./document-organization.ts').DocumentOrganization; documentTitle?:string; navigationCues?:string[]; knowledgeDistribution?:import('./knowledge-distribution.ts').KnowledgeDistribution; documentOperation?:DocumentOperation;replacementIds?:string[];edits?:DocumentEdit[];appendText?:string; basis?: MemoryBasis; updates?: string; mergePreviousIds?:string[]; updateReason?: string; answersPartOf?: string; quote?: string; quoteSource?: string; sourceIds?: string[]; narrative?: NarrativeNote };
export type MemoryQuery = { query?: string; kind?: MemoryKind; offset?: number; chapterIndex?: number; ids?:string[]; entityIds?:string[];relations?:true;worldView?:'current'|'history';stateView?: 'current' | 'history'; arcView?:'current'|'history'; view?: 'index' | 'full' };
export type OriginalHistoryQuery = { query:string; range?:Range; order?:'source-asc'|'source-desc'|'relevance'; cursor?:string };
export function parseOriginalHistoryQuery(value:unknown):OriginalHistoryQuery {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('历史原文查询参数无效');
  const v=value as Record<string,unknown>,r=v.range as Range|undefined;
  if(Object.keys(v).some(k=>!['query','range','order','cursor'].includes(k))||typeof v.query!=='string'||!v.query.trim()||v.query.length>160||v.order!==undefined&&!['source-asc','source-desc','relevance'].includes(v.order as string)||v.cursor!==undefined&&(typeof v.cursor!=='string'||v.cursor.length>50000)||r!==undefined&&(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).some(k=>!['start','end'].includes(k))||!Number.isSafeInteger(r.start)||!Number.isSafeInteger(r.end)||r.start<0||r.end<=r.start))throw Error('历史原文查询参数无效');
  return {query:v.query.trim(),...(r?{range:{start:r.start,end:r.end}}:{}),...(v.order?{order:v.order as OriginalHistoryQuery['order']}:{}),...(v.cursor?{cursor:v.cursor as string}:{})};
}
export type OpinionIndexNavigation={currentUnderstanding?:Pick<Memory,'id'|'text'>};
export type OrdinaryMemoryIndex={id:string;kind:MemoryKind;readingStage?:Range[];history?:true;origin?:'background';currentAlreadyProvided?:true;match?:{textStart:number;textEnd:number;text:string}};
export type DiscussionQuery = { query?: string; offset?: number; chatId?: string; textStart?: number };
export type ReadingReply = { partnerMaintenance?:PartnerMaintenanceProposal; partnerMaintenanceIssue?:{reason:string;proposal:unknown}; quiet?:true; sceneInsight?:SceneInsight; views?:ViewProposal[]; paragraphComments?:import('./paragraph-comments.ts').ParagraphCommentProposal[]; reaction?:import('./paragraph-comments.ts').ReadingExpression; reply: string; thoughts: Understanding[]; wantsLong: boolean; workspace?: { understanding?: string; focus?: string[]; working?:string[] }; readingBrief?: string; stageNarrative?: StageNarrativeReply; stateUpdates?: StateUpdate[]; arcUpdates?:ArcUpdate[];entityRoots?:EntityRootProposal[]; search?: string; lookup?: string; lookupHistory?:OriginalHistoryQuery; recall?: MemoryQuery; history?: DiscussionQuery; read?: Range; readPage?: string; title?: string; replyBasis?: MemoryBasis; reinforce?: string[] };
export type ReadingDraftRequest = { source: ReadingRecord['source']; ranges: Range[]; input: string; resumeId?: string; correctionRepairId?:string;maintenanceJobId?:string;maintenanceClaim?:string;sceneCommentIds?:string[];sceneOpportunity?:SceneOpportunity };
export type ReadingDraftMaterial = {
  /** Real published/user messages actually supplied, independent of maintenance. */
  conversationInputChatIds?:string[];
  /** Stable old p-label coordinates, without copying their original bodies. */
  conversationPassageRefs?:Array<[string,Evidence]>;
  /** Exact stable instructions captured by this task, restored with its persona. */
  systemMessages?:ModelMessage[];
  partnerPersona?:PartnerPersonaSnapshot;
  partnerThemeVersionIds?:string[];
  partnerThemeReadIds?:string[];
  partnerMaintenanceCandidateIds?:string[];
  documentCandidate?:import('./reading-candidate.ts').ReadingDocumentCandidate;
  /** Receipt metadata for the actual dispatched surface; no copied request bodies. */
  exposures?:import('./material-projection.ts').MaterialExposureReceipt[];
  /** Indirect sources of a received child conclusion. These grant no full-body
   * exposure or document-update permission to the parent task. */
  delegatedSources?:{agentSessionId:string;resultRef:string;memoryIds:string[];viewIds:string[];chatIds:string[];originalRanges:Range[]}[];
  taskRole?:'scene'|'maintenance';
  sceneCommentIds?:string[];
  sceneOpportunity?:SceneOpportunity;
  sceneRecordIds?:string[];
  sceneOrigin?:{instanceId:string;sessionId:string;generation:number;dialogueRevision:number};
  viewIds?:string[];
  maintenanceJobId?:string;
  maintenanceViewTargets?:MaintenanceViewTarget[];
  maintenanceReviewRanges?:Range[];
  maintenanceReviewMemoryIds?:string[];
  /** New bounded source batches; absent legacy material keeps whole-target semantics. */
  maintenanceReviewBatch?:true;
  partialMemoryIds?:string[];
  expressionContract?:'paragraph-expressions-v1';
  historicalCommentIds?:string[];
  correctionRepairId?:string;
  /** Workspace version at formation; restored drafts cannot publish over a newer handoff. */
  workspaceRevision?: number;
  workspaceSnapshot?:CompanionWorkspace;
  workspaceVersion?: WorkspaceVersion;
  workspaceSource?: CompanionWorkspace['source'];
  /** Full records explicitly supplied as immutable history, never update targets. */
  historicalSourceIds?: string[];
  /** New structural attribution stamps; missing keeps every old draft stamp exact. */
  basisStampVersion?:1;
  /** Body identity is independent of its current residency or storage key. */
  sourceStampVersion?:2;
  dependencyStampVersion?:3;
  messages: ModelMessage[]; refs: Evidence[]; originalRanges: Range[];
  /** Core task mode, preserved across switches; old drafts use legacy semantics. */
  narrativeMode?: NarrativeMode;
  arcCandidate?: ArcCandidate;
  worldCandidate?: WorldCandidate;
  analysisTask?:true;
  /** Core write protocol captured at formation; old drafts use version 1. */
  stateWriteVersion?: StateWriteVersion;
  /** Captured task strategy; absent old drafts must remain structured. */
  readingStrategy?: ReadingStrategy;
  outputProtocol?:'reading-text-v1'|'reading-documents-v1';
  /** Explicit non-quiet reading reaction allowance at original formation. */
  outputReactionAllowed?:true;
  memoryIds: string[]; chatIds: string[]; habitIds: string[];
  passages: [string, NonNullable<Memory['sourceQuote']>][];
};
export type ReadingDraft = ReadingDraftRequest & {
  materialRef?:TaskMaterialRef;
  blockedReason?:string;
  delivery?:ReadingDelivery;
  id: string; bookId: string; version: string; partnerId: string; createdAt: number;
  /** Exact replaced raw candidates consumed with this draft; no range-based inference. */
  supersededReceiptIds?:string[];
  result: ReadingReply; webSources: WebReference[]; material: ReadingDraftMaterial;
  dependencyStamp: string; association: 'pending' | 'ready';
  /** One bounded continuation of a returned draft after a genuine workspace conflict. */
  continuation?: {status:'pending'|'requested'|'received'|'blocked';targetRevision:number;targetVersion:WorkspaceVersion;usageId?:string;reason?:string};
};
export type QueryAcquisition =
  | {kind:'original';evidence:Evidence}
  | {kind:'memory';id:string;memoryKind:MemoryKind;view:'full'|'index'|'partial';history?:boolean;stamp:string;indexQuery?:string}
  | {kind:'chat';id:string;textStart:number;textEnd:number;stamp:string};
export type QueryMaterial = Omit<ReadingDraftMaterial,'messages'> & {
  replyStyle?:import('./reply-delivery.ts').ReplyStyle;
  deferWorkspace?:true;
  deferWorkspaceRepairId?:string;
  references:Record<'memory'|'chat'|'habit'|'part'|'entity',[string,string][]>;
  webSources:WebReference[];
  ranges:Range[];readUrls:string[];
  /** Domain user materials only; no system policy, reasoning or Harness history. */
  messages:ModelMessage[];
  pendingHabits?:{added:CommonHabit[];retired:{id:string;by:string}[];ids:string[]};
  habitInputStamp?:string;
  partialMemoryIds?:string[];
  answerScope?:'overview'|'focused';
  answerPreparation?:{aspects:{need:string;memoryIds:string[];sourceIds:string[];unavailableIds:string[]}[]};
};
/** A returned candidate retained before task interruption, never internal reasoning. */
export type CompanionReadingReceipt = {
  materialRef?:TaskMaterialRef;
  id:string; requestKey:string; bookId:string; version:string; partnerId:string;
  /** Explicit prior final candidate in this exact Harness task; never range inference. */
  supersedesId?:string;
  request:ReadingDraftRequest; material:QueryMaterial; dependencyStamp:string;
  candidate:{transport:'agent'|'json';format:'submit'|'content'|'reading-text';text:string;finalText?:string;proposal?:string;reaction?:string};
  status:'received'|'blocked'; createdAt:number; blockedReason?:string;
};
export type QueryCheckpoint = {
  messageEmojiReactionReceipts?:{targetId:string;emoji:string;active:boolean}[];
  materialRef?:TaskMaterialRef;
  id:string;
  questionId:string;bookId:string;version:string;partnerId:string;questionStamp:string;
  status:'acquired'|'received'|'ready'|'consumed';usageIds:string[];acquired:QueryAcquisition[];
  candidate?:{format:'submit'|'content';text:string;finalText?:string;transport:'agent'|'json';phase:'main'|'receipt-repair'};material?:QueryMaterial;dependencyStamp?:string;
  result?:ReadingReply;replyId?:string;
  committedMemoryIds?:string[];
  blockedReason?:string;
  limits?:{main:4|6|'host-admitted';'receipt-repair':1|2|'host-admitted'};
  /** The exact unresolved dispatch snapshot; replaced only by the next request. */
  pendingReceipt?:{usageId:string;phase:'main'|'receipt-repair';payloadHash:string;material:QueryMaterial;materialRef?:TaskMaterialRef;dependencyStamp:string};
};
