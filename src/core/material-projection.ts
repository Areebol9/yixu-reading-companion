import {isWorkspaceVersion,canonicalMaintenanceViewTargets} from './types.ts';
import {bookTextSlice,mergeRanges,normalize} from './books.ts';
import {chatAllowsMemory,isBackgroundMemory,isCurrentUnderstanding,isEvidenceAllowed,memoryIsForgotten,memorySources,sceneNearbyReadings} from './context.ts';
import {chatBelongsToPartner} from './discussion-recall.ts';
import {knowledgeMaintenanceMatch} from './knowledge-distribution.ts';
import {coreViewHeads,currentPublishedViews,viewAllowed} from './published-views.ts';
import type {Book,Chat,Memory,PublishedView,Range,ReadingDraftMaterial,ReadingRecord,State} from './types.ts';

export type CompanionInitialMaterialOptions={ranges:Range[];extra?:Range[];query?:string;conversationId?:string;role?:'scene'|'maintenance';views?:PublishedView[];requiredMemoryIds?:string[];requiredChatIds?:string[]};
const overlaps=(ranges:readonly Range[],focus:readonly Range[])=>ranges.some(r=>focus.some(f=>r.start<f.end&&f.start<r.end));
const literalMatch=(text:string,cue:string)=>{const needle=normalize(cue);return needle.length>=2&&normalize(text).includes(needle);};
/** Preserve the saved speaker, reply relationship and publication form. A
 * paragraph record carries no claim that the reader has opened or seen it. */
export function conversationMaterial(c:Chat){return{id:c.id,role:c.role,text:c.text,...(c.replyTo?{replyTo:c.replyTo}:{}),...(c.delivery?{delivery:c.delivery}:{}),...(c.presentation==='paragraph'?{presentation:c.presentation,anchor:c.anchor,paragraphCommentId:c.paragraphCommentId,sharedChatId:c.sharedChatId,readerInteraction:c.readerInteraction}: {})};}
/** Local navigation chooses candidates; bodies still pass the ordinary complete
 * document reader before joining the supplier packet or its source set. */
