import {readingDelivery,ReadingDeliveryProjection} from './reading-delivery.ts';
import type {AgentRunner} from '../core/agent-port.ts';
import type {WorkbenchEnvironment,WorkbenchDataStore} from './environment.ts';
import {LocalApplication} from '../core/application.ts';
import {ReadingRuntime,restoreReadingEngine} from '../core/runtime.ts';
import {ChatModel,ModelOutputError} from '../core/model.ts';
import {modelEnvelopeError,ModelRequestError,ModelReceiptSaveError} from '../core/errors.ts';
import {initialState} from '../core/state.ts';
import {restoreBackup,restoreBackupState,writeBackupPartnerAvatars} from '../core/backup.ts';
import {bookLength,readingStart,importBook,covers} from '../core/books.ts';
import {modeProfile} from '../core/reading-mode.ts';
import {DEFAULT_READING_WINDOW_CHARS} from '../core/scene-scheduling.ts';
import type {ReadingEngine} from '../core/engine.ts';
import {decideReadingRecovery} from '../core/recovery-capabilities.ts';
import type {Service,State,Chat,TerminatedMaintenanceResume,ReadingObservationSaved,ReadingRecoveryTarget,ReadingRecoveryExecution} from '../core/types.ts';
import type {WorkbenchClient,WorkbenchSnapshot,WorkbenchMode,WorkbenchSession,WorkbenchSettings,WorkbenchService,WorkbenchSource,WorkbenchPage,WorkbenchEvent,WorkbenchDraft,WorkbenchSourceCapture,WorkbenchSourceReceipt} from './contract.ts';

import {WorkbenchEvents,latestReadingObservationSaved,workbenchSourceIdentity,sameWorkbenchSource} from './events.ts';
import type {Observations} from './events.ts';
import type {ObservationMetadata,ObservationChanges} from './observation-store.ts';
import {validateWorkbenchDraft,takeBackupWorkbenchMetadata} from './observation-store.ts';
import {OfflineModel,offlineGuide} from './offline-model.ts';
import {chapterReadingRange,chapterBodyCoverage,isVolumeHeading} from './reading-layout.ts';
import {archiveBudget,estimateAutoReading as estimateReading,validateAutoReading,autoReadingChapters} from './auto-reading.ts';
import type {AutoReadingState,AutoReadingSettings,WorkbenchBudget} from './contract.ts';
import {chapterContentEnd} from '../core/books.ts';
import {availableRecovery,recoveryActionLabel} from './activity-presentation.ts';
import {currentDraftKey,inheritedDrafts} from './draft-versions.ts';
import {bookVersionPrefixLength} from '../core/book-versions.ts';
import {createModelStreamPresentation} from './model-stream-presentation.ts';

