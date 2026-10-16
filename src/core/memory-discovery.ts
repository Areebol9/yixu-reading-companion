import {knowledgeNavigationText,knowledgeQueryMatch,knowledgeMaintenanceMatch,validateKnowledgeQuery} from './knowledge-distribution.ts';
import type {KnowledgeDistribution,KnowledgeDocumentQuery,KnowledgeMaintenanceMatch} from './knowledge-distribution.ts';
import {prepareMemoryIdentities,memoryContentIdentity} from './memory-identity.ts';
import {mergeRanges, normalize} from './books.ts';
import {isBackgroundMemory, isEvidenceAllowed, memorySources} from './context.ts';
import {recallTerms} from './recall-terms.ts';
import {hashText} from './text-hash.ts';
import {diverseDiscoveryOrder,selectMemoryDocumentCandidates,validateMemorySelectionOptions} from './discovery-selection.ts';
import type {MemoryCandidateSelection,MemoryCandidateSelectionOptions} from './discovery-selection.ts';
import type {Book, HydratedMemory, Memory, MemoryBody, MemoryBodyRef, Range, State} from './types.ts';

export type MemoryDocumentQuery = {
  query?:string; expansions?:string[]; knowledge?:KnowledgeDocumentQuery; maintenanceText?:string; mode?:'focused'|'coverage'; range?:Range;
  /** Formation is the reading task window, never the time of the described event. */
  rangeBasis?:'formation'|'source'; order?:'source-asc'|'source-desc'|'relevance'; cursor?:string; limit?:number;
  /** Select from the whole permitted candidate set, rather than the first chronological page. */
  selection?:'ranked'|'diverse';
};
export type ReadMemoryBodies = (refs:readonly MemoryBodyRef[])=>Promise<MemoryBody[]>;
type ParagraphIndex = {start:number;end:number;terms:string[]};
type BodyIndex = {hash:string;chars:number;terms:string[];forgetTerms:string[];paragraphs:ParagraphIndex[]};
export type MemoryDiscoverySidecar = {schema:1;entries:BodyIndex[]};
/** Lexical navigation only. It contains no document prose and grants no source authority. */
export class MemoryDiscoveryCache {
  private entries=new Map<string,BodyIndex>();
  private changes=0;
  get revision():number{return this.changes;}
  get(hash:string,chars:number):BodyIndex|undefined {const entry=this.entries.get(hash);return entry?.chars===chars?entry:undefined;}
  put(entry:BodyIndex):void {const old=this.entries.get(entry.hash);if(!old||old.chars!==entry.chars){this.entries.set(entry.hash,entry);this.changes++;}}
  export():MemoryDiscoverySidecar {return {schema:1,entries:structuredClone([...this.entries.values()])};}
  import(value:unknown):void {
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['schema','entries'].includes(k)))throw Error('阅读档案索引无效');
    const sidecar=value as MemoryDiscoverySidecar;
    if(sidecar.schema!==1||!Array.isArray(sidecar.entries)||sidecar.entries.length>100000||JSON.stringify(value).length>16*1024*1024)throw Error('阅读档案索引无效');
    const checked=new Map<string,BodyIndex>();
    const termsValid=(terms:unknown):terms is string[]=>Array.isArray(terms)&&terms.length<=1000000&&terms.every(t=>typeof t==='string'&&t.length>0&&t.length<=300000);
    for(const entry of sidecar.entries){
      if(!entry||typeof entry!=='object'||Object.keys(entry).some(k=>!['hash','chars','terms','forgetTerms','paragraphs'].includes(k))||!/^[0-9a-f]{64}$/.test(entry.hash)||!Number.isSafeInteger(entry.chars)||entry.chars<0||entry.chars>300000||!termsValid(entry.terms)||!termsValid(entry.forgetTerms)||!Array.isArray(entry.paragraphs)||entry.paragraphs.length>entry.chars)throw Error('阅读档案索引无效');
      let end=0;for(const paragraph of entry.paragraphs){if(!paragraph||!Number.isSafeInteger(paragraph.start)||!Number.isSafeInteger(paragraph.end)||paragraph.start<end||paragraph.end<=paragraph.start||paragraph.end>entry.chars||!Array.isArray(paragraph.terms)||paragraph.terms.some(t=>typeof t!=='string'))throw Error('阅读档案段落索引无效');end=paragraph.end;}
      checked.set(entry.hash,structuredClone(entry));
    }
    this.entries=checked;this.changes++;
  }
}
export type MemoryDiscoveryScope = {source?:Memory['source'];extra?:Range[];cache?:MemoryDiscoveryCache};
export type MemoryDocumentIndex = {
  id:string;kind:Memory['kind'];title?:string;navigationCues?:string[];knowledgeDistribution?:KnowledgeDistribution;knowledgeMatchedBy?:'navigation'|'body-fallback'|'subject-context';knowledgeContextVia?:{memoryId:string;cues:string[]}[];maintenanceMatch?:KnowledgeMaintenanceMatch;navigationOnly:true;
  readingStage?:Range[];sourceRanges:Range[];bodyHash:string;bodyChars:number;history?:true;
  /** Explicit development lineage only. Absence also covers an unauthorized or broken chain. */
  directSuccessorId?:string;developmentChainIds?:string[];
  /** Source ordering falls back explicitly when an older document has no exact source ranges. */
  orderingRangeBasis?:'source'|'formation'|'unlocated';
  paragraphHits:{start:number;end:number;excerptStart:number;excerptEnd:number;text:string}[];
  /** Later formation windows are follow-up reading navigation, never later event confirmation. */
  laterDevelopmentIds:string[];
};
export type MemoryDiscoveryResult = {
  items:MemoryDocumentIndex[];total:number;nextCursor?:string;
  coverage:{eligibleDocuments:number;indexedDocuments:number;unavailableBodyIds:string[];formationRanges:Range[];sourceRanges:Range[];complete:false};
  indexing:{readBodies:number;reusedBodies:number};
};
const defaultCaches=new WeakMap<State,MemoryDiscoveryCache>();
function cacheFor(state:State,scope:MemoryDiscoveryScope):MemoryDiscoveryCache {if(scope.cache)return scope.cache;let cache=defaultCaches.get(state);if(!cache){cache=new MemoryDiscoveryCache();defaultCaches.set(state,cache);}return cache;}
function overlaps(ranges:readonly Range[],range:Range):boolean {return ranges.some(r=>r.start<range.end&&r.end>range.start);}
function sourceRanges(memory:Memory):Range[] {return mergeRanges(memorySources(memory).map(({start,end})=>({start,end})));}
function tombstoned(state:State,memory:Memory,text?:string):boolean {return state.forgotten.some(f=>f.bookId===memory.bookId&&(f.id===memory.id||text!==undefined&&!!normalize(f.text)&&normalize(text).includes(normalize(f.text))));}
/** Permission and revision metadata are checked before a store read or a count. */
function allowed(state:State,book:Book,memory:Memory,scope:MemoryDiscoveryScope,text?:string):boolean {
  if(memory.bookId!==book.id||memory.partnerId!==state.partnerId||memory.forgotten||memory.reviewDisposition==='unsupported'||tombstoned(state,memory,text)||!isEvidenceAllowed(book,memory.evidence,scope.extra)||isBackgroundMemory(memory)!==(scope.source==='background'))return false;
  const visibleCause=(id:string|undefined)=>id?state.memories.find(m=>m.id===id):undefined;
  const next=visibleCause(memory.replacedBy);
  if(memory.invalidatedBy)return false;
  if(memory.replacedBy&&(!next||next.revisionKind!=='development'))return false;
  return !['stage','state','arc','context'].includes(memory.kind);
}
function stamp(memory:Memory):string {
  let identity:unknown;try{identity=memoryContentIdentity(memory);}catch{identity='inline-unprepared-or-changed';}
  // Record identity and permissions without copying prose into the fence/cursor binding.
  return JSON.stringify([memory.id,memory.bookId,memory.partnerId,memory.kind,identity,memory.evidence,memory.readingStage,memory.sourceEvidence,memory.sourceQuote?.evidence,memory.documentTitle,memory.navigationCues,memory.knowledgeDistribution,memory.forgotten,memory.invalidatedBy,memory.replacedBy,memory.correctionOf,memory.revisionKind,memory.reviewDisposition,memory.source,memory.backgroundOrigin,memory.createdAt]);
}
function authorizationStamp(state:State,book:Book,scope:MemoryDiscoveryScope):string {return JSON.stringify([book.id,book.version,book.known,state.partnerId,scope.extra??[],state.memories.map(stamp),state.forgotten]);}
async function hydrate(state:State,book:Book,memory:Memory,readBodies:ReadMemoryBodies|undefined,scope:MemoryDiscoveryScope,hidden?:Set<string>):Promise<HydratedMemory|undefined> {
  if(!allowed(state,book,memory,scope,memory.text))return;
  const before=stamp(memory),ref=memory.bodyRef;let text=memory.text;
  if(text===undefined){if(!ref||!readBodies)return;let bodies:MemoryBody[];try{bodies=await readBodies([ref]);}catch{return;}const matches=bodies.filter(b=>b.key===ref.key&&b.hash===ref.hash);if(matches.length!==1)return;text=matches[0].text;}
  if(typeof text!=='string'||ref&&(text.length!==ref.chars||await hashText(text)!==ref.hash))return;
  const current=state.memories.find(m=>m.id===memory.id);
  if(current&&tombstoned(state,current,text)){hidden?.add(memory.id);return;}
  if(!current||stamp(current)!==before||memory.text!==undefined&&current.text!==text||!allowed(state,book,current,scope,text))return;
  return {...current,text};
}
function indexBody(hash:string,text:string):BodyIndex {
  const paragraphs:ParagraphIndex[]=[];
  for(const match of text.matchAll(/[^\r\n]+/gu))if(match[0].trim())paragraphs.push({start:match.index!,end:match.index!+match[0].length,terms:[...recallTerms(match[0])]});
  return {hash,chars:text.length,terms:[...recallTerms(text)],forgetTerms:[...recallTerms(normalize(text))].filter(t=>/\p{Script=Han}/u.test(t)),paragraphs};
}
function queryWords(query:MemoryDocumentQuery):Set<string> {return recallTerms([query.query,query.knowledge?.topic,query.knowledge?.subject,...(query.expansions??[])].filter(Boolean).join('\n'));}
function validateQuery(query:MemoryDocumentQuery):void {
  if(query.knowledge!==undefined)validateKnowledgeQuery(query.knowledge);
  if(query.maintenanceText!==undefined&&typeof query.maintenanceText!=='string')throw Error('知识维护材料须为本轮实际给入的正文');
  if(query.query!==undefined&&(typeof query.query!=='string'||query.query.length>300000)||query.expansions!==undefined&&(!Array.isArray(query.expansions)||query.expansions.length>12||query.expansions.some(t=>typeof t!=='string'||t.length>160))||query.mode!==undefined&&!['focused','coverage'].includes(query.mode)||query.selection!==undefined&&!['ranked','diverse'].includes(query.selection)||query.rangeBasis!==undefined&&!['formation','source'].includes(query.rangeBasis)||query.order!==undefined&&!['source-asc','source-desc','relevance'].includes(query.order)||query.limit!==undefined&&(!Number.isSafeInteger(query.limit)||query.limit<1||query.limit>8)||query.range&&(!Number.isSafeInteger(query.range.start)||!Number.isSafeInteger(query.range.end)||query.range.start<0||query.range.end<=query.range.start))throw Error('阅读档案查询无效');
}
function developmentChain(memory:Memory,visible:ReadonlyMap<string,Memory>):string[] {
  const ids:string[]=[],seen=new Set([memory.id]);let current=memory;
  while(current.replacedBy){const next=visible.get(current.replacedBy);if(!next||next.revisionKind!=='development'||seen.has(next.id))break;ids.push(next.id);seen.add(next.id);current=next;}
  return ids;
}
function orderingRange(memory:Memory,basis:'formation'|'source'):{first:number;basis:'source'|'formation'|'unlocated'} {
  const sources=sourceRanges(memory);if(basis==='source'&&sources.length)return {first:Math.min(...sources.map(r=>r.start)),basis:'source'};
  if(memory.readingStage?.length)return {first:Math.min(...memory.readingStage.map(r=>r.start)),basis:'formation'};
  return {first:Infinity,basis:'unlocated'};
}
function paragraphHits(text:string,index:BodyIndex,words:Set<string>):MemoryDocumentIndex['paragraphHits'] {
  return index.paragraphs.map(p=>({p,score:p.terms.filter(t=>words.has(t)).length})).filter(h=>h.score>0).sort((a,b)=>b.score-a.score||a.p.start-b.p.start).slice(0,3).map(({p})=>{
    const paragraph=text.slice(p.start,p.end);let hit=-1;
    for(const word of words){const at=paragraph.toLowerCase().indexOf(word);if(at>=0&&(hit<0||at<hit))hit=at;}
    let start=p.start+Math.max(0,hit-100),end=Math.min(p.end,start+360);start=Math.max(p.start,Math.min(start,end-360));
    if(start>p.start&&/[\uDC00-\uDFFF]/u.test(text[start]))start--;if(end<p.end&&/[\uDC00-\uDFFF]/u.test(text[end]))end++;
    return {start:p.start,end:p.end,excerptStart:start,excerptEnd:end,text:text.slice(start,end)};
  });
}

