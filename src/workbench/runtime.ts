import {HarnessRuntime} from '../agent/runtime.ts';
import {LocalApplication} from '../core/application.ts';
import {ReadingRuntime,restoreReadingEngine} from '../core/runtime.ts';
import {ChatModel,ModelOutputError} from '../core/model.ts';
import {modelEnvelopeError,ModelRequestError,ModelReceiptSaveError} from '../core/errors.ts';
import {initialState} from '../core/state.ts';
import {restoreBackup} from '../core/backup.ts';
import {bookLength,readingStart} from '../core/books.ts';
import type {ReadingEngine} from '../core/engine.ts';
import type {Service,State,Chat,TerminatedMaintenanceResume} from '../core/types.ts';
import type {WorkbenchClient,WorkbenchSnapshot,WorkbenchMode,WorkbenchSession,WorkbenchSettings,WorkbenchService,WorkbenchSource,WorkbenchPage,WorkbenchEvent} from './contract.ts';
import {WorkbenchStore,rememberSession,workbenchSessions,availableWorkbenchSessions,activeWorkbenchSession,markWorkbenchSessionActive,archiveWorkbenchSessions,exportArchivedWorkbenchBackup} from './store.ts';
import {WorkbenchEvents} from './events.ts';
import type {Observations} from './events.ts';
import {OfflineModel,offlineGuide} from './offline-model.ts';
import {chapterReadingRange,chapterBodyCoverage,isVolumeHeading} from './reading-layout.ts';

type Metadata={observations:Observations;pagePosition:number;selectedBookId:string;pageChars:number;importedHistory?:string};
const defaultPageChars=1400;
export function workbenchPageNumbers(end:number,bodyStart:number,textLength:number,pageChars:number){
 const totalPages=Math.max(1,Math.ceil((textLength-bodyStart)/pageChars));
 return {pageNumber:Math.min(totalPages,Math.max(1,Math.ceil((end-bodyStart)/pageChars))),totalPages};
}
const offlineService:Service={id:'custom-workbench-offline',name:'界面演练 · 固定技术回应',baseUrl:'https://workbench.invalid/v1',model:'offline-ui-rehearsal',contextLimit:1000000,maxOutput:4096,effort:'high',enabled:true,secretRef:'',fallback:false,thinking:'none'};
const visibleReply=(chat:Chat)=>chat.role==='assistant'&&chat.presentation!=='paragraph'&&!chat.excluded&&(!chat.readingReaction||chat.readingReaction.status==='delivered');
async function bridge<T>(method:string,input:unknown={},signal?:AbortSignal):Promise<T>{
 const isModel=method==='workbenchModel';if(isModel&&signal?.aborted)throw new ModelRequestError('请求尚未发出，已停止','not-dispatched');
 let response:Response,value:any;
 try {response=await fetch('/api/'+method,{method:'POST',headers:{'Content-Type':'application/json','X-Yixu-Client':'local-app'},body:JSON.stringify(input),signal});value=await response.json();}
 catch(error){if(isModel)throw modelEnvelopeError({});throw error;}
 if(value?.modelReceiptPending){const pending=value.modelReceiptPending;throw new ModelReceiptSaveError(pending.message,pending.response);}
 if(!response.ok){if(isModel)throw modelEnvelopeError(value);throw Error(value.error??'本机服务暂不可用，请确认服务已启动');}
 if(isModel&&value?.modelOutputError){const received=value.modelOutputError;throw new ModelOutputError(received.message,received.response,received.reason,received.outcome);}
 return value;
}

