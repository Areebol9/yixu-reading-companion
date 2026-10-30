import {mkdir,writeFile,readFile,stat,rename,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {NodeStore} from './node-store.ts';
import {JsonFileWriter} from './json-stream.ts';
import {writePortableBackup} from './content-object-backup.ts';
import type {WorkbenchExportFile} from '../workbench/contract.ts';

export type PreparedDownload={id:string;name:string;filename:string;sha256:string;bytes:number};
export type ExportProgress={schema:'yixu-export-progress-v1';id:string;archiveId:string;kind:'record'|'backup';name:string;stage:'snapshot'|'writing'|'ready'|'failed';startedAt:number;bytes?:number;sha256?:string;completedAt?:number;failedStage?:string;error?:string;failedAt?:number};
export function exportIdentifier(value:string){if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))throw Error('导出标识必须是UUID');return value.toLowerCase();}
type ExportInput={archiveId:string;kind:'record'|'backup';name:string;exportId?:string;metadata?:Record<string,unknown>;onProgress?:(stage:string)=>void};
export class ArchiveDownloads {
  private preparing=new Map<string,{identity:string;task:Promise<WorkbenchExportFile>}>();
  constructor(private directory:string,private allowsArchive:(id:string)=>boolean=()=>true){}
  private location(id:string){return join(resolve(this.directory),exportIdentifier(id));}
  async status(id:string):Promise<ExportProgress|undefined>{
    id=exportIdentifier(id);let value:ExportProgress;
    try{value=JSON.parse(await readFile(join(this.location(id),'progress.json'),'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
    if(value.schema!=='yixu-export-progress-v1'||value.id!==id||!this.allowsArchive(value.archiveId)||!['backup','record'].includes(value.kind)||!['snapshot','writing','ready','failed'].includes(value.stage)||typeof value.name!=='string'||!Number.isFinite(value.startedAt))throw Error('原导出进度身份不符');
    // Return only the public manifest, never local filenames or connection credentials.
    const {schema,archiveId,kind,name,stage,startedAt,bytes,sha256,completedAt,failedStage,error,failedAt}=value;
    return{schema,id,archiveId,kind,name,stage,startedAt,...(bytes!==undefined?{bytes}:{}),...(sha256!==undefined?{sha256}:{}),...(completedAt!==undefined?{completedAt}:{}),...(failedStage!==undefined?{failedStage}:{}),...(error!==undefined?{error}:{}),...(failedAt!==undefined?{failedAt}:{})};
  }
  async get(id:string):Promise<PreparedDownload|undefined>{
    const value=await this.status(id);if(!value||value.stage!=='ready')return;
    if(!Number.isSafeInteger(value.bytes)||value.bytes!<0||!/^[a-f0-9]{64}$/.test(value.sha256??''))throw Error('原导出文件证明无效');
    const filename=join(this.location(value.id),'download.json'),info=await stat(filename);
    if(!info.isFile()||info.size!==value.bytes)throw Error('原导出文件长度与已就绪记录不符');
    return{id:value.id,name:value.name,filename,bytes:value.bytes!,sha256:value.sha256!};
  }
  prepare(store:NodeStore,input:ExportInput):Promise<WorkbenchExportFile>{
    const id=exportIdentifier(input.exportId??randomUUID()),identity=JSON.stringify([input.archiveId,input.kind,input.name]);
    const active=this.preparing.get(id);if(active){if(active.identity!==identity)return Promise.reject(Error('同一导出标识不能更换存档或类型'));return active.task;}
    const task=this.prepareOnce(store,input,id).finally(()=>this.preparing.delete(id));this.preparing.set(id,{identity,task});return task;
  }
  private async prepareOnce(store:NodeStore,input:ExportInput,id:string):Promise<WorkbenchExportFile>{
    if(!this.allowsArchive(input.archiveId))throw Error('导出所属存档未获本宿主授权');
    const directory=this.location(id),snapshot=join(directory,'snapshot.sqlite'),pending=join(directory,'backup.pending'),filename=join(directory,'download.json');
    await mkdir(resolve(this.directory),{recursive:true});
    try{await mkdir(directory);}catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      const original=await this.status(id);
      if(!original)throw Error('原导出目录已存在但进度未确认，请保留原事实');
      if(original.archiveId!==input.archiveId||original.kind!==input.kind||original.name!==input.name)throw Error('同一导出标识不能更换存档或类型');
      input.onProgress?.(original.stage);const ready=await this.get(id);
      if(ready)return this.file(ready);
      throw Error('原导出保持'+original.stage+'阶段'+(original.error?'：'+original.error:'，请查询原进度；不会重新生成'));
    }
    const manifest:ExportProgress={schema:'yixu-export-progress-v1',id,archiveId:input.archiveId,kind:input.kind,name:input.name,stage:'snapshot',startedAt:Date.now()};
    const progress=async(stage:ExportProgress['stage'],extra:Record<string,unknown>={})=>{Object.assign(manifest,{stage,...extra});const file=join(directory,'progress.json');await writeFile(file+'.pending',JSON.stringify(manifest),{mode:0o600});await rename(file+'.pending',file);input.onProgress?.(stage);};
    let frozen:NodeStore|undefined,writer:JsonFileWriter|undefined;
    try{
      await progress('snapshot');await store.createExportSnapshot(snapshot);frozen=new NodeStore(snapshot,store.receiptDirectory);
      frozen.readNativeAgentSessionStream=store.readNativeAgentSessionStream;
      frozen.readNativeAgentSpills=store.readNativeAgentSpills;
      frozen.readNativeAgentOriginal=store.readNativeAgentOriginal;
      writer=new JsonFileWriter(pending);await progress('writing');
      if(input.kind==='backup')await this.backup(writer,frozen);
      else await this.record(writer,frozen,input.metadata??{});
      const proof=await writer.finish();await frozen.close();frozen=undefined;
      await rename(pending,filename);await progress('ready',{...proof,completedAt:Date.now()});
      return this.file({id,name:input.name,filename,...proof});
    }catch(error){const failedStage=String(manifest.stage);writer?.abort(error instanceof Error?error:Error(String(error)));await frozen?.close().catch(()=>{});await progress('failed',{failedStage,error:String(error),failedAt:Date.now()});throw Error('导出在'+failedStage+'阶段未完成：'+String(error),{cause:error});}
    finally{await rm(snapshot,{force:true});await rm(snapshot+'-wal',{force:true});await rm(snapshot+'-shm',{force:true});}
  }
  private file({id,name,bytes,sha256}:PreparedDownload):WorkbenchExportFile{return{name,download:{id,path:'/downloads/'+id,bytes,sha256}};}
  private async backup(writer:JsonFileWriter,store:NodeStore){await writePortableBackup(writer,store);}
  private async record(writer:JsonFileWriter,store:NodeStore,metadata:Record<string,unknown>){
    const header=await store.prepareObservationExport();
    await writer.object({...metadata,schema:'yixu-workbench-run/v1',exportedAt:new Date().toISOString(),importedHistory:header.importedHistory},{
      events:()=>writer.array(store.exportObservationEntries('events'),entry=>writer.value(entry.value)),
      timings:()=>this.observationMap(writer,store,'timings'),ratings:()=>this.observationMap(writer,store,'ratings'),questionActions:()=>this.observationMap(writer,store,'questions'),replyClockDomains:()=>this.observationMap(writer,store,'readyDomains'),drafts:()=>this.observationMap(writer,store,'drafts'),
      chats:()=>writer.array(store.exportEntities('chats'),async({readingReaction,...chat})=>writer.value({...chat,...(readingReaction?{readingReaction:{requestKey:readingReaction.requestKey,status:readingReaction.status}}:{})})),
      books:()=>writer.array(store.exportEntities('books'),async({text,...book})=>writer.value(book)),
      usage:()=>writer.array(store.exportEntities('usage'),async({maintenanceDispatch,agentResponse,...usage})=>writer.value(usage)),
    });
  }
  private async observationMap(writer:JsonFileWriter,store:NodeStore,kind:'ratings'|'timings'|'questions'|'readyDomains'|'drafts'){
    await writer.raw('{');let first=true;for(const entry of store.exportObservationEntries(kind)){if(!first)await writer.raw(',');first=false;await writer.raw(JSON.stringify(entry.key)+':');await writer.value(entry.value);}await writer.raw('}');
  }
}
