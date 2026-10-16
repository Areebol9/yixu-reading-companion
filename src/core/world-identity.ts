import {memoryTextLength,requireMemoryText} from './memory-bodies.ts';
import {covers,id,mergeRanges,normalize} from './books.ts';
import {evidence,isBackgroundMemory,isCurrentMemory,isUsableSourceVersion,isEvidenceAllowed,readableRanges,usableMemories,memoryIsForgotten} from './context.ts';
import {parseEntityRoots,parseWorldNote} from './world-schema.ts';
import type {Book,EntityRoot,Memory,Range,ReadingReply,State,WorldNote} from './types.ts';
import type {NarrativeReadOptions} from './stage-state.ts';

export function worldNote(value:WorldNote):WorldNote{return Object.fromEntries(['about','identityClaim','attribution','ruleLinks','worldChangeOf'].flatMap(k=>(value as any)[k]===undefined?[]:[[k,structuredClone((value as any)[k])]]));}
export function worldEntityIds(m:WorldNote):string[]{return [...new Set([...(m.about??[]).map(x=>x.entityId),m.identityClaim?.entityId,m.identityClaim?.targetId,m.identityClaim?.speakerId,m.attribution?.holderId,m.attribution?.speakerId].filter((s):s is string=>!!s))];}
function sameLane(m:Memory,root:EntityRoot):boolean{return m.bookId===root.bookId&&m.partnerId===root.partnerId&&isBackgroundMemory(m)===(root.source==='background')&&m.evidence.every(e=>e.version===root.version);}
function scopeBook(book:Book,options:NarrativeReadOptions):Book{return {...book,known:readableRanges(book,options.extra??[]).map(r=>({start:r.start,end:Math.min(r.end,options.through??r.end)})).filter(r=>r.end>r.start)};}
function allowedVersion(state:State,book:Book,id:string,source?:Memory['source']):Memory|undefined{
  const m=state.memories.find(m=>m.id===id);return m&&m.bookId===book.id&&m.partnerId===state.partnerId&&isBackgroundMemory(m)===(source==='background')&&!m.forgotten&&!m.invalidatedBy&&m.reviewDisposition!=='unsupported'&&isEvidenceAllowed(book,m.evidence)&&!memoryIsForgotten(state,m)?m:undefined;
}
function validBinding(state:State,book:Book,m:Memory,entityId:string):boolean{
  const binding=m.entityBindings?.find(b=>b.entityId===entityId),root=state.entityRoots?.find(r=>r.id===entityId);
  if(!root||!sameLane(m,root)||!binding)return false;
  const owner=allowedVersion(state,book,binding.memoryId,isBackgroundMemory(m)?'background':'reading');
  // Corrected binding versions are suspended even when independent speech text
  // remains valid. Normal recognition progress does not falsify old identity.
  return !!owner&&isUsableSourceVersion(state,owner)&&sameLane(owner,root)&&!!(owner.sourceEvidence?.length||owner.sourceQuote)&&owner.identityClaim?.type==='name'&&owner.identityClaim.entityId===entityId;
}
export function visibleWorldMemory(state:State,book:Book,m:Memory):Memory{
  const copy=structuredClone(m),bad=worldEntityIds(m).filter(id=>!validBinding(state,book,m,id));
  if(bad.length){copy.about=copy.about?.filter(x=>!bad.includes(x.entityId));if(copy.identityClaim&&[copy.identityClaim.entityId,copy.identityClaim.targetId,copy.identityClaim.speakerId].some(id=>id&&bad.includes(id)))delete copy.identityClaim;if(copy.attribution&&[copy.attribution.holderId,copy.attribution.speakerId].some(id=>id&&bad.includes(id)))delete copy.attribution;copy.entityBindings=copy.entityBindings?.filter(b=>!bad.includes(b.entityId));(copy as any).bindingAvailability='needs-review';}
  if(copy.attribution?.contentRef&&!allowedVersion(state,book,copy.attribution.contentRef.memoryId,isBackgroundMemory(copy)?'background':'reading')){delete copy.attribution.contentRef;(copy as any).contentAvailability='needs-review';}
  if(copy.ruleLinks!==undefined)copy.ruleLinks=copy.ruleLinks.filter(x=>allowedVersion(state,book,x.memoryId,isBackgroundMemory(copy)?'background':'reading'));
  if(copy.identityClaim?.changeOf&&!allowedVersion(state,book,copy.identityClaim.changeOf,isBackgroundMemory(copy)?'background':'reading'))delete copy.identityClaim.changeOf;
  if(copy.worldChangeOf&&!allowedVersion(state,book,copy.worldChangeOf,isBackgroundMemory(copy)?'background':'reading'))delete copy.worldChangeOf;
  return copy;
}
export function permittedWorldMemories(state:State,book:Book,options:NarrativeReadOptions&{history?:boolean}={}):Memory[]{
  const scope=scopeBook(book,options),shadows=state.memories.map(m=>{const copy={...m};for(const field of ['replacedBy','invalidatedBy'] as const){const cause=state.memories.find(x=>x.id===copy[field]);if(cause&&!isEvidenceAllowed(scope,cause.evidence))delete copy[field];}return copy;}),scoped={...state,memories:shadows};
  const all=(options.history?shadows.filter(m=>m.bookId===book.id&&m.partnerId===state.partnerId&&isUsableSourceVersion(scoped,m)&&isEvidenceAllowed(scope,m.evidence)&&!memoryIsForgotten(state,m)):usableMemories(scoped,scope)).filter(m=>isBackgroundMemory(m)===(options.source==='background')).map(m=>visibleWorldMemory(scoped,scope,m));
  const continued=new Set(all.flatMap(m=>[m.worldChangeOf,m.identityClaim?.changeOf].filter((s):s is string=>!!s)));
  return options.history?all:all.filter(m=>!continued.has(m.id));
}
export type EntityIndexItem={id:string;names:{name:string;cognition:NonNullable<Memory['identityClaim']>['cognition'];memoryId:string}[];claimIds:string[]};
export function entityIndex(state:State,book:Book,options:NarrativeReadOptions&{query?:string}={}):EntityIndexItem[]{
  const claims=permittedWorldMemories(state,book,options).filter(m=>m.identityClaim),roots=(state.entityRoots??[]).filter(r=>r.bookId===book.id&&r.version===book.version&&r.partnerId===state.partnerId&&(r.source==='background')===(options.source==='background'));
  return roots.flatMap(root=>{const owned=claims.filter(m=>m.identityClaim!.entityId===root.id),names=owned.filter(m=>m.identityClaim!.type==='name').map(m=>({name:m.identityClaim!.name!,cognition:m.identityClaim!.cognition,memoryId:m.id}));if(!owned.length||options.query&&!names.some(n=>normalize(n.name).includes(normalize(options.query!))))return [];return[{id:root.id,names,claimIds:owned.map(m=>m.id)}];});
}
export function entityMemories(state:State,book:Book,ids:readonly string[],options:NarrativeReadOptions&{history?:boolean}={}):Memory[]{
  const all=permittedWorldMemories(state,book,options),visible=new Set(entityIndex(state,book,options).map(x=>x.id)),wanted=new Set(ids.filter(id=>visible.has(id)));
  // One legal identity relation for discovery; never destructive union, never
  // convert claimed/inferred aliases into observed identity.
  const seeds=new Set(wanted);for(const m of all){const c=m.identityClaim;if(c?.type==='same-identity'&&c.cognition==='observed'&&c.targetId&&visible.has(c.entityId)&&visible.has(c.targetId)&&(seeds.has(c.entityId)||seeds.has(c.targetId))){wanted.add(c.entityId);wanted.add(c.targetId);}}
  return all.filter(m=>worldEntityIds(m).some(id=>wanted.has(id)));
}
export function worldCoverage(state:State,book:Book,source:Memory['source']='preparation'):Range[]{return mergeRanges((state.readings??[]).filter(r=>r.bookId===book.id&&r.version===book.version&&r.partnerId===state.partnerId&&(r.source==='background')===(source==='background')&&r.processing==='model'&&r.worldCandidate==='v1').flatMap(r=>r.ranges).filter(r=>isEvidenceAllowed(book,[evidence(book,r)])));}
export function prepareWorldReply(state:State,book:Book,reply:ReadingReply,enabled:boolean):{reply:ReadingReply;roots:EntityRoot[]}{
  if(!enabled){if(reply.entityRoots!==undefined||reply.thoughts.some(t=>Object.keys(worldNote(t)).length))throw Error('当前任务未开放世界与主体候选写入');return {reply,roots:[]};}
  const proposals=parseEntityRoots(reply.entityRoots)??[],mapping=new Map(proposals.map(p=>[p.key,id()]));
  const entity=(key:string)=>{if(/^new[1-8]$/.test(key)){const found=mapping.get(key);if(!found)throw Error('本轮新主体未声明来源');return found;}return key;};
  const thoughts=reply.thoughts.map(t=>{const note=parseWorldNote(t as any);if(note.about)note.about=note.about.map(x=>({...x,entityId:entity(x.entityId)}));if(note.identityClaim){const c=note.identityClaim;note.identityClaim={...c,entityId:entity(c.entityId),...(c.targetId?{targetId:entity(c.targetId)}:{}),...(c.speakerId?{speakerId:entity(c.speakerId)}:{})};}if(note.attribution)note.attribution={...note.attribution,holderId:entity(note.attribution.holderId),...(note.attribution.speakerId?{speakerId:entity(note.attribution.speakerId)}:{})};return{...t,...note};});
  return {reply:{...reply,thoughts},roots:proposals.map(p=>({id:mapping.get(p.key)!,bookId:book.id,version:book.version,partnerId:state.partnerId,source:'reading',originMemoryId:p.memoryId}))};
}
export class MissingWorldIdentityBindingsError extends Error{
  readonly bindings:{entityId:string;memoryIds:string[]}[];
  constructor(bindings:{entityId:string;memoryIds:string[]}[]){super('目录不授身份绑定，须取得完整合法name声明或同批有自身p的name声明');this.name='MissingWorldIdentityBindingsError';this.bindings=bindings;}
}
/** Recovery only refers to labels already supplied in this request. */
export function worldIdentityRecovery(error:MissingWorldIdentityBindingsError,labels:{memoryLabel:(id:string)=>string;entityLabel:(id:string)=>string}):Error{
  const missing=error.bindings.flatMap(binding=>{const entityId=labels.entityLabel(binding.entityId);if(!/^e\d+$/.test(entityId))return[];return[{entityId,ids:binding.memoryIds.map(id=>labels.memoryLabel(id)).filter(id=>/^m\d+$/.test(id)).slice(0,1)}];});
  const ids=[...new Set(missing.flatMap(m=>m.ids))],entityIds=missing.filter(m=>!m.ids.length).map(m=>m.entityId);
  const calls:string[]=[];
  for(let i=0;i<ids.length;i+=8)calls.push(JSON.stringify({ids:ids.slice(i,i+8)}));
  for(let i=0;i<entityIds.length;i+=8)calls.push(JSON.stringify({entityIds:entityIds.slice(i,i+8),view:'full'}));
  return Error(error.message+'。'+(missing.length?'缺少完整姓名依据的主体：'+missing.map(m=>m.entityId).join('、')+'。':'')+(calls.length?'依次调用 recall_memory '+calls.join('；')+' 取得合法name完整正文（有分页时继续nextOffset）。':'')+'保留原提交内容，取得依据后重交同一提交；不要改写事实或猜测绑定。');
}
export function bindWorldPlan(state:State,book:Book,added:Memory[],sources:ReadonlyMap<string,Memory>,roots:EntityRoot[],parents:string[],refs:Memory['evidence'],source:Memory['source']):void{
  const all=[...state.memories,...added],memory=(key:string)=>/^t\d+$/.test(key)?sources.get(key):all.find(m=>m.id===key&&parents.includes(m.id));
  const exact=(m:Memory)=>m.sourceEvidence??(m.sourceQuote?[m.sourceQuote.evidence]:[]);
  const usable=(m:Memory)=>typeof m.text==='string'&&m.bookId===book.id&&m.partnerId===state.partnerId&&isBackgroundMemory(m)===(source==='background')&&isUsableSourceVersion(state,m)&&isEvidenceAllowed(book,m.evidence)&&m.evidence.every(e=>covers(refs,e));
  for(const root of roots){const owner=memory(root.originMemoryId);if(!owner||!usable(owner)||!exact(owner).length||owner.identityClaim?.type!=='name'||owner.identityClaim.entityId!==root.id)throw Error('新主体须有本轮成功形成且绑定自身的精确原文声明');root.originMemoryId=owner.id;root.source=source==='background'?'background':'reading';}
  const visible=new Set(entityIndex(state,book,{source}).map(r=>r.id)),availableRoots=[...(state.entityRoots??[]).filter(r=>visible.has(r.id)),...roots],heads=permittedWorldMemories(state,book,{source}),continued=new Set(all.flatMap(m=>[m.worldChangeOf,m.identityClaim?.changeOf].filter((s):s is string=>!!s))),used=new Set<string>();
  const declarations=new Map<string,Memory>(),missing=new Map<string,string[]>();
  // Gather the whole missing binding set before constructing any entity edges.
  // The directory may suggest recovery, but only actual parents authorize it.
  for(const m of added){if(!Object.keys(worldNote(m)).length)continue;
    if(!exact(m).length||exact(m).some(e=>e.bookId!==book.id||e.version!==book.version||!covers(refs,e)||!isEvidenceAllowed(book,[e])))throw Error('身份、归属与规则声明须有自身精确原文依据，完整围栏不能代替出处');
    for(const entityId of worldEntityIds(m)){
      const root=availableRoots.find(r=>r.id===entityId);if(!root||!sameLane(m,root))throw Error('主体编号不属于当前书版本、伙伴及来源渠道');
      const declaration=all.find(x=>parents.includes(x.id)&&usable(x)&&x.identityClaim?.type==='name'&&x.identityClaim.entityId===entityId&&validBinding(state,book,x,entityId))??all.find(x=>added.includes(x)&&x.identityClaim?.type==='name'&&x.identityClaim.entityId===entityId&&usable(x)&&exact(x).length);
      if(declaration)declarations.set(entityId,declaration);
      else if(!missing.has(entityId))missing.set(entityId,heads.filter(x=>x.identityClaim?.type==='name'&&x.identityClaim.entityId===entityId&&validBinding(state,book,x,entityId)).sort((a,b)=>memoryTextLength(a)-memoryTextLength(b)||a.id.localeCompare(b.id)).map(x=>x.id));
    }
  }
  if(missing.size)throw new MissingWorldIdentityBindingsError([...missing].map(([entityId,memoryIds])=>({entityId,memoryIds})));
  for(const m of added){if(!Object.keys(worldNote(m)).length)continue;
    m.entityBindings=[];
    for(const entityId of worldEntityIds(m)){
      const declaration=declarations.get(entityId)!;
      if(declaration.id!==m.id&&!m.parents.includes(declaration.id))m.parents=[...m.parents,declaration.id];
      m.entityBindings.push({entityId,memoryId:declaration.id});
    }
    const ref=m.attribution?.contentRef;if(ref){const target=memory(ref.memoryId);if(!target||!usable(target)||typeof target.text!=='string'||ref.end>requireMemoryText(target).length||target.kind==='question'&&(ref.start!==0||ref.end!==memoryTextLength(target)))throw Error('归属内容必须实际取得具体版本及合法完整区间');ref.memoryId=target.id;if(target.id!==m.id&&!m.parents.includes(target.id))m.parents=[...m.parents,target.id];}
    for(const link of m.ruleLinks??[]){const target=memory(link.memoryId);if(!target||!usable(target)||target.narrative?.category!=='rule')throw Error('规则限定须实际取得对应规则全文及具体版本');link.memoryId=target.id;if(target.id!==m.id&&!m.parents.includes(target.id))m.parents=[...m.parents,target.id];}
    for(const key of ['worldChangeOf','identity'] as const){const priorKey=key==='identity'?m.identityClaim?.changeOf:m.worldChangeOf;if(!priorKey)continue;const prior=memory(priorKey);if(!prior||!heads.some(h=>h.id===prior.id)||continued.has(prior.id)&&!added.some(x=>x===m&&(x.worldChangeOf===prior.id||x.identityClaim?.changeOf===prior.id))||used.has(prior.id)||key==='identity'&&prior.identityClaim?.entityId!==m.identityClaim?.entityId||!usable(prior))throw Error('正常认识发展须接续实际完整取得的唯一当前声明');used.add(prior.id);if(key==='identity')m.identityClaim!.changeOf=prior.id;else m.worldChangeOf=prior.id;if(!m.parents.includes(prior.id))m.parents=[...m.parents,prior.id];}
  }
}
export function validateWorldState(state:State):void{
  if(state.entityRoots!==undefined&&(!Array.isArray(state.entityRoots)||state.entityRoots.length>200000))throw Error('主体目录无效');const ids=new Set<string>();
  for(const root of state.entityRoots??[]){const book=state.books.find(b=>b.id===root.bookId),origin=state.memories.find(m=>m.id===root.originMemoryId);if(typeof root.id!=='string'||!root.id||ids.has(root.id)||!book||root.version!==book.version||!origin||!sameLane(origin,root)||!['reading','background'].includes(root.source)||!worldEntityIds(origin).includes(root.id))throw Error('主体根的具体书版本和来源无效');ids.add(root.id);}
  for(const m of state.memories){parseWorldNote(worldNote(m) as any);if(Object.keys(worldNote(m)).length&&(!m.sourceEvidence?.length&&!m.sourceQuote||['context','stage','state','arc'].includes(m.kind)))throw Error('身份与归属只能附在有精确源的独立正文');const entities=worldEntityIds(m);if(entities.length){if(!Array.isArray(m.entityBindings)||m.entityBindings.length>24||entities.some(entityId=>!m.entityBindings!.some(b=>b.entityId===entityId)))throw Error('主体绑定缺少实际身份来源版本');for(const b of m.entityBindings){const root=state.entityRoots?.find(r=>r.id===b.entityId),owner=state.memories.find(x=>x.id===b.memoryId);if(!root||!owner||!sameLane(m,root)||!sameLane(owner,root)||owner.evidence.some(e=>!covers(m.evidence,e))||owner.identityClaim?.type!=='name'||owner.identityClaim.entityId!==root.id||!owner.sourceEvidence?.length&&!owner.sourceQuote)throw Error('主体绑定来源无效');}}
    const refs=[...(m.attribution?.contentRef?[m.attribution.contentRef.memoryId]:[]),...(m.ruleLinks??[]).map(x=>x.memoryId),m.worldChangeOf,m.identityClaim?.changeOf].filter((s):s is string=>!!s);for(const key of refs){const target=state.memories.find(x=>x.id===key);if(!target||target.bookId!==m.bookId||target.partnerId!==m.partnerId||isBackgroundMemory(target)!==isBackgroundMemory(m)||target.evidence.some(e=>!covers(m.evidence,e)))throw Error('身份、归属或规则具体版本越出完整围栏');}
    const ref=m.attribution?.contentRef;if(ref){const target=state.memories.find(x=>x.id===ref.memoryId)!;if(ref.end>memoryTextLength(target)||target.kind==='question'&&(ref.start!==0||ref.end!==memoryTextLength(target)))throw Error('归属正文引用越界');}
    const seen=new Set([m.id]);let previous=m.worldChangeOf??m.identityClaim?.changeOf;while(previous){if(seen.has(previous))throw Error('认识发展循环');seen.add(previous);const p=state.memories.find(x=>x.id===previous)!;previous=p.worldChangeOf??p.identityClaim?.changeOf;}
  }
}
