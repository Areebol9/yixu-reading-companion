import {memoryReadableByPartner} from './book-document-ownership.ts';
import {memoryContentIdentity} from './memory-identity.ts';
import {mergeRanges,normalize} from './books.ts';
import {isBackgroundMemory,isCurrentUnderstanding,isEvidenceAllowed} from './context.ts';
import {semanticReferenceIds} from './semantic-notes.ts';
import {worldEntityIds} from './world-identity.ts';
import {chatBelongsToPartner} from './discussion-recall.ts';
import {requireMemoryText} from './memory-bodies.ts';
import {documentSubjectNavigation} from './document-subjects.ts';
import type {DocumentSubjectNavigation} from './document-subjects.ts';
import type {DocumentOrganization} from './document-organization.ts';
import type {Book,CompanionWorkspace,Memory,ReadingReply,State,WorkspaceVersion} from './types.ts';
import {resolveBookVersion,bookVersionPrefixLength,bookVersionAllowsRange,bookVersionAllowsRanges} from './book-versions.ts';
import {documentCapacity} from './types.ts';

type Source = CompanionWorkspace['source'];
export type WorkspaceBindings = {memoryIds:readonly string[];proposalMemoryIds?:Readonly<Record<string,string>>};
export type WorkspaceOptions = {expectedRevision:number;source?:Source;readingId?:string;chatId?:string};
export type WorkspaceDocumentNavigation = {id:string;kind:Memory['kind'];documentTitle?:string;readingStage?:Memory['readingStage'];chars?:number;organization?:DocumentOrganization;subject?:DocumentSubjectNavigation};
export type WorkspaceMemory = Memory & {subject?:DocumentSubjectNavigation;capacity:ReturnType<typeof documentCapacity>};
export type WorkspaceMaterial = {workspace:CompanionWorkspace;understanding?:WorkspaceMemory;working:WorkspaceMemory[];remaining:WorkspaceDocumentNavigation[];focus:(WorkspaceDocumentNavigation&{text?:string})[]};
const key=(w:Pick<CompanionWorkspace,'bookId'|'version'|'partnerId'|'source'>)=>JSON.stringify([w.bookId,w.version,w.partnerId,w.source]);
const validId=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=128;

/** Workspace filtering reads permission and source metadata only. Keep chapter
 * arrays shared instead of rebuilding the old book on each material lookup. */
function workspaceBoundary(book:Book|undefined,version:string):Book|undefined{
  if(!book)return;
  const length=bookVersionPrefixLength(book,version);if(length===undefined)return;if(version===book.version)return book;
  const prefixes=book.sourceLineage?.prefixes.filter(prefix=>prefix.chars<length)??[];
  return{...book,version,text:'',textLength:length,sourceLineage:prefixes.length?{currentVersion:version,prefixes}:undefined};
}

export function workspaceVersion(w:CompanionWorkspace):WorkspaceVersion{
  return{...(w.understandingId!==undefined?{understandingId:w.understandingId}:{}),understandingRevision:w.understandingRevision??w.revision,focusRevision:w.focusRevision??w.revision,...(w.workingIds!==undefined?{workingIds:[...w.workingIds],workingRevision:w.workingRevision??w.revision}:{})};
}
/** Compare only the fields this proposal will write. Untouched current fields
 * remain available to a separately authorized rebase in the engine. */
export function workspaceVersionMatches(current:CompanionWorkspace,anchor:WorkspaceVersion,proposal:ReadingReply['workspace']):boolean{
  const version=workspaceVersion(current);
  return(proposal?.understanding===undefined||version.understandingRevision===anchor.understandingRevision&&version.understandingId===anchor.understandingId)&&
    (proposal?.focus===undefined||version.focusRevision===anchor.focusRevision)&&
    (proposal?.working===undefined||version.workingRevision===anchor.workingRevision&&JSON.stringify(version.workingIds)===JSON.stringify(anchor.workingIds));
}
/** Merge selection changes only. Concrete document bases remain independently
 * checked by MemoryPlan; unrelated foreground selection never rewrites a draft. */
