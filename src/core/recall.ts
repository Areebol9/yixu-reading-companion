import {documentScope} from './book-document-ownership.ts';
import {entityMemories,permittedWorldMemories,visibleWorldMemory,worldNote} from './world-identity.ts';
import {currentArcs,permittedArcs} from './arc-state.ts';
import { normalize } from './books.ts';
import { currentQuestion,usableMemories, memorySources, readableParts,isEvidenceAllowed,isBackgroundMemory } from './context.ts';
import { narrativeIndex, narrativeTerms, subjectOverlap } from './narrative.ts';
import {historicalReadingBriefs} from './reading-brief.ts';
import {canDevelopMemory} from './memory-plan.ts';
import {currentStates,permittedStages,permittedStates} from './stage-state.ts';
import {narrativeMaterialChars} from './stage-materials.ts';
import {recallTerms} from './recall-terms.ts';
import {visibleSemanticMemory,semanticMaterial} from './semantic-material.ts';
import {chatBelongsToPartner} from './discussion-recall.ts';
export {recallTerms} from './recall-terms.ts';
import type { Book, Memory, MemoryQuery, Range, State, ReadingStrategy,ArcCandidate,OpinionIndexNavigation,OrdinaryMemoryIndex } from './types.ts';

import {strategyMemoryAllowed,structureMaterialPool,readStructureRelations,projectStructureRelations} from './structure-relations.ts';
import type {StructureRelationIndex} from './structure-relations.ts';
export {strategyMemoryAllowed} from './structure-relations.ts';

const cache = new Map<string, { text: string; terms: Set<string> }>();
function indexedText(memory:Memory):string {
  // A missing body is searched explicitly through metadata only, never as an empty body.
  if(typeof memory.text==='string')return narrativeTerms(memory);
  return [memory.documentTitle,...(memory.navigationCues??[]),...(memory.narrative?.subjects??[]),memory.narrative?.condition,memory.narrative?.storyTime,memory.stateProjection?.topic,memory.arcProjection?.label].filter((v):v is string=>typeof v==='string').join('\n');
}
function fullText(memory:Memory):string {if(typeof memory.text!=='string')throw Error('阅读档案正文尚未载入，请通过全文展开取得');return memory.text;}

function literalOpinionMatch(text:string,query:string):OrdinaryMemoryIndex['match']{
  let needle=query.normalize('NFKC').toLowerCase().trim();if(!needle)return;
  const normalized=text.normalize('NFKC').toLowerCase();let at=normalized.indexOf(needle);
  if(at<0){for(const term of recallTerms(needle)){const hit=normalized.indexOf(term);if(hit>=0){needle=term;at=hit;break;}}}if(at<0)return;
  // Prefix lengths map NFKC expansions/compositions to original UTF16 offsets.
  // Mark clusters and adjacent Hangul jamo stay together; boundaries never split a pair.
  const boundaries=[0];let offset=0,previousJamo=false;
  const jamo=(value:string)=>{const n=value.normalize('NFKC').codePointAt(0)!;return n>=0x1100&&n<=0x11ff||n>=0xa960&&n<=0xa97f||n>=0xd7b0&&n<=0xd7ff;};
  for(const character of text){const currentJamo=jamo(character);if(offset&&!/\p{Mark}/u.test(character.normalize('NFKC'))&&!(previousJamo&&currentJamo))boundaries.push(offset);offset+=character.length;previousJamo=currentJamo;}boundaries.push(text.length);
  const length=(i:number)=>text.slice(0,boundaries[i]).normalize('NFKC').toLowerCase().length;
  let low=0,high=boundaries.length-1;while(low<high){const mid=Math.ceil((low+high)/2);if(length(mid)<=at)low=mid;else high=mid-1;}const hitStart=boundaries[low];
  low=0;high=boundaries.length-1;while(low<high){const mid=Math.floor((low+high)/2);if(length(mid)>=at+needle.length)high=mid;else low=mid+1;}const hitEnd=boundaries[low];
  let start=Math.max(0,hitStart-Math.min(80,Math.max(0,Math.floor((200-(hitEnd-hitStart))/2)))),end=Math.min(text.length,start+200);start=Math.max(0,Math.min(start,end-200));
  const split=(n:number)=>n>0&&n<text.length&&text.charCodeAt(n)>=0xdc00&&text.charCodeAt(n)<=0xdfff&&text.charCodeAt(n-1)>=0xd800&&text.charCodeAt(n-1)<=0xdbff;
  if(split(start))start--;if(split(end))end++;
  return{textStart:start,textEnd:end,text:text.slice(start,end)};
}
/** A navigation projection only; it never supplies complete-record authority. */
export function ordinaryMemoryIndex(memory:Memory,query?:string,navigation?:OpinionIndexNavigation,history=false):OrdinaryMemoryIndex{
  const result:OrdinaryMemoryIndex&{scope?:Memory['scope'];partnerId:string}={id:memory.id,kind:memory.kind,scope:memory.scope,partnerId:memory.partnerId,readingStage:memory.readingStage,...(history?{history:true}: {})};
  if(memory.kind!=='opinion'||!navigation)return result;
  if(isBackgroundMemory(memory))result.origin='background';
  if(typeof memory.text==='string'&&navigation.currentUnderstanding?.id===memory.id&&navigation.currentUnderstanding.text===memory.text)result.currentAlreadyProvided=true;
  if(query&&typeof memory.text==='string'){const match=literalOpinionMatch(memory.text,query);if(match)result.match=match;}
  return result;
}

