/** Private transport deltas. None of these carries publication authority. */
export type ModelStreamDelta = {type:'text'|'reasoning';text:string} | {type:'tool-call';index:number;id?:string;name?:string;argumentsDelta:string};
export type ModelStreamObserver = (delta:ModelStreamDelta)=>void;

/** OpenAI-compatible SSE, decoded incrementally from actual HTTP bytes. The raw
 * UTF-8 carrier stays separate from its derived Chat Completions object. */
export class ProviderSseDecoder {
  private readonly decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
  private raw:string[]=[];private pending='';private data:string[]=[];private done=false;private ended=false;private firstLine=true;
  private meta:Record<string,any>={};private content='';private reasoning='';private hasContent=false;private hasReasoning=false;
  private finishReason:string|null=null;private usage:unknown;private readonly calls=new Map<number,{id:string;type:string;function:{name:string;arguments:string}}>();
  constructor(private readonly observe?:ModelStreamObserver){}
  get rawBody(){return this.raw.join('');}
  push(bytes:Uint8Array){if(this.ended)throw Error('SSE载体已结束');const text=this.decoder.decode(bytes,{stream:true});this.raw.push(text);this.lines(text);}
  private lines(text:string){
    this.pending+=text;let match:RegExpExecArray|null;
    while((match=/\r\n|\r|\n/u.exec(this.pending))){
      // A CR at the byte boundary may be the first half of CRLF.
      if(match[0]==='\r'&&match.index===this.pending.length-1)return;
      let line=this.pending.slice(0,match.index);this.pending=this.pending.slice(match.index+match[0].length);
      if(this.firstLine){line=line.replace(/^\uFEFF/u,'');this.firstLine=false;}
      if(!line){this.event();continue;}if(line.startsWith(':'))continue;
      const colon=line.indexOf(':'),field=colon<0?line:line.slice(0,colon),value=colon<0?'':line.slice(colon+1).replace(/^ /u,'');
      if(field==='data')this.data.push(value);
    }
  }
  private event(){
    if(!this.data.length)return;const data=this.data.join('\n');this.data=[];
    if(this.done)throw Error('SSE终态后出现额外数据');
    if(data==='[DONE]'){this.done=true;return;}
    const value=JSON.parse(data);if(!value||typeof value!=='object'||value.error)throw Error('SSE返回错误或无效事件');
    for(const key of ['id','created','model','system_fingerprint','service_tier'])if(value[key]!==undefined)this.meta[key]=value[key];
    if(value.usage!==null&&value.usage!==undefined)this.usage=value.usage;
    if(!Array.isArray(value.choices))throw Error('SSE缺少choices');
    for(const choice of value.choices){
      if(choice.index!==0)throw Error('SSE仅接受单一首选回答');
      if(this.finishReason!==null)throw Error('SSE已完成的回答继续输出');
      const delta=choice.delta??{};if(!delta||typeof delta!=='object'||Array.isArray(delta))throw Error('SSE delta无效');
      if(delta.role!==undefined&&delta.role!=='assistant')throw Error('SSE角色无效');
      for(const [field,type]of [['content','text'],['reasoning_content','reasoning']] as const){
        const text=delta[field];if(text===null||text===undefined)continue;if(typeof text!=='string')throw Error('SSE正文片段无效');
        if(type==='text'){this.content+=text;this.hasContent=true;}else{this.reasoning+=text;this.hasReasoning=true;}
        if(text)this.observe?.({type,text});
      }
      if(delta.tool_calls!==undefined){
        if(!Array.isArray(delta.tool_calls))throw Error('SSE工具片段无效');
        for(const part of delta.tool_calls){
          if(!Number.isSafeInteger(part.index)||part.index<0||part.type!==undefined&&part.type!=='function'||part.id!==undefined&&typeof part.id!=='string'||part.function!==undefined&&(!part.function||typeof part.function!=='object'))throw Error('SSE工具标识无效');
          const call=this.calls.get(part.index)??{id:'',type:'function',function:{name:'',arguments:''}};
          if(part.id!==undefined){if(call.id&&part.id!==call.id)throw Error('SSE工具标识被替换');call.id=part.id;}
          const name=part.function?.name,args=part.function?.arguments;
          if(name!==undefined&&typeof name!=='string'||args!==undefined&&typeof args!=='string')throw Error('SSE工具参数片段无效');
          if(name!==undefined)call.function.name+=name;if(args!==undefined)call.function.arguments+=args;this.calls.set(part.index,call);
          this.observe?.({type:'tool-call',index:part.index,...(part.id!==undefined?{id:part.id}:{}),...(name!==undefined?{name}:{}),argumentsDelta:args??''});
        }
      }
      if(choice.finish_reason!==null&&choice.finish_reason!==undefined){if(typeof choice.finish_reason!=='string')throw Error('SSE完成原因无效');this.finishReason=choice.finish_reason;}
    }
  }
  get terminalState(){return{doneMarker:this.done,finishReason:this.finishReason,usagePresent:this.usage!==undefined};}
  end():Record<string,any>{
    if(this.ended)throw Error('SSE载体已结束');const tail=this.decoder.decode();this.raw.push(tail);this.lines(tail+'\n');this.ended=true;
    if(this.pending||this.data.length||!this.done||this.finishReason===null)throw Error('SSE尚未完整结束，部分原答保留为未知结果');
    const calls=[...this.calls].sort(([a],[b])=>a-b).map(([,call])=>call);
    return{...this.meta,object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:this.hasContent?this.content:null,...(this.hasReasoning?{reasoning_content:this.reasoning}:{}),...(calls.length?{tool_calls:calls}:{})},finish_reason:this.finishReason}],...(this.usage!==undefined?{usage:this.usage}:{})};
  }
}

