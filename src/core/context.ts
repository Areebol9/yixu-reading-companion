import {bookTextSlice} from './books.ts';
import { bookLength, covers, hasBookText, id, mergeRanges, normalize, readingStart, requireBookText, subtractRanges,chapterAt,chapterContentStart,chapterContentEnd } from './books.ts';
import type { Book, Chat, Evidence, Memory, Range, State } from './types.ts';
import { memoryTextLimit,parseOriginalHistoryQuery } from './types.ts';
import type { OriginalHistoryQuery } from './types.ts';
import { reconcileTranscriptRevisions } from './transcripts.ts';
import { inputHabitValue, reconcileHabits } from './habits.ts';
import {semanticReferenceIds} from './semantic-notes.ts';
import {captureCorrectionRepairs,activateCorrectionRepairs} from './companion-correction-repair.ts';
import {pruneCompanionWorkspaces} from './companion-workspace.ts';
import {bookVersionAllowsRange} from './book-versions.ts';
import {requireMemoryText} from './memory-bodies.ts';
import {memoryReadableByPartner,sameDocumentOwner} from './book-document-ownership.ts';

export class PermissionError extends Error {}
type ReadingBoundary = Pick<Book, 'id' | 'version' | 'frontMatterEnd' | 'frontMatterIncluded'|'sourceLineage'> & {
  readonly known: readonly Readonly<Range>[];
  readonly text?: string;
  readonly textLength?: number;
};
export function readableRanges(book: ReadingBoundary, extra: readonly Range[] = []): Range[] {
  return mergeRanges([...book.known.map(r => ({ start: Math.max(r.start, readingStart(book)), end: r.end })), ...extra]);
}
export function readableParts(book: ReadingBoundary, span: Range, extra: readonly Range[] = []): Range[] {
  if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end <= span.start) throw new PermissionError('阅读坐标无效');
  const length = book.textLength ?? book.text?.length ?? 0;
  return readableRanges(book, extra).map(range => ({ start: Math.max(range.start, span.start), end: Math.min(range.end, span.end, length) })).filter(range => range.end > range.start);
}
/** Nearby original text already permitted for this task, distinct from its new material. */
export function precedingReadings(book: Book, readings: Range[], extra: Range[] = []): Range[] {
  const material = mergeRanges(readings), selected: Range[] = [];
  let remaining = 1200;
  for (const current of [...material].reverse()) {
    if (!remaining || selected.length >= 8) break;
    if (!current.start) continue;
    const candidates = subtractRanges(readableParts(book, { start: Math.max(0, current.start - 1200), end: current.start }, extra), [...material, ...selected]);
    for (const range of candidates.reverse()) {
      if (!remaining || selected.length >= 8) break;
      const part = { start: Math.max(range.start, range.end - remaining), end: range.end };
      selected.push(part); remaining -= part.end - part.start;
    }
  }
  return mergeRanges(selected);
}
/** Complete permitted current/previous chapter window. Focus remains separate;
 * holes and ungranted future paragraphs never enter this material. */