/** First-packet selection and analysis recall share the exact current, permitted source lane. */
export function analysisCandidatePool(state:State,book:Book,options:{source?:Memory['source'];extra?:Range[];readingStrategy?:ReadingStrategy;arcCandidate?:ArcCandidate;worldCandidate?:'v1'}={}){
  return structureMaterialPool(state,book,options);
}
function memoryTerms(memory: Memory): Set<string> {
  const text = indexedText(memory);
  const previous = cache.get(memory.id);
  if (previous?.text === text) return previous.terms;
  const result = recallTerms(text); cache.set(memory.id, { text, terms: result });
  if (cache.size > 5000) cache.delete(cache.keys().next().value!);
  return result;
}

/** One-hop linkage, using permitted candidates only. Query wording can match the
 * question while the newly revealed answer uses completely different words. */
function connectPartialAnswers<T extends {memory:Memory;score:number}>(items:T[]):T[] {
  const initial = new Map(items.map(item=>[item.memory.id,item]));
  const scores = new Map(items.map(item=>[item.memory.id,item.score]));
  for (const item of items) if (item.memory.answersPartOf) {
    const question = initial.get(item.memory.answersPartOf);
    if (!question || question.memory.kind !== 'question') continue;
    scores.set(item.memory.id,Math.max(scores.get(item.memory.id)!,question.score * .8));
    scores.set(question.memory.id,Math.max(scores.get(question.memory.id)!,item.score * .6));
  }
  return items.map(item=>({...item,score:scores.get(item.memory.id)!}));
}