/** Search every permitted document body; persisted lexical entries make later calls incremental. */
export async function discoverMemoryDocuments(state:State,book:Book,query:MemoryDocumentQuery,readBodies:ReadMemoryBodies|undefined,scope:MemoryDiscoveryScope={}):Promise<MemoryDiscoveryResult> {
  validateQuery(query);const cache=cacheFor(state,scope),words=queryWords(query),mode=query.mode??'focused',order=query.order??(mode==='coverage'?'source-asc':'relevance');
  const candidates=state.memories.filter(m=>allowed(state,book,m,scope,m.text)&&(!query.range||overlaps(query.rangeBasis==='source'?sourceRanges(m):m.readingStage??[],query.range)));
  await prepareMemoryIdentities(candidates);
  const fence=authorizationStamp(state,book,scope);
  const binding=JSON.stringify([book.id,book.version,state.partnerId,scope.source??'reading',book.known,scope.extra??[],query.query??'',query.expansions??[],query.knowledge??null,query.maintenanceText??'',mode,query.selection??'ranked',query.range??null,query.rangeBasis??'formation',order,candidates.map(stamp),state.forgotten]);
  let offset=0;if(query.cursor){let parsed:{binding:string;offset:number};try{parsed=JSON.parse(query.cursor);}catch{throw Error('阅读档案续页无效');}if(!parsed||parsed.binding!==await hashText(binding)||!Number.isSafeInteger(parsed.offset)||parsed.offset<0)throw Error('阅读档案续页条件或权限已变化：cursor须使用原查询实际返回的nextCursor，并原样保留生成它的query、knowledge、expansions、mode、selection、range、rangeBasis和order过滤条件；不使用offset。条件或权限确有变化时，从无cursor重新查，不能沿用旧cursor。');offset=parsed.offset;}
  const unavailable=new Set<string>(),hidden=new Set<string>(),bodies=new Map<string,HydratedMemory>(),indexed:{memory:Memory;index:BodyIndex;score:number;knowledgeMatchedBy?:'navigation'|'body-fallback'|'subject-context';knowledgeContextVia?:{memoryId:string;cues:string[]}[];maintenanceMatch?:KnowledgeMaintenanceMatch;subjectContextSeed?:boolean}[]=[];let reads=0,reused=0;
  let residentChars=0;
  const remember=(memory:HydratedMemory)=>{
    if(memory.text.length>96000)return;
    const previous=bodies.get(memory.id);if(previous){residentChars-=previous.text.length;bodies.delete(memory.id);}
    bodies.set(memory.id,memory);residentChars+=memory.text.length;
    while(bodies.size>8||residentChars>96000){const first=bodies.keys().next().value!;residentChars-=bodies.get(first)!.text.length;bodies.delete(first);}
  };
  const tombstones=state.forgotten.filter(f=>f.bookId===book.id&&!!normalize(f.text));
  for(const memory of candidates){
    let hash=memoryContentIdentity(memory).hash;
    let entry=hash?cache.get(hash,memoryContentIdentity(memory).chars):undefined;
    // Text tombstones need an exact body check when lexical terms cannot rule them out.
    const needsTombstoneCheck=memory.text===undefined&&tombstones.some(f=>{const terms=[...recallTerms(normalize(f.text))].filter(t=>/\p{Script=Han}/u.test(t));return !entry||!terms.length||terms.every(t=>entry!.forgetTerms.includes(t));});
    if(!entry||needsTombstoneCheck){const loaded=await hydrate(state,book,memory,readBodies,scope,hidden);if(memory.text===undefined)reads++;if(!loaded){if(!hidden.has(memory.id)&&allowed(state,book,memory,scope))unavailable.add(memory.id);continue;}remember(loaded);hash??=await hashText(loaded.text);entry=indexBody(hash,loaded.text);cache.put(entry);}else reused++;
    if(!allowed(state,book,memory,scope,memory.text))continue;
    let queryBody=memory.text??bodies.get(memory.id)?.text;
    if(query.knowledge&&(query.knowledge.topic||query.knowledge.subject)&&knowledgeQueryMatch(memory.knowledgeDistribution,query.knowledge,[])!=='navigation'&&queryBody===undefined){const loaded=await hydrate(state,book,memory,readBodies,scope);if(memory.text===undefined)reads++;if(!loaded){unavailable.add(memory.id);continue;}remember(loaded);queryBody=loaded.text;}
    const knowledgeMatchedBy=query.knowledge?knowledgeQueryMatch(memory.knowledgeDistribution,query.knowledge,entry.terms,queryBody):undefined;
    const maintenanceMatch=query.maintenanceText?knowledgeMaintenanceMatch(memory.knowledgeDistribution,query.maintenanceText):undefined;
    const subjectContextSeed=!!query.knowledge?.subject&&knowledgeQueryMatch(memory.knowledgeDistribution,{subject:query.knowledge.subject},entry.terms,queryBody)!==undefined;
    indexed.push({memory,index:entry,score:0,knowledgeMatchedBy,maintenanceMatch,subjectContextSeed});
  }
  // A subject's named context is a navigation bridge to its defaults, never a
  // membership fact or proof that the subject learned the referenced knowledge.
  if(query.knowledge?.subject){
    const seeds=indexed.filter(item=>item.subjectContextSeed).map(item=>({memoryId:item.memory.id,cues:item.memory.knowledgeDistribution?.scopeCues??[]})).filter(seed=>seed.cues.length);
    for(const item of indexed){if(item.knowledgeMatchedBy)continue;
      let body=item.memory.text??bodies.get(item.memory.id)?.text;
      const via:{memoryId:string;cues:string[]}[]=[];
      for(const seed of seeds){const cues:string[]=[];for(const cue of seed.cues){
        const lookup={topic:query.knowledge.topic,subject:cue};
        const navigates=knowledgeQueryMatch(item.memory.knowledgeDistribution,lookup,[])==='navigation';
        if(!navigates&&body===undefined){const loaded=await hydrate(state,book,item.memory,readBodies,scope);if(item.memory.text===undefined)reads++;if(loaded){remember(loaded);body=loaded.text;}else unavailable.add(item.memory.id);}
        if(navigates||body!==undefined&&knowledgeQueryMatch(item.memory.knowledgeDistribution,lookup,item.index.terms,body)!==undefined)cues.push(cue);
      }if(cues.length)via.push({memoryId:seed.memoryId,cues});}
      if(via.length){item.knowledgeMatchedBy='subject-context';item.knowledgeContextVia=via;}
    }
  }
  if(query.knowledge){for(let at=indexed.length-1;at>=0;at--)if(!indexed[at].knowledgeMatchedBy)indexed.splice(at,1);}
  // Binary-term BM25 normalization: repeated text does not add hits, and a long
  // body containing many incidental terms cannot win simply by being longer.
  const averageTerms=indexed.reduce((sum,item)=>sum+item.index.terms.length,0)/Math.max(1,indexed.length),frequency=new Map<string,number>();
  for(const item of indexed)for(const term of item.index.terms)if(words.has(term))frequency.set(term,(frequency.get(term)??0)+1);
  const weight=(term:string)=>Math.log1p((indexed.length+.5)/((frequency.get(term)??0)+.5));
  for(const item of indexed){
    const hits=item.index.terms.filter(term=>words.has(term)),normalizer=2.2/(1+1.2*(.25+.75*item.index.terms.length/Math.max(1,averageTerms)));
    const navigation=recallTerms([item.memory.documentTitle,...(item.memory.navigationCues??[]),knowledgeNavigationText(item.memory.knowledgeDistribution)].filter(Boolean).join('\n'));
    item.score=hits.reduce((sum,term)=>sum+weight(term),0)*normalizer+[...words].filter(term=>navigation.has(term)).reduce((sum,term)=>sum+weight(term),0)*.15;
  }
  for(const item of indexed)if(item.maintenanceMatch)item.score+=Object.values(item.maintenanceMatch).reduce((n,cues)=>n+cues.length,0);
  const unique=new Map<string,typeof indexed[number]>();
  for(const item of indexed){const previous=unique.get(item.index.hash);if(!previous||item.memory.createdAt>previous.memory.createdAt)unique.set(item.index.hash,item);}
  let ranked=[...unique.values()].filter(item=>mode==='coverage'||!words.size||item.score>0||!!item.knowledgeMatchedBy).sort((a,b)=>{
    if(query.maintenanceText&&!!a.maintenanceMatch!==!!b.maintenanceMatch)return a.maintenanceMatch?-1:1;
    const first=(m:Memory)=>orderingRange(m,query.rangeBasis??'formation').first;
    const chronological=first(a.memory)===first(b.memory)?0:(first(a.memory)<first(b.memory)?-1:1);
    return order==='relevance'?b.score-a.score||a.memory.createdAt-b.memory.createdAt:chronological*(order==='source-desc'?-1:1)||a.memory.createdAt-b.memory.createdAt||a.memory.id.localeCompare(b.memory.id);
  });
  if(query.selection==='diverse')ranked=diverseDiscoveryOrder(ranked,!!words.size);
  const visible=new Map(indexed.map(item=>[item.memory.id,item.memory]));
  const page=ranked.slice(offset,offset+(query.limit??8)),items:MemoryDocumentIndex[]=[];
  for(const {memory,index,knowledgeMatchedBy,knowledgeContextVia,maintenanceMatch} of page){
    let loaded=bodies.get(memory.id);if(!loaded){loaded=await hydrate(state,book,memory,readBodies,scope);if(memory.text===undefined)reads++;}
    if(!loaded){unavailable.add(memory.id);continue;}
    const end=Math.max(0,...(memory.readingStage??[]).map(r=>r.end));
    const chain=developmentChain(memory,visible);
    items.push({id:memory.id,kind:memory.kind,...(memory.documentTitle?{title:memory.documentTitle}:{}),...(memory.navigationCues?.length?{navigationCues:memory.navigationCues}:{}),...(memory.knowledgeDistribution?{knowledgeDistribution:memory.knowledgeDistribution}:{}),...(knowledgeMatchedBy?{knowledgeMatchedBy}:{}),...(knowledgeContextVia?{knowledgeContextVia}:{}),...(maintenanceMatch?{maintenanceMatch}:{}),navigationOnly:true,readingStage:memory.readingStage,sourceRanges:sourceRanges(memory),bodyHash:index.hash,bodyChars:index.chars,...(memory.replacedBy||memory.historicalOnly?{history:true as const}:{}),...(chain.length?{directSuccessorId:chain[0],developmentChainIds:chain}:{}),...(order!=='relevance'?{orderingRangeBasis:orderingRange(memory,query.rangeBasis??'formation').basis}:{}),paragraphHits:paragraphHits(loaded.text,index,words),laterDevelopmentIds:ranked.filter(x=>x.memory.id!==memory.id&&!chain.includes(x.memory.id)&&(x.memory.readingStage??[]).some(r=>r.start>=end)&&x.score>0).slice(0,4).map(x=>x.memory.id)});
  }
  const next=offset+page.length;
  const nextCursor=next<ranked.length?JSON.stringify({binding:await hashText(binding),offset:next}):undefined;
  if(authorizationStamp(state,book,scope)!==fence)throw Error('阅读档案查询期间许可或档案身份已变化，请重新取材');
  return {items,total:ranked.length,...(nextCursor?{nextCursor}:{}),coverage:{eligibleDocuments:candidates.length-hidden.size,indexedDocuments:indexed.length,unavailableBodyIds:[...unavailable],formationRanges:mergeRanges(indexed.flatMap(x=>x.memory.readingStage??[])),sourceRanges:mergeRanges(indexed.flatMap(x=>sourceRanges(x.memory))),complete:false},indexing:{readBodies:reads,reusedBodies:reused}};
}

