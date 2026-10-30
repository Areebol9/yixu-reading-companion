import type {ModelReply,ModelDispatchFailure} from './types.ts';
import type {ProviderReceipt,ProviderTermination} from './provider-capabilities.ts';

/** A complete native result exists; only its local durable settlement failed. */
export class ModelReceiptSaveError extends Error {
  readonly kind='settlement-pending';
  readonly response:ModelReply;
  constructor(message:string,response:ModelReply){super(message);this.name='ModelReceiptSaveError';this.response=response;}
}

/** Transport/service failures that can recover without changing permissions or configuration. */
export class TransientServiceError extends Error {
  constructor(message: string) { super(message); this.name = 'TransientServiceError'; }
}

/** Only the transport can prove that an upstream request was never started. */
export class ModelRequestError extends Error {
  dispatch: 'not-dispatched' | 'unknown';
  retryable: boolean;
  usageId?: string;
  responseUsage?: { input: number; output: number };
  responseReceived: boolean;
  failure?:ModelDispatchFailure;
  constructor(message: string, dispatch: 'not-dispatched' | 'unknown', options: { retryable?: boolean; usageId?: string; responseUsage?: { input: number; output: number }; responseReceived?: boolean; failure?:ModelDispatchFailure } = {}) {
    super(message); this.name = 'ModelRequestError'; this.dispatch = dispatch;
    this.retryable = dispatch === 'not-dispatched' && options.retryable === true;
    this.usageId = options.usageId; this.responseUsage = options.responseUsage; this.responseReceived = options.responseReceived === true;
    this.failure=options.failure;
  }
}
/** Provider rejection proves no result is pending, but never proves free usage. */
export class ProviderTerminalError extends ModelRequestError {
  constructor(message:string,readonly termination:ProviderTermination,readonly receipt:ProviderReceipt,responseUsage?:{input:number;output:number}){
    super(message,'unknown',{usageId:termination.requestId,responseUsage,responseReceived:true});this.name='ProviderTerminalError';
  }
}
export function canRecoverModelRequest(error: unknown): boolean {
  return error instanceof TransientServiceError || error instanceof ModelRequestError && error.retryable;
}
export function modelEnvelopeError(response: { error?: string; dispatch?: string; retryable?: boolean; requestId?: string; failure?:ModelDispatchFailure }): Error {
  const value=response.failure;
  const failure=value&&['budget','concurrency','lock','configuration','integrity','authentication','internal'].includes(value.category)&&/^[A-Z][A-Z0-9_]{0,63}$/.test(value.code)&&['configuration-read','configuration-validation','request-validation','ledger-admission','ledger-read','lock-acquisition','lock-release','integrity-validation','budget-admission','ledger-write','ledger-transaction','receipt-validation'].includes(value.stage)&&['condition-change','explicit','receipt'].includes(value.recovery)?{category:value.category,code:value.code,stage:value.stage,recovery:value.recovery,...(value.errorName&&['Error','SyntaxError','TypeError','RangeError'].includes(value.errorName)?{errorName:value.errorName}:{}),...(Number.isInteger(value.status)&&value.status!>=400&&value.status!<=599?{status:value.status}:{}),...(Array.isArray(value.blockerRequestIds)?{blockerRequestIds:value.blockerRequestIds.filter(id=>typeof id==='string'&&/^[0-9a-f-]{36}$/i.test(id))}:{})}:undefined;
  if (response.dispatch === 'not-dispatched') return new ModelRequestError(response.error ?? '模型请求未发出，原任务已保留', 'not-dispatched', { retryable: failure?false:response.retryable, usageId: response.requestId, failure });
  return new ModelRequestError('模型请求的结果或结算尚未确定，已停止自动重问；原问题、材料和用量记录已保留', 'unknown', { usageId: response.requestId });
}
