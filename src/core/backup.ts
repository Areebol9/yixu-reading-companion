import {sameDocumentOwner} from './book-document-ownership.ts';
import {validateBookChapters} from './book-directory.ts';
import {bookVersionPrefixLength} from './book-versions.ts';
import {resolveBookVersion,bookVersionAllowsRange,bookVersionAllowsRanges,validateBookSourceLineage} from './book-versions.ts';
import {parseDocumentOrganization} from './document-organization.ts';
import {remainingMaintenanceJob} from './maintenance-recovery.ts';
import {verifiedContentTransfer} from './content-object-transfer.ts';
import {validateAgentSessionHeaders} from './agent-sessions.ts';
import {mergeAgentSessions,validateAgentResponses} from './agent-session-backup.ts';
import {storageMaterialOwners,resolveStorageMaterials,validateTaskMaterialRef} from './storage-records.ts';
import {validateSceneOpportunity} from './scene-scheduling.ts';
import {validateParagraphChats} from './paragraph-comments.ts';
import {validatePublishedViews,currentPublishedViews,maintenanceViewTargetComplete} from './published-views.ts';
import {validateMaintenanceDispatchHeaders,validateMaintenanceDispatch,maintenanceTaskCommitted} from './maintenance-dispatch.ts';
import {parseKnowledgeDistribution} from './knowledge-distribution.ts';
import {validateWorldState} from './world-identity.ts';
import {validateDocumentRevision,validateMergedMemoryLineage,validateDocumentLifecycle} from './document-revision.ts';
import {validateSemanticState} from './semantic-notes.ts';
import {validateArcMemories} from './arc-state.ts';
import { READING_MEMORY_LIMIT } from './types.ts';
import {readingReactionPayload} from './reading-output.ts';
import {hashText} from './text-hash.ts';
import {hydrateMemoryBodies,requireMemoryText,validateMemoryBody} from './memory-bodies.ts';
import {prepareMemoryIdentities,memoryContentIdentity,stampsEqual} from './memory-identity.ts';
import {prepareMemoryRecovery} from './memory-recovery.ts';
import { applyFrontMatterBoundary, covers, importBook,bookSourceFile,mergeRanges,subtractRanges } from './books.ts';
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
import type { PartnerAvatarAsset, State, Store, Usage } from './types.ts';
import {ordinaryReadingTask} from './terminated-reading-continuation.ts';
import {semanticReferenceIds} from './semantic-notes.ts';
import {worldEntityIds} from './world-identity.ts';
import {validatePartnerPersonas,mergePartnerPersonas} from './partner-persona.ts';
import {partnerAvatarAsset} from './partner-avatar.ts';
import {conversationBelongsToPartner} from './discussion-recall.ts';
import {maintenanceProcessed,maintenanceProgressFacts} from './maintenance-progress.ts';
import {validateFormationSources} from './formation-sources.ts';

/** Restore the saved conversation selection and native segment without moving tasks to another dialogue. */
function mergeConversationContinuity(target:State,current:State):void{
  const conversations=new Map(target.conversations.map(conversation=>[conversation.id,conversation])),local=new Map(current.conversations.map(conversation=>[conversation.id,conversation]));
  const required=new Set([...(target.agentSessions??[]).flatMap(task=>task.conversationId?[task.conversationId]:[]),...target.chats.flatMap(chat=>chat.sessionId?[chat.sessionId]:[]),...current.conversations.filter(conversation=>conversation.lastUsedAt!==undefined||conversation.context).map(conversation=>conversation.id)]);
  const taskTimes=new Map<string,number>();for(const task of [...(target.agentSessions??[]),...(current.agentSessions??[])])taskTimes.set(task.id,Math.max(taskTimes.get(task.id)??0,task.updatedAt));
  const progress=(conversation:State['conversations'][number])=>Math.max(conversation.lastUsedAt??0,taskTimes.get(conversation.context?.lastTaskId??'')??0);
  const visited=new Set<string>();
  for(const first of [...required]){let id:string|undefined=first;while(id&&!visited.has(id)){visited.add(id);const saved=local.get(id),incoming=conversations.get(id);if(!saved)break;const book=target.books.find(book=>book.id===saved.bookId),eligible=book&&target.partners.some(partner=>conversationBelongsToPartner({...current,partnerId:partner.id},saved));if(!eligible)break;
    if(incoming){
      if(incoming.bookId!==saved.bookId||incoming.partnerId!==saved.partnerId||incoming.createdAt!==saved.createdAt||incoming.previousConversationId!==saved.previousConversationId)throw Error('同一对话的作品、伙伴或前段归属发生冲突，原记录保持');
      const [latest,other]=progress(saved)>=progress(incoming)?[saved,incoming]:[incoming,saved];
      conversations.set(id,{...incoming,...(saved.lastUsedAt!==undefined||incoming.lastUsedAt!==undefined?{lastUsedAt:Math.max(saved.lastUsedAt??0,incoming.lastUsedAt??0)}:{}),...(latest.context??other.context?{context:structuredClone(latest.context??other.context)}:{}),...(latest.continuationReason??other.continuationReason?{continuationReason:latest.continuationReason??other.continuationReason}:{})});
    }else conversations.set(id,structuredClone(saved));
    id=saved.previousConversationId;
  }}
  target.conversations=[...conversations.values()];
}

async function backupAvatarAssets(value:unknown):Promise<PartnerAvatarAsset[]>{
  if(!value||typeof value!=='object')return[];
  const raw=(value as {partnerAvatarAssets?:unknown}).partnerAvatarAssets;if(raw===undefined)return[];
  if(!Array.isArray(raw))throw Error('备份头像资源无效');
  const seen=new Set<string>(),assets:PartnerAvatarAsset[]=[];
  for(const asset of raw){
    if(!asset||typeof asset.id!=='string'||seen.has(asset.id)||typeof asset.dataUrl!=='string'||!Number.isFinite(asset.createdAt)||asset.createdAt<0)throw Error('备份头像记录无效');
    const checked=await partnerAvatarAsset(asset.dataUrl);if(asset.id!==checked.id||asset.mimeType!==checked.mimeType)throw Error('备份头像内容与标识不符');
    seen.add(asset.id);assets.push({id:asset.id,mimeType:checked.mimeType,dataUrl:asset.dataUrl,createdAt:asset.createdAt});
  }
  return assets;
}

