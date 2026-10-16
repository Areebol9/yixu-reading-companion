import {memoryTextLength,requireMemoryText} from './memory-bodies.ts';
import { bookLength, covers, id, mergeRanges, normalize } from './books.ts';
import { evidence, isBackgroundMemory, isCurrentMemory, isUsableSourceVersion, isEvidenceAllowed, readableRanges ,memoryIsForgotten} from './context.ts';
import { READING_STATE_LIMIT } from './types.ts';
import {parseStructuralBasis,planStructuralBasis,validateStructuralBasis} from './basis.ts';
import type { Book, Evidence, Memory, Range, ReadingReply, StageNarrativeReply, State, StatePart, StatePartOperation, StateUpdate, StateWriteVersion } from './types.ts';

export type NarrativeReadOptions = { source?: Memory['source']; extra?: Range[]; through?: number };
export type NarrativePlanContext = {
  refs: Evidence[]; parents: string[]; chatIds: string[]; source: Memory['source']; habitIds: string[];
  originalRanges: Range[]; passages: ReadonlyMap<string, NonNullable<Memory['sourceQuote']>>;
  readingStage: Range[]; newMemoryIds: string[];
  stateWriteVersion?: StateWriteVersion;
  /** Input-only thought slots, bound by the detached ordinary-memory plan. */
  proposalSources?: ReadonlyMap<string, Memory>;
};
/** Complete projection rendering is bounded, never silently abbreviated. */
export function renderStateParts(parts: readonly Pick<StatePart,'text'>[], endText?: string): string {
  const value=endText??parts.map(p=>p.text).join('\n');
  if(!value.trim()||value.length>1800)throw Error('完整状态正文须为1至1800字符，不会截断片段');
  return value;
}
const textLimit = 1800;
const fields = (value: unknown, names: string[], label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !names.includes(k))) throw Error(`${label}字段无效`);
  return value as Record<string, unknown>;
};
const sourceIds = (raw: unknown): string[] | undefined => {
  if (raw === undefined) return;
  if (!Array.isArray(raw) || raw.length > 8 || raw.some(s => typeof s !== 'string' || !/^p\d{1,6}$/.test(s))) throw Error('阶段原文出处编号无效');
  return [...new Set(raw as string[])];
};
const text = (raw: unknown, limit: number, label: string): string => {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > limit) throw Error(`${label}须为1至${limit}字符的完整文字`);
  return raw.trim();
};
export function parseStageNarrative(raw: unknown): StageNarrativeReply | undefined {
  if (raw === undefined) return;
  const v = fields(raw, ['text', 'continues', 'sourceIds','basis'], '阶段叙事');
  if (v.continues !== undefined && typeof v.continues !== 'boolean') throw Error('阶段延续标记无效');
  return { text: text(v.text, textLimit, '阶段叙事'), ...(v.continues !== undefined ? { continues: v.continues as boolean } : {}), ...(v.sourceIds !== undefined ? { sourceIds: sourceIds(v.sourceIds) } : {}),...(v.basis!==undefined?{basis:parseStructuralBasis(v.basis)}:{}) };
}
export function parseStateUpdates(raw: unknown, writeVersion: StateWriteVersion = 1): StateUpdate[] | undefined {
  if (raw === undefined) return;
  if (!Array.isArray(raw) || raw.length > READING_STATE_LIMIT) throw Error(`当前状态最多${READING_STATE_LIMIT}条`);
  return raw.map(entry => {
    const v = fields(entry, writeVersion===2?['topic','status','stateChangeOf','operations','end','basis']:['topic', 'text', 'status', 'stateChangeOf', 'sourceIds','basis'], '当前状态');
    const basis=v.basis!==undefined?{basis:parseStructuralBasis(v.basis)}:{};
    if (v.status !== undefined && !['active', 'ended'].includes(v.status as string) ||
      v.stateChangeOf !== undefined && (typeof v.stateChangeOf !== 'string' || !v.stateChangeOf || v.stateChangeOf.length > 128) ||
      v.status === 'ended' && !v.stateChangeOf) throw Error('状态继起或结束标记无效');
    const topic=text(v.topic,80,'状态主题');
    if(writeVersion===2){
      if(!Array.isArray(v.operations)||v.operations.length>64)throw Error('v2状态须提供至多64条明确片段操作');
      const operations=v.operations.map(raw=>parseStateOperation(raw));
      let end:StateUpdate['end'];
      if(v.end!==undefined){const e=fields(v.end,['text','sourceIds'],'结束记录');const ids=sourceIds(e.sourceIds);if(!ids?.length)throw Error('结束记录须有实际原文出处');end={text:text(e.text,1800,'结束记录'),sourceIds:ids};}
      if(v.status==='ended'&&!end||v.status!=='ended'&&end)throw Error('结束状态须明确提供end，活动状态不接受end');
      return{topic,operations,...basis,...(v.stateChangeOf?{stateChangeOf:v.stateChangeOf as string}:{}),...(v.status?{status:v.status as StateUpdate['status']}:{}),...(end?{end}:{})};
    }
    return { topic, text: text(v.text, textLimit, '当前状态'),...basis,
      ...(v.status !== undefined ? { status: v.status as StateUpdate['status'] } : {}),
      ...(v.stateChangeOf !== undefined ? { stateChangeOf: v.stateChangeOf as string } : {}),
      ...(v.sourceIds !== undefined ? { sourceIds: sourceIds(v.sourceIds) } : {}) };
  });
}