export function selectCompanionInitialMaterials(state:State,book:Book,options:CompanionInitialMaterialOptions){
  // This turn's explicit temporary grant is a local fence, never a persistent
  // reading-progress change. Every initial source uses the same scoped book.
  if(options.extra?.length)book={...book,known:mergeRanges([...book.known,...options.extra])};
  const role=options.role??'scene',originalRanges=mergeRanges(options.ranges);
  if(originalRanges.length&&!isEvidenceAllowed(book,originalRanges.map(r=>({...r,bookId:book.id,version:book.version}))))throw Error('首包现场材料超出实际阅读许可');
  const nearbyRanges=role==='scene'?sceneNearbyReadings(book,originalRanges):[],query=options.query??'';
  const text=[query,...originalRanges.map(r=>bookTextSlice(book,r.start,r.end))].join('\n');
  const requiredMemories=new Set(options.requiredMemoryIds??[]),requiredChats=new Set(options.requiredChatIds??[]);
  const eligibleChats=state.chats.filter(c=>c.bookId===book.id&&chatBelongsToPartner(state,c)&&chatAllowsMemory(state,c)&&!c.excluded&&(!c.publication||c.publication.status==='published')&&!c.outdatedBy&&!c.replacedBy&&!c.futureGrant&&isEvidenceAllowed(book,c.evidence)&&c.text!==query);
  const chatScore=(c:Chat)=>Number(requiredChats.has(c.id))*100+Number(!!c.anchor&&c.anchor.version===book.version&&overlaps([c.anchor],originalRanges))*20+Number(overlaps(c.formationRanges??[],originalRanges))*10;
  const relatedChats=eligibleChats.filter(c=>chatScore(c)>0).sort((a,b)=>chatScore(b)-chatScore(a)||b.createdAt-a.createdAt);
  // Explicit questions retain their immediate exchange. A reading scene also
  // needs the latest completed pair even when ordinary Q&A has no text anchor.
  if(query&&options.conversationId)for(const c of eligibleChats.filter(c=>c.presentation!=='paragraph'&&c.sessionId===options.conversationId).slice(-2))if(!relatedChats.includes(c))relatedChats.push(c);
  let recentPair:Chat[]=[];
  if(role==='scene'&&!query&&options.conversationId&&state.conversations.some(c=>c.id===options.conversationId&&c.bookId===book.id&&c.kind==='reading')){
    for(const answer of [...eligibleChats].reverse().sort((a,b)=>b.createdAt-a.createdAt)){
      if(answer.sessionId!==options.conversationId||answer.role!=='assistant'||answer.readingReaction||answer.delivery&&answer.delivery!=='answered'||!answer.text.trim())continue;
      const question=eligibleChats.find(c=>c.id===answer.replyTo&&c.role==='user'&&c.sessionId===options.conversationId&&c.delivery==='answered'&&c.text.trim());
      if(question){recentPair=[question,answer];break;}
    }
  }
  const chats:Chat[]=[];let chatChars=0;
  const addChat=(c:Chat,required=false)=>{if(chats.includes(c))return;if(required||chats.length<4&&chatChars+c.text.length<=6000){chats.push(c);chatChars+=c.text.length;}};
  // Explicit source obligations retain first claim on the existing allowance.
  for(const c of relatedChats.filter(c=>requiredChats.has(c.id))){addChat(c,true);const parent=eligibleChats.find(p=>p.id===c.replyTo);if(parent)addChat(parent,true);}
  const recentAdditions=recentPair.filter(c=>!chats.includes(c));
  if(chats.length+recentAdditions.length<=4&&chatChars+recentAdditions.reduce((n,c)=>n+c.text.length,0)<=6000)for(const c of recentAdditions)addChat(c);
  for(const c of relatedChats){addChat(c,requiredChats.has(c.id));const parent=eligibleChats.find(p=>p.id===c.replyTo);if(parent)addChat(parent,requiredChats.has(c.id));}
  chats.sort((a,b)=>a.createdAt-b.createdAt);const chatIds=new Set(chats.map(c=>c.id));
  const permitted=currentPublishedViews(state,book),requested=options.views?new Set(options.views.map(v=>v.id)):undefined;
  const pool=permitted.filter(v=>!requested||requested.has(v.id));
  const viewScore=(v:PublishedView)=>Number(overlaps(v.ranges,originalRanges))*12+Number(v.chatIds.some(id=>chatIds.has(id)))*16+Number(!!v.adoptedMemorySources?.some(s=>requiredMemories.has(s.id)))*20+Number(literalMatch(text,v.key))*8;
  const ranked=pool.filter(v=>viewScore(v)>0).sort((a,b)=>viewScore(b)-viewScore(a)||b.createdAt-a.createdAt);
  const coreIds=new Set(coreViewHeads(state,book).map(view=>view.id)),views:PublishedView[]=pool.filter(view=>coreIds.has(view.id));
  for(const view of ranked)if(!views.includes(view)&&views.length<(role==='scene'?3:8))views.push(view);
  const versions=new Map(state.memories.map(m=>[m.id,m]));
  const candidates=state.memories.filter(m=>m.bookId===book.id&&m.partnerId===state.partnerId&&isCurrentUnderstanding(m,versions.get(m.replacedBy??''),book)&&isBackgroundMemory(m)===false&&!['context','stage','state','arc'].includes(m.kind)&&isEvidenceAllowed(book,m.evidence)&&!memoryIsForgotten(state,m));
  const memoryScore=(m:Memory)=>Number(requiredMemories.has(m.id))*100+Number(overlaps(memorySources(m),originalRanges))*24+Number(m.chatIds.some(id=>chatIds.has(id)))*20+Number(!!knowledgeMaintenanceMatch(m.knowledgeDistribution,text))*12+(m.navigationCues??[]).filter(cue=>literalMatch(text,cue)).length*8+Number(!!m.documentTitle&&literalMatch(text,m.documentTitle))*8;
  const related=candidates.filter(m=>memoryScore(m)>0).sort((a,b)=>memoryScore(b)-memoryScore(a)||b.createdAt-a.createdAt||a.id.localeCompare(b.id));
  const limit=role==='scene'?2:6,memoryIds=role==='scene'?[]:related.slice(0,limit).map(m=>m.id),remainingMemoryIds=related.filter(m=>!memoryIds.includes(m.id)).map(m=>m.id),unavailableMemoryIds=[...requiredMemories].filter(id=>!candidates.some(m=>m.id===id));
  return{originalRanges,nearbyRanges,views,chats,memoryIds,remainingMemoryIds,unavailableMemoryIds,omitted:{views:pool.length-views.length,chats:eligibleChats.length-chats.length,relatedDocuments:remainingMemoryIds.length},notice:'首包按当前获准片段与明确关联选择，未选资料仍可按需发现、成组取完整正文或回查原文；省略不表示资料不存在或理解已完成。首包已有依据时可直接提交有效终态，不必先发现目录再重读。'};
}

