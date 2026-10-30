import type {ModelStreamObserver} from '../core/provider-stream.ts';

export type StreamArrival={at:number;clockMs:number};
export type ModelStreamPresentationMetrics={deltaCount:number;reasoningDeltaCount:number;textDeltaCount:number;toolDeltaCount:number;observerMs:number;uiPublishCount:number};

/** Read only the root object's reply string, once per incoming character. Other
 * values are skipped without collecting their strings or revisiting old input. */
function submitReadingReplyReader(){
 let phase:'start'|'key'|'colon'|'value'|'after'|'done'|'invalid'='start',key='',reply:string|undefined;
 let role:'key'|'reply'|'skip'|'nested'|undefined,escape=false,unicode='',unicodeLeft=0,high='',primitive=false;
 const nested:string[]=[];
 const append=(value:string)=>{
  if(role!=='key'&&role!=='reply')return;
  const add=(text:string)=>{if(role==='key')key+=text;else reply=(reply??'')+text;};
  if(high){if(value.length===1&&/[\uDC00-\uDFFF]/u.test(value)){add(high+value);high='';return;}add(high);high='';}
  if(value.length===1&&/[\uD800-\uDBFF]/u.test(value))high=value;else add(value);
 };
 const begin=(next:NonNullable<typeof role>)=>{role=next;escape=false;unicode='';unicodeLeft=0;high='';if(next==='key')key='';if(next==='reply')reply='';};
 return{
  get reply(){return phase==='invalid'?undefined:reply;},
  push(fragment:string){
   for(const char of fragment){
    if(phase==='invalid')return;
    if(role){
     if(unicodeLeft){if(!/^[\da-f]$/iu.test(char)){phase='invalid';return;}unicode+=char;if(!--unicodeLeft)append(String.fromCharCode(Number.parseInt(unicode,16)));continue;}
     if(escape){escape=false;if(char==='u'){unicode='';unicodeLeft=4;}else{const escapes:Record<string,string>={'"':'"','\\':'\\','/':'/','b':'\b','f':'\f','n':'\n','r':'\r','t':'\t'};if(!Object.hasOwn(escapes,char)){phase='invalid';return;}append(escapes[char]);}continue;}
     if(char==='\\'){escape=true;continue;}
     if(char==='"'){if(high){if(role==='key')key+=high;else if(role==='reply')reply=(reply??'')+high;high='';}const ended=role;role=undefined;if(ended==='key')phase='colon';else if(ended!=='nested')phase='after';continue;}
     if(char<' '){phase='invalid';return;}append(char);continue;
    }
    if(nested.length){
     if(char==='"')begin('nested');else if(char==='{'||char==='[')nested.push(char);else if(char==='}'||char===']'){if(nested.pop()!==(char==='}'?'{':'[')){phase='invalid';return;}if(!nested.length)phase='after';}continue;
    }
    if(primitive){if(!/[\s,}]/u.test(char))continue;primitive=false;phase='after';}
    if(/\s/u.test(char))continue;
    if(phase==='start'){if(char==='{')phase='key';else phase='invalid';}
    else if(phase==='key'){if(char==='"')begin('key');else if(char==='}')phase='done';else phase='invalid';}
    else if(phase==='colon'){if(char===':')phase='value';else phase='invalid';}
    else if(phase==='value'){
     if(char==='"')begin(key==='reply'?'reply':'skip');
     else if(char==='{'||char==='[')nested.push(char);
     else if(/[-\dntf]/u.test(char))primitive=true;else phase='invalid';
    }else if(phase==='after'){if(char===',')phase='key';else if(char==='}')phase='done';else phase='invalid';}
    else phase='invalid';
   }
  },
 };
}