export function parseStateOperation(raw:unknown):StatePartOperation{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('状态片段操作无效');
  const op=(raw as Record<string,unknown>).op;
  if(!['add','replace','retire'].includes(op as string))throw Error('状态片段操作仅允许add/replace/retire');
  const v=fields(raw,op==='add'?['op','text','memoryId','start','end','sourceIds']:op==='replace'?['op','partId','text','memoryId','start','end','sourceIds','reason']:['op','partId','sourceIds','reason'],'状态片段操作');
  if(op!=='add'&&(typeof v.partId!=='string'||!v.partId||v.partId.length>128))throw Error('操作须明确指向旧片段编号');
  if(op!=='add'&&(typeof v.reason!=='string'||!v.reason.trim()||v.reason.length>240))throw Error('替换或结束片段须说明依据和原因');
  const ids=sourceIds(v.sourceIds);
  if(op!=='add'&&!ids?.length)throw Error('替换或结束片段须有本轮实际原文出处');
  if(v.memoryId!==undefined&&(typeof v.memoryId!=='string'||!v.memoryId||v.memoryId.length>128)||
    (v.start===undefined)!==(v.end===undefined)||v.start!==undefined&&(!Number.isSafeInteger(v.start)||!Number.isSafeInteger(v.end)||Number(v.start)<0||Number(v.end)<=Number(v.start))||v.start!==undefined&&!v.memoryId)throw Error('片段的完整来源或摘录区间无效');
  if(op!=='retire'&&v.text===undefined&&!v.memoryId)throw Error('片段须有完整文字或明确完整来源');
  return{op:op as StatePartOperation['op'],...(op!=='retire'&&v.text!==undefined?{text:text(v.text,1800,'状态片段')}:{}),...(v.partId?{partId:v.partId as string}:{}),...(v.memoryId?{memoryId:v.memoryId as string}:{}),...(v.start!==undefined?{start:v.start as number,end:v.end as number}:{}),...(ids?{sourceIds:ids}:{}),...(v.reason?{reason:(v.reason as string).trim()}:{})};
}

