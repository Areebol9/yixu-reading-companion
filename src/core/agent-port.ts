import type { AgentModelReply, ModelMessage, ModelTool, Service } from './types.ts';

/** Shared with receipt recovery: only complete the existing final object brace. */
export function completeSubmitObject(raw:string):string{
  try{JSON.parse(raw);return raw;}catch{}
  const value=raw.trim();if(!value.startsWith('{')||!/[\]}]$/u.test(value))return raw;
  try{const parsed=JSON.parse(value+'}');return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?value+'}':raw;}catch{return raw;}
}

export type AgentModelRequest = {
  service: Service; signal: AbortSignal;
  assertCurrent(): void;
  request(messages: ModelMessage[], tools: ModelTool[], signal: AbortSignal): Promise<AgentModelReply>;
};
export type AgentTool = ModelTool & { execute(args: unknown, signal: AbortSignal): Promise<unknown> };
export type AgentRunRequest<T> = AgentModelRequest & {
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
  parseTextFinal?: (text: string) => T;
  /** The domain decides which returned channel is its final result. Raw submit
   * arguments remain available when the explicit proposal cannot be applied. */
  finalizeSubmission?: (text:string, submission?:T, rawSubmission?:string) => T;
  /** Independent reading body; a same-response structural proposal is optional. */
  readingExit?: ModelTool & { allowProposal:boolean; reaction?:ModelTool; validate(args:unknown):void; parse(args:unknown, proposal?:string, reaction?:string):T;
    /** One domain acceptance for settled reading carriers; transport never publishes. */
    accept?(submission:import('./reading-output.ts').ReadingSubmission):Promise<import('./reading-output.ts').ReadingAcceptance<T>>;
    /** Legacy reading only: independently validate an explicit readingBrief in
     * untouched, complete lone submit arguments. No body returns undefined. */
    parseLegacySubmit?(raw:string):T|undefined };
  submit: ModelTool & { parse(args: unknown): T };
};
/** The shared runtime proposes results. Domain tools and durable commits remain in the core. */
export interface AgentRunner { run<T>(input: AgentRunRequest<T>): Promise<T>; }
