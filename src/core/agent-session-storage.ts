import type {AgentSessionMaterial,AgentSessionRecord,AgentSessionEventChunk,AgentSessionManifest,TaskMaterialBody,TaskMaterialRef,State} from './types.ts';
import type {NativeSessionReference} from './agent-port.ts';
import {conversationBelongsToPartner} from './discussion-recall.ts';

/** Conversation and execution identities survive cold restore independently of native logs. */
export function validateConversationContexts(state:State):void{
  const conversations=new Map(state.conversations.map(conversation=>[conversation.id,conversation])),tasks=new Map((state.agentSessions??[]).map(record=>[record.id,record]));
  const samePartner=(left:State['conversations'][number],right:State['conversations'][number])=>state.partners.some(partner=>conversationBelongsToPartner({...state,partnerId:partner.id},left)&&conversationBelongsToPartner({...state,partnerId:partner.id},right)),nativeContexts=new Map<string,State['conversations'][number]>();
  for(const conversation of state.conversations){
    if(conversation.lastUsedAt!==undefined&&(!Number.isFinite(conversation.lastUsedAt)||conversation.lastUsedAt<0))throw Error('对话的实际使用时间无效');
    if(conversation.continuationReason!==undefined&&!['user','context-compacted','restore-pressure','context-invalidated'].includes(conversation.continuationReason))throw Error('对话接续原因无效');
    if(conversation.previousConversationId!==undefined){
      const previous=conversations.get(conversation.previousConversationId);
      if(typeof conversation.previousConversationId!=='string'||!previous||previous.id===conversation.id||previous.bookId!==conversation.bookId||!samePartner(conversation,previous))throw Error('前后对话须属于同一作品和伙伴');
    }
    const context=conversation.context;if(context===undefined)continue;
    if(!context||typeof context!=='object'||Array.isArray(context)||typeof context.nativeSessionId!=='string'||!context.nativeSessionId||context.lastTaskId!==undefined&&(typeof context.lastTaskId!=='string'||!context.lastTaskId)||context.previousTaskId!==undefined&&(typeof context.previousTaskId!=='string'||!context.previousTaskId))throw Error('对话的原生上下文身份无效');
    const priorContext=nativeContexts.get(context.nativeSessionId);if(priorContext&&(priorContext.bookId!==conversation.bookId||!samePartner(priorContext,conversation)))throw Error('同一原生上下文不能连接不同作品或伙伴');nativeContexts.set(context.nativeSessionId,conversation);
    if(context.lastTaskId){const task=tasks.get(context.lastTaskId);if(!task||task.bookId!==conversation.bookId||!conversationBelongsToPartner({...state,partnerId:task.partnerId},conversation)||(task.nativeSessionId??task.id)!==context.nativeSessionId||task.conversationId!==undefined&&task.conversationId!==conversation.id||task.contextRole==='branch')throw Error('对话的原生上下文未对应本对话的实际主任务');}
    if(context.previousTaskId){let previous=tasks.get(context.previousTaskId);if(!previous||previous.bookId!==conversation.bookId||!conversationBelongsToPartner({...state,partnerId:previous.partnerId},conversation)||previous.conversationId!==conversation.id||previous.contextRole==='branch'||(previous.nativeSessionId??previous.id)===context.nativeSessionId)throw Error('原生前段须对应同一对话的实际主任务');const chain=new Set(context.lastTaskId?[context.lastTaskId]:[]);while(previous){if(chain.has(previous.id))throw Error('原生前段任务接续形成循环');chain.add(previous.id);previous=previous.previousSessionId?tasks.get(previous.previousSessionId):undefined;}}
  }
  const checked=new Set<string>();for(const conversation of state.conversations){const chain=new Set<string>();let cursor:typeof conversation|undefined=conversation;while(cursor&&!checked.has(cursor.id)){if(chain.has(cursor.id))throw Error('对话前后接续形成循环');chain.add(cursor.id);cursor=cursor.previousConversationId?conversations.get(cursor.previousConversationId):undefined;}for(const id of chain)checked.add(id);}
  const nativeOwners=new Map<string,{bookId:string;partnerId:string}>();
  for(const task of state.agentSessions??[]){
    if(task.contextRole!==undefined&&!['main','branch'].includes(task.contextRole)||task.contextRole!==undefined&&!task.conversationId)throw Error('执行任务的对话上下文职责无效');
    if(task.conversationId!==undefined){const conversation=conversations.get(task.conversationId);if(typeof task.conversationId!=='string'||!conversation||conversation.bookId!==task.bookId||!conversationBelongsToPartner({...state,partnerId:task.partnerId},conversation))throw Error('执行任务不能连接其他作品或伙伴的对话');}
    const nativeId=task.nativeSessionId??task.native?.sessionId??task.id,owner=nativeOwners.get(nativeId),conversation=nativeContexts.get(nativeId);if(owner&&(owner.bookId!==task.bookId||owner.partnerId!==task.partnerId)||conversation&&(conversation.bookId!==task.bookId||!conversationBelongsToPartner({...state,partnerId:task.partnerId},conversation)))throw Error('同一原生上下文不能连接不同作品或伙伴');nativeOwners.set(nativeId,{bookId:task.bookId,partnerId:task.partnerId});
  }
}