/** Local, book-scoped search. Filter permissions before matching, counting or paging. */
export function searchMemories(state: State, book: Book, request: MemoryQuery, extra: Range[] = [], source: Memory['source'] = 'reading',strategy:ReadingStrategy='structured',scope:{analysis?:boolean;arcCandidate?:ArcCandidate;worldCandidate?:'v1';relationHistoryIds?:readonly string[];opinionNavigation?:OpinionIndexNavigation}={}): { items: Memory[]; total: number; nextOffset?: number;relations?:StructureRelationIndex;historicalIds?:string[];remainingIds?:string[];unavailableIds?:string[];unloadedBodyIds?:string[];searchScope?:'metadata-and-loaded-bodies';searchedKinds?:Memory['kind'][];documentScope?:'book-and-current-partner' } {
  if (request.view !== undefined && (strategy!=='companion'&&!['stage','state','arc'].includes(request.kind ?? '')&&!request.entityIds&&!request.relations || !['index','full'].includes(request.view))) throw Error('轻目录仅用于结构或关系检索');
  const relationScope={source,extra,readingStrategy:strategy,arcCandidate:scope.arcCandidate,worldCandidate:scope.worldCandidate};
  if(request.relations){
    if(!scope.analysis||strategy==='full-original'||!request.ids?.length&&!request.entityIds?.length)throw Error('作品关系须从本轮已提供的认识或主体入口读取');
    const page=readStructureRelations(state,book,request, {...relationScope,offset:request.offset,query:request.query}),items:Memory[]=[];let chars=JSON.stringify(page.index).length;
    if(request.view==='full')for(const m of page.records){const size=['stage','state','arc'].includes(m.kind)?narrativeMaterialChars(m):fullText(m).length+JSON.stringify({...worldNote(m),...semanticMaterial(m)}).length;if(items.length>=8||(strategy!=='companion'||items.length>0)&&chars+size>4000)continue;items.push(m);chars+=size;}
    else items.push(...page.records);
    return{items,total:page.index.total,nextOffset:page.index.nextOffset,relations:{...page.index,...(request.view==='full'?{missingBodyIds:page.records.filter(m=>!items.some(x=>x.id===m.id)).map(m=>m.id)}:{})},historicalIds:page.historicalIds};
  }
  const query = (request.query ?? '').normalize('NFKC').toLowerCase().trim(), words = recallTerms(query);
  const narrativeOptions={source,extra};
  // Legacy ordinary recall can include explicitly authorized background material.
  // Identity/attribution metadata retains its stricter source-lane contract.
  const hasWorld=(m:Memory)=>Object.keys(worldNote(m)).length>0||!!m.entityBindings?.length||!!m.temporal||!!m.clue;
  const history=strategy==='companion'&&(request.worldView==='history'||!!request.ids)?permittedWorldMemories(state,book,{source,extra,history:true}).filter(m=>!hasWorld(m)):[];
  const ordinary=[...new Map([...history,...usableMemories(state,book,extra).filter(m=>!hasWorld(m)),...permittedWorldMemories(state,book,{source,extra,history:request.worldView==='history'||!!request.ids}).filter(hasWorld)].map(m=>[m.id,m])).values()].filter(m=>m.kind!=='stage'&&m.kind!=='state'&&m.kind!=='arc');
  const samePool=scope.analysis&&!request.kind&&!request.ids&&!request.entityIds&&request.worldView!=='history'&&request.stateView!=='history'&&request.arcView!=='history';
  const companionStages=strategy==='companion'&&request.kind==='stage';
  const stageCandidates=[...permittedStages(state,book,narrativeOptions),...(companionStages?ordinary.filter(memory=>memory.kind==='opinion'&&documentScope(memory)==='book'&&isBackgroundMemory(memory)===(source==='background')):[])];
  const eligible = request.entityIds?entityMemories(state,book,request.entityIds,{source,extra,history:request.worldView==='history'}):strategy==='full-original'?usableMemories(state,book,extra).filter(m=>strategyMemoryAllowed(state,m,strategy)):request.kind==='context'?historicalReadingBriefs(state,book,extra):request.kind==='stage'?stageCandidates:request.kind==='arc'?(request.arcView==='history'||request.ids?permittedArcs:currentArcs)(state,book,narrativeOptions):request.kind==='state'?(request.stateView==='history'||request.ids?permittedStates:currentStates)(state,book,narrativeOptions):request.ids?[...ordinary,...permittedStages(state,book,narrativeOptions),...permittedStates(state,book,narrativeOptions),...permittedArcs(state,book,narrativeOptions)]:samePool?analysisCandidatePool(state,book,{source,extra,readingStrategy:strategy,arcCandidate:scope.arcCandidate,worldCandidate:scope.worldCandidate}).all:ordinary;
  const relationGraph=request.ids&&scope.relationHistoryIds?.length?projectStructureRelations(state,book,relationScope):undefined;
  const historicalGranted=relationGraph?request.ids!.filter(id=>scope.relationHistoryIds!.includes(id)&&relationGraph.memories.has(id)&&relationGraph.edges.some(e=>e.ownerId===id||e.from.kind==='memory'&&e.from.id===id||e.to.kind==='memory'&&e.to.id===id)).map(id=>relationGraph.memories.get(id)!):[];
  const versions=new Map(state.memories.map(m=>[m.id,m]));
  const requested=request.ids&&new Set(request.ids.map(id=>currentQuestion(state,book,id,extra,versions)?.id??id));
  const membership = request.chapterIndex !== undefined ? narrativeIndex(state, book, eligible, extra).membership : undefined;
  // Score linked, permitted questions and answers before filtering the output
  // kind. An old question can be found through a name revealed in its answer.
  const candidates = [...eligible,...historicalGranted.filter(m=>!eligible.some(x=>x.id===m.id))].filter(m => strategy==='full-original'||(request.kind === 'context' ? m.kind === 'context' : m.kind !== 'context'));
  const ranked = connectPartialAnswers(candidates.map(memory => {
    const text = indexedText(memory).normalize('NFKC').toLowerCase(), indexed = memoryTerms(memory);
    let score = query && text.includes(query) ? 2 : 0;
    for (const word of words) if (indexed.has(word)) score += 1 / Math.max(1, words.size);
    return { memory, score };
  })).filter(({ memory, score }) => (!query || score > 0) && (!requested || requested.has(memory.id)) &&
    (!request.kind || memory.kind === request.kind || companionStages&&memory.kind==='opinion'&&documentScope(memory)==='book') && (request.chapterIndex === undefined || membership?.get(memory.id)?.has(request.chapterIndex)))
    .sort((a, b) => request.kind==='stage'&&!companionStages?Math.min(...(a.memory.stageNarrative?.ranges??a.memory.readingStage??[]).map(r=>r.start))-Math.min(...(b.memory.stageNarrative?.ranges??b.memory.readingStage??[]).map(r=>r.start))||a.memory.createdAt-b.memory.createdAt:b.score - a.score || b.memory.createdAt - a.memory.createdAt || a.memory.id.localeCompare(b.memory.id));
  const semanticVersions=new Map(permittedWorldMemories(state,book,{source,extra,history:true}).filter(m=>strategyMemoryAllowed(state,m,strategy)).map(m=>[m.id,m])),chatIds=new Set(source==='background'?[]:state.chats.filter(c=>c.bookId===book.id&&chatBelongsToPartner(state,c)&&!c.excluded&&!c.outdatedBy&&!c.replacedBy&&!c.futureGrant&&isEvidenceAllowed(book,c.evidence,extra)).map(c=>c.id));
  const opinionNavigation=!request.entityIds&&!request.relations?scope.opinionNavigation:undefined;
  // Explicitly named complete opinions may share a larger navigation batch;
  // ordinary query/index recall keeps its existing ordering and budget.
  const requestedOpinionBatch=strategy==='companion'&&!!opinionNavigation&&!!request.ids?.length&&request.view==='full'&&(!request.kind||request.kind==='opinion')&&ranked.every(({memory})=>memory.kind==='opinion');
  if(requestedOpinionBatch){
    const positions=new Map<string,number>();
    request.ids!.forEach((key,index)=>{const resolved=currentQuestion(state,book,key,extra,versions)?.id??key;if(!positions.has(resolved))positions.set(resolved,index);});
    ranked.sort((a,b)=>positions.get(a.memory.id)!-positions.get(b.memory.id)!);
  }
  const items: Memory[] = []; let offset = request.offset ?? 0, chars = 0;
  while (offset < ranked.length && items.length < 8) {
    const memory = ranked[offset].memory, size = ['stage','state','arc'].includes(memory.kind) ? narrativeMaterialChars(memory, request.view ?? 'full') : request.view==='index' ? JSON.stringify(strategy==='companion'&&opinionNavigation&&memory.kind==='opinion'?ordinaryMemoryIndex(memory,request.query,opinionNavigation,!!memory.historicalOnly||!!memory.replacedBy||historicalGranted.some(h=>h.id===memory.id)):{id:memory.id,kind:memory.kind,readingStage:memory.readingStage}).length : (strategy==='companion'?fullText(memory).length:Math.min(fullText(memory).length, 1800)) + (memory.narrative ? JSON.stringify(memory.narrative).length : 0) + (strategy==='companion'?JSON.stringify({...worldNote(memory),...semanticMaterial(memory)}).length:0);
    // A complete, valid record can exceed the batch budget through provenance
    // metadata. Return that first record whole so paging always advances.
    if (items.length && chars + size > (requestedOpinionBatch?24000:4000)) break;
    items.push(visibleSemanticMemory(book,visibleWorldMemory(state,book,memory),semanticVersions,{extra,world:!!scope.worldCandidate&&strategy!=='full-original',chatIds})); chars += size; offset++;
  }
  return { items, total: ranked.length,...(companionStages?{searchedKinds:['stage','opinion'] as Memory['kind'][],documentScope:'book-and-current-partner' as const}:{}), nextOffset: offset < ranked.length ? offset : undefined,...(candidates.some(m=>m.text===undefined)?{unloadedBodyIds:candidates.filter(m=>m.text===undefined).map(m=>m.id),searchScope:'metadata-and-loaded-bodies' as const}:{}),...(requestedOpinionBatch?{remainingIds:ranked.slice(offset).map(({memory})=>memory.id),unavailableIds:request.ids!.filter(key=>!ranked.some(({memory})=>memory.id===(currentQuestion(state,book,key,extra,versions)?.id??key)))}:{}),...(historicalGranted.length||strategy==='companion'&&items.some(m=>m.historicalOnly||m.replacedBy)?{historicalIds:items.filter(m=>strategy==='companion'&&(m.historicalOnly||m.replacedBy)||historicalGranted.some(h=>h.id===m.id)).map(m=>m.id)}:{}) };
}