export function recentChapterReadings(book:Book,focus:Range[],extra:Range[]=[]):Range[]{
  const last=focus.at(-1);if(!last)return[];const current=chapterAt(book,Math.max(last.start,last.end-1)),bodyChapters=book.chapters.filter(c=>chapterContentEnd(book,c)>Math.max(readingStart(book),chapterContentStart(book,c))),at=bodyChapters.findIndex(c=>c.index===current.index),selected=at<0?[current]:bodyChapters.slice(Math.max(0,at-1),at+1);
  return mergeRanges(selected.flatMap(c=>{const start=Math.max(readingStart(book),chapterContentStart(book,c)),end=chapterContentEnd(book,c);return end>start?readableParts(book,{start,end},extra):[];}));
}
/** Remaining part of the same complete recent window, with no character cap. */
export function sceneNearbyReadings(book:Book,readings:Range[],extra:Range[]=[]):Range[]{
  return subtractRanges(recentChapterReadings(book,readings,extra),readings);
}
export function assertReadable(book: Book, span: Range, extra: Range[] = []): void {
  if (span.end > bookLength(book) || !covers(readableRanges(book, extra), span)) throw new PermissionError('这段资料超出本次允许阅读的范围');
}
export function evidence(book: Book, span: Range): Evidence { return { ...span, bookId: book.id, version: book.version }; }
/** Displaying real dialogue does not grant later material or maintenance use. */
type ChatMemoryCheck={chats:Map<string,Chat>;books:Map<string,Book>;evidence:Map<string,ReturnType<typeof createEvidenceChecker>>;memo:Map<string,boolean>};
/** One synchronous source check may visit the same paragraph parents repeatedly. */
export function createChatMemoryChecker(state:State):(chat:Chat)=>boolean{
  const check:ChatMemoryCheck={chats:new Map(state.chats.map(chat=>[chat.id,chat])),books:new Map(state.books.map(book=>[book.id,book])),evidence:new Map(),memo:new Map()};
  return chat=>chatAllowsMemory(state,chat,new Set(),check);
}
export function chatAllowsMemory(state:State,chat:Chat,seen=new Set<string>(),check?:ChatMemoryCheck):boolean{
  if(chat.memoryAllowed===false||seen.has(chat.id))return false;
  const known=check?.memo.get(chat.id);if(known!==undefined)return known;
  seen.add(chat.id);
  if(chat.presentation==='paragraph'){
    const book=check?check.books.get(chat.bookId):state.books.find(b=>b.id===chat.bookId);
    let allowed=book&&check?.evidence.get(book.id);if(book&&check&&!allowed){allowed=createEvidenceChecker(book);check.evidence.set(book.id,allowed);}
    if(!book||chat.excluded||chat.futureGrant||!chat.anchor||!bookVersionAllowsRange(book,chat.anchor.version,chat.anchor)||!(allowed?allowed([chat.anchor,...chat.evidence]):isEvidenceAllowed(book,[chat.anchor,...chat.evidence])))return false;
    for(const parentId of new Set([chat.replyTo,chat.paragraphCommentId].filter((v):v is string=>!!v))){
      const parent=check?check.chats.get(parentId):state.chats.find(c=>c.id===parentId);
      if(!parent||parent.presentation!=='paragraph'||parent.anchor?.start!==chat.anchor.start||parent.anchor.end!==chat.anchor.end||!chatAllowsMemory(state,parent,new Set(seen),check))return false;
    }
  }
  const allowed=!chat.replyTo||(check?check.chats.get(chat.replyTo):state.chats.find(question=>question.id===chat.replyTo))?.memoryAllowed!==false;
  check?.memo.set(chat.id,allowed);return allowed;
}
/** A read-only question may quote only the response explicitly selected by the user. */
export function chatIsTaskSource(state:State,chat:Chat,question?:Chat):boolean{
  if(chatAllowsMemory(state,chat))return true;
  if(question?.memoryAllowed!==false)return false;
  if(chat.id===question.id)return true;
  const selected=question.expansionOf&&state.chats.find(response=>response.id===question.expansionOf&&response.bookId===question.bookId&&response.sessionId===question.sessionId);
  return !!selected&&selected.role==='assistant'&&(chat.id===selected.id||chat.id===selected.replyTo);
}
/** Precise original locations; legacy exposure ranges are not treated as claim support. */
export function memorySources(memory: Pick<Memory, 'sourceEvidence' | 'sourceQuote'>): Evidence[] {
  return memory.sourceEvidence?.length ? memory.sourceEvidence : memory.sourceQuote ? [memory.sourceQuote.evidence] : [];
}
/** Match an optional quote only within original text actually supplied this turn. */
export function matchSourceQuote(book: Book, ranges: Range[], quote?: string): Memory['sourceQuote'] {
  if (!quote || quote.length < 8 || quote.length > 200 || !hasBookText(book)&&!book.residentRanges?.length) return;
  let found: number | undefined;
  for (const range of mergeRanges(ranges)) {
    if (!isEvidenceAllowed(book, [evidence(book, range)])) continue;
    const text = bookTextSlice(book,range.start, range.end);
    let offset = text.indexOf(quote);
    while (offset >= 0) {
      const start = range.start + offset;
      if (found !== undefined && found !== start) return;
      found = start; offset = text.indexOf(quote, offset + 1);
    }
  }
  if (found !== undefined) return { text: quote, evidence: evidence(book, { start: found, end: found + quote.length }) };
}
export function readText(book: Book, span: Range, extra: Range[] = []): string { assertReadable(book, span, extra); requireBookText(book); return bookTextSlice(book,span.start, span.end); }
/** Capture a grant only for one synchronous check, never across state changes. */
export function createEvidenceChecker(book:ReadingBoundary,extra:readonly Range[]=[]):(refs:readonly Readonly<Evidence>[])=>boolean{
  const length=book.textLength??book.text?.length??0,bookId=book.id,version={version:book.version,textLength:length,sourceLineage:book.sourceLineage},allowed=readableRanges(book,extra),checked=new WeakMap<object,boolean>();
  return refs=>{const known=checked.get(refs);if(known!==undefined)return known;
    const valid=refs.length > 0 && refs.every(r => r.bookId === bookId && bookVersionAllowsRange(version,r.version,r) && r.end <= length &&
    Number.isSafeInteger(r.start) && Number.isSafeInteger(r.end) && r.start >= 0 && r.end > r.start &&
    allowed.some(span => span.start <= r.start && span.end >= r.end));
    checked.set(refs,valid);return valid;
  };
}
export function isEvidenceAllowed(book: ReadingBoundary, refs: readonly Readonly<Evidence>[], extra: readonly Range[] = []): boolean {
  return createEvidenceChecker(book,extra)(refs);
}
/** Unloaded records remain metadata candidates; exact text exclusion is rechecked after hydration. */
export function memoryIsForgotten(state:State,memory:Memory):boolean {
  return memory.forgotten||state.forgotten.some(f=>f.bookId===memory.bookId&&(f.id===memory.id||typeof memory.text==='string'&&!!normalize(f.text)&&normalize(memory.text).includes(normalize(f.text))));
}
export function usableMemories(state: State, book: Book, extra: Range[] = []): Memory[] {
  const versions = new Map(state.memories.map(m => [m.id,m]));
  return state.memories.filter(m => isCurrentUnderstanding(m, versions.get(m.replacedBy ?? ''), book, extra) && m.bookId === book.id && memoryReadableByPartner(state,m) &&
    isEvidenceAllowed(book, m.evidence, extra) && !memoryIsForgotten(state,m))
    .map(m=>{const question=m.answersPartOf&&currentQuestion(state,book,m.answersPartOf,extra,versions);
      return question&&question.id!==m.answersPartOf?{...m,answersPartOf:question.id}:m;});
}
/** A verified, verbatim restoration preserves the question identity. Keep stored
 * history intact and resolve its pointer only within this task's permission. */
