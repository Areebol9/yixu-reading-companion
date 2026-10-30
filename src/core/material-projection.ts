import {isWorkspaceVersion,canonicalMaintenanceViewTargets} from './types.ts';
import {bookTextSlice,mergeRanges,normalize,covers} from './books.ts';
import {chatAllowsMemory,createChatMemoryChecker,isBackgroundMemory,isCurrentUnderstanding,isEvidenceAllowed,createEvidenceChecker,memoryIsForgotten,memorySources,sceneNearbyReadings} from './context.ts';
import {memoryReadableByPartner,sameDocumentOwner,viewReadableByPartner} from './book-document-ownership.ts';
import {chatBelongsToPartner} from './discussion-recall.ts';
import {knowledgeMaintenanceMatcher} from './knowledge-distribution.ts';
import {coreViewHeads,currentPublishedViews,viewAllowed} from './published-views.ts';
import {memoryContentIdentity,stampsEqual} from './memory-identity.ts';
import {hashText} from './text-hash.ts';
import {conversationAliasIndex,conversationBodyReferences} from './conversation-alias.ts';
import {decodeMaterialInput,materialEnvelopeParts} from './material-input.ts';
import {validateSceneOpportunity} from './scene-scheduling.ts';
import {resolveBookVersion,bookVersionPrefixLength,bookVersionAllowsRange,bookVersionAllowsRanges} from './book-versions.ts';
import type {Book,Chat,Memory,ModelMessage,PublishedView,Range,ReadingDraftMaterial,ReadingDraftRequest,ReadingRecord,State} from './types.ts';
import {formationSourceChecker} from './formation-sources.ts';

/** A domain version is not its dependency closure. Full means the verified
 * complete body; a preview or partial retrieval never authorizes a full-body
 * update. IDs identify the exact supplied version, never a mutable "latest". */
export type MaterialExposure={kind:'memory'|'view'|'original'|'chat';id:string;version:string;hash:string;mode:'full'|'partial'|'preview';ranges?:Range[];chars:number;change?:{previousId:string;previousHash:string}};
/** Emitted by the native request pipeline after final projection/spill, for
 * content actually sent in the frozen request. Saving a raw tool event alone
 * is not evidence that the model received that body. */
export type MaterialExposureReceipt={agentSessionId:string;agentCallId:string;requestId?:string;purpose?:string;toolCallId?:string;eventSeqs:number[];surfaceHash:string;materials?:MaterialExposure[]};
export type MaterialExposureCandidate={kind:MaterialExposure['kind'];id:string;version:string;text:string;labels:string[];range?:Range;bodyAliasIds?:readonly string[];documentChange?:import('./document-reading.ts').DocumentChangeMaterial};

/** The caller supplies this task's validated receipts, never the global ledger.
 * Compaction changes the visible surface, not which immutable bytes this task
 * actually received. Auxiliary summaries and previews confer no extra reads. */
export function taskMaterialExposures(receipts:readonly MaterialExposureReceipt[]|undefined,agentSessionId?:string):MaterialExposure[]{
  const records=(receipts??[]).filter(receipt=>receipt.purpose===undefined&&(agentSessionId===undefined||receipt.agentSessionId===agentSessionId)).flatMap(receipt=>receipt.materials??[]);
  return [...new Map(records.map(material=>[JSON.stringify([material.kind,material.id,material.version,material.mode,material.hash,material.ranges,material.change]),material])).values()];
}
/** Missing receipts grant nothing. Loaded local text is only the comparison
 * body; exact task receipts provide full or accumulated range authority. */
export function taskFullMemoryIds(memories:readonly Memory[],receipts:readonly MaterialExposureReceipt[]|undefined,agentSessionId?:string):Set<string>{
  return fullMemoryIdsFromMaterials(memories,taskMaterialExposures(receipts,agentSessionId));
}
function fullMemoryIdsFromMaterials(memories:readonly Memory[],materials:readonly MaterialExposure[]):Set<string>{
  return new Set(memories.filter(memory=>{const identity=memoryContentIdentity(memory),items=materials.filter(m=>m.kind==='memory'&&m.id===memory.id&&m.version===identity.hash&&m.mode!=='preview');if(items.some(m=>m.mode==='full'&&m.hash===identity.hash&&m.chars===identity.chars))return true;const ranges=mergeRanges(items.flatMap(m=>m.ranges??[]));return ranges.length===1&&ranges[0].start===0&&ranges[0].end===identity.chars;}).map(memory=>memory.id));
}
/** The last normal frozen request, not the union of all historic exposures. */
export function currentFullMemoryIds(memories:readonly Memory[],receipts:readonly MaterialExposureReceipt[]|undefined):Set<string>{
  if(receipts===undefined)return new Set(memories.map(memory=>memory.id));
  const latest=receipts.filter(receipt=>receipt.purpose===undefined).at(-1);
  return fullMemoryIdsFromMaterials(memories,latest?.materials??[]);
}
/** Empty task ranges consume a real maintenance claim, including a review of
 * already understood text. Review ranges remain bound to that claim and scope. */
