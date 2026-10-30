import {bookVersionAllowsRanges} from './book-versions.ts';
import {requireMemoryText} from './memory-bodies.ts';
import { covers, mergeRanges } from './books.ts';
import { evidence, isBackgroundMemory, isEvidenceAllowed, memorySources, readableParts } from './context.ts';
import { recallTerms } from './recall-terms.ts';
import { currentStates, permittedStages } from './stage-state.ts';
import type { Book, Evidence, Memory, Range, State,StateProjection,ArcProjection } from './types.ts';

/** A stage is replaced by original text only when every covered span was shown.
 * A matching quote, neighbouring excerpt or the last coordinate is insufficient. */
export function stageCoveredByOriginal(memory: Memory, provided: Range[]): boolean {
  return memory.kind === 'stage' && !!memory.stageNarrative?.ranges.length &&
    memory.stageNarrative.ranges.every(range => covers(mergeRanges(provided), range));
}

/** Store full parts once; expose only offsets into the actually supplied
 * complete state text. This is display metadata, never a clipped basis. */
export function stateProjectionMaterial(text:string,projection:StateProjection|undefined){
  if(!projection)return;
  if(projection.writeVersion!==2)return projection;
  let offset=0;
  const parts=(projection.parts??[]).map(part=>{
    const textStart=offset,textEnd=textStart+part.text.length;offset=textEnd+1;
    if(text.slice(textStart,textEnd)!==part.text)throw Error('状态部件与完整正文不一致，未提供不完整基态');
    return{id:part.id,textStart,textEnd,memoryRef:part.memoryRef,sourceEvidence:part.sourceEvidence};
  });
  const end=projection.end?{textStart:0,textEnd:text.length,sourceEvidence:projection.end.sourceEvidence}:undefined;
  return{...projection,parts,end};
}

function sourceRangeTable(sourceScope:Pick<Evidence,'bookId'|'version'>){
  const sourceRanges: (Range & { bookId?: string; version?: string })[] = [];
  const sourceSlots = new Map<string, number>();
  const indexes = (sources: Evidence[]) => sources.map(e => {
    const range = e.bookId === sourceScope.bookId && e.version === sourceScope.version
      ? { start: e.start, end: e.end } : { start: e.start, end: e.end, bookId: e.bookId, version: e.version };
    const key = JSON.stringify([e.bookId, e.version, e.start, e.end]);
    let index = sourceSlots.get(key);
    if (index === undefined) { index = sourceRanges.length; sourceRanges.push(range); sourceSlots.set(key, index); }
    return index;
  });
  return{sourceScope,sourceRanges,indexes};
}

function arcProjectionMaterial(text:string,projection:ArcProjection|undefined,indexes:(sources:Evidence[])=>number[]){
  let arcOffset=0;
  return projection?{...projection,parts:projection.parts.map(part=>{const textStart=arcOffset,textEnd=textStart+part.text.length;arcOffset=textEnd+1;if(text.slice(textStart,textEnd)!==part.text)throw Error('弧线部件与正文不一致');return{id:part.id,role:part.role,textStart,textEnd,memoryRef:part.memoryRef,sourceEvidence:part.sourceEvidence?indexes(part.sourceEvidence):undefined,impact:part.impact};}),end:projection.end?{textStart:arcOffset,textEnd:text.length,sourceEvidence:indexes(projection.end.sourceEvidence)}:undefined}:undefined;
}

/** The same complete arc display also accepts review inputs without creating a Memory. */
export function arcMaterial(text:string,projection:ArcProjection,scope:Pick<Evidence,'bookId'|'version'>,exposure:Evidence[]){
  const{sourceScope,sourceRanges,indexes}=sourceRangeTable(scope);
  const arcProjection=arcProjectionMaterial(text,projection,indexes)!;
  const knowledge=indexes(exposure),references=indexes([...projection.parts.flatMap(p=>p.sourceEvidence??[]),...(projection.end?.sourceEvidence??[])]);
  return{arcProjection,knowledge,sourceScope,sourceRanges,references};
}

