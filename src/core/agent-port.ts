import type { AgentModelReply, ModelMessage, ModelTool, Service, ModelOutcome } from './types.ts';
import type {MaterialExposureReceipt} from './material-projection.ts';

export type AgentSessionSnapshot = { header: unknown; events: unknown[] };
export type NativeCallLink={agentCallId:string;ordinal:number;boundarySeq:number;resultSeq?:number;requestId?:string;purpose?:string;taskExecutionId?:string;notDispatched?:true;terminalNoResult?:true};
export type NativeFeedbackLink={requestId:string;messageId:string};
/** Official JSONL writes the optional root delegation depth as 0. All other
 * metadata remains exact; property ordering is not an identity field. */
export function nativeSessionHeadersEqual(left:unknown,right:unknown):boolean{
  const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value;
  const header=(value:unknown)=>value&&typeof value==='object'?{...value,delegationDepth:(value as {delegationDepth?:number}).delegationDepth??0}:value;
  return JSON.stringify(canonical(header(left)))===JSON.stringify(canonical(header(right)));
}
export type NativeSessionReference={kind:'dsh-native-session-v1';backend:'jsonl';sessionId:string;formatVersion:4;header:unknown;eventCount:number;closedEventCount?:number;spills?:{locator:string;storageLocator?:string;sourceSessionId?:string;hash:string;bytes:number;callId:string;toolName:string}[];relocations?:{sourceHeader:unknown;sourceEventCount:number;sourceSnapshotHash:string;targetSnapshotHash:string;projectDirectory:string;reason:'book-project-relocation-v1'}[];calls:NativeCallLink[];feedbacks:NativeFeedbackLink[];migration?:{sourceSnapshotHash:string;nativeSnapshotHash:string;sourceEventCount:number;eventSeqMap:(number|null)[];headerMapping?:{sourceCwd?:string;projectDirectory:string;reason:'book-project-v1'}}};
/** The caller atomically saves this native event prefix together with its
 * domain material. An append must compare expectedCount and never rewrite. */
