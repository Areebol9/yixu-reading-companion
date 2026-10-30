import {bookVersionAllowsRanges} from './book-versions.ts';
import {requireMemoryText} from './memory-bodies.ts';
import { READING_MEMORY_LIMIT,isReadingDelivery } from './types.ts';
import { bookLength, chapterAt, covers, id, mergeRanges, normalize } from './books.ts';
import { isBackgroundMemory,isEvidenceAllowed, memorySources, usableMemories } from './context.ts';
import type { Book, Memory, MemoryKind, NarrativeNote, Range, ReadingRecord, State } from './types.ts';

/** Optional model annotation; never an authority to merge identities or change facts. */
export function parseNarrative(value: unknown, kind: MemoryKind): NarrativeNote | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  const categories = kind === 'story' ? ['event','relation','rule'] : kind === 'opinion' ? ['view'] : kind === 'question' ? ['thread'] : [];
  if (Object.keys(v).some(k => !['category','subjects','condition','storyTime'].includes(k)) || !categories.includes(v.category as string) ||
    !Array.isArray(v.subjects) || !v.subjects.length || v.subjects.length > 8 || v.subjects.some(s => typeof s !== 'string' || !s.trim() || s.length > 60) ||
    v.condition !== undefined && (typeof v.condition !== 'string' || v.condition.length > 240) || v.storyTime !== undefined && (typeof v.storyTime !== 'string' || v.storyTime.length > 160)) return;
  return { category: v.category as NarrativeNote['category'], subjects: [...new Set(v.subjects.map(s => s.trim()))],
    ...(typeof v.condition === 'string' && v.condition.trim() ? { condition: v.condition.trim() } : {}),
    ...(typeof v.storyTime === 'string' && v.storyTime.trim() ? { storyTime: v.storyTime.trim() } : {}) };
}

export function readingRecord(book: Book, partnerId: string, ranges: Range[], memoryIds: string[], background = false, preparation = false): ReadingRecord {
  return { id: id(), bookId: book.id, version: book.version, partnerId,
    source: background ? 'background' : preparation ? 'preparation' : 'reading', ranges: mergeRanges(ranges), memoryIds: [...new Set(memoryIds)], createdAt: Date.now() };
}

/** Navigation through material actually processed. Book position and actual
 * processing time stay distinct from fictional time; no claims are rewritten. */
export function stageReadings(state: State, book: Book, source: Memory['source'] = 'reading', extra: Range[] = [], limit = 3) {
  const available = new Map(usableMemories(state,book,extra).filter(m=>m.kind!=='context'&&
    isBackgroundMemory(m)===(source==='background')).map(m=>[m.id,m]));
  const all = new Map(state.memories.filter(m=>m.bookId===book.id&&m.partnerId===state.partnerId).map(m=>[m.id,m]));
  const resolve = (id:string):string|undefined=>{
    const seen=new Set<string>();let m=all.get(id);
    while(m&&!seen.has(m.id)){
      if(available.has(m.id))return m.id;
      if(m.kind==='context')return;
      seen.add(m.id);m=all.get(m.replacedBy??'');
    }
  };
  const records=(state.readings??[]).filter(r=>r.bookId===book.id&&bookVersionAllowsRanges(book,r.version,r.ranges)&&r.partnerId===state.partnerId&&
    r.processing!=='layout'&&(r.source==='background')===(source==='background')&&
    isEvidenceAllowed(book,r.ranges.map(p=>({...p,bookId:book.id,version:book.version})),extra)&&
    r.ranges.every(p=>covers(r.source==='background'?book.backgroundPrepared??[]:book.prepared,p)))
    .sort((a,b)=>Math.max(...b.ranges.map(r=>r.end))-Math.max(...a.ranges.map(r=>r.end))||b.createdAt-a.createdAt).slice(0,limit).reverse();
  return records.map(r=>{
    const indexes=[...new Set(r.ranges.flatMap(p=>[chapterAt(book,p.start).index,chapterAt(book,p.end-1).index]))].sort((a,b)=>a-b);
    return {source:r.source,processedAt:r.createdAt,ranges:r.ranges.map(p=>({...p})),chapters:indexes.map(index=>{
      const c=book.chapters[index],title=covers([...book.known,...extra],{start:c.start,end:c.start+c.title.length})?c.title:`文件内第${index+1}个章节`;
      return{index,title};
    }),memoryIds:[...new Set(r.memoryIds.flatMap(id=>{const current=resolve(id);return current?[current]:[];}))]};
  });
}

