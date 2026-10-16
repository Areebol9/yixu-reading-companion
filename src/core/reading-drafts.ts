import { bookLength, id, mergeRanges, normalize, readingStart } from './books.ts';
import {maintenanceTaskCommitted} from './maintenance-dispatch.ts';
import { chatAllowsMemory,isEvidenceAllowed } from './context.ts';
import {viewAllowed} from './published-views.ts';
import {validateTaskMaterialRef} from './storage-records.ts';
import {validateSceneOpportunity} from './scene-scheduling.ts';
import {validateMaterialProjection,sceneRecordAllowed} from './material-projection.ts';
import { parseReadingReply } from './model.ts';
import { publicWebUrl } from './web.ts';
import {semanticNote} from './semantic-notes.ts';
import {correctionRepairStamp,correctionRepairUsable} from './companion-correction-repair.ts';
import {memoryContentIdentity,stampsEqual} from './memory-identity.ts';
import {requireMemoryText} from './memory-bodies.ts';
import type { Book, ReadingDraft, ReadingDraftMaterial, ReadingDraftRequest, ReadingReply, State, WebReference } from './types.ts';
import {isReadingDelivery,isWorkspaceVersion} from './types.ts';

/** Exact semantic dependency state, compacting duplicate evidence ranges.
 * New unrelated messages and usage do not invalidate completed understanding. */
export function dependencyStamp(state: State, material: ReadingDraftMaterial,result?:ReadingReply): string {
  const companion=material.readingStrategy==='companion';
  return JSON.stringify({
    ...(material.taskRole?{taskRole:material.taskRole}:{}),
    ...(material.sceneRecordIds?.length?{sceneRecords:material.sceneRecordIds.map(id=>state.readings?.find(r=>r.id===id))}:{}),
    ...(material.sceneCommentIds?.length?{sceneCommentIds:material.sceneCommentIds}:{}),
    ...(material.viewIds?.length?{views:material.viewIds.map(id=>state.publishedViews?.find(v=>v.id===id))}:{}),
    ...(material.maintenanceReviewRanges?.length?{maintenanceReviewRanges:material.maintenanceReviewRanges,maintenanceReviewMemoryIds:material.maintenanceReviewMemoryIds}:{}),
    ...(material.maintenanceViewTargets?.length?{maintenanceViewTargets:material.maintenanceViewTargets}:{}),
    ...(material.sourceStampVersion===2?{sourceStampVersion:2}:{}),
    ...(material.correctionRepairId?{correctionRepair:correctionRepairStamp(state,material.correctionRepairId)}:{}),
    ...(material.historicalSourceIds?.length?{historicalSourceIds:material.historicalSourceIds}:{}),
    ...(material.analysisTask?{analysisTask:true}:{}),
    ...(material.arcCandidate?{arcCandidate:material.arcCandidate}:{}),
    ...(material.worldCandidate?{worldCandidate:material.worldCandidate}:{}),
    ...(material.narrativeMode!==undefined?{narrativeMode:material.narrativeMode}:{}),
    ...(material.outputReactionAllowed?{outputReactionAllowed:true}:{}),
    // Missing and explicit v1 are semantically identical, preserving old stamps.
    ...(material.stateWriteVersion===2?{stateWriteVersion:2}:{}),
    ...(material.readingStrategy==='full-original'?{readingStrategy:'full-original'}:{}),
    ...(companion?{readingStrategy:'companion',originalSources:{refs:material.refs,ranges:material.originalRanges,passages:material.passages},
      // These are immutable formation values, never the current workspace.
      ...(material.workspaceRevision!==undefined?{workspaceRevision:material.workspaceRevision}:{}),
      ...(material.workspaceVersion?{workspaceVersion:material.workspaceVersion}:{}),
      ...(material.workspaceSource!==undefined?{workspaceSource:material.workspaceSource}:{})}:{}),
    ...(material.basisStampVersion===1?{basisStampVersion:1,structuralWriteBasis:[result?.stageNarrative?.basis,result?.stateUpdates?.map(u=>u.basis),result?.arcUpdates?.map(u=>u.basis)]}:{}),
    memories: material.memoryIds.map(id => {
      const m=state.memories.find(m=>m.id===id);
      // A normal development changes the current interpretation, not the
      // already supplied immutable source. Correction and forgetting still do.
      const replacement=companion&&state.memories.find(n=>n.id===m?.replacedBy)?.revisionKind==='development'?undefined:m?.replacedBy;
      return m ? [m.id,m.bookId,m.partnerId,m.kind,material.sourceStampVersion===2?memoryContentIdentity(m):requireMemoryText(m),m.source,m.forgotten,replacement,m.invalidatedBy,m.reviewDisposition,m.answersPartOf,
        m.readingStage,m.narrative,m.sourceEvidence,m.sourceQuote,mergeRanges(m.evidence),...(m.documentRevision?['document-revision',m.documentRevision]:[]),...(m.temporal||m.clue?['semantic-note',semanticNote(m)]:[]),...(m.backgroundOrigin?['background-origin']:[]),...(m.historicalOnly?['historical-only']:[]),
        ...(m.about||m.identityClaim||m.attribution||m.ruleLinks||m.worldChangeOf?[m.about,m.identityClaim,m.attribution,m.ruleLinks,m.worldChangeOf,m.entityBindings]:[]),...(m.arcProjection?[m.arcProjection,m.arcChangeOf]:[]),...(m.stageNarrative?[m.stageNarrative]:[]),...(m.stateProjection?[m.stateProjection,m.stateChangeOf]:[]),...(material.basisStampVersion===1&&['stage','state','arc'].includes(m.kind)?['structural-basis',m.basis??null]:[]),...(material.sourceStampVersion===2?['lineage',m.parents,m.chatIds,m.habitIds,m.basis,m.correctionOf,m.revisionKind,m.revisionReason,m.correctionRepairSources,m.webSources]:[])] : null;
    }),
    ...(material.historicalCommentIds?.length?{historicalCommentIds:material.historicalCommentIds}:{}),
    ...(material.expressionContract?{expressionContract:material.expressionContract}:{}),
    chats: material.chatIds.map(id => {
      const c=state.chats.find(c=>c.id===id);
      return c ? [c.id,c.bookId,c.partnerId,c.sessionId,c.role,c.text,c.excluded,c.outdatedBy,c.replacedBy,c.futureGrant,mergeRanges(c.evidence),...(c.presentation==='paragraph'?['paragraph',c.anchor,c.formationRanges,c.formedThrough,...(c.replyTo||c.readerInteraction?['interaction',c.replyTo,c.paragraphCommentId,c.readerInteraction]:[])]:[])] : null;
    }),
    habits: material.habitIds.map(id => {
      const h=state.habits?.find(h=>h.id===id);
      return h ? [h.id,h.partnerId,h.key,h.value,h.forgotten,h.retiredBy,h.invalidatedBy] : null;
    }),
  });
}