/** Only permitted memories participate in ranking; future material cannot affect even hit counts. */
export function selectMemories(state: State, book: Book, current: Range, question = '', extra: Range[] = [], charBudget = 6500, options: { focusQuestion?: boolean; surrounding?: string; discussion?:string; maxItems?: number; originalComplete?: boolean; materialRanges?:Range[]; perspectiveOnly?:boolean; excludeIds?:string[];readingStrategy?:ReadingStrategy } = {}): Memory[] {
  const eligible = usableMemories(state, book, extra).filter(m => typeof m.text==='string'&&(options.readingStrategy==='full-original'?strategyMemoryAllowed(state,m,'full-original'):!['context','stage','state','arc'].includes(m.kind)&&(!options.originalComplete || m.kind !== 'story' || ['conversation','correction','review'].includes(m.source))&&(!options.perspectiveOnly||['opinion','shared','user'].includes(m.kind)||['correction','review'].includes(m.source)))&&!options.excludeIds?.includes(m.id));
  // Selection is local: scanning the complete task adds no model input. A tail
  // window discarded revelations early in an otherwise fully supplied chapter.
  const material=(options.materialRanges??[current]).flatMap(r=>readableParts(book,r,extra)).map(r=>book.text.slice(r.start,r.end)).join('\n');
  const nearby = material + '\n' + (options.surrounding ?? '');
  const focused = !!options.focusQuestion && !!question.trim();
  const queryText = focused ? question : nearby + '\n' + question;
  const query = recallTerms(queryText), context = focused ? recallTerms(nearby) : new Set<string>();
  const discussion=focused?(options.discussion??'').slice(-1800):'';
  const discourse=recallTerms(discussion);
  const frequency = new Map<string, number>();
  const indexed = eligible.map(memory => ({ memory, words: memoryTerms(memory) }));
  for (const item of indexed) for (const word of item.words) if (query.has(word) || context.has(word) || discourse.has(word)) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  const scored = connectPartialAnswers(indexed.map(({ memory, words }, index) => {
    let score = 0;
    for (const word of query) if (words.has(word)) score += (focused ? 3 : 1) * Math.log(1 + eligible.length / ((frequency.get(word) ?? 0) + 1));
    for (const word of context) if (words.has(word)) score += .25 * Math.log(1 + eligible.length / ((frequency.get(word) ?? 0) + 1));
    for (const word of discourse) if (words.has(word)) score += .75 * Math.log(1 + eligible.length / ((frequency.get(word) ?? 0) + 1));
    score /= Math.sqrt(Math.max(8, words.size));
    score += Math.min(2, subjectOverlap(memory, queryText)) * .5;
    if (memorySources(memory).some(r => r.start < current.end && r.end > current.start)) score += .4;
    return { memory, score, index };
  }));
  // Recent developments stay visible; relevant older facts and discussions get independent slots.
  const recent = eligible.slice(-8).reverse();
  const ranked = scored.filter(r => r.score > 0).sort((a, b) => b.score - a.score || b.index - a.index).map(r => r.memory);
  const chosen: Memory[] = [], selected = new Set<string>(); let size = 0;
  const add=(memory:Memory)=>{
    const amount = fullText(memory).length + (memory.narrative ? JSON.stringify(memory.narrative).length : 0);
    if (selected.has(memory.id) || size + amount > charBudget || chosen.length >= (options.maxItems??32)) return false;
    selected.add(memory.id); chosen.push(memory); size += amount;
    return true;
  };
  for(const memory of [...ranked.slice(0,focused?4:0),...recent.slice(0,focused?2:4)])add(memory);
  // An incidental returning subject must not disappear behind many high-scoring
  // notes about the main actor. These remain stage-labelled historical records,
  // not an automatic claim that the newest mention describes a current fact.
  const mentioned=normalize(material+'\n'+question+'\n'+discussion);
  const subjects=new Map<string,Memory[]>();
  for(const memory of eligible)for(const name of memory.narrative?.subjects??[]){
    const key=normalize(name);if(key.length<2||!mentioned.includes(key))continue;
    const related=subjects.get(key)??[];related.push(memory);subjects.set(key,related);
  }
  let covered=0;
  for(const [subject,related] of subjects){
    if(chosen.some(m=>m.narrative?.subjects.some(s=>normalize(s)===subject)))continue;
    const facts=related.filter(m=>m.kind==='story');
    const candidates=facts.length?facts:related;
    candidates.sort((a,b)=>Math.max(0,...(b.readingStage??[]).map(r=>r.end))-Math.max(0,...(a.readingStage??[]).map(r=>r.end))||b.createdAt-a.createdAt);
    if(candidates.some(add)&&++covered>=4)break;
  }
  for(const memory of [...ranked.slice(0,24),...recent])add(memory);
  return chosen.sort((a, b) => a.createdAt - b.createdAt);
}

