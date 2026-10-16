import {remainingMaintenanceJob} from './maintenance-recovery.ts';
import {validateSceneOpportunity} from './scene-scheduling.ts';
import {validateParagraphChats} from './paragraph-comments.ts';
import {validatePublishedViews,currentPublishedViews,maintenanceViewTargetComplete} from './published-views.ts';
import {validateMaintenanceDispatchHeaders,validateMaintenanceDispatch,maintenanceTaskCommitted} from './maintenance-dispatch.ts';
import {parseKnowledgeDistribution} from './knowledge-distribution.ts';
import {validateWorldState} from './world-identity.ts';
import {validateDocumentRevision} from './document-revision.ts';
import {validateSemanticState} from './semantic-notes.ts';
import {validateArcMemories} from './arc-state.ts';
import { READING_MEMORY_LIMIT } from './types.ts';
import {readingReactionPayload} from './reading-output.ts';
import {hashText} from './text-hash.ts';
import {hydrateMemoryBodies,requireMemoryText,validateMemoryBody} from './memory-bodies.ts';
import {prepareMemoryIdentities,memoryContentIdentity} from './memory-identity.ts';
import {prepareMemoryRecovery} from './memory-recovery.ts';
import { applyFrontMatterBoundary, covers, importBook,mergeRanges,subtractRanges } from './books.ts';
import { forgetMemory,isBackgroundMemory, reconcileCorrections,reconcileMemoryOrigins } from './context.ts';
import { validateService } from './services.ts';
import { publicWebUrl } from './web.ts';
import { boundBasis, parseBasis,parseStructuralBasis } from './basis.ts';
import {validHabit,reconcileHabits} from './habits.ts';
import { recoverInterruptedState } from './startup.ts';
import { validateReviewTasks } from './review-tasks.ts';
import { validateNarrativeState } from './narrative.ts';
import {pruneReadingDrafts,validateReadingDrafts,readingDraftUsable} from './reading-drafts.ts';
import {validateStageStateMemories,currentStates} from './stage-state.ts';
import {validateQueryCheckpoints,mergeQueryCheckpoints} from './query-checkpoints.ts';
import {validateCompanionWorkspaces,mergeCompanionWorkspaces} from './companion-workspace.ts';
import {validateCorrectionRepairs,mergeCorrectionRepairs} from './companion-correction-repair.ts';
import {validateCompanionReadingReceipts,mergeCompanionReadingReceipts} from './companion-receipts.ts';
import type { State, Store } from './types.ts';
import {ordinaryReadingTask} from './terminated-reading-continuation.ts';
import {semanticReferenceIds} from './semantic-notes.ts';
import {worldEntityIds} from './world-identity.ts';

