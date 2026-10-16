import {projectStructureRelations,strategyMemoryAllowed} from './structure-relations.ts';
import type {StructureRelation} from './structure-relations.ts';
import {arcReviewEntries} from './arc-state.ts';
import {chatAllowsMemory,isBackgroundMemory,isEvidenceAllowed,readableRanges} from './context.ts';
import {reviewableFact} from './fact-review.ts';
import {chatBelongsToPartner} from './discussion-recall.ts';
import {semanticNote,semanticSources} from './semantic-notes.ts';
import {semanticMaterial} from './semantic-material.ts';
import {memoryContentIdentity} from './memory-identity.ts';
import {requireMemoryText} from './memory-bodies.ts';
import type {Book,Chat,Evidence,Memory,Range,State} from './types.ts';

export const workDossierSections=['world-rules','entities','stages','states','arcs','questions','opinions','other','conversations'] as const;
export type WorkDossierSection=typeof workDossierSections[number];
export type WorkDossierRequest={view?:'index'|'full'|'sources';section?:WorkDossierSection;ids?:string[];entityIds?:string[];history?:boolean;offset?:number;limit?:number;profile?:'analysis'|'full-original';source?:'preparation'|'background';snapshot?:string};
type Missing={id:string;kind:'memory'|'entity'|'chat';availability:'unavailable'|'not-expanded'|'no-exact-source'};
type PartnerFormation=ReturnType<typeof semanticMaterial>['partnerFormation'];
type DossierItem={id:string;kind:Memory['kind']|'entity'|'chat';sections:WorkDossierSection[];version:'current'|'history';availability:'available'|'needs-review';bindingAvailability?:'needs-review';contentAvailability?:'needs-review';semanticAvailability?:'needs-review';partnerFormation?:PartnerFormation;text?:string;preview?:string;previewTruncated?:boolean;bodyExpanded:boolean;readingStage?:Range[];createdAt?:number;sourceRanges?:Evidence[];exposureRanges?:Evidence[];relations?:StructureRelation[];record?:Partial<Memory>&{partnerFormation?:PartnerFormation;semanticAvailability?:'needs-review'};entity?:{type:'unknown';names:{name:string;cognition:string;memoryId:string}[];memoryIds:string[]};conversation?:{role:Chat['role'];delivery?:Chat['delivery'];replyTo?:string;answerIds:string[]};unavailableReferences?:string[];sourceIndex?:number;chunkIndex?:number;range?:Evidence;nextTextStart?:number;correctedPrevious?:true};
export type WorkDossierResult={book:{id:string;title:string;version:string};scope:{profile:'analysis'|'full-original';source:'preparation'|'background';knownRanges:Range[]};snapshot:string;sections:{id:WorkDossierSection;label:string;currentCount:number;historyCount:number;availability:'available'|'disabled'|'needs-review';gaps:{availability:'needs-review';id:string}[];firstItems:{id:string;kind:DossierItem['kind'];version:DossierItem['version'];bodyExpanded:false}[]}[];items:DossierItem[];page:{offset:number;total:number;hasMore:boolean;nextOffset?:number;meaning:'query-traversal';snapshot:string;unexpandedBodyCount:number};missing:Missing[];ordering:'formation-order-not-story-time'};
const labels:Record<WorkDossierSection,string>={'world-rules':'世界与规则',entities:'主体与知情',stages:'阅读阶段',states:'状态主题',arcs:'故事弧线',questions:'原问与答案',opinions:'观点与依据',other:'其他认识',conversations:'实际交流'};
export function parseWorkDossierRequest(raw:unknown={}):WorkDossierRequest{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('作品档案参数无效');
  const q=raw as WorkDossierRequest;
  const validIds=(v:unknown)=>Array.isArray(v)&&v.length<=100&&v.every(id=>typeof id==='string'&&id.length>0&&id.length<=128)&&new Set(v).size===v.length;
  if(Object.keys(q).some(k=>!['view','section','ids','entityIds','history','offset','limit','profile','source','snapshot'].includes(k))||q.view!==undefined&&!['index','full','sources'].includes(q.view)||q.section!==undefined&&!workDossierSections.includes(q.section)||q.ids!==undefined&&!validIds(q.ids)||q.entityIds!==undefined&&!validIds(q.entityIds)||q.history!==undefined&&typeof q.history!=='boolean'||q.offset!==undefined&&(!Number.isSafeInteger(q.offset)||q.offset<0)||q.limit!==undefined&&(!Number.isSafeInteger(q.limit)||q.limit<1||q.limit>100)||q.profile!==undefined&&!['analysis','full-original'].includes(q.profile)||q.source!==undefined&&!['preparation','background'].includes(q.source)||q.snapshot!==undefined&&(typeof q.snapshot!=='string'||!q.snapshot||q.snapshot.length>100))throw Error('作品档案参数无效');
  return structuredClone(q);
}
// A traversal stamp, not authority. Every page is recomputed from current state.
function stamp(value:unknown):string{const s=JSON.stringify(value);let a=2166136261,b=5381;for(let i=0;i<s.length;i++){a=Math.imul(a^s.charCodeAt(i),16777619);b=Math.imul(b,33)^s.charCodeAt(i);}return `${s.length}-${a>>>0}-${b>>>0}`;}
function traversalMemory(m:Memory):unknown {
  const {text,bodyRef,documentTitle,navigationCues,...record}=m;
  // Cold references and their hydrated copies traverse the same archive.
  if(bodyRef)return {...record,contentIdentity:memoryContentIdentity(m)};
  return {...record,text};
}
function exactSources(m:Memory):Evidence[]{const refs=[...(m.sourceEvidence??[]),...(m.sourceQuote?[m.sourceQuote.evidence]:[]),...semanticSources(m),...[...(m.stateProjection?.parts??[]),...(m.arcProjection?.parts??[])].flatMap(p=>p.sourceEvidence??[]),...(m.stateProjection?.end?.sourceEvidence??[]),...(m.arcProjection?.end?.sourceEvidence??[])];return refs.filter((r,i)=>refs.findIndex(e=>e.bookId===r.bookId&&e.version===r.version&&e.start===r.start&&e.end===r.end)===i);}
export function projectWorkDossier(state:State,book:Book,raw:WorkDossierRequest={}):WorkDossierResult{
  const q=parseWorkDossierRequest(raw),profile=q.profile??'analysis',source=q.source??'preparation',view=q.view??'index',world=profile==='analysis'&&!!book.worldCandidate,arc=profile==='analysis'&&!!book.arcCandidate;
  const graph=projectStructureRelations(state,book,{source,readingStrategy:profile==='analysis'?'structured':'full-original',arcCandidate:arc?book.arcCandidate:undefined,worldCandidate:world?book.worldCandidate:undefined});
  const memories=graph.memories,entityIds=new Set(graph.entities.map(e=>e.id)),visible=(id:string)=>memories.has(id),allowedRefs=(refs:Evidence[]|undefined)=>(refs??[]).filter(e=>isEvidenceAllowed(book,[e]));
  const chats=source==='background'?[]:state.chats.filter(c=>c.bookId===book.id&&chatBelongsToPartner(state,c)&&chatAllowsMemory(state,c)&&!c.excluded&&!c.outdatedBy&&!c.replacedBy&&!c.futureGrant&&(c.role==='user'||c.delivery!=='pending')&&isEvidenceAllowed(book,c.evidence)),chatIds=new Set(chats.map(c=>c.id));
  const edges=profile==='full-original'?[]:graph.edges.filter(e=>world||!['about','identity','attribution','speaker','content','rule'].includes(e.type)&&!['worldChangeOf','identityClaim.changeOf'].includes(String(e.detail?.field??'')));
  const membership=new Map<string,Set<WorkDossierSection>>([...memories.keys()].map(id=>[id,new Set()]));
  const add=(id:string,section:WorkDossierSection)=>membership.get(id)?.add(section);
  for(const m of memories.values()){
    if(m.kind==='stage')add(m.id,'stages');else if(m.kind==='state')add(m.id,'states');else if(m.kind==='arc')add(m.id,'arcs');else if(m.kind==='question')add(m.id,'questions');else if(m.kind==='opinion')add(m.id,'opinions');
    if(world&&m.narrative?.category==='rule')add(m.id,'world-rules');
  }
  for(const e of edges){if(e.type==='rule'){add(e.from.id,'world-rules');add(e.to.id,'world-rules');}if(['about','identity','attribution'].includes(e.type)){if(e.from.kind==='memory')add(e.from.id,'entities');if(e.to.kind==='memory')add(e.to.id,'entities');add(e.ownerId,'entities');}if(['partial-answer','complete-answer'].includes(e.type)){add(e.from.id,'questions');add(e.to.id,'questions');}}
  for(const [id,sections]of membership)if(!sections.size)sections.add('other');
  const arcReviews=arc?arcReviewEntries(state,book,{source}):[];
  const reviewCandidates=state.memories.filter(m=>reviewableFact(state,book,m)&&isBackgroundMemory(m)===(source==='background')&&(profile==='analysis'||!['context','stage','state','arc'].includes(m.kind)));
  const reviews=[...arcReviews,...reviewCandidates.filter(m=>m.kind!=='arc'&&!memories.has(m.id)&&(m.invalidatedBy||m.reviewDisposition==='unsupported')&&strategyMemoryAllowed(state,m,profile==='analysis'?'structured':'full-original'))].filter(m=>!reviewCandidates.some(next=>next.id!==m.id&&[next.stateChangeOf,next.arcChangeOf,next.worldChangeOf,next.identityClaim?.changeOf,next.revisionKind==='development'?next.correctionOf:undefined].includes(m.id)));
  const currentIds=graph.currentIds;
  const snapshot=stamp({book:{id:book.id,version:book.version,known:readableRanges(book),world,arc},profile,source,memories:[...memories.values()].map(traversalMemory),current:[...currentIds],entities:graph.entities,chats,reviews:reviews.map(traversalMemory)});
  if(q.snapshot&&q.snapshot!==snapshot)throw Error('作品档案已变化，请从首页重新获取');
  const missing:Missing[]=[],all:DossierItem[]=[];
  const memoryItem=(m:Memory):DossierItem=>({id:m.id,kind:m.kind,sections:[...membership.get(m.id)!],version:currentIds.has(m.id)?'current':'history',availability:'available',...(world&&(m as any).bindingAvailability==='needs-review'?{bindingAvailability:'needs-review' as const}:{}),...(world&&(m as any).contentAvailability==='needs-review'?{contentAvailability:'needs-review' as const}:{}),...((m as any).semanticAvailability==='needs-review'?{semanticAvailability:'needs-review' as const}:{}),partnerFormation:semanticMaterial(m).partnerFormation,bodyExpanded:false,createdAt:m.createdAt,readingStage:structuredClone(m.readingStage),sourceRanges:structuredClone(allowedRefs(exactSources(m))),exposureRanges:structuredClone(allowedRefs(m.evidence))});
  for(const m of memories.values())all.push(memoryItem(m));
  for(const e of graph.entities){const related=new Set(edges.filter(x=>x.from.kind==='entity'&&x.from.id===e.id||x.to.kind==='entity'&&x.to.id===e.id).flatMap(x=>[x.ownerId,...[x.from,x.to].filter(n=>n.kind==='memory').map(n=>n.id)]));all.push({id:e.id,kind:'entity',sections:['entities'],version:'current',availability:'available',bodyExpanded:false,entity:{type:'unknown',names:structuredClone(e.names.filter(n=>visible(n.memoryId))),memoryIds:[...related].filter(visible)}});}
  for(const c of chats)all.push({id:c.id,kind:'chat',sections:['conversations'],version:'current',availability:'available',bodyExpanded:false,createdAt:c.createdAt,exposureRanges:structuredClone(allowedRefs(c.evidence)),conversation:{role:c.role,delivery:c.delivery,...(c.replyTo&&chatIds.has(c.replyTo)?{replyTo:c.replyTo}:{}),answerIds:chats.filter(a=>a.role==='assistant'&&a.replyTo===c.id).map(a=>a.id)}});
  for(const m of reviews){const section:WorkDossierSection=m.kind==='arc'?'arcs':m.kind==='stage'?'stages':m.kind==='state'?'states':m.kind==='question'?'questions':m.kind==='opinion'?'opinions':world&&m.narrative?.category==='rule'?'world-rules':'other';all.push({id:m.id,kind:m.kind,sections:[section],version:'current',availability:'needs-review',bodyExpanded:false});}
  const sections=workDossierSections.map(id=>{const disabled=(id==='world-rules'||id==='entities')&&!world||id==='arcs'&&!arc||['stages','states'].includes(id)&&profile==='full-original',items=all.filter(i=>i.sections.includes(id)),gaps=items.filter(i=>i.availability==='needs-review').map(i=>({availability:'needs-review' as const,id:i.id}));return{id,label:labels[id],currentCount:items.filter(i=>i.version==='current'&&i.availability==='available').length,historyCount:items.filter(i=>i.version==='history').length,availability:disabled?'disabled' as const:gaps.length?'needs-review' as const:'available' as const,gaps,firstItems:items.filter(i=>q.history||i.version==='current'||id==='questions').slice(0,5).map(i=>({id:i.id,kind:i.kind,version:i.version,bodyExpanded:false as const}))};});
  const selectedIds=new Set(q.ids??[]),selectedEntities=new Set(q.entityIds??[]),relatedIds=new Set(all.filter(i=>i.kind==='entity'&&selectedEntities.has(i.id)).flatMap(i=>[i.id,...i.entity!.memoryIds]));
  for(const id of selectedIds)if(!all.some(i=>i.id===id))missing.push({id,kind:'memory',availability:'unavailable'});
  for(const id of selectedEntities)if(!entityIds.has(id))missing.push({id,kind:'entity',availability:'unavailable'});
  let selected=all.filter(i=>(!q.section||i.sections.includes(q.section))&&(!selectedIds.size&&!selectedEntities.size||selectedIds.has(i.id)||relatedIds.has(i.id))&&(q.history||i.version==='current'||selectedIds.has(i.id)||view==='index'&&i.sections.includes('questions'))).sort((a,b)=>(a.createdAt??0)-(b.createdAt??0)||a.id.localeCompare(b.id));
  const filteredRecord=(m:Memory):Partial<Memory>=>{
    const r:Partial<Memory>={};const gaps:string[]=[];
    const pointer=(field:string,id:string|undefined,valid=visible)=>{if(!id)return undefined;if(valid(id))return id;gaps.push(field);return undefined;};
    const ids=(field:string,items:string[]|undefined,valid=visible)=>{const accepted=(items??[]).filter(valid);if(accepted.length!==(items??[]).length)gaps.push(field);return accepted;};
    r.parents=ids('parents',m.parents);r.chatIds=ids('chatIds',m.chatIds,id=>chatIds.has(id));if(m.basis)r.basis={memoryIds:ids('basis.memoryIds',m.basis.memoryIds),chatIds:ids('basis.chatIds',m.basis.chatIds,id=>chatIds.has(id))};
    for(const field of ['answersPartOf','stateChangeOf','arcChangeOf'] as const){const value=pointer(field,m[field]);if(value)r[field]=value;}
    if(m.revisionKind==='development'){r.revisionKind='development';r.correctionOf=pointer('correctionOf',m.correctionOf);}else if(m.correctionOf)gaps.push('correctedPrevious');
    if(m.replacedBy){const replacement=memories.get(m.replacedBy);if(replacement?.revisionKind==='development')r.replacedBy=m.replacedBy;}
    r.narrative=structuredClone(m.narrative);r.revisionReason=m.revisionReason;
    Object.assign(r,semanticNote(m),{partnerFormation:semanticMaterial(m).partnerFormation});
    if((m as any).semanticAvailability==='needs-review'){gaps.push('semantic');Object.assign(r,{semanticAvailability:'needs-review'});}
    if(m.stageNarrative)r.stageNarrative={...structuredClone(m.stageNarrative),previousStageId:pointer('previousStageId',m.stageNarrative.previousStageId)};
    const parts=(values:NonNullable<Memory['stateProjection']>['parts'])=>(values??[]).map(p=>{const copy=structuredClone(p);if(copy.memoryRef&&!visible(copy.memoryRef.memoryId)){delete copy.memoryRef;gaps.push('parts.memoryRef');}copy.sourceEvidence=allowedRefs(copy.sourceEvidence);if('impact'in copy){const impact=(copy as any).impact;if(impact&&(!visible(impact.sourceVersionId)||!visible(impact.targetVersionId))){delete(copy as any).impact;gaps.push('parts.impact');}else if(impact){if(!visible(impact.sourceArcId)){delete impact.sourceArcId;gaps.push('parts.impact.sourceArcId');}if(!visible(impact.targetArcId)){delete impact.targetArcId;gaps.push('parts.impact.targetArcId');}}}return copy;});
    if(m.stateProjection)r.stateProjection={...structuredClone(m.stateProjection),parts:parts(m.stateProjection.parts),...(m.stateProjection.end?{end:{text:m.stateProjection.end.text,sourceEvidence:allowedRefs(m.stateProjection.end.sourceEvidence)}}:{})};
    if(m.arcProjection){const a=structuredClone(m.arcProjection);a.parts=parts(a.parts) as typeof a.parts;if(!visible(a.arcId)){delete(a as Partial<typeof a>).arcId;gaps.push('arcId');}if(a.end)a.end.sourceEvidence=allowedRefs(a.end.sourceEvidence);r.arcProjection=a;}
    if(world){for(const field of ['bindingAvailability','contentAvailability'])if((m as any)[field]==='needs-review')gaps.push(field);r.about=m.about?.filter(a=>entityIds.has(a.entityId));if(m.identityClaim){const c=structuredClone(m.identityClaim);if([c.entityId,c.targetId,c.speakerId].every(id=>!id||entityIds.has(id))){c.changeOf=pointer('identityClaim.changeOf',c.changeOf);r.identityClaim=c;}else gaps.push('identityClaim');}if(m.attribution){const a=structuredClone(m.attribution);if(entityIds.has(a.holderId)&&(!a.speakerId||entityIds.has(a.speakerId))){if(a.contentRef&&!visible(a.contentRef.memoryId)){delete a.contentRef;gaps.push('attribution.contentRef');}r.attribution=a;}else gaps.push('attribution');}r.ruleLinks=m.ruleLinks?.filter(l=>visible(l.memoryId));r.worldChangeOf=pointer('worldChangeOf',m.worldChangeOf);r.entityBindings=m.entityBindings?.filter(b=>entityIds.has(b.entityId)&&visible(b.memoryId));}
    return Object.assign(r,{unavailableReferences:gaps});
  };
  const selectedBodyIds=new Set(selected.map(i=>i.id));
  if(view==='sources'){
    const chunks:DossierItem[]=[];
    for(const item of selected){const m=memories.get(item.id);if(!m){missing.push({id:item.id,kind:item.kind==='entity'?'entity':item.kind==='chat'?'chat':'memory',availability:item.availability==='needs-review'?'unavailable':'no-exact-source'});continue;}const refs=allowedRefs(exactSources(m));if(!refs.length)missing.push({id:item.id,kind:'memory',availability:'no-exact-source'});
      refs.forEach((ref,sourceIndex)=>{let start=ref.start,chunkIndex=0;while(start<ref.end){let end=Math.min(start+4000,ref.end);if(end<ref.end&&book.text.charCodeAt(end-1)>=0xD800&&book.text.charCodeAt(end-1)<=0xDBFF)end--;chunks.push({...item,bodyExpanded:false,sourceIndex,chunkIndex:chunkIndex++,range:{...ref,start,end},...(end<ref.end?{nextTextStart:end}:{})});start=end;}});
    }selected=chunks;
  }
  const offset=q.offset??0,limit=q.limit??20,page=selected.slice(offset,offset+limit);
  for(const item of page){const m=memories.get(item.id),chat=chats.find(c=>c.id===item.id);if(view==='sources'){item.text=book.text.slice(item.range!.start,item.range!.end);continue;}if(item.availability==='needs-review'&&!m){missing.push({id:item.id,kind:'memory',availability:'unavailable'});continue;}const text=m?(view==='full'?requireMemoryText(m):m.text):chat?.text;
    if(view==='full'){item.bodyExpanded=true;if(text!==undefined)item.text=text;if(m){const record=filteredRecord(m);item.unavailableReferences=(record as any).unavailableReferences;delete(record as any).unavailableReferences;item.record=record;item.relations=structuredClone(edges.filter(e=>e.ownerId===m.id||e.from.id===m.id||e.to.id===m.id));if(m.correctionOf&&m.revisionKind!=='development')item.correctedPrevious=true;}}
    else{if(text!==undefined){item.preview=text.slice(0,240);item.previewTruncated=text.length>240;}missing.push({id:item.id,kind:item.kind==='entity'?'entity':item.kind==='chat'?'chat':'memory',availability:'not-expanded'});item.relations=structuredClone(edges.filter(e=>['partial-answer','complete-answer','development','state-progress','arc-progress'].includes(e.type)&&(e.ownerId===item.id||e.from.id===item.id||e.to.id===item.id)));}
  }
  const next=offset+page.length,hasMore=next<selected.length,expandedIds=new Set(page.filter(i=>i.bodyExpanded).map(i=>i.id)),unexpandedBodyCount=[...selectedBodyIds].filter(id=>!expandedIds.has(id)).length;
  return structuredClone({book:{id:book.id,title:book.title,version:book.version},scope:{profile,source,knownRanges:readableRanges(book)},snapshot,sections,items:page,page:{offset,total:selected.length,hasMore,...(hasMore?{nextOffset:next}:{}),meaning:'query-traversal',snapshot,unexpandedBodyCount},missing,ordering:'formation-order-not-story-time'});
}
