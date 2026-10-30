import type {WorkbenchSnapshot,WorkbenchSourceIdentity} from './contract.ts';
import {readingParagraphs} from './reading-layout.ts';
import type {ReplyRating,ReplyTiming,WorkbenchEvent,WorkbenchMode,WorkbenchRating} from './contract.ts';
import type {ReadingObservationSaved} from '../core/types.ts';
/** Late successful saves remain in history but cannot replace a newer viewport receipt. */
export function latestReadingObservationSaved(previous:ReadingObservationSaved|undefined,event:ReadingObservationSaved,current:{instanceId:string;sessionId?:string;observation?:number},book:{id:string;version:string}|undefined,partnerId:string):ReadingObservationSaved|undefined{
 if(!book||event.instanceId!==current.instanceId||event.sessionId!==current.sessionId||event.bookId!==book.id||event.version!==book.version||event.partnerId!==partnerId||current.observation===undefined||event.observation>current.observation)return previous;
 if(previous&&previous.instanceId===event.instanceId&&previous.sessionId===event.sessionId&&previous.bookId===event.bookId&&previous.version===event.version&&previous.observation>event.observation)return previous;
 return structuredClone(event);
}
export type Observations={events:WorkbenchEvent[];ratings:Record<string,WorkbenchRating>;timings:Record<string,ReplyTiming>;questions:Record<string,{at:number;domain:string}>;readyDomains:Record<string,string>};
export class WorkbenchEvents {
 readonly clockDomain='browser-performance:'+crypto.randomUUID();
 readonly data:Observations;
 private mode:WorkbenchMode;private clock:()=>number;
 constructor(mode:WorkbenchMode,data?:Observations,clock=()=>performance.now()){
  this.mode=mode;this.clock=clock;
  this.data=data??{events:[],ratings:{},timings:{},questions:{},readyDomains:{}};
  this.data.questions??={};this.data.readyDomains??={};
 }
 add(kind:WorkbenchEvent['kind'],title:string,fields:Partial<WorkbenchEvent>={}){
  const event:WorkbenchEvent={id:crypto.randomUUID(),kind,title,at:Date.now(),clockMs:this.clock(),clockDomain:this.clockDomain,mode:this.mode,...fields};this.data.events.push(event);return event;
 }
 observationSaved(event:ReadingObservationSaved){return this.add('reading','可见正文许可已保存',{readingObservation:structuredClone(event)});}
 question(chatId:string,action:WorkbenchEvent){this.data.questions[chatId]={at:action.clockMs,domain:action.clockDomain};}
 ready(chatId:string,questionId?:string){
  if(this.data.timings[chatId])return;
  const readyAt=this.clock(),action=questionId?this.data.questions[questionId]:undefined;
  this.data.timings[chatId]={chatId,questionId,readyAt,...(action?.domain===this.clockDomain?{actionStartedAt:action.at}:{})};this.data.readyDomains[chatId]=this.clockDomain;
  this.add('reply','答复已由核心放行',{chatId,detail:'页面实际可见时间尚未采集'});
 }
 visible(chatId:string,start?:number,end?:number){
  const timing=this.data.timings[chatId];if(!timing||timing.visibleAt!==undefined)return false;
  timing.visibleAt=this.clock();if(start!==undefined&&end!==undefined&&end>start)timing.visibleRange={start,end};
  const action=timing.questionId?this.data.questions[timing.questionId]:undefined;
  if(action?.domain===this.clockDomain&&this.data.readyDomains[chatId]===this.clockDomain)timing.firstVisibleMs=Math.max(0,timing.visibleAt-action.at);
  this.add('visible','答复实际进入可见区域',{chatId,elapsedMs:timing.firstVisibleMs});return true;
 }
 rate(chatId:string,value:ReplyRating,note?:string){
  const prior=this.data.ratings[chatId]??{chatId,values:[],note:'',helpful:false,at:Date.now()};
  prior.values=note!==undefined?[...new Set([...prior.values,value])]:prior.values.includes(value)?prior.values.filter(v=>v!==value):[...prior.values,value];if(note!==undefined)prior.note=note;prior.at=Date.now();this.data.ratings[chatId]=prior;this.add('rating','人工评价已保存',{chatId,detail:value});
 }
 helpful(chatId:string){
  const prior=this.data.ratings[chatId]??{chatId,values:[],note:'',helpful:false,at:Date.now()};prior.helpful=true;prior.at=Date.now();this.data.ratings[chatId]=prior;
  if(this.data.timings[chatId])this.data.timings[chatId].userMarkedHelpful=true;this.add('rating','读者标记有用',{chatId});
 }
 note(note:string,chatId?:string){
  if(chatId){const prior=this.data.ratings[chatId]??{chatId,values:[],note:'',helpful:false,at:Date.now()};prior.note=note;prior.at=Date.now();this.data.ratings[chatId]=prior;}
  this.add('rating','读者体验备注',{chatId,detail:note});
 }
}