type Metadata=ObservationMetadata;
const defaultPageChars=DEFAULT_READING_WINDOW_CHARS;
export function workbenchPageNumbers(end:number,bodyStart:number,textLength:number,pageChars:number){
 const totalPages=Math.max(1,Math.ceil((textLength-bodyStart)/pageChars));
 return {pageNumber:Math.min(totalPages,Math.max(1,Math.ceil((end-bodyStart)/pageChars))),totalPages};
}
const offlineService:Service={id:'custom-workbench-offline',name:'界面演练 · 固定技术回应',baseUrl:'https://workbench.invalid/v1',model:'offline-ui-rehearsal',contextLimit:1000000,maxOutput:4096,effort:'high',enabled:true,secretRef:'',fallback:false,thinking:'none'};
export function initialWorkbenchState(mode:WorkbenchMode){const state=initialState();state.settings.readingEffort='high';state.settings.defaultQuiet=false;if(mode==='offline'){state.settings.services=[{...offlineService}];state.settings.serviceId=offlineService.id;state.settings.tokenLimit=20000000;}return state;}
const visibleReply=(chat:Chat)=>chat.role==='assistant'&&chat.presentation!=='paragraph'&&!chat.excluded&&(!chat.readingReaction||chat.readingReaction.status==='delivered');
const recoveryTargetKey=(target:ReadingRecoveryTarget)=>JSON.stringify(target.kind==='question'?['question',target.questionId,target.requestId??null]:target.kind==='scene'?['scene',target.bookId,target.requestId]:['maintenance',target.jobId,target.requestId??null]);
export class WorkbenchController implements WorkbenchClient {
 private constructor(private environment:WorkbenchEnvironment) {}
 private bridge<T>(method:string,input:unknown={},signal?:AbortSignal,onStream?:(delta:import('../core/provider-stream.ts').ModelStreamDelta)=>void):Promise<T>{return this.environment.bridge<T>(method,input,signal,onStream);}
 private session!:WorkbenchSession;private store!:WorkbenchDataStore;private engine!:ReadingEngine;private runtime!:ReadingRuntime;private application!:LocalApplication;private harness!:AgentRunner & {dispose?():Promise<void>};
 private log!:WorkbenchEvents;private unsubscribe?:()=>void;private listeners=new Set<()=>void>();private cached!:WorkbenchSnapshot;
 private observationCursor=0;private observationWrites:Promise<void>=Promise.resolve();private observationQuestions=new Set<string>();
 private connectionTarget?:string;
 private drafts:Record<string,WorkbenchDraft>={};private dirtyDrafts=new Map<string,WorkbenchDraft|null>();
 takeConnectionTarget(){const id=this.connectionTarget;this.connectionTarget=undefined;return id;}
 private projectedLog?:WorkbenchEvents;private projectedEventCount=0;private logEvents:WorkbenchEvent[]=[];private logRatings:WorkbenchSnapshot['ratings']={};private logTimings:WorkbenchSnapshot['timings']={};private dirtyRatings=new Set<string>();private dirtyTimings=new Set<string>();
 private selectedBookId='';private pagePosition=0;private pageChars=defaultPageChars;private services:WorkbenchService[]=[];private sources:WorkbenchSource[]=[];private historicalSourcesLoaded=false;
 private error='';private notice='';private importedHistory?:string;private visibleObservations=new Map<string,Promise<void>>();private stopRequest?:Promise<void>;private busyAction=false;private disposed=false;private saveScheduled=false;private selectedService?:WorkbenchService;
 private autoReading:AutoReadingState={phase:'stopped'};private ledgerBudget?:WorkbenchBudget;private autoEpoch=0;
 private deliveryProjection=new ReadingDeliveryProjection();private observedChats?:State['chats'];
 private archiveBudgetInputs?:unknown[];private projectedArchiveBudget?:WorkbenchBudget;
 private streamingReplies=new Map<string,NonNullable<WorkbenchSnapshot['streamingReplies']>[number]&{startedAt:number}>();
 private following=false;private sourceVisible=false;private followEpoch=0;private lastVisible='';private navigationRevision=0;
 private sourceOwner?:{producerId:string;epoch:string;sequence:number;readingMode?:WorkbenchSourceCapture['readingMode']};
 private sourceRegistry=new Map<string,{producerId:string;epoch:string;sequence:number;readingMode?:WorkbenchSourceCapture['readingMode']}>();
 private sourceConnectionEpoch=crypto.randomUUID();
 private observationSaved?:ReadingObservationSaved;private exportPrepared?:WorkbenchSnapshot['exportPrepared'];
 private pageLoading=false;private pageEpoch=0;private desiredPage='';private navigationDirection=0;private chapterCache=new Map<string,string>();private chapterLoads=new Map<string,Promise<void>>();private chapterFailures=new Set<string>();private pureVolumeHeadings=new Map<string,Set<number>>();private visibleRange?:{start:number;end:number};
 private lastFlow='';private seenChats=new Set<string>();private pendingAsks:Array<{id:string;action:WorkbenchEvent;before:Set<string>;bookId:string;text:string}>=[];private readingActions=0;
 static async create(environment:WorkbenchEnvironment){if(!environment)throw Error('工作台执行须由伴读宿主注入');const controller=new WorkbenchController(environment),active=environment.initialArchiveId?environment.sessions.available().find(s=>s.id===environment.initialArchiveId):environment.sessions.active()??environment.sessions.available()[0];if(environment.initialArchiveId&&!active)throw Error('指定阅读存档尚未完成迁移，未建立空档替代');if(active)await controller.attach(active);else await controller.loadNew(environment.developerMode===false?'live':'offline');await controller.refreshServices();if(environment.browserEvents&&typeof window!=='undefined')window.addEventListener('storage',controller.sessionMetadataChanged);return controller;}
 private sessionMetadataChanged=()=>{const metadata=this.environment.sessions.list().find(session=>session.id===this.session?.id);if(!metadata?.archivedAt||this.session.archivedAt)return;this.session=metadata;this.following=false;this.followEpoch++;this.engine.sourceActive(false);void this.engine.stopReadingSafely().catch(error=>{this.error=(error as Error).message;this.publish();});this.notice='此存档已归档，停止新增处理；原记录保留，可在历史归档中导出。';this.publish();};
 getSnapshot=()=>this.cached;
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
 private get service(){return this.engine.state.settings.services.find(s=>s.id===this.engine.state.settings.serviceId)!;}
 private getSettings():WorkbenchSettings{const service=this.service;return {serviceId:service?.id,thinking:service?.thinking,temperature:service?.temperature,topP:service?.topP,baseUrl:service?.baseUrl??'',model:service?.model??'',maxOutput:service?.maxOutput??4096,tokenLimit:this.engine.state.settings.tokenLimit,contextLimit:service?.contextLimit??200000,effort:service?.effort??'high',pageChars:this.pageChars};}
 private get foregroundService(){return this.engine.state.partners.find(p=>p.id===this.engine.state.partnerId)?.modelService;}
 private serviceReady(service:Service|undefined){return !!service?.enabled&&this.services.some(s=>s.scope==='workbench'&&s.id===service.id&&s.hasKey);}
 private get modelReady(){return !this.session.archivedAt&&(this.session.mode==='offline'||this.serviceReady(this.foregroundService));}
 private get backgroundModelReady(){return !this.session.archivedAt&&(this.session.mode==='offline'||this.serviceReady(this.service));}
 private currentBudget(committed?:State):WorkbenchBudget{
  if(this.ledgerBudget)return this.ledgerBudget;
  if(!committed)return archiveBudget(this.engine.state);
  const inputs=[committed.usage,committed.settings.tokenLimit];
  if(!this.archiveBudgetInputs||inputs.some((input,index)=>input!==this.archiveBudgetInputs![index])){this.projectedArchiveBudget=archiveBudget(committed);this.archiveBudgetInputs=inputs;}
  return this.projectedArchiveBudget!;
 }
 private inheritBookDrafts(bookId:string){
  const book=this.application.snapshot.state.books.find(book=>book.id===bookId);if(!book)return;
  const added=inheritedDrafts(book,this.drafts);if(!Object.keys(added).length)return;
  this.drafts={...this.drafts,...added};for(const [key,draft]of Object.entries(added))this.dirtyDrafts.set(key,draft);this.persistMetadata();
 }
 private currentAutoReadingSettings(){
  const settings=this.autoReading.settings;if(!settings)return;
  const book=this.engine.state.books.find(book=>book.id===settings.bookId);if(!book||bookVersionPrefixLength(book,settings.version)===undefined)return;
  const current={...settings,version:book.version};validateAutoReading(current,book);this.autoReading={...this.autoReading,settings:current};if(settings.version!==current.version)this.persistMetadata();
 }
 private page():WorkbenchPage|undefined {
  const book=this.engine.state.books.find(b=>b.id===this.selectedBookId);if(!book)return;
  const headings=this.pureVolumeHeadings.get(book.version)??new Set<number>();
  const section=chapterReadingRange(book.chapters,readingStart(book),this.pagePosition,bookLength(book),headings);if(!section)return;
  const {chapter,start,end,position,previousChapterStart,nextChapterStart,firstReadingSection}=section;
  const key=JSON.stringify([book.id,book.version,start,end]);this.desiredPage=key;
  const text=this.chapterCache.get(key);if(text===undefined){this.pageLoading=!this.chapterFailures.has(key);if(this.pageLoading)this.loadChapter(book.id,book.version,start,end,chapter.index,chapter.title);return;}
  this.pageLoading=false;
  const {coverage,authorized}=chapterBodyCoverage(text,start,chapter.title,book);
  return {bookId:book.id,version:book.version,start,end,position,firstReadingSection,navigationRevision:this.navigationRevision,previousChapterStart,nextChapterStart,text,chapterIndex:chapter.index,chapterTitle:chapter.title,pageNumber:1,totalPages:1,authorized,prepared:coverage.status==='complete',coverage};
 }
 private loadChapter(bookId:string,version:string,start:number,end:number,index:number,title:string){
  const key=JSON.stringify([bookId,version,start,end]);if(this.chapterLoads.has(key))return;
  const application=this.application,epoch=this.pageEpoch;
  const work=application.command('readBookRange',bookId,{start,end}).then(result=>{
   if(this.disposed||this.application!==application||epoch!==this.pageEpoch)return;
   if(result.version!==version||result.start!==start||result.end!==end||result.text.length!==end-start)throw Error('本章正文版本或范围不符，未显示不完整原文');
   if(isVolumeHeading(title)&&result.text.trim()===title){const skipped=this.pureVolumeHeadings.get(version)??new Set<number>();skipped.add(index);this.pureVolumeHeadings.set(version,skipped);if(this.desiredPage===key&&this.navigationDirection<0){const book=this.engine.state.books.find(b=>b.id===bookId&&b.version===version),prior=book?.chapters.filter(c=>c.end<=start&&!skipped.has(c.index)).at(-1);if(prior)this.pagePosition=Math.max(readingStart(book!),prior.start);}}
   else{this.chapterCache.delete(key);this.chapterCache.set(key,result.text);while(this.chapterCache.size>3||this.chapterCache.size>1&&[...this.chapterCache.values()].reduce((n,text)=>n+text.length,0)>64000)this.chapterCache.delete(this.chapterCache.keys().next().value!);}
   this.pageLoading=false;this.publish();
   // Reading adjacent original text does not grant model permission. Keep the
   // normal three-chapter cache warm while the current chapter is displayed.
   if(this.desiredPage===key){const book=this.engine.state.books.find(book=>book.id===bookId&&book.version===version);if(book)for(const direction of [-1,1]){const neighbor=chapterReadingRange(book.chapters,readingStart(book),direction<0?start-1:end,bookLength(book),this.pureVolumeHeadings.get(version)??new Set());if(!neighbor||neighbor.start===start)continue;const nextKey=JSON.stringify([bookId,version,neighbor.start,neighbor.end]);if(!this.chapterCache.has(nextKey)&&!this.chapterFailures.has(nextKey))this.loadChapter(bookId,version,neighbor.start,neighbor.end,neighbor.chapter.index,neighbor.chapter.title);}}
  }).catch(error=>{if(this.disposed||this.application!==application||epoch!==this.pageEpoch)return;this.chapterFailures.add(key);if(this.desiredPage===key){this.pageLoading=false;this.error='本章正文未载入：'+(error as Error).message;this.publish();}}).finally(()=>{if(this.chapterLoads.get(key)===work)this.chapterLoads.delete(key);});
  this.chapterLoads.set(key,work);
 }
 private publish(){
  if(!this.application||this.disposed)return;
  if(this.projectedLog!==this.log){this.projectedLog=this.log;this.logEvents=structuredClone(this.log.data.events.slice(-80));this.logRatings=structuredClone(this.log.data.ratings);this.logTimings=structuredClone(this.log.data.timings);this.dirtyRatings.clear();this.dirtyTimings.clear();}
  else{
   if(this.log.data.events.length!==this.projectedEventCount)this.logEvents=structuredClone(this.log.data.events.slice(-80));
   if(this.dirtyRatings.size){const next={...this.logRatings};for(const id of this.dirtyRatings)if(this.log.data.ratings[id])next[id]=structuredClone(this.log.data.ratings[id]);this.logRatings=next;this.dirtyRatings.clear();}
   if(this.dirtyTimings.size){const next={...this.logTimings};for(const id of this.dirtyTimings)if(this.log.data.timings[id])next[id]=structuredClone(this.log.data.timings[id]);this.logTimings=next;this.dirtyTimings.clear();}
  }
  const selectedServiceId=this.service?.id;
  this.projectedEventCount=this.log.data.events.length;
  const prior=this.cached,app=this.application.snapshot;
  this.cached={sessionId:this.session.id,mode:this.session.mode,sessions:this.environment.sessions.list(),app,selectedBookId:this.selectedBookId,book:app.state.books.find(b=>b.id===this.selectedBookId),page:this.page(),events:this.logEvents,ratings:this.logRatings,timings:this.logTimings,drafts:this.drafts,settings:this.getSettings(),selectedService:this.selectedService ? {...this.selectedService}:undefined,services:[...this.services],sources:[...this.sources],hasKey:this.services.some(s=>s.scope==='workbench'&&s.id===selectedServiceId&&s.hasKey),busyAction:this.busyAction,error:this.error,notice:this.notice,coreLabel:'阅读、交流与伙伴理解',importedHistory:this.importedHistory,following:this.following,modelReady:false,historicalSourcesLoaded:this.historicalSourcesLoaded,sessionArchived:!!this.session.archivedAt};
  const committed=this.store.readProjectionState?.(),ranges=this.autoReading.startPosition!==undefined&&this.autoReading.targetPosition!==undefined?[{start:this.autoReading.startPosition,end:this.autoReading.targetPosition}]:undefined;
  this.cached.readingDelivery=app.projectionPending?prior?.readingDelivery:committed?this.deliveryProjection.read(committed,this.selectedBookId,this.autoReading.startedAt,this.logTimings,ranges):readingDelivery(this.engine.state,this.selectedBookId,this.autoReading.startedAt,this.logTimings,ranges);this.cached.autoReading=structuredClone(this.autoReading);this.cached.budget=app.projectionPending?prior?.budget:this.currentBudget(committed);this.cached.streamingReplies=[...this.streamingReplies.values()].map(value=>({...value}));
  this.cached.following=this.following;this.cached.pageLoading=this.pageLoading;this.cached.sourceConnectionEpoch=this.sourceConnectionEpoch;this.cached.sourceOwner=this.sourceOwner?{producerId:this.sourceOwner.producerId,epoch:this.sourceOwner.epoch}:undefined;this.cached.modelReady=this.modelReady;this.cached.backgroundModelReady=this.backgroundModelReady;
  const identity=this.engine.readingObservationIdentity,book=this.cached.book,saved=this.observationSaved;
  this.cached.readingObservation={sourceVisible:this.sourceVisible,visibleRange:this.visibleRange?{...this.visibleRange}:undefined,identity:{...identity},saved:saved&&saved.instanceId===identity.instanceId&&saved.sessionId===identity.sessionId&&saved.bookId===book?.id&&saved.version===book?.version?structuredClone(saved):undefined,activeEntries:this.readingActions};
  this.cached.exportPrepared=this.exportPrepared?{...this.exportPrepared}:undefined;
  this.cached.eventHistory={count:this.projectedEventCount,beforeId:this.logEvents[0]?.id,hasEarlier:this.projectedEventCount>this.logEvents.length};
  this.listeners.forEach(listener=>listener());
 }
 private persistMetadata(){
  if(this.saveScheduled||this.disposed)return;this.saveScheduled=true;
  queueMicrotask(()=>{this.saveScheduled=false;void this.saveMetadata().catch(()=>{this.error='阅读记录保存未完成，请保留输入并查看处理详情';this.publish();});});
 }
 private saveMetadata(){
  const store=this.store,log=this.log;
  const next=this.observationWrites.catch(()=>{}).then(async()=>{
   if(this.store!==store||this.log!==log)return;
   const header={pagePosition:this.pagePosition,selectedBookId:this.selectedBookId,pageChars:this.pageChars,importedHistory:this.importedHistory,autoReadingSettings:this.autoReading.settings};
   if(!store.saveObservationChanges){await store.saveObservations({observations:log.data,drafts:this.drafts,...header});return;}
   const events=log.data.events.slice(this.observationCursor),end=log.data.events.length,keys=new Set(events.flatMap(event=>event.chatId?[event.chatId]:[])),questions=[...this.observationQuestions];
   const changes:ObservationChanges={header,eventStart:this.observationCursor,events,ratings:{},timings:{},questions:{},readyDomains:{},drafts:Object.fromEntries(this.dirtyDrafts)};
   for(const key of keys){if(log.data.ratings[key])changes.ratings[key]=log.data.ratings[key];if(log.data.timings[key])changes.timings[key]=log.data.timings[key];if(log.data.readyDomains[key])changes.readyDomains[key]=log.data.readyDomains[key];}
   for(const key of questions)if(log.data.questions[key])changes.questions[key]=log.data.questions[key];
   // NodeStore captures only this suffix and these changed records synchronously.
   await store.saveObservationChanges(changes);this.observationCursor=end;for(const key of questions)if(log.data.questions[key]===changes.questions[key])this.observationQuestions.delete(key);for(const [key,value]of Object.entries(changes.drafts??{}))if(this.dirtyDrafts.get(key)===value)this.dirtyDrafts.delete(key);
  });this.observationWrites=next;return next;
 }
 private changed(change?:import('../core/application-contract.ts').ApplicationChange){
  const state=this.engine.state,flow=this.application.snapshot.readingFlow!,signature=JSON.stringify(flow);
  // Model dispatch may pause while visible text continues to be durably recorded.
  // User stop and source/save failures own the explicit reader stop paths.
  if(signature!==this.lastFlow){this.lastFlow=signature;this.log.add('reading','阅读与交流队列变化',{readingFlow:flow,detail:`待处理 ${flow.pendingChars} 字，正在理解 ${flow.activeChars} 字，交流待完成 ${flow.foregroundPending} 条`});}
  const committed=this.store.readProjectionState?.(),chats=committed?.chats??state.chats,candidates=change?.changes?.collections.chats?.put??(change?.changes?[]:chats);
  for(const [requestId,stream]of this.streamingReplies){
   if(candidates.some(chat=>chat.role==='assistant'&&chat.replyTo===stream.questionId&&chat.createdAt>=stream.startedAt&&!chat.excluded&&(!chat.publication||chat.publication.status==='published')&&(!chat.readingReaction||chat.readingReaction.status==='delivered')))this.streamingReplies.delete(requestId);
   else if(candidates.some(chat=>chat.id===stream.questionId&&(chat.delivery==='failed'||chat.delivery==='stopped')))stream.state='incomplete';
  }
  if(!committed||this.observedChats!==chats){
   this.observedChats=committed?chats:undefined;
   for(const pending of [...this.pendingAsks]){const question=candidates.find(c=>c.role==='user'&&c.bookId===pending.bookId&&c.text===pending.text&&!pending.before.has(c.id)&&!this.log.data.questions[c.id]);if(question){this.log.question(question.id,pending.action);this.observationQuestions.add(question.id);this.pendingAsks=this.pendingAsks.filter(p=>p.id!==pending.id);}}
   for(const chat of candidates)if(visibleReply(chat)&&!this.seenChats.has(chat.id)){this.log.ready(chat.id,chat.replyTo);this.dirtyTimings.add(chat.id);this.seenChats.add(chat.id);}
  }
  for(const event of this.application.takeUIEvents())if(event.kind==='error'||event.kind==='notice'){this[event.kind==='error'?'error':'notice']=event.text;this.log.add(event.kind==='error'?'error':'status',event.text);}
  this.publish();this.persistMetadata();
 }
 private async release(){this.unsubscribe?.();if(this.runtime){await this.engine.disableLocalResultRecovery();await this.application.command('stopReadingSafely');await this.saveMetadata();this.application.dispose();this.runtime.dispose();await this.harness.dispose?.();await this.store.close();}}
 private async attach(session:WorkbenchSession){
  if(this.environment.fixedArchiveId&&session.id!==this.environment.fixedArchiveId)throw Error('宿主Context固定所属存档，切档须连接目标宿主');
  if(session.archivedAt||this.environment.sessions.list().some(item=>item.id===session.id&&item.archivedAt))throw Error('此阅读存档已归档，仅可从历史归档导出，不会打开或恢复旧任务');
  this.pageEpoch++;this.chapterCache.clear();this.chapterLoads.clear();this.chapterFailures.clear();this.pureVolumeHeadings.clear();this.visibleRange=undefined;this.desiredPage='';
  this.autoReading={phase:'stopped'};this.autoEpoch++;this.ledgerBudget=undefined;this.following=false;this.sourceVisible=false;this.sourceOwner=undefined;this.sourceRegistry.clear();this.sourceConnectionEpoch=crypto.randomUUID();this.followEpoch++;this.lastVisible='';this.selectedService=undefined;this.observationSaved=undefined;this.exportPrepared=undefined;
  await this.release();this.session=session;this.store=await this.environment.createStore(session.id);
  const metadata=await this.store.loadObservations<Metadata>();this.log=new WorkbenchEvents(session.mode,metadata?.observations);this.pageChars=metadata?.pageChars??defaultPageChars;this.importedHistory=metadata?.importedHistory;
  this.drafts=structuredClone(metadata?.drafts??{});this.dirtyDrafts.clear();
  this.observationCursor=this.log.data.events.length;this.observationQuestions.clear();this.observationWrites=Promise.resolve();
  this.autoReading={phase:'stopped',settings:metadata?.autoReadingSettings,reason:metadata?.autoReadingSettings?'重新打开后保持停止，点击开始可接续':undefined};
  const model=session.mode==='offline'?new OfflineModel():new ChatModel(async(request,signal,onStream)=>{
   if(this.environment.sessions.list().some(item=>item.id===session.id&&item.archivedAt))throw new ModelRequestError('此阅读存档已归档，未派发模型请求','not-dispatched');
   const log=this.log,engine=this.engine,current=()=>!this.disposed&&this.log===log&&this.engine===engine&&this.session.id===session.id;
   const begin=log.add('model','模型请求派发',{requestId:request.requestId,detail:JSON.stringify({bookId:this.selectedBookId,model:request.body.model,effort:request.body.reasoning_effort,serviceId:request.serviceId})});this.publish();this.persistMetadata();
   // Request attribution is fixed before streaming; reasoning and tool fragments
   // never search the usage history or rebuild the workbench snapshot.
   const questionId=request.requestId?engine.state.usage.find(u=>u.id===request.requestId)?.questionId:undefined,question=questionId?engine.state.chats.find(chat=>chat.id===questionId):undefined;
   const presentation=createModelStreamPresentation({forward:onStream,signal,current,showText:!!questionId&&!!request.requestId,
    firstResponse:arrival=>{log.add('model','收到首段响应',{requestId:request.requestId,...arrival,elapsedMs:arrival.clockMs-begin.clockMs});this.persistMetadata();},
    firstProse:arrival=>{log.add('model','收到首段可显示正文',{requestId:request.requestId,...arrival,elapsedMs:arrival.clockMs-begin.clockMs});this.persistMetadata();},
    present:text=>{if(!question)return;for(const [id,stream]of this.streamingReplies)if(stream.questionId===question.id&&id!==request.requestId)this.streamingReplies.delete(id);this.streamingReplies.set(request.requestId!,{partnerId:question.partnerId,requestId:request.requestId!,questionId:question.id,bookId:question.bookId,conversationId:question.sessionId,...(question.presentation==='paragraph'?{paragraphCommentId:question.id}:{}),text,state:'generating',startedAt:begin.at});},
    interrupt:()=>{const stream=request.requestId?this.streamingReplies.get(request.requestId):undefined;if(!stream)return false;stream.state='incomplete';return true;},publish:()=>this.publish(),
   });
   const budgetRefresh=setInterval(()=>{if(current())void this.refreshBudget().catch(()=>{});},5000);
   let terminalKind:WorkbenchEvent['kind']='model',terminalTitle='模型响应返回',terminalElapsedMs:number|undefined,toolNames:string[]=[];
   try {const result=await this.bridge<{status:number;body:Record<string,any>}>('workbenchModel',request,signal,presentation.observe);terminalElapsedMs=performance.now()-begin.clockMs;
    toolNames=(result.body.choices?.[0]?.message?.tool_calls??[]).map((call:{function?:{name?:string}})=>String(call.function?.name??'工具'));return result;
   }catch(error){terminalKind='error';terminalTitle=(error as Error).message;throw error;}finally{
    clearInterval(budgetRefresh);const metrics=presentation.finish();
    // Add the summary after the final scheduled text has been flushed, before
    // publishing this event for the first time (event projections are immutable).
    log.add(terminalKind,terminalTitle,{requestId:request.requestId,elapsedMs:terminalElapsedMs,detail:JSON.stringify({streamPresentation:{...metrics,uiPublishCount:metrics.uiPublishCount+(current()?2:1)}})});
    for(const name of toolNames)log.add('tool','模型请求取材或提交',{requestId:request.requestId,detail:name});
    const stream=request.requestId?this.streamingReplies.get(request.requestId):undefined;if(stream)stream.state=terminalKind==='error'?'incomplete':'saving';
    if(current()){
     void this.refreshBudget().catch(()=>{});this.publish();this.persistMetadata();
    }
   }
  },async(requestId,receivedResponse)=>{const receipt=await this.bridge<import('../core/types.ts').QueryHostReceipt>('workbenchQueryReceipt',{requestId,...(receivedResponse?{receivedResponse}:{})});await this.refreshBudget();return receipt;},input=>this.bridge('workbenchCloseAttempt',input));
  const restored=await restoreReadingEngine(this.store,model);this.engine=restored.engine;this.engine.readingWindowChars=this.pageChars;this.engine.setModelDispatchAllowed(false);
  this.engine.projectDirectory=this.environment.projectDirectory?bookId=>this.environment.projectDirectory!(session.id,bookId):undefined;
  this.engine.sessionDirectory=this.environment.sessionDirectory?bookId=>this.environment.sessionDirectory!(session.id,bookId):undefined;
  this.engine.attachAgentSession=this.environment.attachAgentSession?(bookId,sessionId)=>this.environment.attachAgentSession!(session.id,bookId,sessionId):undefined;
  const observedEngine=this.engine;observedEngine.onReadingObservationSaved=event=>{if(this.engine!==observedEngine||this.disposed)return;this.log.observationSaved(event);this.observationSaved=latestReadingObservationSaved(this.observationSaved,event,observedEngine.readingObservationIdentity,observedEngine.state.books.find(book=>book.id===this.selectedBookId),observedEngine.state.partnerId);this.publish();this.persistMetadata();};
  await this.environment.initializeEngine?.(session.id,this.engine);
  await this.engine.settleCompletedSceneExpressions();
  this.harness=this.environment.createHarness(session.id);this.engine.agent=this.harness;
  this.engine.factReviewer=this.environment.createFactReviewer?.(this.harness);
  this.engine.projectDirectory=this.environment.projectDirectory?bookId=>this.environment.projectDirectory!(session.id,bookId):undefined;
  this.engine.sessionDirectory=this.environment.sessionDirectory?bookId=>this.environment.sessionDirectory!(session.id,bookId):undefined;
  this.engine.attachAgentSession=this.environment.attachAgentSession?(bookId,sessionId)=>this.environment.attachAgentSession!(session.id,bookId,sessionId):undefined;
  this.runtime=new ReadingRuntime(this.engine,{available:false,async request(){return {} as never;}});
  const originalReaction=this.engine.onReaction;this.engine.onReaction=text=>{originalReaction?.(text);this.log.add('reading','核心放行主动反应',{detail:'实际可见时间由页面记录'});this.publish();this.persistMetadata();};
  this.application=new LocalApplication(this.runtime,async<T>(method:string,payload:unknown):Promise<T>=>{
   if(method==='services')return this.services.filter(s=>s.scope==='workbench') as T;
   if(method==='bindModelService'){const metadata=await this.bridge<WorkbenchService>('workbenchBindService',payload);this.services=[...this.services.filter(s=>s.scope!=='workbench'||s.id!==metadata.id),metadata];return metadata as T;}
   if(method==='saveSecret'){await this.bridge('workbenchSaveSecret',payload);await this.refreshServices();return {ok:true} as T;}
   throw Error('测试台尚未提供此设备能力');
  },this.store.readProjectionState?.bind(this.store));
  if(session.mode==='live')await this.application.initializePartnerModels();
  this.lastFlow='';this.observedChats=undefined;this.seenChats=new Set(this.engine.state.chats.filter(visibleReply).map(c=>c.id));this.pendingAsks=[];
  this.selectedBookId=metadata?.selectedBookId&&this.engine.state.books.some(b=>b.id===metadata.selectedBookId)?metadata.selectedBookId:this.engine.state.books[0]?.id??'';
  this.currentAutoReadingSettings();this.inheritBookDrafts(this.selectedBookId);
  const book=this.engine.state.books.find(b=>b.id===this.selectedBookId);this.pagePosition=metadata?.pagePosition??(book?Math.max(readingStart(book),book.position-1):0);
  await this.refreshBudget();
  this.unsubscribe=this.application.subscribe(change=>this.changed(change));this.environment.sessions.markActive(session.id);this.error='';this.notice=session.mode==='offline'?'界面演练：固定技术回应，外部模型调用为零':'阅读存档已打开，模型设置已保留；点击开始伴读或发送问题后使用模型。';this.publish();this.engine.enableLocalResultRecovery();
 }
 private async loadNew(mode:WorkbenchMode,state?:State,metadata?:Partial<Metadata>,avatarAssets?:unknown){
  if(mode==='offline'&&this.environment.developerMode===false)throw Error('界面演示仅在开发者模式提供');
  const session:WorkbenchSession={id:crypto.randomUUID(),mode,title:mode==='offline'?'界面演示':'真实共读',createdAt:Date.now()};
  if(!state){state=initialWorkbenchState(mode);}
  else if(mode==='offline'){state.settings.services=state.settings.services.filter(s=>s.id!==offlineService.id);state.settings.services.forEach(s=>{s.enabled=false;});state.settings.services.push({...offlineService});state.settings.serviceId=offlineService.id;}
  if(mode==='live'&&this.selectedService&&!state.books.length){const metadata=this.selectedService;const service=this.fromMetadata(metadata);state.settings.services=state.settings.services.filter(s=>s.id!==service.id);state.settings.services.push(service);state.settings.serviceId=service.id;}
  if(this.environment.fixedArchiveId)for(const record of state.agentSessions??[])if(record.native)record.nativeImportPending=true;
  if(mode==='offline'&&!state.books.length){const guide=await importBook(offlineGuide.title,offlineGuide.text);Object.assign(guide,modeProfile('companion'));state.books.push(guide);}
  if(this.session&&this.environment.fixedArchiveId){await this.stopArchiveSource();}
  // Publish a new archive only after its complete state has durably saved.
  // A disk/validation failure here leaves the current controller and archive intact.
  const preparedStore=await this.environment.createStore(session.id);
  try{if(avatarAssets!==undefined)await writeBackupPartnerAvatars({partnerAvatarAssets:avatarAssets},preparedStore);await preparedStore.save(state);if(this.environment.fixedArchiveId)await preparedStore.saveObservations({observations:{events:[],ratings:{},timings:{},questions:{},readyDomains:{}},selectedBookId:state.books[0]?.id??'',pagePosition:state.books[0]?Math.max(readingStart(state.books[0]),state.books[0].position-1):0,pageChars:this.pageChars,...metadata});await preparedStore.flush();}finally{await preparedStore.close();}
  this.environment.sessions.remember({...session,storageLocation:'host'});await this.environment.sessions.flush();
  if(this.session&&this.environment.fixedArchiveId){this.environment.sessions.markActive(session.id);await this.environment.sessions.flush();this.connectionTarget=session.id;return;}
  await this.attach(session);
  if(mode==='offline'&&!this.engine.state.books.length){const imported=await this.application.command('importText',offlineGuide.title,offlineGuide.text);this.selectedBookId=imported.bookId;await this.application.command('setReadingMode',imported.bookId,'companion');this.pagePosition=0;}
  this.log.add('status','独立存档已打开',{detail:mode==='offline'?'界面演练，无外部模型调用':'模型尚未启用'});this.publish();this.persistMetadata();
 }
 private async action(title:string,work:()=>Promise<void>,exclusive:boolean|'settings'=true,archiveExit=false){
  if(this.disposed)throw Error('测试存档已关闭');if(this.session?.archivedAt&&!archiveExit)throw Error('此阅读存档已归档，不能继续旧任务；请使用当前正常存档');if(this.busyAction)throw Error('正在切换阅读存档或更改设置，请稍候');
  if(exclusive===true&&(this.readingActions||this.engine?.busy))throw Error('请先暂停当前处理，再切换阅读存档');
  if(exclusive)this.busyAction=true;else this.readingActions++;this.error='';this.log.add('action',title);this.publish();
  try{await work();}catch(error){this.error=(error as Error).message??'操作未完成';this.log.add('error',this.error);throw error;}finally{if(exclusive)this.busyAction=false;else this.readingActions--;this.publish();this.persistMetadata();}
 }
 async importTxt(name:string,text:string,sourceFile?:import('../core/types.ts').BookSourceFile){await this.action('导入本机文本',async()=>{const result=await this.application.command('importText',name,text,sourceFile);this.selectedBookId=result.bookId;await this.application.command('setReadingMode',result.bookId,'companion');this.pagePosition=readingStart(this.engine.book(result.bookId));});}
 async getBookProjectLocations(){
  if(!this.environment.getBookProjectLocations)throw Error('请在桌面客户端管理书籍工程位置');
  return this.environment.getBookProjectLocations(this.session.id);
 }
 async saveBookProjectCopy(bookId:string,parentDirectory:string){
  if(!this.environment.saveBookProjectCopy)throw Error('请在桌面客户端保存书籍工程');
  this.engine.book(bookId);
  await this.flush();
  return this.environment.saveBookProjectCopy(this.session.id,bookId,parentDirectory);
 }
 async saveDraft(key:string,value:WorkbenchDraft|null){
  if(this.disposed||this.session.archivedAt)throw Error('当前存档不能更改草稿');validateWorkbenchDraft(this.engine.state,key,value);
  const next={...this.drafts};if(value===null){delete next[key];const book=this.application.snapshot.state.books.find(book=>currentDraftKey(book,key)===key);if(book)for(const prior of Object.keys(next))if(prior!==key&&currentDraftKey(book,prior)===key){delete next[prior];this.dirtyDrafts.set(prior,null);}}else{
   next[key]=structuredClone(value);
   const book=this.application.snapshot.state.books.find(book=>currentDraftKey(book,key)!==undefined),current=book&&currentDraftKey(book,key);
   if(current&&current!==key&&(!next[current]||next[current].updatedAt<value.updatedAt)){next[current]={...next[key]};this.dirtyDrafts.set(current,next[current]);}
  }this.drafts=next;this.dirtyDrafts.set(key,value===null?null:next[key]);this.publish();await this.saveMetadata();
 }
 async importBackup(raw:string){await this.action('导入备份到新存档',async()=>{const parsed=JSON.parse(raw),avatars=parsed.partnerAvatarAssets,state=await restoreBackupState(parsed,initialState()),metadata=takeBackupWorkbenchMetadata(state);for(const record of state.agentSessions??[])if(record.native)record.nativeImportPending=true;const importedHistory=`导入历史：${state.usage.length}条原用量记录（含原未知状态），本存档新增记录另列`;await this.loadNew(this.session.mode,state,{...metadata,importedHistory},avatars);if(!this.connectionTarget)this.importedHistory=importedHistory;});}
 /** Host-only file route; not an arbitrary-object renderer RPC command. */
 async importBackupState(value:unknown){await this.action('导入备份到新存档',async()=>{const avatars=(value as {partnerAvatarAssets?:unknown})?.partnerAvatarAssets,state=await restoreBackupState(value,initialState()),metadata=takeBackupWorkbenchMetadata(state);for(const record of state.agentSessions??[])if(record.native)record.nativeImportPending=true;const importedHistory=`导入历史：${state.usage.length}条原用量记录（含原未知状态），本存档新增记录另列`;await this.loadNew(this.session.mode,state,{...metadata,importedHistory},avatars);if(!this.connectionTarget)this.importedHistory=importedHistory;});}
 async importSource(id:string){if(this.sources.some(source=>source.id===id&&source.historical))throw Error('历史资料仅可导出，不会导入当前存档');await this.action('载入本机阅读资料的独立副本',async()=>{const result=await this.bridge<{title:string;state:State}>('workbenchSource',{id});const state=await restoreBackup(JSON.stringify(result.state),initialState());const mode=id==='knowledge20-checkpoint'||id==='knowledge20-empty'?'live':this.session.mode;await this.loadNew(mode,state);this.importedHistory=`${result.title}；${id==='knowledge20-checkpoint'?'伙伴独立准备至二十章；功能检查问答另存，用户共同经历从本次操作开始。':''}保留${state.usage.length}条原用量，含原未知状态。`;this.notice=mode==='live'?'已载入真实共读的独立副本，原理解与用量保留。选择一次模型服务并保存，即可开始。':'历史材料已载入独立副本，原记录保留。';});}
 async selectBook(id:string){if(['reading','starting','finishing'].includes(this.autoReading.phase))await this.stopAutoReading('已切换作品');await this.action('选择作品',async()=>{this.following=false;this.followEpoch++;this.lastVisible='';this.engine.sourceActive(false);await this.application.command('selectBook',id);this.selectedBookId=id;this.inheritBookDrafts(id);this.visibleRange=undefined;this.pageEpoch++;this.chapterLoads.clear();this.chapterFailures.clear();const book=this.engine.book(id);this.pagePosition=Math.max(readingStart(book),book.position-1);this.navigationRevision++;});}
 async jumpTo(position:number){await this.navigateTo(position);}
 async renameBook(id:string,title:string){await this.action('修改书名',()=>this.application.command('renameBook',id,title));}
 async recognizeBookDirectory(bookId:string,useModel:boolean){return this.application.command('recognizeBookDirectory',bookId,useModel);}
 async extendBookSource(id:string,raw:string,title?:string,sourceFile?:import('../core/types.ts').BookSourceFile){await this.action('接续完整原文',async()=>{
  await this.application.command('extendBookSource',id,raw,title,sourceFile);
  this.inheritBookDrafts(id);if(this.autoReading.settings?.bookId===id){this.currentAutoReadingSettings();this.autoReading={phase:'stopped',settings:this.autoReading.settings,reason:'原文已接续，自动伴读保持停止。'};this.autoEpoch++;}
  if(this.selectedBookId===id){this.following=false;this.followEpoch++;this.lastVisible='';this.sourceVisible=false;this.visibleRange=undefined;this.sourceOwner=undefined;this.sourceRegistry.clear();this.sourceConnectionEpoch=crypto.randomUUID();this.pageEpoch++;this.navigationRevision++;this.chapterCache.clear();this.chapterLoads.clear();this.chapterFailures.clear();this.pureVolumeHeadings.clear();this.desiredPage='';this.engine.sourceActive(false);}
 });}
 private async navigateTo(position:number){if(this.busyAction)throw Error('正在切换阅读存档或更改设置，请稍候');if(!Number.isSafeInteger(position))throw Error('跳转位置无效');this.navigationDirection=Math.sign(position-this.pagePosition);this.pagePosition=Math.max(0,position);this.navigationRevision++;this.followEpoch++;this.visibleRange=undefined;this.chapterFailures.clear();this.sourceVisible=false;this.lastVisible='';if(this.engine.session?.active)this.engine.sourceActive(false);this.log.add('action','浏览跳转',{detail:'本机浏览，未增加模型授权'});this.publish();this.persistMetadata();}
 async turnPage(delta:number){const page=this.page(),position=delta<0?page?.previousChapterStart:page?.nextChapterStart;if(position!==undefined)await this.jumpTo(position);}
 private async refreshBudget(){
  if(this.session.mode!=='live')return;
  const value=await this.bridge<Omit<WorkbenchBudget,'source'>|null>('workbenchBudget');
  if(value){this.engine.model.tokenBudgetAuthority='provider-ledger';this.ledgerBudget={...value,source:'ledger'};if(this.engine.state.settings.tokenLimit!==value.tokenLimit)await this.application.command('updateLimits',{tokenLimit:value.tokenLimit});if(this.autoReading.settings&&this.autoReading.settings.tokenLimit!==value.tokenLimit){this.autoReading={...this.autoReading,settings:{...this.autoReading.settings,tokenLimit:value.tokenLimit}};this.persistMetadata();}}
  this.publish();
 }
 private async applyTokenLimit(tokenLimit:number){
  if(!Number.isSafeInteger(tokenLimit)||tokenLimit<0)throw Error('token 总上限应为非负整数');
  if(this.session.mode==='live'){const value=await this.bridge<Omit<WorkbenchBudget,'source'>|null>('workbenchUpdateBudget',{tokenLimit});if(value)this.ledgerBudget={...value,source:'ledger'};}
   await this.application.command('updateLimits',{tokenLimit});
  if(this.autoReading.settings)this.autoReading={...this.autoReading,settings:{...this.autoReading.settings,tokenLimit}};
  this.log.add('status','本轮 token 上限已应用',{detail:JSON.stringify({tokenLimit,used:(this.ledgerBudget??archiveBudget(this.engine.state)).tokens})});
 }
 async estimateAutoReading(targetChapterIndex:number){
  const book=this.engine.book(this.selectedBookId);await this.refreshBudget();
  const stamps=this.log.data.events.flatMap(event=>{if(event.title!=='模型请求派发'||!event.requestId||!event.detail)return[];try{return[{...JSON.parse(event.detail),requestId:event.requestId}];}catch{return[];}});
  return estimateReading(this.engine.state,book,this.pagePosition,targetChapterIndex,this.service,this.ledgerBudget??archiveBudget(this.engine.state),stamps);
 }
 async configureAutoReading(settings:AutoReadingSettings){
  const book=this.engine.book(this.selectedBookId);validateAutoReading(settings,book);
  const target=autoReadingChapters(book).find(c=>c.index===settings.targetChapterIndex)!;
  if(chapterContentEnd(book,target)<=this.pagePosition)throw Error('终止章节应在当前读点之后');
   try{await this.applyTokenLimit(settings.tokenLimit);}catch(error){this.notice='模型用量设置未应用，翻阅沿已生效上限继续：'+(error as Error).message;this.log.add('error',this.notice);}
   const tokenLimit=(this.ledgerBudget??archiveBudget(this.engine.state)).tokenLimit;
   this.autoReading={...this.autoReading,settings:{...settings,tokenLimit},targetPosition:chapterContentEnd(book,target)};
  this.log.add('status','自动伴读设置已应用',{detail:JSON.stringify(settings)});this.publish();await this.saveMetadata();
 }
 async startAutoReading(capture:WorkbenchSourceCapture,settings:AutoReadingSettings){
   if(this.session.archivedAt)throw Error('已归档存档不能开始新的阅读');
  this.requireModel();this.requireBackgroundModel();
  if(!capture?.visible||!capture.range)throw Error('请让当前正文可见后开始');
  const sourceEpoch=await this.activateReadingSource(capture.producerId,capture.sourceEpoch);
  if(!sourceEpoch)throw Error('当前阅读页面尚未激活');
  capture={...capture,sourceEpoch};
  if(['starting','reading','finishing'].includes(this.autoReading.phase))return;
  const epoch=++this.autoEpoch;this.autoReading={...this.autoReading,phase:'starting',reason:undefined};this.publish();
  try{
   // Admit the real viewport before asynchronous settings writes. Those writes
   // can trigger a newer capture of the same page; that is not a navigation.
   if(!capture.visible||!capture.range)throw Error('请让当前正文可见后开始');
   const observed=await this.captureReadingSource({...capture,startFollowing:false});
   if(observed.status==='obsolete'&&observed.reason!=='superseded')throw Error('当前页面已变化，请从显示的正文开始');
   await this.configureAutoReading(settings);if(epoch!==this.autoEpoch)return;
   if(!sameWorkbenchSource(capture.source,workbenchSourceIdentity({sessionId:this.session.id,page:this.page()}))||this.sourceOwner?.producerId!==capture.producerId||this.sourceOwner.epoch!==capture.sourceEpoch||!this.sourceVisible||!this.visibleRange)throw Error('当前页面已变化或隐藏，请从显示的正文开始');
   await this.startFollowing(this.visibleRange);
   if(epoch!==this.autoEpoch)return;
   this.autoReading={...this.autoReading,phase:'reading',startedAt:Date.now(),startPosition:capture.range.start,reason:undefined};
   this.log.add('status','自动伴读已开始',{detail:JSON.stringify({position:capture.range.start,target:this.autoReading.targetPosition})});this.publish();await this.saveMetadata();
  }catch(error){if(epoch===this.autoEpoch)await this.stopAutoReading((error as Error).message);throw error;}
 }
 private markAutoStopped(reason:string){
  this.autoEpoch++;if(this.autoReading.phase==='complete'||this.autoReading.phase==='stopped'&&this.autoReading.reason===reason)return;
  this.autoReading={...this.autoReading,phase:'stopped',reason};this.log?.add('status','自动伴读已停止',{detail:reason});this.publish();this.persistMetadata();
 }
 async stopAutoReading(reason='已手动停止自动伴读'){
  this.markAutoStopped(reason);this.following=false;this.followEpoch++;this.lastVisible='';this.engine.sourceActive(false);
  await this.application.command('pauseReadingSafely');await this.saveMetadata();this.publish();
 }
 async advanceAutoReading(){
  if(this.autoReading.phase!=='reading')return;
  const page=this.page(),book=this.engine.book(this.selectedBookId),settings=this.autoReading.settings;
  if(!page||!settings||!this.visibleRange||!this.sourceVisible||!this.following)return;
  const end=chapterContentEnd(book,book.chapters.find(c=>c.index===page.chapterIndex)!);
  if(this.visibleRange.end<end)throw Error('本章最后的正文尚未可见，未自动翻章');
  if(page.chapterIndex>=settings.targetChapterIndex){
   this.autoReading={...this.autoReading,phase:'complete',reason:'已读到目标；伙伴理解与交流按各自实际状态继续显示'};this.following=false;this.followEpoch++;
   this.log.add('status','自动阅读已到目标',{detail:JSON.stringify({position:this.visibleRange.end})});this.publish();await this.saveMetadata();
   void this.application.command('finishReading',book.id).then(()=>this.changed()).catch(error=>{this.error='目标已到达，后台收尾未完成：'+(error as Error).message;this.publish();});
  }else if(page.nextChapterStart!==undefined)await this.navigateTo(page.nextChapterStart);
 }
 recordReadingPosition(position:number){const page=this.page();if(!page||!Number.isSafeInteger(position)||position<page.start||position>=page.end||position===this.pagePosition)return;this.pagePosition=position;this.publish();this.persistMetadata();}
 async provideToCurrent(){if(!this.visibleRange||!this.sourceVisible)throw Error('请从屏幕中实际可见的正文开始跟随');await this.startFollowing(this.visibleRange);}
 async startReading(){await this.provideToCurrent();}
 private requireModel(){if(this.session.archivedAt)throw Error('这份存档已归档，不能开始新的共读');if(!this.modelReady)throw Error('当前伙伴尚未绑定可用模型。请在伙伴页面选择模型并保存。你仍可以阅读和查看记录。');}
 private requireBackgroundModel(){if(!this.backgroundModelReady)throw Error('后台整理尚未设置可用模型。请在“模型设置”中选择后台模型并保存。');}
 private dispatch<T>(work:()=>Promise<T>):Promise<T>{this.engine.setModelDispatchAllowed(true);return work();}
 private visibleText(range:{start:number;end:number}){const page=this.page();if(!page||!Number.isSafeInteger(range.start)||!Number.isSafeInteger(range.end)||range.start<page.start||range.end>page.end||range.end<=range.start)throw Error('阅读位置已变化，请回到原文后重新开始跟随。');return {page,text:page.text.slice(range.start-page.start,range.end-page.start)};}
 async startFollowing(range:{start:number;end:number}){
  this.requireModel();this.requireBackgroundModel();
  const {page}=this.visibleText(range),epoch=++this.followEpoch;this.visibleRange={...range};this.following=true;this.sourceVisible=true;this.lastVisible='';this.publish();
  try {await this.action('开始跟随当前可见正文',async()=>{
   this.engine.setModelDispatchAllowed(true);
   if(this.application.snapshot.readingControl?.state==='paused')await this.application.command('resumeReadingSafely');
   await this.application.command('startReading',page.bookId);
   if(epoch!==this.followEpoch||!this.following)return;
   this.engine.observing(true);this.engine.sourceActive(this.sourceVisible);
   if(this.sourceVisible){const actual=this.visibleRange??range,latest=this.visibleText(actual);await this.engine.observe(latest.page.bookId,latest.text,'body','continuous-page',{version:latest.page.version,...actual},'recorded');if(epoch===this.followEpoch&&this.visibleRange?.start===actual.start&&this.visibleRange?.end===actual.end)this.lastVisible=`${latest.page.bookId}:${actual.start}:${actual.end}`;}
  },false);}catch(error){if(epoch===this.followEpoch){this.following=false;this.engine.sourceActive(false);this.publish();}throw error;}
 }
 async followVisible(range:{start:number;end:number}){
  if(!this.following||!this.sourceVisible||!this.engine.session?.observing||this.busyAction)return;
  const {page,text}=this.visibleText(range),key=`${page.bookId}:${range.start}:${range.end}`;
  if(key===this.lastVisible)return;
  this.visibleRange={...range};const epoch=this.followEpoch,identity=JSON.stringify([epoch,page.version,key]);
  const pending=this.visibleObservations.get(identity);if(pending)return pending;
  const work=Promise.resolve().then(async()=>{
   if(epoch!==this.followEpoch||!this.following||!this.sourceVisible)return;
   try{await this.action('跟随可见正文',()=>this.engine.observe(page.bookId,text,'body','continuous-page',{version:page.version,...range},'recorded'),false);if(epoch===this.followEpoch&&this.sourceVisible&&this.visibleRange?.start===range.start&&this.visibleRange?.end===range.end)this.lastVisible=key;}
   catch(error){if(epoch!==this.followEpoch)return;this.following=false;this.followEpoch++;this.engine.sourceActive(false);this.publish();throw error;}
  }).finally(()=>{if(this.visibleObservations.get(identity)===work)this.visibleObservations.delete(identity);});
  this.visibleObservations.set(identity,work);return work;
 }
 setSourceVisible(value:boolean,range?:{start:number;end:number}){const prior=this.visibleRange;if(value&&range){this.visibleText(range);this.visibleRange={...range};}if(!value)this.visibleRange=undefined;const rangeChanged=prior?.start!==this.visibleRange?.start||prior?.end!==this.visibleRange?.end;const visibilityChanged=value!==this.sourceVisible;this.sourceVisible=value;if(!value)this.lastVisible='';if((visibilityChanged||rangeChanged)&&this.engine.session?.active&&this.engine.session.bookId===this.selectedBookId)this.engine.sourceActive(value,range);if(visibilityChanged||rangeChanged)this.publish();}
 async registerReadingSource(producerId:string,archiveId:string,connectionEpoch:string):Promise<string>{
  if(this.disposed||this.session.id!==archiveId||this.sourceConnectionEpoch!==connectionEpoch||typeof producerId!=='string'||!producerId)throw Error('屏幕来源不属于当前阅读存档或连接代次');
  const existing=this.sourceRegistry.get(producerId);if(existing)return existing.epoch;
  const registered={producerId,epoch:crypto.randomUUID(),sequence:0};this.sourceRegistry.set(producerId,registered);return registered.epoch;
 }
 async activateReadingSource(producerId:string,sourceEpoch:string,onlyIfUnowned=false):Promise<string|undefined>{
  const registered=this.sourceRegistry.get(producerId);
  if(this.disposed||!registered||registered.epoch!==sourceEpoch||typeof onlyIfUnowned!=='boolean')throw Error('当前阅读页面的登记已变化，请重新连接正文');
  if(this.sourceOwner===registered)return registered.epoch;
  if(onlyIfUnowned&&this.sourceOwner)return undefined;
  if(['starting','reading','finishing'].includes(this.autoReading.phase))this.markAutoStopped('已切换当前阅读页面，自动阅读保持停止');
  // Rotation fences delayed captures from this same screen's previous ownership.
  const owner={producerId,epoch:crypto.randomUUID(),sequence:0};this.sourceRegistry.set(producerId,owner);this.sourceOwner=owner;
  this.following=false;this.followEpoch++;this.lastVisible='';this.setSourceVisible(false);
  this.log.add('reading','当前阅读页面已激活',{detail:JSON.stringify({producerId,epoch:owner.epoch})});this.publish();this.persistMetadata();return owner.epoch;
 }
 async releaseReadingSource(producerId:string,sourceEpoch:string):Promise<boolean>{
  if(this.disposed||!this.sourceOwner||this.sourceOwner.producerId!==producerId||this.sourceOwner.epoch!==sourceEpoch)return false;
  if(['starting','reading','finishing'].includes(this.autoReading.phase))this.markAutoStopped('当前阅读页面已离开，自动阅读保持停止');
  this.sourceOwner=undefined;this.following=false;this.followEpoch++;this.lastVisible='';this.setSourceVisible(false);this.publish();return true;
 }
 async captureReadingSource(capture:WorkbenchSourceCapture):Promise<WorkbenchSourceReceipt>{
  if(!capture||!capture.source||typeof capture.producerId!=='string'||!capture.producerId||typeof capture.sourceEpoch!=='string'||!capture.sourceEpoch||!Number.isSafeInteger(capture.sequence)||capture.sequence<1||typeof capture.visible!=='boolean'||capture.startFollowing!==undefined&&typeof capture.startFollowing!=='boolean')throw Error('可见正文观察身份无效');
  const owner=this.sourceOwner;
  if(!owner||owner.producerId!==capture.producerId||owner.epoch!==capture.sourceEpoch)return{status:'obsolete',reason:'source-replaced'};
  const current=workbenchSourceIdentity({sessionId:this.session.id,page:this.page()});
  const reason=!sameWorkbenchSource(capture.source,current)?'page-changed':capture.sequence<=owner.sequence?'superseded':undefined;
  if(reason)return{status:'obsolete',reason};
  if(capture.readingMode!==undefined&&!['manual','developer-auto'].includes(capture.readingMode))throw Error('阅读来源类型无效');
  // A current-page malformed range remains an error. Only an identified old
  // page or older producer sequence can receive an obsolete acknowledgement.
  if(capture.visible){if(!capture.range)throw Error('可见正文观察缺少实际范围');this.visibleText(capture.range);}
  if(capture.startFollowing&&!capture.visible)throw Error('请从实际可见正文开始跟随');
  owner!.sequence=capture.sequence;
  const readingMode=capture.readingMode??'manual';
  if(capture.visible&&owner!.readingMode!==readingMode){owner!.readingMode=readingMode;this.log.add('reading',readingMode==='developer-auto'?'开发者模拟阅读正在登记正文':'人工阅读正在登记可见正文',{detail:JSON.stringify({producerId:capture.producerId,readingMode})});this.persistMetadata();}
  this.setSourceVisible(capture.visible,capture.range);
  if(capture.visible&&capture.range){
   this.recordReadingPosition(capture.range.start);
   if(capture.startFollowing)await this.startFollowing(capture.range);
   else if(this.following)await this.followVisible(capture.range);
  }
  return{status:'accepted'};
 }
 async preparePrevious(through:number,from?:number){this.requireBackgroundModel();const epoch=++this.followEpoch;this.following=false;await this.action('补齐明确已读的前文',()=>this.dispatch(async()=>{if(!this.selectedBookId)throw Error('请先选择作品');const id=this.selectedBookId,book=this.engine.book(id),start=Math.max(from??readingStart(book),readingStart(book));const alreadyKnown=(from===undefined||Number.isSafeInteger(from)&&from>=0)&&Number.isSafeInteger(through)&&through<=bookLength(book)&&covers(book.known,{start,end:through});if(!alreadyKnown)await this.application.command('setKnown',id,through,from);if(epoch!==this.followEpoch)return;await this.application.command('startReading',id);if(epoch!==this.followEpoch)return;if(this.application.snapshot.readingControl?.state==='paused')await this.application.command('resumeReadingSafely');if(epoch!==this.followEpoch)return;await this.application.command('prepare',id);}),false);}
 async sendMessage(text:string,long=false,conversationId?:string){this.requireModel();await this.action('发送交流问题',()=>this.dispatch(async()=>{if(!this.selectedBookId)throw Error('请先选择作品');const action=this.log.add('action','问题开始',{detail:long?'明确长答':'短交流'}),pending={id:crypto.randomUUID(),action,before:new Set(this.engine.state.chats.map(c=>c.id)),bookId:this.selectedBookId,text};this.pendingAsks.push(pending);try{await this.application.command('ask',pending.bookId,text,long,conversationId,{acceptanceOnly:true});}finally{this.pendingAsks=this.pendingAsks.filter(p=>p.id!==pending.id);}}),false);}
 private recoveryEntry(target:ReadingRecoveryTarget,expectedExecution:Exclude<ReadingRecoveryExecution,'none'>){
  const identity=recoveryTargetKey(target),activity=this.application.snapshot.activities.find(activity=>activity.recovery?.target&&recoveryTargetKey(activity.recovery.target)===identity),decision=activity&&availableRecovery(activity);
  if(!activity||!decision||decision.execution!==expectedExecution)throw Error(activity?.recovery?.reason??'这项工作的进度已变化，请在活动面板查看当前可用的操作。');
  return{activity,decision};
 }
 async dismissMaintenance(jobId:string){
  const job=this.engine.state.maintenanceJobs?.find(item=>item.id===jobId);
  if(!job||job.bookId!==this.selectedBookId)throw Error('请先打开这项整理对应的书籍。');
  await this.action('清除整理待办，保留历史记录',()=>this.application.command('dismissMaintenance',jobId),false);
 }
 async restoreMaintenance(jobId:string){
  const state=this.engine.state,job=state.maintenanceJobs?.find(item=>item.id===jobId);
  if(!job||job.bookId!==this.selectedBookId)throw Error('请先打开这项整理对应的书籍。');
  const target={kind:'maintenance' as const,jobId};
  const restored={...state,partnerId:job.scope==='book'?job.partnerId:state.partnerId,maintenanceJobs:state.maintenanceJobs!.map(item=>item.id===jobId?{...item,dismissed:undefined}:item)};
  const decision=decideReadingRecovery(restored,target,{receiptReader:!!this.engine.model.readQueryReceipt});
  if(decision.execution==='none')throw Error(decision.reason??'这项整理目前无法继续，历史记录保留。');
  const execution=decision.execution;
  await this.action('恢复并继续这项整理',async()=>{
   if(execution==='continue'){
    this.requireBackgroundModel();this.engine.setModelDispatchAllowed(true);
   }
   await this.application.command('restoreMaintenance',jobId,execution);
  },false);
 }
 async recoverReading(target:ReadingRecoveryTarget,expectedExecution:Exclude<ReadingRecoveryExecution,'none'>){
  const entry=this.recoveryEntry(target,expectedExecution);
  await this.action(recoveryActionLabel(entry.decision),async()=>{
   const {activity,decision}=this.recoveryEntry(target,expectedExecution);
   if(activity.bookId!==this.selectedBookId)throw Error('请先打开这项工作对应的书籍。');
   if(decision.execution==='continue'){
    if(target.kind==='maintenance')this.requireBackgroundModel();else this.requireModel();this.engine.setModelDispatchAllowed(true);
   }
   await this.application.command('recoverReading',target,expectedExecution);
  },false);
 }
 private recoverProjected(match:(target:ReadingRecoveryTarget)=>boolean,action?:NonNullable<import('../core/types.ts').ReadingRecoveryCapability['action']>){
  const choices=this.application.snapshot.activities.map(availableRecovery).filter(decision=>decision&&match(decision.target)&&(!action||decision.action===action));
  if(choices.length!==1)throw Error('请在活动面板找到这项工作，再点击继续。');
  const decision=choices[0]!;return this.recoverReading(decision.target,decision.execution);
 }
 async retryQuestion(id:string){await this.recoverProjected(target=>target.kind==='question'&&target.questionId===id,'retry-question');}
 async resumeTerminatedMaintenance(input:TerminatedMaintenanceResume){this.requireBackgroundModel();await this.action('继续此前中断的整理',()=>this.dispatch(async()=>{const job=this.application.snapshot.state.maintenanceJobs?.find(j=>j.id===input.jobId);if(!job||job.bookId!==this.selectedBookId)throw Error('这项整理属于另一本书，请先打开对应书籍');await this.application.command('resumeTerminatedMaintenance',input);}),false);}
 async refreshReadingViews(viewIds:string[]){if(!Array.isArray(viewIds))throw Error('请指定需要更新的本书概要');this.requireBackgroundModel();await this.action('更新本书概要',()=>this.dispatch(()=>this.application.command('prepare',this.selectedBookId,viewIds)),false);}
 async resumeMaintenance(jobId:string){await this.recoverProjected(target=>target.kind==='maintenance'&&target.jobId===jobId,'resume-maintenance');}
 async closeLostMaintenance(jobId:string){
  const job=this.application.snapshot.state.maintenanceJobs?.find(job=>job.id===jobId);
  if(!job||job.bookId!==this.selectedBookId)throw Error('请先打开这项整理对应的书籍。');
  this.requireBackgroundModel();this.engine.setModelDispatchAllowed(true);
  // This explicit action obtains a host termination certificate. It does not
  // convert a receipt lookup into a retry or resend the unknown input.
  await this.action('接着完成中断的整理',()=>this.application.command('closeLostMaintenance',jobId),false);
 }
 async recoverQuestionReceipt(id:string){await this.recoverProjected(target=>target.kind==='question'&&target.questionId===id,'recover-question');}
 async resumeSceneParticipation(bookId:string,requestId?:string){if(!requestId)throw Error('请在活动面板找到这段共读，再点击继续。');await this.recoverProjected(target=>target.kind==='scene'&&target.bookId===bookId&&target.requestId===requestId);}
 async expandReply(id:string){this.requireModel();await this.action('展开当前话题',()=>this.dispatch(()=>this.application.command('expandReply',id)),false);}
 async newDiscussion(){let id='';await this.action('另开讨论',async()=>{if(!this.selectedBookId)throw Error('请先选择作品');id=await this.application.command('newDiscussion',this.selectedBookId);},false);return id;}
 async reconcileBookAnalysis(bookId:string){return this.application.command('reconcileBookAnalysis',bookId);}
 async listConversationMessages(bookId:string,query:import('../core/conversation-messages.ts').ConversationMessageQuery){return this.application.command('listConversationMessages',bookId,query);}
 async continueConversation(bookId:string){let id='';await this.action('接续下一段交流',async()=>{if(bookId!==this.selectedBookId)throw Error('作品已切换，请在当前交流中接续');id=await this.application.command('continueConversation',bookId);},false);return id;}
 async renameConversation(id:string,title:string){await this.action('修改对话名称',()=>this.application.command('renameConversation',id,title));}
 async updatePartner(name:string,traits:string){await this.action('保存当前伙伴特点',()=>this.application.command('updatePartner',this.engine.state.partnerId,name,traits));}
 async updatePartnerProfile(partnerId:string,profile:Parameters<WorkbenchClient['updatePartnerProfile']>[1]){await this.action('保存伙伴资料',()=>this.application.command('updatePartnerProfile',partnerId,profile),false);}
 async adoptPartnerPersona(partnerId:string,templateId:string){await this.action('采用人格',()=>this.application.command('adoptPartnerPersona',partnerId,templateId),false);}
 async createPartner(templateId:string){return this.application.command('createPartner',templateId);}
 async selectPartner(partnerId:string){this.markAutoStopped('切换阅读伙伴');this.following=false;this.followEpoch++;this.lastVisible='';await this.action('保存当前共读后切换伙伴',()=>this.application.command('selectPartner',partnerId),false);}
 async setPartnerAvatar(partnerId:string,dataUrl:string){return this.application.command('setPartnerAvatar',partnerId,dataUrl);}
 async getPartnerAvatar(assetId:string){return this.application.command('getPartnerAvatar',assetId);}
 async correctMemory(id:string,text:string){await this.action('更正伙伴理解',async()=>{this.following=false;this.followEpoch++;await this.application.command('correctMemory',id,text);});}
 async forgetMemory(id:string){await this.action('忘记指定理解',()=>this.application.command('forgetMemory',id));}
 markNote(note:string,chatId?:string){if(chatId&&!this.engine.state.chats.some(c=>c.id===chatId&&visibleReply(c)))return;this.log.note(note,chatId);if(chatId)this.dirtyRatings.add(chatId);this.publish();this.persistMetadata();}
 async setQuiet(value:boolean){await this.action(value?'开启安静模式':'关闭安静模式',()=>this.application.command('quiet',value),false);}
 async pause(){this.markAutoStopped('已停止自动伴读');this.following=false;this.followEpoch++;this.lastVisible='';await this.action('暂停伴读并保存已收到的回复',()=>this.application.command('pauseReadingSafely'),false);}
 async resume(){await this.action('继续伴读',()=>{this.engine.setModelDispatchAllowed(true);return this.application.command('resumeReadingSafely');},false);}
 stop():Promise<void>{
  if(this.stopRequest)return this.stopRequest;
  this.markAutoStopped('本次共读已结束');this.following=false;this.followEpoch++;this.lastVisible='';
  const work=this.action('等待回复并保存，结束本次共读',()=>this.application.command('stopReadingSafely'),false).then(()=>{if(!this.application.snapshot.session?.active&&this.application.snapshot.readingControl?.state!=='stopping'){this.notice='本次共读已结束，阅读记录和对话已保存，下次可继续交流。';this.publish();}}).finally(()=>{if(this.stopRequest===work)this.stopRequest=undefined;});
  this.stopRequest=work;return work;
 }
 markReply(chatId:string,rating:'accurate'|'resonant'|'verify',note?:string){if(!this.engine.state.chats.some(c=>c.id===chatId&&visibleReply(c)))return;this.log.rate(chatId,rating,note);this.dirtyRatings.add(chatId);this.publish();this.persistMetadata();}
 markHelpful(chatId:string){if(!this.engine.state.chats.some(c=>c.id===chatId&&visibleReply(c)))return;this.log.helpful(chatId);this.dirtyRatings.add(chatId);this.dirtyTimings.add(chatId);this.publish();this.persistMetadata();}
 async recordVisible(chatId:string,start:number,end:number){
  const chat=this.engine.state.chats.find(c=>c.id===chatId&&visibleReply(c));
  if(!chat||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end>chat.text.length||!chat.text.slice(start,end).trim()||/[\uDC00-\uDFFF]/u.test(chat.text[start]??'')||/[\uDC00-\uDFFF]/u.test(chat.text[end]??''))return false;
  this.log.visible(chatId,start,end);
  if(this.log.data.timings[chatId]?.visibleAt===undefined)return false;
  // A retry after a failed write must persist the original observation before acknowledging it.
  const log=this.log;await this.saveMetadata();if(this.log!==log)return false;
  this.dirtyTimings.add(chatId);this.publish();return true;
 }
 async refreshServices(){
  try{const [services,sources]=await Promise.all([this.bridge<WorkbenchService[]>('workbenchServices'),this.bridge<WorkbenchSource[]>('workbenchSources')]);this.services=services;this.sources=sources;this.historicalSourcesLoaded=false;}
  catch(error){this.notice='本机服务未连接，可继续使用界面演示';if(this.session?.mode==='live')this.error=(error as Error).message;}
  this.publish();
 }
 private fromMetadata(metadata:WorkbenchService):Service{return {id:metadata.id,name:metadata.name??metadata.id,baseUrl:metadata.baseUrl,model:metadata.model,contextLimit:metadata.contextLimit,maxOutput:metadata.maxOutput??4096,effort:metadata.effort??'high',enabled:false,secretRef:metadata.id,fallback:false,...(metadata.temperature!==undefined?{temperature:metadata.temperature}:{}),...(metadata.topP!==undefined?{topP:metadata.topP}:{}),thinking:metadata.thinking??(metadata.id.startsWith('custom-')?'none':'deepseek'),...(metadata.inputPrice!==undefined?{inputPrice:metadata.inputPrice}:{}),...(metadata.outputPrice!==undefined?{outputPrice:metadata.outputPrice}:{}),...(metadata.providerCapabilities?{providerCapabilities:structuredClone(metadata.providerCapabilities)}:{})};}
 async useService(sourceId:string){let selected:WorkbenchService|undefined;await this.action('选择模型服务',async()=>{
  const shared=this.services.some(s=>s.scope==='shared'&&s.id===sourceId),existing=this.services.find(s=>s.scope==='workbench'&&s.id===sourceId);
  const metadata=existing??(shared?(await this.bridge<{service:WorkbenchService}>('workbenchUseService',{sourceId})).service:undefined);
  if(!metadata)throw Error('模型服务不存在，请刷新服务列表');
  if(!existing)this.services=[...this.services.filter(s=>s.scope!=='workbench'||s.id!==metadata.id),metadata];
  selected=this.selectedService=metadata;
  this.notice='已选择模型服务，保存后用于AI共读';
 },'settings');return structuredClone(selected!);}
 discardServiceSelection(){this.selectedService=undefined;this.publish();}
 async setLanguage(language:'zh-CN'|'en',initializeDefaultPersona=false){await this.action('设置界面语言',()=>this.application.command('setLanguage',language,initializeDefaultPersona),'settings');}
 async updateSettings(settings:WorkbenchSettings){await this.action('保存模型与用量设置',async()=>{
  if(!Number.isSafeInteger(settings.pageChars)||settings.pageChars<200||settings.pageChars>6000)throw Error('每页字符应为200至6000');
  const native=this.services.find(s=>s.transport==='native-codex'&&s.baseUrl===settings.baseUrl);
  if(native&&(settings.model!==native.model||settings.effort!==(native.effort??'high')))throw Error('本机 Luna 渠道固定使用 gpt-6-luna / high，请保留该渠道的实际配置。');
  if(!Number.isSafeInteger(settings.tokenLimit)||settings.tokenLimit<0)throw Error('token 总上限应为非负整数');
  const activeLimit=(this.ledgerBudget??archiveBudget(this.engine.state)).tokenLimit;
  if(this.session.mode==='live'&&settings.tokenLimit!==activeLimit){const value=await this.bridge<Omit<WorkbenchBudget,'source'>|null>('workbenchUpdateBudget',{tokenLimit:settings.tokenLimit});if(value)this.ledgerBudget={...value,source:'ledger'};}
  const tokenLimit=this.ledgerBudget?.tokenLimit??settings.tokenLimit;
  if(this.session.mode==='live'){
   const matched=this.services.find(service=>service.scope==='workbench'&&service.baseUrl===settings.baseUrl&&service.model===settings.model&&(!settings.serviceId||service.id===settings.serviceId));
   if(matched?.transport==='native-codex'&&(settings.model!==matched.model||settings.effort!==(matched.effort??'high')))throw Error('本机 Luna 渠道固定使用 gpt-6-luna / high。请选择该渠道的实际配置。');
   const currentId=this.service.id,createCustom=!matched&&(this.services.some(s=>s.id===currentId&&s.transport==='native-codex')||!currentId.startsWith('custom-')&&settings.baseUrl!==this.service.baseUrl),id=matched?.id??(createCustom?undefined:currentId);
   // Existing tasks retain their captured model configuration; settings apply to new tasks.
   await this.application.command('saveModelSettings',{serviceId:id,...(matched?{metadata:this.fromMetadata(matched)}:{}),patch:{baseUrl:settings.baseUrl,model:settings.model,contextLimit:settings.contextLimit,maxOutput:settings.maxOutput,effort:settings.effort,thinking:settings.thinking??matched?.thinking??(!id||id.startsWith('custom-')?'none':'deepseek'),temperature:settings.temperature??null,topP:settings.topP??null,fallback:false},key:settings.apiKey??'',limits:{tokenLimit,readingEffort:settings.effort}});
  }else await this.application.command('updateLimits',{tokenLimit,readingEffort:settings.effort});
  if(this.autoReading.settings)this.autoReading={...this.autoReading,settings:{...this.autoReading.settings,tokenLimit}};
  this.selectedService=undefined;this.pageChars=settings.pageChars;this.engine.readingWindowChars=this.pageChars;this.notice=`后台模型与用量设置已保存；思考强度为${settings.effort}`;
 },'settings');}
 async createSession(mode:WorkbenchMode){await this.action('新建独立存档',()=>this.loadNew(mode),true,true);}
 private async stopArchiveSource(){this.following=false;this.followEpoch++;this.lastVisible='';await this.application.command('stopReadingSafely');await this.flush();}
 async switchMode(mode:WorkbenchMode){await this.action('切换运行方式，保留原存档',async()=>{const state=initialWorkbenchState(mode);let selected='';for(const book of this.engine.state.books)if(book.title!==offlineGuide.title){const copy=await importBook(book.title,book.text||await this.store.readBookText(book.version));Object.assign(copy,modeProfile('companion'));state.books.push(copy);if(book.id===this.selectedBookId)selected=copy.id;}await this.loadNew(mode,state,{selectedBookId:selected||state.books[0]?.id||'',pagePosition:this.pagePosition});this.notice='已建立独立存档并带入原文与浏览位置。原存档的理解、交流和用量保留，可从阅读存档打开。';});}
 async openSession(id:string){await this.action('打开阅读存档',async()=>{const session=this.environment.sessions.available().find(s=>s.id===id);if(!session)throw Error('存档不存在或已归档；历史归档仅提供导出');if(this.environment.fixedArchiveId){if(id===this.session.id)return;await this.stopArchiveSource();this.environment.sessions.markActive(id);await this.environment.sessions.flush();this.connectionTarget=id;}else await this.attach(session);},true,true);}
 async archiveSession(id:string){await this.action('归档旧阅读存档',async()=>{const count=this.environment.sessions.archive([id],this.session.id);this.notice=count?'旧存档已归档，资料、回复和用量记录仍可导出查看。':'该存档已归档。';},false);}
 async archiveOtherSessions(){await this.action('归档其它阅读存档',async()=>{const count=this.environment.sessions.archive(this.environment.sessions.available().filter(session=>session.id!==this.session.id).map(session=>session.id),this.session.id);this.notice=`已归档 ${count} 份旧存档；当前存档、读点和交流保持。`;},false);}
 async exportArchivedBackup(id:string){if(!this.environment.sessions.list().some(session=>session.id===id&&session.archivedAt))throw Error('归档存档不存在');if(!this.environment.prepareExport)throw Error('当前程序暂不支持导出文件');return this.environment.prepareExport({archiveId:id,kind:'backup',name:'伴读归档备份-'+id+'.json'});}
 async loadHistoricalSources(){if(this.historicalSourcesLoaded)return;const sources=await this.bridge<WorkbenchSource[]>('workbenchSources',{includeHistorical:true});this.sources=sources;this.historicalSourcesLoaded=true;this.publish();}
 async exportHistoricalSource(id:string){if(!this.sources.some(source=>source.id===id&&source.historical))throw Error('历史资料未载入清单');const result=await this.bridge<{filename:string;backup:string;historical:true}>('workbenchSource',{id,mode:'archive'});if(!result.historical||typeof result.backup!=='string')throw Error('历史资料导出格式不符');return{name:result.filename,text:result.backup};}
 async exportSession(options?:import('./contract.ts').WorkbenchExportOptions){
  return this.prepareHostExport('record','伴读测试-'+this.session.id+'.json',{session:this.session,clockDomain:this.log.clockDomain,mode:this.session.mode,offlineExternalCalls:this.session.mode==='offline'?0:undefined,settings:this.getSettings(),readingFlow:this.engine.readingFlow},options);
 }
 private async prepareHostExport(kind:'record'|'backup',name:string,metadata?:Record<string,unknown>,options?:import('./contract.ts').WorkbenchExportOptions){
  if(!this.environment.prepareExport)throw Error('当前程序暂不支持导出文件，请在桌面客户端导出备份');
  const archiveId=this.session.id;await this.flush();const result=await this.environment.prepareExport({archiveId,kind,name,exportId:options?.exportId,metadata,onProgress:stage=>{this.notice=({snapshot:'正在准备当前阅读存档',writing:'正在导出原文、阅读资料和处理记录',ready:'导出文件已准备好，正在开始下载',failed:'导出未完成，请查看处理详情后重试'} as Record<string,string>)[stage]??stage;this.publish();}});
  if(this.session.id!==archiveId)throw Error('导出时阅读存档已切换，请回到原存档查看导出结果');
  if(!('download'in result))throw Error('导出文件暂时无法下载，请稍后重试');
  this.exportPrepared={id:result.download.id,archiveId,kind,name,sha256:result.download.sha256,preparedAt:Date.now(),status:'prepared'};
  this.log.add('status','正常导出文件已准备',{detail:name});this.publish();this.persistMetadata();return result;
 }
 async exportBackup(options?:import('./contract.ts').WorkbenchExportOptions){return this.prepareHostExport('backup','伴读测试备份-'+this.session.id+'.json',undefined,options);}
 async readMemoryBody(bookId:string,memoryId:string){return this.application.command('readMemoryBody',bookId,memoryId);}
 async readMemoryEvidence(bookId:string,memoryId:string){return this.application.command('readMemoryEvidence',bookId,memoryId);}
 async listProcessEvents(beforeId?:string){const all=this.log.data.events,end=beforeId===undefined?all.length:all.findIndex(event=>event.id===beforeId);if(end<0)throw Error('这条记录已不在当前存档中');const events=structuredClone(all.slice(Math.max(0,end-80),end));return{events,beforeId:events[0]?.id,hasEarlier:end>events.length};}
 async discoverKnowledgeDocuments(bookId:string,query:{topic?:string;subject?:string;cursor?:string}={}){return this.application.command('discoverKnowledgeDocuments',bookId,query);}
 async listParagraphComments(bookId:string,query:{ranges?:{start:number;end:number}[];cursor?:string}={}){return this.application.command('listParagraphComments',bookId,query);}
 async postParagraphComment(bookId:string,input:import('../core/paragraph-comments.ts').UserParagraphComment){let commentId='';await this.action(input.parentId?'发表段评回复':'发表段评',async()=>{commentId=await this.application.command('postParagraphComment',bookId,input);},false);return commentId;}
 async confirmParagraphRead(bookId:string,range:{start:number;end:number},version:string){await this.action('确认本段已读',async()=>{const {page}=this.visibleText(range);if(page.bookId!==bookId||page.version!==version)throw Error('原文版本已变化，请重新打开本段段评。');await this.application.command('setKnown',bookId,range.end,range.start);},false);}
 async setParagraphCommentLiked(bookId:string,commentId:string,liked:boolean){await this.action(liked?'点赞段评':'取消段评点赞',()=>this.application.command('setParagraphCommentLiked',bookId,commentId,liked),false);}
 async setMessageEmojiReaction(bookId:string,targetId:string,emoji:string,active:boolean){await this.action('更新消息表情',()=>this.application.command('setMessageEmojiReaction',bookId,targetId,emoji,active),false);}
 async clearUnreadMessages(bookId:string,input:{partnerId:string;targetIds:string[]}):Promise<number>{return this.application.command('clearUnreadMessages',bookId,input);}
 async recordMessagePresentation(bookId:string,targetId:string,kind:'notified'|'seen'):Promise<boolean>{return this.application.command('recordMessagePresentation',bookId,targetId,kind);}
 async requestParagraphReply(bookId:string,commentId:string){this.requireModel();await this.action('请伙伴回应已发表的段评',()=>this.dispatch(async()=>{const action=this.log.add('action','段评回应开始',{chatId:commentId,detail:'沿已发表段评回复，不新增用户发言'});this.log.question(commentId,action);this.observationQuestions.add(commentId);await this.application.command('requestParagraphReply',bookId,commentId,true);}),false);}
 async askAboutParagraphComment(bookId:string,commentId:string,text:string){this.requireModel();await this.action('接着一条伙伴段评交流',()=>this.dispatch(async()=>{const action=this.log.add('action','段评追问开始',{detail:'保留读者原话，引用指定段评'}),pending={id:crypto.randomUUID(),action,before:new Set(this.engine.state.chats.map(c=>c.id)),bookId,text};this.pendingAsks.push(pending);try{await this.application.command('askAboutParagraphComment',bookId,commentId,text,true);}finally{this.pendingAsks=this.pendingAsks.filter(p=>p.id!==pending.id);}}),false);}
 clearNotice(){this.notice='';this.error='';this.publish();}
 async detachReadingSource(){this.setSourceVisible(false);if(this.following||this.engine.session?.active)await this.pause();await this.flush();}
 async reconnectClient(){this.markAutoStopped('页面重新连接，点击开始接续');this.following=false;this.sourceVisible=false;this.visibleRange=undefined;this.lastVisible='';this.sourceOwner=undefined;this.sourceRegistry.clear();this.sourceConnectionEpoch=crypto.randomUUID();this.followEpoch++;this.engine.setModelDispatchAllowed(false);this.engine.sourceActive(false);this.publish();}
 async flush(){await Promise.resolve();await this.saveMetadata();await this.store.flush();await this.environment.sessions.flush();}
 async dispose(){if(this.disposed)return;if(this.environment.browserEvents&&typeof window!=='undefined')window.removeEventListener('storage',this.sessionMetadataChanged);await this.saveMetadata();await this.release();this.disposed=true;this.listeners.clear();}
}
export async function createWorkbenchRuntime(environment:WorkbenchEnvironment):Promise<WorkbenchClient>{return WorkbenchController.create(environment);}
export const createWorkbench=createWorkbenchRuntime;