export function isNonOriginalMaintenanceTask(state:State,book:Pick<Book,'id'|'version'>,request:ReadingDraftRequest,material:ReadingDraftMaterial):boolean{
  if(request.source!=='reading'||!Array.isArray(request.ranges)||request.ranges.length||!request.maintenanceJobId||!request.maintenanceClaim||material.taskRole!=='maintenance'||material.readingStrategy!=='companion'||material.maintenanceJobId!==request.maintenanceJobId)return false;
  const reviewRanges=material.maintenanceReviewRanges??[],source=resolveBookVersion(state.books.find(value=>value.id===book.id),book.version);
  if(!Array.isArray(reviewRanges)||reviewRanges.length&&(!source||reviewRanges.some(range=>!bookVersionAllowsRange(source,book.version,range)||!covers(source.known,range)||!covers(source.prepared,range))))return false;
  const key=JSON.stringify([book.id,book.version,state.partnerId,'reading',[],'maintenance',request.maintenanceJobId,request.maintenanceClaim]);
  return state.usage.some(usage=>{
    const dispatch=usage.maintenanceDispatch,claim=dispatch?.claim;
    return usage.requestKey===key&&!!dispatch&&!!claim&&dispatch.request.source===request.source&&dispatch.request.input===request.input&&Array.isArray(dispatch.request.ranges)&&!dispatch.request.ranges.length&&dispatch.request.maintenanceJobId===request.maintenanceJobId&&dispatch.request.maintenanceClaim===request.maintenanceClaim&&claim.hash===request.maintenanceClaim&&
      Array.isArray(claim.ranges)&&!claim.ranges.length&&Array.isArray(claim.viewReviewRanges??[])&&JSON.stringify(claim.viewReviewRanges??[])===JSON.stringify(reviewRanges)&&(!reviewRanges.length||claim.viewReviewVersion===1)&&Array.isArray(claim.chatIds)&&Array.isArray(claim.viewTargets)&&
      !!(reviewRanges.length||claim.chatIds.length||claim.sceneRecordIds?.length||claim.viewTargets.length)&&
      claim.chatIds.every(id=>material.chatIds?.includes(id))&&JSON.stringify(claim.sceneRecordIds??[])===JSON.stringify(material.sceneRecordIds??[])&&JSON.stringify(claim.viewTargets)===JSON.stringify(material.maintenanceViewTargets??[]);
  });
}
/** Reuse requires this exact version and its complete bytes on this surface. */
export async function currentFullViewIds(views:readonly PublishedView[],materials:readonly MaterialExposure[]|undefined):Promise<Set<string>>{
  const full=new Map((materials??[]).filter(material=>material.kind==='view'&&material.mode==='full').map(material=>[material.id,material]));
  const ids=await Promise.all(views.map(async view=>{const item=full.get(view.id);return item&&item.version===view.id&&item.chars===view.text.length&&item.hash===await hashText(view.text)?view.id:undefined;}));
  return new Set(ids.filter((id):id is string=>id!==undefined));
}

/** Keep each exchange's body once while retaining both independent uses. */
export function referenceProvidedConversation(messages:readonly ModelMessage[],items:ReturnType<typeof conversationMaterials>){
  const supplied=new Map<string,string>();
  const visit=(value:unknown,preview=false):void=>{if(typeof value==='string'){decodeMaterialInput(value).forEach(decoded=>visit(decoded,preview));return;}if(!value||typeof value!=='object')return;if(Array.isArray(value)){value.forEach(item=>visit(item,preview));return;}const item=value as Record<string,unknown>,navigation=preview||item.navigationOnly===true||item.bodyFormat==='preview',parts=materialEnvelopeParts(item);if(parts!==undefined){parts.forEach(part=>visit(part,navigation));return;}if(!navigation&&typeof item.id==='string'&&typeof item.text==='string')supplied.set(item.id,item.text);for(const[key,child]of Object.entries(item))visit(child,navigation||['paragraphHits','preview','excerpt','head','tail'].includes(key));};
  for(const message of messages)if(message.role==='user')visit(message.content);
  return items.map(item=>'text' in item&&supplied.get(item.id)===item.text?((({text,...rest})=>({...rest,bodyRefId:item.id,use:'maintenance-new'}))(item)):item);
}

export function conversationExposureCandidates(state:State,book:Book,ids:readonly string[],labels:readonly [string,string][]=[]):MaterialExposureCandidate[]{
  const aliases=conversationAliasIndex(state,book,ids);
  return [...new Set(ids)].flatMap(id=>{const chat=state.chats.find(chat=>chat.id===id);return chat?[{kind:'chat' as const,id,version:String(chat.createdAt),text:chat.text,labels:[id,...labels.filter(([actual])=>actual===id).map(([,label])=>label)],...(aliases.has(id)?{bodyAliasIds:[...aliases.get(id)!].filter(other=>other!==id)}:{})}]:[];});
}

/** Normal version development is readable history, but its conservative
 * ancestors still carry withdrawal, correction and forgetting. This walk is
 * local validation only and never expands those ancestors into model input. */
export function materialMemorySourceChecker(state:State,book:Book):(id:string)=>boolean{
  // This index/memo belongs only to one synchronous check, never to a later
  // mutation or request. Multiple supplied roots share the same ancestor walk.
  const memories=new Map<string,Memory>(),chats=new Map<string,Chat>(),passed=new Set<string>(),evidenceAllowed=createEvidenceChecker(book);
  for(const memory of state.memories)if(memory.bookId===book.id)memories.set(memory.id,memory);
  for(const chat of state.chats)if(chat.bookId===book.id)chats.set(chat.id,chat);
  const auditAllowed=formationSourceChecker(state,evidenceAllowed);
  return(id:string)=>{
    const root=memories.get(id);if(!root||!memoryReadableByPartner(state,root))return false;
    const seen=new Set<string>(),pending=[{kind:'memory',id}];
    while(pending.length){
      const next=pending.pop()!,key=next.kind+':'+next.id;if(seen.has(key)||passed.has(key))continue;seen.add(key);
      if(next.kind==='memory'){
        const memory=memories.get(next.id),successor=memory?.replacedBy?memories.get(memory.replacedBy):undefined;
        if(!memory||memory.bookId!==book.id||!state.partners.some(partner=>partner.id===memory.partnerId)||memory.forgotten||memory.invalidatedBy||memory.reviewDisposition==='unsupported'||memory.replacedBy&&(!successor||successor.revisionKind!=='development')||memoryIsForgotten(state,memory)||!evidenceAllowed(memory.evidence))return false;
        if(memory.formationSources){if(!auditAllowed(memory.formationSources))return false;continue;}
        for(const id of [...memory.parents,...(memory.basis?.memoryIds??[])])pending.push({kind:'memory',id});
        for(const id of [...memory.chatIds,...(memory.basis?.chatIds??[])])pending.push({kind:'chat',id});
      }else{
        const chat=chats.get(next.id);
        // Private provenance is verified locally under its recorded author; it
        // never enters the current partner's material merely through this walk.
        const owner=chat?.partnerId??state.partners.find(partner=>partner.legacyUnlabelled)?.id??(state.partners.length===1?state.partners[0].id:undefined);
        if(!chat||!owner||chat.bookId!==book.id||!chatBelongsToPartner({...state,partnerId:owner},chat)||!chatAllowsMemory(state,chat)||chat.excluded||chat.outdatedBy||chat.replacedBy||chat.futureGrant||!evidenceAllowed(chat.evidence))return false;
        for(const id of [...(chat.memoryIds??[]),...(chat.basis?.memoryIds??[])])pending.push({kind:'memory',id});
        for(const id of [...(chat.contextChatIds??[]),...(chat.basis?.chatIds??[]),...(chat.replyTo?[chat.replyTo]:[]),...(chat.paragraphCommentId?[chat.paragraphCommentId]:[])])pending.push({kind:'chat',id});
      }
    }
    for(const key of seen)passed.add(key);return true;
  };
}
export function materialMemorySourceAllowed(state:State,book:Book,id:string):boolean{return materialMemorySourceChecker(state,book)(id);}

