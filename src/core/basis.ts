import {covers} from './books.ts';
import {isBackgroundMemory,isEvidenceAllowed,isUsableSourceVersion} from './context.ts';
import type {MemoryBasis,Memory,Book,State,Evidence,Range} from './types.ts';

/** Optional model attribution, never an authorization or forgetting boundary. */
export function parseBasis(raw: unknown): MemoryBasis | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const ids = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 64 && v.every(x => typeof x === 'string' && x.length > 0 && x.length <= 128);
  if (!ids(value.memoryIds) || !ids(value.chatIds) || value.habitIds!==undefined&&!ids(value.habitIds)) return undefined;
  return { memoryIds: [...new Set(value.memoryIds)], chatIds: [...new Set(value.chatIds)], ...(value.habitIds!==undefined?{habitIds:[...new Set(value.habitIds as string[])]}:{}) };
}

export function boundBasis(basis: MemoryBasis | undefined, memoryIds: string[], chatIds: string[], habitIds: string[] = []): MemoryBasis | undefined {
  if (!basis || basis.memoryIds.some(id => !memoryIds.includes(id)) || basis.chatIds.some(id => !chatIds.includes(id)) || basis.habitIds?.some(id=>!habitIds.includes(id))) return undefined;
  return { memoryIds: [...basis.memoryIds], chatIds: [...basis.chatIds], ...(basis.habitIds!==undefined?{habitIds:[...basis.habitIds]}:{}) };
}

/** Structural writes explicitly claiming attribution must never silently fall back. */
export function parseStructuralBasis(raw:unknown,memoryLimit=64):MemoryBasis|undefined{
  if(raw===undefined)return;
  const v=raw as Record<string,unknown>,ids=(value:unknown,limit:number):value is string[]=>Array.isArray(value)&&value.length<=limit&&value.every(id=>typeof id==='string'&&id.length>0&&id.length<=128);
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['memoryIds','chatIds','habitIds'].includes(k))||!ids(v.memoryIds,memoryLimit)||!ids(v.chatIds,64)||v.habitIds!==undefined&&!ids(v.habitIds,2))throw Error('结构basis须明确memoryIds/chatIds数组及可选habitIds，不能猜测或降级');
  return{memoryIds:[...new Set(v.memoryIds)],chatIds:[...new Set(v.chatIds)],...(v.habitIds!==undefined?{habitIds:[...new Set(v.habitIds as string[])]}:{})};
}
export const structuralBasisSchema={type:'object',description:'本项新理解实际使用的完整m/c/h或本次成功thought的tN；省略保守依赖全部已取得资料，空数组须有本轮实际p。程序自动保留前身、物化来源和影响目标依赖。',properties:{memoryIds:{type:'array',items:{type:'string'},maxItems:64},chatIds:{type:'array',items:{type:'string'},maxItems:64},habitIds:{type:'array',items:{type:'string'},maxItems:2}},required:['memoryIds','chatIds'],additionalProperties:false};
type StructuralContext={parents:string[];chatIds:string[];habitIds:string[];source:Memory['source'];refs:Evidence[];originalRanges:Range[];passages:ReadonlyMap<string,NonNullable<Memory['sourceQuote']>>;proposalSources?:ReadonlyMap<string,Memory>};
export function planStructuralBasis(state:State,book:Book,memory:Memory,raw:MemoryBasis|undefined,ctx:StructuralContext,mandatory:string[]=[]):void{
  if(raw===undefined)return;
  const parsed=parseStructuralBasis(raw)!;
  const memoryIds=parsed.memoryIds.map(key=>{
    if(!/^t[1-9]\d*$/.test(key)){if(!ctx.parents.includes(key))throw Error('结构basis来源须为本轮实际完整取得的认识，目录不授依据');return key;}
    const proposed=ctx.proposalSources?.get(key);
    if(!proposed||proposed.bookId!==book.id||proposed.partnerId!==state.partnerId||isBackgroundMemory(proposed)!==(ctx.source==='background')||!isUsableSourceVersion(state,proposed)||proposed.evidence.some(e=>e.bookId!==book.id||e.version!==book.version||!covers(ctx.refs,e))||!isEvidenceAllowed(book,proposed.evidence))throw Error('结构basis的t来源未成功形成或未在本轮获准取得');
    return proposed.id;
  });
  if(parsed.chatIds.some(id=>!ctx.chatIds.includes(id))||parsed.habitIds?.some(id=>!ctx.habitIds.includes(id)))throw Error('结构basis交流或习惯未在本轮实际提供');
  if(!memoryIds.length&&!parsed.chatIds.length&&!parsed.habitIds?.length){
    const provided=[...ctx.passages.values()].filter(p=>p.evidence.bookId===book.id&&p.evidence.version===book.version&&book.text.slice(p.evidence.start,p.evidence.end)===p.text&&covers(ctx.originalRanges,p.evidence)&&isEvidenceAllowed(book,[p.evidence])).map(p=>p.evidence);
    // Exact old and new citations may merge at a touching boundary. A supplied
    // p remains actual support even when its containing precise range is longer.
    if(!memory.sourceEvidence?.some(e=>covers(provided,e)||provided.some(p=>covers([e],p))))throw Error('结构独立basis须有本轮实际p支持，不能以旧坐标或宽围栏洗去依赖');
  }
  memory.basis={...parsed,memoryIds:[...new Set([...memoryIds,...mandatory])]};
  memory.parents=[...new Set([...memory.parents,...memory.basis.memoryIds])];
}
export function validateStructuralBasis(memory:Memory,mandatory:string[]=[]):void{
  if(memory.basis===undefined)return;
  const basis=parseStructuralBasis(memory.basis,memory.parents.length)!;
  if(!boundBasis(basis,memory.parents,memory.chatIds,memory.habitIds??[])||mandatory.some(id=>!basis.memoryIds.includes(id))||!basis.memoryIds.length&&!basis.chatIds.length&&!basis.habitIds?.length&&!memory.sourceEvidence?.length)throw Error('结构basis缺少实际来源、前身或完整物化依赖');
}
