import {Worker} from 'node:worker_threads';
import {ReadingDocumentError} from '../core/document-revision.ts';
import {MissingWorldIdentityBindingsError} from '../core/world-identity.ts';
import {ComputationScopeError} from '../core/computation-port.ts';
import {MemoryIdentityError} from '../core/memory-identity.ts';
import type {DomainComputationPort,DomainComputationOptions,MemoryComputationInput,DocumentSubjectsComputationInput} from '../core/computation-port.ts';
import type {MemoryPlan} from '../core/memory-plan.ts';

type RemoteError={kind:string;name:string;message:string;stack?:string;errors?:string[];requiredMemoryIds?:string[];requiredViewIds?:string[];requiredChatIds?:string[];issues?:ReadingDocumentError['issues'];requiredMemoryRanges?:ReadingDocumentError['requiredMemoryRanges'];bindings?:MissingWorldIdentityBindingsError['bindings']};
function decodeError(value:RemoteError):Error{
  let error:Error;
  if(value.kind==='memory-identity')error=new MemoryIdentityError(value.message);
  else if(value.kind==='reading-document')error=new ReadingDocumentError(value.errors??[value.message],value.requiredMemoryIds,value.requiredViewIds,value.issues,value.requiredMemoryRanges);
  else if(value.kind==='world-bindings')error=new MissingWorldIdentityBindingsError(value.bindings??[]);
  else if(value.kind==='scope')error=new ComputationScopeError(value.message,value.requiredMemoryIds,value.requiredChatIds);
  else{const Constructor={TypeError,RangeError,SyntaxError,ReferenceError,URIError,EvalError}[value.name as 'TypeError'];error=Constructor?new Constructor(value.message):Error(value.message);error.name=value.name;}
  if(value.stack)error.stack=value.stack;return error;
}
type Pending={resolve:(value:any)=>void;reject:(error:Error)=>void;detach:()=>void};
type Unit={worker:Worker;pending:Map<number,Pending>};
/** Independent foreground/background pure CPU lanes. Each request contains its
 * own bounded scope; workers never own a database, business task or live State. */
export class DomainComputation implements DomainComputationPort{
  private next=0;
  private units=new Map<'foreground'|'background',Unit>();
  private closed=false;
  private unit(lane:'foreground'|'background'):Unit{
    const existing=this.units.get(lane);if(existing)return existing;
    const worker=new Worker(new URL('./domain-computation-worker.ts',import.meta.url)),unit:Unit={worker,pending:new Map()};
    const fail=(error:Error)=>{if(this.units.get(lane)!==unit)return;this.units.delete(lane);for(const pending of unit.pending.values()){pending.detach();pending.reject(error);}unit.pending.clear();};
    worker.on('message',({id,result,error})=>{const pending=unit.pending.get(id);if(!pending)return;unit.pending.delete(id);pending.detach();if(error)pending.reject(decodeError(error));else pending.resolve(result);if(!unit.pending.size)worker.unref();});
    worker.on('error',fail);worker.on('exit',code=>fail(Error('领域纯计算进程已退出：'+code)));worker.unref();this.units.set(lane,unit);return unit;
  }
  private request<T>(method:'memories'|'subjects',input:MemoryComputationInput|DocumentSubjectsComputationInput,options:DomainComputationOptions={}):Promise<T>{
    if(this.closed)return Promise.reject(Error('领域纯计算端口已关闭'));
    if(options.signal?.aborted)return Promise.reject(new DOMException('本次纯计算已取消','AbortError'));
    if(method==='memories'){
      const scope=(input as MemoryComputationInput).scope,allowed=new Set(['book','partnerId','partners','memories','chats','forgotten','habits','readings','entityRoots','publishedViews','formationSources']);
      const unexpected=Object.keys(scope).filter(key=>!allowed.has(key));
      if(unexpected.length)return Promise.reject(new ComputationScopeError('纯计算端口拒绝额外存档字段：'+unexpected.join('、')));
      if(scope.book.text)return Promise.reject(new ComputationScopeError('纯计算端口拒绝整书text；请传本任务residentRanges租约'));
      if(scope.chats.some(chat=>'text'in chat||'readingReaction'in chat))return Promise.reject(new ComputationScopeError('纯计算聊天来源须先经computationChat投影'));
    }else if(Object.keys(input).some(key=>key!=='memories'&&key!=='plan'))return Promise.reject(new ComputationScopeError('维护对象校验只接收本范围memories与候选plan，不能传入完整存档'));
    const unit=this.unit(options.lane??'background'),id=++this.next;unit.worker.ref();
    return new Promise((resolve,reject)=>{
      const detach=()=>options.signal?.removeEventListener('abort',abort),abort=()=>{const pending=unit.pending.get(id);if(!pending)return;unit.pending.delete(id);detach();reject(new DOMException('本次纯计算已取消','AbortError'));if(!unit.pending.size)unit.worker.unref();};
      unit.pending.set(id,{resolve,reject,detach});options.signal?.addEventListener('abort',abort,{once:true});
      try{unit.worker.postMessage({id,method,input});}catch(error){unit.pending.delete(id);detach();if(!unit.pending.size)unit.worker.unref();reject(error);}
    });
  }
  planMemories(input:MemoryComputationInput,options?:DomainComputationOptions){return this.request<MemoryPlan>('memories',input,options);}
  validateDocumentSubjects(input:DocumentSubjectsComputationInput,options?:DomainComputationOptions){return this.request<void>('subjects',input,options);}
  async dispose(){if(this.closed)return;this.closed=true;const units=[...this.units.values()];this.units.clear();for(const unit of units){for(const pending of unit.pending.values()){pending.detach();pending.reject(new DOMException('领域纯计算端口已释放','AbortError'));}unit.pending.clear();}await Promise.all(units.map(unit=>unit.worker.terminate()));}
}
