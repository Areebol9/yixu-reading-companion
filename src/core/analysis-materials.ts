import {projectStructureRelations,relatedStructureIds,readStructureRelations} from './structure-relations.ts';
import type {StructureRelationIndex} from './structure-relations.ts';
import {entityIndex,permittedWorldMemories,worldEntityIds,worldNote} from './world-identity.ts';
import type {EntityIndexItem} from './world-identity.ts';
import {chatAllowsMemory,currentQuestion,isBackgroundMemory,isEvidenceAllowed,memorySources,readableParts} from './context.ts';
import {chatBelongsToPartner} from './discussion-recall.ts';
import {arcReviewEntries,permittedArcs} from './arc-state.ts';
import {canDevelopMemory} from './memory-plan.ts';
import {recallTerms,analysisCandidatePool} from './recall.ts';
import {displaySizeMaterial,narrativeIndexItem,narrativeMaterial} from './stage-materials.ts';
import {semanticMaterial} from './semantic-material.ts';
import type {ArcCandidate,Book,Chat,Memory,Range,ReadingStrategy,State} from './types.ts';

export const arcMaterial=narrativeMaterial;
export const arcIndexItem=narrativeIndexItem;
export type AnalysisIndexItem=(ReturnType<typeof narrativeIndexItem>|{id:string;kind:Memory['kind'];readingStage?:Range[]})&{history?:true};
export type AnalysisRecord=Memory&{history?:true};
export type AnalysisMaterials={relationIndex?:StructureRelationIndex;historicalSourceIds?:string[];entityIndex?:{items:EntityIndexItem[];hasMore:boolean};records:AnalysisRecord[];chats:Chat[];index:{items:AnalysisIndexItem[];hasMore:boolean};chatIndex:{items:{id:string;role:Chat['role'];createdAt:number}[];hasMore:boolean};chars:number;completeness:{complete:boolean;missingBodies:{id:string;kind:Memory['kind'];reason:'budget'}[];missingChats:{id:string;reason:'budget'}[]}};
export function analysisRecordMaterial(m:AnalysisRecord,source:Memory['source']='reading'){
  if(['arc','state','stage'].includes(m.kind))return{...narrativeMaterial(m),...(m.history?{history:true,canUpdate:false}:{})};
  return{id:m.id,kind:m.kind,text:m.text,...(m.history?{history:true}: {}),...worldNote(m),...semanticMaterial(m),entityBindings:m.entityBindings,bindingAvailability:(m as any).bindingAvailability,contentAvailability:(m as any).contentAvailability,narrative:m.narrative,readingStage:m.readingStage,answersPartOf:m.answersPartOf,origin:isBackgroundMemory(m)?'background':m.source,canUpdate:!m.history&&canDevelopMemory(m,source),updateReason:m.revisionReason,references:memorySources(m).map(({start,end})=>({start,end})),webSources:m.webSources};
}
export function analysisChatMaterial(chat:Chat){return{id:chat.id,role:chat.role,text:chat.text,replyTo:chat.replyTo,delivery:chat.delivery};}
export function analysisPacketChars(records:AnalysisRecord[],index:AnalysisMaterials['index'],source:Memory['source']='reading',missing:AnalysisMaterials['completeness']['missingBodies']=[],chats:Chat[]=[],chatIndex:AnalysisMaterials['chatIndex']={items:[],hasMore:false},missingChats:AnalysisMaterials['completeness']['missingChats']=[],entities?:AnalysisMaterials['entityIndex'],relations?:StructureRelationIndex):number{
  return JSON.stringify({...(relations?{analysisRelations:relations}:{}),...(entities?{entityIndex:{items:entities.items.map(x=>({...x,id:'e99999',names:x.names.map(n=>({...n,memoryId:'m99999'})),claimIds:x.claimIds.map(()=>'m99999')})),hasMore:entities.hasMore}}:{}),analysisMaterials:records.map(m=>displaySizeMaterial(analysisRecordMaterial(m,source))),analysisIndex:{items:index.items.map(displaySizeMaterial),hasMore:index.hasMore},analysisChats:chats.map(c=>({...analysisChatMaterial(c),id:'c99999',...(c.replyTo?{replyTo:'c99999'}:{})})),analysisChatIndex:{items:chatIndex.items.map(c=>({...c,id:'c99999'})),hasMore:chatIndex.hasMore},analysisCompleteness:{complete:!relations?.hasMore&&!entities?.hasMore&&!index.hasMore&&!chatIndex.hasMore&&!missing.length&&!missingChats.length&&!index.items.some(i=>(i as any).availability==='needs-review'),missingBodies:missing.map(m=>({...m,id:'m99999'})),missingChats:missingChats.map(m=>({...m,id:'c99999'}))}}).length;
}
export function selectAnalysisMaterials(state:State,book:Book,options:{focusRanges?:Range[];query?:string;source?:Memory['source'];extra?:Range[];budget?:number;arcCandidate?:ArcCandidate;worldCandidate?:'v1';readingStrategy?:ReadingStrategy;chats?:Chat[];queryMode?:boolean}={}):AnalysisMaterials{
  const source=options.source??'preparation',extra=options.extra??[],budget=options.budget??3575,strategy=options.readingStrategy??'structured';
  if(!Number.isSafeInteger(budget)||budget<0)throw Error('分析资料预算无效');
  const focus=(options.focusRanges??[]).flatMap(r=>readableParts(book,r,extra));
  const words=recallTerms((options.query??'')+'\n'+focus.map(r=>book.text.slice(r.start,r.end)).join('\n'));
  const queryWords=recallTerms(options.query??'');
  const queryScore=(m:Memory)=>{const terms=recallTerms(m.text+' '+(m.arcProjection?.label??m.stateProjection?.topic??''));let value=0;for(const word of queryWords)if(terms.has(word))value++;return value;};
  const score=(m:Memory)=>{const terms=recallTerms(m.text+' '+(m.arcProjection?.label??m.stateProjection?.topic??''));let value=0;for(const word of words)if(terms.has(word))value++;return value;};
  const opts={source,extra},pool=analysisCandidatePool(state,book,{source,extra,readingStrategy:strategy,arcCandidate:options.arcCandidate,worldCandidate:options.worldCandidate}),{ordinary,states,stages,arcs}=pool,versions=options.arcCandidate&&strategy!=='full-original'?permittedArcs(state,book,opts):[];
  // An explicit question is a separate priority, not diluted by thousands of
  // common focus words in a longer scene or prose record.
  const historical=permittedWorldMemories(state,book,{source,extra,history:true});
  const entityIdsFor=(m:Memory)=>[...new Set([...worldEntityIds(m),...[...(m.stateProjection?.parts??[]),...(m.arcProjection?.parts??[])].flatMap(p=>p.memoryRef?worldEntityIds(historical.find(x=>x.id===p.memoryRef!.memoryId)??{}):[])])];
  const graph=projectStructureRelations(state,book,{...options,source,extra}),relationSeeds={ids:pool.all.filter(m=>queryScore(m)>0||score(m)>0).map(m=>m.id),entityIds:options.worldCandidate?entityIndex(state,book,{source,extra}).filter(e=>e.names.some(n=>(options.query??'').includes(n.name)||focus.some(r=>book.text.slice(r.start,r.end).includes(n.name)))).map(e=>e.id):[]},adjacent=relatedStructureIds(graph,relationSeeds);
  const rank=(a:Memory,b:Memory)=>queryScore(b)-queryScore(a)||Number(adjacent.has(b.id))-Number(adjacent.has(a.id))||score(b)-score(a)||(adjacent.get(a.id)??99)-(adjacent.get(b.id)??99)||a.id.localeCompare(b.id),related=[...arcs,...states,...ordinary,...(options.queryMode?stages:[]),...graph.memories.values()].filter((m,i,all)=>all.findIndex(x=>x.id===m.id)===i&&(pool.all.some(p=>p.id===m.id)||adjacent.has(m.id))).sort(rank);
  const relations:StructureRelationIndex|undefined=graph.edges.length&&strategy!=='full-original'?{scope:'work-memory-relations',items:[],nodes:[],entityIds:[],total:0,hasMore:false}:undefined;
  const entities:AnalysisMaterials['entityIndex']=options.worldCandidate&&strategy!=='full-original'?{items:[],hasMore:false}:undefined;
  const entityCandidates=entities?entityIndex(state,book,{source,extra}):[],entityWanted=new Set(entityCandidates.filter(e=>e.names.some(n=>(options.query??'').includes(n.name)||focus.some(r=>book.text.slice(r.start,r.end).includes(n.name)))).map(e=>e.id));
  const records:AnalysisRecord[]=[],chats:Chat[]=[],index:AnalysisMaterials['index']={items:[],hasMore:false},chatIndex:AnalysisMaterials['chatIndex']={items:[],hasMore:false},missingChats:AnalysisMaterials['completeness']['missingChats']=[],missing:AnalysisMaterials['completeness']['missingBodies']=[],selected=new Set<string>(),catalogued=new Set<string>();
  const deferredNav:AnalysisIndexItem[]=[];
  const indexItem=(m:Memory):AnalysisIndexItem=>({...(['arc','stage','state'].includes(m.kind)?narrativeIndexItem(m):{id:m.id,kind:m.kind,readingStage:m.readingStage}),...(graph.memories.has(m.id)&&!graph.currentIds.has(m.id)?{history:true as const}:{})});
  const chargedMissing=(next:AnalysisMaterials['index'],taken:Memory[]=records)=>missing.filter(m=>next.items.some(i=>i.id===m.id)&&!taken.some(r=>r.id===m.id));
  const directory=(m:Memory)=>{
    if(selected.has(m.id)||catalogued.has(m.id))return;
    const item=indexItem(m),next={...index,items:[...index.items,item]};
    if(analysisPacketChars(records,next,source,chargedMissing(next),chats,chatIndex,missingChats,entities,relations)<=budget){index.items.push(item);catalogued.add(m.id);}else index.hasMore=true;
  };
  const take=(bundle:Memory[])=>{
    const fresh:AnalysisRecord[]=bundle.filter((m,i)=>!selected.has(m.id)&&bundle.findIndex(x=>x.id===m.id)===i).map(m=>Object.assign(structuredClone(graph.memories.get(m.id)??m),graph.currentIds.has(m.id)?{}:{history:true as const}));
    if(!fresh.length)return;
    const nextIndex={...index,items:[...index.items,...deferredNav].filter((item,i,all)=>!fresh.some(m=>m.id===item.id)&&all.findIndex(x=>x.id===item.id)===i)};
    if(analysisPacketChars([...records,...fresh],nextIndex,source,chargedMissing(nextIndex,[...records,...fresh]),chats,chatIndex,missingChats,entities,relations)<=budget){records.push(...fresh);fresh.forEach(m=>selected.add(m.id));index.items=options.queryMode?index.items.filter(item=>!fresh.some(m=>m.id===item.id)):nextIndex.items;for(let i=deferredNav.length-1;i>=0;i--)if(selected.has(deferredNav[i].id))deferredNav.splice(i,1);return;}
    for(const m of fresh){
      if(!missing.some(x=>x.id===m.id))missing.push({id:m.id,kind:m.kind,reason:'budget'});
      if(!options.queryMode){directory(m);continue;}
      if(['arc','state','stage'].includes(m.kind)&&(queryScore(m)>0||score(m)>0||adjacent.has(m.id))&&!deferredNav.some(i=>i.id===m.id)){
        const next={...index,items:[...index.items,...deferredNav,indexItem(m)]};
        if(analysisPacketChars(records,next,source,chargedMissing(next),chats,chatIndex,missingChats,entities,relations)<=budget)deferredNav.push(indexItem(m));
      }
    }
  };
  // Current explicit names need one complete legal declaration before long
  // arcs and ordinary histories compete for the same unchanged packet budget.
  const identityFor=(entityId:string)=>ordinary.filter(m=>m.identityClaim?.type==='name'&&m.identityClaim.entityId===entityId&&m.entityBindings?.some(b=>b.entityId===entityId)&&memorySources(m).length).sort((a,b)=>JSON.stringify(analysisRecordMaterial(a,source)).length-JSON.stringify(analysisRecordMaterial(b,source)).length||a.id.localeCompare(b.id))[0];
  for(const entity of (options.queryMode?[]:entityCandidates).filter(e=>entityWanted.has(e.id)).sort((a,b)=>Number(b.names.some(n=>(options.query??'').includes(n.name)))-Number(a.names.some(n=>(options.query??'').includes(n.name))) )){
    const name=identityFor(entity.id);if(name)take([name]);
  }
  const review=options.arcCandidate?arcReviewEntries(state,book,opts):[];
  const reviewIds=new Set(review.map(m=>m.id));
  const queue=options.queryMode?[...related,...review.filter(m=>queryScore(m)>0||score(m)>0)].sort(rank):related;
  for(const m of queue){
    if(options.queryMode&&reviewIds.has(m.id)){
      const next={...index,items:[...index.items,...deferredNav,indexItem(m)]};
      if(analysisPacketChars(records,next,source,chargedMissing(next),chats,chatIndex,missingChats,entities,relations)<=budget)deferredNav.push(indexItem(m));else index.hasMore=true;
      continue;
    }
    let referencedContext:Memory[]=[];
    if(options.worldCandidate&&(options.queryMode||entityIdsFor(m).some(id=>entityWanted.has(id)))){
      const names=options.queryMode?[]:entityIdsFor(m).flatMap(id=>{const name=identityFor(id);return name?[name]:[];});
      const referenced=[...(m.attribution?.contentRef?[m.attribution.contentRef.memoryId]:[]),...(m.ruleLinks??[]).map(l=>l.memoryId)];
      const context=historical.filter(x=>referenced.includes(x.id));
      if(options.queryMode)referencedContext=context;else take([m,...names,...context]);
    }

    if(m.kind==='arc'){
      // Traverse exactly one explicit edge in either direction, at its original versions.
      const links=versions.flatMap(v=>v.arcProjection!.parts.flatMap(p=>p.impact?[p.impact]:[])).filter(link=>link.sourceArcId===m.arcProjection!.arcId||link.targetArcId===m.arcProjection!.arcId);
      const endpoints=links.flatMap(l=>[versions.find(v=>v.id===l.sourceVersionId),versions.find(v=>v.id===l.targetVersionId)]).filter((v):v is Memory=>!!v);
      take([m,...endpoints,...referencedContext]);
    }else if(m.kind==='question'||m.answersPartOf){
      const q=m.kind==='question'?m:currentQuestion(state,book,m.answersPartOf!,extra);
      const permitted=q&&ordinary.find(o=>o.id===q.id);
      const answers=permitted?ordinary.filter(o=>o.answersPartOf&&currentQuestion(state,book,o.answersPartOf,extra)?.id===permitted.id):[];
      take([m,...(permitted?[permitted,...answers]:[]),...referencedContext]);
    }else if(m.revisionKind==='development'&&m.correctionOf&&graph.memories.get(m.correctionOf)?.kind==='question')take([m,graph.memories.get(m.correctionOf)!,...referencedContext]);else take([m,...referencedContext]);
  }
  if(!options.queryMode)for(const m of stages.sort((a,b)=>queryScore(b)-queryScore(a)||score(b)-score(a)||b.stageNarrative!.ranges.at(-1)!.end-a.stageNarrative!.ranges.at(-1)!.end))take([m]);
  if(options.queryMode){
    for(const item of deferredNav){if(!catalogued.has(item.id)&&!selected.has(item.id)){index.items.push(item);catalogued.add(item.id);}}
    for(const m of [...arcs,...states,...stages,...review].filter(m=>queryScore(m)>0||score(m)>0).sort(rank))directory(m);
    for(const m of [...related,...review].sort(rank))directory(m);
  }else for(const m of [...arcs,...states,...stages,...review])directory(m);
  const history=(options.chats??state.chats).filter(c=>c.bookId===book.id&&chatBelongsToPartner(state,c)&&chatAllowsMemory(state,c)&&!c.excluded&&!c.outdatedBy&&!c.replacedBy&&!c.futureGrant&&isEvidenceAllowed(book,c.evidence,extra)).sort((a,b)=>{
    const rank=(c:Chat)=>{let n=0;const t=recallTerms(c.text);for(const w of words)if(t.has(w))n++;return n;};return rank(b)-rank(a)||b.createdAt-a.createdAt;
  });
  for(const c of history){
    if(chats.some(x=>x.id===c.id))continue;
    const pair=c.role==='assistant'?history.find(q=>q.id===c.replyTo):history.find(a=>a.replyTo===c.id&&a.role==='assistant');
    const bundle=[c,...(pair&&!chats.some(x=>x.id===pair.id)?[pair]:[])];
    if(analysisPacketChars(records,index,source,chargedMissing(index),[...chats,...bundle],chatIndex,missingChats,entities,relations)<=budget)chats.push(...bundle.map(x=>structuredClone(x)));
    else {const item={id:c.id,role:c.role,createdAt:c.createdAt},next={items:[...chatIndex.items,item],hasMore:chatIndex.hasMore},missingNext=[...missingChats,{id:c.id,reason:'budget' as const}];if(analysisPacketChars(records,index,source,chargedMissing(index),chats,next,missingNext,entities,relations)<=budget){chatIndex.items.push(item);missingChats.push({id:c.id,reason:'budget'});}else chatIndex.hasMore=true;}
  }
  if(entities)for(const item of entityCandidates){
    if(!entityWanted.has(item.id)&&!records.some(m=>worldEntityIds(m).includes(item.id)))continue;
    const next={items:[...entities.items,item],hasMore:entities.hasMore};
    if(analysisPacketChars(records,index,source,chargedMissing(index),chats,chatIndex,missingChats,next,relations)<=budget)entities.items.push(item);else entities.hasMore=true;
  }
  if(relations){
    const seeds={ids:[...records.map(m=>m.id),...index.items.map(m=>m.id)],entityIds:entities?.items.map(e=>e.id)??[]},page=readStructureRelations(state,book,seeds,{...options,source,extra});relations.total=page.index.total;
    for(const edge of page.index.items){const nextEdges=[...relations.items,edge],memoryIds=[...new Set(nextEdges.flatMap(e=>[e.ownerId,...[e.from,e.to].filter(n=>n.kind==='memory').map(n=>n.id)]))],next={...relations,items:nextEdges,nodes:memoryIds.map(id=>({id,kind:graph.memories.get(id)!.kind,history:!graph.currentIds.has(id)})),entityIds:[...new Set(nextEdges.flatMap(e=>[e.from,e.to].filter(n=>n.kind==='entity').map(n=>n.id)))]};if(analysisPacketChars(records,index,source,chargedMissing(index),chats,chatIndex,missingChats,entities,next)<=budget)Object.assign(relations,next);else break;}
    relations.hasMore=relations.items.length<relations.total;
  }
  const reported=chargedMissing(index);
  const chars=analysisPacketChars(records,index,source,reported,chats,chatIndex,missingChats,entities,relations);
  if(chars>budget){throw Error('分析资料预算连必要包壳与未取齐标记也容纳不下，未扩大预算');}
  return{relationIndex:relations,historicalSourceIds:records.filter(m=>m.history).map(m=>m.id),entityIndex:entities,records,chats,index:structuredClone(index),chatIndex,chars,completeness:{complete:!relations?.hasMore&&!entities?.hasMore&&reported.length===0&&!missingChats.length&&!index.hasMore&&!chatIndex.hasMore&&!index.items.some(item=>(item as any).availability==='needs-review'),missingBodies:reported,missingChats}};
}