/** Explicit IDs expand complete bodies, with source eligibility checked again after the await. */
export async function readMemoryDocuments(state:State,book:Book,ids:readonly string[],readBodies:ReadMemoryBodies|undefined,scope:MemoryDiscoveryScope={}):Promise<{items:HydratedMemory[];unavailableIds:string[];remainingIds:string[]}> {
  await prepareMemoryIdentities(state.memories.filter(m=>ids.includes(m.id)&&allowed(state,book,m,scope,m.text)));
  const fence=authorizationStamp(state,book,scope),items:HydratedMemory[]=[],unavailableIds:string[]=[],remainingIds:string[]=[];let chars=0;
  for(const id of [...new Set(ids)]){
    const memory=state.memories.find(m=>m.id===id);if(!memory||!allowed(state,book,memory,scope,memory.text)){unavailableIds.push(id);continue;}
    const size=memory.bodyRef?.chars??memory.text?.length;
    if(items.length>=8||items.length>0&&size!==undefined&&chars+size>24000){remainingIds.push(id);continue;}
    const loaded=await hydrate(state,book,memory,readBodies,scope);if(!loaded){unavailableIds.push(id);continue;}
    items.push(loaded);chars+=loaded.text.length;
  }
  if(authorizationStamp(state,book,scope)!==fence)throw Error('阅读档案展开期间许可或档案身份已变化，请重新取材');
  return {items,unavailableIds,remainingIds};
}