export function validateNativeSessionReference(value:NativeSessionReference,id:string):void{
  if(value.kind!=='dsh-native-session-v1'||value.backend!=='jsonl'||value.sessionId!==id||value.formatVersion!==4||(value.header as {id?:unknown})?.id!==id||!Number.isSafeInteger(value.eventCount)||value.eventCount<0||!Array.isArray(value.calls)||!Array.isArray(value.feedbacks))throw Error('原生会话引用或存储水位无效');
  if(value.closedEventCount!==undefined&&(!Number.isSafeInteger(value.closedEventCount)||value.closedEventCount<1||value.closedEventCount>value.eventCount))throw Error('原生会话闭合水位无效');
  if(value.spills&&(!Array.isArray(value.spills)||value.spills.some(item=>typeof item.locator!=='string'||!item.locator||item.storageLocator!==undefined&&(typeof item.storageLocator!=='string'||!item.storageLocator)||item.sourceSessionId!==undefined&&(typeof item.sourceSessionId!=='string'||!item.sourceSessionId)||!/^[a-f0-9]{64}$/.test(item.hash)||!Number.isSafeInteger(item.bytes)||item.bytes<0||typeof item.callId!=='string'||!item.callId||typeof item.toolName!=='string'||!item.toolName)))throw Error('原生长结果来源索引无效');
  if(value.relocations){if(!Array.isArray(value.relocations)||!value.relocations.length)throw Error('原生会话重定位来源无效');for(const entry of value.relocations)if(entry.reason!=='book-project-relocation-v1'||(entry.sourceHeader as {id?:unknown})?.id!==id||!Number.isSafeInteger(entry.sourceEventCount)||entry.sourceEventCount<0||entry.sourceEventCount>value.eventCount||!/^[a-f0-9]{64}$/.test(entry.sourceSnapshotHash)||!/^[a-f0-9]{64}$/.test(entry.targetSnapshotHash)||!/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(entry.projectDirectory))throw Error('原生会话重定位来源无效');const last=value.relocations[value.relocations.length-1];if((value.header as {cwd?:unknown}).cwd!==last.projectDirectory)throw Error('原生会话重定位目标不符');}
  const ids=new Set<string>();let previousBoundary=0;for(const call of value.calls){if(typeof call.agentCallId!=='string'||!call.agentCallId||ids.has(call.agentCallId)||!Number.isSafeInteger(call.ordinal)||call.ordinal<1||!Number.isSafeInteger(call.boundarySeq)||call.boundarySeq<previousBoundary||call.boundarySeq>value.eventCount||call.resultSeq!==undefined&&(!Number.isSafeInteger(call.resultSeq)||call.resultSeq<call.boundarySeq||call.resultSeq>=value.eventCount)||call.requestId!==undefined&&(typeof call.requestId!=='string'||!call.requestId)||call.purpose!==undefined&&typeof call.purpose!=='string'||call.taskExecutionId!==undefined&&(typeof call.taskExecutionId!=='string'||!call.taskExecutionId)||call.notDispatched!==undefined&&call.notDispatched!==true)throw Error('原生调用的领域关联无效');ids.add(call.agentCallId);previousBoundary=call.boundarySeq;}
  for(const feedback of value.feedbacks)if(typeof feedback.requestId!=='string'||!feedback.requestId||typeof feedback.messageId!=='string'||!feedback.messageId||!value.calls.some(call=>call.requestId===feedback.requestId))throw Error('原生反馈的领域关联无效');
  const migration=value.migration;if(migration&&(!/^[a-f0-9]{64}$/.test(migration.sourceSnapshotHash)||!/^[a-f0-9]{64}$/.test(migration.nativeSnapshotHash)||!Number.isSafeInteger(migration.sourceEventCount)||migration.sourceEventCount<0||migration.eventSeqMap.length!==migration.sourceEventCount||migration.eventSeqMap.some(seq=>seq!==null&&(!Number.isSafeInteger(seq)||seq<0||seq>=value.eventCount))))throw Error('原生会话迁移证明无效');
  if(migration?.headerMapping){const mapping=migration.headerMapping,initial=value.relocations?.[0]?.sourceHeader??value.header;if(mapping.reason!=='book-project-v1'||typeof mapping.projectDirectory!=='string'||!/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(mapping.projectDirectory)||mapping.sourceCwd!==undefined&&typeof mapping.sourceCwd!=='string'||(initial as {cwd?:unknown}).cwd!==mapping.projectDirectory)throw Error('原生书籍工程归属迁移证明无效');}
}