/** Observe the native, frozen request without rewriting it. Nested tool JSON is
 * decoded for exact body comparison; assistant claims never certify exposure.
 * A navigation hit stays a preview even if a very short document fits in it. */
export async function observeMaterialExposures(messages:readonly ModelMessage[],candidates:readonly MaterialExposureCandidate[]):Promise<MaterialExposure[]>{
  const found=new Map<string,{candidate:MaterialExposureCandidate;mode:MaterialExposure['mode'];text:string;range?:Range}>();
  const changes=new Map<string,MaterialExposureCandidate>();
  const byLabel=new Map<string,MaterialExposureCandidate[]>();
  const aliases:{id:string;target:string}[]=[];
  for(const candidate of candidates)for(const label of candidate.labels)byLabel.set(label,[...(byLabel.get(label)??[]),candidate]);
  const add=(candidate:MaterialExposureCandidate,mode:MaterialExposure['mode'],text:string,range?:Range)=>{found.set(JSON.stringify([candidate.kind,candidate.id,candidate.version,mode,range]),{candidate,mode,text,range});};
  const visit=(value:unknown,parentId?:string,preview=false):void=>{
    if(typeof value==='string'){
      const decoded=decodeMaterialInput(value);
      if(decoded.length){for(const item of decoded)visit(item,parentId,preview);return;}
      // Serialized containers must be decoded before inspecting their leaves;
      // roles and preview fields inside them also govern original-text markers.
      if(/^[\s]*[\[{]/.test(value))return;
      for(const candidate of candidates)if(candidate.kind==='original')for(const label of candidate.labels){
        const marker='【'+label+'】',at=value.indexOf(marker);if(at<0)continue;
        const body=value.slice(at+marker.length);let length=0;while(length<candidate.text.length&&body[length]===candidate.text[length])length++;
        if(length&&length<candidate.text.length&&candidate.text.charCodeAt(length-1)>=0xd800&&candidate.text.charCodeAt(length-1)<=0xdbff)length--;
        if(length)add(candidate,preview?'preview':length===candidate.text.length?'full':'partial',candidate.text.slice(0,length),candidate.range?{start:candidate.range.start,end:candidate.range.start+length}:undefined);
      }
      return;
    }
    if(!value||typeof value!=='object')return;
    if(Array.isArray(value)){for(const item of value)visit(item,parentId,preview);return;}
    const item=value as Record<string,unknown>,id=typeof item.id==='string'?item.id:parentId,navigation=preview||item.navigationOnly===true||item.bodyFormat==='preview';
    if(id&&!navigation&&item.documentChange)for(const candidate of byLabel.get(id)??[]){const expected=candidate.documentChange;
      if(candidate.kind==='memory'&&expected&&candidate.id===expected.currentId&&candidate.version===expected.currentHash&&stampsEqual(JSON.stringify(item.documentChange),JSON.stringify(expected)))changes.set(candidate.id,candidate);
    }
    const parts=materialEnvelopeParts(item);if(parts!==undefined){for(const part of parts)visit(part,id,navigation);return;}
    if(id&&!navigation&&item.text===undefined&&typeof item.bodyRefId==='string')aliases.push({id,target:item.bodyRefId});
    if(id&&typeof item.text==='string')for(const candidate of byLabel.get(id)??[]){
      if(candidate.kind==='original')continue;
      if(item.text===candidate.text)add(candidate,navigation?'preview':'full',item.text);
      else if(item.text){
        const start=typeof item.start==='number'?item.start:candidate.text.indexOf(item.text),end=typeof item.end==='number'?item.end:start+item.text.length;
        if(start>=0&&end<=candidate.text.length&&candidate.text.slice(start,end)===item.text&&(typeof item.start==='number'||candidate.text.indexOf(item.text,start+1)<0))add(candidate,navigation?'preview':'partial',item.text,{start,end});
      }
    }
    for(const [key,child]of Object.entries(item))visit(child,id,navigation||['paragraphHits','preview','excerpt','head','tail'].includes(key));
  };
  for(const message of messages)if(message.role==='user'||message.role==='tool')visit(message.content);
  // The referenced complete body must survive in this exact surface. A saved
  // link, a pruned tool result, or an assistant-authored claim grants nothing.
  const direct=[...found.values()].filter(item=>item.mode==='full');
  for(const alias of aliases)for(const candidate of byLabel.get(alias.id)??[]){
    if(candidate.kind!=='chat')continue;
    const target=direct.find(item=>item.candidate.kind==='chat'&&item.candidate.labels.includes(alias.target)&&candidate.bodyAliasIds?.includes(item.candidate.id)&&item.candidate.text===candidate.text);
    if(target)add(candidate,'full',candidate.text);
  }
  return [...await Promise.all([...found.values()].map(async({candidate,mode,text,range})=>({kind:candidate.kind,id:candidate.id,version:candidate.version,hash:await hashText(text),mode,chars:text.length,...(range?{ranges:[range]}:{})}))),...[...changes.values()].map(candidate=>({kind:'memory' as const,id:candidate.id,version:candidate.version,hash:candidate.version,mode:'partial' as const,chars:0,change:{previousId:candidate.documentChange!.previousId,previousHash:candidate.documentChange!.previousHash}}))];
}

export type CompanionInitialMaterialOptions={ranges:Range[];extra?:Range[];query?:string;conversationId?:string;role?:'scene'|'maintenance';views?:PublishedView[];requiredMemoryIds?:string[];requiredChatIds?:string[];includeRecentChats?:boolean};
const overlaps=(ranges:readonly Range[],focus:readonly Range[])=>ranges.some(r=>focus.some(f=>r.start<f.end&&f.start<r.end));
/** Preserve the saved speaker, reply relationship and publication form. A
 * paragraph record carries no claim that the reader has opened or seen it. */
export function conversationMaterial(c:Chat){
  return{id:c.id,bookId:c.bookId,...(c.partnerId?{partnerId:c.partnerId}:{}),sessionId:c.sessionId,role:c.role,text:c.text,createdAt:c.createdAt,
    ...(c.formationRanges?{formationRanges:c.formationRanges}:{}),...(c.formedThrough!==undefined?{formedThrough:c.formedThrough}:{}),
    ...(c.replyTo?{replyTo:c.replyTo}:{}),...(c.delivery?{delivery:c.delivery}:{}),
    ...(c.publication?{publication:{status:c.publication.status,...(c.publication.destination?{destination:c.publication.destination}:{})}}:{}),
    ...(c.readingReaction?{readingReaction:{status:c.readingReaction.status}}:{}),...(c.presentationReceipt?{presentationReceipt:c.presentationReceipt}:{}),
    ...(c.expressionAnchor?{expressionAnchor:c.expressionAnchor}:{}),...(c.paragraphCommentId!==undefined?{paragraphCommentId:c.paragraphCommentId}:{}),...(c.sharedChatId!==undefined?{sharedChatId:c.sharedChatId}:{}),
    ...(c.presentation==='paragraph'?{presentation:c.presentation,...(c.anchor!==undefined?{anchor:c.anchor}:{}),...(c.readerInteraction!==undefined?{readerInteraction:c.readerInteraction}:{})}: {})};
}
export function conversationMaterials(state:State,book:Book,chats:readonly Chat[]){
  const references=conversationBodyReferences(state,book,chats);
  return chats.map(chat=>{const material=conversationMaterial(chat),bodyRefId=references.get(chat.id);if(!bodyRefId)return material;const{text,...identity}=material;return{...identity,bodyRefId};});
}
/** Local navigation chooses candidates; bodies still pass the ordinary complete
 * document reader before joining the supplier packet or its source set. */
export function selectCompanionInitialMaterials(state:State,book:Book,options:CompanionInitialMaterialOptions){
  // This turn's explicit temporary grant is a local fence, never a persistent
  // reading-progress change. Every initial source uses the same scoped book.
  if(options.extra?.length)book={...book,known:mergeRanges([...book.known,...options.extra])};
  const role=options.role??'scene',originalRanges=mergeRanges(options.ranges);
  // All selection below is synchronous: share these indexes only for this
  // preparation, then discard them before any state or permission can change.
  const evidenceAllowed=createEvidenceChecker(book),chatAllowed=createChatMemoryChecker(state);
  if(originalRanges.length&&!evidenceAllowed(originalRanges.map(r=>({...r,bookId:book.id,version:book.version}))))throw Error('首包现场材料超出实际阅读许可');
  const nearbyRanges=role==='scene'?sceneNearbyReadings(book,originalRanges):[],query=options.query??'';
  const text=[query,...originalRanges.map(r=>bookTextSlice(book,r.start,r.end))].join('\n');
  const normalizedText=normalize(text),literalMatches=new Map<string,boolean>(),matchKnowledge=knowledgeMaintenanceMatcher(text);
  const literalMatch=(cue:string)=>{const known=literalMatches.get(cue);if(known!==undefined)return known;const needle=normalize(cue),matched=needle.length>=2&&normalizedText.includes(needle);literalMatches.set(cue,matched);return matched;};
  const requiredMemories=new Set(options.requiredMemoryIds??[]),requiredChats=new Set(options.requiredChatIds??[]);
  const eligibleChats=state.chats.filter(c=>c.bookId===book.id&&chatBelongsToPartner(state,c)&&chatAllowed(c)&&!c.excluded&&c.delivery!=='pending'&&(!c.publication||c.publication.status==='published')&&(!c.readingReaction||c.readingReaction.status==='delivered')&&!c.outdatedBy&&!c.replacedBy&&!c.futureGrant&&evidenceAllowed(c.evidence)&&c.text.trim());
  const chatScore=(c:Chat)=>Number(requiredChats.has(c.id))*100+Number(!!c.anchor&&bookVersionAllowsRange(book,c.anchor.version,c.anchor)&&overlaps([c.anchor],originalRanges))*20+Number(overlaps(c.formationRanges??[],originalRanges))*10;
  const relatedChats=eligibleChats.filter(c=>chatScore(c)>0).sort((a,b)=>chatScore(b)-chatScore(a)||b.createdAt-a.createdAt);
  // Continue actual speech, including unprompted reactions and published
  // comments. A new reading session does not erase the same partner's recent
  // exchange in this book; neither coordinates nor a completed Q&A pair gate it.
  const recentChats=role==='scene'&&options.includeRecentChats!==false?[...eligibleChats].sort((a,b)=>Number(b.sessionId===options.conversationId)-Number(a.sessionId===options.conversationId)||b.createdAt-a.createdAt||b.id.localeCompare(a.id)):[];
  const aliases=conversationAliasIndex(state,book,eligibleChats.map(c=>c.id));
  const chats:Chat[]=[];let chatChars=0;
  const addChat=(c:Chat,required=false)=>{if(chats.includes(c))return;const cost=chats.some(selected=>aliases.get(c.id)?.has(selected.id))?0:c.text.length;if(required||chats.length<4&&chatChars+cost<=6000){chats.push(c);chatChars+=cost;}};
  // Explicit source obligations retain first claim on the existing allowance.
  for(const c of relatedChats.filter(c=>requiredChats.has(c.id))){addChat(c,true);const parent=eligibleChats.find(p=>p.id===c.replyTo);if(parent)addChat(parent,true);}
  for(const c of recentChats){addChat(c);if(chats.includes(c)){const parent=eligibleChats.find(p=>p.id===c.replyTo);if(parent)addChat(parent);}}
  for(const c of relatedChats){addChat(c,requiredChats.has(c.id));const parent=eligibleChats.find(p=>p.id===c.replyTo);if(parent)addChat(parent,requiredChats.has(c.id));}
  chats.sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id));const chatIds=new Set(chats.map(c=>c.id));
  const permitted=currentPublishedViews(state,book),requested=options.views?new Set(options.views.map(v=>v.id)):undefined;
  const pool=permitted.filter(v=>!requested||requested.has(v.id));
  const viewScore=(v:PublishedView)=>Number(overlaps(v.ranges,originalRanges))*12+Number(v.chatIds.some(id=>chatIds.has(id)))*16+Number(!!v.adoptedMemorySources?.some(s=>requiredMemories.has(s.id)))*20+Number(literalMatch(v.key))*8;
  const ranked=pool.filter(v=>viewScore(v)>0).sort((a,b)=>viewScore(b)-viewScore(a)||b.createdAt-a.createdAt);
  const coreIds=new Set(coreViewHeads(state,book).map(view=>view.id)),views:PublishedView[]=pool.filter(view=>coreIds.has(view.id));
  for(const view of ranked)if(!views.includes(view)&&views.length<(role==='scene'?3:8))views.push(view);
  const versions=new Map(state.memories.map(m=>[m.id,m]));
  const sourceAllowed=materialMemorySourceChecker(state,book);
  const candidates=state.memories.filter(m=>m.bookId===book.id&&memoryReadableByPartner(state,m)&&(isCurrentUnderstanding(m,versions.get(m.replacedBy??''),book)||requiredMemories.has(m.id)&&sourceAllowed(m.id))&&isBackgroundMemory(m)===false&&!['context','stage','state','arc'].includes(m.kind)&&evidenceAllowed(m.evidence)&&!memoryIsForgotten(state,m));
  const subjectScores=new Map<Memory,number>(),memoryScores=new Map<Memory,number>(),knowledgeMatches=new Map<Memory,boolean>();
  const knowledgeMatch=(m:Memory)=>{let matched=knowledgeMatches.get(m);if(matched===undefined){matched=!!matchKnowledge(m.knowledgeDistribution);knowledgeMatches.set(m,matched);}return matched;};
  const subjectScore=(m:Memory)=>{let score=subjectScores.get(m);if(score===undefined){score=(m.navigationCues??[]).filter(literalMatch).length+(m.organization?.topics??[]).filter(literalMatch).length+Number(!!m.documentTitle&&literalMatch(m.documentTitle))+Number(knowledgeMatch(m))+(m.organization?.subject?[m.organization.subject.title,...(m.organization.subject.aliases??[])].filter(literalMatch).length:0);subjectScores.set(m,score);}return score;};
  const memoryScore=(m:Memory)=>{let score=memoryScores.get(m);if(score===undefined){score=Number(requiredMemories.has(m.id))*100+Number(overlaps(memorySources(m),originalRanges))*24+Number(m.chatIds.some(id=>chatIds.has(id)))*20+Number(knowledgeMatch(m))*12+subjectScore(m)*8;memoryScores.set(m,score);}return score;};
  const candidateIds=new Set(candidates.map(m=>m.id)),direct=new Set(candidates.filter(m=>memoryScore(m)>0).map(m=>m.id)),linked=new Set<string>();
  const head=(id:string)=>{const seen=new Set<string>();let m=versions.get(id);while(m?.replacedBy&&!seen.has(m.id)){seen.add(m.id);const next=versions.get(m.replacedBy);if(!next||!sameDocumentOwner(m,next)||next.revisionKind!=='development')break;m=next;}return m&&candidateIds.has(m.id)?m.id:undefined;};
  // Explicit narrative links are a one-hop convenience, not the conservative
  // provenance closure and never a change to the original link's identity.
  for(const m of candidates)for(const link of m.organization?.related??[]){const target=head(link.id);if(!target)continue;if(direct.has(m.id))linked.add(target);if(direct.has(target))linked.add(m.id);}
  const score=(m:Memory)=>memoryScore(m)+(linked.has(m.id)?6:0),related=candidates.filter(m=>score(m)>0).sort((a,b)=>Number(requiredMemories.has(b.id))-Number(requiredMemories.has(a.id))||subjectScore(b)-subjectScore(a)||Number(linked.has(b.id)&&!!b.organization?.roles.some(r=>['stage','arc','topic'].includes(r)))-Number(linked.has(a.id)&&!!a.organization?.roles.some(r=>['stage','arc','topic'].includes(r)))||score(b)-score(a)||b.createdAt-a.createdAt||a.id.localeCompare(b.id));
  const limit=role==='scene'?2:6,required=candidates.filter(m=>requiredMemories.has(m.id));
  const preferred=related.filter(m=>!requiredMemories.has(m.id));
  const memoryIds=[...required,...preferred.slice(0,Math.max(0,limit-required.length))].map(m=>m.id),unavailableMemoryIds=[...requiredMemories].filter(id=>!candidates.some(m=>m.id===id));
  return{originalRanges,nearbyRanges,views,chats,memoryIds,unavailableMemoryIds,omitted:{views:pool.length-views.length,chats:eligibleChats.length-chats.length,relatedDocuments:related.length-memoryIds.length},notice:'首包按当前获准片段与明确关联选择，未选资料仍可在全部获准资料中搜索、分页发现、成组取完整正文或回查原文；省略不表示资料不存在或理解已完成。首包已有依据时可直接提交有效终态，不必先发现目录再重读。'};
}