class WorkbenchController implements WorkbenchClient {
 private session!:WorkbenchSession;private store!:WorkbenchStore;private engine!:ReadingEngine;private runtime!:ReadingRuntime;private application!:LocalApplication;private harness!:HarnessRuntime;
 private log!:WorkbenchEvents;private unsubscribe?:()=>void;private listeners=new Set<()=>void>();private cached!:WorkbenchSnapshot;
 private selectedBookId='';private pagePosition=0;private pageChars=defaultPageChars;private services:WorkbenchService[]=[];private sources:WorkbenchSource[]=[];private historicalSourcesLoaded=false;
 private error='';private notice='';private importedHistory?:string;private busyAction=false;private disposed=false;private saveScheduled=false;private selectedService?:WorkbenchService;
 private following=false;private sourceVisible=false;private followEpoch=0;private lastVisible='';private navigationRevision=0;
 private pageLoading=false;private pageEpoch=0;private desiredPage='';private navigationDirection=0;private chapterCache=new Map<string,string>();private chapterLoads=new Map<string,Promise<void>>();private chapterFailures=new Set<string>();private pureVolumeHeadings=new Map<string,Set<number>>();private visibleRange?:{start:number;end:number};
 private lastFlow='';private seenChats=new Set<string>();private pendingAsks:Array<{id:string;action:WorkbenchEvent;before:Set<string>;bookId:string;text:string}>=[];private readingActions=0;
 static async create(){const controller=new WorkbenchController(),active=activeWorkbenchSession()??availableWorkbenchSessions()[0];if(active)await controller.attach(active);else await controller.loadNew('offline');await controller.refreshServices();if(typeof window!=='undefined')window.addEventListener('storage',controller.sessionMetadataChanged);return controller;}
 private sessionMetadataChanged=()=>{const metadata=workbenchSessions().find(session=>session.id===this.session?.id);if(!metadata?.archivedAt||this.session.archivedAt)return;this.session=metadata;this.following=false;this.followEpoch++;this.engine.sourceActive(false);void this.engine.stopReadingSafely().catch(error=>{this.error=(error as Error).message;this.publish();});this.notice='此存档已归档，停止新增处理；原记录保留，可在历史归档中导出。';this.publish();};
 getSnapshot=()=>this.cached;
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
 private get service(){return this.engine.state.settings.services.find(s=>s.id===this.engine.state.settings.serviceId)!;}
 private getSettings():WorkbenchSettings{const service=this.service;return {baseUrl:service?.baseUrl??'',model:service?.model??'',maxOutput:Math.min(service?.maxOutput??4096,16384),tokenLimit:this.engine.state.settings.tokenLimit,contextLimit:service?.contextLimit??200000,effort:service?.effort??'high',pageChars:this.pageChars};}
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
  }).catch(error=>{if(this.disposed||this.application!==application||epoch!==this.pageEpoch)return;this.chapterFailures.add(key);if(this.desiredPage===key){this.pageLoading=false;this.error='本章正文未载入：'+(error as Error).message;this.publish();}}).finally(()=>{if(this.chapterLoads.get(key)===work)this.chapterLoads.delete(key);});
  this.chapterLoads.set(key,work);
 }
 private publish(){
  if(!this.application||this.disposed)return;
  const selectedServiceId=this.service?.id;
  this.cached={sessionId:this.session.id,mode:this.session.mode,sessions:workbenchSessions(),app:this.application.snapshot,selectedBookId:this.selectedBookId,book:this.application.snapshot.state.books.find(b=>b.id===this.selectedBookId),page:this.page(),events:structuredClone(this.log.data.events),ratings:structuredClone(this.log.data.ratings),timings:structuredClone(this.log.data.timings),settings:this.getSettings(),selectedService:this.selectedService ? {...this.selectedService}:undefined,services:[...this.services],sources:[...this.sources],hasKey:this.services.some(s=>s.scope==='workbench'&&s.id===selectedServiceId&&s.hasKey),busyAction:this.busyAction,error:this.error,notice:this.notice,coreLabel:'阅读、交流与伙伴理解',importedHistory:this.importedHistory,following:this.following,modelReady:false,historicalSourcesLoaded:this.historicalSourcesLoaded,sessionArchived:!!this.session.archivedAt};
  this.cached.following=this.following;this.cached.pageLoading=this.pageLoading;this.cached.modelReady=!this.session.archivedAt&&(this.session.mode==='offline'||!!this.service?.enabled&&this.services.some(s=>s.scope==='workbench'&&s.id===this.service?.id&&s.hasKey));
  this.listeners.forEach(listener=>listener());
 }
 private persistMetadata(){
  if(this.saveScheduled||this.disposed)return;this.saveScheduled=true;
  queueMicrotask(()=>{this.saveScheduled=false;const store=this.store,metadata:Metadata={observations:this.log.data,pagePosition:this.pagePosition,selectedBookId:this.selectedBookId,pageChars:this.pageChars,importedHistory:this.importedHistory};void store.saveObservations(metadata).catch(()=>{if(this.store===store){this.error='阅读记录保存未完成，请保留输入并查看处理详情';this.publish();}});});
 }
 private changed(){
  const state=this.engine.state,flow=this.engine.readingFlow,signature=JSON.stringify(flow);
  if(signature!==this.lastFlow){this.lastFlow=signature;this.log.add('reading','阅读与交流队列变化',{readingFlow:flow,detail:`待处理 ${flow.pendingChars} 字，正在理解 ${flow.activeChars} 字，交流待完成 ${flow.foregroundPending} 条`});}
  for(const pending of [...this.pendingAsks]){const question=state.chats.find(c=>c.role==='user'&&c.bookId===pending.bookId&&c.text===pending.text&&!pending.before.has(c.id)&&!this.log.data.questions[c.id]);if(question){this.log.question(question.id,pending.action);this.pendingAsks=this.pendingAsks.filter(p=>p.id!==pending.id);}}
  for(const chat of state.chats)if(visibleReply(chat)&&!this.seenChats.has(chat.id)){this.log.ready(chat.id,chat.replyTo);this.seenChats.add(chat.id);}
  for(const event of this.application.takeUIEvents())if(event.kind==='error'||event.kind==='notice'){this[event.kind==='error'?'error':'notice']=event.text;this.log.add(event.kind==='error'?'error':'status',event.text);}
  this.publish();this.persistMetadata();
 }
 private async release(){this.unsubscribe?.();if(this.runtime){this.runtime.dispose();await this.harness.dispose();await this.store.close();}}
 private async attach(session:WorkbenchSession,state?:State){
  if(session.archivedAt||workbenchSessions().some(item=>item.id===session.id&&item.archivedAt))throw Error('此阅读存档已归档，仅可从历史归档导出，不会打开或恢复旧任务');
  this.pageEpoch++;this.chapterCache.clear();this.chapterLoads.clear();this.chapterFailures.clear();this.pureVolumeHeadings.clear();this.visibleRange=undefined;this.desiredPage='';
  this.following=false;this.sourceVisible=false;this.followEpoch++;this.lastVisible='';this.selectedService=undefined;
  await this.release();this.session=session;this.store=new WorkbenchStore(session.id);
  if(state)await this.store.save(state);
  const metadata=await this.store.loadObservations<Metadata>();this.log=new WorkbenchEvents(session.mode,metadata?.observations);this.pageChars=metadata?.pageChars??defaultPageChars;this.importedHistory=metadata?.importedHistory;
  const model=session.mode==='offline'?new OfflineModel():new ChatModel(async(request,signal)=>{
   if(workbenchSessions().some(item=>item.id===session.id&&item.archivedAt))throw new ModelRequestError('此阅读存档已归档，未派发模型请求','not-dispatched');
   const begin=this.log.add('model','模型请求派发',{requestId:request.requestId,detail:'测试台独立渠道'});this.publish();this.persistMetadata();
   try {const result=await bridge<{status:number;body:Record<string,any>}>('workbenchModel',request,signal);this.log.add('model','模型响应返回',{requestId:request.requestId,elapsedMs:performance.now()-begin.clockMs});
    for(const call of result.body.choices?.[0]?.message?.tool_calls??[])this.log.add('tool','模型请求取材或提交',{requestId:request.requestId,detail:String(call.function?.name??'工具')});return result;
   }catch(error){this.log.add('error',(error as Error).message,{requestId:request.requestId});throw error;}finally{this.publish();this.persistMetadata();}
  },requestId=>bridge('workbenchQueryReceipt',{requestId}));
  const restored=await restoreReadingEngine(this.store,model);this.engine=restored.engine;
  if(session.mode==='live'){await this.engine.editState(s=>{s.settings.services.forEach(service=>{service.enabled=false;});});}
  this.harness=new HarnessRuntime();this.engine.agent=this.harness;
  this.runtime=new ReadingRuntime(this.engine,{available:false,async request(){return {} as never;}});
  const originalReaction=this.engine.onReaction;this.engine.onReaction=text=>{originalReaction?.(text);this.log.add('reading','核心放行主动反应',{detail:'实际可见时间由页面记录'});this.publish();this.persistMetadata();};
  this.application=new LocalApplication(this.runtime,async<T>(method:string,payload:unknown):Promise<T>=>{
   if(method==='services')return this.services.filter(s=>s.scope==='workbench') as T;
   if(method==='saveSecret'){await bridge('workbenchSaveSecret',payload);await this.refreshServices();return {ok:true} as T;}
   throw Error('测试台尚未提供此设备能力');
  });
  this.lastFlow='';this.seenChats=new Set(this.engine.state.chats.filter(visibleReply).map(c=>c.id));this.pendingAsks=[];
  this.selectedBookId=metadata?.selectedBookId&&this.engine.state.books.some(b=>b.id===metadata.selectedBookId)?metadata.selectedBookId:this.engine.state.books[0]?.id??'';
  const book=this.engine.state.books.find(b=>b.id===this.selectedBookId);this.pagePosition=metadata?.pagePosition??(book?Math.max(readingStart(book),book.position-1):0);
  this.unsubscribe=this.application.subscribe(()=>this.changed());markWorkbenchSessionActive(session.id);this.error='';this.notice=session.mode==='offline'?'当前为演示模式，可在模型设置中启用服务':'真实存档已打开，选择模型服务并保存后可开始共读';this.publish();
 }
 private async loadNew(mode:WorkbenchMode,state?:State){
  const session:WorkbenchSession={id:crypto.randomUUID(),mode,title:mode==='offline'?'界面演示':'真实共读',createdAt:Date.now()};
  if(!state){state=initialState();state.settings.readingEffort='high';state.settings.defaultQuiet=false;if(mode==='offline'){state.settings.services=[{...offlineService}];state.settings.serviceId=offlineService.id;state.settings.tokenLimit=20000000;}}
  else if(mode==='offline'){state.settings.services=state.settings.services.filter(s=>s.id!==offlineService.id);state.settings.services.forEach(s=>{s.enabled=false;});state.settings.services.push({...offlineService});state.settings.serviceId=offlineService.id;}
  if(mode==='live'&&this.selectedService&&!state.books.length){const metadata=this.selectedService;const service=this.fromMetadata(metadata);state.settings.services=state.settings.services.filter(s=>s.id!==service.id);state.settings.services.push(service);state.settings.serviceId=service.id;}
  rememberSession(session);await this.attach(session,state);
  if(mode==='offline'&&!this.engine.state.books.length){const imported=await this.application.command('importText',offlineGuide.title,offlineGuide.text);this.selectedBookId=imported.bookId;await this.application.command('setReadingMode',imported.bookId,'companion');this.pagePosition=0;}
  this.log.add('status','独立存档已打开',{detail:mode==='offline'?'界面演练，无外部模型调用':'模型尚未启用'});this.publish();this.persistMetadata();
 }
 private async action(title:string,work:()=>Promise<void>,exclusive=true,archiveExit=false){
  if(this.disposed)throw Error('测试存档已关闭');if(this.session?.archivedAt&&!archiveExit)throw Error('此阅读存档已归档，不能继续旧任务；请使用当前正常存档');if(this.busyAction)throw Error('正在切换阅读存档或更改设置，请稍候');
  if(exclusive&&(this.readingActions||this.engine?.busy))throw Error('请先暂停或停止当前处理，再切换档案或配置');
  if(exclusive)this.busyAction=true;else this.readingActions++;this.error='';this.log.add('action',title);this.publish();
  try{await work();}catch(error){this.error=(error as Error).message??'操作未完成';this.log.add('error',this.error);throw error;}finally{if(exclusive)this.busyAction=false;else this.readingActions--;this.publish();this.persistMetadata();}
 }
 async importTxt(name:string,text:string){await this.action('导入本机文本',async()=>{const result=await this.application.command('importText',name,text);this.selectedBookId=result.bookId;await this.application.command('setReadingMode',result.bookId,'companion');this.pagePosition=readingStart(this.engine.book(result.bookId));});}
 async importBackup(raw:string){await this.action('导入备份到新存档',async()=>{const state=await restoreBackup(raw,initialState());const mode=this.session.mode;await this.loadNew(mode,state);this.importedHistory=`导入历史：${state.usage.length}条原用量记录（含原未知状态），本存档新增记录另列`;});}
 async importSource(id:string){if(this.sources.some(source=>source.id===id&&source.historical))throw Error('历史资料仅可导出，不会导入当前存档');await this.action('载入本机阅读资料的独立副本',async()=>{const result=await bridge<{title:string;state:State}>('workbenchSource',{id});const state=await restoreBackup(JSON.stringify(result.state),initialState());const mode=id==='knowledge20-checkpoint'||id==='knowledge20-empty'?'live':this.session.mode;await this.loadNew(mode,state);this.importedHistory=`${result.title}；保留${state.usage.length}条原用量，含原未知状态。`;this.notice=mode==='live'?'已载入真实共读的独立副本，原理解与用量保留。选择一次模型服务并保存，即可开始。':'历史材料已载入独立副本，原记录保留。';});}
 async selectBook(id:string){await this.action('选择作品',async()=>{this.following=false;this.followEpoch++;this.lastVisible='';this.engine.sourceActive(false);await this.application.command('selectBook',id);this.selectedBookId=id;this.visibleRange=undefined;this.pageEpoch++;this.chapterLoads.clear();this.chapterFailures.clear();const book=this.engine.book(id);this.pagePosition=Math.max(readingStart(book),book.position-1);this.navigationRevision++;});}
 async jumpTo(position:number){if(this.busyAction)throw Error('正在切换阅读存档或更改设置，请稍候');if(!Number.isSafeInteger(position))throw Error('跳转位置无效');this.navigationDirection=Math.sign(position-this.pagePosition);this.pagePosition=Math.max(0,position);this.navigationRevision++;this.visibleRange=undefined;this.chapterFailures.clear();this.sourceVisible=false;this.lastVisible='';if(this.engine.session?.observing)this.engine.sourceActive(false);this.log.add('action','浏览跳转',{detail:'本机浏览，未增加模型授权'});this.publish();this.persistMetadata();}
 async turnPage(delta:number){const page=this.page(),position=delta<0?page?.previousChapterStart:page?.nextChapterStart;if(position!==undefined)await this.jumpTo(position);}
 recordReadingPosition(position:number){const page=this.page();if(!page||!Number.isSafeInteger(position)||position<page.start||position>=page.end||position===this.pagePosition)return;this.pagePosition=position;this.publish();this.persistMetadata();}
 async provideToCurrent(){if(!this.visibleRange||!this.sourceVisible)throw Error('请从屏幕中实际可见的正文开始跟随');await this.startFollowing(this.visibleRange);}
 async startReading(){await this.provideToCurrent();}
 private requireModel(){if(this.session.archivedAt)throw Error('已归档存档不能派发模型请求');if(this.session.mode==='live'&&!this.cached.modelReady)throw Error('真实模型服务尚未启用。请打开“模型设置”，选择模型服务并保存，然后开始共读。');}
 private visibleText(range:{start:number;end:number}){const page=this.page();if(!page||!Number.isSafeInteger(range.start)||!Number.isSafeInteger(range.end)||range.start<page.start||range.end>page.end||range.end<=range.start)throw Error('阅读位置已变化，请回到原文后重新开始跟随。');return {page,text:page.text.slice(range.start-page.start,range.end-page.start)};}
 async startFollowing(range:{start:number;end:number}){
  this.requireModel();const {page}=this.visibleText(range),epoch=++this.followEpoch;this.visibleRange={...range};this.following=true;this.sourceVisible=true;this.lastVisible='';this.publish();
  try {await this.action('开始跟随当前可见正文',async()=>{
   if(this.application.snapshot.readingControl?.state==='paused')await this.application.command('resumeReadingSafely');
   await this.application.command('startReading',page.bookId);
   if(epoch!==this.followEpoch||!this.following)return;
   this.engine.observing(true);this.engine.sourceActive(this.sourceVisible);
   if(this.sourceVisible){const actual=this.visibleRange??range,latest=this.visibleText(actual);this.lastVisible=`${latest.page.bookId}:${actual.start}:${actual.end}`;await this.engine.observe(latest.page.bookId,latest.text,'body','continuous-page',{version:latest.page.version,...actual});}
  },false);}catch(error){if(epoch===this.followEpoch){this.following=false;this.engine.sourceActive(false);this.publish();}throw error;}
 }
 async followVisible(range:{start:number;end:number}){
  if(!this.following||!this.sourceVisible||!this.engine.session?.observing||this.busyAction)return;
  const {page,text}=this.visibleText(range),key=`${page.bookId}:${range.start}:${range.end}`;if(key===this.lastVisible)return;this.lastVisible=key;this.visibleRange={...range};const epoch=this.followEpoch;this.requireModel();
  try{await this.action('跟随可见正文',()=>this.engine.observe(page.bookId,text,'body','continuous-page',{version:page.version,...range}),false);}catch(error){if(epoch!==this.followEpoch)return;this.following=false;this.followEpoch++;this.engine.sourceActive(false);this.publish();throw error;}
 }
 setSourceVisible(value:boolean,range?:{start:number;end:number}){if(value&&range){this.visibleText(range);this.visibleRange={...range};}if(!value)this.visibleRange=undefined;if(value===this.sourceVisible)return;this.sourceVisible=value;if(!value)this.lastVisible='';if(this.following)this.engine.sourceActive(value);this.publish();}
 async preparePrevious(through:number,from?:number){this.requireModel();const epoch=++this.followEpoch;this.following=false;await this.action('补齐明确已读的前文',async()=>{if(!this.selectedBookId)throw Error('请先选择作品');const id=this.selectedBookId;await this.application.command('setKnown',id,through,from);if(epoch!==this.followEpoch)return;await this.application.command('startReading',id);if(epoch!==this.followEpoch)return;if(this.application.snapshot.readingControl?.state==='paused')await this.application.command('resumeReadingSafely');if(epoch!==this.followEpoch)return;await this.application.command('prepare',id);},false);}
 async sendMessage(text:string,long=false,conversationId?:string){this.requireModel();await this.action('发送交流问题',async()=>{if(!this.selectedBookId)throw Error('请先选择作品');const action=this.log.add('action','问题开始',{detail:long?'明确长答':'短交流'}),pending={id:crypto.randomUUID(),action,before:new Set(this.engine.state.chats.map(c=>c.id)),bookId:this.selectedBookId,text};this.pendingAsks.push(pending);try{await this.application.command('ask',pending.bookId,text,long,conversationId);}finally{this.pendingAsks=this.pendingAsks.filter(p=>p.id!==pending.id);}},false);}
 async retryQuestion(id:string){this.requireModel();await this.action('接续原问题',()=>this.application.command('retryQuestion',id),false);}
 async resumeTerminatedMaintenance(input:TerminatedMaintenanceResume){this.requireModel();await this.action('接续已确认终止的原维护任务',async()=>{const current=this.application.snapshot,job=current.state.maintenanceJobs?.find(j=>j.id===input.jobId);if(!job||job.bookId!==this.selectedBookId)throw Error('原维护任务不属于当前作品，未接续');if(current.readingControl?.state==='paused')await this.application.command('resumeReadingSafely');const session=this.application.snapshot.session;if(!session?.active||session.bookId!==job.bookId||session.mode!=='reading')await this.application.command('startReading',job.bookId);await this.application.command('resumeTerminatedMaintenance',input);},false);}
 async resumeMaintenance(jobId:string){this.requireModel();await this.action('取回原答并继续后台整理',async()=>{const current=this.application.snapshot,job=current.state.maintenanceJobs?.find(j=>j.id===jobId);if(!job||job.bookId!==this.selectedBookId)throw Error('请先打开原维护所属作品');const session=current.session;if(!session?.active||session.bookId!==job.bookId||session.mode!=='reading')await this.application.command('startReading',job.bookId);await this.application.command('resumeMaintenance',jobId);},false);}
 async recoverQuestionReceipt(id:string){await this.action('读取并恢复原答',()=>this.application.command('recoverQuestionReceipt',id),false);}
 async resumeSceneParticipation(bookId:string){await this.action('恢复已收到结果',async()=>{if(bookId!==this.selectedBookId)throw Error('请先打开需要恢复结果的书籍。');await this.application.command('resumeSceneParticipation',bookId);},false);}
 async expandReply(id:string){this.requireModel();await this.action('展开当前话题',()=>this.application.command('expandReply',id),false);}
 async newDiscussion(){let id='';await this.action('另开讨论',async()=>{if(!this.selectedBookId)throw Error('请先选择作品');id=await this.application.command('newDiscussion',this.selectedBookId);},false);return id;}
 async renameConversation(id:string,title:string){await this.action('修改对话名称',()=>this.application.command('renameConversation',id,title));}
 async updatePartner(name:string,traits:string){await this.action('保存当前伙伴特点',()=>this.application.command('updatePartner',this.engine.state.partnerId,name,traits));}
 async correctMemory(id:string,text:string){await this.action('更正伙伴理解',async()=>{this.following=false;this.followEpoch++;await this.application.command('correctMemory',id,text);});}
 async forgetMemory(id:string){await this.action('忘记指定理解',()=>this.application.command('forgetMemory',id));}
 markNote(note:string,chatId?:string){if(chatId&&!this.engine.state.chats.some(c=>c.id===chatId&&visibleReply(c)))return;this.log.note(note,chatId);this.publish();this.persistMetadata();}
 async setQuiet(value:boolean){await this.action(value?'开启安静模式':'关闭安静模式',()=>this.application.command('quiet',value),false);}
 async pause(){this.following=false;this.followEpoch++;this.lastVisible='';await this.action('暂停新跟随，保存已发请求',()=>this.application.command('pauseReadingSafely'),false);}
 async resume(){await this.action('接续原共读任务',()=>this.application.command('resumeReadingSafely'),false);}
 async stop(){this.following=false;this.followEpoch++;this.lastVisible='';await this.action('结束本次共读，收好已发请求',()=>this.application.command('stopReadingSafely'),false);if(!this.application.snapshot.session?.active&&this.application.snapshot.readingControl?.state!=='stopping'){this.notice='本次共读已结束，已收到的回复与阅读记录已保存。';this.publish();}}
 markReply(chatId:string,rating:'accurate'|'resonant'|'verify',note?:string){if(!this.engine.state.chats.some(c=>c.id===chatId&&visibleReply(c)))return;this.log.rate(chatId,rating,note);this.publish();this.persistMetadata();}
 markHelpful(chatId:string){if(!this.engine.state.chats.some(c=>c.id===chatId&&visibleReply(c)))return;this.log.helpful(chatId);this.publish();this.persistMetadata();}
 recordVisible(chatId:string,start?:number,end?:number){if(!this.engine.state.chats.some(c=>c.id===chatId&&visibleReply(c)))return;if(this.log.visible(chatId,start,end)){this.publish();this.persistMetadata();}}
 async refreshServices(){
  try{const [services,sources]=await Promise.all([bridge<WorkbenchService[]>('workbenchServices'),bridge<WorkbenchSource[]>('workbenchSources')]);this.services=services;this.sources=sources;this.historicalSourcesLoaded=false;}
  catch(error){this.notice='本机服务未连接，可继续使用界面演示';if(this.session?.mode==='live')this.error=(error as Error).message;}
  this.publish();
 }
 private fromMetadata(metadata:WorkbenchService):Service{return {id:metadata.id,name:metadata.name??metadata.id,baseUrl:metadata.baseUrl,model:metadata.model,contextLimit:metadata.contextLimit,maxOutput:Math.min(metadata.maxOutput??4096,16384),effort:metadata.effort??'high',enabled:false,secretRef:metadata.id,fallback:false,thinking:metadata.id.startsWith('custom-')?'none':'deepseek'};}
 async useService(sourceId:string){await this.action('选择模型服务',async()=>{
  const shared=this.services.some(s=>s.scope==='shared'&&s.id===sourceId),existing=this.services.find(s=>s.scope==='workbench'&&s.id===sourceId);
  const metadata=existing??(shared?(await bridge<{service:WorkbenchService}>('workbenchUseService',{sourceId})).service:undefined);
  if(!metadata)throw Error('模型服务不存在，请刷新服务列表');await this.refreshServices();
  this.selectedService=metadata;
  this.notice='已选择模型服务，保存后用于AI共读';
 });}
 discardServiceSelection(){this.selectedService=undefined;this.publish();}
 async updateSettings(settings:WorkbenchSettings){await this.action('保存模型与用量设置',async()=>{
  if(!Number.isSafeInteger(settings.pageChars)||settings.pageChars<200||settings.pageChars>6000)throw Error('每页字符应为200至6000');
  await this.application.command('updateLimits',{tokenLimit:settings.tokenLimit,readingEffort:settings.effort});
  if(this.session.mode==='live'){
   const matched=this.services.find(service=>service.scope==='workbench'&&service.baseUrl===settings.baseUrl&&service.model===settings.model);
   let id=this.service.id;
   if(matched){id=matched.id;await this.engine.editState(state=>{if(!state.settings.services.some(s=>s.id===id))state.settings.services.push(this.fromMetadata(matched));state.settings.serviceId=id;});}
   else if(!id.startsWith('custom-')&&settings.baseUrl!==this.service.baseUrl)id=await this.application.command('addService');
   await this.application.command('updateService',id,{baseUrl:settings.baseUrl,model:settings.model,contextLimit:settings.contextLimit,maxOutput:settings.maxOutput,effort:settings.effort,thinking:id.startsWith('custom-')?'none':'deepseek',fallback:false});
   await this.application.command('selectService',id);await this.application.command('enableService',id,settings.apiKey??'');
  }
  this.selectedService=undefined;this.pageChars=settings.pageChars;this.notice=`模型与用量设置已保存；思考强度为${settings.effort}`;
 });}
 async createSession(mode:WorkbenchMode){await this.action('新建独立存档',()=>this.loadNew(mode),true,true);}
 async switchMode(mode:WorkbenchMode){await this.action('切换运行方式，保留原存档',async()=>{const books=[];for(const book of this.engine.state.books)books.push({...book,text:book.text||await this.store.readBookText(book.version)});const selected=this.selectedBookId,position=this.pagePosition;await this.loadNew(mode);for(const book of books){if(book.text&&book.title!==offlineGuide.title){const result=await this.application.command('importText',book.title,book.text);await this.application.command('setReadingMode',result.bookId,'companion');if(book.id===selected){this.selectedBookId=result.bookId;this.pagePosition=position;}}}this.notice='已建立独立存档并带入原文与浏览位置。原存档的理解、交流和用量保留，可从阅读存档打开。';});}
 async openSession(id:string){await this.action('打开阅读存档',async()=>{const session=availableWorkbenchSessions().find(s=>s.id===id);if(!session)throw Error('存档不存在或已归档；历史归档仅提供导出');await this.attach(session);},true,true);}
 async archiveSession(id:string){await this.action('归档旧阅读存档',async()=>{const count=archiveWorkbenchSessions([id],this.session.id);this.notice=count?'旧存档已归档，原资料、回执及用量保留；不会自动打开或接续。':'该存档已归档。';},false);}
 async archiveOtherSessions(){await this.action('归档其它阅读存档',async()=>{const count=archiveWorkbenchSessions(availableWorkbenchSessions().filter(session=>session.id!==this.session.id).map(session=>session.id),this.session.id);this.notice=`已归档 ${count} 份旧存档；当前存档、读点和交流保持。`;},false);}
 async exportArchivedBackup(id:string){return{name:'伴读归档备份-'+id+'.json',text:await exportArchivedWorkbenchBackup(id)};}
 async loadHistoricalSources(){if(this.historicalSourcesLoaded)return;const sources=await bridge<WorkbenchSource[]>('workbenchSources',{includeHistorical:true});this.sources=sources;this.historicalSourcesLoaded=true;this.publish();}
 async exportHistoricalSource(id:string){if(!this.sources.some(source=>source.id===id&&source.historical))throw Error('历史资料未载入清单');const result=await bridge<{filename:string;backup:string;historical:true}>('workbenchSource',{id,mode:'archive'});if(!result.historical||typeof result.backup!=='string')throw Error('历史资料导出格式不符');return{name:result.filename,text:result.backup};}
 async exportSession(){
  const chats=this.engine.state.chats.map(({readingReaction,...chat})=>({...chat,...(readingReaction?{readingReaction:{requestKey:readingReaction.requestKey,status:readingReaction.status}}:{})}));
  const value={schema:'yixu-workbench-run/v1',session:this.session,exportedAt:new Date().toISOString(),clockDomain:this.log.clockDomain,replyClockDomains:this.log.data.readyDomains,questionActions:this.log.data.questions,mode:this.session.mode,offlineExternalCalls:this.session.mode==='offline'?0:undefined,settings:this.getSettings(),readingFlow:this.engine.readingFlow,events:this.log.data.events,timings:this.log.data.timings,ratings:this.log.data.ratings,chats,books:this.engine.state.books.map(({text,...book})=>book),usage:this.engine.state.usage,importedHistory:this.importedHistory};
  return {name:'伴读测试-'+this.session.id+'.json',text:JSON.stringify(value,null,2)};
 }
 async exportBackup(){const text=await this.application.command('exportBackup',false);return {name:'伴读测试备份-'+this.session.id+'.json',text};}
 async readMemoryBody(bookId:string,memoryId:string){return this.application.command('readMemoryBody',bookId,memoryId);}
 async discoverKnowledgeDocuments(bookId:string,query:{topic?:string;subject?:string;cursor?:string}={}){return this.application.command('discoverKnowledgeDocuments',bookId,query);}
 async listParagraphComments(bookId:string,query:{ranges?:{start:number;end:number}[];cursor?:string}={}){return this.application.command('listParagraphComments',bookId,query);}
 async postParagraphComment(bookId:string,input:import('../core/paragraph-comments.ts').UserParagraphComment){let commentId='';await this.action(input.parentId?'发表段评回复':'发表段评',async()=>{commentId=await this.application.command('postParagraphComment',bookId,input);},false);return commentId;}
 async confirmParagraphRead(bookId:string,range:{start:number;end:number},version:string){await this.action('确认本段已读',async()=>{const {page}=this.visibleText(range);if(page.bookId!==bookId||page.version!==version)throw Error('原文版本已变化，请重新打开本段段评。');await this.application.command('setKnown',bookId,range.end,range.start);},false);}
 async setParagraphCommentLiked(bookId:string,commentId:string,liked:boolean){await this.action(liked?'点赞段评':'取消段评点赞',()=>this.application.command('setParagraphCommentLiked',bookId,commentId,liked),false);}
 async requestParagraphReply(bookId:string,commentId:string){this.requireModel();await this.action('请伙伴回应已发表的段评',async()=>{const action=this.log.add('action','段评回应开始',{chatId:commentId,detail:'沿已发表段评回复，不新增用户发言'});this.log.question(commentId,action);await this.application.command('requestParagraphReply',bookId,commentId);},false);}
 async askAboutParagraphComment(bookId:string,commentId:string,text:string){this.requireModel();await this.action('接着一条伙伴段评交流',async()=>{const action=this.log.add('action','段评追问开始',{detail:'保留读者原话，引用指定段评'}),pending={id:crypto.randomUUID(),action,before:new Set(this.engine.state.chats.map(c=>c.id)),bookId,text};this.pendingAsks.push(pending);try{await this.application.command('askAboutParagraphComment',bookId,commentId,text);}finally{this.pendingAsks=this.pendingAsks.filter(p=>p.id!==pending.id);}},false);}
 clearNotice(){this.notice='';this.error='';this.publish();}
 async dispose(){if(this.disposed)return;if(typeof window!=='undefined')window.removeEventListener('storage',this.sessionMetadataChanged);await this.store.saveObservations({observations:this.log.data,pagePosition:this.pagePosition,selectedBookId:this.selectedBookId,pageChars:this.pageChars,importedHistory:this.importedHistory});this.disposed=true;await this.release();this.listeners.clear();}
}
export async function createWorkbenchRuntime():Promise<WorkbenchClient>{return WorkbenchController.create();}
export const createWorkbench=createWorkbenchRuntime;