export type StoredMaterial = {ref:TaskMaterialRef;body:TaskMaterialBody;dependencies?:TaskMaterialBody[]};
type Encode=(value:TaskMaterialBody['value'])=>Promise<StoredMaterial>;
const deltas=new WeakMap<AgentSessionMaterial,{previous:AgentSessionMaterial;previousRef?:TaskMaterialRef;events:unknown[]}>();
const encoded=new WeakMap<AgentSessionMaterial,Promise<StoredMaterial>>();
const migrationSources=new WeakMap<import('./agent-port.ts').AgentSessionSnapshot,Promise<StoredMaterial>>();
const successors=new WeakMap<AgentSessionRecord,WeakRef<AgentSessionRecord>>();

/** Only the adapter may establish this identity; imported records take the
 * strict path below. No public backup receives a storage-local event chain. */
export function registerAgentSessionAppend(previous:AgentSessionRecord,next:AgentSessionRecord,events:unknown[]):void{
  deltas.set(next.material!,{previous:previous.material!,...(previous.materialRef?{previousRef:{...previous.materialRef}}:{}),events});
  successors.set(next,new WeakRef(previous));
}
/** The official native file replaces only the domain's mirrored log, never its source original. */
export function registerNativeSessionProjection(previous:AgentSessionRecord,next:AgentSessionRecord):void{
  if(!next.native||!next.material||next.material.snapshot.events.length!==0||!previous.native&&previous.material!.snapshot.events.length>0&&next.material.migrationSource!==previous.material!.snapshot)throw Error('原生会话投影释放缺少原迁移来源');
  successors.set(next,new WeakRef(previous));
}
export function assertAgentSessionSuccessor(previous:AgentSessionRecord,next:AgentSessionRecord):void{
  const trusted=successors.get(next)?.deref()===previous,tail=next.material&&deltas.get(next.material)?.events;
  const legacyTail=trusted&&tail&&tail.every(event=>['tool/result','step/end','turn/end','yixu/terminal-result'].includes(String((event as {type?:unknown})?.type)));
  if((previous.status!=='open'||next.status!=='open')&&!(previous.status===next.status&&(!!next.native||legacyTail))||['id','bookId','version','partnerId','taskKey','createdAt','previousSessionId','nativeSessionId','nativeStartEventCount','conversationId','contextRole'].some(key=>previous[key as keyof AgentSessionRecord]!==next[key as keyof AgentSessionRecord]))throw Error('Agent事件保存的任务归属或状态已变化');
  if(previous.delegation){const a=previous.delegation,b=next.delegation;if(!b||['parentSessionId','operationKey','prompt','label','delivery','context','presetId','inheritedPresetId'].some(key=>a[key as keyof typeof a]!==b[key as keyof typeof b])||JSON.stringify(a.dependencies)!==JSON.stringify(b.dependencies)||JSON.stringify(a.authority)!==JSON.stringify(b.authority)||a.acceptedMessageId&&a.acceptedMessageId!==b.acceptedMessageId||a.resultRef&&a.resultRef!==b.resultRef)throw Error('子任务原意图或交付身份已变化');const rank={prepared:0,accepted:1,unknown:2,failed:2,'result-received':3,complete:4};if(rank[b.status]<rank[a.status])throw Error('子任务交付状态倒退');}
  if(previous.delegation&&JSON.stringify(previous.delegation.authorizedService)!==JSON.stringify(next.delegation?.authorizedService))throw Error('子任务原授权模型条件已变化');
  if(JSON.stringify(previous.inheritedFrom)!==JSON.stringify(next.inheritedFrom)||previous.material?.inheritedMaterial!==next.material?.inheritedMaterial&&JSON.stringify(previous.material?.inheritedMaterial)!==JSON.stringify(next.material?.inheritedMaterial))throw Error('子任务继承历史的冻结来源已变化');
  if(previous.native){
    if(!next.native||next.native.sessionId!==previous.native.sessionId||next.native.eventCount<previous.native.eventCount||JSON.stringify(next.native.header)!==JSON.stringify(previous.native.header)||JSON.stringify(next.native.migration)!==JSON.stringify(previous.native.migration)||JSON.stringify(next.native.relocations)!==JSON.stringify(previous.native.relocations))throw Error('原生会话关联或迁移证明已变化');
    for(const call of previous.native.calls){const current=next.native.calls.find(item=>item.agentCallId===call.agentCallId);if(!current||current.ordinal!==call.ordinal||current.boundarySeq!==call.boundarySeq||current.purpose!==call.purpose||current.taskExecutionId!==call.taskExecutionId||call.resultSeq!==undefined&&current.resultSeq!==call.resultSeq||call.requestId&&current.requestId!==call.requestId||call.notDispatched&&!current.notDispatched)throw Error('原生调用关联已变化');}
    if(previous.native.feedbacks.some(item=>!next.native!.feedbacks.some(next=>next.requestId===item.requestId&&next.messageId===item.messageId)))throw Error('原生反馈关联已丢失');
    if(previous.native.spills?.some(item=>!next.native!.spills?.some(next=>JSON.stringify(next)===JSON.stringify(item))))throw Error('原生长结果来源索引已丢失');
  }
  // Trusted append skips only the large immutable event-prefix comparison.
  if(successors.get(next)?.deref()===previous)return;
  const left=previous.material?.snapshot,right=next.material?.snapshot;
  if(!left||!right||JSON.stringify(left.header)!==JSON.stringify(right.header)||right.events.length<left.events.length)throw Error('Agent事件保存前缀已变化，未覆盖其他进度');
  for(let index=0;index<left.events.length;index++)if(JSON.stringify(left.events[index])!==JSON.stringify(right.events[index]))throw Error('Agent事件保存前缀已变化，未覆盖其他进度');
}
function sessionId(header:unknown):string{
  const id=(header as {id?:unknown}|null)?.id;if(typeof id!=='string'||!id)throw Error('Agent会话头身份无效');return id;
}
function assertEvents(events:unknown[],start:number):void{
  if(!Array.isArray(events)||events.some((event,index)=>!event||typeof event!=='object'||(event as {seq?:unknown}).seq!==start+index))throw Error('Agent事件分块序列不连续');
}

