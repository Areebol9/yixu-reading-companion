import {id,mergeRanges,normalize} from './books.ts';
import {isBackgroundMemory,isEvidenceAllowed} from './context.ts';
import {workspaceFor} from './companion-workspace.ts';
import {legacyMemoryRecord,memoryContentIdentity,memorySourceRecord,stampsEqual} from './memory-identity.ts';
import {requireMemoryText} from './memory-bodies.ts';
import type {CompanionCorrectionRepair,CompanionWorkspace,Memory,State} from './types.ts';
import {resolveBookVersion} from './book-versions.ts';

const withoutFocus=(w:CompanionWorkspace)=>{const {focusIds,focusRevision,understandingRevision,revision,updatedAt,...identity}=w;return JSON.stringify(identity);};
function usesContentIdentity(stamp:string|undefined):boolean {try{return JSON.parse(stamp??'').sourceStampVersion===2;}catch{return false;}}
function canStampRecords(memories:(Memory|undefined)[]):boolean {try{memories.forEach(m=>m&&memorySourceRecord(m));return true;}catch{return false;}}
function focusSourceStamp(state:State,w:CompanionWorkspace,questionId:string,previous?:string):string {
  const memories=w.focusIds.map(id=>state.memories.find(m=>m.id===id)),v2=previous===undefined?canStampRecords(memories):usesContentIdentity(previous);
  const records=[memories.map(m=>m?(v2?memorySourceRecord(m):legacyMemoryRecord(m)):null),state.chats.find(c=>c.id===questionId)??null];
  return JSON.stringify(v2?{sourceStampVersion:2,records}:records);
}
/** Only the recorded, source-preserving focus commits may advance a repair CAS. */
export function correctionFocusRevision(state:State,p:CompanionCorrectionRepair,formedRevision:number):number|undefined {
  const book=resolveBookVersion(state.books.find(b=>b.id===p.bookId),p.version);if(!book)return;
  const current=workspaceFor(state,book,p.source),handoffs=p.focusHandoffs??[];
  if(formedRevision!==p.workspaceRevision)return;
  if(!handoffs.length)return current.revision===formedRevision?formedRevision:undefined;
  let revision=p.workspaceRevision,previous:CompanionWorkspace|undefined;
  for(const h of handoffs){
    if(h.before.revision!==revision||h.after.revision!==revision+1||withoutFocus(h.before)!==withoutFocus(h.after)||h.before.understandingId||h.after.understandingId||
      h.before.bookId!==p.bookId||h.before.version!==p.version||h.before.partnerId!==p.partnerId||h.before.source!==p.source||previous&&JSON.stringify(previous)!==JSON.stringify(h.before)||
      !stampsEqual(focusSourceStamp(state,h.after,h.questionId,h.sourceStamp),h.sourceStamp))return;
    const question=state.chats.find(c=>c.id===h.questionId);
    if(!question||question.role!=='user'||question.bookId!==p.bookId||question.partnerId!==p.partnerId||question.excluded||question.outdatedBy||question.replacedBy||question.futureGrant||!isEvidenceAllowed(book,question.evidence))return;
    revision=h.after.revision;previous=h.after;
  }
  return JSON.stringify(previous)===JSON.stringify(current)?revision:undefined;
}
/** Called only after planWorkspace resolved full supplied or newly formed focus records. */
export function recordCorrectionFocus(state:State,repairId:string,before:CompanionWorkspace,after:CompanionWorkspace,questionId:string):void {
  const p=state.companionCorrectionRepairs?.find(p=>p.id===repairId);
  if(!p||!correctionRepairUsable(state,p)||correctionFocusRevision({...state,companionWorkspaces:(state.companionWorkspaces??[]).map(w=>w.bookId===before.bookId&&w.version===before.version&&w.partnerId===before.partnerId&&w.source===before.source?before:w)},p,p.workspaceRevision)!==before.revision||withoutFocus(before)!==withoutFocus(after))throw Error('关注交接未沿当前更正恢复任务形成，旧任务不能覆盖工作台');
  p.focusHandoffs=[...(p.focusHandoffs??[]),{before:structuredClone(before),after:structuredClone(after),questionId,sourceStamp:focusSourceStamp(state,after,questionId)}];
}