/** A saved scene judgment is a partner observation at its formation range. Its
 * source closure remains subject to the same withdrawal and permission rules. */
export function sceneRecordAllowed(state:State,book:Book,record:ReadingRecord):boolean{
  const insight=record.sceneInsight;
  if(record.bookId!==book.id||record.version!==book.version||record.partnerId!==state.partnerId||!insight||typeof insight.text!=='string'||!insight.text.trim()||!Array.isArray(insight.evidence)||!insight.evidence.length||!Array.isArray(insight.memoryIds)||!Array.isArray(insight.chatIds)||insight.viewIds!==undefined&&!Array.isArray(insight.viewIds))return false;
  if(insight.evidence.some(e=>!Number.isSafeInteger(e.start)||!Number.isSafeInteger(e.end)||e.start<0||e.end<=e.start)||!isEvidenceAllowed(book,insight.evidence)||state.forgotten.some(f=>f.bookId===book.id&&!!normalize(f.text)&&normalize(insight.text).includes(normalize(f.text))))return false;
  const checked=new Set<string>(),checking=new Set<string>();
  function allowedChat(id:string):boolean{
    const key='chat:'+id;if(checked.has(key)||checking.has(key))return true;
    const c=state.chats.find(c=>c.id===id);
    if(!c||c.bookId!==book.id||!chatBelongsToPartner(state,c)||!chatAllowsMemory(state,c)||c.excluded||c.outdatedBy||c.replacedBy||c.futureGrant||!isEvidenceAllowed(book,c.evidence))return false;
    checking.add(key);
    const dependencies=[...(c.contextChatIds??[]),...(c.basis?.chatIds??[]),...(c.replyTo?[c.replyTo]:[]),...(c.paragraphCommentId?[c.paragraphCommentId]:[])];
    const valid=[...new Set(dependencies)].every(allowedChat)&&[...new Set([...(c.memoryIds??[]),...(c.basis?.memoryIds??[])])].every(allowedMemory);
    checking.delete(key);if(valid)checked.add(key);return valid;
  }
  function allowedMemory(id:string):boolean{
    const key='memory:'+id;if(checked.has(key)||checking.has(key))return true;
    const m=state.memories.find(m=>m.id===id),next=state.memories.find(n=>n.id===m?.replacedBy);
    if(!m||m.bookId!==book.id||m.partnerId!==state.partnerId||memoryIsForgotten(state,m)||m.invalidatedBy||m.reviewDisposition==='unsupported'||m.replacedBy&&next?.revisionKind!=='development'||!isEvidenceAllowed(book,m.evidence))return false;
    checking.add(key);
    const valid=[...new Set([...m.parents,...(m.basis?.memoryIds??[])])].every(allowedMemory)&&[...new Set([...m.chatIds,...(m.basis?.chatIds??[])])].every(allowedChat);
    checking.delete(key);if(valid)checked.add(key);return valid;
  }
  return insight.memoryIds.every(allowedMemory)&&insight.chatIds.every(allowedChat)&&(insight.viewIds??[]).every(id=>{const view=state.publishedViews?.find(v=>v.id===id);return!!view&&viewAllowed(state,book,view);});
}

