import {isBackgroundMemory,isEvidenceAllowed,memorySources} from './context.ts';
import {entityIndex,permittedWorldMemories} from './world-identity.ts';
import {currentStates,permittedStages,permittedStates} from './stage-state.ts';
import {currentArcs,permittedArcs} from './arc-state.ts';
import {visibleSemanticMemory} from './semantic-material.ts';
import {chatBelongsToPartner} from './discussion-recall.ts';
import type {Book,Memory,Range,State,ReadingStrategy,ArcCandidate,Evidence} from './types.ts';

export type StructureScope={source?:Memory['source'];extra?:Range[];readingStrategy?:ReadingStrategy;arcCandidate?:ArcCandidate;worldCandidate?:'v1'};
export type RelationNode={kind:'memory'|'entity';id:string};
export type StructureRelation={ownerId:string;from:RelationNode;to:RelationNode;type:'about'|'identity'|'attribution'|'speaker'|'content'|'rule'|'state-member'|'arc-member'|'impact'|'partial-answer'|'complete-answer'|'basis'|'development'|'state-progress'|'arc-progress'|'temporal'|'clue-setup'|'clue-payoff';evidence:Evidence[];partId?:string;detail?:Record<string,string|number>};
export type RelationSeeds={ids?:readonly string[];entityIds?:readonly string[]};
export type StructureRelationIndex={scope:'work-memory-relations';items:StructureRelation[];nodes:{id:string;kind:Memory['kind'];history:boolean}[];entityIds:string[];total:number;hasMore:boolean;nextOffset?:number;missingBodyIds?:string[];searchScope?:'metadata-and-loaded-bodies'};

/** Filter material roles after the existing source/permission checks. No source ID widens permission. */
export function strategyMemoryAllowed(state:State,memory:Memory,strategy:ReadingStrategy='structured'):boolean{
  if(strategy!=='full-original')return true;
  const structural=['context','stage','state','arc'].includes(memory.kind);
  if(memory.source==='correction'||!structural&&(['opinion','question','shared','user'].includes(memory.kind)||memory.source==='conversation'||memory.kind==='story'&&!!memory.answersPartOf))return true;
  const seen=new Set<string>();let cursor=memory;
  while(cursor.correctionOf&&!seen.has(cursor.id)){
    seen.add(cursor.id);const previous=state.memories.find(m=>m.id===cursor.correctionOf);
    if(!previous||previous.bookId!==memory.bookId||previous.partnerId!==memory.partnerId)return false;
    if(previous.kind==='question'&&memory.kind==='story'||cursor.source==='review'&&(previous.source==='correction'||!structural&&(['opinion','question','shared','user'].includes(previous.kind)||!['context','stage','state','arc'].includes(previous.kind)&&previous.source==='conversation'||previous.kind==='story'&&!!previous.answersPartOf)))return true;
    if(cursor.source!=='review'&&cursor.revisionKind!=='development')return false;
    cursor=previous;
  }
  return false;
}