export function draftBook(book: Book, draft: Pick<ReadingDraft,'source'|'ranges'>): Book {
  return draft.source==='background' ? {...book,known:[{start:readingStart(book),end:Math.max(...draft.ranges.map(r=>r.end))}]} : book;
}

export function createReadingDraft(state: State, book: Book, request: ReadingDraftRequest, result: ReadingReply, webSources: WebReference[], material: ReadingDraftMaterial, association: ReadingDraft['association']): ReadingDraft {
  const refs=mergeRanges(material.refs).map(r=>({...r,bookId:book.id,version:book.version}));
  const value=structuredClone({...material,readingStrategy:material.readingStrategy??'structured',stateWriteVersion:material.stateWriteVersion??1,refs,originalRanges:mergeRanges(material.originalRanges),messages:material.messages.filter(m=>m.role==='user')});
  if(result.stageNarrative?.basis!==undefined||result.stateUpdates?.some(u=>u.basis!==undefined)||result.arcUpdates?.some(u=>u.basis!==undefined)||value.memoryIds.some(id=>state.memories.some(m=>m.id===id&&['stage','state','arc'].includes(m.kind)&&m.basis!==undefined)))value.basisStampVersion=1;
  return {id:id(),bookId:book.id,version:book.version,partnerId:state.partnerId,createdAt:Date.now(),
    source:request.source,...(request.sceneOpportunity?{sceneOpportunity:request.sceneOpportunity}:{}),ranges:mergeRanges(request.ranges),input:request.input,...(request.sceneCommentIds?.length?{sceneCommentIds:[...request.sceneCommentIds]}:{}),...(request.correctionRepairId?{correctionRepairId:request.correctionRepairId}:{}),...(request.maintenanceJobId?{maintenanceJobId:request.maintenanceJobId,maintenanceClaim:request.maintenanceClaim}:{}),result:structuredClone(result),webSources:structuredClone(webSources),material:value,
    dependencyStamp:dependencyStamp(state,value.partialMemoryIds?.length?{...value,memoryIds:[...value.memoryIds,...value.partialMemoryIds]}:value,result),association};
}