export function currentQuestion(state:State,book:Book,memoryId:string,extra:Range[]=[],versions=new Map(state.memories.map(m=>[m.id,m]))):Memory|undefined{
  const seen=new Set<string>();let memory=versions.get(memoryId);
  while(memory&&!seen.has(memory.id)){
    if(memory.kind!=='question'||memory.bookId!==book.id||!memoryReadableByPartner(state,memory)||memory.forgotten||
      !isEvidenceAllowed(book,memory.evidence,extra)||memoryIsForgotten(state,memory))return;
    if(isCurrentUnderstanding(memory,versions.get(memory.replacedBy??''),book,extra))return memory;
    seen.add(memory.id);const next=versions.get(memory.replacedBy??'');
    if(!next||!sameDocumentOwner(memory,next)||next.source!=='review'||next.kind!=='question'||next.reviewDisposition!=='supported'||typeof memory.text!=='string'||typeof next.text!=='string'||next.text!==memory.text)return;
    memory=next;
  }
}
export function isCurrentMemory(memory: Pick<Memory, 'forgotten' | 'replacedBy' | 'invalidatedBy' | 'reviewDisposition'|'historicalOnly'|'documentState'>): boolean { return memory.documentState!=='retired' && !memory.historicalOnly && !memory.forgotten && !memory.replacedBy && !memory.invalidatedBy && memory.reviewDisposition !== 'unsupported'; }
/** A normal developed version remains an immutable source, even when a newer
 * interpretation is known. Error correction and forgetting do not. */