export function statePartSources(book:Book,ids:readonly string[],ctx:Pick<NarrativePlanContext,'originalRanges'|'passages'|'refs'>):Evidence[]{
  if(!ids.length)throw Error('状态片段须有实际原文出处');
  const selected=ids.map(key=>ctx.passages.get(key));
  if(selected.some(p=>!p||!covers(ctx.originalRanges,p.evidence)||!covers(ctx.refs,p.evidence)||!isEvidenceAllowed(book,[p.evidence])||book.text.slice(p.evidence.start,p.evidence.end)!==p.text))throw Error('状态片段出处未在本轮实际提供');
  return mergeRanges(selected.map(p=>({start:p!.evidence.start,end:p!.evidence.end}))).map(r=>evidence(book,r));
}
export function bindStatePartMemory(state:State,book:Book,proposal:StatePartOperation,ctx:Pick<NarrativePlanContext,'parents'|'source'> & Partial<Pick<NarrativePlanContext,'proposalSources'|'refs'>>):StatePart['memoryRef']{
  if(!proposal.memoryId)return;
  const proposed=/^t[1-9]\d*$/.test(proposal.memoryId);
  const memory=proposed?ctx.proposalSources?.get(proposal.memoryId):state.memories.find(m=>m.id===proposal.memoryId);
  if(!memory||!proposed&&!ctx.parents.includes(memory.id)||proposed&&(!ctx.refs||memory.evidence.some(e=>e.bookId!==book.id||e.version!==book.version||!covers(ctx.refs??[],e)))||!['story','question'].includes(memory.kind)||memory.bookId!==book.id||memory.partnerId!==state.partnerId||isBackgroundMemory(memory)!==(ctx.source==='background')||!isUsableSourceVersion(state,memory)||!isEvidenceAllowed(book,memory.evidence))throw Error('状态片段只可绑定本轮完整提供或成功提出且可用的事实或完整原问');
  const body=requireMemoryText(memory),value=proposal.text;let start=proposal.start,end=proposal.end;
  if(start===undefined){
    if(value===undefined){start=0;end=body.length;}
    else{start=body.indexOf(value);if(start<0||body.indexOf(value,start+1)>=0)throw Error('片段摘录须在完整来源中唯一逐字匹配');end=start+value.length;}
  }
  if(end!>body.length||value!==undefined&&body.slice(start,end)!==value||memory.kind==='question'&&(start!==0||end!==body.length)||!body.slice(start,end).trim())throw Error('状态摘录不符完整来源，原问不能剪断条件');
  return{memoryId:memory.id,start,end:end!};
}
function checkPartSource(state:State,book:Book,part:StatePart,source:Memory['source'],independent=false):void{
  if(!part||typeof part.id!=='string'||!part.id||typeof part.text!=='string'||!part.text.trim()||part.text.length>1800)throw Error('状态片段身份或完整文字无效');
  if(part.sourceEvidence&&(!part.sourceEvidence.length||!isEvidenceAllowed(book,part.sourceEvidence)))throw Error('状态片段原文来源不可用');
  if(part.memoryRef){
    const ref=part.memoryRef,m=state.memories.find(m=>m.id===ref.memoryId);
    if(!m||!['story','question'].includes(m.kind)||m.bookId!==book.id||m.partnerId!==state.partnerId||isBackgroundMemory(m)!==isBackgroundMemory({source})||!isUsableSourceVersion(state,m)||!isEvidenceAllowed(book,m.evidence)||
      !Number.isSafeInteger(ref.start)||!Number.isSafeInteger(ref.end)||ref.start<0||ref.end<=ref.start||ref.end>memoryTextLength(m)||typeof m.text==='string'&&m.text.slice(ref.start,ref.end)!==part.text||m.kind==='question'&&(ref.start!==0||ref.end!==memoryTextLength(m)))throw Error('状态片段绑定的来源版本失效，须显式重建');
  }else if(!part.sourceEvidence?.length&&!independent)throw Error('状态片段缺少明确来源');
}
/** An unchanged manual assertion keeps its actual human lineage, never a fabricated p citation. */
function manualPartOrigin(state:State,book:Book,part:StatePart,memory:Pick<Memory,'parents'|'source'|'partnerId'|'evidence'>,live:boolean):boolean{
  const seen=new Set<string>(),pending=[...memory.parents];
  while(pending.length){const key=pending.pop()!;if(seen.has(key))continue;seen.add(key);const origin=state.memories.find(m=>m.id===key);
    if(!origin||origin.bookId!==book.id||origin.partnerId!==memory.partnerId||isBackgroundMemory(origin)!==isBackgroundMemory(memory))continue;
    if(origin.source==='correction'&&origin.stateProjection?.parts?.some(p=>p.id===part.id&&p.text===part.text&&!p.memoryRef&&!p.sourceEvidence?.length)&&
      origin.evidence.every(r=>covers(memory.evidence,r))&&(!live||isCurrentMemory(origin)&&isEvidenceAllowed(book,origin.evidence)))return true;
    pending.push(...origin.parents);
  }
  return false;
}
export function validateStateParts(state:State,book:Book,memory:Memory,live=false):void{
  const p=memory.stateProjection;
  if(p?.writeVersion!==undefined&&p.writeVersion!==2)throw Error('状态存储协议版本无效');
  if(p?.writeVersion!==2){if(p?.parts!==undefined||p?.end!==undefined)throw Error('旧状态不能伪装v2完整片段');return;}
  if(!Array.isArray(p.parts)||new Set(p.parts.map(x=>x?.id)).size!==p.parts.length)throw Error('状态片段列表或编号无效');
  const independent=memory.source==='correction';
  const validRefs=(raw:unknown):raw is Evidence[]=>Array.isArray(raw)&&raw.length>0&&raw.every(r=>r&&r.bookId===book.id&&r.version===book.version&&Number.isSafeInteger(r.start)&&Number.isSafeInteger(r.end)&&r.start>=0&&r.end>r.start&&r.end<=bookLength(book)&&covers(memory.evidence,r));
  for(const part of p.parts){
    if(!part||typeof part.id!=='string'||!part.id||part.id.length>128||typeof part.text!=='string'||!part.text.trim())throw Error('状态片段无效');
    if(part.sourceEvidence!==undefined&&!validRefs(part.sourceEvidence))throw Error('片段原文出处超出完整使用范围');
    if(part.memoryRef){
      const ref=part.memoryRef,source=state.memories.find(m=>m.id===ref.memoryId);
      if(!source||!['story','question'].includes(source.kind)||source.bookId!==memory.bookId||source.partnerId!==memory.partnerId||isBackgroundMemory(source)!==isBackgroundMemory(memory)||
        !Number.isSafeInteger(ref.start)||!Number.isSafeInteger(ref.end)||ref.start<0||ref.end<=ref.start||ref.end>memoryTextLength(source)||typeof source.text==='string'&&source.text.slice(ref.start,ref.end)!==part.text||source.kind==='question'&&(ref.start!==0||ref.end!==memoryTextLength(source))||
        source.evidence.some(r=>!covers(memory.evidence,r))||!independent&&!memory.parents.includes(source.id)||live&&(!isUsableSourceVersion(state,source)||!isEvidenceAllowed(book,source.evidence)))throw Error('片段引用的完整来源版本或摘录无效');
    }else if(!part.sourceEvidence?.length&&!independent&&!manualPartOrigin(state,book,part,memory,live))throw Error('片段须有实际原文、稳定来源或未触人工前态');
    if(live)checkPartSource(state,book,part,isBackgroundMemory(memory)?'background':memory.source,independent||!part.memoryRef&&!part.sourceEvidence?.length&&manualPartOrigin(state,book,part,memory,true));
  }
  if(p.status==='ended'){
    if(p.parts.length||!p.end||typeof p.end.text!=='string'||!p.end.text.trim()||!(independent&&Array.isArray(p.end.sourceEvidence)&&!p.end.sourceEvidence.length)&&!validRefs(p.end.sourceEvidence))throw Error('结束状态须为空活动片段并有完整结束收据');
  }else if(p.end!==undefined||!p.parts.length)throw Error('活动状态须保持有效片段且不携带结束收据');
  if(typeof memory.text==='string'&&renderStateParts(p.parts,p.end?.text)!==memory.text)throw Error('完整状态文字与片段不一致');
}
export function applyStateOperations(state:State,book:Book,update:StateUpdate,previous:Memory|undefined,ctx:NarrativePlanContext):{parts:StatePart[];end?:NonNullable<Memory['stateProjection']>['end'];sourceEvidence:Evidence[]}{
  if(previous&&previous.stateProjection?.writeVersion!==2)throw Error('旧v1状态须先经明确原文建立，不会自动包成完整v2基态');
  const parts=structuredClone(previous?.stateProjection?.parts??[]),seen=new Set<string>(),sources:Evidence[]=[];
  for(const operation of update.operations??[]){
    const op=parseStateOperation(operation);let index=-1;
    if(op.op!=='add'){
      if(seen.has(op.partId!))throw Error('同一片段本批只能操作一次');seen.add(op.partId!);
      index=parts.findIndex(p=>p.id===op.partId);if(index<0)throw Error('状态操作指向未知片段，整批未提交');
    }else if(!previous&&update.status==='ended')throw Error('新主题只能增加活动片段');
    const selected=op.sourceIds?.length?statePartSources(book,op.sourceIds,ctx):[];sources.push(...selected);
    if(op.op==='retire'){parts.splice(index,1);continue;}
    const memoryRef=bindStatePartMemory(state,book,op,ctx);if(!memoryRef&&!selected.length)throw Error('新片段须绑定完整稳定来源或实际原文');
    const source=memoryRef?state.memories.find(m=>m.id===memoryRef.memoryId):undefined;
    const fromProposal=/^t[1-9]\d*$/.test(op.memoryId??'');
    // These are inherited source coordinates, not newly acquired p passages.
    // A broad knowledge fence is never substituted for an exact source.
    const inherited=fromProposal?(source?.sourceEvidence?.length?source.sourceEvidence:source?.sourceQuote?[source.sourceQuote.evidence]:[]):[];
    if(inherited.some(e=>e.bookId!==book.id||e.version!==book.version||!covers(ctx.refs,e)||!isEvidenceAllowed(book,[e])))throw Error('本次事实的精确出处不在实际获准来源围栏内');
    if(fromProposal&&!inherited.length&&!selected.length)throw Error('本次事实投影须有已核验精确出处或实际原文，不能以宽围栏充当出处');
    const precise=mergeRanges([...inherited,...selected].map(({start,end})=>({start,end}))).map(r=>evidence(book,r));
    sources.push(...inherited);
    const value=op.text??(source?requireMemoryText(source).slice(memoryRef!.start,memoryRef!.end):undefined);
    if(!value?.trim())throw Error('状态来源正文未成功物化');
    const part:StatePart={id:op.op==='replace'?op.partId!:id(),text:value,...(memoryRef?{memoryRef}:{}),...(precise.length?{sourceEvidence:precise}:{})};
    if(op.op==='add')parts.push(part);else parts[index]=part;
  }
  let end:NonNullable<Memory['stateProjection']>['end'];
  if(update.status==='ended'){
    if(!previous||parts.length||!update.end)throw Error('结束须逐项明确退出全部片段并提供结束记录');
    const selected=statePartSources(book,update.end.sourceIds,ctx);sources.push(...selected);end={text:update.end.text,sourceEvidence:selected};
  }else if(update.end)throw Error('活动状态不能携带结束记录');
  for(const part of parts){const unchanged=previous?.stateProjection?.parts?.some(p=>p.id===part.id&&JSON.stringify(p)===JSON.stringify(part));
    const manual=!!unchanged&&manualPartOrigin(state,book,part,{parents:[previous!.id,...ctx.parents],source:ctx.source,partnerId:state.partnerId,evidence:ctx.refs},true);
    checkPartSource(state,book,part,ctx.source,manual);
  }
  if(new Set(parts.map(p=>p.id)).size!==parts.length)throw Error('状态片段编号重复');
  renderStateParts(parts,end?.text);
  return{parts,...(end?{end}:{}),sourceEvidence:mergeRanges([...sources,...parts.flatMap(p=>p.sourceEvidence??[])].map(({start,end})=>({start,end}))).map(r=>evidence(book,r))};
}