/** Immutable linked chunks make an ordinary append independent of prefix size.
 * A legacy inline session is mapped once, at the first storage boundary. */
export function encodeAgentSession(material:AgentSessionMaterial,encode:Encode):Promise<StoredMaterial>{
  const known=encoded.get(material);if(known)return known;
  const pending=(async()=>{
    const delta=deltas.get(material),previous=delta?await encodeAgentSession(delta.previous,encode):undefined;
    const prior=previous?.body.value as AgentSessionManifest|undefined;
    const events=delta?.events??material.snapshot.events,start=prior?.eventCount??0;
    assertEvents(events,start);
    const id=sessionId(material.snapshot.header);
    if(prior&&(sessionId(prior.header)!==id||material.snapshot.events.length!==start+events.length))throw Error('Agent事件分块前缀已变化');
    // Encoding is not durable publication. An old inline v1 ref does not prove
    // that its newly mapped baseline chunk exists. Carry that conversion's
    // transitive bodies in this transaction; a published manifest ref proves
    // the normal predecessor's linked prefix is already available.
    const unpublishedPrevious=previous&&delta?.previousRef?.key!==previous.ref.key?previous.dependencies??[]:[];
    const sources=await encode(material.material),dependencies:TaskMaterialBody[]=[...unpublishedPrevious,...(prior?.sources.key===sources.ref.key?[]:[...(sources.dependencies??[]),sources.body])];
    let tail=prior?.tail;
    if(events.length){
      const chunk:AgentSessionEventChunk={kind:'agent-session-events-v1',sessionId:id,start,events,...(tail?{previous:tail}:{})};
      const stored=await encode(chunk);dependencies.push(stored.body);tail=stored.ref;
    }
    let migrationSourceRef=prior?.migrationSourceRef;
    if(material.migrationSource&&!migrationSourceRef){let stored=migrationSources.get(material.migrationSource);if(!stored){stored=encode({kind:'agent-session-migration-source-v1',snapshot:material.migrationSource});migrationSources.set(material.migrationSource,stored);}const source=await stored;migrationSourceRef=source.ref;dependencies.push(...(source.dependencies??[]),source.body);}
    const spillBodyRefs:TaskMaterialRef[]=[];for(const body of material.spillBodies??[]){const stored=await encode(body);spillBodyRefs.push(stored.ref);if(!prior?.spillBodyRefs?.some(ref=>ref.key===stored.ref.key))dependencies.push(...(stored.dependencies??[]),stored.body);}
    const inherited=material.inheritedMaterial?await encode(material.inheritedMaterial):undefined;if(inherited&&inherited.ref.key!==prior?.inheritedMaterialRef?.key)dependencies.push(...(inherited.dependencies??[]),inherited.body);
    const manifest:AgentSessionManifest={kind:'agent-session-manifest-v1',header:material.snapshot.header,eventCount:start+events.length,...(tail?{tail}:{}),sources:sources.ref,dependencyStamp:material.dependencyStamp,...(migrationSourceRef?{migrationSourceRef}:{}),...(spillBodyRefs.length?{spillBodyRefs}:{}),...(inherited?{inheritedMaterialRef:inherited.ref}:{}),...(material.delegatedResult?{delegatedResult:material.delegatedResult}:{})};
    const result=await encode(manifest);
    deltas.delete(material);
    return{...result,dependencies};
  })();
  encoded.set(material,pending);void pending.catch(()=>{encoded.delete(material);});return pending;
}