export function mergePreparedWorkspace(current:CompanionWorkspace,before:WorkspaceVersion,proposed:CompanionWorkspace,developments:{previousId:string;nextId:string}[]=[]):CompanionWorkspace{
  const merge=(old:string[],wanted:string[],now:string[])=>{
    const removed=new Set(old.filter(id=>!wanted.includes(id))),added=wanted.filter(id=>!old.includes(id));
    return[...new Set([...now.filter(id=>!removed.has(id)),...added.filter(id=>{const successor=developments.find(d=>d.nextId===id);return !successor||!old.includes(successor.previousId)||now.includes(successor.previousId);})])];
  };
  return revised(current,{...current,understandingId:current.understandingId===before.understandingId?proposed.understandingId:current.understandingId,workingIds:merge(before.workingIds??[],proposed.workingIds??[],current.workingIds??[]),focusIds:workspaceVersion(current).focusRevision===before.focusRevision?proposed.focusIds:current.focusIds});
}
function revised(previous:CompanionWorkspace,next:CompanionWorkspace):CompanionWorkspace{
  const version=workspaceVersion(previous),revision=previous.revision+1;
  return{...next,revision,updatedAt:Date.now(),
    understandingRevision:next.understandingId!==previous.understandingId?revision:version.understandingRevision,
    focusRevision:JSON.stringify(next.focusIds)!==JSON.stringify(previous.focusIds)?revision:version.focusRevision,
    ...(next.workingIds!==undefined?{workingRevision:JSON.stringify(next.workingIds)!==JSON.stringify(previous.workingIds)?revision:version.workingRevision??revision}:{})};
}
/** The question's position orders late answers, rather than completion time. */
function mayAdvanceChat(state:State,currentId:string|undefined,nextId:string):boolean{
  if(!currentId||currentId===nextId)return true;
  const current=state.chats.find(c=>c.id===currentId),next=state.chats.find(c=>c.id===nextId);
  if(!current||!next)return !current;
  const question=(chat:typeof current)=>state.chats.find(c=>c.id===chat.replyTo&&c.bookId===chat.bookId&&chatBelongsToPartner({...state,partnerId:chat.partnerId??state.partnerId},c))??chat;
  const a=question(current),b=question(next);
  return a.id===b.id||b.createdAt>a.createdAt||b.createdAt===a.createdAt&&state.chats.indexOf(b)>state.chats.indexOf(a);
}

function usable(state:State,book:Book,w:CompanionWorkspace,m:Memory|undefined,understanding=false):m is Memory{
  if(w.source==='background')book={...book,known:mergeRanges([...book.known,...(book.backgroundPrepared??[])])};
  return !!m&&m.bookId===w.bookId&&memoryReadableByPartner({partnerId:w.partnerId},m)&&
    (understanding?m.kind==='opinion':['story','opinion','question'].includes(m.kind))&&
    isBackgroundMemory(m)===(w.source==='background')&&
    isCurrentUnderstanding(m,state.memories.find(n=>n.id===m.replacedBy),book)&&isEvidenceAllowed(book,m.evidence)&&
    !state.forgotten.some(f=>f.bookId===book.id&&typeof m.text==='string'&&normalize(m.text).includes(normalize(f.text)));
}
function filtered(state:State,book:Book,w:CompanionWorkspace):CompanionWorkspace{
  if(w.source==='background')book={...book,known:mergeRanges([...book.known,...(book.backgroundPrepared??[])])};
  const memories=new Map(state.memories.map(m=>[m.id,m]));
  const result={...w,focusIds:[...new Set(w.focusIds)].filter(id=>usable(state,book,w,memories.get(id)))};
  if(w.workingIds!==undefined)result.workingIds=[...new Set(w.workingIds)].filter(id=>usable(state,book,w,memories.get(id)));
  if(!usable(state,book,w,memories.get(w.understandingId??''),true))delete result.understandingId;
  const reading=state.readings?.find(r=>r.id===w.lastReadingId);
  if(!reading||reading.bookId!==w.bookId||reading.version!==w.version||reading.partnerId!==w.partnerId||
    (reading.source==='background')!==(w.source==='background')||!isEvidenceAllowed(book,reading.ranges.map(r=>({...r,bookId:book.id,version:book.version}))))delete result.lastReadingId;
  const chat=state.chats.find(c=>c.id===w.lastChatId);
  if(w.source==='background'||!chat||chat.bookId!==w.bookId||!chatBelongsToPartner({...state,partnerId:w.partnerId},chat)||
    chat.excluded||chat.outdatedBy||chat.replacedBy||chat.futureGrant||!isEvidenceAllowed(book,chat.evidence))delete result.lastChatId;
  return result;
}

