import type {Service} from './types.ts';

export type ProviderCapabilities={
  version:'provider-capabilities-v1';
  transport:'native-http'|'cli-text';
  provider:'deepseek'|'openai-compatible'|'local-cli';
  nativeTools:boolean;
  schema:'json-schema'|'deepseek-strict';
  strict:boolean;
  reasoningContinuation:'required'|'optional'|'unsupported';
  /** Declared provider capability, or a CLI request contract when contract-only.
   * Neither changes the authorized service.maxOutput for an existing run. */
  outputLimit:{kind:'provider-max-tokens'|'contract-only';maxTokens:number};
  /** Legacy wire name for local conservative reservations, not measured context usage. */
  contextAccounting:'utf8-conservative';
  evidence:readonly string[];
};
export type ProviderSchemaReceipt={version:'tool-schema-v1';businessDigest:string;compiledDigest:string};
export type ProviderReceipt={
  version:'provider-receipt-v1';status:number;body:Record<string,unknown>;
  bodyEncoding:'wire-utf8'|'derived-json';rawBody?:string;rawBodyHash?:string;
  responseId?:string;finishReason?:string;usage?:Record<string,unknown>;
  capability?:ProviderCapabilities;schema?:ProviderSchemaReceipt;
};
/** A complete response from the direct provider, not a proxy's guessed error. */
export type ProviderTermination={
  version:'provider-termination-v1';kind:'provider-rejected';requestId:string;
  provider:'deepseek';status:429|503;responseHash:string;endedAt:number;
  endpoint:string;retryAfterMs?:number;noResult:true;
};

export function validateProviderCapabilities(value:ProviderCapabilities,service?:Pick<Service,'baseUrl'|'maxOutput'>):void{
  if(!value||value.version!=='provider-capabilities-v1'||!['native-http','cli-text'].includes(value.transport)||!['deepseek','openai-compatible','local-cli'].includes(value.provider)||typeof value.nativeTools!=='boolean'||!['json-schema','deepseek-strict'].includes(value.schema)||typeof value.strict!=='boolean'||!['required','optional','unsupported'].includes(value.reasoningContinuation)||value.contextAccounting!=='utf8-conservative'||!Array.isArray(value.evidence)||!value.evidence.length||value.evidence.some(item=>typeof item!=='string'||!item.trim())||!value.outputLimit||!['provider-max-tokens','contract-only'].includes(value.outputLimit.kind)||!Number.isSafeInteger(value.outputLimit.maxTokens)||value.outputLimit.maxTokens<256)throw Error('提供方能力声明无效');
  if(value.transport==='cli-text'&&(value.nativeTools||value.strict||value.outputLimit.kind!=='contract-only'))throw Error('CLI文本渠道不能声明提供方原生工具或输出硬限制');
  if(value.strict!==(value.schema==='deepseek-strict')||value.strict&&(value.provider!=='deepseek'||value.transport!=='native-http'||!value.nativeTools))throw Error('strict能力与工具渠道声明不一致');
  if(service){
    if(service.maxOutput>value.outputLimit.maxTokens)throw Error(value.outputLimit.kind==='provider-max-tokens'?'单次输出超过提供方声明能力':'单次输出超过渠道请求合同');
    const url=new URL(service.baseUrl);
    if(value.provider==='deepseek'&&(url.origin!=='https://api.deepseek.com'||!['','/','/v1','/beta'].includes(url.pathname.replace(/\/$/,''))))throw Error('DeepSeek原生能力只适用于官方直接接口');
    if(value.strict&&url.pathname.replace(/\/$/,'')!=='/beta')throw Error('DeepSeek strict必须显式使用官方Beta接口');
  }
}

export function isProviderTermination(value:unknown,requestId?:string):value is ProviderTermination{
  const item=value as ProviderTermination|undefined;
  return !!item&&item.version==='provider-termination-v1'&&item.kind==='provider-rejected'&&item.provider==='deepseek'&&[429,503].includes(item.status)&&item.noResult===true&&typeof item.requestId==='string'&&!!item.requestId&&(!requestId||item.requestId===requestId)&&/^[a-f0-9]{64}$/.test(item.responseHash)&&Number.isSafeInteger(item.endedAt)&&item.endedAt>0&&['https://api.deepseek.com/chat/completions','https://api.deepseek.com/v1/chat/completions','https://api.deepseek.com/beta/chat/completions'].includes(item.endpoint)&&(item.retryAfterMs===undefined||Number.isFinite(item.retryAfterMs)&&item.retryAfterMs>=0);
}

export async function verifyProviderTermination(value:unknown,receipt:ProviderReceipt|undefined,service:Pick<Service,'baseUrl'|'providerCapabilities'>,requestId:string):Promise<boolean>{
  if(!isProviderTermination(value,requestId)||!receipt||receipt.status!==value.status||service.providerCapabilities?.provider!=='deepseek'||service.providerCapabilities.transport!=='native-http'||value.endpoint!==service.baseUrl.replace(/\/$/,'')+'/chat/completions'||!receipt.body?.error||typeof receipt.body.error!=='object'||Array.isArray(receipt.body.error)||receipt.body.choices!==undefined)return false;
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(receipt.body))));
  return Array.from(bytes).map(byte=>byte.toString(16).padStart(2,'0')).join('')===value.responseHash;
}