export function narrativeMaterial(memory: Memory) {
  const body=requireMemoryText(memory);
  const scope = memory.evidence.find(e => e.bookId === memory.bookId);
  if (!scope) throw Error('阶段或状态缺少本书版本来源，未提供不完整资料');
  const{sourceScope,sourceRanges,indexes}=sourceRangeTable({bookId:scope.bookId,version:scope.version});
  const projection = stateProjectionMaterial(body, memory.stateProjection);
  const stateProjection = projection?.writeVersion === 2 ? { ...projection,
    parts: projection.parts?.map(part => ({ ...part, sourceEvidence: part.sourceEvidence ? indexes(part.sourceEvidence) : undefined })),
    end: projection.end ? { ...projection.end, sourceEvidence: indexes(projection.end.sourceEvidence) } : undefined
  } : projection;
  const arcProjection=arcProjectionMaterial(body,memory.arcProjection,indexes);
  const knowledge=arcProjection?indexes(memory.evidence):undefined;
  const references = indexes(memorySources(memory));
  return { id: memory.id, kind: memory.kind, text: body,
    origin: isBackgroundMemory(memory) ? 'background' : memory.source,
    readingStage: memory.readingStage, stageNarrative: memory.stageNarrative,
    stateProjection, stateChangeOf: memory.stateChangeOf, ...(arcProjection?{arcProjection,arcChangeOf:memory.arcChangeOf,knowledge}:{}), sourceScope, sourceRanges, references };
}

export type NarrativeMaterial = ReturnType<typeof narrativeMaterial>;
/** Resolve original-text coordinates only. memoryRef offsets address memory text. */
export function narrativeSourceRanges(material: Pick<NarrativeMaterial, 'sourceScope' | 'sourceRanges' | 'references'>, indexes: readonly number[] = material.references): Evidence[] {
  return indexes.map(index => {
    const range = material.sourceRanges[index];
    if (!Number.isSafeInteger(index) || !range) throw Error('阶段或状态出处索引无效');
    return { start: range.start, end: range.end, bookId: range.bookId ?? material.sourceScope.bookId, version: range.version ?? material.sourceScope.version };
  });
}

export function narrativeIndexItem(memory: Memory) {
  if(memory.kind==='arc'&&memory.arcProjection)return{id:memory.id,kind:'arc' as const,arcId:memory.arcProjection.arcId,label:memory.arcProjection.label,status:memory.arcProjection.status,...(memory.invalidatedBy||memory.reviewDisposition==='unsupported'?{availability:'needs-review' as const}:{})};
  if (memory.kind === 'state' && memory.stateProjection) return { id: memory.id, kind: 'state' as const,
    topic: memory.stateProjection.topic, status: memory.stateProjection.status,
    writeVersion: memory.stateProjection.writeVersion, readingStage: memory.readingStage };
  if (memory.kind === 'stage' && memory.stageNarrative) return { id: memory.id, kind: 'stage' as const,
    ranges: memory.stageNarrative.ranges, continues: memory.stageNarrative.continues };
  throw Error('仅阶段或状态提供轻目录');
}
export type NarrativeIndexItem = ReturnType<typeof narrativeIndexItem>;
export type NarrativeMaterialIndex = { items: NarrativeIndexItem[]; hasMore: boolean };