export function isUsableSourceVersion(state:State,memory:Memory):boolean{
  return !memory.forgotten&&!memory.invalidatedBy&&memory.reviewDisposition!=='unsupported'&&(!memory.replacedBy||state.memories.find(m=>m.id===memory.replacedBy)?.revisionKind==='development');
}
export function isBackgroundMemory(memory:Pick<Memory,'source'|'backgroundOrigin'>):boolean{return memory.source==='background'||memory.backgroundOrigin===true;}
type MemoryVersion = Pick<Memory, 'id' | 'forgotten' | 'replacedBy' | 'invalidatedBy' | 'reviewDisposition' | 'revisionKind'|'historicalOnly'|'documentState'> & { readonly evidence: readonly Readonly<Evidence>[] };
export function isCurrentUnderstanding(memory: MemoryVersion, next: MemoryVersion | undefined, book: ReadingBoundary, extra: readonly Range[] = []): boolean {
  return !memory.historicalOnly && memory.documentState!=='retired' && (isCurrentMemory(memory) || !memory.forgotten && !memory.invalidatedBy && memory.reviewDisposition !== 'unsupported' && !!memory.replacedBy && memory.replacedBy === next?.id &&
    next.revisionKind === 'development' && !isEvidenceAllowed(book, next.evidence, extra));
}

export function reconcileMemoryOrigins(state:State,memories=new Map(state.memories.map(m=>[m.id,m]))):void{
  for(const m of state.memories)if(['review','correction'].includes(m.source)&&!m.backgroundOrigin){
    const seen=new Set<string>();let previous=memories.get(m.correctionOf??'');
    while(previous&&!seen.has(previous.id)&&sameDocumentOwner(previous,m)){
      if(isBackgroundMemory(previous)){m.backgroundOrigin=true;break;}
      if(!['review','correction'].includes(previous.source))break;
      seen.add(previous.id);previous=memories.get(previous.correctionOf??'');
    }
  }
}