/** Current and immutable normally developed versions share the existing permission/source contract. */
export function structureMaterialPool(state:State,book:Book,options:StructureScope={}){
  const source=options.source??'preparation',extra=options.extra??[],strategy=options.readingStrategy??'structured',opts={source,extra};
  const ordinary=permittedWorldMemories(state,book,opts).filter(m=>!['context','stage','state','arc'].includes(m.kind)&&isBackgroundMemory(m)===(source==='background')&&strategyMemoryAllowed(state,m,strategy));
  const states=strategy==='full-original'?[]:currentStates(state,book,opts),stages=strategy==='full-original'?[]:permittedStages(state,book,opts),arcs=strategy==='full-original'||!options.arcCandidate?[]:currentArcs(state,book,opts);
  const versions=new Map(permittedWorldMemories(state,book,{...opts,history:true}).filter(m=>strategyMemoryAllowed(state,m,strategy)).map(m=>[m.id,m])),chatIds=new Set(source==='background'?[]:state.chats.filter(c=>c.bookId===book.id&&chatBelongsToPartner(state,c)&&!c.excluded&&!c.outdatedBy&&!c.replacedBy&&!c.futureGrant&&isEvidenceAllowed(book,c.evidence,extra)).map(c=>c.id));
  const visible=ordinary.map(m=>visibleSemanticMemory(book,m,versions,{extra,world:!!options.worldCandidate&&strategy!=='full-original',chatIds}));
  return{ordinary:visible,states,stages,arcs,all:[...visible,...states,...arcs,...stages]};
}
export function projectStructureRelations(state:State,book:Book,options:StructureScope={}){
  const opts={source:options.source??'preparation',extra:options.extra??[]},strategy=options.readingStrategy??'structured',pool=structureMaterialPool(state,book,options);
  const historical=[...permittedWorldMemories(state,book,{...opts,history:true}).filter(m=>!['context','stage','state','arc'].includes(m.kind)&&strategyMemoryAllowed(state,m,strategy)),...pool.stages,...(strategy==='full-original'?[]:permittedStates(state,book,opts)),...(strategy==='full-original'||!options.arcCandidate?[]:permittedArcs(state,book,opts))];
  const memories=new Map(historical.filter(m=>m.bookId===book.id&&m.partnerId===state.partnerId&&isBackgroundMemory(m)===(opts.source==='background')&&isEvidenceAllowed(book,m.evidence,opts.extra)).map(m=>[m.id,m])),currentIds=new Set(pool.all.map(m=>m.id));
  const semanticVersions=new Map(memories),chatIds=new Set(opts.source==='background'?[]:state.chats.filter(c=>c.bookId===book.id&&chatBelongsToPartner(state,c)&&!c.excluded&&!c.outdatedBy&&!c.replacedBy&&!c.futureGrant&&isEvidenceAllowed(book,c.evidence,opts.extra)).map(c=>c.id));
  for(const [id,m] of memories)memories.set(id,visibleSemanticMemory(book,m,semanticVersions,{extra:opts.extra,world:!!options.worldCandidate&&strategy!=='full-original',chatIds}));
  const entities=options.worldCandidate&&strategy!=='full-original'?entityIndex(state,book,opts):[],entityIds=new Set(entities.map(e=>e.id)),edges:StructureRelation[]=[];
  const memory=(id:string):RelationNode=>({kind:'memory',id}),entity=(id:string):RelationNode=>({kind:'entity',id});
  const visible=(node:RelationNode)=>node.kind==='memory'?memories.has(node.id):entityIds.has(node.id);
  const add=(m:Memory,from:RelationNode,to:RelationNode,type:StructureRelation['type'],detail?:StructureRelation['detail'],partId?:string,evidence:Evidence[]=memorySources(m))=>{if(visible(from)&&visible(to)&&evidence.every(e=>isEvidenceAllowed(book,[e],opts.extra)))edges.push({ownerId:m.id,from,to,type,evidence:structuredClone(evidence),...(detail?{detail}:{}),...(partId?{partId}:{})});};
  for(const m of memories.values()){
    for(const axis of ['occurrence','acquisition'] as const){const anchor=m.temporal?.[axis];for(const r of anchor?.relations??[])add(m,memory(m.id),memory(r.targetId),'temporal',{axis,targetAxis:'occurrence',relation:r.relation,cognition:anchor!.cognition},undefined,anchor!.sourceEvidence);}
    if(m.clue){const c=m.clue;add(m,memory(m.id),memory(c.setupRef.memoryId),'clue-setup',{status:c.status,cognition:c.cognition,start:c.setupRef.start,end:c.setupRef.end},undefined,c.sourceEvidence);for(const r of c.payoffRefs??[])add(m,memory(m.id),memory(r.memoryId),'clue-payoff',{status:c.status,cognition:c.cognition,start:r.start,end:r.end},undefined,c.sourceEvidence);}
    for(const about of m.about??[])add(m,entity(about.entityId),memory(m.id),'about',about.role?{role:about.role}:undefined);
    if(m.identityClaim){const c=m.identityClaim;add(m,entity(c.entityId),c.targetId?entity(c.targetId):memory(m.id),'identity',{type:c.type,cognition:c.cognition,...(c.name?{name:c.name}:{})});if(c.speakerId)add(m,entity(c.speakerId),memory(m.id),'speaker');}
    if(m.attribution){const a=m.attribution;add(m,entity(a.holderId),memory(m.id),'attribution',{mode:a.mode,grounding:a.grounding});if(a.speakerId)add(m,entity(a.speakerId),memory(m.id),'speaker');if(a.contentRef)add(m,memory(m.id),memory(a.contentRef.memoryId),'content',{start:a.contentRef.start,end:a.contentRef.end});}
    for(const link of m.ruleLinks??[])add(m,memory(m.id),memory(link.memoryId),'rule',{type:link.type,cognition:link.cognition});
    for(const part of m.stateProjection?.parts??[])if(part.memoryRef&&memories.has(part.memoryRef.memoryId))add(m,memory(part.memoryRef.memoryId),memory(m.id),'state-member',{start:part.memoryRef.start,end:part.memoryRef.end},part.id,part.sourceEvidence??memorySources(memories.get(part.memoryRef.memoryId)!));
    for(const part of m.arcProjection?.parts??[]){if(part.memoryRef)add(m,memory(part.memoryRef.memoryId),memory(m.id),'arc-member',{role:part.role,start:part.memoryRef.start,end:part.memoryRef.end},part.id,part.sourceEvidence??(memories.has(part.memoryRef.memoryId)?memorySources(memories.get(part.memoryRef.memoryId)!):[]));if(part.impact)add(m,memory(part.impact.sourceVersionId),memory(part.impact.targetVersionId),'impact',{type:part.impact.type,cognition:part.impact.cognition},part.id,part.sourceEvidence??[]);}
    if(m.answersPartOf)add(m,memory(m.answersPartOf),memory(m.id),'partial-answer');
    if(m.revisionKind==='development'&&m.correctionOf){const before=memories.get(m.correctionOf);add(m,memory(m.correctionOf),memory(m.id),before?.kind==='question'&&m.kind!=='question'?'complete-answer':'development');}
    if(m.worldChangeOf)add(m,memory(m.worldChangeOf),memory(m.id),'development',{field:'worldChangeOf'});
    if(m.identityClaim?.changeOf)add(m,memory(m.identityClaim.changeOf),memory(m.id),'development',{field:'identityClaim.changeOf'});
    for(const id of m.kind==='opinion'?m.basis?.memoryIds??[]:[])add(m,memory(m.id),memory(id),'basis');
    if(m.stateChangeOf)add(m,memory(m.stateChangeOf),memory(m.id),'state-progress');if(m.arcChangeOf)add(m,memory(m.arcChangeOf),memory(m.id),'arc-progress');
  }
  edges.sort((a,b)=>a.ownerId.localeCompare(b.ownerId)||a.type.localeCompare(b.type)||a.from.id.localeCompare(b.from.id)||a.to.id.localeCompare(b.to.id));
  return{edges,memories,currentIds,entities,pool};
}
function relationSearchText(memory:Memory):string {return typeof memory.text==='string'?memory.text:[memory.documentTitle,...(memory.navigationCues??[]),...(memory.narrative?.subjects??[]),memory.stateProjection?.topic,memory.arcProjection?.label].filter((v):v is string=>typeof v==='string').join('\n');}
const touches=(edge:StructureRelation,ids:Set<string>,entities:Set<string>)=>ids.has(edge.ownerId)||(edge.from.kind==='memory'?ids:entities).has(edge.from.id)||(edge.to.kind==='memory'?ids:entities).has(edge.to.id);
const relatedIds=(edges:StructureRelation[])=>[...new Set(edges.flatMap(e=>[e.ownerId,...[e.from,e.to].filter(n=>n.kind==='memory').map(n=>n.id)]))];
export function readStructureRelations(state:State,book:Book,seeds:RelationSeeds,options:StructureScope&{offset?:number;budget?:number;query?:string}={}){
  const graph=projectStructureRelations(state,book,options),ids=new Set((seeds.ids??[]).filter(id=>graph.memories.has(id))),entities=new Set((seeds.entityIds??[]).filter(id=>graph.entities.some(e=>e.id===id))),query=(options.query??'').normalize('NFKC').toLowerCase().trim(),words=query.split(/[\s，。、；：！？,.!?;:]+/).filter(Boolean),all=graph.edges.filter(e=>touches(e,ids,entities)&&(!words.length||words.some(w=>relatedIds([e]).some(id=>relationSearchText(graph.memories.get(id)!).normalize('NFKC').toLowerCase().includes(w))))),items:StructureRelation[]=[];
  let offset=options.offset??0,chars=0;if(!Number.isSafeInteger(offset)||offset<0)throw Error('关系目录游标无效');while(offset<all.length&&items.length<8){const e=all[offset],size=JSON.stringify(e).length;if(items.length&&chars+size>(options.budget??4000))break;items.push(structuredClone(e));chars+=size;offset++;}
  const materialIds=relatedIds(items),nodes=materialIds.map(id=>({id,kind:graph.memories.get(id)!.kind,history:!graph.currentIds.has(id)})),entityIds=[...new Set(items.flatMap(e=>[e.from,e.to].filter(n=>n.kind==='entity').map(n=>n.id)))];
  const index:StructureRelationIndex={scope:'work-memory-relations',items,nodes,entityIds,...([...graph.memories.values()].some(m=>m.text===undefined)?{searchScope:'metadata-and-loaded-bodies' as const}:{}),total:all.length,hasMore:offset<all.length,...(offset<all.length?{nextOffset:offset}:{})};
  return{index,records:materialIds.map(id=>graph.memories.get(id)!),historicalIds:nodes.filter(n=>n.history).map(n=>n.id)};
}
/** Bounded navigation for the current packet only; it creates no semantic links. */
export function relatedStructureIds(graph:ReturnType<typeof projectStructureRelations>,seeds:RelationSeeds){
  const distances=new Map<string,number>(),walk=(memorySeeds:readonly string[],entitySeeds:readonly string[],limit:number)=>{
    let ids=new Set(memorySeeds.filter(id=>graph.memories.has(id))),entities=new Set(entitySeeds.filter(id=>graph.entities.some(e=>e.id===id))),visitedIds=new Set(ids),visitedEntities=new Set(entities);
    for(let depth=1;depth<=limit;depth++){
      const edges=graph.edges.filter(e=>touches(e,ids,entities)),nextIds=new Set<string>(),nextEntities=new Set<string>();
      for(const id of relatedIds(edges)){distances.set(id,Math.min(distances.get(id)??depth,depth));if(!visitedIds.has(id)){visitedIds.add(id);nextIds.add(id);}}
      for(const e of edges)for(const node of [e.from,e.to])if(node.kind==='entity'&&!visitedEntities.has(node.id)){visitedEntities.add(node.id);nextEntities.add(node.id);}
      ids=nextIds;entities=nextEntities;if(!ids.size&&!entities.size)break;
    }
  };walk(seeds.ids??[],[],2);walk([],seeds.entityIds??[],3);return distances;
}