/** Receipt replay verifies the original carrier, rather than trusting a separately
 * stored derived body. A partial SSE carrier cannot become a complete receipt. */
export function parseProviderWireBody(rawBody:string):Record<string,any>{
  const trimmed=rawBody.replace(/^\uFEFF/u,'').trimStart();
  if(trimmed.startsWith('{')||trimmed.startsWith('['))return JSON.parse(trimmed);
  const decoder=new ProviderSseDecoder();decoder.push(new TextEncoder().encode(rawBody));return decoder.end();
}

/** Local NDJSON framing keeps transport deltas separate from the final, saved
 * gateway result. The final HTTP status is inside the terminal envelope. */
export class LocalModelStreamDecoder {
  private readonly decoder=new TextDecoder('utf-8',{fatal:true});private pending='';private terminal?:{status:number;body:unknown};
  constructor(private readonly observe?:ModelStreamObserver){}
  push(bytes:Uint8Array){this.lines(this.decoder.decode(bytes,{stream:true}));}
  private lines(text:string){this.pending+=text;let index:number;while((index=this.pending.indexOf('\n'))>=0){const line=this.pending.slice(0,index);this.pending=this.pending.slice(index+1);if(!line.trim())continue;if(this.terminal)throw Error('本机流式终态后出现额外结果');const item=JSON.parse(line);if(item.type==='delta')this.observe?.(item.delta);else if(item.type==='result'&&Number.isInteger(item.status))this.terminal={status:item.status,body:item.body};else throw Error('本机流式响应格式无效');}}
  end(){this.lines(this.decoder.decode());if(this.pending.trim()||!this.terminal)throw Error('本机流式结果尚未完整返回');return{ok:this.terminal.status>=200&&this.terminal.status<300,status:this.terminal.status,value:this.terminal.body};}
}

export async function readLocalModelResponse(response:Response,observe?:ModelStreamObserver):Promise<{ok:boolean;status:number;value:unknown}>{
  if(!response.headers.get('content-type')?.includes('application/x-ndjson'))return{ok:response.ok,status:response.status,value:await response.json()};
  if(!response.body)throw Error('本机流式载体缺失');const decoder=new LocalModelStreamDecoder(observe),reader=response.body.getReader();
  try{for(;;){const part=await reader.read();if(part.done)break;decoder.push(part.value);}return decoder.end();}finally{reader.releaseLock();}
}