/** A successful dispatch carries its saved outputs when restoring an older archive. */
function mergeMaintenanceRecovery(target:State,local:State):void{
  const belongs=(bookId:string,version:string,partnerId:string)=>target.books.some(b=>b.id===bookId&&b.version===version)&&target.partners.some(p=>p.id===partnerId);
  const commits=local.usage.flatMap(usage=>{const d=usage.maintenanceDispatch,key=usage.requestKey&&ordinaryReadingTask(usage.requestKey);return d?.committed&&key&&belongs(key.bookId,key.version,key.partnerId)?[{dispatch:d,key}]:[];});
  for(const book of target.books){
    const completed=commits.filter(c=>c.key.bookId===book.id&&c.key.version===book.version),current=local.books.find(b=>b.id===book.id&&b.version===book.version);
    if(!completed.length||!current)continue;
    const within=(ranges:import('./types.ts').Range[],fence:import('./types.ts').Range[])=>subtractRanges(ranges,subtractRanges(ranges,fence));
    const claimed=mergeRanges(completed.flatMap(c=>c.dispatch.claim.ranges));if(!claimed.length)continue;
    const permitted=within(claimed,current.known),committedRanges=within(permitted,current.prepared);
    book.known=mergeRanges([...subtractRanges(book.known,claimed),...permitted]);
    book.prepared=mergeRanges([...subtractRanges(book.prepared,claimed),...committedRanges]);
    if(book.position>0&&covers(claimed,{start:book.position-1,end:book.position})&&!covers(book.known,{start:book.position-1,end:book.position}))book.position=Math.max(0,...book.known.filter(r=>r.end<=book.position).map(r=>r.end));
    if(book.buffered)book.buffered=subtractRanges(book.buffered,claimed);
  }
  const viewIds=new Set(commits.flatMap(c=>c.dispatch.committed!.viewIds)),memoryIds=new Set(commits.flatMap(c=>c.dispatch.committed!.memoryIds)),chatIds=new Set<string>();
  const publications=new Map((target.viewPublications??[]).map(p=>[p.id,p]));
  for(const c of commits){
    const commit=c.dispatch.committed!,publication=local.viewPublications?.find(p=>p.id===commit.publicationId);
    if(publication&&(!publications.has(publication.id)||publications.get(publication.id)!.revision<=publication.revision)){publications.set(publication.id,structuredClone(publication));for(const id of publication.viewIds)viewIds.add(id);}
    const reading=local.readings?.find(r=>r.id===commit.readingId);
    if(reading&&!target.readings?.some(r=>r.id===reading.id))(target.readings??=[]).push(structuredClone(reading));
  }
  const copiedViews=new Set<string>(),copiedMemories=new Set<string>(),copiedChats=new Set<string>();
  while([...viewIds].some(id=>!copiedViews.has(id))||[...memoryIds].some(id=>!copiedMemories.has(id))||[...chatIds].some(id=>!copiedChats.has(id))){
    for(const id of viewIds){
      if(copiedViews.has(id))continue;copiedViews.add(id);const view=local.publishedViews?.find(v=>v.id===id);if(!view)throw Error('本地维护提交的概要成果缺失');
      for(const id of [...view.viewSources,...(view.previousId?[view.previousId]:[])])viewIds.add(id);
      for(const source of view.memorySources)memoryIds.add(source.id);for(const id of view.contextChatIds)chatIds.add(id);
      const saved=target.publishedViews?.find(v=>v.id===id);if(saved&&JSON.stringify(saved)!==JSON.stringify(view))throw Error('同一维护概要身份存在冲突，未覆盖备份');
      if(!saved)(target.publishedViews??=[]).push(structuredClone(view));
    }
    for(const id of memoryIds){
      if(copiedMemories.has(id))continue;copiedMemories.add(id);const memory=local.memories.find(m=>m.id===id);if(!memory)throw Error('本地维护提交的认识依赖缺失');
      for(const ref of [...memory.parents,...(memory.basis?.memoryIds??[]),...semanticReferenceIds(memory),...(memory.entityBindings??[]).map(b=>b.memoryId),...(memory.ruleLinks??[]).map(l=>l.memoryId),memory.attribution?.contentRef?.memoryId,memory.worldChangeOf,memory.identityClaim?.changeOf,memory.correctionOf,memory.replacedBy,memory.invalidatedBy,memory.answersPartOf,memory.stateChangeOf,memory.arcChangeOf].filter((id):id is string=>!!id))memoryIds.add(ref);
      for(const entityId of worldEntityIds(memory)){const root=local.entityRoots?.find(r=>r.id===entityId);if(root){memoryIds.add(root.originMemoryId);if(!target.entityRoots?.some(r=>r.id===root.id))(target.entityRoots??=[]).push(structuredClone(root));}}
      for(const id of [...memory.chatIds,...(memory.basis?.chatIds??[])])chatIds.add(id);
      const saved=target.memories.find(m=>m.id===id);
      if(!saved)target.memories.push(structuredClone(memory));
      else if(memoryContentIdentity(saved).hash!==memoryContentIdentity(memory).hash)throw Error('同一维护认识身份存在冲突正文，未覆盖备份');
    }
    for(const id of chatIds){
      if(copiedChats.has(id))continue;copiedChats.add(id);const chat=local.chats.find(c=>c.id===id);if(!chat)throw Error('本地维护成果的交流依赖缺失');
      for(const id of [...(chat.memoryIds??[]),...(chat.basis?.memoryIds??[]),...(chat.memoryResult?.memoryIds??[])])memoryIds.add(id);
      for(const id of [...(chat.contextChatIds??[]),...(chat.basis?.chatIds??[]),chat.replyTo].filter((id):id is string=>!!id))chatIds.add(id);
      const saved=target.chats.find(c=>c.id===id);if(saved&&saved.text!==chat.text)throw Error('同一维护交流身份存在冲突正文，未覆盖备份');
      if(!saved)target.chats.push(structuredClone(chat));
      const conversation=local.conversations.find(c=>c.id===chat.sessionId);if(conversation&&!target.conversations.some(c=>c.id===conversation.id))target.conversations.push(structuredClone(conversation));
    }
  }
  if(publications.size)target.viewPublications=[...publications.values()];
  const localJobs=(local.maintenanceJobs??[]).filter(j=>belongs(j.bookId,j.version,j.partnerId)),localIds=new Set(localJobs.map(j=>j.id));
  const incoming=(target.maintenanceJobs??[]).filter(j=>!localIds.has(j.id)).flatMap(job=>{const remaining=remainingMaintenanceJob(local,job);return remaining?[remaining]:[];});
  if(target.maintenanceJobs||localJobs.length)target.maintenanceJobs=[...incoming,...structuredClone(localJobs)];
}
export async function restoreBackup(raw: string, current: State, store?: Store): Promise<State> {
  const recoveryStore: Store = store ?? { async load() { return undefined; }, async save() {} };
  if (raw.length > 180_000_000) throw new Error('备份超过本原型支持的体积');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('无法读取此备份'); }
  const v = value as State;
  for(const owner of [...(v.readingDrafts??[]),...(v.companionReadingReceipts??[]),...(v.queryCheckpoints??[]),...(v.queryCheckpoints??[]).flatMap(q=>q.pendingReceipt?[q.pendingReceipt]:[]),...(v.usage??[]).flatMap(u=>u.maintenanceDispatch?[u.maintenanceDispatch]:[])])if(owner.materialRef)throw Error('可移机备份须携完整原任务材料，不能携带本机存储引用');
  if (v?.schema !== 1 || !Array.isArray(v.books) || !Array.isArray(v.memories) || !Array.isArray(v.chats) || !Array.isArray(v.usage) || !Array.isArray(v.partners) || !Array.isArray(v.forgotten) || !Array.isArray(v.conversations) || !Array.isArray(v.settings?.services) || !v.settings.services.length || !v.partners.length) throw new Error('备份格式不完整');
  // Credentials are a transfer envelope, imported separately by explicit choice.
  // They must never persist in ordinary state or leak into later key-free exports.
  delete (value as Record<string, unknown>).secrets;
  delete (value as Record<string, unknown>).exportedAt;
  if (v.books.length > 500 || v.memories.length > 100000 || v.chats.length > 200000) throw new Error('备份记录数量超过原型支持范围');
  for (const book of v.books) {
    if (typeof book.id !== 'string' || typeof book.title !== 'string' || typeof book.text !== 'string' || !Array.isArray(book.known) || !Array.isArray(book.prepared)) throw new Error('书籍数据无效');
    if(book.readingStrategy!==undefined&&!['structured','full-original','companion'].includes(book.readingStrategy))throw Error('共读处理策略无效');
    if(book.worldCandidate!==undefined&&book.worldCandidate!=='v1')throw Error('世界候选能力无效');
    if(book.arcCandidate!==undefined&&book.arcCandidate!=='v1')throw Error('弧线候选能力无效');
    if(book.narrativeMode!==undefined&&!['legacy','stages'].includes(book.narrativeMode))throw Error('共读叙事资料方式无效');
    if (book.readingSourceId !== undefined && (typeof book.readingSourceId !== 'string' || !/^[a-z0-9:._-]{1,80}$/i.test(book.readingSourceId))) throw new Error('阅读应用标识无效');
    const checked = await importBook(book.title, book.text);
    if (checked.version !== book.version) throw new Error('书籍正文与备份版本不一致');
    book.chapters = checked.chapters;
    book.text = checked.text; book.textLength = checked.textLength;
    book.frontMatterEnd = checked.frontMatterEnd;
    if (book.frontMatterIncluded !== undefined && typeof book.frontMatterIncluded !== 'boolean') throw new Error('书前简介设置无效');
    if (current.books.some(local => local.id === book.id && local.version === book.version && local.frontMatterIncluded === false)) book.frontMatterIncluded = false;
    if(book.sceneObserved!==undefined&&(!Array.isArray(book.sceneObserved)||new Set(book.sceneObserved.map(o=>o.partnerId)).size!==book.sceneObserved.length||book.sceneObserved.some(o=>!o||typeof o.partnerId!=='string'||!o.partnerId||!Array.isArray(o.ranges)||o.ranges.some(r=>!r||!Number.isSafeInteger(r.start)||!Number.isSafeInteger(r.end)||r.start<0||r.end<=r.start||r.end>book.text.length))))throw Error('现场实际观察范围无效');
    if (book.backgroundPrepared !== undefined && !Array.isArray(book.backgroundPrepared)) throw new Error('背景覆盖记录无效');
    if (book.buffered !== undefined && !Array.isArray(book.buffered)) throw new Error('阅读缓冲记录无效');
    if(book.fullOriginalPending!==undefined&&(!Array.isArray(book.fullOriginalPending)||book.fullOriginalPending.length>5000))throw Error('完整原文待办记录无效');
    for (const r of [...book.known, ...book.prepared, ...(book.backgroundPrepared ?? []), ...(book.buffered ?? []),...(book.fullOriginalPending??[])]) if (!r || !Number.isSafeInteger(r.start) || !Number.isSafeInteger(r.end) || r.start < 0 || r.end <= r.start || r.end > book.text.length) throw new Error('备份包含无效阅读范围');
    if (!Number.isSafeInteger(book.position) || book.position < 0 || book.position > book.text.length || (book.position > 0 && !covers(book.known, { start: book.position - 1, end: book.position }))) throw new Error('阅读位置超出确认范围');
    if (book.prepared.some(r => !covers(book.known, r))) throw new Error('前文准备超出确认范围');
    if (book.buffered?.some(r => !covers(book.known, r) || book.prepared.some(p => p.start < r.end && p.end > r.start))) throw new Error('阅读缓冲超出确认范围或与已处理内容重叠');
    if(book.fullOriginalPending?.some(r=>!covers(book.known,r)))throw Error('完整原文待办超出确认范围');
    applyFrontMatterBoundary(book);
  }
  const ids = new Set(v.books.map(b => b.id));
  if (v.transcriptRevisions !== undefined && (!Array.isArray(v.transcriptRevisions) || v.transcriptRevisions.length > 200000)) throw new Error('转写更正记录无效');
  for (const r of v.transcriptRevisions ?? []) if (!r || !ids.has(r.bookId) || typeof r.originalId !== 'string' || !r.originalId || typeof r.replacementId !== 'string' || !r.replacementId || r.originalId === r.replacementId || !Number.isFinite(r.createdAt) || r.createdAt < 0) throw new Error('转写更正记录无效');
  if(v.habits!==undefined&&(!Array.isArray(v.habits)||v.habits.length>10000))throw new Error('相处习惯记录无效');
  for (const collection of [v.books, v.memories, v.chats, v.conversations, v.partners, v.usage, v.settings.services, v.transcriptRevisions ?? [], v.habits??[]]) {
    const seen = new Set<string>();
    for (const item of collection) { if (!item || typeof item.id !== 'string' || !item.id || seen.has(item.id)) throw new Error('备份包含重复或无效标识'); seen.add(item.id); }
  }
  for (const p of v.partners) if (typeof p.name !== 'string' || typeof p.traits !== 'string' || !Array.isArray(p.backgroundBooks) || p.backgroundBooks.some(id => !ids.has(id))) throw new Error('伙伴记录无效');
  if (!v.partners.some(p => p.id === v.partnerId)) throw new Error('当前伙伴记录无效');
  const strings = (a: unknown) => Array.isArray(a) && a.every(x => typeof x === 'string');
  for(const h of v.habits??[]){
    if(!v.partners.some(p=>p.id===h.partnerId)||!validHabit(h.key,h.value)||!Number.isFinite(h.createdAt)||h.createdAt<0||typeof h.forgotten!=='boolean'||
      [h.sourceChatId,h.sourceBookId,h.replaces,h.retiredBy,h.invalidatedBy].some(x=>x!==undefined&&(typeof x!=='string'||!x))||!!h.sourceChatId!==!!h.sourceBookId)throw new Error('相处习惯记录无效');
    const chat=v.chats.find(c=>c.id===h.sourceChatId);
    if(h.sourceBookId&&!ids.has(h.sourceBookId)||chat&&(chat.role!=='user'||chat.bookId!==h.sourceBookId||chat.futureGrant))throw new Error('相处习惯来源无效');
    for(const ref of [h.replaces,h.retiredBy].filter(Boolean)){const linked=v.habits?.find(x=>x.id===ref);if(!linked||linked.partnerId!==h.partnerId||linked.key!==h.key||linked.id===h.id)throw new Error('相处习惯更正关系无效');}
  }
  for(const p of v.partners)for(const key of ['replyLength','followupQuestions'])if((v.habits??[]).filter(h=>h.partnerId===p.id&&h.key===key&&!h.retiredBy&&!h.forgotten&&!h.invalidatedBy).length>1)throw new Error('同一相处习惯存在多个当前值');
  for (const m of v.memories) if (!m || !ids.has(m.bookId) || !v.partners.some(p => p.id === m.partnerId) || typeof m.text !== 'string' || !strings(m.parents) || !strings(m.chatIds) || !Array.isArray(m.evidence) || !['story','opinion','question','shared','user','context','stage','state','arc'].includes(m.kind) || !['preparation','reading','conversation','background','correction','review'].includes(m.source) || typeof m.forgotten !== 'boolean'||m.historicalOnly!==undefined&&m.historicalOnly!==true) throw new Error('备份的记忆记录无效');
  for (const memory of v.memories) {
    if (memory.bodyRef) await validateMemoryBody({ key: memory.bodyRef.key, hash: memory.bodyRef.hash, text: requireMemoryText(memory) }, memory.bodyRef);
    // A complete backup carries actual text; storage references are recreated on save.
    delete memory.bodyRef;
    parseKnowledgeDistribution(memory.knowledgeDistribution,'memory.knowledgeDistribution');
    if (memory.documentTitle !== undefined && (typeof memory.documentTitle !== 'string' || memory.documentTitle.length > 200) || memory.navigationCues !== undefined && (!strings(memory.navigationCues) || memory.navigationCues.length > 16 || memory.navigationCues.some(cue => cue.length > 200))) throw Error('阅读档案导航记录无效');
  }
  await prepareMemoryIdentities(v.memories);
  for(const r of v.readings??[])if(r.sceneCommentIds!==undefined&&(!Array.isArray(r.sceneCommentIds)||new Set(r.sceneCommentIds).size!==r.sceneCommentIds.length||r.sceneCommentIds.some(id=>typeof id!=='string'||!id))||r.sceneJudgment!==undefined&&!['quiet','expressions'].includes(r.sceneJudgment))throw Error('现场判断与实际评论触发身份无效');
  for(const r of v.readings??[]){
    const book=v.books.find(b=>b.id===r.bookId&&b.version===r.version);if(r.sceneOpportunity){if(!book||!r.sceneJudgment)throw Error('自然现场记录缺少原判断身份');validateSceneOpportunity(book,r.sceneOpportunity);}
    const i=r.sceneInsight;if(i){const strings=(x:unknown):x is string[]=>Array.isArray(x)&&new Set(x).size===x.length&&x.every(id=>typeof id==='string'&&!!id);if(!book||!r.sceneJudgment||Object.keys(i).some(k=>!['text','evidence','memoryIds','chatIds','viewIds'].includes(k))||typeof i.text!=='string'||!i.text.trim()||i.text.length>1600||!Array.isArray(i.evidence)||!i.evidence.length||i.evidence.some(e=>e.bookId!==book.id||e.version!==book.version||!Number.isSafeInteger(e.start)||!Number.isSafeInteger(e.end)||e.start<0||e.end<=e.start||e.end>book.text.length)||!strings(i.memoryIds)||!strings(i.chatIds)||i.viewIds!==undefined&&!strings(i.viewIds))throw Error('现场阶段成果的原形成范围或依赖无效');}
  }
  for(const u of v.usage)if(u.sceneOpportunity){const task=u.requestKey&&JSON.parse(u.requestKey),book=task&&v.books.find(b=>b.id===task[0]&&b.version===task[1]);if(!book||task[5]!=='scene')throw Error('自然现场首派的原请求身份无效');validateSceneOpportunity(book,u.sceneOpportunity);}
  for(const r of v.readings??[])if(r.supersededReceiptIds!==undefined&&(!r.draftId||!Array.isArray(r.supersededReceiptIds)||r.supersededReceiptIds.length>12||new Set(r.supersededReceiptIds).size!==r.supersededReceiptIds.length||r.supersededReceiptIds.some(id=>typeof id!=='string'||!id||id.length>128||id===r.draftId)))throw Error('阅读记录原答继起编号无效');
  for(const m of v.memories)if(m.kind==='context'&&(!requireMemoryText(m).trim()||requireMemoryText(m).length>1000||!m.readingStage?.length&&m.source!=='correction'))throw new Error('阅读简报记录无效');
  for (const m of v.memories) if ([m.correctionOf, m.replacedBy, m.invalidatedBy].some(x => x !== undefined && (typeof x !== 'string' || !x)) || (['correction','review'].includes(m.source) && !m.correctionOf)) throw new Error('备份的更正记录无效');
  for(const m of v.memories)if(m.backgroundOrigin!==undefined){
    if(m.backgroundOrigin!==true||!['review','correction'].includes(m.source))throw new Error('独立阅读来源标记无效');
    const seen=new Set<string>();let previous=v.memories.find(p=>p.id===m.correctionOf);
    while(previous&&previous.source!=='background'&&!seen.has(previous.id)&&['review','correction'].includes(previous.source)){
      seen.add(previous.id);previous=v.memories.find(p=>p.id===previous!.correctionOf);
    }
    if(!previous||previous.source!=='background'||previous.bookId!==m.bookId||previous.partnerId!==m.partnerId)throw new Error('独立阅读来源标记无效');
  }
  reconcileMemoryOrigins(v);
  for (const m of v.memories) if (m.answersPartOf !== undefined) {
    const question = v.memories.find(q=>q.id===m.answersPartOf);
    if (typeof m.answersPartOf !== 'string' || !question || question.kind !== 'question' || !['story','opinion'].includes(m.kind) ||
      question.bookId !== m.bookId || question.partnerId !== m.partnerId || !m.parents.includes(question.id) ||
      question.evidence.some(r=>!covers(m.evidence,r))) throw new Error('部分答案的疑问关联无效');
  }
  for (const m of v.memories) if (m.revisionKind !== undefined || m.revisionReason !== undefined) {
    const previous = v.memories.find(p => p.id === m.correctionOf);
    const brief=previous?.kind==='context'&&m.kind==='context';
    if (m.revisionKind !== 'development' || typeof m.revisionReason !== 'string' || !m.revisionReason.trim() || m.revisionReason.length > 240 ||
      !previous || !brief&&(!['opinion','question'].includes(previous.kind) || !['story','opinion','question'].includes(m.kind)) ||
      (m.source === 'background' ? !isBackgroundMemory(previous) : isBackgroundMemory(previous)||!['preparation','reading','conversation'].includes(m.source) || !(brief?['preparation','reading','conversation','correction','review']:['preparation','reading','conversation','review']).includes(previous.source))) throw new Error('理解更新记录无效');
  }
  for (const m of v.memories) if (m.source === 'review'
    ? !['story','context','opinion','question','stage','state','arc'].includes(m.kind) || v.memories.find(p=>p.id===m.correctionOf)?.kind!==m.kind || m.answersPartOf!==undefined&&m.answersPartOf!==v.memories.find(p=>p.id===m.correctionOf)?.answersPartOf || ['opinion','question'].includes(m.kind)&&v.memories.find(p=>p.id===m.correctionOf)?.text!==m.text || m.kind==='context'&&requireMemoryText(m).length>1000 || !['supported','unsupported'].includes(m.reviewDisposition!) || typeof m.reviewReason !== 'string' || !m.reviewReason.trim() || m.reviewReason.length > 600 || !m.evidence.length
    : m.reviewDisposition !== undefined || m.reviewReason !== undefined) throw new Error('事实核对记录无效');
  for (const m of v.memories) for (const ref of [m.correctionOf, m.replacedBy, m.invalidatedBy].filter(Boolean)) {
    const linked = v.memories.find(x => x.id === ref);
    const transcript = ref === m.invalidatedBy && v.transcriptRevisions?.some(r => r.id === ref && r.bookId === m.bookId);
    const habit = ref === m.invalidatedBy && v.habits?.some(h=>h.id===ref&&h.partnerId===m.partnerId);
    if (!transcript && !habit && (!linked || linked.bookId !== m.bookId || linked.partnerId !== m.partnerId || linked.id === m.id)) throw new Error('备份的更正关联无效');
  }
  for (const c of v.chats) if (!c || !ids.has(c.bookId) || typeof c.text !== 'string' || !Array.isArray(c.evidence) || !['user', 'assistant'].includes(c.role) || typeof c.excluded !== 'boolean' || typeof c.sessionId !== 'string' || (c.futureGrant !== undefined && typeof c.futureGrant !== 'string')) throw new Error('备份的聊天记录无效');
  for (const item of [...v.memories, ...v.chats]) {
    if(item.habitIds!==undefined&&(!strings(item.habitIds)||item.habitIds.length>2||item.habitIds.some(id=>!v.habits?.some(h=>h.id===id))))throw new Error('相处习惯引用无效');
    const book = v.books.find(b => b.id === item.bookId)!;
    for (const r of item.evidence) if (!r || r.bookId !== book.id || r.version !== book.version || !Number.isSafeInteger(r.start) || !Number.isSafeInteger(r.end) || r.start < 0 || r.end <= r.start || r.end > book.text.length) throw new Error('资料引用与原文不符');
    if (item.webSources !== undefined) {
      if (!Array.isArray(item.webSources) || item.webSources.length > 10) throw new Error('联网来源记录无效');
      for (const ref of item.webSources) { if (typeof ref.title !== 'string' || ref.read !== undefined && typeof ref.read !== 'boolean') throw new Error('联网来源记录无效'); publicWebUrl(ref.url); }
    }
  }
  await validateParagraphChats(v);
  for (const c of v.chats) if (c.partnerId !== undefined && !v.partners.some(p => p.id === c.partnerId)) throw new Error('聊天所属伙伴无效');
  for (const c of v.chats) if ((c.delivery !== undefined && !['pending','failed','answered','stopped'].includes(c.delivery)) || (c.longReply !== undefined && typeof c.longReply !== 'boolean') || (c.expansionOffered !== undefined && (typeof c.expansionOffered !== 'boolean' || c.role !== 'assistant')) || (c.expansionOf !== undefined && (typeof c.expansionOf !== 'string' || c.role !== 'user')) || (c.replyTo !== undefined && typeof c.replyTo !== 'string')) throw new Error('问题处理记录无效');
  for(const c of v.chats)if(c.readingReaction!==undefined){
    const r=c.readingReaction,b=v.books.find(b=>b.id===c.bookId)!;
    if(!r||typeof r!=='object'||Object.keys(r).some(k=>!['requestKey','raw','status','reason','usageId','attempts'].includes(k))||typeof r.requestKey!=='string'||r.requestKey.length>12000||typeof r.raw!=='string'||r.raw.length>20000||!['saved','delivered','suppressed'].includes(r.status)||c.role!=='assistant'||c.futureGrant||readingReactionPayload(r.raw,true)!==c.text||c.id!=='reading-reaction:'+await hashText(r.requestKey)||r.status==='saved'&&(!c.excluded||c.delivery!=='pending')||r.status==='suppressed'&&(!c.excluded||c.delivery!=='stopped')||r.status==='delivered'&&c.delivery!=='answered')throw Error('提前阅读反应的原文载体或交付状态无效');
    if(r.reason!==undefined&&typeof r.reason!=='string'||r.usageId!==undefined&&typeof r.usageId!=='string'||r.attempts!==undefined&&(!Array.isArray(r.attempts)||r.attempts.some(a=>!a||typeof a.raw!=='string'||readingReactionPayload(a.raw,true)===undefined||!['saved','delivered','suppressed'].includes(a.status)||a.reason!==undefined&&typeof a.reason!=='string'||a.usageId!==undefined&&typeof a.usageId!=='string')))throw Error('反应尝试的原文与状态无效');
    let key:unknown;try{key=JSON.parse(r.requestKey);}catch{throw Error('提前阅读反应的任务编号无效');}
    if(!Array.isArray(key)||!(key.length===5||key.length===6&&key[5]==='scene'||key.length===7&&key[5]==='scene'&&ordinaryReadingTask(r.requestKey))||key[0]!==b.id||key[1]!==b.version||key[2]!==c.partnerId||key[3]!=='reading'||!Array.isArray(key[4])||!key[4].length||key[4].some((p:any)=>!p||!Number.isSafeInteger(p.start)||!Number.isSafeInteger(p.end)||p.start<0||p.end<=p.start||p.end>b.text.length||!covers(c.evidence,p)))throw Error('提前阅读反应与本书任务来源不符');
  }
  for(const c of v.chats)if(c.memoryAllowed!==undefined&&c.memoryAllowed!==false)throw Error('交流的后续资料采用权限无效');
  for(const c of v.chats)if(c.answerScope!==undefined&&!['overview','focused'].includes(c.answerScope))throw Error('问题的答复范围无效');
  for (const m of v.memories) if (m.sourceEvidence !== undefined) {
    const book = v.books.find(b => b.id === m.bookId)!;
    if (!Array.isArray(m.sourceEvidence) || !m.sourceEvidence.length ||
      m.sourceEvidence.some(r => !r || r.bookId !== book.id || r.version !== book.version ||
        !Number.isSafeInteger(r.start) || !Number.isSafeInteger(r.end) || r.start < 0 || r.end <= r.start || r.end > book.text.length ||
        !covers(m.evidence, r))) throw new Error('记忆原文依据超出记录的使用范围');
  }
  for (const m of v.memories) if (m.sourceQuote !== undefined) {
    const q = m.sourceQuote, r = q?.evidence, book = v.books.find(b => b.id === m.bookId)!;
    if (!q || typeof q.text !== 'string' || q.text.length < 8 || q.text.length > 200 || !r || r.bookId !== book.id || r.version !== book.version ||
      !Number.isSafeInteger(r.start) || !Number.isSafeInteger(r.end) || !m.evidence.some(e => e.start <= r.start && e.end >= r.end) ||
      q.text !== book.text.slice(r.start, r.end)) throw new Error('记忆短引与原文不符');
  }
  for(const m of v.memories)if(m.documentRevision!==undefined)validateDocumentRevision(m,v.memories.find(p=>p.id===m.documentRevision!.previousId),v.books.find(b=>b.id===m.bookId)!);
  for (const c of v.chats) if ((c.memoryIds !== undefined && !strings(c.memoryIds)) || (c.contextChatIds !== undefined && !strings(c.contextChatIds)) || (c.outdatedBy !== undefined && typeof c.outdatedBy !== 'string')) throw new Error('聊天的更正关联无效');
  for (const c of v.chats) {
    if(c.responseProfile?.worldCandidate!==undefined&&c.responseProfile.worldCandidate!=='v1')throw Error('回应世界候选协议无效');
    if(c.responseProfile?.arcCandidate!==undefined&&c.responseProfile.arcCandidate!=='v1')throw Error('回应弧线候选协议无效');
    if(c.responseProfile!==undefined&&(!c.responseProfile||!['structured','full-original','companion'].includes(c.responseProfile.readingStrategy)||!['legacy','stages'].includes(c.responseProfile.narrativeMode)||['full-original','companion'].includes(c.responseProfile.readingStrategy)&&c.responseProfile.narrativeMode!=='legacy'))throw Error('回应任务资料方式无效');
    if (c.input !== undefined && c.input !== 'voice') throw new Error('发言来源无效');
    if (c.corrects !== undefined && (c.input !== 'voice' || !v.transcriptRevisions?.some(r => r.originalId === c.corrects && r.replacementId === c.id && r.bookId === c.bookId))) throw new Error('转写替换关联无效');
    if (c.replacedBy !== undefined && !v.transcriptRevisions?.some(r => r.originalId === c.id && r.replacementId === c.replacedBy && r.bookId === c.bookId)) throw new Error('转写替换关联无效');
  }
  for (const c of v.chats) if (c.memoryResult !== undefined && (!c.memoryResult || !['saved','reused','not_saved','temporary'].includes(c.memoryResult.status) || !strings(c.memoryResult.memoryIds))) throw new Error('记忆保存结果无效');
  for (const c of v.chats) if (c.memoryResult) {
    const result = c.memoryResult, positive = result.status === 'saved' || result.status === 'reused';
    if(result.habitIds!==undefined&&(!strings(result.habitIds)||result.habitIds.length>2||result.habitIds.some(id=>!v.habits?.some(h=>h.id===id))))throw new Error('相处习惯保存结果无效');
    if (positive !== (result.memoryIds.length > 0 || !!result.habitIds?.length) || result.memoryIds.length > READING_MEMORY_LIMIT || result.memoryIds.some(id => !v.memories.some(m => m.id === id && m.bookId === c.bookId))) throw new Error('记忆保存结果与实际记录不符');
  }
  for (const m of v.memories) if (m.basis !== undefined) {
    const structural=['stage','state','arc'].includes(m.kind)&&!['review','correction'].includes(m.source);
    const basis = boundBasis(structural?parseStructuralBasis(m.basis,m.parents.length):parseBasis(m.basis), m.parents, m.chatIds, m.habitIds??[]);
    if (!basis) throw new Error('记忆的来源关联无效'); m.basis = basis;
  }
  for (const c of v.chats) if (c.basis !== undefined) {
    const basis = boundBasis(parseBasis(c.basis), c.memoryIds ?? [], c.contextChatIds ?? [], c.habitIds??[]);
    if (!basis) throw new Error('聊天的来源关联无效'); c.basis = basis;
  }
  for (const c of v.conversations) if (!ids.has(c.bookId) || typeof c.title !== 'string' || typeof c.manualTitle !== 'boolean' || !Number.isSafeInteger(c.start) || !Number.isSafeInteger(c.end) || c.start < 0 || c.end < c.start || c.end > v.books.find(b => b.id === c.bookId)!.text.length) throw new Error('对话索引无效');
  for (const f of v.forgotten) if (!f || typeof f.id !== 'string' || typeof f.bookId !== 'string' || typeof f.text !== 'string' || (f.chatIds !== undefined && !strings(f.chatIds))) throw new Error('忘记记录无效');
  for (const u of v.usage) if (!u || typeof u.id !== 'string' || !Number.isFinite(u.input) || !Number.isFinite(u.output) || u.input < 0 || u.output < 0) throw new Error('备份的用量记录无效');
  for (const u of v.usage) if (u.taskId !== undefined && (typeof u.taskId !== 'string' || !u.taskId)) throw new Error('用量的任务关联无效');
  for(const u of v.usage)if(u.readingTaskFailure&&(u.readingTaskFailure.role!=='scene'||typeof u.readingTaskFailure.reason!=='string'||!u.requestKey||u.dispatchState==='not-dispatched'))throw Error('现场任务失败的原调用身份无效');
  for (const u of v.usage) if (u.reviewMemoryId !== undefined && (typeof u.reviewMemoryId!=='string'||!u.reviewMemoryId||!v.tasks?.some(t=>t.id===u.taskId&&t.items.some(i=>i.memoryId===u.reviewMemoryId)))) throw Error('用量的复核条目关联无效');
  for (const u of v.usage) if (u.dispatchState !== undefined && !['not-dispatched','dispatch-started','response-received'].includes(u.dispatchState) || u.requestKey !== undefined && (typeof u.requestKey !== 'string' || !u.requestKey)) throw new Error('用量的派发关联无效');
  validateReviewTasks(v);
  validateNarrativeState(v);
  validateStageStateMemories(v);validateArcMemories(v);validateWorldState(v);validateSemanticState(v);
  validateReadingDrafts(v);
  validateQueryCheckpoints(v);
  validateCompanionWorkspaces(v);
  validateCorrectionRepairs(v);
  validateCompanionReadingReceipts(v);
  validatePublishedViews(v);
  validateMaintenanceDispatchHeaders(v);for(const usage of v.usage)if(usage.maintenanceDispatch)await validateMaintenanceDispatch(v,usage,false);
  for(const view of v.publishedViews??[])for(const source of view.memorySources){const memory=v.memories.find(m=>m.id===source.id)!;if(memoryContentIdentity(memory).hash!==source.hash)throw Error('派生视图认识来源版本与备份不符');}
  for(const view of v.publishedViews??[])for(const source of view.originalSources){const book=v.books.find(b=>b.id===view.bookId)!;if(await hashText(book.text.slice(source.evidence.start,source.evidence.end))!==source.hash)throw Error('派生视图原文来源身份与备份不符');}
  for (const u of v.usage) if ((u.cost !== undefined && (!Number.isFinite(u.cost) || u.cost < 0)) || (u.costBudgetId !== undefined && typeof u.costBudgetId !== 'string') || (u.pricing !== undefined && (u.pricing.currency !== 'CNY' || !Number.isFinite(u.pricing.input) || u.pricing.input < 0 || !Number.isFinite(u.pricing.output) || u.pricing.output < 0))) throw new Error('备份的费用记录无效');
  if (!Number.isFinite(v.settings.tokenLimit) || v.settings.tokenLimit < 0) throw new Error('备份的用量上限无效');
  if ((v.settings.costLimit !== undefined && (!Number.isFinite(v.settings.costLimit) || v.settings.costLimit < 0)) || (v.settings.costBudgetId !== undefined && typeof v.settings.costBudgetId !== 'string') || (v.settings.costBudgetStartedAt !== undefined && (!Number.isFinite(v.settings.costBudgetStartedAt) || v.settings.costBudgetStartedAt < 0))) throw new Error('备份的费用预算无效');
  v.settings.services = v.settings.services.map(s => validateService(s, true));
  if (!v.settings.services.some(s => s.id === v.settings.serviceId)) throw new Error('当前模型服务无效');
  if (!Number.isFinite(v.settings.minReactionMs) || v.settings.minReactionMs < 0 || !Number.isFinite(v.settings.minReadChars) || v.settings.minReadChars < 0) throw new Error('共读频率设置无效');
  // Preserve local revisions when importing an older snapshot of the same book/partner.
  const localRevisions = (current.transcriptRevisions ?? []).filter(r => v.books.some(b => b.id === r.bookId && current.books.some(c => c.id === b.id && c.version === b.version)));
  v.transcriptRevisions = [...new Map([...(v.transcriptRevisions ?? []), ...localRevisions].map(r => [r.id, r])).values()];
  for (const r of localRevisions) {
    const chat = current.chats.find(c => c.id === r.replacementId);
    if (!chat) continue;
    const copy = structuredClone(chat);
    if (copy.delivery === 'answered' && !v.chats.some(c => c.role === 'assistant' && c.replyTo === copy.id)) copy.delivery = 'stopped';
    const index = v.chats.findIndex(c => c.id === chat.id);
    if (index >= 0) v.chats[index] = copy; else v.chats.push(copy);
    const conversation = current.conversations.find(c => c.id === chat.sessionId);
    if (conversation && !v.conversations.some(c => c.id === conversation.id)) v.conversations.push(structuredClone(conversation));
  }
  // An older local pending receipt cannot overwrite a newer imported target.
  const localReadyTargets=new Set((current.tasks??[]).flatMap(t=>t.items.filter(i=>i.reviewReady).map(i=>i.memoryId)));
  const importedReadyTargets=new Map(v.memories.filter(m=>localReadyTargets.has(m.id)&&(m.replacedBy||m.forgotten)).map(m=>[m.id,structuredClone(m)]));
  for (const m of current.memories) if ((m.correctionOf || m.replacedBy || m.invalidatedBy) &&
    v.books.some(b => b.id === m.bookId && current.books.some(c => c.id === b.id && c.version === b.version)) && v.partners.some(p => p.id === m.partnerId)) {
    const index = v.memories.findIndex(x => x.id === m.id), local = structuredClone(m);
    if (typeof local.text !== 'string') {
      if (!store) throw Error('恢复本地更正需要读取阅读档案正文');
      await hydrateMemoryBodies(store, [local]);
    }
    if (index >= 0) v.memories[index] = local; else v.memories.push(local);
  }
  for(const [id,imported] of importedReadyTargets){const local=current.memories.find(m=>m.id===id);if(local&&!local.replacedBy&&!local.forgotten){const at=v.memories.findIndex(m=>m.id===id);v.memories[at]=imported;}}
  await prepareMemoryIdentities(v.memories);
  if(current.entityRoots?.length)v.entityRoots=[...new Map([...(v.entityRoots??[]),...current.entityRoots.filter(r=>v.books.some(b=>b.id===r.bookId&&b.version===r.version)&&v.partners.some(p=>p.id===r.partnerId)&&v.memories.some(m=>m.id===r.originMemoryId))].map(r=>[r.id,r])).values()];
  for (const c of v.chats) { const local = current.chats.find(x => x.id === c.id && x.bookId === c.bookId); if (local?.outdatedBy) c.outdatedBy = local.outdatedBy; }
  // A restored snapshot cannot reactivate superseded or forgotten local habits.
  const localHabits=(current.habits??[]).filter(h=>v.partners.some(p=>p.id===h.partnerId));
  const localKeys=new Set(localHabits.map(h=>h.partnerId+'\0'+h.key));
  v.habits=[...new Map([...(v.habits??[]).map(h=>localKeys.has(h.partnerId+'\0'+h.key)&&!localHabits.some(l=>l.id===h.id)?{...h,forgotten:true}:h),...localHabits.map(h=>({...h,sourceBookId:h.sourceBookId&&ids.has(h.sourceBookId)?h.sourceBookId:undefined,sourceChatId:h.sourceBookId&&ids.has(h.sourceBookId)?h.sourceChatId:undefined}))].map(h=>[h.id,h])).values()];
  const usage = new Map([...v.usage, ...current.usage].map(x => [x.id, x])); v.usage = [...usage.values()];
  await mergeQueryCheckpoints(v,current);validateQueryCheckpoints(v);
  mergeCompanionWorkspaces(v,current);
  mergeMaintenanceRecovery(v,current);
  // Only the local records actually carried into this detached restore need their
  // bodies. Never hydrate the live current archive to merge an older backup.
  const localBodies = v.memories.filter(memory => typeof memory.text !== 'string');
  for (let start = 0; start < localBodies.length; start += 64) await hydrateMemoryBodies(recoveryStore, localBodies.slice(start, start + 64));
  mergeCorrectionRepairs(v,current);
  await prepareMemoryRecovery(v,recoveryStore);
  reconcileCorrections(v);
  // Known local forgetting and accounting survive restoration of an older snapshot.
  const forgotten = new Map([...v.forgotten, ...current.forgotten].map(x => [x.id, x]));
  v.forgotten = [...forgotten.values()];
  for (const f of [...v.forgotten]) {
    forgetMemory(v, f.id);
    for (const c of v.chats) if (f.chatIds?.includes(c.id)) c.excluded = true;
  }
  reconcileHabits(v);
  v.forgotten = [...new Map(v.forgotten.map(f => [f.id, f])).values()];
  // Local checkpoints win over an older backup, just like local revisions and usage.
  const localTasks = (current.tasks ?? []).filter(t => v.books.some(b => b.id === t.bookId && b.version === t.version) && v.partners.some(p => p.id === t.partnerId));
  const tasks=new Map((v.tasks??[]).map(t=>[t.id,t]));
  for(const local of structuredClone(localTasks)){const incoming=tasks.get(local.id);if(incoming&&['complete','cancelled'].includes(incoming.status)&&['running','interrupted'].includes(local.status))continue;tasks.set(local.id,local);}v.tasks=[...tasks.values()];
  // A scene judgment and its candidates are one saved result. Preserve its
  // real local delivery responsibility while importing an older archive.
  const sceneRecords=(current.readings??[]).filter(r=>r.sceneJudgment&&r.draftId&&v.books.some(b=>b.id===r.bookId&&b.version===r.version)&&v.partners.some(p=>p.id===r.partnerId));
  const sceneUsages=new Set(sceneRecords.map(r=>r.draftId!));
  for(const book of v.books){const local=current.books.find(b=>b.id===book.id&&b.version===book.version);for(const observed of local?.sceneObserved??[]){const imported=book.sceneObserved?.find(o=>o.partnerId===observed.partnerId);book.sceneObserved=[...(book.sceneObserved??[]).filter(o=>o.partnerId!==observed.partnerId),{partnerId:observed.partnerId,ranges:mergeRanges([...(imported?.ranges??[]),...observed.ranges])}];}}
  for(const r of sceneRecords)if(!v.readings?.some(prior=>prior.id===r.id))(v.readings??=[]).push(structuredClone(r));
  const localSceneChats=current.chats.filter(c=>c.publication?.scene&&sceneUsages.has(c.publication.scene.usageId));
  for(const chat of localSceneChats){
    const at=v.chats.findIndex(c=>c.id===chat.id),imported=at<0?undefined:v.chats[at],copy=structuredClone(chat);
    if(imported?.excluded||v.forgotten.some(f=>f.chatIds?.includes(copy.id)))copy.excluded=true;
    if(imported?.outdatedBy)copy.outdatedBy=imported.outdatedBy;if(imported?.replacedBy)copy.replacedBy=imported.replacedBy;
    if(at<0)v.chats.push(copy);else v.chats[at]=copy;
    const conversation=current.conversations.find(c=>c.id===chat.sessionId);if(conversation&&!v.conversations.some(c=>c.id===conversation.id))v.conversations.push(structuredClone(conversation));
  }
  const completedDrafts=new Set((current.readings??[]).flatMap(r=>r.draftId?[r.draftId,...(r.supersededReceiptIds??[])]:[]));
  const localDrafts=(current.readingDrafts??[]).filter(d=>v.books.some(b=>b.id===d.bookId&&b.version===d.version)&&v.partners.some(p=>p.id===d.partnerId));
  if(v.readingDrafts||localDrafts.length){
    v.readingDrafts=[...new Map([...(v.readingDrafts??[]),...structuredClone(localDrafts)].map(d=>[d.id,d])).values()].filter(d=>(!completedDrafts.has(d.id)||d.material?.taskRole==='scene'&&readingDraftUsable(v,d)||d.materialRef&&sceneRecords.some(r=>r.draftId===d.id)&&localSceneChats.some(c=>c.publication?.scene?.usageId===d.id&&['deferred','save-failed'].includes(c.publication.status)))&&!maintenanceTaskCommitted(v,d));
    await prepareMemoryRecovery(v,recoveryStore);
    validateReadingDrafts(v);pruneReadingDrafts(v);
  }
  // Receipt merging immediately checks usability. Prepare its finite legacy
  // dependencies before that check, using detached receipt copies.
  const receiptRecovery = { ...v, companionReadingReceipts: [...(v.companionReadingReceipts ?? []), ...structuredClone((current.companionReadingReceipts ?? []).filter(receipt => v.books.some(book => book.id === receipt.bookId && book.version === receipt.version) && v.partners.some(partner => partner.id === receipt.partnerId)))] };
  await prepareMemoryRecovery(receiptRecovery,recoveryStore);
  mergeCompanionReadingReceipts(v,current);
  validateReviewTasks(v);
  if (current.settings.costBudgetId || current.settings.costLimit !== undefined) {
    v.settings.costBudgetId = current.settings.costBudgetId;
    v.settings.costBudgetStartedAt = current.settings.costBudgetStartedAt;
    v.settings.costLimit = current.settings.costLimit;
  }
  // Imported credentials never enable calls or background observation by themselves.
  v.settings.services.forEach(s => { s.enabled = false; });
  v.settings.searchEnabled = false;
  if (!v.settings.searchProvider) { v.settings.searchProvider = 'exa'; v.settings.searchEndpoint = 'https://mcp.exa.ai/mcp'; }
  v.resume = undefined;
  recoverInterruptedState(v);
  validatePublishedViews(v);validateMaintenanceDispatchHeaders(v);
  validateStageStateMemories(v);validateArcMemories(v);validateWorldState(v);validateSemanticState(v);
  for(const book of v.books)for(const partner of v.partners)for(const source of ['reading','background'] as const)currentStates({...v,partnerId:partner.id},book,{source});
  return v;
}