/** A missing old-state field yields an empty handoff without migrating history. */
export function workspaceFor(state:State,book:Book,source:Source='reading'):CompanionWorkspace{
  const empty:CompanionWorkspace={bookId:book.id,version:book.version,partnerId:state.partnerId,source,revision:0,focusIds:[],updatedAt:0};
  const stored=state.companionWorkspaces?.find(w=>key(w)===key(empty));
  if(stored)return filtered(state,book,stored);
  // A verified source extension keeps the old handoff immutable. The current
  // view inherits it until a new submission writes this version's own record.
  const previous=[...(book.sourceLineage?.prefixes??[])].sort((a,b)=>b.chars-a.chars).flatMap(prefix=>{
    const workspace=state.companionWorkspaces?.find(w=>w.bookId===book.id&&w.version===prefix.version&&w.partnerId===state.partnerId&&w.source===source);return workspace?[workspace]:[];
  })[0];
  const priorBook=previous&&workspaceBoundary(book,previous.version);
  return priorBook?{...filtered(state,priorBook,previous),version:book.version}:empty;
}
/** Focus text is a navigation excerpt. Only understanding is supplied in full. */
export function workspaceMaterial(state:State,book:Book,source:Source='reading',providedIds?:ReadonlySet<string>):WorkspaceMaterial{
  const workspace=workspaceFor(state,book,source),memories=new Map(state.memories.map(m=>[m.id,m]));
  const selected=[...new Set([workspace.understandingId,...(workspace.workingIds??[])].filter((id):id is string=>!!id))];
  const available=(id:string)=>!providedIds||providedIds.has(id);
  const understanding=workspace.understandingId&&available(workspace.understandingId)?memories.get(workspace.understandingId):undefined;
  // Derive navigation for the existing explicit selection. Object primaries
  // never become the overall understanding or working selection by inference.
  const visible=state.memories.filter(memory=>usable(state,book,workspace,memory));
  const navigation=(memory:Memory):WorkspaceDocumentNavigation=>{
    const subject=documentSubjectNavigation(memory,visible),organization=memory.organization?structuredClone(memory.organization):undefined;
    if(organization?.related)organization.related=organization.related.filter(link=>visible.some(candidate=>candidate.id===link.id));
    return{id:memory.id,kind:memory.kind,documentTitle:memory.documentTitle,readingStage:memory.readingStage,chars:memory.bodyRef?.chars??memory.text?.length,
      ...(organization?{organization}:{}),...(subject?{subject}:{})};
  };
  const full=(memory:Memory):WorkspaceMemory=>({...memory,text:requireMemoryText(memory),capacity:documentCapacity(requireMemoryText(memory).length),subject:documentSubjectNavigation(memory,visible)});
  return {workspace,...(understanding?{understanding:structuredClone(full(understanding))}:{}),remaining:selected.filter(id=>!available(id)).map(id=>navigation(memories.get(id)!)),working:(workspace.workingIds??[]).filter(id=>available(id)&&id!==understanding?.id).map(id=>full(memories.get(id)!)),focus:workspace.focusIds.map(id=>{
    const m=memories.get(id)!;return{...navigation(m),...(typeof m.text==='string'?{text:m.text.slice(0,180)}:{})};
  })};
}
/** Only this submission's proved, unique old-version → new-proposal edges
 * inherit selection. Evidence/basis/update targets remain immutable old IDs. */