/** A saved scene judgment is a partner observation at its formation range. Its
 * source closure remains subject to the same withdrawal and permission rules. */
export function sceneRecordAllowed(state:State,book:Book,record:ReadingRecord):boolean{
  const insight=record.sceneInsight;
  const formedLength=bookVersionPrefixLength(book,record.version);
  const evidenceAllowed=(evidence:readonly import('./types.ts').Evidence[])=>formedLength!==undefined&&evidence.every(e=>{const length=bookVersionPrefixLength(book,e.version);return length!==undefined&&length<=formedLength&&bookVersionAllowsRange(book,record.version,e);})&&isEvidenceAllowed(book,[...evidence]);
  if(record.sceneOpportunity?.preview&&!covers(book.known,record.sceneOpportunity.preview))return false;
  if(record.bookId!==book.id||!bookVersionAllowsRanges(book,record.version,record.ranges)||record.partnerId!==state.partnerId||!insight||typeof insight.text!=='string'||!insight.text.trim()||!Array.isArray(insight.evidence)||!insight.evidence.length||!Array.isArray(insight.memoryIds)||!Array.isArray(insight.chatIds)||insight.viewIds!==undefined&&!Array.isArray(insight.viewIds))return false;
  if(insight.evidence.some(e=>!Number.isSafeInteger(e.start)||!Number.isSafeInteger(e.end)||e.start<0||e.end<=e.start)||!evidenceAllowed(insight.evidence)||state.forgotten.some(f=>f.bookId===book.id&&!!normalize(f.text)&&normalize(insight.text).includes(normalize(f.text))))return false;
  const checked=new Set<string>(),checking=new Set<string>();
  function allowedChat(id:string):boolean{
    const key='chat:'+id;if(checked.has(key)||checking.has(key))return true;
    const c=state.chats.find(c=>c.id===id);
    if(!c||c.bookId!==book.id||!chatBelongsToPartner(state,c)||!chatAllowsMemory(state,c)||c.excluded||c.outdatedBy||c.replacedBy||c.futureGrant||!evidenceAllowed(c.evidence))return false;
    checking.add(key);
    const dependencies=[...(c.contextChatIds??[]),...(c.basis?.chatIds??[]),...(c.replyTo?[c.replyTo]:[]),...(c.paragraphCommentId?[c.paragraphCommentId]:[])];
    const valid=[...new Set(dependencies)].every(allowedChat)&&[...new Set([...(c.memoryIds??[]),...(c.basis?.memoryIds??[])])].every(allowedMemory);
    checking.delete(key);if(valid)checked.add(key);return valid;
  }
  const memorySourceAllowed=materialMemorySourceChecker(state,book);
  function allowedMemory(id:string):boolean{
    const memory=state.memories.find(m=>m.id===id);
    return !!memory&&evidenceAllowed(memory.evidence)&&memorySourceAllowed(id);
  }
  return insight.memoryIds.every(allowedMemory)&&insight.chatIds.every(allowedChat)&&(insight.viewIds??[]).every(id=>{const view=state.publishedViews?.find(v=>v.id===id);return!!view&&evidenceAllowed(view.evidence)&&viewAllowed(state,book,view);});
}