function permitted(state: State, book: Book, kind: 'stage' | 'state', options: NarrativeReadOptions): Memory[] {
  if (options.through !== undefined && (!Number.isSafeInteger(options.through) || options.through < 0 || options.through > bookLength(book))) throw Error('阶段查询上界无效');
  const allowed = readableRanges(book, options.extra ?? []).map(r => ({ start: r.start, end: Math.min(r.end, options.through ?? r.end) })).filter(r => r.end > r.start);
  const scope = { ...book, known: allowed }, background = options.source === 'background';
  return state.memories.filter(m => m.kind === kind && m.bookId === book.id && m.partnerId === state.partnerId &&
    isBackgroundMemory(m) === background && isCurrentMemory(m) && isEvidenceAllowed(scope, m.evidence) &&
    (kind!=='state'||(()=>{try{validateStateParts(state,scope,m,true);return true;}catch{return false;}})())&&
    !memoryIsForgotten(state,m));
}
function visibleCopies(memories: Memory[], otherIds: Set<string> = new Set()): Memory[] {
  const ids = new Set([...memories.map(m => m.id), ...otherIds]);
  return memories.map(m => {
    const copy = structuredClone(m);
    if (copy.stageNarrative?.previousStageId && !ids.has(copy.stageNarrative.previousStageId)) delete copy.stageNarrative.previousStageId;
    if (copy.stateChangeOf && !ids.has(copy.stateChangeOf)) delete copy.stateChangeOf;
    return copy;
  });
}
export function permittedStages(state: State, book: Book, options: NarrativeReadOptions = {}): Memory[] {
  return visibleCopies(permitted(state, book, 'stage', options)).sort((a, b) => a.stageNarrative!.ranges[0].start - b.stageNarrative!.ranges[0].start || a.createdAt - b.createdAt);
}
export function permittedStates(state: State, book: Book, options: NarrativeReadOptions = {}): Memory[] {
  const visible = permitted(state, book, 'state', options), aliases = new Map<string, string>();
  // A visible correction keeps the original state's temporal identity. Only
  // actual, fully permitted same-topic revisions can resolve that identity.
  for (const memory of visible) {
    let previousId = memory.correctionOf;
    const seen = new Set<string>();
    while (previousId && !seen.has(previousId)) {
      seen.add(previousId);
      const previous = state.memories.find(m => m.id === previousId);
      if (!previous || previous.kind !== 'state' || previous.bookId !== book.id || previous.partnerId !== state.partnerId ||
        isBackgroundMemory(previous) !== isBackgroundMemory(memory) || previous.forgotten ||
        previous.stateProjection?.topic !== memory.stateProjection?.topic || !isEvidenceAllowed({ ...book, known: readableRanges(book, options.extra ?? []).map(r => ({ start: r.start, end: Math.min(r.end, options.through ?? r.end) })).filter(r => r.end > r.start) }, previous.evidence)) break;
      aliases.set(previous.id, memory.id); previousId = previous.correctionOf;
    }
  }
  const resolved = visible.map(m => m.stateChangeOf && aliases.has(m.stateChangeOf) ? { ...m, stateChangeOf: aliases.get(m.stateChangeOf)! } : m);
  return visibleCopies(resolved).sort((a, b) => Math.max(...a.stateProjection!.asOf.map(r => r.end)) - Math.max(...b.stateProjection!.asOf.map(r => r.end)) || a.createdAt - b.createdAt);
}
export function currentStates(state: State, book: Book, options: NarrativeReadOptions = {}): Memory[] {
  const visible = permittedStates(state, book, options);
  const scope = { ...book, known: readableRanges(book, options.extra ?? []).map(r => ({ start: r.start, end: Math.min(r.end, options.through ?? r.end) })).filter(r => r.end > r.start) };
  // A suspended successor still advances this explicit chain. Its predecessor
  // remains readable history, rather than becoming the current state again.
  const all = state.memories.filter(m => m.kind === 'state' && m.bookId === book.id && m.partnerId === state.partnerId &&
    isBackgroundMemory(m) === (options.source === 'background') && !m.forgotten && isEvidenceAllowed(scope, m.evidence) &&
    !memoryIsForgotten(state,m));
  const aliases = new Map<string, string>();
  for (const memory of visible) {
    let key = memory.correctionOf;
    const seen = new Set<string>();
    while (key && !seen.has(key)) {
      seen.add(key);
      const previous = all.find(m => m.id === key && m.stateProjection?.topic === memory.stateProjection?.topic);
      if (!previous) break;
      aliases.set(previous.id, memory.id); key = previous.correctionOf;
    }
  }
  const resolve = (key: string) => { const seen = new Set<string>(); while (aliases.has(key) && !seen.has(key)) { seen.add(key); key = aliases.get(key)!; } return key; };
  const superseded = new Set<string>();
  for (const memory of all) if (memory.stateChangeOf) { superseded.add(memory.stateChangeOf); superseded.add(resolve(memory.stateChangeOf)); }
  const branches = new Map<string, number>();
  for (const memory of visible) if (memory.stateChangeOf) branches.set(memory.stateChangeOf, (branches.get(memory.stateChangeOf) ?? 0) + 1);
  const heads = visible.filter(m => !superseded.has(m.id)), topics = new Set<string>();
  for (const head of heads) { if (topics.has(head.stateProjection!.topic.trim())) throw Error('可见状态主题存在多个当前分支'); topics.add(head.stateProjection!.topic.trim()); }
  if ([...branches.values()].some(n => n > 1)) throw Error('可见状态继起存在分叉');
  return heads;
}
export function stageOriginalRanges(state: State, book: Book, memoryId: string, options: NarrativeReadOptions = {}): Range[] {
  return permittedStages(state, book, options).find(m => m.id === memoryId)?.stageNarrative?.ranges.map(r => ({ ...r })) ?? [];
}