/** Keep HTTP observers small; only the scheduled presentation touches the UI. */
export function createModelStreamPresentation(options:{
 forward?:ModelStreamObserver;signal:AbortSignal;current:()=>boolean;showText:boolean;
 firstResponse:(arrival:StreamArrival)=>void;firstProse:(arrival:StreamArrival)=>void;
 present:(text:string)=>void;interrupt:()=>boolean;publish:()=>void;
}){
 const metrics:ModelStreamPresentationMetrics={deltaCount:0,reasoningDeltaCount:0,textDeltaCount:0,toolDeltaCount:0,observerMs:0,uiPublishCount:0};
 let timer:ReturnType<typeof setTimeout>|undefined,closed=false,tool=false,publicTool:number|undefined,text='',textKind:'pending'|'prose'|'structured'='pending',pendingText=false,needsPaint=false,lastPaint=0;
 const calls=new Map<number,{name:string;reader:ReturnType<typeof submitReadingReplyReader>}>();
 let firstResponse:StreamArrival|undefined,firstProse:StreamArrival|undefined,responseRecorded=false,proseRecorded=false;
 const cancelTimer=()=>{if(timer!==undefined){clearTimeout(timer);timer=undefined;}};
 const publish=()=>{if(!options.current())return;metrics.uiPublishCount++;lastPaint=performance.now();options.publish();};
 const flush=()=>{
  cancelTimer();if(!options.current())return;
  if(firstResponse&&!responseRecorded){responseRecorded=true;options.firstResponse(firstResponse);}
  if(!options.signal.aborted&&pendingText&&textKind==='prose'){
   if(firstProse&&!proseRecorded){proseRecorded=true;options.firstProse(firstProse);}
   options.present(text);needsPaint=true;
  }
  pendingText=false;if(needsPaint){needsPaint=false;publish();}
 };
 const schedule=()=>{if(!closed&&!options.signal.aborted&&timer===undefined)timer=setTimeout(flush,Math.max(0,100-(performance.now()-lastPaint)));};
 const abort=()=>{cancelTimer();pendingText=false;text='';if(options.current()&&options.interrupt())needsPaint=true;};
 options.signal.addEventListener('abort',abort,{once:true});
 if(options.signal.aborted)abort();
 const observe:ModelStreamObserver=delta=>{
  const started=performance.now(),receivedAt=firstResponse?undefined:Date.now();metrics.deltaCount++;
  if(delta.type==='reasoning')metrics.reasoningDeltaCount++;else if(delta.type==='text')metrics.textDeltaCount++;else metrics.toolDeltaCount++;
  try{
   // Every original delta reaches DSH, including after a presentation scope ends.
   options.forward?.(delta);
   if(!options.current()||closed||options.signal.aborted)return;
   if(!firstResponse){firstResponse={at:receivedAt!,clockMs:started};schedule();}
   if(delta.type==='tool-call'){
    if(!tool){flush();tool=true;}
    // Only this explicit reply field is a public draft. Domain acceptance still
    // owns the final answer; internal tool arguments never enter presentation.
    if(options.showText){
     let call=calls.get(delta.index);if(!call)calls.set(delta.index,call={name:'',reader:submitReadingReplyReader()});
     call.name+=delta.name??'';call.reader.push(delta.argumentsDelta);
     if(call.name==='submit_reading'&&(publicTool===undefined||publicTool===delta.index)&&call.reader.reply){
      publicTool=delta.index;const next=call.reader.reply;
      if(next!==text){text=next;textKind='prose';if(!firstProse)firstProse={at:Date.now(),clockMs:started};pendingText=true;schedule();}
     }
    }
    return;
   }
   if(delta.type!=='text'||tool||!options.showText)return;
   text+=delta.text;
   if(textKind==='pending'){
    const significant=delta.text.trimStart();
    if(significant){textKind=/^[\[{<`]/u.test(significant)?'structured':'prose';if(textKind==='prose')firstProse={at:Date.now(),clockMs:started};}
   }
   if(textKind==='prose'){pendingText=true;schedule();}
  }finally{metrics.observerMs+=performance.now()-started;}
 };
 return{observe,metrics,finish(){
  if(closed)return metrics;
  closed=true;options.signal.removeEventListener('abort',abort);
  try{flush();}finally{cancelTimer();text='';}
  return metrics;
 }};
}