/** JSON export carries only images actually referenced by a saved partner. */
export async function collectPartnerAvatarAssets(state:State,store:Store):Promise<PartnerAvatarAsset[]>{
  const ids=new Set(state.partners.flatMap(partner=>partner.avatar?.kind==='image'?[partner.avatar.assetId]:[])),assets:PartnerAvatarAsset[]=[];
  for(const id of ids){const asset=await store.readPartnerAvatar?.(id);if(!asset)throw Error('伙伴头像原件缺失，无法导出完整备份');assets.push(asset);}
  return backupAvatarAssets({partnerAvatarAssets:assets});
}

/** Called only for actual import after restore validation, before publishing state. */
export async function writeBackupPartnerAvatars(value:unknown,store:Store):Promise<void>{
  const assets=await backupAvatarAssets(value);if(assets.length&&!store.writePartnerAvatar)throw Error('当前存储不支持恢复头像图片');
  for(const asset of assets)await store.writePartnerAvatar!(asset);
}

/** Run the same body-level validators one owner at a time. Cold references stay
 * cold after verification instead of reconstructing all historical requests. */
async function validatePortableMaterials(state:State,store:Store){
  const audits=new Set([...state.memories,...(state.publishedViews??[])].flatMap(record=>record.formationSources?[record.formationSources]:[])),auditRefs=new Map([...audits].flatMap(audit=>audit.materialRef?[[audit.materialRef.key,audit.materialRef] as const]:[]));
  for(const ref of auditRefs.values()){
    validateTaskMaterialRef(ref);const bodies=await store.readTaskMaterials?.([ref]);if(bodies?.length!==1||bodies[0].key!==ref.key||bodies[0].hash!==ref.hash)throw Error('完整供材审计的原任务正文缺失');
    const text=JSON.stringify(bodies[0].value);if(await hashText(text)!==ref.hash||new TextEncoder().encode(text).length!==ref.bytes)throw Error('完整供材审计的原任务正文版本不符');
  }
  const verify=async(owners:ReturnType<typeof storageMaterialOwners>,validate:()=>void|Promise<void>)=>{
    const cold=owners.filter(owner=>!owner.material);
    try{
      await resolveStorageMaterials(owners,store.readTaskMaterials?.bind(store));
      const selected=new Set<object>(owners);
      await prepareMemoryRecovery({...state,
        readingDrafts:state.readingDrafts?.filter(owner=>selected.has(owner)),
        companionReadingReceipts:state.companionReadingReceipts?.filter(owner=>selected.has(owner)),
        queryCheckpoints:state.queryCheckpoints?.filter(owner=>selected.has(owner)),
        agentSessions:state.agentSessions?.filter(owner=>selected.has(owner)),
        usage:state.usage.filter(usage=>usage.maintenanceDispatch&&selected.has(usage.maintenanceDispatch)),
      },store);
      await validate();
    }
    finally{for(const owner of cold)delete owner.material;}
  };
  for(const draft of state.readingDrafts??[])await verify([draft],()=>validateReadingDrafts({...state,readingDrafts:[draft]}));
  for(const receipt of state.companionReadingReceipts??[])await verify([receipt],()=>validateCompanionReadingReceipts({...state,companionReadingReceipts:[receipt]}));
  for(const query of state.queryCheckpoints??[])await verify([query,...(query.pendingReceipt?[query.pendingReceipt]:[])],()=>validateQueryCheckpoints({...state,queryCheckpoints:[query]}));
  for(const usage of state.usage)await verify([...(usage.maintenanceDispatch?[usage.maintenanceDispatch]:[]),...(usage.agentResponse?[usage.agentResponse]:[])],async()=>{
    if(usage.maintenanceDispatch)await validateMaintenanceDispatch(state,usage,false);
    validateAgentResponses({...state,usage:[usage]});
  });
  for(const record of state.agentSessions??[])await verify([record],async()=>{
    validateAgentSessionHeaders(state);
    if(record.native&&(!record.material||record.material.snapshot.events.length!==record.native.eventCount||JSON.stringify(record.material.snapshot.header)!==JSON.stringify(record.native.header)))throw Error('Portable native session is missing its exact confirmed prefix');
    for(const body of record.material?.spillBodies??[])if(await hashText(body.text)!==body.hash)throw Error('Portable native spill hash mismatch');
    for(const entry of record.native?.spills??[])if(!record.material?.spillBodies?.some(body=>body.locator===entry.locator&&body.hash===entry.hash&&body.bytes===entry.bytes))throw Error('Portable native spill is missing');
  });
}