export type MemoryMaterialCandidates = {currentIds?:readonly string[];focused?:readonly MemoryDocumentIndex[];coverage?:readonly MemoryDocumentIndex[]};
/** Automatic material selection has a strict budget; unlike an explicit full-body
 * read, its first large document cannot silently exceed the other material budget. */
export async function selectAndReadMemoryDocuments(state:State,book:Book,branches:MemoryMaterialCandidates,readBodies:ReadMemoryBodies|undefined,scope:MemoryDiscoveryScope={},options:MemoryCandidateSelectionOptions={}):Promise<{items:HydratedMemory[];selections:MemoryCandidateSelection[];unavailableIds:string[];remainingIds:string[]}> {
  validateMemorySelectionOptions(options);
  const permitted=state.memories.filter(memory=>allowed(state,book,memory,scope,memory.text));
  await prepareMemoryIdentities(permitted);
  const fence=authorizationStamp(state,book,scope),cache=cacheFor(state,scope),byId=new Map(permitted.map(memory=>[memory.id,memory])),navigable=new Map<string,Memory>(),checked=new Set<string>(),bodies=new Map<string,HydratedMemory>();
  const canNavigate=async(memory:Memory):Promise<boolean>=>{
    if(checked.has(memory.id))return navigable.has(memory.id);checked.add(memory.id);
    if(!allowed(state,book,memory,scope,memory.text))return false;
    if(memory.text===undefined){
      const identity=memoryContentIdentity(memory),entry=cache.get(identity.hash,identity.chars);
      const uncertain=state.forgotten.some(f=>{if(f.bookId!==book.id||!normalize(f.text))return false;const terms=[...recallTerms(normalize(f.text))].filter(t=>/\p{Script=Han}/u.test(t));return !entry||!terms.length||terms.every(t=>entry.forgetTerms.includes(t));});
      if(uncertain){const loaded=await hydrate(state,book,memory,readBodies,scope);if(!loaded)return false;bodies.set(memory.id,loaded);}
    }
    navigable.set(memory.id,memory);return true;
  };
  const inputIds=[...new Set([...(branches.currentIds??[]),...(branches.focused??[]).map(item=>item.id),...(branches.coverage??[]).map(item=>item.id)])];
  for(const id of inputIds){
    let memory=byId.get(id);if(!memory||!await canNavigate(memory))continue;
    const seen=new Set([memory.id]);
    while(memory.replacedBy){const next=byId.get(memory.replacedBy);if(!next||next.revisionKind!=='development'||seen.has(next.id)||!await canNavigate(next))break;seen.add(next.id);memory=next;}
  }
  const index=(memory:Memory):MemoryDocumentIndex=>{
    const identity=memoryContentIdentity(memory),chain=developmentChain(memory,navigable);
    return {id:memory.id,kind:memory.kind,navigationOnly:true,...(memory.documentTitle?{title:memory.documentTitle}:{}),...(memory.navigationCues?.length?{navigationCues:memory.navigationCues}:{}),...(memory.knowledgeDistribution?{knowledgeDistribution:memory.knowledgeDistribution}:{}),readingStage:memory.readingStage,sourceRanges:sourceRanges(memory),bodyHash:identity.hash,bodyChars:identity.chars,...(memory.replacedBy||memory.historicalOnly?{history:true as const}:{}),...(chain.length?{directSuccessorId:chain[0],developmentChainIds:chain}:{}),paragraphHits:[],laterDevelopmentIds:[]};
  };
  const documents=new Map([...navigable].map(([id,memory])=>[id,index(memory)])),unavailable=new Set<string>();
  const lane=(ids:readonly string[])=>ids.flatMap(id=>{const item=documents.get(id);return item&&!unavailable.has(id)?[item]:[];});
  let plan=selectMemoryDocumentCandidates({},options);
  // A missing/corrupt selected body yields its place to the next eligible
  // candidate. Successfully read bytes are reused across that local retry.
  while(true){
    plan=selectMemoryDocumentCandidates({current:lane(branches.currentIds??[]),focused:lane((branches.focused??[]).map(item=>item.id)),coverage:lane((branches.coverage??[]).map(item=>item.id)),companions:[...documents.values()].filter(item=>!unavailable.has(item.id))},options);
    let failed=false;
    for(const id of plan.ids){if(bodies.has(id))continue;const loaded=await hydrate(state,book,navigable.get(id)!,readBodies,scope);if(loaded)bodies.set(id,loaded);else {unavailable.add(id);failed=true;}}
    if(!failed)break;
  }
  if(authorizationStamp(state,book,scope)!==fence)throw Error('阅读档案选择期间许可或档案身份已变化，请重新取材');
  return {items:plan.ids.map(id=>bodies.get(id)!),selections:plan.selections,unavailableIds:[...new Set([...inputIds.filter(id=>!documents.has(id)),...unavailable])],remainingIds:plan.remainingIds};
}

export {selectMemoryDocumentCandidates} from './discovery-selection.ts';
export type {MemoryCandidateSelectionOptions,MemoryCandidateSelection} from './discovery-selection.ts';