export function correctionRepairStamp(state:State,repairId:string):string {
  const p=state.companionCorrectionRepairs?.find(p=>p.id===repairId);
  if(!p)return 'missing';
  const memories=[...p.memoryIds,...p.correctionIds].map(id=>state.memories.find(m=>m.id===id)),v2=p.dependencyStamp?usesContentIdentity(p.dependencyStamp):canStampRecords([...memories,p.oldDraft]);
  const records=[p.id,p.status,p.oldDraft?(v2?memorySourceRecord(p.oldDraft):legacyMemoryRecord(p.oldDraft)):undefined,p.ranges,p.workspaceRevision,p.correctionIds,
    memories.map(m=>m?(v2?memorySourceRecord(m):legacyMemoryRecord(m)):null),
    p.chatIds.map(id=>state.chats.find(c=>c.id===id)??null),p.habitIds.map(id=>state.habits?.find(h=>h.id===id)??null),...(p.workingDocument?['working-document']:[])];
  const stamp=JSON.stringify(v2?{sourceStampVersion:2,records}:records);
  return stampsEqual(stamp,p.dependencyStamp)?p.dependencyStamp:stamp;
}
function permitted(state:State,p:CompanionCorrectionRepair):boolean {
  const book=resolveBookVersion(state.books.find(b=>b.id===p.bookId),p.version);
  if(!book||state.partnerId!==p.partnerId||!state.partners.some(v=>v.id===p.partnerId)||!p.oldDraft)return false;
  const scope=p.source==='background'?{...book,known:mergeRanges([...book.known,...(book.backgroundPrepared??[])])}:book;
  if(!isEvidenceAllowed(scope,p.ranges.map(r=>({...r,bookId:book.id,version:book.version}))))return false;
  const correctionIds=new Set(p.correctionIds);
  if(!p.correctionIds.length||p.correctionIds.some(id=>!state.memories.some(m=>m.id===id&&m.source==='correction'&&m.correctionOf&&p.memoryIds.concat(p.correctionIds).includes(m.correctionOf))))return false;
  for(const memoryId of [...p.memoryIds,...p.correctionIds]){
    const m=state.memories.find(m=>m.id===memoryId);
    if(!m||m.bookId!==book.id||m.partnerId!==p.partnerId||isBackgroundMemory(m)!==(p.source==='background')||m.forgotten||m.historicalOnly||m.reviewDisposition==='unsupported'||!isEvidenceAllowed(scope,m.evidence)||
      m.invalidatedBy&&!correctionIds.has(m.invalidatedBy)||m.replacedBy&&!correctionIds.has(m.replacedBy)&&state.memories.find(n=>n.id===m.replacedBy)?.revisionKind!=='development')return false;
  }
  if(p.chatIds.some(id=>!state.chats.some(c=>c.id===id&&c.bookId===book.id&&!c.excluded&&!c.replacedBy&&!c.futureGrant&&(!c.outdatedBy||correctionIds.has(c.outdatedBy))&&isEvidenceAllowed(scope,c.evidence)))||
    p.habitIds.some(id=>!state.habits?.some(h=>h.id===id&&!h.forgotten&&!h.retiredBy&&!h.invalidatedBy)))return false;
  const old=state.memories.find(m=>m.id===p.oldMemoryId);
  const sameBody=old&&(usesContentIdentity(p.dependencyStamp)?stampsEqual(JSON.stringify(memoryContentIdentity(old)),JSON.stringify(memoryContentIdentity(p.oldDraft))):requireMemoryText(old)===requireMemoryText(p.oldDraft));
  return !!sameBody&&(!!old!.invalidatedBy&&correctionIds.has(old!.invalidatedBy)||!!old!.replacedBy&&correctionIds.has(old!.replacedBy))&&
    !state.forgotten.some(f=>f.bookId===book.id&&normalize(JSON.stringify(legacyMemoryRecord(p.oldDraft!))).includes(normalize(f.text)));
}
export function correctionRepairUsable(state:State,p:CompanionCorrectionRepair):boolean {
  return p.status==='pending'&&permitted(state,p)&&stampsEqual(correctionRepairStamp(state,p.id),p.dependencyStamp);
}
/** Capture only a currently usable full workspace interpretation before mutation. */
export function captureCorrectionRepairs(state:State,original:Memory):CompanionCorrectionRepair[] {
  const existing=(state.companionCorrectionRepairs??[]).filter(p=>p.bookId===original.bookId&&p.partnerId===original.partnerId&&correctionRepairUsable(state,p));
  const book=state.books.find(b=>b.id===original.bookId);if(!book)return existing;
  for(const source of ['reading','background'] as const){
    const w=workspaceFor(state,book,source);
    for(const memoryId of new Set([...(w.understandingId?[w.understandingId]:[]),...(w.workingIds??[])])){
    if(existing.some(p=>p.source===source&&p.oldMemoryId===memoryId))continue;
    const m=state.memories.find(m=>m.id===memoryId&&m.kind==='opinion');if(!m)continue;
    requireMemoryText(m);
    const memoryIds=new Set<string>([m.id]),chatIds=new Set<string>(),habitIds=new Set<string>();
    let changed=true;while(changed){changed=false;
      for(const key of [...memoryIds]){const v=state.memories.find(m=>m.id===key);if(!v)continue;for(const parent of [...v.parents,...(v.basis?.memoryIds??[])])if(!memoryIds.has(parent)){memoryIds.add(parent);changed=true;}for(const c of [...v.chatIds,...(v.basis?.chatIds??[])])if(!chatIds.has(c)){chatIds.add(c);changed=true;}for(const h of [...(v.habitIds??[]),...(v.basis?.habitIds??[])])habitIds.add(h);}
      for(const key of [...chatIds]){const c=state.chats.find(c=>c.id===key);if(!c)continue;for(const h of [...(c.habitIds??[]),...(c.basis?.habitIds??[])])habitIds.add(h);for(const parent of [...(c.memoryIds??[]),...(c.basis?.memoryIds??[])])if(!memoryIds.has(parent)){memoryIds.add(parent);changed=true;}for(const chat of [...(c.contextChatIds??[]),...(c.basis?.chatIds??[]),...(c.replyTo?[c.replyTo]:[])])if(!chatIds.has(chat)){chatIds.add(chat);changed=true;}}
    }
    existing.push({id:id(),bookId:book.id,version:book.version,partnerId:original.partnerId,source,workspaceRevision:w.revision,ranges:mergeRanges(m.evidence),oldMemoryId:m.id,oldDraft:structuredClone(m),memoryIds:[...memoryIds],chatIds:[...chatIds],habitIds:[...habitIds],correctionIds:[],dependencyStamp:'',status:'pending',createdAt:Date.now(),...(m.id!==w.understandingId&&w.workingIds?.includes(m.id)?{workingDocument:true as const}:{})});
    }
  }return existing;
}
export function activateCorrectionRepairs(state:State,candidates:CompanionCorrectionRepair[],replacement:Memory):void {
  for(const p of candidates){
    if(!replacement.correctionOf||!p.memoryIds.includes(replacement.correctionOf)&&!p.correctionIds.includes(replacement.correctionOf))continue;
    const old=state.memories.find(m=>m.id===p.oldMemoryId);
    if(!old||old.invalidatedBy!==replacement.id&&old.replacedBy!==replacement.id&&!p.correctionIds.length)continue;
    if(!p.correctionIds.includes(replacement.id))p.correctionIds.push(replacement.id);
    const at=state.companionCorrectionRepairs?.findIndex(v=>v.id===p.id)??-1;
    if(at<0)(state.companionCorrectionRepairs??=[]).push(p);else state.companionCorrectionRepairs![at]=p;
    const book=state.books.find(b=>b.id===p.bookId)!;p.workspaceRevision=workspaceFor(state,book,p.source).revision;delete p.focusHandoffs;
    p.dependencyStamp=correctionRepairStamp(state,p.id);
  }
}
export function pruneCorrectionRepairs(state:State):boolean {
  let changed=false;for(const p of state.companionCorrectionRepairs??[])if(p.status==='pending'&&!correctionRepairUsable(state,p)){p.status='blocked';delete p.oldDraft;delete p.focusHandoffs;p.dependencyStamp='';changed=true;}return changed;
}
export function validateCorrectionRepairs(state:State):void {
  const ids=(v:unknown):v is string[]=>Array.isArray(v)&&v.length<=10000&&v.every(id=>typeof id==='string'&&!!id&&id.length<=128);
  for(const m of state.memories)if(m.correctionRepairSources){
    const refs=m.correctionRepairSources;
    if(!ids(refs.memoryIds)||!ids(refs.chatIds)||!ids(refs.habitIds)||m.kind!=='opinion'||
      refs.memoryIds.some(id=>!state.memories.some(v=>v.id===id&&v.bookId===m.bookId&&v.partnerId===m.partnerId&&v.evidence.every(e=>m.evidence.some(r=>r.bookId===e.bookId&&r.version===e.version))))||
      refs.chatIds.some(id=>{const c=state.chats.find(c=>c.id===id);return c?c.bookId!==m.bookId||!!c.partnerId&&c.partnerId!==m.partnerId||c.evidence.some(e=>!m.evidence.some(r=>r.bookId===e.bookId&&r.version===e.version)):!m.forgotten;})||
      refs.habitIds.some(id=>!state.habits?.some(h=>h.id===id&&h.partnerId===m.partnerId)))throw Error('更正恢复的撤回来源无效');
  }
  if(state.companionCorrectionRepairs===undefined)return;
  if(!Array.isArray(state.companionCorrectionRepairs)||state.companionCorrectionRepairs.length>1500)throw Error('更正恢复任务无效');
  const seen=new Set<string>();
  for(const p of state.companionCorrectionRepairs){
    if(!p||typeof p.id!=='string'||!p.id||seen.has(p.id)||p.workingDocument!==undefined&&p.workingDocument!==true||!['reading','background'].includes(p.source)||!['pending','blocked','complete'].includes(p.status)||!Number.isSafeInteger(p.workspaceRevision)||p.workspaceRevision<0||!Number.isFinite(p.createdAt)||!ids(p.memoryIds)||!ids(p.chatIds)||!ids(p.habitIds)||!ids(p.correctionIds)||typeof p.dependencyStamp!=='string'||!Array.isArray(p.ranges)||!p.ranges.length||p.ranges.some(r=>!Number.isSafeInteger(r.start)||!Number.isSafeInteger(r.end)||r.start<0||r.end<=r.start)||
      p.oldDraft&&(p.oldDraft.id!==p.oldMemoryId||p.oldDraft.kind!=='opinion'||typeof p.oldDraft.text!=='string'||p.oldDraft.text.length>100000)||p.status==='pending'&&!p.oldDraft)throw Error('更正恢复旧稿或来源无效');
    seen.add(p.id);
    if(p.focusHandoffs!==undefined){
      if(!Array.isArray(p.focusHandoffs)||p.focusHandoffs.length>256)throw Error('更正恢复关注交接无效');
      let revision=p.workspaceRevision,previous:CompanionWorkspace|undefined;
      for(const h of p.focusHandoffs){if(!h?.before||!h.after||h.before.revision!==revision||h.after.revision!==revision+1||withoutFocus(h.before)!==withoutFocus(h.after)||h.before.understandingId||h.after.understandingId||h.before.bookId!==p.bookId||h.before.version!==p.version||h.before.partnerId!==p.partnerId||h.before.source!==p.source||!ids(h.before.focusIds)||!ids(h.after.focusIds)||typeof h.questionId!=='string'||!h.questionId||typeof h.sourceStamp!=='string'||previous&&JSON.stringify(previous)!==JSON.stringify(h.before))throw Error('更正恢复关注交接无效');revision=h.after.revision;previous=h.after;}
    }
  }
}
export function mergeCorrectionRepairs(target:State,local:State):void {
  const records=new Map((target.companionCorrectionRepairs??[]).map(p=>[p.id,p]));
  for(const p of local.companionCorrectionRepairs??[]){const incoming=records.get(p.id);if(incoming&&incoming.status!=='pending'&&p.status==='pending')continue;records.set(p.id,structuredClone(p));}
  if(records.size||target.companionCorrectionRepairs!==undefined)target.companionCorrectionRepairs=[...records.values()];
}