/** A successful dispatch carries its saved outputs when restoring an older archive. */
function mergeMaintenanceRecovery(target:State,local:State):void{
  const belongs=(bookId:string,version:string,partnerId:string)=>target.books.some(b=>b.id===bookId&&bookVersionPrefixLength(b,version)!==undefined)&&target.partners.some(p=>p.id===partnerId);
  const commits=local.usage.flatMap(usage=>{const d=usage.maintenanceDispatch,key=usage.requestKey&&ordinaryReadingTask(usage.requestKey);return d&&maintenanceProgressFacts(d).length&&key&&belongs(key.bookId,key.version,key.partnerId)?[{dispatch:d,key}]:[];});
  for(const book of target.books){
    const completed=commits.filter(c=>c.key.bookId===book.id&&bookVersionPrefixLength(book,c.key.version)!==undefined),current=local.books.find(b=>b.id===book.id&&b.version===book.version);
    if(!completed.length||!current)continue;
    const within=(ranges:import('./types.ts').Range[],fence:import('./types.ts').Range[])=>subtractRanges(ranges,subtractRanges(ranges,fence));
    const claimed=mergeRanges(completed.flatMap(c=>maintenanceProcessed(c.dispatch).ranges));if(!claimed.length)continue;
    const permitted=within(claimed,current.known),committedRanges=within(permitted,current.prepared);
    book.known=mergeRanges([...subtractRanges(book.known,claimed),...permitted]);
    book.prepared=mergeRanges([...subtractRanges(book.prepared,claimed),...committedRanges]);
    if(book.position>0&&covers(claimed,{start:book.position-1,end:book.position})&&!covers(book.known,{start:book.position-1,end:book.position}))book.position=Math.max(0,...book.known.filter(r=>r.end<=book.position).map(r=>r.end));
    if(book.buffered)book.buffered=subtractRanges(book.buffered,claimed);
  }
  const viewIds=new Set(commits.flatMap(c=>maintenanceProgressFacts(c.dispatch).flatMap(fact=>fact.viewIds))),memoryIds=new Set(commits.flatMap(c=>maintenanceProgressFacts(c.dispatch).flatMap(fact=>fact.memoryIds))),chatIds=new Set<string>(),habitIds=new Set<string>();
  const publications=new Map((target.viewPublications??[]).map(p=>[p.id,p]));
  for(const c of commits){
    const commit=c.dispatch.committed,publication=local.viewPublications?.find(p=>p.id===commit?.publicationId||p.bookId===c.key.bookId&&p.viewIds.some(id=>viewIds.has(id)));
    if(publication&&(!publications.has(publication.id)||publications.get(publication.id)!.revision<=publication.revision)){publications.set(publication.id,structuredClone(publication));for(const id of publication.viewIds)viewIds.add(id);}
    const reading=local.readings?.find(r=>r.id===commit?.readingId);
    if(reading&&!target.readings?.some(r=>r.id===reading.id))(target.readings??=[]).push(structuredClone(reading));
  }
  const copiedViews=new Set<string>(),copiedMemories=new Set<string>(),copiedChats=new Set<string>();
  while([...viewIds].some(id=>!copiedViews.has(id))||[...memoryIds].some(id=>!copiedMemories.has(id))||[...chatIds].some(id=>!copiedChats.has(id))){
    for(const id of viewIds){
      if(copiedViews.has(id))continue;copiedViews.add(id);const view=local.publishedViews?.find(v=>v.id===id);if(!view)throw Error('本地维护提交的概要成果缺失');
      for(const id of [...view.viewSources,...(view.previousId?[view.previousId]:[]),...(view.formationSources?.viewIds??[])])viewIds.add(id);
      for(const source of view.memorySources)memoryIds.add(source.id);for(const id of view.formationSources?.memoryIds??[])memoryIds.add(id);for(const id of [...view.contextChatIds,...(view.formationSources?.chatIds??[])])chatIds.add(id);for(const id of view.formationSources?.habitIds??[])habitIds.add(id);
      const saved=target.publishedViews?.find(v=>v.id===id);if(saved&&JSON.stringify(saved)!==JSON.stringify(view))throw Error('同一维护概要身份存在冲突，未覆盖备份');
      if(!saved)(target.publishedViews??=[]).push(structuredClone(view));
    }
    for(const id of memoryIds){
      if(copiedMemories.has(id))continue;copiedMemories.add(id);const memory=local.memories.find(m=>m.id===id);if(!memory)throw Error('本地维护提交的认识依赖缺失');
      for(const ref of [...memory.parents,...(memory.formationSources?.memoryIds??[]),...(memory.writeBaseIds??[]),...(memory.mergePreviousIds??[]),...(memory.documentSuccessors??[]),...(memory.basis?.memoryIds??[]),...semanticReferenceIds(memory),...(memory.entityBindings??[]).map(b=>b.memoryId),...(memory.ruleLinks??[]).map(l=>l.memoryId),memory.attribution?.contentRef?.memoryId,memory.worldChangeOf,memory.identityClaim?.changeOf,memory.correctionOf,memory.replacedBy,memory.invalidatedBy,memory.answersPartOf,memory.stateChangeOf,memory.arcChangeOf].filter((id):id is string=>!!id))memoryIds.add(ref);
      for(const id of memory.formationSources?.viewIds??[])viewIds.add(id);for(const id of [...(memory.habitIds??[]),...(memory.formationSources?.habitIds??[])])habitIds.add(id);
      for(const entityId of worldEntityIds(memory)){const root=local.entityRoots?.find(r=>r.id===entityId);if(root){memoryIds.add(root.originMemoryId);if(!target.entityRoots?.some(r=>r.id===root.id))(target.entityRoots??=[]).push(structuredClone(root));}}
      for(const id of [...memory.chatIds,...(memory.formationSources?.chatIds??[]),...(memory.basis?.chatIds??[])])chatIds.add(id);
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
  for(const id of habitIds){const habit=local.habits?.find(habit=>habit.id===id);if(!habit)throw Error('本地维护成果的习惯审计来源缺失');if(!target.habits?.some(saved=>saved.id===id))(target.habits??=[]).push(structuredClone(habit));}
  if(publications.size)target.viewPublications=[...publications.values()];
  const localJobs=(local.maintenanceJobs??[]).filter(j=>belongs(j.bookId,j.version,j.partnerId)),localIds=new Set(localJobs.map(j=>j.id));
  const incoming=(target.maintenanceJobs??[]).filter(j=>!localIds.has(j.id)).flatMap(job=>{const remaining=remainingMaintenanceJob(local,job);return remaining?[remaining]:[];});
  if(target.maintenanceJobs||localJobs.length)target.maintenanceJobs=[...incoming,...structuredClone(localJobs)];
}
/** Native events and domain commits have independent save boundaries. Equal
 * native watermarks can still carry a newly committed operation receipt. */
async function mergeUsageOperationReceipts(incoming:Usage[],current:Usage[],store:Store):Promise<Usage[]>{
  const merged=new Map(incoming.map(usage=>[usage.id,usage]));
  for(const local of current){
    const saved=merged.get(local.id),added=saved?.agentResponse?.material?.operations;
    if(saved&&(['agentSessionId','agentCallId','nativeSessionId','taskExecutionId','requestKey','questionId'] as const).some(key=>local[key]!==undefined&&saved[key]!==undefined&&local[key]!==saved[key]))throw Error('同一用量记录的执行任务或原生上下文归属冲突，未覆盖原调用');
    const savedProgress=saved?.maintenanceDispatch&&(saved.maintenanceDispatch.progress?.length||saved.maintenanceDispatch.committed);
    if(!saved||!added?.length&&!savedProgress){merged.set(local.id,local);continue;}
    // Preserve the existing accounting rule: a local unresolved request stays
    // unresolved until its own receipt recovery proves settlement.
    if(local.status!=='complete'||local.dispatchState!=='response-received'||local.modelOutcome){merged.set(local.id,local);continue;}
    if(local.agentSessionId!==saved.agentSessionId||local.agentCallId!==saved.agentCallId||local.input!==saved.input||local.output!==saved.output)throw Error('备份操作回执与本地原调用身份或结算不一致');
    const copy=structuredClone(local);
    if(savedProgress){
      const original=copy.maintenanceDispatch,received=saved.maintenanceDispatch!;
      if(original&&!stampsEqual(JSON.stringify([original.payloadHash,original.request,original.claim]),JSON.stringify([received.payloadHash,received.request,received.claim])))throw Error('同一维护原调用的冻结任务或供材身份冲突');
      const progress=new Map((original?.progress??[]).map(receipt=>[receipt.operationKey,receipt]));
      for(const receipt of received.progress??[]){const prior=progress.get(receipt.operationKey);if(prior&&!stampsEqual(JSON.stringify(prior),JSON.stringify(receipt)))throw Error('同一维护操作的部分提交回执冲突');if(!prior)progress.set(receipt.operationKey,structuredClone(receipt));}
      if(original?.committed&&received.committed&&!stampsEqual(JSON.stringify(original.committed),JSON.stringify(received.committed)))throw Error('同一维护原任务的最终提交回执冲突');
      copy.maintenanceDispatch={...(original??structuredClone(received)),...(progress.size?{progress:[...progress.values()]}:{}),...(original?.committed??received.committed?{committed:structuredClone(original?.committed??received.committed!)}:{})};
    }
    if(!added?.length){merged.set(copy.id,copy);continue;}
    if(copy.agentResponse)await resolveStorageMaterials([copy.agentResponse],store.readTaskMaterials?.bind(store));
    const old=copy.agentResponse?.material,body=saved.agentResponse!.material!;
    if(old&&JSON.stringify(old.response)!==JSON.stringify(body.response))throw Error('同一领域操作的原始模型响应出现冲突，未覆盖原答');
    const operations=new Map((old?.operations??[]).map(receipt=>[receipt.operation.key,receipt]));
    for(const receipt of added){const prior=operations.get(receipt.operation.key);if(prior&&JSON.stringify(prior)!==JSON.stringify(receipt))throw Error('同一领域提交的原回执出现冲突');if(!prior)operations.set(receipt.operation.key,structuredClone(receipt));}
    copy.agentResponse={material:{...(old??structuredClone(body)),operations:[...operations.values()]}};
    merged.set(copy.id,copy);
  }
  return [...merged.values()];
}

export async function restoreBackup(raw: string, current: State, store?: Store): Promise<State> {
  if (raw.length > 180_000_000) throw new Error('备份超过本原型支持的体积');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('无法读取此备份'); }
  return restoreBackupState(value,current,store);
}

/** Host streaming import enters the same complete validation and reconciliation
 * after parsing records, without building a second whole-archive JSON string. */
export async function restoreBackupState(value:unknown,current:State,store?:Store):Promise<State>{
  const transfer=verifiedContentTransfer(value);
  const avatars=await backupAvatarAssets(value);
  const recoveryStore: Store = store ?? {...transfer?.store,async load() { return undefined; }, async save() {if(transfer)throw Error('Portable validation resolver is read-only');}};
  const v = value as State;
  if (v?.schema !== 1 || !Array.isArray(v.books) || !Array.isArray(v.memories) || !Array.isArray(v.chats) || !Array.isArray(v.usage) || !Array.isArray(v.partners) || !Array.isArray(v.forgotten) || !Array.isArray(v.conversations) || !Array.isArray(v.settings?.services) || !v.settings.services.length || !v.partners.length) throw new Error('备份格式不完整');
  for(const owner of storageMaterialOwners(v))if(owner.materialRef&&!transfer)throw Error('可移机备份须携完整原任务材料，不能携带本机存储引用');
  // Credentials are a transfer envelope, imported separately by explicit choice.
  // They must never persist in ordinary state or leak into later key-free exports.
  delete (value as Record<string, unknown>).secrets;
  delete (value as Record<string, unknown>).exportedAt;
  delete (value as Record<string, unknown>).partnerAvatarAssets;
  if (v.books.length > 500 || v.memories.length > 100000 || v.chats.length > 200000) throw new Error('备份记录数量超过原型支持范围');
  for (const book of v.books) {
    if (typeof book.id !== 'string' || typeof book.title !== 'string' || typeof book.text !== 'string' || !Array.isArray(book.known) || !Array.isArray(book.prepared)) throw new Error('书籍数据无效');
    if(book.readingStrategy!==undefined&&!['structured','full-original','companion'].includes(book.readingStrategy))throw Error('共读处理策略无效');
    if(book.worldCandidate!==undefined&&book.worldCandidate!=='v1')throw Error('世界候选能力无效');
    if(book.arcCandidate!==undefined&&book.arcCandidate!=='v1')throw Error('弧线候选能力无效');
    if(book.narrativeMode!==undefined&&!['legacy','stages'].includes(book.narrativeMode))throw Error('共读叙事资料方式无效');
    if (book.readingSourceId !== undefined && (typeof book.readingSourceId !== 'string' || !/^[a-z0-9:._-]{1,80}$/i.test(book.readingSourceId))) throw new Error('阅读应用标识无效');
    const importedSource=bookSourceFile(book.sourceFile);
    // A backup may be opened on another computer. Retain the file name while
    // letting a fresh local import establish a usable external path.
    book.sourceFile=importedSource?{name:importedSource.name}:undefined;
    const checked = await importBook(book.title, book.text);
    if (checked.version !== book.version) throw new Error('书籍正文与备份版本不一致');
    await validateBookSourceLineage(book);
    validateBookChapters(book.chapters,checked.text.length);
    if(book.directory){if(book.directory.version!==book.version||!['local','model'].includes(book.directory.method)||typeof book.directory.unresolved!=='boolean')throw Error('书籍目录与当前原文不一致');validateBookChapters(book.directory.entries,checked.text.length);}
    book.text = checked.text; book.textLength = checked.textLength;
    book.frontMatterEnd ??= checked.frontMatterEnd;
    if (book.frontMatterIncluded !== undefined && typeof book.frontMatterIncluded !== 'boolean') throw new Error('书前简介设置无效');
    if (current.books.some(local => local.id === book.id && local.version === book.version && local.frontMatterIncluded === false)) book.frontMatterIncluded = false;
    if(book.partnerProgress!==undefined&&(!Array.isArray(book.partnerProgress)||new Set(book.partnerProgress.map(p=>p.partnerId)).size!==book.partnerProgress.length||book.partnerProgress.some(p=>!v.partners.some(partner=>partner.id===p.partnerId)||[p.prepared,p.backgroundPrepared??[],p.buffered??[],p.fullOriginalPending??[]].some(ranges=>!Array.isArray(ranges)||ranges.some(r=>!r||!Number.isSafeInteger(r.start)||!Number.isSafeInteger(r.end)||r.start<0||r.end<=r.start||r.end>book.text.length)))))throw Error('伙伴的书籍阅读进度无效');
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
  validatePartnerPersonas(v);
  for(const partner of v.partners)if(partner.avatar?.kind==='image'){
    const id=partner.avatar.assetId,portable=transfer?.store as Pick<Store,'readPartnerAvatar'>|undefined;
    const asset=avatars.find(a=>a.id===id)??await portable?.readPartnerAvatar?.(id)??await store?.readPartnerAvatar?.(id);
    if(!asset)throw Error('备份缺少伙伴头像原件');
    await backupAvatarAssets({partnerAvatarAssets:[asset]});if(asset.id!==id)throw Error('备份头像引用不符');
  }
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
    if(memory.formationSources)validateFormationSources(memory.formationSources,v);
    if(memory.writeBaseIds!==undefined&&(!strings(memory.writeBaseIds)||new Set(memory.writeBaseIds).size!==memory.writeBaseIds.length||memory.writeBaseIds.some(id=>!memory.parents.includes(id)||!v.memories.some(previous=>previous.id===id&&previous.bookId===memory.bookId))))throw Error('文档写入基版引用无效');
    if (memory.bodyRef) await validateMemoryBody({ key: memory.bodyRef.key, hash: memory.bodyRef.hash, text: requireMemoryText(memory) }, memory.bodyRef);
    // A complete backup carries actual text; storage references are recreated on save.
    delete memory.bodyRef;
    parseDocumentOrganization(memory.organization);
    parseKnowledgeDistribution(memory.knowledgeDistribution,'memory.knowledgeDistribution');
    if (memory.documentTitle !== undefined && (typeof memory.documentTitle !== 'string' || memory.documentTitle.length > 200) || memory.navigationCues !== undefined && (!strings(memory.navigationCues) || memory.navigationCues.length > 16 || memory.navigationCues.some(cue => cue.length > 200))) throw Error('阅读档案导航记录无效');
  }
  await prepareMemoryIdentities(v.memories);
  for(const r of v.readings??[])if(r.sceneCommentIds!==undefined&&(!Array.isArray(r.sceneCommentIds)||new Set(r.sceneCommentIds).size!==r.sceneCommentIds.length||r.sceneCommentIds.some(id=>typeof id!=='string'||!id))||r.sceneJudgment!==undefined&&!['quiet','expressions'].includes(r.sceneJudgment))throw Error('现场判断与实际评论触发身份无效');
  for(const r of v.readings??[]){
    const book=resolveBookVersion(v.books.find(b=>b.id===r.bookId),r.version);if(r.sceneOpportunity){if(!book||!r.sceneJudgment)throw Error('自然现场记录缺少原判断身份');validateSceneOpportunity(book,r.sceneOpportunity);}
    const i=r.sceneInsight;if(i){const strings=(x:unknown):x is string[]=>Array.isArray(x)&&new Set(x).size===x.length&&x.every(id=>typeof id==='string'&&!!id);if(!book||!r.sceneJudgment||Object.keys(i).some(k=>!['text','evidence','memoryIds','chatIds','viewIds'].includes(k))||typeof i.text!=='string'||!i.text.trim()||i.text.length>1600||!Array.isArray(i.evidence)||!i.evidence.length||i.evidence.some(e=>e.bookId!==book.id||!bookVersionAllowsRange(book,e.version,e)||!Number.isSafeInteger(e.start)||!Number.isSafeInteger(e.end)||e.start<0||e.end<=e.start||e.end>book.text.length)||!strings(i.memoryIds)||!strings(i.chatIds)||i.viewIds!==undefined&&!strings(i.viewIds))throw Error('现场阶段成果的原形成范围或依赖无效');}
  }
  for(const u of v.usage)if(u.sceneOpportunity){const task=u.requestKey&&JSON.parse(u.requestKey),book=task&&resolveBookVersion(v.books.find(b=>b.id===task[0]),task[1]);if(!book||task[5]!=='scene')throw Error('自然现场首派的原请求身份无效');validateSceneOpportunity(book,u.sceneOpportunity);}
  for(const r of v.readings??[])if(r.supersededReceiptIds!==undefined&&(!r.draftId||!Array.isArray(r.supersededReceiptIds)||r.supersededReceiptIds.length>12||new Set(r.supersededReceiptIds).size!==r.supersededReceiptIds.length||r.supersededReceiptIds.some(id=>typeof id!=='string'||!id||id.length>128||id===r.draftId)))throw Error('阅读记录原答继起编号无效');
  for(const m of v.memories)if(m.kind==='context'&&(!requireMemoryText(m).trim()||requireMemoryText(m).length>1000||!m.readingStage?.length&&m.source!=='correction'))throw new Error('阅读简报记录无效');
  for (const m of v.memories) if ([m.correctionOf, m.replacedBy, m.invalidatedBy].some(x => x !== undefined && (typeof x !== 'string' || !x)) || (['correction','review'].includes(m.source) && !m.correctionOf)) throw new Error('备份的更正记录无效');
  for(const m of v.memories)if(m.backgroundOrigin!==undefined){
    if(m.backgroundOrigin!==true||!['review','correction'].includes(m.source))throw new Error('独立阅读来源标记无效');
    const seen=new Set<string>();let previous=v.memories.find(p=>p.id===m.correctionOf);
    while(previous&&previous.source!=='background'&&!seen.has(previous.id)&&['review','correction'].includes(previous.source)){
      seen.add(previous.id);previous=v.memories.find(p=>p.id===previous!.correctionOf);
    }
    if(!previous||previous.source!=='background'||!sameDocumentOwner(previous,m))throw new Error('独立阅读来源标记无效');
  }
  reconcileMemoryOrigins(v);
  for (const m of v.memories) if (m.answersPartOf !== undefined) {
    const question = v.memories.find(q=>q.id===m.answersPartOf);
    if (typeof m.answersPartOf !== 'string' || !question || question.kind !== 'question' || !['story','opinion'].includes(m.kind) ||
      !sameDocumentOwner(question,m) || !m.parents.includes(question.id) ||
      question.evidence.some(r=>!covers(m.evidence,r))) throw new Error('部分答案的疑问关联无效');
  }
  for (const m of v.memories) if (m.revisionKind !== undefined || m.revisionReason !== undefined) {
    const previous = v.memories.find(p => p.id === m.correctionOf);
    const brief=previous?.kind==='context'&&m.kind==='context';
    const userRequest=previous?.kind==='user'&&m.kind==='user'&&m.source==='conversation'&&previous.source==='conversation';
    if (m.revisionKind !== 'development' || typeof m.revisionReason !== 'string' || !m.revisionReason.trim() || m.revisionReason.length > 240 ||
      !previous || !brief&&!userRequest&&(!['opinion','question'].includes(previous.kind) || !['story','opinion','question'].includes(m.kind)) ||
      (m.source === 'background' ? !isBackgroundMemory(previous) : isBackgroundMemory(previous)||!['preparation','reading','conversation'].includes(m.source) || !(brief?['preparation','reading','conversation','correction','review']:['preparation','reading','conversation','review']).includes(previous.source))) throw new Error('理解更新记录无效');
  }
  for (const m of v.memories) if (m.source === 'review'
    ? !['story','context','opinion','question','stage','state','arc'].includes(m.kind) || v.memories.find(p=>p.id===m.correctionOf)?.kind!==m.kind || m.answersPartOf!==undefined&&m.answersPartOf!==v.memories.find(p=>p.id===m.correctionOf)?.answersPartOf || ['opinion','question'].includes(m.kind)&&v.memories.find(p=>p.id===m.correctionOf)?.text!==m.text || m.kind==='context'&&requireMemoryText(m).length>1000 || !['supported','unsupported'].includes(m.reviewDisposition!) || typeof m.reviewReason !== 'string' || !m.reviewReason.trim() || m.reviewReason.length > 600 || !m.evidence.length
    : m.reviewDisposition !== undefined || m.reviewReason !== undefined) throw new Error('事实核对记录无效');
  for (const m of v.memories) for (const ref of [m.correctionOf, m.replacedBy, m.invalidatedBy].filter(Boolean)) {
    const linked = v.memories.find(x => x.id === ref);
    const transcript = ref === m.invalidatedBy && v.transcriptRevisions?.some(r => r.id === ref && r.bookId === m.bookId);
    const habit = ref === m.invalidatedBy && v.habits?.some(h=>h.id===ref&&h.partnerId===m.partnerId);
    if (!transcript && !habit && (!linked || !sameDocumentOwner(linked,m) || linked.id === m.id)) throw new Error('备份的更正关联无效');
  }
  for (const c of v.chats) if (!c || !ids.has(c.bookId) || typeof c.text !== 'string' || !Array.isArray(c.evidence) || !['user', 'assistant'].includes(c.role) || typeof c.excluded !== 'boolean' || typeof c.sessionId !== 'string' || (c.futureGrant !== undefined && typeof c.futureGrant !== 'string')) throw new Error('备份的聊天记录无效');
  for (const item of [...v.memories, ...v.chats]) {
    if(item.habitIds!==undefined&&(!strings(item.habitIds)||item.habitIds.length>2||item.habitIds.some(id=>!v.habits?.some(h=>h.id===id))))throw new Error('相处习惯引用无效');
    const book = v.books.find(b => b.id === item.bookId)!;
    for (const r of item.evidence) if (!r || r.bookId !== book.id || !bookVersionAllowsRange(book,r.version,r) || !Number.isSafeInteger(r.start) || !Number.isSafeInteger(r.end) || r.start < 0 || r.end <= r.start || r.end > book.text.length) throw new Error('资料引用与原文不符');
    if (item.webSources !== undefined) {
      if (!Array.isArray(item.webSources) || item.webSources.length > 10) throw new Error('联网来源记录无效');
      for (const ref of item.webSources) { if (typeof ref.title !== 'string' || ref.read !== undefined && typeof ref.read !== 'boolean') throw new Error('联网来源记录无效'); publicWebUrl(ref.url); }
    }
  }
  await validateParagraphChats(v);
  for (const c of v.chats) if (c.partnerId !== undefined && !v.partners.some(p => p.id === c.partnerId)) throw new Error('聊天所属伙伴无效');
  for(const c of v.chats)if(c.recoveredFrom){
    const r=c.recoveredFrom,u=v.usage.find(item=>item.id===r.requestId),task=u?.requestKey&&ordinaryReadingTask(u.requestKey);
    if(c.role!=='assistant'||!u||u.status!=='complete'||u.dispatchState!=='response-received'||!task||task.bookId!==c.bookId||task.partnerId!==c.partnerId||r.sourceTime!==u.time||c.createdAt!==r.sourceTime||!Number.isFinite(r.recoveredAt)||r.recoveredAt<r.sourceTime)throw Error('补存表达缺少原答身份或原始时间');
  }
  for (const c of v.chats) if ((c.delivery !== undefined && !['pending','failed','answered','stopped'].includes(c.delivery)) || (c.longReply !== undefined && typeof c.longReply !== 'boolean') || (c.expansionOffered !== undefined && (typeof c.expansionOffered !== 'boolean' || c.role !== 'assistant')) || (c.expansionOf !== undefined && (typeof c.expansionOf !== 'string' || c.role !== 'user')) || (c.replyTo !== undefined && typeof c.replyTo !== 'string')) throw new Error('问题处理记录无效');
  for(const c of v.chats)if(c.readingReaction!==undefined){
    const r=c.readingReaction,b=v.books.find(b=>b.id===c.bookId)!;
    if(!r||typeof r!=='object'||Object.keys(r).some(k=>!['requestKey','raw','status','reason','usageId','attempts'].includes(k))||typeof r.requestKey!=='string'||r.requestKey.length>12000||typeof r.raw!=='string'||r.raw.length>20000||!['saved','delivered','suppressed'].includes(r.status)||c.role!=='assistant'||c.futureGrant||readingReactionPayload(r.raw,true)!==c.text||c.id!=='reading-reaction:'+await hashText(r.requestKey)||r.status==='saved'&&(!c.excluded||c.delivery!=='pending')||r.status==='suppressed'&&(!c.excluded||c.delivery!=='stopped')||r.status==='delivered'&&c.delivery!=='answered')throw Error('提前阅读反应的原文载体或交付状态无效');
    if(r.reason!==undefined&&typeof r.reason!=='string'||r.usageId!==undefined&&typeof r.usageId!=='string'||r.attempts!==undefined&&(!Array.isArray(r.attempts)||r.attempts.some(a=>!a||typeof a.raw!=='string'||readingReactionPayload(a.raw,true)===undefined||!['saved','delivered','suppressed'].includes(a.status)||a.reason!==undefined&&typeof a.reason!=='string'||a.usageId!==undefined&&typeof a.usageId!=='string')))throw Error('反应尝试的原文与状态无效');
    const task=ordinaryReadingTask(r.requestKey);
    if(!task||task.kind!==undefined&&task.kind!=='scene'||task.bookId!==b.id||!bookVersionAllowsRanges(b,task.version,task.ranges)||task.partnerId!==c.partnerId||task.source!=='reading'||!task.ranges.length||task.ranges.some(range=>range.end>b.text.length||!covers(c.evidence,range)))throw Error('提前阅读反应与本书任务来源不符');
  }
  for(const c of v.chats)if(c.memoryAllowed!==undefined&&c.memoryAllowed!==false)throw Error('交流的后续资料采用权限无效');
  for(const c of v.chats)if(c.answerScope!==undefined&&!['overview','focused'].includes(c.answerScope))throw Error('问题的答复范围无效');
  for (const m of v.memories) if (m.sourceEvidence !== undefined) {
    const book = v.books.find(b => b.id === m.bookId)!;
    if (!Array.isArray(m.sourceEvidence) || !m.sourceEvidence.length ||
      m.sourceEvidence.some(r => !r || r.bookId !== book.id || !bookVersionAllowsRange(book,r.version,r) ||
        !Number.isSafeInteger(r.start) || !Number.isSafeInteger(r.end) || r.start < 0 || r.end <= r.start || r.end > book.text.length ||
        !covers(m.evidence, r))) throw new Error('记忆原文依据超出记录的使用范围');
  }
  for (const m of v.memories) if (m.sourceQuote !== undefined) {
    const q = m.sourceQuote, r = q?.evidence, book = v.books.find(b => b.id === m.bookId)!;
    if (!q || typeof q.text !== 'string' || q.text.length < 8 || q.text.length > 200 || !r || r.bookId !== book.id || !bookVersionAllowsRange(book,r.version,r) ||
      !Number.isSafeInteger(r.start) || !Number.isSafeInteger(r.end) || !m.evidence.some(e => e.start <= r.start && e.end >= r.end) ||
      q.text !== book.text.slice(r.start, r.end)) throw new Error('记忆短引与原文不符');
  }
  for(const m of v.memories)validateDocumentLifecycle(m,v.memories);
  for(const m of v.memories)if(m.documentRevision!==undefined)validateDocumentRevision(m,v.memories.find(p=>p.id===m.documentRevision!.previousId),v.books.find(b=>b.id===m.bookId)!);
  for(const m of v.memories)validateMergedMemoryLineage(m,v.memories);
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
  for (const c of v.conversations) if (c.partnerId!==undefined&&!v.partners.some(p=>p.id===c.partnerId)||!ids.has(c.bookId) || typeof c.title !== 'string' || typeof c.manualTitle !== 'boolean' || !Number.isSafeInteger(c.start) || !Number.isSafeInteger(c.end) || c.start < 0 || c.end < c.start || c.end > v.books.find(b => b.id === c.bookId)!.text.length) throw new Error('对话索引无效');
  for (const f of v.forgotten) if (!f || typeof f.id !== 'string' || typeof f.bookId !== 'string' || typeof f.text !== 'string' || (f.chatIds !== undefined && !strings(f.chatIds))) throw new Error('忘记记录无效');
  for (const u of v.usage) if (!u || typeof u.id !== 'string' || !Number.isFinite(u.input) || !Number.isFinite(u.output) || u.input < 0 || u.output < 0) throw new Error('备份的用量记录无效');
  for (const u of v.usage) if (u.taskId !== undefined && (typeof u.taskId !== 'string' || !u.taskId)) throw new Error('用量的任务关联无效');
  for(const u of v.usage)if(u.readingTaskFailure&&(u.readingTaskFailure.role!=='scene'||typeof u.readingTaskFailure.reason!=='string'||!u.requestKey||u.dispatchState==='not-dispatched'))throw Error('现场任务失败的原调用身份无效');
  for (const u of v.usage) if (u.reviewMemoryId !== undefined && (typeof u.reviewMemoryId!=='string'||!u.reviewMemoryId||!v.tasks?.some(t=>t.id===u.taskId&&t.items.some(i=>i.memoryId===u.reviewMemoryId)))) throw Error('用量的复核条目关联无效');
  for (const u of v.usage) if (u.dispatchState !== undefined && !['not-dispatched','dispatch-started','response-received'].includes(u.dispatchState) || u.requestKey !== undefined && (typeof u.requestKey !== 'string' || !u.requestKey)) throw new Error('用量的派发关联无效');
  validateReviewTasks(v);
  validateNarrativeState(v);
  validateStageStateMemories(v);validateArcMemories(v);validateWorldState(v);validateSemanticState(v);
  if(transfer)await validatePortableMaterials(v,recoveryStore);
  validateReadingDrafts(v);
  validateQueryCheckpoints(v);
  validateCompanionWorkspaces(v);
  validateCorrectionRepairs(v);
  validateCompanionReadingReceipts(v);
  validatePublishedViews(v);
  validateMaintenanceDispatchHeaders(v);if(!transfer)for(const usage of v.usage)if(usage.maintenanceDispatch)await validateMaintenanceDispatch(v,usage,false);
  validateAgentSessionHeaders(v);validateAgentResponses(v);
  for(const view of v.publishedViews??[])for(const source of view.memorySources){const memory=v.memories.find(m=>m.id===source.id)!;if(memoryContentIdentity(memory).hash!==source.hash)throw Error('派生视图认识来源版本与备份不符');}
  for(const view of v.publishedViews??[])for(const source of view.originalSources){const book=v.books.find(b=>b.id===view.bookId)!;if(await hashText(book.text.slice(source.evidence.start,source.evidence.end))!==source.hash)throw Error('派生视图原文来源身份与备份不符');}
  for (const u of v.usage) if ((u.cost !== undefined && (!Number.isFinite(u.cost) || u.cost < 0)) || (u.costBudgetId !== undefined && typeof u.costBudgetId !== 'string') || (u.pricing !== undefined && (u.pricing.currency !== 'CNY' || !Number.isFinite(u.pricing.input) || u.pricing.input < 0 || !Number.isFinite(u.pricing.output) || u.pricing.output < 0))) throw new Error('备份的费用记录无效');
  if (!Number.isFinite(v.settings.tokenLimit) || v.settings.tokenLimit < 0) throw new Error('备份的用量上限无效');
  if(v.settings.language!==undefined&&!['zh-CN','en'].includes(v.settings.language))throw Error('备份的语言设置无效');
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
  if(current.entityRoots?.length)v.entityRoots=[...new Map([...(v.entityRoots??[]),...current.entityRoots.filter(r=>v.books.some(b=>b.id===r.bookId&&bookVersionPrefixLength(b,r.version)!==undefined)&&v.partners.some(p=>p.id===r.partnerId)&&v.memories.some(m=>m.id===r.originMemoryId))].map(r=>[r.id,r])).values()];
  for (const c of v.chats) { const local = current.chats.find(x => x.id === c.id && x.bookId === c.bookId); if (local?.outdatedBy) c.outdatedBy = local.outdatedBy; }
  // A restored snapshot cannot reactivate superseded or forgotten local habits.
  const localHabits=(current.habits??[]).filter(h=>v.partners.some(p=>p.id===h.partnerId));
  const localKeys=new Set(localHabits.map(h=>h.partnerId+'\0'+h.key));
  v.habits=[...new Map([...(v.habits??[]).map(h=>localKeys.has(h.partnerId+'\0'+h.key)&&!localHabits.some(l=>l.id===h.id)?{...h,forgotten:true}:h),...localHabits.map(h=>({...h,sourceBookId:h.sourceBookId&&ids.has(h.sourceBookId)?h.sourceBookId:undefined,sourceChatId:h.sourceBookId&&ids.has(h.sourceBookId)?h.sourceChatId:undefined}))].map(h=>[h.id,h])).values()];
  v.usage=await mergeUsageOperationReceipts(v.usage,current.usage,recoveryStore);
  await mergeAgentSessions(v,current,recoveryStore);
  await mergeQueryCheckpoints(v,current);validateQueryCheckpoints(v);
  mergeCompanionWorkspaces(v,current);
  mergeMaintenanceRecovery(v,current);
  mergePartnerPersonas(v,current);
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
  const localTasks = (current.tasks ?? []).filter(t => v.books.some(b => b.id === t.bookId && bookVersionPrefixLength(b,t.version)!==undefined) && v.partners.some(p => p.id === t.partnerId));
  const tasks=new Map((v.tasks??[]).map(t=>[t.id,t]));
  for(const local of structuredClone(localTasks)){const incoming=tasks.get(local.id);if(incoming&&['complete','cancelled'].includes(incoming.status)&&['running','interrupted'].includes(local.status))continue;tasks.set(local.id,local);}v.tasks=[...tasks.values()];
  // A scene judgment and its candidates are one saved result. Preserve its
  // real local delivery responsibility while importing an older archive.
  const sceneRecords=(current.readings??[]).filter(r=>r.sceneJudgment&&r.draftId&&v.books.some(b=>b.id===r.bookId&&bookVersionPrefixLength(b,r.version)!==undefined)&&v.partners.some(p=>p.id===r.partnerId));
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
  const localDrafts=(current.readingDrafts??[]).filter(d=>v.books.some(b=>b.id===d.bookId&&bookVersionPrefixLength(b,d.version)!==undefined)&&v.partners.some(p=>p.id===d.partnerId));
  if(v.readingDrafts||localDrafts.length){
    v.readingDrafts=[...new Map([...(v.readingDrafts??[]),...structuredClone(localDrafts)].map(d=>[d.id,d])).values()];
    await prepareMemoryRecovery(v,recoveryStore);
    v.readingDrafts=v.readingDrafts.filter(d=>(!completedDrafts.has(d.id)||d.material?.taskRole==='scene'&&readingDraftUsable(v,d)||d.materialRef&&sceneRecords.some(r=>r.draftId===d.id)&&localSceneChats.some(c=>c.publication?.scene?.usageId===d.id&&['deferred','save-failed'].includes(c.publication.status)))&&!maintenanceTaskCommitted(v,d));
    validateReadingDrafts(v);pruneReadingDrafts(v);
  }
  // Receipt merging immediately checks usability. Prepare its finite legacy
  // dependencies before that check, using detached receipt copies.
  const localReceiptCopies=structuredClone((current.companionReadingReceipts ?? []).filter(receipt => v.books.some(book => book.id === receipt.bookId && bookVersionPrefixLength(book,receipt.version)!==undefined) && v.partners.some(partner => partner.id === receipt.partnerId)));
  const receiptRecovery = { ...v, companionReadingReceipts: [...(v.companionReadingReceipts ?? []), ...localReceiptCopies] };
  await prepareMemoryRecovery(receiptRecovery,recoveryStore);
  mergeCompanionReadingReceipts(v,{...current,companionReadingReceipts:localReceiptCopies});
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
  mergeConversationContinuity(v,current);
  recoverInterruptedState(v);
  validateAgentSessionHeaders(v);validateAgentResponses(v);
  validatePublishedViews(v);validateMaintenanceDispatchHeaders(v);
  validateStageStateMemories(v);validateArcMemories(v);validateWorldState(v);validateSemanticState(v);
  for(const book of v.books)for(const partner of v.partners)for(const source of ['reading','background'] as const)currentStates({...v,partnerId:partner.id},book,{source});
  return v;
}