/** Integrity checking is delegated to the common cold-body reader. Walking is
 * iterative so thousands of append chunks cannot overflow a JavaScript stack. */
export async function decodeAgentSession(manifest:AgentSessionManifest,stored:StoredMaterial,read:(ref:TaskMaterialRef)=>Promise<TaskMaterialBody>):Promise<AgentSessionMaterial>{
  const id=sessionId(manifest.header);
  if(!Number.isSafeInteger(manifest.eventCount)||manifest.eventCount<0||typeof manifest.dependencyStamp!=='string'||!!manifest.tail!==(manifest.eventCount>0))throw Error('Agent会话存储清单无效');
  const chunks:AgentSessionEventChunk[]=[],seen=new Set<string>();let cursor=manifest.eventCount,ref=manifest.tail;
  while(ref){
    if(seen.has(ref.key))throw Error('Agent事件分块存在环路');seen.add(ref.key);
    const body=await read(ref),chunk=body.value;
    if(!('kind'in chunk)||chunk.kind!=='agent-session-events-v1'||chunk.sessionId!==id||!Number.isSafeInteger(chunk.start)||chunk.start<0||!Array.isArray(chunk.events)||!chunk.events.length||chunk.start+chunk.events.length!==cursor)throw Error('Agent事件分块身份或前缀无效');
    assertEvents(chunk.events,chunk.start);chunks.push(chunk);cursor=chunk.start;ref=chunk.previous;
  }
  if(cursor!==0)throw Error('Agent事件分块前缀缺失');
  const sources=await decodeAgentSessionSources(manifest,read);
  const events:unknown[]=[];for(let index=chunks.length-1;index>=0;index--)for(const event of chunks[index].events)events.push(event);
  const material:AgentSessionMaterial={...sources,snapshot:{header:manifest.header,events}};
  encoded.set(material,Promise.resolve({...stored,dependencies:[]}));return material;
}