/** Records describe material actually processed, not a second copy of its claims.
 * Resolve references through revisions at the caller's permitted reading stage. */
export function narrativeIndex(state: State, book: Book, eligible: Memory[], extra: Range[] = []) {
  const available = new Map(eligible.map(m => [m.id, m]));
  const all = new Map(state.memories.filter(m => m.bookId === book.id && m.partnerId === state.partnerId).map(m => [m.id, m]));
  const membership = new Map<string, Set<number>>(), coverage = new Map<number, Range[]>();
  const chaptersFor = (ranges: Range[]) => new Set(ranges.flatMap(r => book.chapters.filter(c => c.start < r.end && c.end > r.start).map(c => c.index)));
  const add = (memoryId: string, chapters: Set<number>) => {
    const prior = membership.get(memoryId) ?? new Set<number>();
    for (const chapter of chapters) prior.add(chapter);
    membership.set(memoryId, prior);
  };
  const resolve = (memoryId: string): Memory | undefined => {
    const seen = new Set<string>(); let memory = all.get(memoryId);
    while (memory && !seen.has(memory.id)) {
      if (available.has(memory.id)) return memory;
      if(memory.kind==='context')return; // A later scene is not a summary of this chapter.
      seen.add(memory.id); memory = all.get(memory.replacedBy ?? '');
    }
  };
  for (const record of state.readings ?? []) {
    if (record.bookId !== book.id || !bookVersionAllowsRanges(book,record.version,record.ranges) || record.partnerId !== state.partnerId ||
      !isEvidenceAllowed(book, record.ranges.map(r => ({ ...r, bookId: book.id, version: book.version })), extra) ||
      record.ranges.some(r => !covers(record.source === 'background' ? book.backgroundPrepared ?? [] : book.prepared, r))) continue;
    const chapters = chaptersFor(record.ranges);
    for (const chapter of chapters) {
      const c = book.chapters[chapter];
      const parts = record.ranges.map(r => ({ start: Math.max(c.start, r.start), end: Math.min(c.end, r.end) })).filter(r => r.end > r.start);
      coverage.set(chapter, mergeRanges([...(coverage.get(chapter) ?? []), ...parts]));
    }
    for (const memoryId of record.memoryIds) { const memory = resolve(memoryId); if (memory) add(memory.id, chapters); }
  }
  // Legacy memories retain precise original anchors; no invented preparation receipts.
  for (const memory of eligible) add(memory.id, chaptersFor(memorySources(memory)));
  // Later partial answers also belong to the earlier question's navigation entry.
  // Eligibility was already filtered by reading scope; this never moves their
  // evidence or makes a later answer usable at an earlier stage.
  for (const memory of eligible) if (memory.answersPartOf) {
    const target = resolve(memory.answersPartOf);
    if (target) add(memory.id,membership.get(target.id) ?? new Set<number>());
  }
  return { membership, coverage };
}

