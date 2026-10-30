import {Worker,MessageChannel} from 'node:worker_threads';
import type {AgentRunRequest,AgentRunner} from '../core/agent-port.ts';
import {WorkerRpc} from './worker-rpc.ts';

class ExecutionUnit{
  private worker:Worker;private sequence=0;private closing=false;private failure?:Error;private closed?:Promise<void>;
  private pending=new Map<number,{rpc:WorkerRpc;resolve(value:unknown):void;reject(error:unknown):void}>();
  private ready:Promise<void>;private closeResolve?:()=>void;private closeReject?:(error:Error)=>void;
  constructor(nativeRoot:string){
    this.worker=new Worker(new URL('./execution-worker.ts',import.meta.url),{workerData:{nativeRoot},execArgv:['--experimental-transform-types']});
    this.ready=new Promise((resolve,reject)=>{this.worker.on('message',message=>{if(message.kind==='ready'){resolve();return;}if(message.kind==='closed'){this.closeResolve?.();return;}if(message.kind==='close-error'){this.closeReject?.(Error(message.message));return;}if(message.kind==='retire-error'){fail(Error(message.message));return;}const pending=this.pending.get(message.id);if(!pending)return;this.pending.delete(message.id);if(message.error)pending.reject(pending.rpc.decode(message.error));else pending.resolve(pending.rpc.decode(message.value));pending.rpc.dispose();});const fail=(error:Error)=>{this.failure=error;reject(error);this.closeReject?.(error);for(const pending of this.pending.values()){pending.reject(error);pending.rpc.dispose(error);}this.pending.clear();};this.worker.on('error',fail);this.worker.on('exit',code=>{if(!this.closing||code!==0)fail(Error('DSH执行线程已退出（'+code+'），原任务与费用保留'));});});
  }
  async execute(kind:string,input:unknown){await this.ready;if(this.failure)throw this.failure;if(this.closing)throw Error('DSH执行线程正在关闭');const channel=new MessageChannel(),wake=new SharedArrayBuffer(4),rpc=new WorkerRpc(channel.port1,wake),id=++this.sequence;return new Promise<unknown>((resolve,reject)=>{this.pending.set(id,{rpc,resolve,reject});try{this.worker.postMessage({kind,id,port:channel.port2,wake,...(kind==='run'?{input:rpc.encode(input)}:rpc.encode(input) as object)},[channel.port2]);}catch(error){this.pending.delete(id);rpc.dispose();channel.port2.close();reject(error);}});}
  /** Queue retirement without a round trip: this worker may be synchronously
   * waiting for the very domain callback that is requesting its retirement. */
  async retire(sessionId:string){await this.ready;if(this.failure)throw this.failure;if(this.closing)return;this.worker.postMessage({kind:'retire',sessionId});}
  async close(){await this.ready;if(this.failure)throw this.failure;this.closing=true;return this.closed??=new Promise<void>((resolve,reject)=>{this.closeResolve=resolve;this.closeReject=reject;this.worker.postMessage({kind:'close'});});}
}
/** Per-archive front/back execution lanes. Only a requested turn is marshalled;
 * callbacks, tools, receipts and persistence remain attached to that exact turn. */
export class WorkerHarnessRuntime implements AgentRunner{
  private units=new Map<string,ExecutionUnit>();private running=new Map<string,string>();private taskLanes=new Map<string,string>();private retiredSessions=new Set<string>();private closing=false;
  constructor(private nativeRoot:string){}
  private unit(lane:string){let unit=this.units.get(lane);if(!unit){unit=new ExecutionUnit(this.nativeRoot);this.units.set(lane,unit);}return unit;}
  async run<T>(input:AgentRunRequest<T>):Promise<T>{
    if(this.closing)throw Error('DSH执行宿主正在关闭');input.assertCurrent();input.signal.throwIfAborted();
    const nativeId=input.session?.nativeId??input.session?.id,lane=input.task?.role==='maintenance'?'maintenance':'conversation';
    if(nativeId&&this.retiredSessions.has(nativeId))throw Error('原生上下文已退役，须沿当前合法上下文接续');
    if(nativeId&&this.running.has(nativeId))throw Error('同一原生会话已有任务，独立回应须使用独立上下文');
    if(nativeId)this.running.set(nativeId,lane);
    if(input.session?.id)this.taskLanes.set(input.session.id,lane);
    try{return await this.unit(lane).execute('run',input) as T;}finally{if(nativeId)this.running.delete(nativeId);if(input.session?.id)this.taskLanes.delete(input.session.id);}
  }
  async compact(sessionId:string,signal:AbortSignal){const lane=this.taskLanes.get(sessionId);if(!lane)throw Error('该伴读任务当前没有活动的原生压缩实例');return this.unit(lane).execute('compact',{sessionId,signal});}
  async retireSession(sessionId:string){this.retiredSessions.add(sessionId);await Promise.all([...this.units.values()].map(unit=>unit.retire(sessionId)));}
  async dispose(){this.closing=true;await Promise.all([...this.units.values()].map(unit=>unit.close()));}
}