export function readingDraftUsable(state: State, draft: ReadingDraft): boolean {
  if(!draft.material)return false;
  if(maintenanceTaskCommitted(state,draft))return false;
  if(draft.material.correctionRepairId&&!state.companionCorrectionRepairs?.some(p=>p.id===draft.material.correctionRepairId&&correctionRepairUsable(state,p)))return false;
  const book=state.books.find(b=>b.id===draft.bookId&&b.version===draft.version);
  const completed=state.readings?.find(r=>r.bookId===draft.bookId&&r.version===draft.version&&r.partnerId===draft.partnerId&&r.source===draft.source&&(r.draftId===draft.id||r.supersededReceiptIds?.includes(draft.id)));
  const pendingScene=completed?.sceneJudgment&&draft.material.taskRole==='scene'&&state.chats.some(c=>c.publication?.scene?.usageId===draft.id&&['deferred','save-failed'].includes(c.publication.status));
  if(!book||!state.partners.some(p=>p.id===draft.partnerId)||completed&&!pendingScene)return false;
  const scope=draftBook(book,draft);
  if(draft.material.sceneRecordIds?.some(id=>{const r=state.readings?.find(r=>r.id===id);return!r||!sceneRecordAllowed({...state,partnerId:draft.partnerId},scope,r);}))return false;
  if(draft.material.viewIds?.some(id=>{const view=state.publishedViews?.find(v=>v.id===id);return!view||!viewAllowed(state,scope,view);}))return false;
  if(!isEvidenceAllowed(scope,draft.material.refs)||!isEvidenceAllowed(scope,draft.ranges.map(r=>({...r,bookId:book.id,version:book.version}))))return false;
  const material=draft.material.partialMemoryIds?.length?{...draft.material,memoryIds:[...draft.material.memoryIds,...draft.material.partialMemoryIds]}:draft.material;
  if(!stampsEqual(dependencyStamp(state,material,draft.result),draft.dependencyStamp))return false;
  if([...draft.material.memoryIds,...(draft.material.partialMemoryIds??[])].some(id=>!state.memories.some(m=>m.id===id&&m.bookId===book.id&&m.partnerId===draft.partnerId&&!m.forgotten&&!m.invalidatedBy&&isEvidenceAllowed(scope,m.evidence)))||
    draft.material.chatIds.some(id=>!state.chats.some(c=>c.id===id&&c.bookId===book.id&&chatAllowsMemory(state,c)&&!c.excluded&&(!c.outdatedBy&&!c.replacedBy||draft.material.historicalCommentIds?.includes(id)&&c.presentation==='paragraph')&&!c.futureGrant&&isEvidenceAllowed(scope,c.evidence))))return false;
  const forgotten=state.forgotten.filter(f=>f.bookId===book.id);
  if(forgotten.length){const text=normalize(JSON.stringify(draft.result));if(forgotten.some(f=>text.includes(normalize(f.text))))return false;}
  return true;
}