/** Source dictionaries belong to each task even when its native event prefix
 * is already verified by the same import's highest shared watermark. */
export async function decodeAgentSessionSources(manifest:AgentSessionManifest,read:(ref:TaskMaterialRef)=>Promise<TaskMaterialBody>):Promise<Omit<AgentSessionMaterial,'snapshot'>>{
  const source=(await read(manifest.sources)).value;
  if(!('messages'in source)||!Array.isArray(source.messages)||!('references'in source)||!('webSources'in source)||!('ranges'in source)||!('readUrls'in source)||'kind'in source)throw Error('Agent会话来源字典无效');
  let migrationSource:import('./agent-port.ts').AgentSessionSnapshot|undefined;
  if(manifest.migrationSourceRef){const original=await read(manifest.migrationSourceRef);if(!('kind'in original.value)||original.value.kind!=='agent-session-migration-source-v1'||!Array.isArray(original.value.snapshot.events))throw Error('原生迁移源原件无效');migrationSource=original.value.snapshot;migrationSources.set(migrationSource,Promise.resolve({ref:manifest.migrationSourceRef,body:original}));}
  const spillBodies:NonNullable<AgentSessionMaterial['spillBodies']>=[];for(const ref of manifest.spillBodyRefs??[]){const body=(await read(ref)).value;if(!('kind'in body)||body.kind!=='agent-session-spill-v1'||typeof body.text!=='string')throw Error('长结果导入正文分块身份无效');spillBodies.push(body);}
  let inheritedMaterial:AgentSessionMaterial['inheritedMaterial'];if(manifest.inheritedMaterialRef){const body=(await read(manifest.inheritedMaterialRef)).value;if('kind'in body||!('references'in body)||!('ranges'in body))throw Error('继承历史来源分块身份无效');inheritedMaterial=body;}
  return{kind:'agent-session-v1',material:source,dependencyStamp:manifest.dependencyStamp,...(migrationSource?{migrationSource}:{}),...(spillBodies.length?{spillBodies}:{}),...(inheritedMaterial?{inheritedMaterial}:{}),...(manifest.delegatedResult?{delegatedResult:manifest.delegatedResult}:{})};
}
