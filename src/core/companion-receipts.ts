import {stampsEqual} from './memory-identity.ts';
import {maintenanceTaskCommitted} from './maintenance-dispatch.ts';
import {viewAllowed} from './published-views.ts';
import {validateTaskMaterialRef} from './storage-records.ts';
import {validateMaterialProjection} from './material-projection.ts';
import {isWorkspaceVersion} from './types.ts';
import { completeSubmitObject } from './agent-port.ts';
import {isNaturalReadingText,readingLegacySubmitBody} from './reading-output.ts';
import { bookLength, covers, hasBookText, mergeRanges, normalize } from './books.ts';
import { chatAllowsMemory,isBackgroundMemory, isEvidenceAllowed } from './context.ts';
import { chatBelongsToPartner } from './discussion-recall.ts';
import { draftBook } from './reading-drafts.ts';
import { pendingHabitInputStamp, queryMaterialStamp, queryMaterialState } from './query-checkpoints.ts';
import { ReadingReferences } from './reading-references.ts';
import { publicWebUrl } from './web.ts';
import {correctionRepairUsable} from './companion-correction-repair.ts';
import type { AgentModelReply, Book, CompanionReadingReceipt, ModelReply, QueryMaterial, ReadingDraftRequest, State } from './types.ts';

type Candidate = CompanionReadingReceipt['candidate'];
const requests = ['read','lookup','recall','history','search','readPage'];
const normalizedRanges = (ranges:ReadingDraftRequest['ranges']) => JSON.stringify(mergeRanges(ranges));
const sameRequest = (a:ReadingDraftRequest,b:ReadingDraftRequest) => a.source===b.source && a.input===b.input && a.maintenanceJobId===b.maintenanceJobId&&a.maintenanceClaim===b.maintenanceClaim&&JSON.stringify(a.sceneCommentIds??[])===JSON.stringify(b.sceneCommentIds??[])&&normalizedRanges(a.ranges)===normalizedRanges(b.ranges);
const belongs = (state:State,r:CompanionReadingReceipt) => state.books.some(b=>b.id===r.bookId&&b.version===r.version)&&state.partners.some(p=>p.id===r.partnerId);
const sameReceiptTask = (a:CompanionReadingReceipt,b:CompanionReadingReceipt) => a.requestKey===b.requestKey&&a.bookId===b.bookId&&a.version===b.version&&a.partnerId===b.partnerId&&
  a.request.source===b.request.source&&a.request.input===b.request.input&&JSON.stringify(a.request.ranges)===JSON.stringify(b.request.ranges);

/** Only caller-declared supersession links, not overlapping material, form a chain. */
export function companionReadingReceiptIds(state:State,latestId:string):string[] {
  const receipts=new Map((state.companionReadingReceipts??[]).map(r=>[r.id,r])),ids:string[]=[];let current=receipts.get(latestId);
  if(!current)return[latestId];
  while(current){
    if(!validUsage(state,current))throw Error('伴读原答替代链缺少同任务的真实调用');
    if(ids.includes(current.id))throw Error('伴读原答替代链循环');ids.push(current.id);
    if(!current.supersedesId)break;
    const previous=receipts.get(current.supersedesId);
    if(!previous||!sameReceiptTask(current,previous)||!validUsage(state,previous))throw Error('伴读原答替代链未指向同任务的真实前回执');
    current=previous;
  }
  return ids;
}

function superseded(state:State,r:CompanionReadingReceipt):boolean {
  return (state.companionReadingReceipts??[]).some(next=>next.supersedesId===r.id&&sameReceiptTask(next,r)&&validUsage(state,next));
}