export function inheritWorkspaceSelection(current:CompanionWorkspace,proposal:ReadingReply['workspace'],result:ReadingReply):NonNullable<ReadingReply['workspace']>{
  const successors=new Map<string,string>(),retired=new Set(result.thoughts.filter(t=>t.documentOperation==='retire').map(t=>t.updates!));
  result.thoughts.forEach((thought,index)=>{for(const previousId of [...(thought.updates?[thought.updates]:[]),...(thought.mergePreviousIds??[])]){if(successors.has(previousId))throw Error(`documents[${index}].updates在同包重复接续具体旧版${previousId}，选择继承有歧义`);successors.set(previousId,`t${index+1}`);}});
  const next={...proposal},map=(id:string)=>successors.get(id)??id;
  const mapped=(id:string)=>retired.has(id)?result.thoughts.find(t=>t.documentOperation==='retire'&&t.updates===id)?.replacementIds??[]:[map(id)];
  const inherit=(field:'working'|'focus',old:string[]|undefined)=>{if(next[field]!==undefined)next[field]=[...new Set(next[field]!.flatMap(mapped))];else if(old?.some(id=>successors.has(id)))next[field]=[...new Set(old.flatMap(mapped))];};
  inherit('working',current.workingIds);inherit('focus',current.focusIds);
  if(next.understanding!==undefined)next.understanding=map(next.understanding);
  else if(current.understandingId&&!retired.has(current.understandingId)&&successors.has(current.understandingId))next.understanding=map(current.understandingId);
  return next;
}
export class CompanionWorkspaceConflict extends Error{
  constructor(){super('伴读工作台已被更新，旧任务结果不能覆盖当前接续状态');this.name='CompanionWorkspaceConflict';}
}
/** Navigation is not a document write. Follow only explicit version edges;
 * unavailable selections cannot discard a valid body submission. */
export function normalizeWorkspaceNavigation(state:State,book:Book,current:CompanionWorkspace,proposal:ReadingReply['workspace'],knownIds:readonly string[],proposalCount:number):ReadingReply['workspace']{
  if(!proposal)return proposal;
  const next={...proposal},known=new Set([...knownIds,...(current.workingIds??[]),...current.focusIds]);
  for(const field of ['working','focus'] as const){
    const requested=proposal[field];if(requested===undefined)continue;
    const valid=requested.flatMap(reference=>{
      if(/^t[1-9]\d*$/.test(reference))return Number(reference.slice(1))<=proposalCount?[reference]:[];
      if(!known.has(reference))return[];
      let memory=state.memories.find(m=>m.id===reference);const seen=new Set<string>();
      while(memory?.replacedBy&&!seen.has(memory.id)){
        seen.add(memory.id);const successor=state.memories.find(m=>m.id===memory!.replacedBy);
        if(!successor||successor.revisionKind!=='development'||successor.bookId!==book.id||!memoryReadableByPartner(state,successor))break;
        memory=successor;
      }
      return usable(state,book,current,memory)?[memory.id]:[];
    });
    // An explicitly empty list clears it; an entirely invalid replacement keeps
    // the existing selection. Current-body permissions remain independent.
    next[field]=[...new Set(valid.length||requested.length===0?valid:field==='working'?current.workingIds??[]:current.focusIds)];
  }
  return next;
}
/** Called on the unpublished next State after successful Memory formation. */
export function planWorkspace(state:State,book:Book,proposal:ReadingReply['workspace'],bindings:WorkspaceBindings,options:WorkspaceOptions):CompanionWorkspace{
  const source=options.source??'reading',current=workspaceFor(state,book,source);
  if(!Number.isSafeInteger(options.expectedRevision)||options.expectedRevision<0||current.revision!==options.expectedRevision)throw new CompanionWorkspaceConflict();
  if(proposal===undefined)return current;
  if(!proposal||typeof proposal!=='object'||Array.isArray(proposal)||Object.keys(proposal).some(k=>!['understanding','focus','working'].includes(k))||
    proposal.understanding!==undefined&&!validId(proposal.understanding)||proposal.focus!==undefined&&(!Array.isArray(proposal.focus)||proposal.focus.some(id=>!validId(id))))throw Error('伴读工作台提议无效');
  const resolve=(reference:string,field:string,understanding=false):string=>{
    const proposed=/^t[1-9]\d*$/.test(reference),id=proposed?bindings.proposalMemoryIds?.[reference]:reference;
    const memory=state.memories.find(m=>m.id===id);
    const retained=field.startsWith('working[')?current.workingIds?.includes(id!):field.startsWith('focus[')?current.focusIds.includes(id!):field==='understanding'&&current.understandingId===id;
    if(!id||!proposed&&!bindings.memoryIds.includes(id)&&!retained||!usable(state,book,current,memory,understanding)){
      // A later record is not necessarily the result of this submission. Only
      // this packet's actual new IDs justify inheriting the selection.
      const replacement=!proposed&&memory?.replacedBy?Object.entries(bindings.proposalMemoryIds??{}).find(([label,newId])=>/^t[1-9]\d*$/.test(label)&&newId===memory.replacedBy)?.[0]:undefined;
      if(replacement)return resolve(replacement,field,understanding);
      throw Error(`工作台${field}引用须来自本轮实际完整取得的可用认识或成功形成的新认识`);
    }
    return id;
  };
  const next:CompanionWorkspace={...current,focusIds:proposal.focus===undefined?[...current.focusIds]:[...new Set(proposal.focus.map((id,index)=>resolve(id,`focus[${index}]`)))],
    revision:current.revision+1,updatedAt:Date.now()};
  if(proposal.understanding!==undefined)next.understandingId=resolve(proposal.understanding,'understanding',true);
  if(proposal.working!==undefined){if(!Array.isArray(proposal.working))throw Error('当前工作集须为文档引用数组');next.workingIds=[...new Set(proposal.working.map((id,index)=>resolve(id,`working[${index}]`)))];}
  if(options.readingId!==undefined)next.lastReadingId=options.readingId;
  if(options.chatId!==undefined){
    if(filtered(state,book,{...next,lastChatId:options.chatId}).lastChatId!==options.chatId)throw Error('工作台接续记录与当前书籍、伙伴或阅读权限不符');
    if(mayAdvanceChat(state,current.lastChatId,options.chatId))next.lastChatId=options.chatId;
  }
  const clean=revised(current,filtered(state,book,next));
  if(options.readingId!==undefined&&clean.lastReadingId!==options.readingId)throw Error('工作台接续记录与当前书籍、伙伴或阅读权限不符');
  const at=state.companionWorkspaces?.findIndex(w=>key(w)===key(current))??-1;
  const workspaces=[...(state.companionWorkspaces??[])];if(at<0)workspaces.push(clean);else workspaces[at]=clean;
  state.companionWorkspaces=workspaces;return structuredClone(clean);
}