export function validateMaterialProjection(state:State,book:Pick<Book,'id'|'version'>,material:ReadingDraftMaterial,resolveSources=true):void{
  const sourceBook=resolveBookVersion(state.books.find(b=>b.id===book.id),book.version);
  if(material.sceneOpportunity?.preview){
    const original=sourceBook;
    if(material.taskRole!=='scene'||!original)throw Error('预读材料只属于原书的现场任务');
    validateSceneOpportunity(original,material.sceneOpportunity);
  }
  if(material.dependencyStampVersion!==undefined&&material.dependencyStampVersion!==3)throw Error('材料依赖版本无效');
  if(material.delegatedSources!==undefined){
    if(!Array.isArray(material.delegatedSources)||new Set(material.delegatedSources.map(source=>source.agentSessionId)).size!==material.delegatedSources.length)throw Error('子结论来源集合无效');
    for(const source of material.delegatedSources){
      if(!source||typeof source.agentSessionId!=='string'||!source.agentSessionId||typeof source.resultRef!=='string'||!source.resultRef||[source.memoryIds,source.viewIds,source.chatIds].some(ids=>!Array.isArray(ids)||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!id))||!Array.isArray(source.originalRanges)||source.originalRanges.some(range=>!Number.isSafeInteger(range.start)||!Number.isSafeInteger(range.end)||range.start<0||range.end<=range.start))throw Error('子结论来源身份无效');
      if(resolveSources){const record=state.agentSessions?.find(record=>record.id===source.agentSessionId);if(!record?.delegation||record.status==='invalidated'||record.bookId!==book.id||!sourceBook||!bookVersionAllowsRanges(sourceBook,record.version,source.originalRanges)||record.partnerId!==state.partnerId||record.delegation.resultRef!==source.resultRef)throw Error('子结论未对应当前书籍的有效原结果');
        const saved=record.material?.delegatedResult,body=record.material?.material,materials=body?[body,...(record.material?.inheritedMaterial?[record.material.inheritedMaterial]:[])]:[];
        // A released external carrier is checked by its durable resultRef and
        // material dependency stamp; when loaded, also verify exact lineage.
        if(saved&&saved.result.resultRef!==source.resultRef||body&&(JSON.stringify([...new Set(materials.flatMap(m=>[...m.memoryIds,...(m.partialMemoryIds??[])]))])!==JSON.stringify(source.memoryIds)||JSON.stringify([...new Set(materials.flatMap(m=>m.viewIds??[]))])!==JSON.stringify(source.viewIds)||JSON.stringify([...new Set(materials.flatMap(m=>m.chatIds))])!==JSON.stringify(source.chatIds)||JSON.stringify(mergeRanges(materials.flatMap(m=>m.originalRanges)))!==JSON.stringify(source.originalRanges)))throw Error('子结论来源与原持久材料不一致');
      }
    }
  }
  if(material.exposures!==undefined){
    if(!Array.isArray(material.exposures))throw Error('实际供材回执集合无效');
    const calls=new Set<string>();
    for(const receipt of material.exposures){
      const key=receipt?.agentCallId+':'+receipt?.surfaceHash;
      if(!receipt||typeof receipt.agentSessionId!=='string'||!receipt.agentSessionId||typeof receipt.agentCallId!=='string'||!receipt.agentCallId||typeof receipt.requestId!=='string'||!receipt.requestId||!/^[a-f0-9]{64}$/.test(receipt.surfaceHash)||!Array.isArray(receipt.eventSeqs)||receipt.eventSeqs.some(seq=>!Number.isSafeInteger(seq)||seq<0)||calls.has(key)||!Array.isArray(receipt.materials))throw Error('实际供材派发身份无效');
      calls.add(key);
      if(resolveSources&&!state.usage.some(usage=>usage.id===receipt.requestId&&usage.agentSessionId===receipt.agentSessionId&&usage.agentCallId===receipt.agentCallId&&usage.status==='complete'&&usage.dispatchState==='response-received'))throw Error('实际供材回执未对应已结算请求');
      for(const exposure of receipt.materials)if(!exposure||!['memory','view','original','chat'].includes(exposure.kind)||typeof exposure.id!=='string'||!exposure.id||typeof exposure.version!=='string'||!exposure.version||!/^[a-f0-9]{64}$/.test(exposure.hash)||!['full','partial','preview'].includes(exposure.mode)||!Number.isSafeInteger(exposure.chars)||exposure.chars<0||exposure.ranges!==undefined&&(!Array.isArray(exposure.ranges)||exposure.ranges.some(range=>!Number.isSafeInteger(range.start)||!Number.isSafeInteger(range.end)||range.start<0||range.end<=range.start)))throw Error('实际供材版本或覆盖无效');
    }
  }
  if(material.taskRole!==undefined&&!['scene','maintenance'].includes(material.taskRole))throw Error('任务供材职责无效');
  if(material.sceneCommentIds!==undefined&&(material.taskRole!=='scene'||!Array.isArray(material.sceneCommentIds)||!material.sceneCommentIds.length||new Set(material.sceneCommentIds).size!==material.sceneCommentIds.length||material.sceneCommentIds.some(id=>typeof id!=='string'||!id||!material.chatIds.includes(id))))throw Error('现场实际评论触发身份无效');
  if(material.sceneOrigin!==undefined){const o=material.sceneOrigin;if(material.taskRole!=='scene'||!o||typeof o.instanceId!=='string'||!o.instanceId||typeof o.sessionId!=='string'||!o.sessionId||!Number.isSafeInteger(o.generation)||o.generation<0||!Number.isSafeInteger(o.dialogueRevision)||o.dialogueRevision<0)throw Error('现场表达形成身份无效');}
  if(material.maintenanceViewTargets!==undefined&&(material.taskRole!=='maintenance'||!material.maintenanceJobId||!Array.isArray(material.maintenanceViewTargets)||JSON.stringify(material.maintenanceViewTargets)!==JSON.stringify(canonicalMaintenanceViewTargets(material.maintenanceViewTargets))||resolveSources&&material.maintenanceViewTargets.some(target=>target.startsWith('view:')&&!state.publishedViews?.some(view=>view.id===target.slice(5)&&view.bookId===book.id&&!!sourceBook&&bookVersionAllowsRanges(sourceBook,view.version,view.evidence)&&viewReadableByPartner(state,view)))))throw Error('维护派生视图目标无效');
  if(material.viewIds!==undefined&&(!Array.isArray(material.viewIds)||new Set(material.viewIds).size!==material.viewIds.length||material.viewIds.some(id=>typeof id!=='string'||!id||resolveSources&&!state.publishedViews?.some(v=>v.id===id&&v.bookId===book.id&&!!sourceBook&&bookVersionAllowsRanges(sourceBook,v.version,v.evidence)&&viewReadableByPartner(state,v)))))throw Error('任务派生视图身份无效');
  if(material.sceneRecordIds!==undefined&&(!Array.isArray(material.sceneRecordIds)||new Set(material.sceneRecordIds).size!==material.sceneRecordIds.length||material.sceneRecordIds.some(id=>typeof id!=='string'||!id||resolveSources&&!state.readings?.some(record=>record.id===id&&!!sourceBook&&sceneRecordAllowed(state,sourceBook,record)))))throw Error('任务现场成果来源无效');
  if(material.maintenanceReviewRanges!==undefined&&(material.taskRole!=='maintenance'||!Array.isArray(material.maintenanceReviewRanges)||JSON.stringify(material.maintenanceReviewRanges)!==JSON.stringify(mergeRanges(material.maintenanceReviewRanges))||material.maintenanceReviewRanges.some(r=>!Number.isSafeInteger(r.start)||!Number.isSafeInteger(r.end)||r.start<0||r.end<=r.start)))throw Error('概要补核范围身份无效');
  if(material.maintenanceReviewMemoryIds!==undefined&&(material.taskRole!=='maintenance'||!Array.isArray(material.maintenanceReviewMemoryIds)||new Set(material.maintenanceReviewMemoryIds).size!==material.maintenanceReviewMemoryIds.length||material.maintenanceReviewMemoryIds.some(id=>typeof id!=='string'||!id)))throw Error('概要补核完整认识身份无效');
  const w=material.workspaceSnapshot;
  if(w&&(w.bookId!==book.id||w.version!==book.version||w.partnerId!==state.partnerId||w.source!==material.workspaceSource||w.revision!==material.workspaceRevision||material.workspaceVersion!==undefined&&!isWorkspaceVersion(material.workspaceVersion,w.revision)||!Array.isArray(w.focusIds)||w.workingIds!==undefined&&!Array.isArray(w.workingIds)))throw Error('私人工作台形成快照无效');
}

