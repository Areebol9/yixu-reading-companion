import {createHash, randomUUID} from 'node:crypto';
import type {Context} from '@deepseek-ai/cordis';
import {BookProjectRegistry} from './project-registry.ts';
import {ownArchive} from './owner.ts';
import {summarizeHostSnapshot} from './status-projection.ts';
import type {ArchiveRuntime, CommandReceipt, CommandStatus, HostDomainFactory, HostFrame, HostRequest, HostLifecycle} from './contract.ts';

type Operation={hash:string;state:CommandStatus['state'];acceptedAt:number;completedAt?:number;task?:Promise<CommandReceipt>;receipt?:CommandReceipt};
const receiptLifetimeMs=10*60*1000,receiptLimit=256;

export class ArchiveHost {
  readonly epoch = randomUUID();
  private sequence = 0;
  private events: HostFrame['events'] = [];
  private listeners = new Set<(frame: HostFrame) => void>();
  private operations = new Map<string, Operation>();
  private transfers=new Set<Promise<unknown>>();
  private runtime!: ArchiveRuntime;
  private unsubscribe?: () => void;
  private release?: () => Promise<void>;
  private closing = false;
  private draining?: Promise<void>;
  private stopStage=0;
  private lifecyclePhase:HostLifecycle['phase']='ready';
  private lifecycleError?:string;
  private lifecycleUsage?:{values:readonly {status?:string}[];unknownRequests:number};
  private pausing?:Promise<void>;
  private cancellation = new AbortController();
  private archiveChanged?: (id:string)=>void;
  private constructor(readonly archiveId: string, private directory: string) {}
  static async open(ctx: Context, factory: HostDomainFactory, archiveId: string, directory: string,progress?:(stage:string)=>Promise<void>) {
    const host = new ArchiveHost(archiveId, directory);
    await progress?.('opening-native-owner');
    host.release = await ownArchive(ctx, archiveId, directory);
    try {
      await progress?.('opening-domain');
      host.runtime = await factory.openArchive({archiveId, archiveDirectory: directory, dshContext: ctx, projectRegistry: new BookProjectRegistry(ctx, archiveId, directory), signal: host.cancellation.signal});
      await progress?.('domain-ready');
      host.unsubscribe = host.runtime.client.subscribe(() => host.publish());
      host.publish(); return host;
    } catch (error) { await host.release(); throw error; }
  }
  frame(): HostFrame { return {epoch: this.epoch, sequence: this.sequence, snapshot: this.runtime.client.getSnapshot?.() ?? this.runtime.client.snapshot, events: this.events}; }
  statusFrame(){return{epoch:this.epoch,sequence:this.sequence,status:summarizeHostSnapshot(this.runtime.client.getSnapshot?.()??this.runtime.client.snapshot)}}
  lifecycle():HostLifecycle {
    const snapshot=(this.runtime.client.getSnapshot?.()??this.runtime.client.snapshot) as {sessionId?:string;following?:boolean;app?:{busy?:boolean;readingControl?:{state?:string;inFlight?:number};state?:{usage?:{status?:string}[]}}};
    const usage=snapshot.app?.state?.usage;
    if(usage&&this.lifecycleUsage?.values!==usage)this.lifecycleUsage={values:usage,unknownRequests:usage.reduce((count,item)=>count+Number(item.status==='unknown'),0)};
    return {archiveId:snapshot.sessionId??this.archiveId,epoch:this.epoch,phase:this.lifecyclePhase??'ready',busy:!!snapshot.app?.busy,activeCommands:[...this.operations.values()].filter(op=>op.state==='accepted'||op.state==='running').length,transfers:this.transfers.size,inFlight:snapshot.app?.readingControl?.inFlight??0,unknownRequests:usage?this.lifecycleUsage!.unknownRequests:0,following:!!snapshot.following,readingState:snapshot.app?.readingControl?.state,...(this.lifecycleError?{error:this.lifecycleError}:{})};
  }
  pause():Promise<void> {
    if(this.closing)return Promise.reject(Error('正在保存阅读记录，请稍候。'));
    if(!this.runtime.pause)return Promise.reject(Error('此宿主尚未提供暂停接口'));
    return this.pausing??=(async()=>{try{await this.runtime.pause!();await this.runtime.flush();this.publish();}finally{this.pausing=undefined;}})();
  }
  partnerAvatar(id:string){return this.runtime.partnerAvatar?.(id);}
  download(id:string){return this.runtime.download?.(id);}
  exportStatus(id:string){return this.runtime.exportStatus?.(id);}
  async importFile(input:Parameters<NonNullable<ArchiveRuntime['importFile']>>[0]){if(this.closing)throw Error('宿主正在正常收尾');if(!this.runtime.importFile)throw Error('宿主文件导入尚未接通');const task=this.runtime.importFile(input);this.transfers.add(task);try{const result=await task;this.publish();return result;}finally{this.transfers.delete(task);}}
  observeArchive(listener:(id:string)=>void){this.archiveChanged=listener;const snapshot=this.frame().snapshot as {sessionId?:string};if(snapshot.sessionId)listener(snapshot.sessionId);return()=>{this.archiveChanged=undefined;};}
  async subscribe(listener: (frame: HostFrame) => void) {
    if(!this.listeners.size&&!this.closing)await this.runtime.reconnectClient();
    this.listeners.add(listener); listener(this.frame());
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size && !this.closing) void this.runtime.detachReadingSource().catch(error => console.error('页面离开后的正常暂停未完成：', error));
    };
  }
  private publish() {
    for (const value of this.runtime.client.takeUIEvents?.() ?? []) this.events.push({sequence: ++this.sequence, value});
    this.events = this.events.slice(-128); this.sequence++;
    const frame = this.frame();
    const id=(frame.snapshot as {sessionId?:string})?.sessionId;if(id)this.archiveChanged?.(id);
    for (const listener of this.listeners) { try { listener(frame); } catch { this.listeners.delete(listener); } }
  }
  private checkOperationIdentity(id:string,epoch:string){
    if(epoch!==this.epoch)throw Error('宿主已更换，原操作不能在新宿主执行，请核对原记录');
    if(typeof id!=='string'||!/^[a-z0-9-]{8,100}$/i.test(id))throw Error('应用操作身份无效，请重新连接');
  }
  private pruneReceipts(){
    const completed=[...this.operations.values()].filter(op=>op.state==='complete').sort((a,b)=>a.completedAt!-b.completedAt!),cutoff=Date.now()-receiptLifetimeMs;
    for(let i=0;i<completed.length;i++)if(completed[i].completedAt!<=cutoff||i<completed.length-receiptLimit){
      // Keep only the ID/hash tombstone for this host epoch. Expiry must never
      // turn the same command into a fresh execution or retain large results.
      const op=completed[i];op.state='expired';delete op.task;delete op.receipt;
    }
  }
  private operationStatus(id:string,op:Operation):CommandStatus{return{id,epoch:this.epoch,state:op.state,acceptedAt:op.acceptedAt,...(op.completedAt!==undefined?{completedAt:op.completedAt}:{}),...(op.receipt?{receipt:op.receipt}:{})};}
  commandStatus(id:string,epoch:string):CommandStatus|undefined{
    this.checkOperationIdentity(id,epoch);this.pruneReceipts();const op=this.operations.get(id);return op?this.operationStatus(id,op):undefined;
  }
  acceptCommand(request:HostRequest):CommandStatus{const op=this.startCommand(request);return this.operationStatus(request.id,op);}
  private startCommand(request:HostRequest):Operation{
    if (!request || typeof request.name !== 'string' || !Array.isArray(request.args)) throw Error('应用操作身份无效，请重新连接');
    this.checkOperationIdentity(request.id,request.epoch);this.pruneReceipts();
    const hash = createHash('sha256').update(JSON.stringify([request.name, request.args])).digest('hex');
    const active = this.operations.get(request.id);
    if(active){if(active.hash!==hash)throw Error('同一操作标识不能更换内容');if(active.state==='expired')throw Error('原操作回执已过期，原操作不会再次执行，请核对应用保存的结果');return active;}
    if(this.closing)throw Error('正在保存阅读记录，请稍后再操作。');
    const op:Operation={hash,state:'accepted',acceptedAt:Date.now()};
    this.operations.set(request.id,op);
    op.task=Promise.resolve().then(()=>{op.state='running';return this.execute(request);}).catch(error=>({id:request.id,error:error instanceof Error?error.message:String(error)})).then(receipt=>{op.state='complete';op.completedAt=Date.now();op.receipt=receipt;this.pruneReceipts();return receipt;});
    void op.task.catch(()=>{});return op;
  }
  async command(request: HostRequest): Promise<CommandReceipt> {
    return this.startCommand(request).task!;
  }
  private async execute(request: HostRequest): Promise<CommandReceipt> {
    let receipt: CommandReceipt;
    try { receipt = {id: request.id, value: await this.runtime.client.command(request.name, ...request.args)}; }
    catch (error) { receipt = {id: request.id, error: error instanceof Error ? error.message : String(error)}; }
    this.publish(); return {...receipt,sequence:this.sequence};
  }
  stop(reason: string): Promise<void> {
    return this.draining ??= (async () => {
      this.closing = true;
      this.lifecyclePhase='stopping';this.lifecycleError=undefined;this.publish();
      await this.pausing;
      if((this.stopStage??0)<1){await this.runtime.stop({reason});this.stopStage=1;}
      if(this.stopStage<2){await Promise.allSettled([...this.operations.values()].filter(op=>op.state==='accepted'||op.state==='running').map(op=>op.task!));await Promise.allSettled([...this.transfers]);this.stopStage=2;}
      if(this.stopStage<3){await this.runtime.flush();this.stopStage=3;}
      if(this.stopStage<4){await this.runtime.dispose();this.stopStage=4;}
      if(this.stopStage<5){this.unsubscribe?.();this.listeners.clear();this.cancellation.abort();await this.release?.();this.stopStage=5;}
      this.lifecyclePhase='closed';
    })().catch(error=>{this.draining=undefined;this.lifecyclePhase='failed';this.lifecycleError=error instanceof Error?error.message:String(error);this.publish();throw error;});
  }
}