/** Validate the transfer contract; stale references are then removed by prune. */
export function validateCompanionWorkspaces(state:State):void{
  if(state.companionWorkspaces===undefined)return;
  if(!Array.isArray(state.companionWorkspaces)||state.companionWorkspaces.length>state.books.reduce((count,book)=>count+1+(book.sourceLineage?.prefixes.length??0),0)*state.partners.length*2)throw Error('伴读工作台记录无效');
  const seen=new Set<string>();
  for(const w of state.companionWorkspaces){
    if(!w||Object.keys(w).some(k=>!['bookId','version','partnerId','source','revision','understandingRevision','focusRevision','understandingId','focusIds','workingIds','workingRevision','lastReadingId','lastChatId','updatedAt'].includes(k))||
      !state.books.some(b=>b.id===w.bookId&&bookVersionPrefixLength(b,w.version)!==undefined)||!state.partners.some(p=>p.id===w.partnerId)||!['reading','background'].includes(w.source)||
      !Number.isSafeInteger(w.revision)||w.revision<0||!Number.isFinite(w.updatedAt)||w.updatedAt<0||
      [w.understandingRevision,w.focusRevision,w.workingRevision].some(v=>v!==undefined&&(!Number.isSafeInteger(v)||v<0||v>w.revision))||
      w.workingIds!==undefined&&(!Array.isArray(w.workingIds)||w.workingIds.some(id=>!validId(id))||new Set(w.workingIds).size!==w.workingIds.length)||
      !Array.isArray(w.focusIds)||w.focusIds.some(id=>!validId(id))||new Set(w.focusIds).size!==w.focusIds.length||
      [w.understandingId,w.lastReadingId,w.lastChatId].some(id=>id!==undefined&&!validId(id))||seen.has(key(w)))throw Error('伴读工作台记录无效');
    seen.add(key(w));
    for(const id of [w.understandingId,...w.focusIds,...(w.workingIds??[])].filter((v):v is string=>!!v)){
      const m=state.memories.find(m=>m.id===id);
      if(m&&(m.bookId!==w.bookId||!memoryReadableByPartner({partnerId:w.partnerId},m)||isBackgroundMemory(m)!==(w.source==='background')||
        (id===w.understandingId?m.kind!=='opinion':!['story','opinion','question'].includes(m.kind))))throw Error('伴读工作台的认识来源无效');
    }
  }
}
/** Keep empty revision tombstones so invalidation cannot reopen a stale write. */
export function pruneCompanionWorkspaces(state:State):boolean{
  if(!state.companionWorkspaces)return false;
  let changed=false;
  state.companionWorkspaces=state.companionWorkspaces.flatMap(w=>{
    const book=workspaceBoundary(state.books.find(b=>b.id===w.bookId),w.version);
    if(!book||!state.partners.some(p=>p.id===w.partnerId)){changed=true;return[];}
    let clean=filtered(state,book,w);
    if(JSON.stringify(clean)!==JSON.stringify(w)){clean=revised(w,clean);changed=true;}
    return[clean];
  });return changed;
}
export function recoverCompanionWorkspaces(state:State):boolean{
  // A removed book/version or partner is an ordinary local lifecycle event.
  // Backup validation still rejects malformed transferred keys before merge.
  let changed=false;
  if(Array.isArray(state.companionWorkspaces)){
    const kept=state.companionWorkspaces.filter(w=>w&&state.books.some(b=>b.id===w.bookId&&bookVersionPrefixLength(b,w.version)!==undefined)&&state.partners.some(p=>p.id===w.partnerId));
    if(kept.length!==state.companionWorkspaces.length){state.companionWorkspaces=kept;changed=true;}
  }
  validateCompanionWorkspaces(state);return pruneCompanionWorkspaces(state)||changed;
}

