import type {ReplyRating,ReplyTiming,WorkbenchEvent,WorkbenchMode,WorkbenchRating} from './contract.ts';
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
 question(chatId:string,action:WorkbenchEvent){this.data.questions[chatId]={at:action.clockMs,domain:action.clockDomain};}
 ready(chatId:string,questionId?:string){
  if(this.data.timings[chatId])return;
  const readyAt=this.clock(),action=questionId?this.data.questions[questionId]:undefined;
  this.data.timings[chatId]={chatId,questionId,readyAt,...(action?.domain===this.clockDomain?{actionStartedAt:action.at}:{})};this.data.readyDomains[chatId]=this.clockDomain;
  this.add('reply','答复已由核心放行',{chatId,detail:'页面实际可见时间尚未采集'});
 }
 visible(chatId:string,start?:number,end?:number){
  const timing=this.data.timings[chatId];if(!timing||timing.visibleAt!==undefined||this.data.readyDomains[chatId]!==this.clockDomain)return false;
  timing.visibleAt=this.clock();if(start!==undefined&&end!==undefined&&end>start)timing.visibleRange={start,end};
  const action=timing.questionId?this.data.questions[timing.questionId]:undefined;
  if(action?.domain===this.clockDomain)timing.firstVisibleMs=Math.max(0,timing.visibleAt-action.at);
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
