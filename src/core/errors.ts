import type {ModelReply} from './types.ts';

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
  constructor(message: string, dispatch: 'not-dispatched' | 'unknown', options: { retryable?: boolean; usageId?: string; responseUsage?: { input: number; output: number }; responseReceived?: boolean } = {}) {
    super(message); this.name = 'ModelRequestError'; this.dispatch = dispatch;
    this.retryable = dispatch === 'not-dispatched' && options.retryable === true;
    this.usageId = options.usageId; this.responseUsage = options.responseUsage; this.responseReceived = options.responseReceived === true;
  }
}
export function canRecoverModelRequest(error: unknown): boolean {
  return error instanceof TransientServiceError || error instanceof ModelRequestError && error.retryable;
}
export function modelEnvelopeError(response: { error?: string; dispatch?: string; retryable?: boolean; requestId?: string }): Error {
  if (response.dispatch === 'not-dispatched') return new ModelRequestError(response.error ?? '模型请求未发出，请检查本地服务配置', 'not-dispatched', { retryable: response.retryable, usageId: response.requestId });
  return new ModelRequestError('模型请求的结果或结算尚未确定，已停止自动重问；原问题、材料和用量记录已保留', 'unknown', { usageId: response.requestId });
}
