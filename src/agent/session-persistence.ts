/// <reference lib="esnext.disposable" />
import { Context } from '@deepseek-ai/cordis';
import { Session, SessionId, SessionLogOffset, KNOWN_SESSION_EVENT_TYPES, interruptedTurnClosers, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session';
import {createUserMessage} from '@deepseek-ai/dsh-llm';
import {estimateMessage} from '@deepseek-ai/dsh-token-meter/estimate';
import {projectCompletedConversationInputs} from '../core/material-input.ts';
import {currentSessionMessageProjections} from '@deepseek-ai/dsh-session-format-catalog/message-projections';
import Persistence, { SessionAlreadyExistsError, SessionAlreadyOwnedError, SessionHandleClosedError, SessionPersistenceNotFoundError, SessionReadOnlyError, SessionPersistenceRevision, assertContiguous, assertStoredId, assertVersion, materializeAppendBatch, materializeCreateHeader, validateStoredEvents, type SessionHandle, type SessionAccess } from '@deepseek-ai/dsh-session-persistence';
import type { AgentSessionSnapshot, AgentSessionStore,NativeSessionReference,NativeCallLink } from '../core/agent-port.ts';
import {hashText} from '../core/text-hash.ts';
import {nativeSessionHeadersEqual} from '../core/agent-port.ts';
import {validateNativeSessionReference} from '../core/agent-session-storage.ts';
import {validateProductSessionEvents,validateProductEventData} from './native-session-format.ts';
import {createNativeFileSessionReader} from '../host/content-object-native.ts';
// Persistence also runs in the host without the worker's runtime composition.
// Load the official compaction vocabulary at this direct decoding boundary.
import type {} from '@deepseek-ai/dsh-compaction';

const requiredProductEvents=['yixu/model-request','yixu/model-response','yixu/model-not-dispatched','yixu/feedback','yixu/reading-check','yixu/terminal-result'] as const;
const vocabularyOwners=new Set<symbol>(),registeredProductEvents=new Set<string>();
declare module '@deepseek-ai/dsh-llm'{interface MessageSourceMap{'yixu-runtime':{kind:'yixu-runtime'};'yixu-dialogue-history':{kind:'yixu-dialogue-history';sourceEventSeq:number;completedThrough:number}}}

/** The caller certifies this closed business prefix (no open/unknown owner).
 * Its ended native turns may include earlier errors whose business outcome was
 * subsequently settled. Keep every utterance/error assistant, retire only task
 * material. An unended turn or the current task outside the boundary is kept. */
function closedPrefixDialoguePlans(events:readonly SessionEvent[],completedThrough:number):Map<number,string>{
  let turn:number|undefined;const ended=new Set<number>(),inputs:{key:number;text:string;turn:number}[]=[];
  for(const event of events){if(event.seq>=completedThrough)break;
    if(event.type==='turn/start')turn=event.data.turn;
    else if(event.type==='turn/end'){ended.add(event.data.turn);turn=undefined;}
    else if(event.type==='user/message'&&turn!==undefined&&event.data.source.kind==='yixu-runtime'&&event.data.content.length===1&&event.data.content[0].type==='text')inputs.push({key:event.seq,text:event.data.content[0].text,turn});
  }
  return projectCompletedConversationInputs(inputs.filter(input=>ended.has(input.turn)));
}
function dialogueHistoryMessage(text:string,seq:number,completedThrough:number){return createUserMessage({source:{kind:'yixu-dialogue-history',sourceEventSeq:seq,completedThrough},content:[{type:'text',text}]});}
function dialoguePrune(event:SessionEvent){if(event.type!=='user/message')throw Error('会话资料替换目标不是用户材料');const seq=event.seq;return{shadowedRange:{start:seq,end:seq},shadowedSeqs:[seq],shadowedTokenCount:estimateMessage(event.data)};}

/** Model-free, append-only projection. The source event and paid receipt stay
 * immutable; only the current DSH surface exchanges one node at a time. */
export function projectCompletedConversationSurface(session:Session,completedThrough:number):number{
  if(!Number.isSafeInteger(completedThrough)||completedThrough<1||completedThrough>session.seq)throw Error('会话资料投影缺少已完成前缀');
  const plans=closedPrefixDialoguePlans(session.snapshotEvents(),completedThrough);let count=0;
  for(const seq of [...session.surface.nodes]){const text=plans.get(seq);if(text===undefined)continue;const event=session.eventAt(seq)!;
    session.append('compaction/prune',dialoguePrune(event));
    session.append('user/message',dialogueHistoryMessage(text,seq,completedThrough),{surfaceOp:{op:'replace',startSeq:seq,endSeq:seq},sourceEventSeqs:[seq]});count++;
  }
  return count;
}
/** The official backend owns decoding, recovery and write leases. This layer
 * registers and validates only the application's required receipt events. */
export function installNativeProductSessionEvents(ctx:Context):()=>void{
  const persistence=ctx.get('sessionPersistence')!;
  const vocabulary=KNOWN_SESSION_EVENT_TYPES;if(!(vocabulary instanceof Set))throw Error('官方原生会话词表接口已变化，未放宽必需事件');
  const owner=Symbol('product-session-vocabulary'),original=persistence.open;
  for(const type of requiredProductEvents)if(!vocabulary.has(type)){vocabulary.add(type);registeredProductEvents.add(type);}
  vocabularyOwners.add(owner);
  persistence.open=async function(id,access,options){
    const handle=await original.call(persistence,id,access,options),read=handle.read;
    handle.read=async function(...args){const result=await read.apply(this,args);validateProductEventData(result.events);return result;};
    return handle;
  };
  let released=false;
  return()=>{if(released)return;released=true;persistence.open=original;vocabularyOwners.delete(owner);if(!vocabularyOwners.size){for(const type of registeredProductEvents)vocabulary.delete(type);registeredProductEvents.clear();}};
}

/** Match the installed Harness's own recovery of the confirmed prefix. The
 * suffix may already be durable from an earlier resume or be appended now.
 * It is adopted intact; application/request events are never inferred. */
export function reconcileNativeResumePrefix(session:Session,reference:NativeSessionReference):void{
  const confirmed=reference.eventCount;
  if(session.seq<confirmed)throw Error('原生日志低于领域已确认水位');
  if(session.seq===confirmed)return;
  const events=session.snapshotEvents(),prefix=events.slice(0,confirmed),closers=interruptedTurnClosers(prefix);
  const restored=Session.fromRestore(session.id,[...prefix,...closers],session.header,session.inheritedEventCount,'shared-frozen',currentSessionMessageProjections);
  const expected=restored.snapshotEvents(SessionLogOffset(confirmed)),actual=events.slice(confirmed);
  const officialOnly=actual.length===expected.length&&!actual.some((event,index)=>{
    const generated=expected[index];
    // End-of-seed uses the resume's actual clock; lifecycle repairs are deterministic.
    return JSON.stringify(event)!==JSON.stringify(generated.type==='session/end-seed'?{...generated,time:event.time}:generated);
  });
  if(!officialOnly){
    // A crash may leave an already durable dialogue projection after the last
    // domain watermark. Accept only exact deterministic replacements of a
    // previously closed prefix, interleaved with official resume markers.
    if(reference.closedEventCount!==confirmed)throw Error('原生已确认前缀后有未核实的新事件，原任务保持');
    const marker=expected.find(event=>event.type==='session/end-seed'),cache=new Map<number,Map<number,string>>();
    const plan=(boundary:number)=>{let value=cache.get(boundary);if(!value){value=closedPrefixDialoguePlans(events,boundary);cache.set(boundary,value);}return value;};
    for(let index=0;index<actual.length;index++){
      const event=actual[index];
      if(marker&&event.type==='session/end-seed'&&JSON.stringify(event)===JSON.stringify({...marker,seq:event.seq,time:event.time}))continue;
      if(event.type!=='compaction/prune')throw Error('原生前缀后不是已核会话投影，须核查原回执');
      const seq=event.data.shadowedRange.start,target=events[seq],next=actual[index+1],source=next?.type==='user/message'?next.data.source:undefined;
      const boundary=source?.kind==='yixu-dialogue-history'?source.completedThrough:confirmed;
      if(!Number.isSafeInteger(boundary)||boundary<1||boundary>confirmed||seq>=boundary||target?.type!=='user/message'||JSON.stringify(event.data)!==JSON.stringify(dialoguePrune(target)))throw Error('会话资料投影价格或完成边界不符');
      const text=plan(boundary).get(seq);if(text===undefined)throw Error('会话资料投影目标不是已完成的宿主材料');
      if(source?.kind==='yixu-dialogue-history'){
        const message=dialogueHistoryMessage(text,seq,boundary),expectedData={...message,id:next!.type==='user/message'?next!.data.id:message.id};
        if(next!.type!=='user/message'||source.sourceEventSeq!==seq||JSON.stringify(next!.data)!==JSON.stringify(expectedData)||JSON.stringify(next!.surfaceOp)!==JSON.stringify({op:'replace',startSeq:seq,endSeq:seq})||JSON.stringify(next!.sourceEventSeqs)!==JSON.stringify([seq]))throw Error('会话资料投影未保留原始交流，拒绝接管');
        index++;
      }else if(index+1<actual.length&&actual[index+1].type!=='session/end-seed')throw Error('会话资料投影缺少相邻替换，原任务保持');
      // A torn final prune is log-only. The next projection will issue a fresh
      // adjacent pair; it never treats this orphan as a completed replacement.
    }
  }
  reference.eventCount=session.seq;
  if(reference.closedEventCount===confirmed)reference.closedEventCount=session.seq;
}

/** Portable import creates a new physical file in the archive's isolated backend.
 * Only cwd changes. Each source can be reconstructed from its original header and
 * the unchanged append-only event prefix; call, message and domain identities stay exact. */
export async function relocateNativeSession(ctx:Context,input:{reference:NativeSessionReference;snapshot:AgentSessionSnapshot;projectDirectory:string;nativeRoot?:string}):Promise<NativeSessionReference>{
  const reference=structuredClone(input.reference),source=input.snapshot;
  validateNativeSessionReference(reference,reference.sessionId);
  if(!/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(input.projectDirectory))throw Error('便携会话重定位需要已核书籍工程绝对目录');
  if(JSON.stringify(source.header)!==JSON.stringify(reference.header)||source.events.length!==reference.eventCount)throw Error('便携会话缺少引用水位的完整原日志');
  const sourceHeader=materializeCreateHeader(source.header as SessionHeader);validateProductSessionEvents(sourceHeader,source.events as SessionEvent[]);
  for(const entry of reference.relocations??[]){const events=source.events.slice(0,entry.sourceEventCount),header=materializeCreateHeader(entry.sourceHeader as SessionHeader);
    if(await hashText(JSON.stringify({header:entry.sourceHeader,events}))!==entry.sourceSnapshotHash||await hashText(JSON.stringify({header:materializeCreateHeader({...header,delegationDepth:header.delegationDepth??0,cwd:entry.projectDirectory}),events}))!==entry.targetSnapshotHash)throw Error('便携会话既有重定位原件哈希不符');
  }
  const header=materializeCreateHeader({...sourceHeader,delegationDepth:sourceHeader.delegationDepth??0,cwd:input.projectDirectory}),snapshot={header,events:source.events};
  const stat=await ctx.get('sessionPersistence')!.stat(SessionId(reference.sessionId));
  if(stat){
    if(!nativeSessionHeadersEqual(stat.header,header))throw Error('目标原生会话已存在且归属不同，未改写原头');
    const assertPrefix=(events:readonly SessionEvent[])=>{for(let index=0;index<Math.min(events.length,source.events.length);index++)if(JSON.stringify(events[index])!==JSON.stringify(source.events[index]))throw Error('目标原生会话已存在且原事件不符，未覆盖');};
    let length:number;
    {await using reader=await ctx.get('sessionPersistence')!.open(SessionId(reference.sessionId),'read');if(!nativeSessionHeadersEqual(reader.header,header))throw Error('目标原生会话头已变化');const original=await reader.read();assertPrefix(original.events);length=original.events.length;}
    if(length<source.events.length){
      await using writer=await ctx.get('sessionPersistence')!.open(SessionId(reference.sessionId),'write');
      if(!nativeSessionHeadersEqual(writer.header,header))throw Error('目标原生会话头已变化');
      const current=await writer.read();assertPrefix(current.events);
      if(current.events.length<source.events.length){await writer.append(source.events.slice(current.events.length) as SessionEvent[]);await writer.flush();}
    }
  }
  else{await using writer=await ctx.get('sessionPersistence')!.create(header);await writer.append(source.events as SessionEvent[]);await writer.flush();}
  if(JSON.stringify(header)!==JSON.stringify(source.header)){reference.relocations=[...(reference.relocations??[]),{sourceHeader:structuredClone(source.header),sourceEventCount:source.events.length,sourceSnapshotHash:await hashText(JSON.stringify(source)),targetSnapshotHash:await hashText(JSON.stringify(snapshot)),projectDirectory:input.projectDirectory,reason:'book-project-relocation-v1'}];reference.header=header;}
  validateNativeSessionReference(reference,reference.sessionId);return reference;
}

/** Official-v4 core coordinate fields; unknown plugin events require their own migration. */
const migrationCoreTypes=new Set(['agent/inbox/spliced','turn/start','turn/end','step/start','step/end','user/message','developer/message','system/message','assistant/message','assistant/attempt','tool/call','tool/result','request/header','request/context','session/end-seed']);
export async function migrateProductSession(id:string,source:AgentSessionSnapshot,projectDirectory?:string):Promise<{snapshot:AgentSessionSnapshot;reference:NativeSessionReference}>{
  const original=validateSnapshot(SessionId(id),source),mapping:(number|null)[]=[],events:SessionEvent[]=[];
  for(const event of original.events){if(ownTypes.has(event.type))mapping.push(null);else{if(!migrationCoreTypes.has(event.type))throw Error('原会话事件须先明确其v4坐标迁移：'+event.type);mapping.push(events.length);events.push(structuredClone(event));}}
  const mapped=(seq:number)=>{const next=mapping[seq];if(!Number.isSafeInteger(seq)||seq<0||next===null||next===undefined)throw Error('原会话坐标指向被剥离或缺失事件');return next;};
  for(let index=0;index<events.length;index++){const event=events[index] as unknown as {seq:number;sourceEventSeqs?:number[];surfaceOp?:string|{op:string;startSeq:number;endSeq:number};type:string;data:{headerSeq?:number}};event.seq=index;
    if(event.sourceEventSeqs)event.sourceEventSeqs=event.sourceEventSeqs.map(mapped);
    if(event.surfaceOp&&typeof event.surfaceOp==='object')event.surfaceOp={...event.surfaceOp,startSeq:mapped(event.surfaceOp.startSeq),endSeq:mapped(event.surfaceOp.endSeq)};
    if(event.type==='developer/message'&&event.data.headerSeq!==undefined)event.data.headerSeq=mapped(event.data.headerSeq);
  }
  if(projectDirectory&&!/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(projectDirectory))throw Error('书籍工程归属迁移需要已核绝对目录');
  const headerMapping=projectDirectory&&original.header.cwd!==projectDirectory?{...(original.header.cwd?{sourceCwd:original.header.cwd}:{}),projectDirectory,reason:'book-project-v1' as const}:undefined;
  const header=headerMapping?materializeCreateHeader({...original.header,cwd:headerMapping.projectDirectory}):original.header;
  validateStoredEvents(header,events);const snapshot={header,events},calls:NativeCallLink[]=[],feedbacks:NativeSessionReference['feedbacks']=[];let boundary=0;
  for(const event of original.events){if(event.type==='yixu/model-request')calls.push({...event.data,boundarySeq:boundary});else if(event.type==='yixu/model-response'){const call=[...calls].reverse().find(call=>call.agentCallId===event.data.agentCallId);if(!call)throw Error('原回执缺少领域调用意图');call.requestId=event.data.requestId;}else if(event.type==='yixu/model-not-dispatched'){const call=[...calls].reverse().find(call=>call.agentCallId===event.data.agentCallId);if(!call)throw Error('原未派发证明缺少调用');call.notDispatched=true;}else if(event.type==='yixu/feedback')feedbacks.push({...event.data});if(mapping[event.seq]!==null)boundary++;}
  const reference:NativeSessionReference={kind:'dsh-native-session-v1',backend:'jsonl',sessionId:id,formatVersion:4,header,eventCount:events.length,calls,feedbacks,migration:{sourceSnapshotHash:await hashText(JSON.stringify(source)),nativeSnapshotHash:await hashText(JSON.stringify(snapshot)),sourceEventCount:source.events.length,eventSeqMap:mapping,...(headerMapping?{headerMapping}:{})}};
  return{snapshot,reference};
}

/** Inspection uses official events and the domain's required receipt links, never ignorable metadata. */
export function inspectNativeSession(snapshot:AgentSessionSnapshot,reference:NativeSessionReference){
  const events=snapshot.events as SessionEvent[],delivered=new Set<string>(),pending=new Set<string>();const inbox:{'next-turn':string[];'next-step':string[]}={'next-turn':[],'next-step':[]};
  for(const event of events){if(event.type==='user/message')delivered.add(event.data.id);else if(event.type==='agent/inbox/spliced'){const data=event.data;inbox[data.target].splice(data.start,data.removedCount??0,...data.inserted.map(message=>message.id));}}
  for(const id of [...inbox['next-turn'],...inbox['next-step']])pending.add(id);
  return{calls:reference.calls.map((call,index)=>{const next=reference.calls[index+1]?.boundarySeq??events.length,range=call.resultSeq!==undefined?[events[call.resultSeq]]:events.slice(call.boundarySeq,next),feedback=reference.feedbacks.filter(item=>item.requestId===call.requestId);return{...call,notDispatched:call.notDispatched===true,assistantRecorded:range.some(event=>event&&(call.purpose==='compaction'?event.type==='compaction/summary':event.type==='assistant/message'&&event.data.interrupted!==true)),feedbackRecorded:feedback.some(item=>delivered.has(item.messageId)),feedbackPending:feedback.some(item=>pending.has(item.messageId))};})};
}

export function createNativeSessionReader(ctx:Context,root?:string){const fileReader=root?createNativeFileSessionReader(root):undefined;return async(reference:NativeSessionReference):Promise<AgentSessionSnapshot>=>{
  if(fileReader)return fileReader(reference);
  const persistence=ctx.get('sessionPersistence')!,stat=await persistence.stat(SessionId(reference.sessionId));if(!stat||!nativeSessionHeadersEqual(stat.header,reference.header))throw Error('原生会话头或引用不符');
  await using reader=await persistence.open(SessionId(reference.sessionId),'read');const read=await reader.read();if(read.events.length<reference.eventCount)throw Error('原生会话日志低于领域已确认水位');return{header:structuredClone(reference.header),events:structuredClone(read.events) as unknown[]};
};}

/** A fixed native prefix for a consistent backup; no events beyond its domain watermark. */
export function createNativeSessionStreamReader(ctx:Context,root?:string){const fileReader=root?createNativeFileSessionReader(root):undefined;return async(reference:NativeSessionReference):Promise<{header:unknown;events:AsyncIterable<unknown>}>=>{
  if(fileReader){const captured=await fileReader(reference);return{header:captured.header,events:(async function*(){yield* captured.events;})()};}
  const captured=structuredClone(reference),stat=await ctx.get('sessionPersistence')!.stat(SessionId(captured.sessionId));
  if(!stat||!nativeSessionHeadersEqual(stat.header,captured.header))throw Error('原生会话头或引用不符');
  return{header:structuredClone(captured.header),events:(async function*(){
    await using reader=await ctx.get('sessionPersistence')!.open(SessionId(captured.sessionId),'read');
    if(!nativeSessionHeadersEqual(reader.header,captured.header))throw Error('原生会话头已变化');
    let offset=0;while(offset<captured.eventCount){const requested=Math.min(256,captured.eventCount-offset),batch=await reader.read(offset,requested);if(batch.events.length!==requested||batch.events.some((event,index)=>event.seq!==offset+index))throw Error('原生会话日志低于领域已确认水位或序列不连续');for(const event of batch.events)yield event;offset+=batch.events.length;}
  })()};
};}

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'yixu/model-request': { agentCallId: string; ordinal: number; purpose?:string;taskExecutionId?:string };
    'yixu/model-response': { agentCallId: string; requestId: string };
    'yixu/model-not-dispatched': { agentCallId:string };
    'yixu/feedback': { requestId: string; messageId: string };
    'yixu/reading-check': { signature:string; authorization:string; requestId:string; toolCallId:string };
    'yixu/terminal-result': {agentCallId:string;requestId?:string;operationKey:string;accepted:boolean};
  }
}