/** Pure conservative request-local IDs: sizing never exposes a real candidate. */
export function displaySizeMaterial<T extends { id: string }>(item: T): T {
  const result = structuredClone(item) as T & { stateChangeOf?: string; stageNarrative?: { previousStageId?: string }; stateProjection?: { parts?: { id: string; memoryRef?: { memoryId: string } }[] } };
  result.id = 'm99999';
  const world=result as any;
  for(const item of world.about??[])item.entityId='e99999';
  if(world.identityClaim){world.identityClaim.entityId='e99999';if(world.identityClaim.targetId)world.identityClaim.targetId='e99999';if(world.identityClaim.speakerId)world.identityClaim.speakerId='e99999';if(world.identityClaim.changeOf)world.identityClaim.changeOf='m99999';}
  if(world.attribution){world.attribution.holderId='e99999';if(world.attribution.speakerId)world.attribution.speakerId='e99999';if(world.attribution.contentRef)world.attribution.contentRef.memoryId='m99999';}
  for(const link of world.ruleLinks??[])link.memoryId='m99999';
  for(const binding of world.entityBindings??[]){binding.entityId='e99999';binding.memoryId='m99999';}
  if(world.worldChangeOf)world.worldChangeOf='m99999';

  const arc=(result as any).arcProjection;if(arc){arc.arcId='m99999';for(const part of arc.parts??[]){part.id='s99999';if(part.memoryRef)part.memoryRef.memoryId='m99999';if(part.impact)for(const key of ['sourceArcId','sourceVersionId','targetArcId','targetVersionId'])part.impact[key]='m99999';}}
  if((result as any).arcId)(result as any).arcId='m99999';if((result as any).arcChangeOf)(result as any).arcChangeOf='m99999';
  if (result.stateChangeOf) result.stateChangeOf = 'm99999';
  if (result.stageNarrative?.previousStageId) result.stageNarrative.previousStageId = 'm99999';
  for (const part of result.stateProjection?.parts ?? []) {
    part.id = 's99999'; if (part.memoryRef) part.memoryRef.memoryId = 'm99999';
  }
  return result;
}
export function narrativeMaterialChars(memory: Memory, view: 'index' | 'full' = 'full'): number {
  return JSON.stringify(displaySizeMaterial(view === 'index' ? narrativeIndexItem(memory) : narrativeMaterial(memory))).length;
}
export function narrativePacketChars(stages: Memory[], states: Memory[], index: NarrativeMaterialIndex): number {
  return JSON.stringify({ stageNarratives: stages.map(m => displaySizeMaterial(narrativeMaterial(m))),
    currentStates: states.map(m => displaySizeMaterial(narrativeMaterial(m))),
    narrativeIndex: { items: index.items.map(displaySizeMaterial), hasMore: index.hasMore } }).length;
}

/** Whole prose records within a bounded input budget. Filtering and pointer
 * visibility belong to the shared core queries, before selection or counts. */