export function validateMaterialProjection(state:State,book:Pick<Book,'id'|'version'>,material:ReadingDraftMaterial,resolveSources=true):void{
  if(material.taskRole!==undefined&&!['scene','maintenance'].includes(material.taskRole))throw Error('任务供材职责无效');
  if(material.sceneCommentIds!==undefined&&(material.taskRole!=='scene'||!Array.isArray(material.sceneCommentIds)||!material.sceneCommentIds.length||new Set(material.sceneCommentIds).size!==material.sceneCommentIds.length||material.sceneCommentIds.some(id=>typeof id!=='string'||!id||!material.chatIds.includes(id))))throw Error('现场实际评论触发身份无效');
  if(material.sceneOrigin!==undefined){const o=material.sceneOrigin;if(material.taskRole!=='scene'||!o||typeof o.instanceId!=='string'||!o.instanceId||typeof o.sessionId!=='string'||!o.sessionId||!Number.isSafeInteger(o.generation)||o.generation<0||!Number.isSafeInteger(o.dialogueRevision)||o.dialogueRevision<0)throw Error('现场表达形成身份无效');}
  if(material.maintenanceViewTargets!==undefined&&(material.taskRole!=='maintenance'||!material.maintenanceJobId||!Array.isArray(material.maintenanceViewTargets)||JSON.stringify(material.maintenanceViewTargets)!==JSON.stringify(canonicalMaintenanceViewTargets(material.maintenanceViewTargets))||resolveSources&&material.maintenanceViewTargets.some(target=>target.startsWith('view:')&&!state.publishedViews?.some(view=>view.id===target.slice(5)&&view.bookId===book.id&&view.version===book.version&&view.partnerId===state.partnerId))))throw Error('维护派生视图目标无效');
  if(material.viewIds!==undefined&&(!Array.isArray(material.viewIds)||new Set(material.viewIds).size!==material.viewIds.length||material.viewIds.some(id=>typeof id!=='string'||!id||resolveSources&&!state.publishedViews?.some(v=>v.id===id&&v.bookId===book.id&&v.version===book.version&&v.partnerId===state.partnerId))))throw Error('任务派生视图身份无效');
  if(material.sceneRecordIds!==undefined&&(!Array.isArray(material.sceneRecordIds)||new Set(material.sceneRecordIds).size!==material.sceneRecordIds.length||material.sceneRecordIds.some(id=>typeof id!=='string'||!id||resolveSources&&!state.readings?.some(record=>{const source=state.books.find(b=>b.id===book.id&&b.version===book.version);return record.id===id&&!!source&&sceneRecordAllowed(state,source,record);}))))throw Error('任务现场成果来源无效');
  if(material.maintenanceReviewRanges!==undefined&&(material.taskRole!=='maintenance'||!Array.isArray(material.maintenanceReviewRanges)||JSON.stringify(material.maintenanceReviewRanges)!==JSON.stringify(mergeRanges(material.maintenanceReviewRanges))||material.maintenanceReviewRanges.some(r=>!Number.isSafeInteger(r.start)||!Number.isSafeInteger(r.end)||r.start<0||r.end<=r.start)))throw Error('概要补核范围身份无效');
  if(material.maintenanceReviewMemoryIds!==undefined&&(material.taskRole!=='maintenance'||!Array.isArray(material.maintenanceReviewMemoryIds)||new Set(material.maintenanceReviewMemoryIds).size!==material.maintenanceReviewMemoryIds.length||material.maintenanceReviewMemoryIds.some(id=>typeof id!=='string'||!id)))throw Error('概要补核完整认识身份无效');
  const w=material.workspaceSnapshot;
  if(w&&(w.bookId!==book.id||w.version!==book.version||w.partnerId!==state.partnerId||w.source!==material.workspaceSource||w.revision!==material.workspaceRevision||material.workspaceVersion!==undefined&&!isWorkspaceVersion(material.workspaceVersion,w.revision)||!Array.isArray(w.focusIds)||w.workingIds!==undefined&&!Array.isArray(w.workingIds)))throw Error('私人工作台形成快照无效');
}

/** One supplier projection for initial packets and subsequent tool pages. */
export function memoryMaterial(value:unknown,options:{full?:boolean;canUpdate?:boolean;already?:boolean}={}){
  const item=value as Record<string,any>;
  const navigation={id:item.id,kind:item.kind,documentTitle:item.documentTitle,navigationCues:Array.isArray(item.navigationCues)?item.navigationCues.slice(0,4).map((cue:string)=>cue.slice(0,80)):undefined,
    moreCues:Array.isArray(item.navigationCues)&&item.navigationCues.length>4||undefined,
    readingStage:Array.isArray(item.readingStage)?item.readingStage.slice(0,4):undefined,
    moreFormationRanges:Array.isArray(item.readingStage)&&item.readingStage.length>4||undefined,
    history:!!item.historicalOnly||!!item.replacedBy||!!item.history,
    currentAlreadyProvided:options.already||undefined};
  if(!options.full)return navigation;
  if(typeof item.text!=='string')throw Error('全文供材前正文尚未载入');
  return{...navigation,text:item.text,origin:item.source,canUpdate:options.canUpdate,knowledgeDistribution:item.knowledgeDistribution};
}
export function navigationPage(value:unknown,already:ReadonlySet<string>){
  const page=value as Record<string,any>;
  return{items:page.items.map((item:Record<string,any>)=>memoryMaterial(item,{already:already.has(item.id)})),
    total:page.total,nextCursor:page.nextCursor,remainingIds:page.remainingIds,unavailableIds:page.unavailableIds,
    hasMore:page.hasMore,mode:page.mode,selection:page.selection,order:page.order,
    notice:'目录仅用于取材。已提供的全文直接复用，其余按编号展开；本页未命中不证明不存在。'};
}
