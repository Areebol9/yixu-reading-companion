import {parentPort,workerData,type MessagePort} from 'node:worker_threads';
import {WorkerRpc} from './worker-rpc.ts';
import {HarnessRuntime} from './runtime.ts';
import {createWorkerContext} from './worker-context.ts';
import type {AgentRunRequest} from '../core/agent-port.ts';

const context=await createWorkerContext(workerData.nativeRoot);
const runtime=new HarnessRuntime({context:context.ctx});
const active=new Set<Promise<unknown>>();
parentPort!.on('message',message=>{
  if(message.kind==='run'){
    const rpc=new WorkerRpc(message.port as MessagePort,message.wake,true),input=rpc.decode(message.input) as AgentRunRequest<unknown>;
    const running=runtime.run(input).then(value=>parentPort!.postMessage({id:message.id,value:rpc.encode(value)}),error=>parentPort!.postMessage({id:message.id,error:rpc.encode(error)})).finally(()=>{rpc.dispose();active.delete(running);});active.add(running);
  }else if(message.kind==='compact'){
    const rpc=new WorkerRpc(message.port as MessagePort,message.wake,true);
    void runtime.compact(message.sessionId,rpc.decode(message.signal)).then(value=>parentPort!.postMessage({id:message.id,value:rpc.encode(value)}),error=>parentPort!.postMessage({id:message.id,error:rpc.encode(error)})).finally(()=>rpc.dispose());
  }else if(message.kind==='retire'){
    const retiring=runtime.retireSession(message.sessionId).catch(error=>parentPort!.postMessage({kind:'retire-error',message:error instanceof Error?error.message:String(error)})).finally(()=>active.delete(retiring));active.add(retiring);
  }else if(message.kind==='close')void(async()=>{await Promise.allSettled([...active]);await runtime.dispose();await context.dispose();parentPort!.postMessage({kind:'closed'});parentPort!.close();})().catch(error=>parentPort!.postMessage({kind:'close-error',message:error instanceof Error?error.message:String(error)}));
});
parentPort!.postMessage({kind:'ready'});
