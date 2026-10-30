import {Worker} from 'node:worker_threads';
import type {StateChangeSet,StoredStateChangeSet} from '../core/types.ts';
import type {ContentObject,PreparedContent} from './content-objects.ts';

export type PreparedStorage={changes:StoredStateChangeSet;encoded:[string,string][];objects:ContentObject[];bodies:{bucket:'memoryBodies'|'taskMaterials';key:string;hash:string}[];immutable:{identity:string;hash:string}[]};
/** Per-store CPU worker. It only sees changed records and immutable bodies; all
 * authoritative reads, ordering and SQL publication stay with NodeStore. */
export class StoragePreparation{
  private worker?:Worker;
  private next=0;
  private pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
  constructor(private receiptDirectory?:string){}
  private request<T>(payload:object):Promise<T>{
    if(!this.worker){
      const worker=this.worker=new Worker(new URL('./storage-preparation-worker.ts',import.meta.url),{workerData:{receiptDirectory:this.receiptDirectory}});
      worker.on('message',({id,result,error})=>{const pending=this.pending.get(id);if(!pending)return;this.pending.delete(id);if(error)pending.reject(Error(error));else pending.resolve(result);if(!this.pending.size)worker.unref();});
      const fail=(error:Error)=>{if(this.worker===worker)this.worker=undefined;for(const pending of this.pending.values())pending.reject(error);this.pending.clear();};
      worker.on('error',fail);worker.on('exit',code=>{if(this.worker===worker)fail(Error('存储准备进程已退出：'+code));});worker.unref();
    }
    const id=++this.next,worker=this.worker;worker.ref();
    return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});try{worker.postMessage({id,...payload});}catch(error){this.pending.delete(id);if(!this.pending.size)worker.unref();reject(error);}});
  }
  changes(input:StateChangeSet){return this.request<PreparedStorage>({input});}
  values(values:unknown[]){return this.request<PreparedContent[]>({values});}
  async close(){const worker=this.worker;this.worker=undefined;if(worker)await worker.terminate();}
}