/** Compact, complete old questions for incremental maintenance. No clipped
 * conditions: a long item that does not fit stays available through recall. */
export function questionIndex(state:State,book:Book,ranges:Range[],exclude:string[],extra:Range[]=[],charBudget=1800,source:Memory['source']='reading',strategy:ReadingStrategy='structured'){
  const allowed=usableMemories(state,book,extra).filter(m=>typeof m.text==='string'&&strategyMemoryAllowed(state,m,strategy));
  const partials=new Map<string,Memory[]>();
  for(const memory of allowed)if(memory.answersPartOf){const list=partials.get(memory.answersPartOf)??[];list.push(memory);partials.set(memory.answersPartOf,list);}
  const eligible=allowed.filter(m=>m.kind==='question'&&canDevelopMemory(m,source)&&!exclude.includes(m.id));
  const material=ranges.flatMap(r=>readableParts(book,r,extra)).map(r=>book.text.slice(r.start,r.end)).join('\n'),terms=recallTerms(material);
  const related=new Set(eligible.map(m=>m.id));
  const indexed=allowed.filter(m=>related.has(m.id)||!!m.answersPartOf&&related.has(m.answersPartOf)).map(memory=>({memory,words:memoryTerms(memory)})),frequency=new Map<string,number>();
  for(const {words} of indexed)for(const w of words)if(terms.has(w))frequency.set(w,(frequency.get(w)??0)+1);
  const ranked=connectPartialAnswers(indexed.map(({memory,words})=>({memory,score:[...words].filter(w=>terms.has(w)).reduce((n,w)=>n+Math.log(1+indexed.length/(frequency.get(w)!+1)),0)/Math.sqrt(Math.max(8,words.size))}))).filter(m=>related.has(m.memory.id)&&m.score>0).sort((a,b)=>b.score-a.score||b.memory.createdAt-a.memory.createdAt);
  const items:(Pick<Memory,'id'|'kind'|'text'|'readingStage'|'answersPartOf'>&{canUpdate:boolean})[]=[],records:Memory[]=[];let chars=0;
  for(const {memory} of ranked){
    const related=[memory,...(partials.get(memory.id)??[])];
    const group=related.map(m=>({id:m.id,kind:m.kind,text:m.text,readingStage:m.readingStage,answersPartOf:m.answersPartOf,canUpdate:canDevelopMemory(m,source)}));
    const cost=group.reduce((sum,item)=>sum+JSON.stringify({...item,id:'m9999',...(item.answersPartOf?{answersPartOf:'m9999'}:{})}).length,0);
    if(chars+cost>charBudget)continue;
    items.push(...group);records.push(...related);chars+=cost;
  }
  return {items,records,chars};
}
