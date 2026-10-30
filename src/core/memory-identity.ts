import type {Memory} from './types.ts';
import {hashText} from './text-hash.ts';

type Identity={hash:string;chars:number};
const prepared=new WeakMap<Memory,{text:string;identity:Identity}>();
const byText=new Map<string,Identity>();
let cachedChars=0;
function rememberTextIdentity(text:string,identity:Identity):void {
  if(byText.delete(text))cachedChars-=text.length;
  if(text.length<=1_000_000){byText.set(text,identity);cachedChars+=text.length;}
  while(byText.size>128||cachedChars>1_000_000){const first=byText.keys().next().value!;cachedChars-=first.length;byText.delete(first);}
}
/** Prepare an imminent synchronous correction before it creates a new Memory. */
export async function prepareMemoryTextIdentity(text:string):Promise<Identity> {
  const known=byText.get(text);if(known)return {...known};
  const identity={hash:await hashText(text),chars:text.length};rememberTextIdentity(text,identity);return {...identity};
}
/** Called after the embedding store has verified these exact bytes. */
export function recordVerifiedMemoryIdentity(memory:Memory,hash:string,text:string):void {
  if(!/^[0-9a-f]{64}$/.test(hash)||memory.text!==text)throw Error('阅读档案正文身份未对应当前正文');
  prepared.set(memory,{text,identity:{hash,chars:text.length}});
  rememberTextIdentity(text,{hash,chars:text.length});
}
/** Drop the object's verification string as soon as its body leaves residency. */
export function releaseMemoryIdentityText(memory:Memory):void {prepared.delete(memory);}
export async function prepareMemoryIdentities(memories:readonly Memory[]):Promise<void> {
  await Promise.all(memories.map(async memory=>{
    if(typeof memory.text!=='string'){memoryContentIdentity(memory);return;}
    const text=memory.text,old=prepared.get(memory);if(old?.text===text)return;
    const known=byText.get(text);if(known){recordVerifiedMemoryIdentity(memory,known.hash,text);return;}
    const hash=await hashText(text);
    if(memory.text!==text)throw Error('阅读档案正文在计算来源身份时变化');
    recordVerifiedMemoryIdentity(memory,hash,text);
  }));
}
/** Semantic identity never includes residency, a storage key or navigation hints. */
export function memoryContentIdentity(memory:Memory):Identity {
  if(typeof memory.text==='string'){
    const cached=prepared.get(memory),identity=cached?.text===memory.text?cached.identity:byText.get(memory.text);
    if(!identity)throw Error('阅读档案正文来源身份尚未准备，请先计算当前正文');
    return {...identity};
  }
  const ref=memory.bodyRef;
  if(!ref||!/^[0-9a-f]{64}$/.test(ref.hash)||!Number.isSafeInteger(ref.chars)||ref.chars<0)throw Error('阅读档案正文来源身份缺失');
  return {hash:ref.hash,chars:ref.chars};
}
/** The exact pre-externalization record shape used by historical repair stamps. */
export function legacyMemoryRecord(memory:Memory):Record<string,unknown> {
  if(typeof memory.text!=='string')throw Error('阅读档案正文尚未载入，请先读取所需档案');
  const {bodyRef,documentTitle,navigationCues,knowledgeDistribution,organization,...record}=memory;return record;
}
export function memorySourceRecord(memory:Memory):Record<string,unknown> {
  const {text,bodyRef,documentTitle,navigationCues,knowledgeDistribution,organization,...record}=memory;
  return {...record,contentIdentity:memoryContentIdentity(memory)};
}
function canonical(value:unknown):unknown {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical((value as Record<string,unknown>)[key])]));
  return value;
}
/** Exact content/provenance version. Development pointers, navigation and
 * storage residency are mutable and do not revoke an otherwise readable version. */
export function memoryReadVersion(memory:Memory):string {
  const {id,bookId,partnerId,kind,source,backgroundOrigin,evidence,sourceEvidence,sourceQuote,parents,chatIds,basis,formationSources,writeBaseIds}=memory;
  return JSON.stringify(canonical({id,bookId,partnerId,kind,source,backgroundOrigin,evidence,sourceEvidence,sourceQuote,parents,chatIds,basis,...(formationSources?{formationSources:formationSources.materialRef??formationSources,writeBaseIds}:{}),content:memoryContentIdentity(memory)}));
}
export function memoryReadVersionDifferences(expected:string,memory:Memory):string[]{
  const before=JSON.parse(expected) as Record<string,unknown>,after=JSON.parse(memoryReadVersion(memory)) as Record<string,unknown>;
  return [...new Set([...Object.keys(before),...Object.keys(after)])].filter(key=>JSON.stringify(before[key])!==JSON.stringify(after[key]));
}
/** Compare JSON semantic records without rewriting historical saved stamps. */
export function stampsEqual(a:string,b:string):boolean {
  if(a===b)return true;
  try{return JSON.stringify(canonical(JSON.parse(a)))===JSON.stringify(canonical(JSON.parse(b)));}catch{return false;}
}