export function pendingReadingDrafts(state: State, bookId: string, background=false): ReadingDraft[] {
  return (state.readingDrafts??[]).filter(d=>!d.blockedReason&&!d.continuation&&d.bookId===bookId&&d.partnerId===state.partnerId&&(d.source==='background')===background&&readingDraftUsable(state,d)).sort((a,b)=>a.createdAt-b.createdAt);
}
export function matchingReadingDraft(state: State, book: Book, request: ReadingDraftRequest): ReadingDraft|undefined {
  const sameRequest=(d:ReadingDraft)=>d.bookId===book.id&&d.version===book.version&&d.partnerId===state.partnerId&&d.source===request.source&&d.input===request.input&&d.maintenanceJobId===request.maintenanceJobId&&d.maintenanceClaim===request.maintenanceClaim&&JSON.stringify(d.sceneCommentIds??[])===JSON.stringify(request.sceneCommentIds??[])&&JSON.stringify(d.ranges)===JSON.stringify(mergeRanges(request.ranges));
  if(request.resumeId){
    const draft=state.readingDrafts?.find(d=>d.id===request.resumeId);
    if(!draft||!sameRequest(draft)||draft.continuation||!readingDraftUsable(state,draft))throw Error('指定原理解候选的任务或形成来源无效，未再生成');
    return draft;
  }
  return pendingReadingDrafts(state,book.id,request.source==='background').find(sameRequest);
}
export function pruneReadingDrafts(state: State): boolean {
  if(!state.readingDrafts?.length)return false;
  const kept=state.readingDrafts.filter(d=>d.materialRef||d.blockedReason||d.continuation||readingDraftUsable(state,d)),changed=kept.length!==state.readingDrafts.length;
  if(changed)state.readingDrafts=kept;
  return changed;
}

/** Persisted drafts are bounded data, never saved system instructions or model
 * reasoning. Imported old drafts are subsequently reconciled with local edits. */