export type AgentSessionStore = {
  load(id: string): Promise<AgentSessionSnapshot | undefined>;
  create(id: string, snapshot: AgentSessionSnapshot): Promise<void>;
  append(id: string, expectedCount: number, events: unknown[]): Promise<void>;
  loadNative?():Promise<NativeSessionReference|undefined>;
  saveNative?(reference:NativeSessionReference):Promise<void>;
};
export type AgentSessionRecovery = { requestId: string; agentCallId?: string; response: AgentModelReply; outcome?: Exclude<ModelOutcome, { kind: 'settlement-pending' }> };
export type AgentRecoveryAuthorization = { kind: 'explicit-resume' | 'program-repair'; id: string };
export type AgentRunSession = { id: string; mode: 'create' | 'resume' | 'bootstrap'; store: AgentSessionStore; recovery?: AgentSessionRecovery; instruction?: string;
  /** Physical DSH context can outlive this independent domain execution. */
  nativeId?:string;
  /** Exact completed prefix inherited by this execution; legacy tasks start at zero. */
  startEventCount?:number;
  /** A new execution appends its current material even when its native context resumes. */
  appendInput?:boolean;
  /** New business turn over a confirmed completed conversation only. Retire
   * old task bodies from the model surface while preserving exact dialogue. */
  projectCompletedConversation?:true;
  /** An explicit host authorization, not progress and never minted by automatic retries. */
  recoveryAuthorization?: AgentRecoveryAuthorization;
  /** Only the host usage ledger can prove an intent never reached dispatch. */
  requestState?(agentCallId:string):Promise<'not-dispatched'|'terminal-no-result'|'unresolved'>;
};
export type AgentRequestContext = { agentSessionId: string; agentCallId: string;taskExecutionId?:string;nativeSessionId?:string;
  /** The actual Harness call, including auxiliary calls; the ledger must honor these values. */
  purpose?: string; model?: string; reasoningEffort?: string; maxTokens?: number;
  /** Private live transport only; complete receipt remains the commit authority. */
  onStream?:import('./provider-stream.ts').ModelStreamObserver;
};
export type AgentOperation = { agentSessionId: string; agentCallId: string;taskExecutionId?:string;nativeSessionId?:string; requestId?: string; toolCallId?: string; key: string };
export type AgentRuntimeContext = { name: string; text: string; required?: boolean };
export type AgentTask={id:string;role:'companion'|'maintenance'|'review'|'preparation';presetId:string};
export type AgentDelegatedResult={conclusion:string;resultRef:string;ranges?:{start:number;end:number}[];sourceRefs?:{kind:string;id:string;version?:string}[]};
export type AgentDelegationDependency={childSessionId:string;resultRef:string};
export type AgentDelegationRecord={parentSessionId:string;operationKey:string;prompt:string;label:string;delivery:'caller'|'parent';context?:'fresh'|'inherit-completed';presetId?:string;inheritedPresetId?:string;dependencies?:AgentDelegationDependency[];authority:{ranges:{start:number;end:number}[]};authorizedService?:Pick<Service,'id'|'baseUrl'|'model'|'effort'|'contextLimit'|'maxOutput'|'thinking'>;acceptedMessageId?:string;status:'prepared'|'accepted'|'result-received'|'complete'|'failed'|'unknown';resultRef?:string;stopReason?:string};
export type AgentDelegationRequest={operation:AgentOperation;itemKey?:string;parentSessionId:string;childSessionId:string;prompt:string;label:string;delivery:'caller'|'parent';context?:'fresh'|'inherit-completed';presetId?:string;inheritedPresetId?:string;dependencies?:AgentDelegationDependency[]};
export type AgentDelegationPort={
  authorizeInheritance?(input:{operation:AgentOperation;parentSessionId:string;eventCount:number}):Promise<void>;
  list():Promise<{childSessionId:string;record:AgentDelegationRecord;inheritedFrom?:{parentSessionId:string;eventCount:number};result?:AgentDelegatedResult}[]>;
  lookup(operation:AgentOperation,itemKey?:string):Promise<{childSessionId:string;record:AgentDelegationRecord;inheritedFrom?:{parentSessionId:string;eventCount:number};result?:AgentDelegatedResult}|undefined>;
  read(childSessionId:string):Promise<{record:AgentDelegationRecord;inheritedFrom?:{parentSessionId:string;eventCount:number};result?:AgentDelegatedResult}|undefined>;
  prepare(request:AgentDelegationRequest):Promise<AgentRunRequest<AgentDelegatedResult>>;
  load(childSessionId:string):Promise<AgentRunRequest<AgentDelegatedResult>|undefined>;
  accepted(request:AgentDelegationRequest,messageId:string):Promise<void>;
  settle(request:AgentDelegationRequest,outcome:{stopReason:string;result?:AgentDelegatedResult}):Promise<void>;
};

/** Shared with receipt recovery: only complete the existing final object brace. */
export function completeSubmitObject(raw:string):string{
  try{JSON.parse(raw);return raw;}catch{}
  const value=raw.trim();if(!value.startsWith('{')||!/[\]}]$/u.test(value))return raw;
  try{const parsed=JSON.parse(value+'}');return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?value+'}':raw;}catch{return raw;}
}

export type AgentModelRequest = {
  service: Service; signal: AbortSignal;
  assertCurrent(): void;
  request(messages: ModelMessage[], tools: ModelTool[], signal: AbortSignal, context?: AgentRequestContext): Promise<AgentModelReply>;
};
/** Only private, immutable candidates cross the parallel dispatch boundary.
 * apply runs in the official model-ordered post-execute phase and must recheck
 * current authority before changing references, source registries or storage.
 * Returning a body here does not acknowledge actual model exposure. */