/** Revisions retire dependent understanding; the original text and actual exchanges stay intact. */
export function reconcileCorrections(state: State): void {
  const memories = new Map(state.memories.map(m => [m.id, m]));reconcileMemoryOrigins(state,memories);
  // Rebuild machine-derived status from explicit revisions and source changes.
  // This also repairs stored status produced by the former reverse input edge.
  // Opaque legacy reasons, forgetting and excluded messages remain intact.
  const causes=new Set<string>((state.habits??[]).map(h=>h.id));
  for(const m of state.memories){
    if(m.replacedBy&&memories.get(m.replacedBy)?.revisionKind!=='development')causes.add(m.replacedBy);
    if(m.reviewDisposition==='unsupported')causes.add(m.id);
  }
  for(const r of state.transcriptRevisions??[])causes.add(r.id);
  for(const m of state.memories)if(m.invalidatedBy&&causes.has(m.invalidatedBy))m.invalidatedBy=undefined;
  for(const c of state.chats)if(c.outdatedBy&&causes.has(c.outdatedBy))c.outdatedBy=undefined;
  for(const h of state.habits??[])if(h.invalidatedBy&&causes.has(h.invalidatedBy))h.invalidatedBy=undefined;
  reconcileTranscriptRevisions(state);
  reconcileHabits(state);
  const retracted = (memory: Memory | undefined) => memory?.invalidatedBy || (memory?.reviewDisposition==='unsupported'?memory.id:undefined) || (memory?.replacedBy && memories.get(memory.replacedBy)?.revisionKind !== 'development' ? memory.replacedBy : undefined);
  const chats = new Map(state.chats.map(c => [c.id, c]));
  for (const m of state.memories) {
    for(const previousId of [...(m.correctionOf?[m.correctionOf]:[]),...(m.mergePreviousIds??[])]){
      const previous=memories.get(previousId);
      if(previous?.replacedBy&&previous.replacedBy!==m.id)m.invalidatedBy=previous.replacedBy;
    }
    if (!m.replacedBy || memories.get(m.replacedBy)?.revisionKind === 'development') continue;
    const reason = m.replacedBy;
    // chatIds / basis.chatIds are inputs to this claim. Retracting a later
    // interpretation cannot retract the earlier exchanges it consulted. Replies
    // derived from the claim are retired through their own dependency IDs below.
    const preference=m.kind==='user'&&typeof m.text==='string'?inputHabitValue(m.text):undefined;
    if(preference)for(const h of state.habits??[]){
      if(h.partnerId===m.partnerId&&h.sourceBookId===m.bookId&&h.sourceChatId&&
        (m.basis?.chatIds??m.chatIds).includes(h.sourceChatId)&&h.key===preference.key&&h.value===preference.value)h.invalidatedBy??=reason;
    }
    // Older backups lack reply dependency IDs. Conservatively retire legacy assistant
    // replies from the affected period, without changing their visible history.
    const until = memories.get(reason)?.createdAt;
    if (until !== undefined) for (const chat of state.chats) {
      if (chat.bookId === m.bookId && chat.role === 'assistant' && chat.memoryIds === undefined &&
        chat.createdAt >= m.createdAt && chat.createdAt <= until) chat.outdatedBy ??= reason;
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of state.memories) {
      if ((m.replacedBy && m.kind!=='context') || m.invalidatedBy || m.source === 'correction') continue;
      const manualParents:string[]=[];
      for(const part of m.stateProjection?.parts??[])if(!part.memoryRef&&!part.sourceEvidence?.length){
        const visited=new Set<string>(),pending=[...m.parents];
        while(pending.length){const key=pending.pop()!;if(visited.has(key))continue;visited.add(key);const origin=memories.get(key);
          if(!origin||origin.bookId!==m.bookId||!sameDocumentOwner(origin,m)||isBackgroundMemory(origin)!==isBackgroundMemory(m))continue;
          if(origin.source==='correction'&&origin.stateProjection?.parts?.some(p=>p.id===part.id&&p.text===part.text&&!p.memoryRef&&!p.sourceEvidence?.length))manualParents.push(origin.id);
          pending.push(...origin.parents);
        }
      }
      const parent = [...(m.basis?.memoryIds ?? m.parents),...(m.writeBaseIds??[]),...semanticReferenceIds(m),...(m.stateProjection?.parts??[]).flatMap(p=>p.memoryRef?[p.memoryRef.memoryId]:[]),...manualParents].map(p => memories.get(p)).find(p => retracted(p));
      const chat = (m.basis?.chatIds ?? m.chatIds).map(c => chats.get(c)).find(c => c?.outdatedBy);
      const reason = retracted(parent) || chat?.outdatedBy;
      if (reason) { m.invalidatedBy = reason; changed = true; }
    }
    for (const chat of state.chats) {
      if (chat.outdatedBy) continue;
      const memory = (chat.basis?.memoryIds ?? chat.memoryIds)?.map(id => memories.get(id)).find(m => retracted(m));
      const previous = (chat.basis?.chatIds ?? [...(chat.contextChatIds ?? []), ...(chat.replyTo ? [chat.replyTo] : [])]).map(id => chats.get(id)).find(c => c?.outdatedBy);
      const reason = retracted(memory) || previous?.outdatedBy;
      if (reason) { chat.outdatedBy = reason; changed = true; }
    }
  }
  reconcileHabits(state);
}