const ownTypes = new Set(['yixu/model-request', 'yixu/model-response', 'yixu/model-not-dispatched', 'yixu/feedback','yixu/terminal-result']);
function validateSnapshot(id: SessionId, value: AgentSessionSnapshot): { header: SessionHeader; events: SessionEvent[] } {
  const header = materializeCreateHeader(value.header as SessionHeader);
  assertStoredId(id, header); assertVersion(header);
  const events = materializeAppendBatch(value.events as SessionEvent[]) as SessionEvent[];
  assertContiguous(id, events, 0);
  validateProductSessionEvents(header,events);
  return { header, events };
}

export function inspectAgentSession(snapshot: AgentSessionSnapshot) {
  const calls: { agentCallId: string; ordinal: number; purpose?:string; requestId?: string; assistantRecorded: boolean; feedbackRecorded: boolean; feedbackPending:boolean;notDispatched:boolean }[] = [];
  const feedbacks:{requestId:string;messageId:string}[]=[],delivered=new Set<string>();
  const inbox:{'next-turn':string[];'next-step':string[]}={'next-turn':[],'next-step':[]};
  let active: typeof calls[number] | undefined;
  for (const raw of snapshot.events) {
    const event = raw as SessionEvent;
    if (event.type === 'yixu/model-request') { active = { ...event.data, assistantRecorded: false, feedbackRecorded: false,feedbackPending:false,notDispatched:false }; calls.push(active); }
    else if (event.type === 'yixu/model-response') {
      const call = [...calls].reverse().find(call => call.agentCallId === event.data.agentCallId);
      if (call) { call.requestId = event.data.requestId; active = call; }
    } else if (event.type === 'assistant/message' && event.data.interrupted!==true && active) active.assistantRecorded = true;
    else if(event.type==='compaction/summary'&&active?.purpose==='compaction')active.assistantRecorded=true;
    else if(event.type==='yixu/model-not-dispatched'){const call=[...calls].reverse().find(call=>call.agentCallId===event.data.agentCallId);if(call)call.notDispatched=true;}
    else if (event.type === 'yixu/feedback') feedbacks.push(event.data);
    else if(event.type==='user/message')delivered.add(event.data.id);
    else if(event.type==='agent/inbox/spliced'){const data=event.data;inbox[data.target].splice(data.start,data.removedCount??0,...data.inserted.map(message=>message.id));}
  }
  const pending=new Set([...inbox['next-turn'],...inbox['next-step']]);
  for(const feedback of feedbacks){const call=[...calls].reverse().find(call=>call.requestId===feedback.requestId);if(call){call.feedbackRecorded ||= delivered.has(feedback.messageId);call.feedbackPending ||= pending.has(feedback.messageId);}}
  return { calls };
}