export type AgentReadTool = {
  isConcurrencySafe(args: unknown): boolean;
  prepare(args: unknown, signal: AbortSignal): Promise<unknown>;
  apply(candidate: unknown, signal: AbortSignal): Promise<unknown>;
};
export type AgentTool = ModelTool & { execute(args: unknown, signal: AbortSignal): Promise<unknown>; read?: AgentReadTool };
export type AgentRunRequest<T> = AgentModelRequest & {
  /** Stable domain progress only: acquired versions, accepted results and write heads.
   * Exclude rejected candidates, requests, clocks, reasoning, repeated reads and planning-only state. */
  recoveryProgress?(): string;
  /** The domain identifies local material/storage faults. Model argument errors
   * remain ordinary tool feedback; local faults must not trigger a paid repair. */
  isLocalToolFailure?(error: unknown): boolean;
  task?:AgentTask;
  delegation?:AgentDelegationPort;
  /** The domain's durable commit is inside the real native tool execution. */
  commit?(value:T,operation:AgentOperation):Promise<T>;
  recoverCommit?(operation:AgentOperation):Promise<T|undefined>;
  /** Current agent working folder, selected by the host for this book. */
  projectDirectory?: string;
  /** Stable native log/workspace and spill ownership; defaults to projectDirectory.
   * Moving the working folder never rewrites an existing native session header. */
  sessionDirectory?: string;
  runtimeContext?: () => AgentRuntimeContext[];
  /** Observes the actual dispatched surface; never changes or mirrors the request. */
  materialExposure?: {acknowledge(receipt:MaterialExposureReceipt,visible:{messages:readonly ModelMessage[]}):Promise<void>;
    /** Ephemeral current native projection, only for deciding whether a read must
     * return a body again. This never grants or revokes a paid call's sources. */
    current?(visible:{messages:readonly ModelMessage[]}):void|Promise<void>};
  session?: AgentRunSession;
  lengthRecovery?:'maintenance';
  /** host-admitted delegates every dispatch to the host request port's batch budget. */
  messages: ModelMessage[]; tools: AgentTool[]; maxCalls: number|'host-admitted';
  /** Exact original transport history plus the explicit resumption instruction. */
  resumePayload?:{messages:ModelMessage[];tools:ModelTool[]};
  /** Reserve the last allowed call for a user-facing answer, with acquired history intact. */
  answerBudget?: { instruction: string; allowSubmit: boolean };
  /** A domain-specific material-selection step within the same task and call
   * budget. Once its tool completes, the ordinary response tools are exposed. */
  preparation?: { toolName:string; ready():boolean; instruction:string };
  acceptJsonFinal?: boolean;
  /** Domain opt-in for tasks that do not need structured state changes. */
  parseTextFinal?: (text: string) => T|Promise<T>;
  /** The domain decides which returned channel is its final result. Raw submit
   * arguments remain available when the explicit proposal cannot be applied. */
  finalizeSubmission?: (text:string, submission?:T, rawSubmission?:string) => T|Promise<T>;
  /** Independent reading body; a same-response structural proposal is optional. */
  readingExit?: ModelTool & { allowProposal:boolean; reaction?:ModelTool; validate(args:unknown):void; parse(args:unknown, proposal?:string, reaction?:string):T|Promise<T>;
    /** One domain acceptance for settled reading carriers; transport never publishes. */
    accept?(submission:import('./reading-output.ts').ReadingSubmission, operation?:AgentOperation):Promise<import('./reading-output.ts').ReadingAcceptance<T>>;
    /** Read the exact durable operation receipt before repeating a side effect. */
    recover?(operation:AgentOperation):Promise<import('./reading-output.ts').ReadingAcceptance<T>|undefined>;
    /** Legacy reading only: independently validate an explicit readingBrief in
     * untouched, complete lone submit arguments. No body returns undefined. */
    parseLegacySubmit?(raw:string):T|undefined|Promise<T|undefined> };
  submit: ModelTool & { parse(args: unknown): T|Promise<T> };
};
/** The shared runtime proposes results. Domain tools and durable commits remain in the core. */
export interface AgentRunner { run<T>(input: AgentRunRequest<T>): Promise<T>;
  /** Explicit authority/persona-context retirement releases any live DSH lease.
   * Ordinary turn completion and reading pause keep a continuing conversation. */
  retireSession?(nativeSessionId:string):Promise<void>;
}