/** Semantic payload only comes from the model; coverage and complete dependencies come from the actual task. */
export function planNarrativeMemories(state: State, book: Book, reply: ReadingReply, ctx: NarrativePlanContext): Memory[] {
  const narrative = parseStageNarrative(reply.stageNarrative), writeVersion=ctx.stateWriteVersion??1, updates = parseStateUpdates(reply.stateUpdates,writeVersion) ?? [];
  if (!narrative && !updates.length) return [];
  const ranges = mergeRanges(ctx.readingStage.map(({start,end})=>({start,end}))), refs = mergeRanges([...ctx.refs, ...ctx.parents.flatMap(parent => state.memories.find(m => m.id === parent)?.evidence ?? [])].filter(r => r.bookId === book.id && r.version === book.version).map(({start,end})=>({start,end}))).map(r => evidence(book, r));
  if (!ranges.length || ranges.some(r => !covers(refs, r) || !covers(ctx.originalRanges, r)) || !isEvidenceAllowed(book, refs)) throw Error('阶段形成范围超出本轮完整获准原文');
  const added: Memory[] = [], validText = (value: string) => !state.forgotten.some(f => f.bookId === book.id && normalize(value).includes(normalize(f.text)));
  const make = (kind: 'stage' | 'state', value: string, parents: string[], sources?: string[]): Memory => {
    const memory: Memory = { id: id(), bookId: book.id, partnerId: state.partnerId, kind, text: value,
      evidence: refs.map(r => ({ ...r })), parents: [...new Set(parents)], chatIds: [...ctx.chatIds],
      createdAt: Date.now(), forgotten: false, source: ctx.source, readingStage: ranges.map(r => ({ ...r })),
      ...(ctx.habitIds.length ? { habitIds: [...ctx.habitIds] } : {}) };
    if (sources?.length) {
      const selected = sources.map(key => ctx.passages.get(key));
      if (selected.some(p => !p || !covers(ctx.originalRanges, p.evidence) || !covers(refs, p.evidence) || !isEvidenceAllowed(book, [p.evidence]) || book.text.slice(p.evidence.start, p.evidence.end) !== p.text)) throw Error('阶段或状态出处未在本轮实际原文中提供');
      memory.sourceEvidence = mergeRanges(selected.map(p => p!.evidence)).map(r => evidence(book, r));
    }
    return memory;
  };
  if (narrative && validText(narrative.text)) {
    const previous = permittedStages(state, book, { source: ctx.source }).filter(m => Math.max(...m.stageNarrative!.ranges.map(r => r.end)) <= ranges[0].start).at(-1);
    const memory = make('stage', narrative.text, [...ctx.parents, ...ctx.newMemoryIds], narrative.sourceIds);
    memory.stageNarrative = { ranges: ranges.map(r => ({ ...r })), continues: narrative.continues ?? false, ...(previous ? { previousStageId: previous.id } : {}) };
    planStructuralBasis(state,book,memory,narrative.basis,ctx);
    added.push(memory);
  }
  const heads = currentStates(state, book, { source: ctx.source }), seen = new Set<string>();
  for (const update of updates) {
    const previous = update.stateChangeOf ? heads.find(m => m.id === update.stateChangeOf) : undefined;
    if (update.stateChangeOf && (!previous || !ctx.parents.includes(previous.id) || previous.stateProjection!.topic !== update.topic || seen.has(previous.id) ||
      previous.stateProjection!.asOf.some(r => !covers(refs, r)))) throw Error('状态继起目标须为本轮完整提供的同主题可见当前状态');
    if (!update.stateChangeOf && (heads.some(m => m.stateProjection!.topic === update.topic) || added.some(m => m.stateProjection?.topic === update.topic))) throw Error('已有同主题状态须显式接续，不能自动合并');
    if (previous) seen.add(previous.id);
    const delta=writeVersion===2?applyStateOperations(state,book,update,previous,{...ctx,refs}):undefined;
    if(writeVersion===2&&previous&&!update.operations?.length&&!update.end&&(!update.status||update.status===previous.stateProjection!.status))continue;
    const value=delta?renderStateParts(delta.parts,delta.end?.text):update.text!;
    if (!validText(value)) continue;
    const memory = make('state', value, [...ctx.parents, ...ctx.newMemoryIds, ...added.filter(m => m.kind === 'stage').map(m => m.id), ...(previous ? [previous.id] : []),...(delta?.parts.flatMap(p=>p.memoryRef?[p.memoryRef.memoryId]:[])??[])], writeVersion===1?update.sourceIds:undefined);
    memory.stateProjection = { topic: previous?.stateProjection!.topic ?? update.topic, asOf: refs.map(({ start, end }) => ({ start, end })), status: update.status ?? 'active' };
    if(delta){memory.stateProjection.writeVersion=2;memory.stateProjection.parts=delta.parts;if(delta.end)memory.stateProjection.end=delta.end;if(delta.sourceEvidence.length)memory.sourceEvidence=delta.sourceEvidence;}
    if (previous) memory.stateChangeOf = previous.id;
    planStructuralBasis(state,book,memory,update.basis,ctx,[...(previous?[previous.id]:[]),...(delta?.parts.flatMap(p=>p.memoryRef?[p.memoryRef.memoryId]:[])??[])]);
    added.push(memory);
  }
  return added;
}