/** Public DOM observation contract. Metadata only; all controls retain normal UI actions. */
export function workbenchSourceIdentity(snapshot:Pick<WorkbenchSnapshot,'sessionId'|'page'>):WorkbenchSourceIdentity|undefined{
 const page=snapshot.page;return page?{archiveId:snapshot.sessionId,bookId:page.bookId,version:page.version,start:page.start,end:page.end,navigationRevision:page.navigationRevision}:undefined;
}
export function sameWorkbenchSource(left:WorkbenchSourceIdentity|undefined,right:WorkbenchSourceIdentity|undefined):boolean{
 return!!left&&!!right&&left.archiveId===right.archiveId&&left.bookId===right.bookId&&left.version===right.version&&left.start===right.start&&left.end===right.end&&left.navigationRevision===right.navigationRevision;
}
export function workbenchAutomationAttributes(snapshot:WorkbenchSnapshot,readerUnobstructed:boolean){
  const {app,book,page}=snapshot,observation=snapshot.readingObservation,progress=app.maintenanceProgress.find(item=>item.bookId===book?.id);
  const owned=app.activities.filter(item=>item.bookId===book?.id&&item.partnerId===app.state.partnerId&&(item.kind==='maintenance'||item.sessionId===app.session?.id)&&['running','unfinished'].includes(item.responsibility??''));
  const service=app.state.settings.services.find(item=>item.id===app.state.settings.serviceId),paragraphs=page?readingParagraphs(page.text,page.start,page.chapterTitle):[];
  const range=observation?.visibleRange,saved=observation?.saved;
  const permissionSaved=!!range&&!!saved&&saved.instanceId===observation.identity.instanceId&&saved.sessionId===observation.identity.sessionId&&saved.bookId===book?.id&&saved.version===book?.version&&saved.partnerId===app.state.partnerId&&saved.observation<=(observation.identity.observation??-1)&&saved.ranges.some(item=>item.start<=range.start&&item.end>=range.end);
  const maintenanceReady=!!progress&&progress.queuedChars+progress.workingChars+progress.blockedChars===0&&progress.overviewPending===0&&progress.blockedJobs===0&&progress.queuedJobs===0&&progress.workingJobs===0;
  return{
    'data-automation-schema':'yixu-workbench-observation/v1','data-archive-id':snapshot.sessionId,'data-book-id':book?.id??'','data-book-version':book?.version??'','data-partner-id':app.state.partnerId,
    'data-chapter-index':page?.chapterIndex??-1,'data-chapter-start':page?.start??-1,'data-chapter-end':page?.end??-1,'data-chapter-body-end':paragraphs.filter(item=>!item.heading).at(-1)?.end??-1,
    'data-next-chapter-start':page?.nextChapterStart??-1,
    'data-mode':snapshot.mode,'data-following':String(snapshot.following),'data-model-ready':String(snapshot.modelReady),'data-reading-active':String(!!app.session?.active),
    'data-reading-session':app.session?.id??'','data-engine-instance':observation?.identity.instanceId??'','data-observation-number':observation?.identity.observation??-1,
    'data-reader-visible':String(readerUnobstructed&&!!observation?.sourceVisible),'data-visible-range':JSON.stringify(observation?.visibleRange??null),'data-saved-observation':JSON.stringify(observation?.saved??null),
    'data-permission-saved':String(permissionSaved),'data-maintenance-ready':String(maintenanceReady),
    'data-reading-control':app.readingControl?.state??'idle','data-in-flight':app.readingControl?.inFlight??0,'data-current-unfinished':owned.length,'data-current-unknown':owned.filter(item=>item.stage==='unknown').length,
    'data-observation-entries':observation?.activeEntries??0,
    'data-maintenance-progress':JSON.stringify(progress??null),'data-page-loading':String(!!snapshot.pageLoading),'data-busy-action':String(snapshot.busyAction),'data-current-error':String(!!snapshot.error||!!snapshot.connectionError),
    'data-connection-error':String(!!snapshot.connectionError),
    'data-model-config':JSON.stringify({serviceId:service?.id??'',model:service?.model??'',effort:service?.effort??'',contextLimit:service?.contextLimit??0,maxOutput:service?.maxOutput??0,tokenLimit:app.state.settings.tokenLimit,mode:snapshot.mode}),
    'data-export-prepared':JSON.stringify(snapshot.exportPrepared??null),
  };
}