export function correctMemory(state: State, memoryId: string, text: string): Memory {
  const original = state.memories.find(m => m.id === memoryId);
  if (!original || original.forgotten || original.replacedBy || original.invalidatedBy) throw new Error('这条记忆已更新，请更正当前记录');
  requireMemoryText(original);
  const value = original.kind==='opinion'?text:text.trim();
  const limit=memoryTextLimit(original.kind);
  if (!value.trim() || limit!==undefined&&value.length > limit) throw new Error(limit===undefined?'更正内容须为非空正文':`更正内容请填写 1 至 ${limit} 个字符`);
  if (value === original.text && original.reviewDisposition !== 'unsupported') return original;
  const repairs=captureCorrectionRepairs(state,original);
  const book = state.books.find(b => b.id === original.bookId);
  if (!book) throw new Error('未找到这条记忆所属的作品');
  const replacement: Memory = {
    ...original, id: id(), text: value, bodyRef:undefined, createdAt: Date.now(), source: 'correction',
    backgroundOrigin:isBackgroundMemory(original)?true:undefined,
    evidence: mergeRanges([...original.evidence, ...book.known]).map(r => evidence(book, r)),
    correctionOf: original.id, mergePreviousIds:undefined, parents: [], chatIds: [], webSources: undefined,
    replacedBy: undefined, invalidatedBy: undefined, basis: { memoryIds: [], chatIds: [] }, habitIds: undefined, reviewDisposition: undefined, reviewReason: undefined, revisionKind: undefined, revisionReason: undefined, documentRevision:undefined, sourceQuote: undefined, sourceEvidence: undefined, readingStage: undefined, answersPartOf: undefined, narrative: undefined,about:undefined,identityClaim:undefined,attribution:undefined,ruleLinks:undefined,worldChangeOf:undefined,entityBindings:undefined,temporal:undefined,clue:undefined
  };
  if(original.arcProjection)replacement.arcProjection={...original.arcProjection,parts:original.arcProjection.status==='ended'?[]:[{id:id(),text:value,role:'progress'}],...(original.arcProjection.status==='ended'?{end:{text:value,sourceEvidence:[]}}:{end:undefined})};
  if (original.stageNarrative) replacement.stageNarrative = structuredClone(original.stageNarrative);
  if (original.stateProjection) replacement.stateProjection = { ...original.stateProjection, asOf: mergeRanges(replacement.evidence.map(({start,end})=>({start,end}))),writeVersion:2,
    parts:original.stateProjection.status==='ended'?[]:[{id:id(),text:value}],
    ...(original.stateProjection.status==='ended'?{end:{text:value,sourceEvidence:[]}}:{end:undefined}) };
  original.replacedBy = replacement.id;
  state.memories.push(replacement);
  reconcileCorrections(state);
  pruneCompanionWorkspaces(state);
  activateCorrectionRepairs(state,repairs,replacement);
  return replacement;
}
export function searchText(book: Book, query: string, extra: Range[] = [], limit = 5): { text: string; evidence: Evidence }[] {
  requireBookText(book);
  const terms = query.split(/[\s，。？！、,:;]+/u).filter(x => x.length >= 2).slice(0, 6);
  if (!terms.length) return [];
  const hits: { text: string; evidence: Evidence; score: number }[] = [];
  // Only permitted slices are searched, so a query cannot reveal future matches or counts.
  for (const range of readableRanges(book, extra)) {
    const source = bookTextSlice(book,range.start, range.end);
    for (const term of terms) {
      let pos = source.indexOf(term), count = 0;
      while (pos >= 0 && count++ < 100) {
        const start = Math.max(range.start, range.start + pos - 180), end = Math.min(range.end, range.start + pos + term.length + 220);
        const text = readText(book, { start, end }, extra);
        hits.push({ text, evidence: evidence(book, { start, end }), score: terms.filter(t => text.includes(t)).length });
        pos = source.indexOf(term, pos + term.length);
      }
    }
  }
  const unique = hits.sort((a, b) => b.score - a.score || b.evidence.start - a.evidence.start).filter((h, i, all) => !all.slice(0, i).some(p => Math.abs(p.evidence.start - h.evidence.start) < 120));
  return unique.slice(0, limit);
}
/** Candidate navigation over actual permitted original coordinates; no stored summaries. */
export function searchOriginalHistory(book:Book,value:OriginalHistoryQuery,extra:Range[]=[]) {
  requireBookText(book);const request=parseOriginalHistoryQuery(value),order=request.order??'source-asc';
  if(request.range&&request.range.end>bookLength(book))throw Error('历史原文查询范围超出本书');
  const ranges=readableRanges(book,extra).map(r=>({start:Math.max(r.start,request.range?.start??r.start),end:Math.min(r.end,request.range?.end??r.end)})).filter(r=>r.end>r.start);
  const binding=JSON.stringify([book.id,book.version,request.query,order,request.range??null,ranges]);
  let offset=0;if(request.cursor){let c:unknown;try{c=JSON.parse(request.cursor);}catch{throw Error('原文续页游标无效');}const v=c as {binding:string;offset:number};if(!v||typeof v!=='object'||Object.keys(v).some(k=>!['binding','offset'].includes(k))||v.binding!==binding||!Number.isSafeInteger(v.offset)||v.offset<0)throw Error('原文续页条件或权限已变化，请按原条件重新查询');offset=v.offset;}
  const terms=request.query.split(/[\s，。？！、,:;]+/u).filter(x=>x.length>=2).slice(0,6),hits:{text:string;evidence:Evidence;score:number}[]=[];
  for(const range of ranges){const source=bookTextSlice(book,range.start,range.end);for(const term of terms){let pos=source.indexOf(term);while(pos>=0){const start=Math.max(range.start,range.start+pos-180),end=Math.min(range.end,range.start+pos+term.length+220),text=readText(book,{start,end},extra);hits.push({text,evidence:evidence(book,{start,end}),score:terms.filter(t=>text.includes(t)).length});pos=source.indexOf(term,pos+term.length);}}}
  hits.sort((a,b)=>order==='source-asc'?a.evidence.start-b.evidence.start||b.score-a.score:order==='source-desc'?b.evidence.start-a.evidence.start||b.score-a.score:b.score-a.score||a.evidence.start-b.evidence.start);
  const buckets=new Map<number,number[]>(),unique=hits.filter(h=>{const at=h.evidence.start,k=Math.floor(at/120);if([k-1,k,k+1].some(b=>(buckets.get(b)??[]).some(x=>Math.abs(x-at)<120)))return false;buckets.set(k,[...(buckets.get(k)??[]),at]);return true;});
  if(offset>unique.length)throw Error('原文续页游标超出当前结果');
  const items=unique.slice(offset,offset+5).map(({text,evidence})=>({text,evidence})),next=offset+items.length;
  return{items,total:unique.length,order,range:request.range,permittedRanges:ranges,...(next<unique.length?{nextCursor:JSON.stringify({binding,offset:next})}:{}),notice:'仅为本次许可与查询范围内的原文命中；坐标可用read_original展开，未命中或到页末不证明事件不存在。续页保留query/range/order和当前书版本、许可。'};
}
export function forgetMemory(state: State, memoryId: string): void {
  const m = state.memories.find(m => m.id === memoryId);
  if (!m) return;
  const originalText=requireMemoryText(m);
  const removed = new Set([memoryId]), chats = new Set(m.chatIds);
  for (const chat of state.chats) if (chat.bookId === m.bookId && normalize(chat.text).includes(normalize(originalText))) chats.add(chat.id);
  // Forgetting follows the full input lineage, even when model attribution is empty.
  // Alternate memory and chat edges until no indirect path remains usable.
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of state.memories) if (!removed.has(item.id) && ([...item.parents,...(item.formationSources?.memoryIds??[])].some(id => removed.has(id)) ||semanticReferenceIds(item).some(id=>removed.has(id))||item.correctionRepairSources?.memoryIds.some(id=>removed.has(id))||item.correctionRepairSources?.chatIds.some(id=>chats.has(id))||
      [...item.chatIds,...(item.formationSources?.chatIds??[]),...(item.historicalCommentIds??[])].some(id => chats.has(id)) || !!item.correctionOf && removed.has(item.correctionOf) || !!item.replacedBy && removed.has(item.replacedBy))) { removed.add(item.id); [...item.chatIds,...(item.historicalCommentIds??[])].forEach(id => chats.add(id)); changed = true; }
    for (const chat of state.chats) if (!chats.has(chat.id) && (chat.memoryIds?.some(id => removed.has(id)) || [...(chat.contextChatIds??[]),...(chat.historicalCommentIds??[])].some(id => chats.has(id)) || !!chat.replyTo && chats.has(chat.replyTo))) { chats.add(chat.id); changed = true; }
  }
  const texts=new Map(state.memories.filter(item=>removed.has(item.id)).map(item=>[item.id,requireMemoryText(item)]));
  for (const item of state.memories) if (removed.has(item.id)) {
    item.forgotten = true;
    if (!state.forgotten.some(f => f.id === item.id)) state.forgotten.push({ id: item.id, bookId: item.bookId, text: texts.get(item.id)!, time: Date.now(), chatIds: item.chatIds });
  }
  for (const chat of state.chats) if (chats.has(chat.id)) chat.excluded = true;
  if(state.readingDrafts)state.readingDrafts=state.readingDrafts.filter(d=>!d.material?.memoryIds.some(id=>removed.has(id))&&!d.material?.chatIds.some(id=>chats.has(id)));
  for(const q of state.queryCheckpoints??[]){
    q.acquired=q.acquired.filter(a=>a.kind==='memory'?!removed.has(a.id):a.kind==='chat'?!chats.has(a.id):true);
    if(q.status!=='consumed'&&(q.material?.memoryIds.some(id=>removed.has(id))||q.material?.partialMemoryIds?.some(id=>removed.has(id))||q.material?.chatIds.some(id=>chats.has(id)))){q.blockedReason='原问题结果涉及已遗忘来源，旧候选不能恢复提交';q.status='acquired';delete q.material;delete q.candidate;delete q.result;delete q.dependencyStamp;}
  }
  for(const task of state.tasks??[])for(const item of task.items)if(removed.has(item.memoryId)){delete item.reviewSources;if(item.reviewReady){delete item.reviewReady;item.reviewReadyInvalidated=true;}}
  const record = state.forgotten.find(f => f.id === memoryId)!; record.chatIds = [...new Set([...(record.chatIds ?? []), ...chats])];
  reconcileHabits(state);
}
export function deleteChat(state: State, id: string): void {
  if(state.chats.some(c=>c.id===id&&c.presentation==='paragraph')){
    for(const m of state.memories.filter(m=>!m.forgotten&&m.historicalCommentIds?.includes(id)))forgetMemory(state,m.id);
    for(const c of state.chats)if(c.historicalCommentIds?.includes(id))c.excluded=true;
  }
  for(const m of state.memories.filter(m=>!m.forgotten&&m.correctionRepairSources?.chatIds.includes(id)))forgetMemory(state,m.id);
  state.chats = state.chats.filter(c => c.id !== id);
  if(state.readingDrafts)state.readingDrafts=state.readingDrafts.filter(d=>!d.material?.chatIds.includes(id));
  if(state.queryCheckpoints)state.queryCheckpoints=state.queryCheckpoints.filter(q=>q.questionId!==id||q.status==='consumed');
  for(const q of state.queryCheckpoints??[]){q.acquired=q.acquired.filter(a=>a.kind!=='chat'||a.id!==id);if(q.material?.chatIds.includes(id)){q.blockedReason='问题来源交流已删除，旧结果不能恢复提交';q.status='acquired';delete q.material;delete q.candidate;delete q.result;delete q.dependencyStamp;}}
}