/** One kernel service routes native events to the owning private product store. */
export class ProductSessionPersistence extends Persistence {
  private bindings = new Map<string, AgentSessionStore>();
  private writers = new Map<string, ProductHandle>();
  private opening = new Set<string>();
  private handles = new Set<ProductHandle>();
  constructor(ctx: Context) {
    super(ctx);
    ctx.on('session/event', (session, event) => { this.writers.get(session.id)?.route(event); });
    ctx.on('session/flush', session => this.flushSession(session.id));
    ctx.effect(() => () => this.flush());
  }
  bind(id: string, store: AgentSessionStore): () => void {
    if (this.bindings.has(id)) throw Error('同一Agent任务已有活动运行器');
    this.bindings.set(id, store);
    return () => { this.bindings.delete(id); };
  }
  private store(id: string) { const store = this.bindings.get(id); if (!store) throw Error('Agent任务未绑定保存端口'); return store; }
  async create(header: SessionHeader): Promise<SessionHandle> {
    const store = this.store(header.id);
    if (this.writers.has(header.id) || this.opening.has(header.id)) throw new SessionAlreadyOwnedError(header.id);
    this.opening.add(header.id);
    try {
      if (await store.load(header.id)) throw new SessionAlreadyExistsError(header.id);
      const value = { header: materializeCreateHeader(header), events: [] };
      await store.create(header.id, value);
      return this.openHandle(header.id, 'write', store, value);
    } finally { this.opening.delete(header.id); }
  }
  async open(id: SessionId, access: SessionAccess): Promise<SessionHandle> {
    const store = this.store(id);
    if (access === 'write' && (this.writers.has(id) || this.opening.has(id))) throw new SessionAlreadyOwnedError(id);
    if (access === 'write') this.opening.add(id);
    try {
      const value = await store.load(id); if (!value) throw new SessionPersistenceNotFoundError(id);
      return this.openHandle(id, access, store, value);
    } finally { if (access === 'write') this.opening.delete(id); }
  }
  private openHandle(id: SessionId, access: SessionAccess, store: AgentSessionStore, value: AgentSessionSnapshot) {
    const validated = validateSnapshot(id, value);
    if (validated.header.isSeeded) throw Error('产品任务不支持未经声明的fork继承');
    const handle = new ProductHandle(id, access, store, validated, () => { this.handles.delete(handle); if (this.writers.get(id) === handle) this.writers.delete(id); });
    this.handles.add(handle); if (access === 'write') this.writers.set(id, handle);
    return handle;
  }
  async flushSession(id: string) { await this.writers.get(id)?.flush(); }
  async flush() { const results = await Promise.allSettled([...this.handles].filter(handle => handle.access === 'write').map(handle => handle.flush())); const failed = results.filter(result => result.status === 'rejected'); if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Agent会话保存未完成'); }
  async stat(id: SessionId) { const value = await this.store(id).load(id); return value ? { header: validateSnapshot(id, value).header, revision: SessionPersistenceRevision(String(value.events.length)), eventCount: value.events.length } : undefined; }
  async list() { const values = await Promise.all([...this.bindings.keys()].map(id => this.stat(SessionId(id)))); return values.filter(value => value !== undefined); }
}

class ProductHandle implements SessionHandle {
  readonly inheritedEventCount = SessionLogOffset(0);
  readonly header: SessionHeader;
  private events: SessionEvent[];
  private buffered: SessionEvent[] = [];
  private draining?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private paused = false;
  private failure: unknown;
  private closed = false;
  private closing?: Promise<void>;
  readonly id:SessionId;readonly access:SessionAccess;private store:AgentSessionStore;private release:()=>void;
  constructor(id: SessionId, access: SessionAccess, store: AgentSessionStore, snapshot: { header: SessionHeader; events: SessionEvent[] }, release: () => void) { this.id=id;this.access=access;this.store=store;this.release=release;this.header = snapshot.header; this.events = snapshot.events; }
  private assertOpen(operation: string) { if (this.closed || this.closing) throw new SessionHandleClosedError(this.id, operation); }
  // Mechanism adapted from DeepSeek Harness session-persistence-jsonl/storage.ts
  // (MIT, copyright 2026 DeepSeek; see third_party/deepseek-harness/LICENSE).
  // Source: deepseek-ai/deepseek-harness commit
  // 21638c56315ae6a2b552d6091945d3144c9af32e. Routed events remain
  // owned by this handle after failure; only an explicit barrier retries them.
  route(event: SessionEvent) {
    if (this.closed) return;
    this.buffer([event]);
    if (this.timer !== undefined || this.paused || this.draining) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.drain(false).catch(() => {}); }, 200);
  }
  async read(offset = 0, length = Number.MAX_SAFE_INTEGER) {
    this.assertOpen('read');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) throw TypeError('Agent会话读取范围无效');
    await this.draining?.catch(() => {});
    const latest=await this.store.load(this.id);
    if(latest){const validated=validateSnapshot(this.id,latest);if(validated.events.length>this.events.length)this.events=validated.events;}
    return { events: structuredClone(this.events.slice(offset, offset + length)), eventState: 'detached' as const };
  }
  private buffer(events: readonly SessionEvent[]) {
    const batch = materializeAppendBatch(events) as SessionEvent[];
    assertContiguous(this.id, batch, this.events.length + this.buffered.length);
    this.buffered.push(...batch);
  }
  append(events: readonly SessionEvent[]): Promise<void> {
    this.assertOpen('append'); if (this.access !== 'write') throw new SessionReadOnlyError(this.id, 'append');
    this.buffer(events);
    return this.drain(false).then(async () => { if (this.buffered.length) await this.drain(false); });
  }
  private drain(retry: boolean): Promise<void> {
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.draining) return retry ? this.draining.catch(() => {}).then(() => this.drain(true)) : this.draining;
    if (this.paused && !retry) return Promise.reject(this.failure);
    this.paused = false;
    const drain = async () => {
      while (this.buffered.length) {
        // Keep the in-flight prefix in the buffer until durable acknowledgement.
        // New events can safely arrive while this single writer is awaiting IO.
        const batch = this.buffered.slice();
        try { await this.store.append(this.id, this.events.length, batch); }
        catch (error) { this.paused = true; this.failure = error; throw error; }
        this.events.push(...batch); this.buffered.splice(0, batch.length);
      }
      this.failure = undefined;
    };
    const pending = drain().finally(() => { this.draining = undefined; if (this.buffered.length && !this.paused && !this.closed && !this.closing && this.timer === undefined) this.timer = setTimeout(() => { this.timer = undefined; void this.drain(false).catch(() => {}); }, 200); });
    this.draining = pending; void pending.catch(() => {}); return pending;
  }
  async flush() { this.assertOpen('flush'); if (this.access !== 'write') throw new SessionReadOnlyError(this.id, 'flush'); await this.drain(true); }
  close() { return this.closing ??= (async () => { try { if (this.access === 'write') do { await this.drain(true); } while (this.buffered.length); } finally { this.closed = true; this.release(); } })(); }
  [Symbol.asyncDispose]() { return this.close(); }
}

/** Native events are deeply frozen. Inspection owns only a cheap outer array. */
export function nativeSessionSnapshot(session: Session): AgentSessionSnapshot { return { header: structuredClone(session.header), events: [...session.snapshotEvents()] as unknown[] }; }
