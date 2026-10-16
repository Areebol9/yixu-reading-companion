import {bookLength,covers,id,mergeRanges,normalize} from './books.ts';
import {evidence,isBackgroundMemory,isCurrentMemory,isEvidenceAllowed,readableRanges,memoryIsForgotten} from './context.ts';
import {applyStateOperations,parseStateOperation,statePartSources,validateStateParts} from './stage-state.ts';
import {parseStructuralBasis,planStructuralBasis,validateStructuralBasis} from './basis.ts';
import type {NarrativePlanContext,NarrativeReadOptions} from './stage-state.ts';
import type {ArcOperation,ArcPart,ArcProjection,ArcUpdate,Book,Memory,Range,ReadingReply,State} from './types.ts';

export const arcRelations=['shared-event','enables','blocks','information','goal-change','delayed-effect','merge-split','feedback'] as const;
const roles=['open','progress','condition','impact'];
const fields=(raw:unknown,keys:string[])=>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!keys.includes(k)))throw Error('弧线字段无效');
  return raw as Record<string,any>;
};
const validIds=(raw:unknown):raw is string[]=>Array.isArray(raw)&&raw.length>0&&raw.length<=8&&raw.every(s=>typeof s==='string'&&/^p[1-9]\d{0,5}$/.test(s));
export function parseArcOperations(raw:unknown):ArcOperation[]{
  if(!Array.isArray(raw)||raw.length>64)throw Error('弧线须提交至多64条明确部件操作');
  return raw.map(value=>{
    const v=fields(value,['op','partId','text','memoryId','start','end','sourceIds','reason','role','impact']);
    const {role,impact,...base}=v,op=parseStateOperation(base);
    if(role!==undefined&&!roles.includes(role)||op.op==='add'&&role===undefined||op.op==='retire'&&(role!==undefined||impact!==undefined))throw Error('弧线部件职责无效');
    if(impact!==undefined){const p=fields(impact,['type','targetId','cognition']);if(!arcRelations.includes(p.type)||!['observed','inferred'].includes(p.cognition)||typeof p.targetId!=='string'||!p.targetId||p.targetId.length>128)throw Error('跨线影响类型、性质或目标无效');}
    if(role==='impact'&&!impact||impact&&role!==undefined&&role!=='impact')throw Error('跨线影响须明确impact职责与目标');
    return {...op,...(role?{role}:{}),...(impact?{impact}:{} )} as ArcOperation;
  });
}
export function parseArcUpdates(raw:unknown):ArcUpdate[]|undefined{
  if(raw===undefined)return;
  if(!Array.isArray(raw)||raw.length>6)throw Error('每批弧线更新至多6条');
  return raw.map(value=>{
    const v=fields(value,['label','arcChangeOf','status','operations','sourceIds','reason','end','basis']);
    if(v.label!==undefined&&(typeof v.label!=='string'||!v.label.trim()||v.label.length>80)||!v.arcChangeOf&&!v.label||v.arcChangeOf!==undefined&&(typeof v.arcChangeOf!=='string'||!v.arcChangeOf||v.arcChangeOf.length>128)||v.status!==undefined&&!['active','offstage','ended'].includes(v.status))throw Error('弧线身份、名称或状态无效');
    if(v.sourceIds!==undefined&&!validIds(v.sourceIds)||v.reason!==undefined&&(typeof v.reason!=='string'||!v.reason.trim()||v.reason.length>240))throw Error('弧线变化来源或理由无效');
    if(v.end!==undefined){const end=fields(v.end,['text','sourceIds']);if(typeof end.text!=='string'||!end.text.trim()||end.text.length>1800||!validIds(end.sourceIds))throw Error('整条弧线结束须明确原文收据');}
    if(v.status==='ended'&&(!v.arcChangeOf||!v.end)||v.end&&v.status!=='ended')throw Error('整线结束须有前身和明确end，不隐式清空部件');
    return {...v,...(v.basis!==undefined?{basis:parseStructuralBasis(v.basis)}:{}),label:v.label?.trim(),operations:parseArcOperations(v.operations)} as ArcUpdate;
  });
}
export function renderArcParts(parts:readonly Pick<ArcPart,'text'>[],end?:string):string{
  const text=[...parts.map(p=>p.text),...(end?[end]:[])].join('\n');
  if(!text.trim()||text.length>1800)throw Error('完整弧线正文须为1至1800字符，不截部件');return text;
}
function stateProxy(memory:Memory):Memory{const a=memory.arcProjection!;return {...memory,text:a.parts.length?a.parts.map(p=>p.text).join('\n'):a.end!.text,stateProjection:{topic:a.label,asOf:memory.evidence.map(({start,end})=>({start,end})),status:a.parts.length?'active':'ended',writeVersion:2,parts:a.parts,...(!a.parts.length?{end:a.end}:{})}};}
function proxyState(state:State):State{return {...state,memories:state.memories.map(m=>m.kind==='arc'?stateProxy(m):m)};}
export function applyArcOperations(state:State,book:Book,update:ArcUpdate,previous:Memory|undefined,ctx:NarrativePlanContext,versionId:string,arcId:string):ArcProjection{
  const ops=update.operations,oldParts=previous?.arcProjection!.parts??[];
  const zeroAfter=oldParts.length+ops.filter(o=>o.op==='add').length-ops.filter(o=>o.op==='retire').length===0;
  const delta=applyStateOperations(proxyState(state),book,{topic:previous?.arcProjection!.label??update.label!,operations:ops.map(({role,impact,...op})=>op),...(zeroAfter&&update.status==='ended'?{status:'ended',end:update.end}:{})},previous?stateProxy(previous):undefined,ctx);
  const changed=new Map<string,ArcOperation>();let added=0;
  for(const op of ops)if(op.op==='replace')changed.set(op.partId!,op);else if(op.op==='add')changed.set(delta.parts.filter(p=>!oldParts.some(o=>o.id===p.id))[added++].id,op);
  const parts=delta.parts.map(raw=>{
    const op=changed.get(raw.id);if(!op)return raw as ArcPart;
    const role=op.role??oldParts.find(p=>p.id===raw.id)?.role;
    if(!role)throw Error('新弧线部件须声明职责');
    const part:ArcPart={...raw,role};
    if(role==='impact'){
      if(!op.impact)throw Error('替换跨线影响须重新明确目标、关系及依据');
      const target=state.memories.find(m=>m.id===op.impact!.targetId);
      if(!target||target.kind!=='arc'||!ctx.parents.includes(target.id)||target.arcProjection!.arcId===arcId||target.partnerId!==state.partnerId||target.bookId!==book.id||isBackgroundMemory(target)!==(ctx.source==='background')||!isCurrentMemory(target)||!isEvidenceAllowed(book,target.evidence)||target.evidence.some(e=>!covers(ctx.refs,e)))throw Error('跨线目标须实际完整取得同书同来源的可见弧线具体版本');
      if(!part.sourceEvidence?.length&&part.memoryRef){const src=state.memories.find(m=>m.id===part.memoryRef!.memoryId)??[...(ctx.proposalSources?.values()??[])].find(m=>m.id===part.memoryRef!.memoryId);const selected=src?.sourceEvidence??(src?.sourceQuote?[src.sourceQuote.evidence]:[]);if(selected.length&&selected.every(e=>e.bookId===book.id&&e.version===book.version&&covers(ctx.refs,e)&&isEvidenceAllowed(book,[e])))part.sourceEvidence=structuredClone(selected);}
      if(!part.sourceEvidence?.length)throw Error('跨线影响须有精确原文或核验正文出处，完整围栏不是精确来源');
      part.impact={type:op.impact.type,cognition:op.impact.cognition,sourceArcId:arcId,sourceVersionId:versionId,targetArcId:target.arcProjection!.arcId,targetVersionId:target.id};
    }else if(op.impact)throw Error('非影响部件不能携带跨线关系');
    return part;
  });
  const status=update.status??previous?.arcProjection!.status??'active';
  if(previous&&status!==previous.arcProjection!.status&&status!=='ended'){
    if(!update.reason?.trim()||!update.sourceIds?.length)throw Error('弧线退出焦点或重新开启须有实际来源及理由');statePartSources(book,update.sourceIds,ctx);
  }
  const end=status==='ended'?(update.end?{text:update.end.text,sourceEvidence:statePartSources(book,update.end.sourceIds,ctx)}:previous?.arcProjection!.end):undefined;
  if(status==='ended'&&!end)throw Error('整线结束须保留明确收据');
  renderArcParts(parts,end?.text);
  return {arcId,label:update.label??previous!.arcProjection!.label,status,parts,...(end?{end}:{})};
}
export function validateArcParts(state:State,book:Book,m:Memory,live=false):void{
  const a=m.arcProjection;if(!a||typeof a.arcId!=='string'||!a.arcId||typeof a.label!=='string'||!a.label.trim()||a.label.length>80||!['active','offstage','ended'].includes(a.status)||!Array.isArray(a.parts)||a.parts.length>64||!a.parts.length&&a.status!=='ended'||renderArcParts(a.parts,a.end?.text)!==m.text)throw Error('弧线完整部件或身份无效');
  if(!['review','correction'].includes(m.source))validateStructuralBasis(m,[...(m.arcChangeOf?[m.arcChangeOf]:[]),...a.parts.flatMap(p=>[...(p.memoryRef?[p.memoryRef.memoryId]:[]),...(p.impact?[p.impact.targetVersionId]:[])])]);
  validateStateParts(proxyState(state),book,stateProxy(m),live);
  for(const p of a.parts){
    if(!roles.includes(p.role)||p.role==='impact'&&!p.impact||p.role!=='impact'&&p.impact)throw Error('弧线职责与影响字段不符');
    if(!p.impact)continue;const impact=p.impact,target=state.memories.find(x=>x.id===impact.targetVersionId),origin=state.memories.find(x=>x.id===impact.sourceVersionId);
    if(!arcRelations.includes(impact.type)||!['observed','inferred'].includes(impact.cognition)||!target||!origin||target.kind!=='arc'||origin.kind!=='arc'||impact.sourceArcId!==a.arcId||origin.arcProjection?.arcId!==a.arcId||target.arcProjection?.arcId!==impact.targetArcId||impact.targetArcId===a.arcId||target.bookId!==m.bookId||origin.bookId!==m.bookId||target.partnerId!==m.partnerId||origin.partnerId!==m.partnerId||isBackgroundMemory(target)!==isBackgroundMemory(m)||!m.parents.includes(target.id)||!p.sourceEvidence?.length||target.evidence.some(e=>!covers(m.evidence,e))||live&&(!isCurrentMemory(target)||!isEvidenceAllowed(book,target.evidence)||origin.forgotten||!isEvidenceAllowed(book,origin.evidence)))throw Error('跨线影响的历史双方版本或精确来源无效');
  }
  if(a.status==='ended'&&(!a.end||!a.end.text.trim()||!Array.isArray(a.end.sourceEvidence)||m.source!=='correction'&&!a.end.sourceEvidence.length)||a.status!=='ended'&&a.end)throw Error('弧线结束收据无效');
  if(a.end?.sourceEvidence.some(e=>e.bookId!==book.id||e.version!==book.version||e.start<0||e.end>bookLength(book)||!covers(m.evidence,e)||live&&!isEvidenceAllowed(book,[e])))throw Error('弧线结束出处无效');
}
function readableArcs(state:State,book:Book,options:NarrativeReadOptions={},includeInvalid=false):Memory[]{
  const scope={...book,known:readableRanges(book,options.extra??[]).map(r=>({start:r.start,end:Math.min(r.end,options.through??r.end)})).filter(r=>r.end>r.start)};
  const shadows=state.memories.map(memory=>{const copy={...memory};for(const field of ['replacedBy','invalidatedBy'] as const){const cause=state.memories.find(x=>x.id===copy[field]);if(cause&&!isEvidenceAllowed(scope,cause.evidence))delete copy[field];}return copy;});
  const scoped={...state,memories:shadows};
  return shadows.filter(m=>m.kind==='arc'&&m.bookId===book.id&&m.partnerId===state.partnerId&&isBackgroundMemory(m)===(options.source==='background')&&!m.forgotten&&isEvidenceAllowed(scope,m.evidence)&&!memoryIsForgotten(state,m)&&(includeInvalid||isCurrentMemory(m)&&(()=>{try{validateArcParts(scoped,scope,m,true);return true;}catch{return false;}})()));
}
export function permittedArcs(state:State,book:Book,options:NarrativeReadOptions={}):Memory[]{
  const items=readableArcs(state,book,options),ids=new Set(items.map(m=>m.id));
  return items.map(m=>{const copy=structuredClone(m);if(copy.arcChangeOf&&!ids.has(copy.arcChangeOf))delete copy.arcChangeOf;return copy;});
}
export function currentArcs(state:State,book:Book,options:NarrativeReadOptions={}):Memory[]{
  const all=readableArcs(state,book,options,true),valid=permittedArcs(state,book,options),aliases=new Map<string,string>();
  for(const m of valid){let key=m.correctionOf;const seen=new Set<string>();while(key&&!seen.has(key)){seen.add(key);const old=all.find(x=>x.id===key&&x.arcProjection!.arcId===m.arcProjection!.arcId);if(!old)break;aliases.set(old.id,m.id);key=old.correctionOf;}}
  const resolve=(key:string)=>{const seen=new Set<string>();while(aliases.has(key)&&!seen.has(key)){seen.add(key);key=aliases.get(key)!;}return key;};
  const continued=new Set<string>(),heads:Memory[]=[];
  for(const m of all)if(m.arcChangeOf)continued.add(resolve(m.arcChangeOf));
  for(const m of valid)if(!continued.has(m.id))heads.push(m);
  const identities=new Set<string>();for(const h of heads){if(identities.has(h.arcProjection!.arcId))throw Error('同一弧线有多个可见当前分叉，须明确修复');identities.add(h.arcProjection!.arcId);}
  return heads.map(m=>{if(m.arcChangeOf){const parent=resolve(m.arcChangeOf);if(valid.some(v=>v.id===parent))m.arcChangeOf=parent;else delete m.arcChangeOf;}return m;});
}
export function arcReviewEntries(state:State,book:Book,options:NarrativeReadOptions={}):Memory[]{
  const all=readableArcs(state,book,options,true),ids=new Set(currentArcs(state,book,options).map(m=>m.arcProjection!.arcId));
  return all.filter(m=>!ids.has(m.arcProjection!.arcId)&&!m.replacedBy&&(m.invalidatedBy||m.reviewDisposition==='unsupported')).map(m=>structuredClone(m));
}
export function planArcMemories(state:State,book:Book,reply:ReadingReply,ctx:NarrativePlanContext):Memory[]{
  const updates=parseArcUpdates(reply.arcUpdates)??[],heads=currentArcs(state,book,{source:ctx.source}),used=new Set<string>(),added:Memory[]=[];
  for(const update of updates){
    const previous=update.arcChangeOf?heads.find(m=>m.id===update.arcChangeOf):undefined;
    if(update.arcChangeOf&&(!previous||!ctx.parents.includes(previous.id)||used.has(previous.id)||previous.evidence.some(e=>!covers(ctx.refs,e))))throw Error('弧线进展须接续本轮完整取得的唯一可见当前版本');
    if(previous)used.add(previous.id);else if(update.operations.some(op=>op.op!=='add')||!update.operations.length)throw Error('新弧线只可明确add部件');
    if(previous&&!update.operations.length&&!update.end&&(!update.status||update.status===previous.arcProjection!.status)&&(!update.label||update.label===previous.arcProjection!.label))continue;
    const version=id(),root=previous?.arcProjection!.arcId??version;
    const projection=applyArcOperations(state,book,update,previous,ctx,version,root);
    const parents=[...new Set([...ctx.parents,...ctx.newMemoryIds,...(previous?[previous.id]:[]),...projection.parts.flatMap(p=>[...(p.memoryRef?[p.memoryRef.memoryId]:[]),...(p.impact?[p.impact.targetVersionId]:[])])])];
    const memory:Memory={id:version,bookId:book.id,partnerId:state.partnerId,kind:'arc',text:renderArcParts(projection.parts,projection.end?.text),arcProjection:projection,...(previous?{arcChangeOf:previous.id}:{}),evidence:mergeRanges(ctx.refs).map(r=>evidence(book,r)),parents,chatIds:[...ctx.chatIds],source:ctx.source,createdAt:Date.now(),forgotten:false,...(ctx.readingStage.length?{readingStage:mergeRanges(ctx.readingStage)}:{}),...(ctx.habitIds.length?{habitIds:[...ctx.habitIds]}:{})};
    const selected=[...projection.parts.flatMap(p=>p.sourceEvidence??[]),...(projection.end?.sourceEvidence??[])];if(selected.length)memory.sourceEvidence=mergeRanges(selected).map(r=>evidence(book,r));
    planStructuralBasis(state,book,memory,update.basis,ctx,[...(previous?[previous.id]:[]),...projection.parts.flatMap(p=>[...(p.memoryRef?[p.memoryRef.memoryId]:[]),...(p.impact?[p.impact.targetVersionId]:[])])]);
    validateArcParts({...state,memories:[...state.memories,memory]},book,memory,true);added.push(memory);
  }
  return added;
}
export function validateArcMemories(state:State):void{
  for(const m of state.memories){if(m.kind!=='arc'){if(m.arcProjection||m.arcChangeOf)throw Error('弧线元数据所属类型无效');continue;}const book=state.books.find(b=>b.id===m.bookId);if(!book)throw Error('弧线作品缺失');validateArcParts(state,book,m);const root=state.memories.find(x=>x.id===m.arcProjection!.arcId);if(!root||root.kind!=='arc'||root.bookId!==m.bookId||root.partnerId!==m.partnerId||root.arcProjection?.arcId!==root.id)throw Error('弧线初版身份无效');let prev=m.arcChangeOf;const seen=new Set([m.id]);while(prev){if(seen.has(prev))throw Error('弧线继起循环');seen.add(prev);const p=state.memories.find(x=>x.id===prev);if(!p||p.kind!=='arc'||p.arcProjection!.arcId!==m.arcProjection!.arcId||p.bookId!==m.bookId||p.partnerId!==m.partnerId||isBackgroundMemory(p)!==isBackgroundMemory(m))throw Error('弧线继起身份无效');if(prev===m.arcChangeOf&&!['correction','review'].includes(m.source)&&!m.parents.includes(prev))throw Error('弧线前身依赖缺失');prev=p.arcChangeOf;}}
}
export function analysisCoverage(state:State,book:Book,source:'preparation'|'reading'|'background'='preparation'):Range[]{
  return mergeRanges((state.readings??[]).filter(r=>r.bookId===book.id&&r.version===book.version&&r.partnerId===state.partnerId&&(r.source==='background')===(source==='background')&&r.arcCandidate==='v1'&&r.processing==='model').flatMap(r=>r.ranges).filter(r=>isEvidenceAllowed(book,[evidence(book,r)])));
}