/** The provider has ended this turn. No semantic repair and no reasoning is kept. */
export function readingReceiptCandidate(response:ModelReply|AgentModelReply,preserveSubmitRaw=false):Candidate|undefined {
  let text:string,transport:Candidate['transport'],format:Candidate['format'];
  let finalText:string|undefined;
  let proposal:string|undefined;
  let reaction:string|undefined;
  if ('toolCalls' in response) {
    transport='agent';
    if(response.toolCalls.length){
      const exits=response.toolCalls.filter(t=>t.function.name==='finish_reading'),notes=response.toolCalls.filter(t=>t.function.name==='submit_reading'),reactions=response.toolCalls.filter(t=>t.function.name==='react_to_reading');
      if(response.finish==='tool_calls'&&exits.length===1&&notes.length<=1&&response.toolCalls.length===exits.length+notes.length+reactions.length){format='reading-text';text=exits[0].function.arguments;proposal=notes[0]?.function.arguments;
        if(reactions.length)reaction=reactions.length===1?reactions[0].function.arguments:JSON.stringify(reactions.map(call=>call.function.arguments));}
      else{if(response.finish!=='tool_calls'||response.toolCalls.length!==1||notes.length!==1)return;
        format='submit';text=preserveSubmitRaw?notes[0].function.arguments:completeSubmitObject(notes[0].function.arguments);if(isNaturalReadingText(response.content))finalText=response.content;}
    }else{if(response.finish!=='stop')return;format='content';text=response.content;}
  }else{transport='json';format='content';text=response.content;}
  if(typeof text!=='string'||!text.trim()&&!finalText||text.length>100000)return;
  if(format==='reading-text')return{transport,format,text,...(proposal!==undefined?{proposal}:{}),...(reaction!==undefined?{reaction}:{})};
  if(finalText)return{transport,format,text,finalText};
  const trimmed=text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  let value:unknown;
  try{value=JSON.parse(trimmed);}catch{
    if(transport==='json'||format==='submit'||/^[{\[]|^```/u.test(text.trim()))return;
    return{transport,format,text};
  }
  if(!value||typeof value!=='object'||Array.isArray(value)||requests.some(key=>Object.hasOwn(value as object,key)))return;
  return{transport,format,text};
}

function validUsage(state:State,r:CompanionReadingReceipt):boolean {
  const usage=state.usage.find(u=>u.id===r.id);
  if(!usage||usage.status!=='complete'||usage.dispatchState!=='response-received'||usage.requestKey!==r.requestKey)return false;
  try{
    const key=JSON.parse(r.requestKey);
    return Array.isArray(key)&&(r.request.correctionRepairId?key.length===6&&key[5]===r.request.correctionRepairId:r.request.maintenanceJobId?key.length===8&&key[5]==='maintenance'&&key[6]===r.request.maintenanceJobId&&key[7]===r.request.maintenanceClaim:r.request.sceneCommentIds?.length?key.length===7&&key[5]==='scene'&&JSON.stringify(key[6])===JSON.stringify(r.request.sceneCommentIds):r.material?.taskRole?key.length===6&&key[5]===r.material.taskRole:key.length===5||!r.material&&!!r.materialRef&&key.length===6&&['scene','maintenance'].includes(key[5]))&&key[0]===r.bookId&&key[1]===r.version&&key[2]===r.partnerId&&key[3]===r.request.source&&JSON.stringify(key[4])===JSON.stringify(r.request.ranges.map(({start,end})=>({start,end})));
  }catch{return false;}
}

/** A formed draft or published reading takes over the same returned work. */
function consumed(state:State,r:CompanionReadingReceipt,seen=new Set<string>()):boolean {
  if(seen.has(r.id))return false;seen.add(r.id);
  if(maintenanceTaskCommitted(state,{bookId:r.bookId,version:r.version,partnerId:r.partnerId,maintenanceJobId:r.request.maintenanceJobId,maintenanceClaim:r.request.maintenanceClaim}))return true;
  if(state.readingDrafts?.some(d=>(d.id===r.id||d.supersededReceiptIds?.includes(r.id)&&sameRequest(d,r.request))&&d.bookId===r.bookId&&d.version===r.version&&d.partnerId===r.partnerId) ||
    state.readings?.some(d=>(d.draftId===r.id||d.source===r.request.source&&d.supersededReceiptIds?.includes(r.id))&&d.bookId===r.bookId&&d.version===r.version&&d.partnerId===r.partnerId))return true;
  return (state.companionReadingReceipts??[]).some(next=>next.supersedesId===r.id&&sameReceiptTask(next,r)&&validUsage(state,next)&&consumed(state,next,seen));
}

/** Record before checking Abort/current-task state; changed sources become blocked. */
export function receiveCompanionReadingReceipt(state:State,book:Book,request:ReadingDraftRequest,requestKey:string,usageId:string,material:QueryMaterial,stamp:string,response:ModelReply|AgentModelReply,supersedesId?:string):CompanionReadingReceipt|undefined {
  const candidate=readingReceiptCandidate(response,material.outputProtocol!==undefined)??(material.taskRole==='scene'&&response.content.trim()&&(!('toolCalls'in response)||response.finish==='stop')?{transport:'toolCalls'in response?'agent' as const:'json' as const,format:'content' as const,text:response.content}:undefined);if(!candidate)return;
  if(candidate.format==='reading-text'&&material.outputProtocol===undefined)return;
  if(candidate.format==='submit'&&material.outputProtocol!==undefined){
    if(material.readingStrategy==='companion')return;
    try{if(readingLegacySubmitBody(candidate.text)===undefined)return;}catch{return;}
  }
  const old=state.companionReadingReceipts?.find(r=>r.id===usageId);if(old){if(old.requestKey!==requestKey||old.bookId!==book.id||old.version!==book.version||!sameRequest(old.request,request))throw Error('原调用已绑定其他阅读回执');return old;}
  let partnerId:string;try{partnerId=JSON.parse(requestKey)[2];}catch{throw Error('伴读原答任务编号无效');}
  const value:CompanionReadingReceipt={id:usageId,requestKey,bookId:book.id,version:book.version,partnerId,
    ...(supersedesId!==undefined?{supersedesId}:{}),
    request:structuredClone(request),
    material:structuredClone({...material,messages:material.messages.filter(m=>m.role==='user').map(m=>({role:'user' as const,content:m.content}))}),
    dependencyStamp:stamp,candidate,status:'received',createdAt:Date.now()};
  if(!validUsage(state,value))throw Error('伴读原答须关联同一已收到完整回执的实际调用');
  const validation={...state,companionReadingReceipts:[...(state.companionReadingReceipts??[]),value]};validateCompanionReadingReceipts(validation);
  if(consumed(state,value))return;
  if(!companionReadingReceiptUsable(state,value)){value.status='blocked';value.blockedReason='原答形成资料或阅读权限已变化，保留原回执并停止自动重答';}
  (state.companionReadingReceipts??=[]).push(value);return value;
}

/** Return blocked receipts too, so a caller cannot mistake them for unrequested work. */
export function matchingCompanionReadingReceipt(state:State,book:Book,request:ReadingDraftRequest,requestKey?:string):CompanionReadingReceipt|undefined {
  return (state.companionReadingReceipts??[]).filter(r=>r.bookId===book.id&&r.version===book.version&&r.partnerId===state.partnerId&&
    (!requestKey||r.requestKey===requestKey)&&sameRequest(r.request,request)&&!consumed(state,r)&&!superseded(state,r)).sort((a,b)=>b.createdAt-a.createdAt).at(0);
}

export function companionReadingReceiptUsable(state:State,r:CompanionReadingReceipt):boolean {
  if(!r.material)return false;
  try{
    const book=state.books.find(b=>b.id===r.bookId&&b.version===r.version),m=r.material;
    if(m.correctionRepairId&&(m.correctionRepairId!==r.request.correctionRepairId||!state.companionCorrectionRepairs?.some(p=>p.id===m.correctionRepairId&&correctionRepairUsable(state,p))))return false;
    if(!book||!belongs(state,r)||r.status!=='received'||!validUsage(state,r)||consumed(state,r)||superseded(state,r)||!['companion','full-original','structured'].includes(m.readingStrategy??'')||m.narrativeMode==='stages')return false;
    const scope=draftBook(book,r.request),formed=queryMaterialState(state,m),background=r.request.source==='background';
    if(!isEvidenceAllowed(scope,m.refs)||!isEvidenceAllowed(scope,r.request.ranges.map(range=>({...range,bookId:book.id,version:book.version})))||!stampsEqual(queryMaterialStamp(state,m),r.dependencyStamp))return false;
    if(m.viewIds?.some(id=>{const view=state.publishedViews?.find(v=>v.id===id);return!view||!viewAllowed(state,scope,view);}))return false;
    if(m.pendingHabits&&m.habitInputStamp!==pendingHabitInputStamp(state,m.pendingHabits))return false;
    if([...m.memoryIds,...(m.partialMemoryIds??[])].some(id=>!formed.memories.some(x=>x.id===id&&x.bookId===book.id&&x.partnerId===r.partnerId&&!x.forgotten&&!x.invalidatedBy&&
      isBackgroundMemory(x)===background&&isEvidenceAllowed(scope,x.evidence)))||m.chatIds.some(id=>!formed.chats.some(x=>x.id===id&&x.bookId===book.id&&chatBelongsToPartner({...formed,partnerId:r.partnerId},x)&&chatAllowsMemory(formed,x)&&!x.excluded&&(!x.outdatedBy&&!x.replacedBy||m.historicalCommentIds?.includes(id)&&x.presentation==='paragraph')&&!x.futureGrant&&isEvidenceAllowed(scope,x.evidence))))return false;
    if(m.habitIds.some(id=>!formed.habits?.some(h=>h.id===id&&h.partnerId===r.partnerId&&!h.forgotten&&!h.retiredBy&&!h.invalidatedBy)))return false;
    if(m.originalRanges.some(range=>!isEvidenceAllowed(scope,[{...range,bookId:book.id,version:book.version}])))return false;
    if(m.passages.some(([,p])=>p.evidence.bookId!==book.id||p.evidence.version!==book.version||!covers(m.originalRanges,p.evidence)||!covers(m.refs,p.evidence)||hasBookText(book)&&book.text.slice(p.evidence.start,p.evidence.end)!==p.text))return false;
    const text=normalize(JSON.stringify([r.candidate,m.messages]));if(state.forgotten.some(f=>f.bookId===book.id&&text.includes(normalize(f.text))))return false;
    // workspaceRevision is formation metadata, not a source dependency. A newer
    // foreground handoff prevents publication in the engine, not raw recovery.
    return true;
  }catch{return false;}
}

export function validateCompanionReadingReceipts(state:State):void {
  if(state.companionReadingReceipts===undefined)return;
  if(!Array.isArray(state.companionReadingReceipts)||state.companionReadingReceipts.length>1500)throw Error('伴读原答回执记录无效');
  const seen=new Set<string>(),ids=(v:unknown):v is string[]=>Array.isArray(v)&&v.length<=256&&v.every(x=>typeof x==='string'&&!!x&&x.length<=128);
  for(const r of state.companionReadingReceipts){
    const book=state.books.find(b=>b.id===r?.bookId&&b.version===r.version),m=r?.material;
    if(!r||typeof r.id!=='string'||!r.id||seen.has(r.id)||Object.keys(r).some(k=>!['id','requestKey','bookId','version','partnerId','supersedesId','request','material','materialRef','dependencyStamp','candidate','status','createdAt','blockedReason'].includes(k)))throw Error('伴读原答回执身份无效');
    seen.add(r.id);
    // Deleted scopes are tombstoned by pruning. A stale receipt must not make
    // restart fail merely because its book/version or partner was removed.
    if(!book||!state.partners.some(p=>p.id===r.partnerId))continue;
    if(!m&&r.materialRef){validateTaskMaterialRef(r.materialRef);if(!validUsage(state,r)||!r.candidate||typeof r.dependencyStamp!=='string'||!['received','blocked'].includes(r.status))throw Error('冷伴读回执身份无效');continue;}
    if(m)validateMaterialProjection({...state,partnerId:r.partnerId},book,m);
    if(r.request.maintenanceJobId!==undefined&&(typeof r.request.maintenanceJobId!=='string'||!r.request.maintenanceJobId||typeof r.request.maintenanceClaim!=='string'||!/^[a-f0-9]{64}$/.test(r.request.maintenanceClaim)||m.taskRole!=='maintenance'||m.maintenanceJobId!==r.request.maintenanceJobId)||r.request.maintenanceClaim!==undefined&&!r.request.maintenanceJobId)throw Error('维护回执的原任务或claim身份无效');
    const ranges=(value:unknown):boolean=>Array.isArray(value)&&value.length<=5000&&value.every(x=>x&&Number.isSafeInteger(x.start)&&Number.isSafeInteger(x.end)&&x.start>=0&&x.end>x.start&&x.end<=bookLength(book!));
    if(!validUsage(state,r)||
      !['received','blocked'].includes(r.status)||!Number.isFinite(r.createdAt)||r.createdAt<0||typeof r.dependencyStamp!=='string'||
      r.blockedReason!==undefined&&typeof r.blockedReason!=='string'||!r.request||!['preparation','reading','background'].includes(r.request.source)||
      typeof r.request.input!=='string'||r.request.input.length>30000||!ranges(r.request.ranges)||!r.request.ranges.length||!m||!['companion','full-original','structured'].includes(m.readingStrategy??'')||m.narrativeMode==='stages'||
      !ranges(m.refs)||m.refs.some(e=>e.bookId!==book.id||e.version!==book.version)||!ranges(m.originalRanges)||!ranges(m.ranges)||!ids(m.memoryIds)||!ids(m.partialMemoryIds??[])||!ids(m.chatIds)||!ids(m.habitIds)||
      !Array.isArray(m.messages)||m.messages.length>64||m.messages.some(x=>x?.role!=='user'||typeof x.content!=='string'||Object.keys(x).some(k=>!['role','content'].includes(k)))||
      !Array.isArray(m.passages)||m.passages.length>10000||!Array.isArray(m.webSources)||m.webSources.length>10||!Array.isArray(m.readUrls)||m.readUrls.some(x=>typeof x!=='string')||
      !r.candidate||!['agent','json'].includes(r.candidate.transport)||!['submit','content','reading-text'].includes(r.candidate.format)||typeof r.candidate.text!=='string'||!r.candidate.text.trim()&&!r.candidate.finalText||r.candidate.text.length>100000||r.candidate.finalText!==undefined&&(r.candidate.format!=='submit'||typeof r.candidate.finalText!=='string'||!isNaturalReadingText(r.candidate.finalText))||
      r.candidate.proposal!==undefined&&(r.candidate.format!=='reading-text'||typeof r.candidate.proposal!=='string')||r.candidate.format==='reading-text'&&(r.candidate.transport!=='agent'||!['reading-text-v1','reading-documents-v1'].includes(m.outputProtocol??''))||m.outputProtocol!==undefined&&!['reading-text-v1','reading-documents-v1'].includes(m.outputProtocol??'')||
      r.candidate.reaction!==undefined&&(r.candidate.format!=='reading-text'||typeof r.candidate.reaction!=='string')||
      m.outputReactionAllowed!==undefined&&(m.outputReactionAllowed!==true||!['reading-text-v1','reading-documents-v1'].includes(m.outputProtocol??'')||r.request.source!=='reading')||
      Object.keys(r.candidate).some(k=>!['transport','format','text','finalText','proposal','reaction'].includes(k))||JSON.stringify(r).length>2000000)throw Error('伴读原答回执的任务、调用或形成材料无效');
    if(m.narrativeMode!==undefined&&!['legacy','stages'].includes(m.narrativeMode)||m.stateWriteVersion!==undefined&&![1,2].includes(m.stateWriteVersion)||
      m.arcCandidate!==undefined&&m.arcCandidate!=='v1'||m.worldCandidate!==undefined&&m.worldCandidate!=='v1'||m.analysisTask!==undefined&&m.analysisTask!==true||
      m.sourceStampVersion!==undefined&&m.sourceStampVersion!==2||m.outputProtocol==='reading-documents-v1'&&m.readingStrategy!=='companion'||m.basisStampVersion!==undefined&&m.basisStampVersion!==1||m.workspaceRevision!==undefined&&(!Number.isSafeInteger(m.workspaceRevision)||m.workspaceRevision<0)||
      m.workspaceVersion!==undefined&&!isWorkspaceVersion(m.workspaceVersion,m.workspaceRevision)||
      (m.workspaceRevision!==undefined||m.workspaceSource!==undefined||m.workspaceVersion!==undefined)&&m.readingStrategy!=='companion'||
      m.workspaceSource!==undefined&&m.workspaceSource!==(r.request.source==='background'?'background':'reading')||
      m.historicalSourceIds!==undefined&&(!ids(m.historicalSourceIds)||m.historicalSourceIds.some(id=>!m.memoryIds.includes(id))))throw Error('伴读原答回执的原模式无效');
    for(const [key,p]of m.passages)if(!/^p[1-9]\d*$/.test(key)||typeof p?.text!=='string'||p.text.length>200||!ranges([p.evidence])||p.evidence.bookId!==book.id||p.evidence.version!==book.version||!covers(m.originalRanges,p.evidence)||!covers(m.refs,p.evidence))throw Error('伴读原答原文编号无效');
    if(!m.references||Object.keys(m.references).length!==5||Object.keys(m.references).some(k=>!['memory','chat','habit','part','entity'].includes(k)))throw Error('伴读原答缺少完整原引用字典');new ReadingReferences().restore(m.references);
    for(const w of m.webSources)publicWebUrl(w.url);
    if(r.supersedesId!==undefined&&(typeof r.supersedesId!=='string'||!r.supersedesId||r.supersedesId.length>128))throw Error('伴读原答替代编号无效');
    if(m.expressionContract!==undefined&&(m.expressionContract!=='paragraph-expressions-v1'||r.request.source!=='reading'))throw Error('伴读原答表达合同无效');
    if(m.historicalCommentIds!==undefined&&(!ids(m.historicalCommentIds)||m.historicalCommentIds.some(id=>!m.chatIds.includes(id)||!state.chats.some(chat=>chat.id===id&&chat.presentation==='paragraph'))))throw Error('伴读回执的历史段评引用无效');
    companionReadingReceiptIds(state,r.id);
  }
}

/** Keep invalid returned work as a blocked receipt; never put it back in a model. */
export function pruneCompanionReadingReceipts(state:State):boolean {
  if(!state.companionReadingReceipts?.length)return false;let changed=false;
  state.companionReadingReceipts=state.companionReadingReceipts.filter(r=>{
    if(!belongs(state,r)||consumed(state,r)){changed=true;return false;}
    if(r.material&&!superseded(state,r)&&r.status==='received'&&!companionReadingReceiptUsable(state,r)){r.status='blocked';r.blockedReason='原答形成资料或阅读权限已变化，保留原回执并停止自动重答';changed=true;}
    return true;
  });return changed;
}

/** Local raw receipts and local consumption survive an older imported snapshot. */
export function mergeCompanionReadingReceipts(target:State,local:State):void {
  if(!target.companionReadingReceipts&&!local.companionReadingReceipts)return;
  const values=new Map((target.companionReadingReceipts??[]).map(r=>[r.id,structuredClone(r)]));
  for(const r of local.companionReadingReceipts??[])if(belongs(target,r)){
    const previous=values.get(r.id),copy=structuredClone(r);
    if(previous?.status==='blocked'){copy.status='blocked';copy.blockedReason=copy.blockedReason??previous.blockedReason;}
    values.set(r.id,copy);
  }
  target.companionReadingReceipts=[...values.values()].filter(r=>!consumed(local,r)&&!consumed(target,r));
  pruneCompanionReadingReceipts(target);
}
