import {receiveMessageOnPort,type MessagePort} from 'node:worker_threads';
import {ModelOutputError} from '../core/model.ts';

const synchronous=new Set(['assertCurrent','recoveryProgress','isLocalToolFailure','runtimeContext','ready','isConcurrencySafe','validate']);
type Wire={kind:string;id?:number;value?:unknown;args?:unknown;error?:unknown};
/** Only this turn's functions and explicit arguments cross the boundary. There is
 * no State transport and every domain side effect still executes at its owner. */
export class WorkerRpc{
  private sequence=0;private functions=new Map<number,Function>();private originals=new Map<number,Error>();
  private pending=new Map<number,{resolve(value:unknown):void;reject(error:unknown):void}>();
  private replies=new Map<number,Wire>();private signals=new Map<number,AbortController>();private cleanups:(()=>void)[]=[];
  private wake:Int32Array;
  constructor(private port:MessagePort,wake:SharedArrayBuffer,private blocking=false){this.wake=new Int32Array(wake);port.on('message',message=>this.handle(message));}
  private send(message:Wire){this.port.postMessage(message);Atomics.add(this.wake,0,1);Atomics.notify(this.wake,0);}
  encode(value:unknown,key=''):unknown{
    if(typeof value==='function'){const id=++this.sequence;this.functions.set(id,value);return{$rpc:'function',id,sync:synchronous.has(key)};}
    if(value instanceof AbortSignal){const id=++this.sequence,abort=()=>this.send({kind:'abort',id,value:this.encode(value.reason)});value.addEventListener('abort',abort,{once:true});this.cleanups.push(()=>value.removeEventListener('abort',abort));return{$rpc:'signal',id,aborted:value.aborted,reason:this.encode(value.reason)};}
    if(value instanceof Error){const prior=(value as Error&{$remoteError?:number}).$remoteError;if(prior!==undefined)return{$rpc:'original-error',id:prior};const id=++this.sequence;this.originals.set(id,value);return{$rpc:'error',id,name:value.name,message:value.message,stack:value.stack,properties:this.encode({...value})};}
    if(Array.isArray(value))return value.map(item=>this.encode(item));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([name,item])=>[name,this.encode(typeof item==='function'?item.bind(value):item,name)]));
    return value;
  }
  decode(value:any):any{
    if(!value||typeof value!=='object')return value;
    if(value.$rpc==='function')return(...args:unknown[])=>this.call(value.id,args,value.sync);
    if(value.$rpc==='signal'){const controller=new AbortController();this.signals.set(value.id,controller);if(value.aborted)controller.abort(this.decode(value.reason));return controller.signal;}
    if(value.$rpc==='original-error')return this.originals.get(value.id)??Error('跨线程原错误引用已释放');
    if(value.$rpc==='error'){const properties=this.decode(value.properties);const error=value.name==='ModelOutputError'?new ModelOutputError(value.message,properties.response,properties.reason,properties.outcome):Error(value.message);Object.assign(error,properties,{name:value.name,stack:value.stack});Object.defineProperty(error,'$remoteError',{value:value.id});return error;}
    if(Array.isArray(value))return value.map(item=>this.decode(item));
    return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,this.decode(item)]));
  }
  private call(id:number,args:unknown[],sync:boolean):any{
    const request=++this.sequence;
    if(this.blocking&&sync){
      this.send({kind:'call',id:request,value:id,args:this.encode(args)});
      while(!this.replies.has(request)){const observed=Atomics.load(this.wake,0);let received;while((received=receiveMessageOnPort(this.port)))this.handle(received.message);if(!this.replies.has(request))Atomics.wait(this.wake,0,observed,1000);}
      const reply=this.replies.get(request)!;this.replies.delete(request);if(reply.kind==='error')throw this.decode(reply.error);return this.decode(reply.value);
    }
    return new Promise((resolve,reject)=>{this.pending.set(request,{resolve,reject});this.send({kind:'call',id:request,value:id,args:this.encode(args)});});
  }
  private handle(message:Wire){
    if(message.kind==='abort'){this.signals.get(message.id!)?.abort(this.decode(message.value));return;}
    if(message.kind==='call'){
      void(async()=>{try{const fn=this.functions.get(message.value as number);if(!fn)throw Error('本轮函数端口已释放');const value=await fn(...this.decode(message.args));this.send({kind:'result',id:message.id,value:this.encode(value)});}catch(error){this.send({kind:'error',id:message.id,error:this.encode(error)});}})();return;
    }
    const pending=this.pending.get(message.id!);if(pending){this.pending.delete(message.id!);if(message.kind==='error')pending.reject(this.decode(message.error));else pending.resolve(this.decode(message.value));}else this.replies.set(message.id!,message);
  }
  dispose(error=Error('本轮执行端口已释放')){for(const cleanup of this.cleanups)cleanup();for(const item of this.pending.values())item.reject(error);this.pending.clear();this.functions.clear();this.originals.clear();this.signals.clear();this.port.close();}
}