/** Validate durable semantics without consulting today's permission, so earlier history survives narrower grants. */
export function validateStageStateMemories(state: State): void {
  const memories = new Map(state.memories.map(m => [m.id, m]));
  for (const m of state.memories) {
    const special = m.kind === 'stage' || m.kind === 'state';
    if (!special) { if (m.stageNarrative !== undefined || m.stateProjection !== undefined || m.stateChangeOf !== undefined) throw Error('阶段或状态元数据所属类型无效'); continue; }
    const book = state.books.find(b => b.id === m.bookId);
    const ranges = m.kind === 'stage' ? m.stageNarrative?.ranges : m.stateProjection?.asOf;
    const revisionSource=['correction','review'].includes(m.source),independentRevision = revisionSource && !!m.correctionOf;
    if (!book || (typeof m.text==='string'?!m.text.trim()||memoryTextLength(m)>textLimit:!m.bodyRef||memoryTextLength(m)>textLimit) || m.basis !== undefined && revisionSource && (!independentRevision||m.basis.memoryIds.length || m.basis.chatIds.length || m.basis.habitIds?.length) || !Array.isArray(ranges) || !ranges.length ||
      ranges.some(r => !r || !Number.isSafeInteger(r.start) || !Number.isSafeInteger(r.end) || r.start < 0 || r.end <= r.start || r.end > bookLength(book) || !covers(m.evidence, r)) ||
      m.answersPartOf !== undefined || m.revisionKind !== undefined) throw Error('阶段或状态的完整范围与依赖无效');
    if(!revisionSource)validateStructuralBasis(m,[...(m.stateChangeOf?[m.stateChangeOf]:[]),...(m.stateProjection?.parts?.flatMap(p=>p.memoryRef?[p.memoryRef.memoryId]:[])??[])]);
    if (m.kind === 'stage') {
      if (m.stateProjection !== undefined || m.stateChangeOf !== undefined || typeof m.stageNarrative!.continues !== 'boolean') throw Error('阶段叙事元数据无效');
      const previous = m.stageNarrative!.previousStageId ? memories.get(m.stageNarrative!.previousStageId) : undefined;
      if (m.stageNarrative!.previousStageId && (!previous || previous.kind !== 'stage' || previous.id === m.id || previous.bookId !== m.bookId || previous.partnerId !== m.partnerId || isBackgroundMemory(previous) !== isBackgroundMemory(m) || Math.max(...previous.stageNarrative!.ranges.map(r => r.end)) > ranges[0].start)) throw Error('阶段前后关系无效');
    } else {
      const projection = m.stateProjection!;
      if (m.stageNarrative !== undefined || typeof projection.topic !== 'string' || !projection.topic.trim() || projection.topic !== projection.topic.trim() || projection.topic.length > 80 || !['active', 'ended'].includes(projection.status) || projection.status === 'ended' && !m.stateChangeOf || JSON.stringify(mergeRanges(projection.asOf.map(({start,end})=>({start,end})))) !== JSON.stringify(mergeRanges(m.evidence.map(({start,end})=>({start,end}))))) throw Error('状态投影元数据无效');
      const previous = m.stateChangeOf ? memories.get(m.stateChangeOf) : undefined;
      if (m.stateChangeOf && (!previous || previous.kind !== 'state' || previous.id === m.id || previous.bookId !== m.bookId || previous.partnerId !== m.partnerId || isBackgroundMemory(previous) !== isBackgroundMemory(m) || previous.stateProjection?.topic !== projection.topic || !independentRevision && !m.parents.includes(previous.id) || previous.stateProjection.asOf.some(r => !covers(ranges, r)))) throw Error('状态继起关系无效');
      const seen = new Set<string>([m.id]); let cursor = previous;
      while (cursor) { if (seen.has(cursor.id)) throw Error('状态继起关系循环'); seen.add(cursor.id); cursor = memories.get(cursor.stateChangeOf ?? ''); }
      validateStateParts(state,book,m);
    }
  }
}