export function chapterContext(state: State, book: Book, memories: Memory[], current: Range, extra: Range[] = []) {
  const index = narrativeIndex(state, book, memories, extra), focus = chapterAt(book, Math.max(0, current.end - 1)).index;
  const chapters = new Set([focus, ...[...index.membership.values()].flatMap(values => [...values])]);
  return [...chapters].sort((a, b) => Math.abs(a - focus) - Math.abs(b - focus)).slice(0, 6).map(chapterIndex => {
    const c = book.chapters[chapterIndex];
    const title = covers([...book.known, ...extra], { start: c.start, end: c.start + c.title.length }) ? c.title : `文件内第${chapterIndex + 1}个章节`;
    const ranges = index.coverage.get(chapterIndex) ?? [];
    return { chapterIndex, title, current: chapterIndex === focus, processedRanges: ranges.slice(-8), moreRanges: ranges.length > 8,
      memoryIds: memories.filter(m => index.membership.get(m.id)?.has(chapterIndex)).map(m => m.id) };
  });
}

export function narrativeTerms(memory: Memory): string {
  const n = memory.narrative,body=requireMemoryText(memory);
  const text = memory.stateProjection ? body + '\n' + memory.stateProjection.topic : memory.arcProjection?body+'\n'+memory.arcProjection.label:body;
  return n ? [text, ...n.subjects, n.condition ?? '', n.storyTime ?? ''].join('\n') : text;
}
export function subjectOverlap(memory: Memory, query: string): number {
  const value = normalize(query);
  return memory.narrative?.subjects.filter(s => value.includes(normalize(s))).length ?? 0;
}

export function validateNarrativeState(state: State): void {
  for (const memory of state.memories) if (memory.narrative !== undefined && !parseNarrative(memory.narrative, memory.kind)) throw new Error('章节认识标注无效');
  for (const memory of state.memories) if (memory.readingStage !== undefined &&
    (!Array.isArray(memory.readingStage) || !memory.readingStage.length || memory.readingStage.length > 5000 ||
      memory.readingStage.some(r => !r || !Number.isSafeInteger(r.start) || !Number.isSafeInteger(r.end) || r.start < 0 || r.end <= r.start || !covers(memory.evidence,r)))) throw new Error('认识形成阶段无效');
  if (state.readings !== undefined && (!Array.isArray(state.readings) || state.readings.length > 100000)) throw new Error('章节材料记录无效');
  const seen = new Set<string>(), memories = new Map(state.memories.map(m => [m.id, m]));
  for (const r of state.readings ?? []) {
    const book = state.books.find(b => b.id === r?.bookId);
    if (!book || typeof r.id !== 'string' || !r.id || seen.has(r.id) || !bookVersionAllowsRanges(book,r.version,r.ranges??[]) || !state.partners.some(p => p.id === r.partnerId) ||
      !['reading','preparation','background'].includes(r.source) || !Array.isArray(r.ranges) || !r.ranges.length || r.ranges.length > 5000 ||
      r.arcCandidate!==undefined&&r.arcCandidate!=='v1'||r.worldCandidate!==undefined&&r.worldCandidate!=='v1'||r.processing==='layout'&&(r.arcCandidate!==undefined||r.worldCandidate!==undefined)||
      r.expressionContract!==undefined&&(r.expressionContract!=='paragraph-expressions-v1'||r.source!=='reading'||r.processing!=='model')||r.expressionOnly!==undefined&&(r.expressionOnly!==true||r.source!=='reading'||r.processing!=='model') || r.processing !== undefined && !['model','layout'].includes(r.processing) ||r.delivery!==undefined&&(!isReadingDelivery(r.delivery)||r.processing==='layout')||
      r.draftId !== undefined && (typeof r.draftId!=='string'||!r.draftId||r.draftId.length>128) ||
      r.ranges.some(p => !p || !Number.isSafeInteger(p.start) || !Number.isSafeInteger(p.end) || p.start < 0 || p.end <= p.start || p.end > bookLength(book)) ||
      !Array.isArray(r.memoryIds) || r.memoryIds.length > READING_MEMORY_LIMIT || r.memoryIds.some(id => typeof id !== 'string' || !id || !memories.has(id) || memories.get(id)!.bookId !== book.id || memories.get(id)!.partnerId !== r.partnerId) ||
      !Number.isFinite(r.createdAt) || r.createdAt < 0) throw new Error('章节材料范围或引用无效');
    seen.add(r.id);
  }
}