export function validateReadingDrafts(state: State, checkOriginal=true): void {
  if(state.readingDrafts===undefined)return;
  if(!Array.isArray(state.readingDrafts)||state.readingDrafts.length>1500)throw Error('阅读草稿记录无效');
  const seen=new Set<string>();
  const ids=(v:unknown):v is string[]=>Array.isArray(v)&&v.length<=256&&v.every(x=>typeof x==='string'&&x.length>0&&x.length<=128);
  for(const d of state.readingDrafts){
    const b=state.books.find(b=>b.id===d?.bookId&&b.version===d.version),c=d?.material;
    if(!c&&d.materialRef){validateTaskMaterialRef(d.materialRef);if(!b||!d.id||seen.has(d.id)||!state.partners.some(p=>p.id===d.partnerId)||!['preparation','reading','background'].includes(d.source)||!Array.isArray(d.ranges)||!d.result||typeof d.input!=='string'||typeof d.dependencyStamp!=='string')throw Error('冷阅读草稿身份无效');seen.add(d.id);continue;}
    if(d.sceneOpportunity){if(!b||c?.taskRole!=='scene'||JSON.stringify(d.sceneOpportunity)!==JSON.stringify(c.sceneOpportunity))throw Error('现场草稿机会与原材料身份不符');validateSceneOpportunity(b,d.sceneOpportunity);}
    if(d.result?.sceneInsight){const i=d.result.sceneInsight;if(typeof i.text!=='string'||!i.text.trim()||i.text.length>1600||!Array.isArray(i.sourceIds)||!i.sourceIds.length||i.sourceIds.some(id=>!c?.passages?.some(([key])=>key===id)))throw Error('现场草稿成果与实际原文出处无效');}
    if(b&&c)validateMaterialProjection({...state,partnerId:d.partnerId},b,c);
    if(d.sceneCommentIds!==undefined&&(!Array.isArray(d.sceneCommentIds)||!d.sceneCommentIds.length||new Set(d.sceneCommentIds).size!==d.sceneCommentIds.length||d.sceneCommentIds.some(id=>typeof id!=='string'||!id)||c?.taskRole!=='scene'||JSON.stringify(d.sceneCommentIds)!==JSON.stringify(c.sceneCommentIds)||d.sceneCommentIds.some(id=>!c.chatIds.includes(id))))throw Error('现场草稿实际评论触发身份无效');
    if(d.maintenanceJobId!==undefined&&(typeof d.maintenanceJobId!=='string'||!d.maintenanceJobId||typeof d.maintenanceClaim!=='string'||!/^[a-f0-9]{64}$/.test(d.maintenanceClaim)||c?.taskRole!=='maintenance'||c.maintenanceJobId!==d.maintenanceJobId)||d.maintenanceClaim!==undefined&&!d.maintenanceJobId)throw Error('维护草稿的原任务或claim身份无效');
    if(c?.correctionRepairId!==undefined&&(typeof c.correctionRepairId!=='string'||c.correctionRepairId!==d.correctionRepairId||c.readingStrategy!=='companion'))throw Error('更正恢复草稿身份无效');
    const ranges=(v:unknown):boolean=>Array.isArray(v)&&v.length<=5000&&v.every(r=>r&&Number.isSafeInteger(r.start)&&Number.isSafeInteger(r.end)&&r.start>=0&&r.end>r.start&&r.end<=bookLength(b!));
    if(!d||!b||typeof d.id!=='string'||!d.id||seen.has(d.id)||!state.partners.some(p=>p.id===d.partnerId)||!['preparation','reading','background'].includes(d.source)||
      !Number.isFinite(d.createdAt)||d.createdAt<0||typeof d.input!=='string'||d.input.length>30000||!['pending','ready'].includes(d.association)||!c||d.delivery!==undefined&&!isReadingDelivery(d.delivery)||c.outputProtocol!==undefined&&!['reading-text-v1','reading-documents-v1'].includes(c.outputProtocol)||c.outputProtocol==='reading-documents-v1'&&c.readingStrategy!=='companion'||
      c.outputReactionAllowed!==undefined&&(c.outputReactionAllowed!==true||!['reading-text-v1','reading-documents-v1'].includes(c.outputProtocol??'')||d.source!=='reading')||
      !Array.isArray(d.ranges)||!d.ranges.length||d.ranges.length>(c.readingStrategy==='full-original'?5000:16)||!ranges(d.ranges)||!ranges(c.refs)||!c.refs.length||!ranges(c.originalRanges)||
      c.historicalSourceIds!==undefined&&(!ids(c.historicalSourceIds)||c.historicalSourceIds.some(id=>!c.memoryIds.includes(id)))||c.refs.some(r=>r.bookId!==b.id||r.version!==b.version)||!ids(c.memoryIds)||!ids(c.partialMemoryIds??[])||!ids(c.chatIds)||!ids(c.habitIds)||
      typeof d.dependencyStamp!=='string'||!Array.isArray(c.messages)||c.messages.length>64||c.messages.some(m=>m?.role!=='user'||typeof m.content!=='string')||
      !Array.isArray(c.passages)||c.passages.length>256||!Array.isArray(d.webSources)||d.webSources.length>10||JSON.stringify(d).length>2000000)throw Error('阅读草稿的范围或来源无效');
    if(c.expressionContract!==undefined&&(c.expressionContract!=='paragraph-expressions-v1'||d.source!=='reading'))throw Error('阅读草稿表达合同无效');
    if(c.historicalCommentIds!==undefined&&(!ids(c.historicalCommentIds)||c.historicalCommentIds.some(id=>!c.chatIds.includes(id)||!state.chats.some(chat=>chat.id===id&&chat.presentation==='paragraph'))))throw Error('阅读形成材料的历史段评引用无效');
    if(d.supersededReceiptIds!==undefined&&(!ids(d.supersededReceiptIds)||d.supersededReceiptIds.length>12||new Set(d.supersededReceiptIds).size!==d.supersededReceiptIds.length||d.supersededReceiptIds.includes(d.id)))throw Error('阅读草稿原答继起编号无效');
    if(c.analysisTask!==undefined&&c.analysisTask!==true)throw Error('独立分析草稿模式无效');
    if(c.basisStampVersion!==undefined&&c.basisStampVersion!==1)throw Error('结构依据草稿标记无效');
    if(c.sourceStampVersion!==undefined&&c.sourceStampVersion!==2)throw Error('阅读草稿来源身份版本无效');
    if(c.worldCandidate!==undefined&&c.worldCandidate!=='v1')throw Error('世界草稿协议无效');
    if(c.arcCandidate!==undefined&&c.arcCandidate!=='v1')throw Error('弧线草稿协议无效');
    if(c.narrativeMode!==undefined&&!['legacy','stages'].includes(c.narrativeMode))throw Error('阅读草稿任务模式无效');
    if(c.stateWriteVersion!==undefined&&c.stateWriteVersion!==1&&c.stateWriteVersion!==2)throw Error('阅读草稿写入协议版本无效');
    if(c.readingStrategy!==undefined&&!['structured','full-original','companion'].includes(c.readingStrategy))throw Error('阅读草稿处理策略无效');
    if(c.workspaceRevision!==undefined&&(!Number.isSafeInteger(c.workspaceRevision)||c.workspaceRevision<0)||
      c.workspaceVersion!==undefined&&!isWorkspaceVersion(c.workspaceVersion,c.workspaceRevision)||
      c.workspaceSource!==undefined&&c.workspaceSource!==(d.source==='background'?'background':'reading')||
      (c.workspaceRevision!==undefined||c.workspaceSource!==undefined)&&c.readingStrategy!=='companion')throw Error('阅读草稿工作台形成版本无效');
    if(d.continuation){const x=d.continuation,usage=x.usageId?state.usage.find(u=>u.id===x.usageId):undefined;
      if(c.readingStrategy!=='companion'||d.correctionRepairId||Object.keys(x).some(k=>!['status','targetRevision','targetVersion','usageId','reason'].includes(k))||!['pending','requested','received','blocked'].includes(x.status)||!isWorkspaceVersion(x.targetVersion,x.targetRevision)||x.reason!==undefined&&(typeof x.reason!=='string'||x.reason.length>4000)||
        x.usageId!==undefined&&(!usage||typeof usage.requestKey!=='string')||['requested','received'].includes(x.status)&&!usage)throw Error('并发阅读接续记录无效');
      if(usage){let key;try{key=JSON.parse(usage.requestKey!);}catch{throw Error('并发阅读接续任务身份无效');}if(!Array.isArray(key)||key.length!==5||key[0]!==d.bookId||key[1]!==d.version||key[2]!==d.partnerId||key[3]!==d.source||JSON.stringify(key[4])!==JSON.stringify(d.ranges.map(({start,end})=>({start,end}))))throw Error('并发阅读接续任务身份不符');}
    }
    seen.add(d.id);
    for(const [key,q]of c.passages){if(!/^p[1-9]\d*$/.test(key)||!q||typeof q.text!=='string'||q.text.length>200||!ranges([q.evidence])||q.evidence.bookId!==b.id||q.evidence.version!==b.version||
      !c.originalRanges.some(r=>r.start<=q.evidence.start&&r.end>=q.evidence.end)||checkOriginal&&q.text!==b.text.slice(q.evidence.start,q.evidence.end))throw Error('阅读草稿原文片段无效');}
    const r=parseReadingReply(JSON.stringify(d.result),c.stateWriteVersion??1,c.readingStrategy??'structured');
    if(r.thoughts.some(t=>t.temporal!==undefined||t.clue!==undefined)&&(c.worldCandidate!=='v1'||c.narrativeMode!=='stages'||c.readingStrategy==='full-original'))throw Error('旧草稿未开放有源时间与线索写入');
    if((r.entityRoots!==undefined||r.thoughts.some(t=>t.about||t.identityClaim||t.attribution||t.ruleLinks||t.worldChangeOf))&&(c.worldCandidate!=='v1'||c.readingStrategy==='full-original'))throw Error('旧草稿未开放世界写入');
    if(r.arcUpdates!==undefined&&(c.arcCandidate!=='v1'||c.readingStrategy==='full-original'))throw Error('旧草稿未开放弧线写入');
    if(c.readingStrategy==='full-original'&&(r.readingBrief!==undefined||r.stageNarrative!==undefined||r.stateUpdates!==undefined))throw Error('完整原文草稿不能包含专门结构写入');
    if(c.readingStrategy==='companion'&&(c.narrativeMode!==undefined&&c.narrativeMode!=='legacy'||c.analysisTask||c.arcCandidate||c.worldCandidate||
      r.readingBrief!==undefined||r.stageNarrative!==undefined||r.stateUpdates!==undefined||r.arcUpdates!==undefined||r.entityRoots!==undefined))throw Error('伴读草稿不能沿用专门结构写入');
    if(r.lookup||r.recall||r.history||r.read||r.search||r.readPage)throw Error('未完成工具请求不能保存为理解草稿');
    for(const w of d.webSources){if(typeof w.title!=='string')throw Error('阅读草稿联网来源无效');publicWebUrl(w.url);}
  }
}