/** Local handoffs and their ordinary memory dependencies survive an old backup.
 * Nothing is summarized, and references denied by the local state never revive. */
export function mergeCompanionWorkspaces(target:State,local:State):void{
  const workspaces=new Map((target.companionWorkspaces??[]).map(w=>[key(w),w]));
  for(const saved of local.companionWorkspaces??[]){
    const book=target.books.find(b=>b.id===saved.bookId&&bookVersionPrefixLength(b,saved.version)!==undefined),localSource=local.books.find(b=>b.id===saved.bookId),localBook=workspaceBoundary(localSource,saved.version);
    if(!book||!localBook||!target.partners.some(p=>p.id===saved.partnerId))continue;
    const localFence=resolveBookVersion(localSource,book.version)??resolveBookVersion(localSource,saved.version)!;
    const incoming=workspaces.get(key(saved));
    if(incoming&&incoming.revision>saved.revision)continue;
    let w=filtered(local,localBook,saved);
    if(JSON.stringify(w)!==JSON.stringify(saved))w=revised(saved,w);
    // The winning local handoff carries its actual reading fence. Unioning an
    // old backup's permission would resurrect locally withdrawn ranges.
    for(const field of ['known','prepared','backgroundPrepared','position','readingSourceId','frontMatterEnd','frontMatterIncluded','buffered','fullOriginalPending'] as const){
      if(localFence[field]===undefined)delete (book as unknown as Record<string,unknown>)[field];
      else (book as unknown as Record<string,unknown>)[field]=structuredClone(localFence[field]);
    }
    const inScope=(m:Memory)=>m.bookId===w.bookId&&memoryReadableByPartner({partnerId:w.partnerId},m)&&m.evidence.every(e=>bookVersionAllowsRange(localBook,e.version,e));
    const partnerState={...local,partnerId:w.partnerId};
    const readings=(local.readings??[]).filter(r=>r.bookId===w.bookId&&bookVersionAllowsRanges(localBook,r.version,r.ranges)&&r.partnerId===w.partnerId);
    const readingMap=new Map((target.readings??[]).map(r=>[r.id,r]));
    for(const reading of readings)readingMap.set(reading.id,structuredClone(reading));
    if(target.readings!==undefined||readingMap.size)target.readings=[...readingMap.values()];
    // A prepared range denotes completed work. Keep its full saved experience,
    // including history, so restoration cannot falsely mark absent work complete.
    const ids=new Set(local.memories.filter(inScope).map(m=>m.id));
    const chatIds=new Set(local.chats.filter(c=>c.bookId===w.bookId&&chatBelongsToPartner(partnerState,c)&&c.evidence.every(e=>bookVersionAllowsRange(localBook,e.version,e))).map(c=>c.id));
    for(const id of [w.understandingId,...w.focusIds,...(w.workingIds??[]),...readings.flatMap(r=>r.memoryIds)].filter((id):id is string=>!!id))ids.add(id);
    if(w.lastChatId)chatIds.add(w.lastChatId);
    const copied=new Set<string>(),copiedChats=new Set<string>();
    while([...ids].some(id=>!copied.has(id))||[...chatIds].some(id=>!copiedChats.has(id))){
      for(const id of ids){
        if(copied.has(id))continue;copied.add(id);
        const m=local.memories.find(m=>m.id===id&&inScope(m));if(!m)continue;
        const refs=[...m.parents,...(m.basis?.memoryIds??[]),...semanticReferenceIds(m),...(m.entityBindings??[]).map(b=>b.memoryId),
          ...(m.ruleLinks??[]).map(l=>l.memoryId),m.attribution?.contentRef?.memoryId,m.worldChangeOf,m.identityClaim?.changeOf,
          m.correctionOf,...(m.mergePreviousIds?['merge-predecessors',m.mergePreviousIds]:[]),m.replacedBy,m.invalidatedBy,m.answersPartOf];
        for(const parent of refs.filter((id):id is string=>!!id))ids.add(parent);
        for(const entityId of worldEntityIds(m)){
          const root=local.entityRoots?.find(r=>r.id===entityId);if(!root)continue;ids.add(root.originMemoryId);
          if(!target.entityRoots?.some(r=>r.id===root.id))target.entityRoots=[...(target.entityRoots??[]),structuredClone(root)];
        }
        for(const id of [...m.chatIds,...(m.basis?.chatIds??[])])chatIds.add(id);
        const at=target.memories.findIndex(v=>v.id===m.id),copy=structuredClone(m);
        if(at<0)target.memories.push(copy);else{
          const imported=target.memories[at];
          const left=typeof imported.text==='string'&&typeof m.text==='string'?imported.text===m.text:JSON.stringify(memoryContentIdentity(imported))===JSON.stringify(memoryContentIdentity(m));
          if(!left)throw Error('同一认识标识存在冲突正文，不能覆盖备份接续');
          target.memories[at]={...copy,...(typeof imported.text==='string'?{text:imported.text}:{}),forgotten:copy.forgotten||imported.forgotten,replacedBy:copy.replacedBy??imported.replacedBy,invalidatedBy:copy.invalidatedBy??imported.invalidatedBy,
            reviewDisposition:imported.reviewDisposition==='unsupported'?'unsupported':copy.reviewDisposition};
        }
      }
      for(const id of chatIds){
        if(copiedChats.has(id))continue;copiedChats.add(id);
        const chat=local.chats.find(c=>c.id===id&&c.bookId===w.bookId&&chatBelongsToPartner(partnerState,c)&&c.evidence.every(e=>bookVersionAllowsRange(localBook,e.version,e)));if(!chat)continue;
        for(const id of [...(chat.memoryIds??[]),...(chat.basis?.memoryIds??[]),...(chat.memoryResult?.memoryIds??[])])ids.add(id);
        for(const id of [...(chat.contextChatIds??[]),...(chat.basis?.chatIds??[]),chat.replyTo].filter((id):id is string=>!!id))chatIds.add(id);
        const at=target.chats.findIndex(c=>c.id===id),copy=structuredClone(chat);
        if(at<0)target.chats.push(copy);else{
          const imported=target.chats[at];
          if(imported.text!==chat.text)throw Error('同一交流标识存在冲突正文，不能覆盖备份接续');
          target.chats[at]={...copy,excluded:copy.excluded||imported.excluded,outdatedBy:copy.outdatedBy??imported.outdatedBy,replacedBy:copy.replacedBy??imported.replacedBy,
            delivery:imported.delivery==='answered'&&copy.delivery==='pending'?'answered':copy.delivery};
        }
        const conversation=local.conversations.find(c=>c.id===chat.sessionId);
        if(conversation&&!target.conversations.some(c=>c.id===conversation.id))target.conversations.push(structuredClone(conversation));
      }
    }
    workspaces.set(key(w),structuredClone(w));
  }
  if(target.companionWorkspaces!==undefined||workspaces.size)target.companionWorkspaces=[...workspaces.values()];
}