/** One supplier projection for initial packets and subsequent tool pages. */
export function memoryMaterial(value:unknown,options:{full?:boolean;canUpdate?:boolean;already?:boolean}={}){
  const item=value as Record<string,any>;
  const bodyHash=item.bodyHash??item.bodyRef?.hash,bodyChars=item.bodyChars??item.bodyRef?.chars;
  const navigation={id:item.id,kind:item.kind,...(item.partnerId?{generatedByPartnerId:item.partnerId}:{}),...(item.scope?{scope:item.scope}:{}),...(item.scope==='book'?{documentAttribution:'书籍共享分析；正文中的伙伴称谓和个人看法属于记录的生成者，不能冒充当前伙伴的经历；私人来源仅在内部核验，不自动提供原文。'}:{}),...(item.subject?{subject:item.subject}:{}),...(item.paragraphHits?{paragraphHits:item.paragraphHits}:{}),...(item.documentState?{documentState:item.documentState}:{}),...(item.documentSuccessors?{documentSuccessors:item.documentSuccessors}:{}),...(item.organization?{organization:item.organization}:{}),...(item.matchedHistoryIds?.length?{matchedHistoryIds:item.matchedHistoryIds}:{}),...(item.developmentChainIds?.length?{developmentChainIds:item.developmentChainIds,directSuccessorId:item.directSuccessorId}:{}),...((item.documentTitle??item.title)!==undefined?{documentTitle:item.documentTitle??item.title}:{}),...(bodyHash!==undefined?{bodyHash}:{}),...(bodyChars!==undefined?{bodyChars}:{}),...(Array.isArray(item.navigationCues)?{navigationCues:item.navigationCues.slice(0,4).map((cue:string)=>cue.slice(0,80))}:{}),
    ...(Array.isArray(item.navigationCues)&&item.navigationCues.length>4?{moreCues:true}:{}),
    ...(Array.isArray(item.readingStage)?{readingStage:item.readingStage.slice(0,4)}:{}),
    ...(Array.isArray(item.readingStage)&&item.readingStage.length>4?{moreFormationRanges:true}:{}),
    history:!!item.historicalOnly||item.documentState==='retired'||!!item.replacedBy||!!item.history,
    ...(options.already?{currentAlreadyProvided:true}:{})};
  if(!options.full){
    // Navigation locates immutable versions. Full relationships, excerpts and
    // object definitions remain available through the same full-read port.
    const {organization,subject,paragraphHits,developmentChainIds,matchedHistoryIds,...compact}=navigation;
    return{...compact,
      ...(subject?{subject:{key:subject.key,title:subject.title,role:subject.role,primary:subject.primary,
        ...(subject.currentPrimary?{currentPrimary:{id:subject.currentPrimary.id}}:{}),
        ...(subject.currentPrimaryConflictIds?{currentPrimaryConflictIds:subject.currentPrimaryConflictIds}:{})}}:{}),
      ...(paragraphHits?.length?{paragraphHits:paragraphHits.map((hit:Record<string,any>)=>({start:hit.start,end:hit.end,excerptStart:hit.excerptStart,excerptEnd:hit.excerptEnd})),preview:paragraphHits[0].text?.slice(0,160)}:{}),
      ...(matchedHistoryIds?.length?{matchedHistoryIds}:{}),
      ...(organization?{organizationAvailable:true}:{}),
      ...(developmentChainIds?.length?{developmentVersionCount:developmentChainIds.length}:{})};
  }
  if(typeof item.text!=='string')throw Error('全文供材前正文尚未载入');
  const identity=memoryContentIdentity(item as Memory);
  // Once the complete body is present, search excerpts and matching cues add
  // no reading material. Keep its content, organization and current successor;
  // the discovery/history tools still expose the full navigation on request.
  const {paragraphHits,navigationCues,moreCues,matchedHistoryIds,developmentChainIds,...full}=navigation;
  return{...full,bodyHash:identity.hash,bodyChars:identity.chars,bodyFormat:'full' as const,text:item.text,...(item.source!==undefined?{origin:item.source}:{}),...(options.canUpdate!==undefined?{canUpdate:options.canUpdate}:{}),...(item.knowledgeDistribution!==undefined?{knowledgeDistribution:item.knowledgeDistribution}:{})};
}
export function navigationPage(value:unknown,already:ReadonlySet<string>){
  const page=value as Record<string,any>;
  return{items:[...new Map<string,Record<string,any>>(page.items.map((item:Record<string,any>)=>[item.id,item])).values()].map(item=>memoryMaterial(item,{already:already.has(item.id)})),
    ...(page.total!==undefined?{total:page.total}:{}),...(page.nextCursor!==undefined?{nextCursor:page.nextCursor}:{}),...(page.remainingIds!==undefined?{remainingIds:page.remainingIds}:{}),...(page.unavailableIds!==undefined?{unavailableIds:page.unavailableIds}:{}),
    ...(page.hasMore!==undefined?{hasMore:page.hasMore}:{}),...(page.mode!==undefined?{mode:page.mode}:{}),...(page.selection!==undefined?{selection:page.selection}:{}),...(page.order!==undefined?{order:page.order}:{}),
    notice:'目录仅用于取材。已提供的全文直接复用，其余按编号展开；本页未命中不证明不存在。'};
}