export function selectStageMaterials(state: State, book: Book, provided: Range[], options: {
  source?: Memory['source']; extra?: Range[]; charBudget?: number; focusRanges?: Range[]; query?: string;
} = {}) {
  const budget = options.charBudget ?? 3600, query = { source: options.source ?? 'reading', extra: options.extra ?? [] };
  const stages: Memory[] = [], states: Memory[] = [], index: NarrativeMaterialIndex = { items: [], hasMore: false };
  const add = (list: Memory[], memory: Memory) => {
    if(typeof memory.text!=='string')return;
    const nextStages = list === stages ? [...stages, memory] : stages, nextStates = list === states ? [...states, memory] : states;
    if (narrativePacketChars(nextStages, nextStates, index) > budget) return;
    list.push(memory);
  };
  // Whole current states take the same total budget first; no half-quota can
  // hide a complete condition behind optional stage prose or navigation.
  const stateCandidates = currentStates(state, book, query);
  const focus = options.focusRanges ?? [];
  const suppliedFocus = mergeRanges(focus.flatMap(r => provided.map(p => ({ start: Math.max(r.start, p.start), end: Math.min(r.end, p.end) })).filter(r => r.end > r.start)))
    .flatMap(r => readableParts(book, r, options.extra ?? []));
  const words = recallTerms(suppliedFocus.map(r => book.text.slice(r.start, r.end)).join('\n') + '\n' + (options.query ?? ''));
  const indexed = stateCandidates.map(memory => ({ memory, words: recallTerms(typeof memory.text==='string'?memory.stateProjection!.topic + '\n' + memory.text:memory.stateProjection!.topic) }));
  const frequency = new Map<string, number>();
  for (const item of indexed) for (const word of item.words) if (words.has(word)) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  const boundary = suppliedFocus.length ? Math.min(...suppliedFocus.map(r => r.start)) : undefined;
  const batches = (state.readings ?? []).filter(r => r.bookId === book.id && bookVersionAllowsRanges(book,r.version,r.ranges) && r.partnerId === state.partnerId &&
    (r.source === 'background') === (query.source === 'background') && r.processing !== 'layout' && r.ranges.length &&
    boundary !== undefined && r.ranges.every(p => p.end <= boundary) && isEvidenceAllowed(book, r.ranges.map(p => evidence(book, p)), options.extra ?? []));
  const latestEnd = Math.max(-1, ...batches.map(r => Math.max(...r.ranges.map(p => p.end))));
  const recent = batches.filter(r => Math.max(...r.ranges.map(p => p.end)) === latestEnd).flatMap(r => r.ranges);
  const overlaps = (a: Range, b: Range) => a.start < b.end && b.start < a.end;
  const ranked = indexed.map(item => {
    const hits = [...item.words].filter(w => words.has(w) && (frequency.get(w) ?? 0) < Math.max(2, Math.ceil(indexed.length * .6)));
    const score = hits.reduce((n, w) => n + Math.log(1 + indexed.length / (frequency.get(w) ?? 1)), 0) / Math.sqrt(Math.max(8, item.words.size));
    const precise = [...(item.memory.sourceEvidence ?? []), ...(item.memory.sourceQuote ? [item.memory.sourceQuote.evidence] : []),
      ...(item.memory.stateProjection?.parts ?? []).flatMap(p => p.sourceEvidence ?? [])];
    const nearby = [...(item.memory.readingStage ?? []), ...precise].some(r => recent.some(p => overlaps(r, p)));
    const tier = score > 0 ? item.memory.stateProjection!.status === 'active' && nearby ? 0 : 1 : 2;
    const lastStage = Math.max(-1, ...(item.memory.readingStage ?? []).map(r => r.end));
    return { ...item, score, tier, lastStage };
  }).sort((a, b) => a.tier - b.tier || b.score - a.score || b.lastStage - a.lastStage || a.memory.id.localeCompare(b.memory.id));
  // Reserve an unabridged navigation entry when a relevant full head cannot
  // fit, before unrelated background prose consumes the same budget.
  const addIndex = (memory: Memory) => {
    const item = narrativeIndexItem(memory), next = { items: [...index.items, item], hasMore: false };
    if (narrativePacketChars(stages, states, next) > budget) return;
    index.items.push(item);
  };
  for (const item of ranked.filter(r => r.tier < 2)) {
    add(states, item.memory);
    if (!states.some(m => m.id === item.memory.id)) addIndex(item.memory);
  }
  for (const item of ranked.filter(r => r.tier === 2)) add(states, item.memory);
  const stageCandidates = permittedStages(state, book, query).filter(m => !stageCoveredByOriginal(m, provided));
  for (const memory of [...stageCandidates].reverse()) add(stages, memory);
  const full = new Set([...states, ...stages].map(m => m.id));
  const omitted = [...ranked.map(r => r.memory), ...stageCandidates].filter(m => !full.has(m.id));
  for (const memory of omitted) if (!index.items.some(m => m.id === memory.id)) addIndex(memory);
  index.hasMore = index.items.length < omitted.length;
  const selected = new Set(stages.map(m => m.id));
  const ordered = stageCandidates.filter(m => selected.has(m.id));
  return { stages: ordered, states, records: [...ordered, ...states], index, chars: narrativePacketChars(ordered, states, index) };
}
