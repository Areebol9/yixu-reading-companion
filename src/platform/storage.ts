import {stateCollections,stateRecordKey} from '../core/types.ts';
import type {BookRangeResult,MemoryBody,MemoryBodyRef,Range,State,StateChangeSet,Store,StoredStateChangeSet,TaskMaterialBody,TaskMaterialRef} from '../core/types.ts';
import {BoundedMemoryBodyCache,prepareMemoryBodySnapshot,releasePersistedMemoryBodies} from '../core/memory-bodies.ts';
import {captureStorageChanges,prepareStorageChanges,restoreStorageMaterials,validateTaskMaterialRef} from '../core/storage-records.ts';
import {hashText} from '../core/text-hash.ts';

const chunkChars=32768;
const stores=['state','texts','memoryBodies','memoryIndex','entities','head','taskMaterials','textChunks','textMeta','observations','partnerAvatars'];
type TextMeta={version:string;length:number;chunkChars:number};
/** Explicit entity changes and scalar head share one existing IDB transaction.
 * Full save is reserved for import/migration, never used to infer changes. */
export class IndexedRecordStore implements Store {
 readonly databaseName:string;
 protected database:Promise<IDBDatabase>;
 private writing:Promise<void>=Promise.resolve();
 private bodies=new BoundedMemoryBodyCache();
 private verifiedTaskBodies=new WeakSet<TaskMaterialBody>();
 private writtenTaskMaterials=new Set<string>();
 constructor(name:string,version:number){
  this.databaseName=name;
  this.database=new Promise((resolve,reject)=>{const req=indexedDB.open(name,version);let blocked=false;req.onupgradeneeded=()=>{for(const store of stores)if(!req.result.objectStoreNames.contains(store))req.result.createObjectStore(store);};req.onblocked=()=>{blocked=true;reject(Error('同一共读存档的旧页面仍占用资料库，请先关闭该旧页面后重新打开；原记录保持'));};req.onsuccess=()=>{const db=req.result;if(blocked){db.close();return;}db.onversionchange=()=>db.close();resolve(db);};req.onerror=()=>reject(req.error);});
 }
 protected queue(work:()=>Promise<void>):Promise<void>{const next=this.writing.catch(()=>{}).then(work);this.writing=next;return next;}
 protected async get<T>(store:string,key:IDBValidKey):Promise<T|undefined>{const db=await this.database;return new Promise((resolve,reject)=>{const req=db.transaction(store).objectStore(store).get(key);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
 async load():Promise<State|undefined>{
  const db=await this.database;
  const snapshot=await new Promise<{head?:Record<string,unknown>;authority?:boolean;entries:{collection:string;value:unknown;order:number}[]}>((resolve,reject)=>{
   const tx=db.transaction(['head','entities']),head=tx.objectStore('head').get('current'),authority=tx.objectStore('head').get('authority'),entries=tx.objectStore('entities').getAll();
   tx.oncomplete=()=>resolve({head:head.result,authority:authority.result,entries:entries.result});tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });
  const head=snapshot.head;
  if(!head){
   if(snapshot.authority)throw Error('本地资料头缺失，未自动回退旧档');
   const legacy=await this.get<State>('state','current');if(!legacy)return;
   for(const book of legacy.books)if(!book.text)book.text=await this.get<string>('texts',book.version)??await this.get<string>('texts',book.id+':'+book.version)??'';
   await this.save(legacy);releasePersistedMemoryBodies(legacy);return this.load();
  }
  const state={...head} as unknown as State;delete (state as any).storageOrder;
  for(const name of stateCollections)(state as any)[name]=[];
  const entries=snapshot.entries;
  for(const entry of entries.sort((a,b)=>a.order-b.order))if((stateCollections as readonly string[]).includes(entry.collection))(state as any)[entry.collection].push(entry.value);
  await restoreStorageMaterials(state,this.readTaskMaterials.bind(this));return state;
 }
 async readPartnerAvatar(id:string):Promise<import('../core/types.ts').PartnerAvatarAsset|undefined>{return this.get('partnerAvatars',id);}
 async writePartnerAvatar(asset:import('../core/types.ts').PartnerAvatarAsset):Promise<void>{
  const {partnerAvatarAsset}=await import('../core/partner-avatar.ts'),verified=await partnerAvatarAsset(asset.dataUrl);if(verified.id!==asset.id||verified.mimeType!==asset.mimeType)throw Error('头像图片身份不符');
  await this.queue(async()=>{const prior=await this.readPartnerAvatar(asset.id);if(prior){if(prior.dataUrl!==asset.dataUrl)throw Error('头像资源冲突');return;}const db=await this.database;await new Promise<void>((resolve,reject)=>{const tx=db.transaction('partnerAvatars','readwrite');tx.objectStore('partnerAvatars').put(asset,asset.id);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});});
 }
 async readMemoryBodies(refs:readonly MemoryBodyRef[]):Promise<MemoryBody[]>{return this.bodies.read(refs,async missing=>{const found=await Promise.all(missing.map(ref=>this.get<MemoryBody>('memoryBodies',ref.key)));return found.filter((b):b is MemoryBody=>!!b);});}
 async readTaskMaterials(refs:readonly TaskMaterialRef[]):Promise<TaskMaterialBody[]>{for(const ref of refs)validateTaskMaterialRef(ref);const found=await Promise.all(refs.map(ref=>this.get<TaskMaterialBody>('taskMaterials',ref.key)));return found.filter((b):b is TaskMaterialBody=>!!b);}
 async readMemoryIndex():Promise<unknown|undefined>{return this.get('memoryIndex','current');}
 writeMemoryIndex(index:unknown):Promise<void>{const copy=structuredClone(index);if(new TextEncoder().encode(JSON.stringify(copy)).length>16000000)return Promise.reject(Error('阅读档案索引超过当前支持体积'));return this.queue(()=>this.putSingle('memoryIndex','current',copy));}
 private async putSingle(store:string,key:IDBValidKey,value:unknown):Promise<void>{const db=await this.database;await new Promise<void>((resolve,reject)=>{const tx=db.transaction(store,'readwrite');tx.objectStore(store).put(value,key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error??Error('本地保存未完成'));});}
 async readBookRanges(version:string,ranges:readonly Range[]):Promise<BookRangeResult>{
  const meta=await this.get<TextMeta>('textMeta',version);if(!meta||meta.version!==version||!Number.isSafeInteger(meta.length)||meta.length<1||meta.chunkChars!==chunkChars)throw Error('原文范围仓缺失或版本不符');
  const pieces=[];
  for(const range of ranges){
   if(!Number.isSafeInteger(range.start)||!Number.isSafeInteger(range.end)||range.start<0||range.end<=range.start||range.end>meta.length)throw Error('原文范围越界');
   let text='';
   for(let index=Math.floor(range.start/meta.chunkChars);index<=Math.floor((range.end-1)/meta.chunkChars);index++){
    const chunk=await this.get<{text:string;hash:string}>('textChunks',[version,index]);if(!chunk||await hashText(chunk.text)!==chunk.hash)throw Error('原文范围块缺失或校验失败');
    const base=index*meta.chunkChars;text+=chunk.text.slice(Math.max(0,range.start-base),Math.min(chunk.text.length,range.end-base));
   }
   if(text.length!==range.end-range.start)throw Error('原文范围长度不符');pieces.push({...range,text,hash:await hashText(text)});
  }
  return {version,length:meta.length,pieces};
 }
 async readBookText(version:string):Promise<string>{
  const meta=await this.get<TextMeta>('textMeta',version);if(!meta)throw Error('原文缺失');const {pieces}=await this.readBookRanges(version,[{start:0,end:meta.length}]);const text=pieces[0].text;if(await hashText(text)!==version)throw Error('原文版本校验失败');return text;
 }
 save(state:State):Promise<void>{
  const books=state.books.map(book=>({...book}));
  const snapshot=prepareMemoryBodySnapshot({...state,books:state.books.map(book=>({...book,textLength:book.text.length||book.textLength,text:''}))});snapshot.catch(()=>{});
  return this.queue(async()=>{
   const prepared=await snapshot,copy=prepared.state;
   const fields={...copy} as Record<string,any>;for(const name of stateCollections)delete fields[name];delete fields.secrets;delete fields.exportedAt;
   const collections:StateChangeSet['collections']={};for(const name of stateCollections)(collections as any)[name]={put:(copy as any)[name]??[]};
   const changes=await prepareStorageChanges({id:'full-import',collections,memoryBodies:prepared.bodies});
   const originals=[];for(const book of books){const existing=await this.get<TextMeta>('textMeta',book.version);if(book.text){if(await hashText(book.text)!==book.version)throw Error('导入原文版本不符');if(!existing){const chunks=[];for(let i=0;i<book.text.length;i+=chunkChars){const text=book.text.slice(i,i+chunkChars);chunks.push({text,hash:await hashText(text)});}originals.push({version:book.version,length:book.text.length,chunks});}}else if(!existing)throw Error('原文尚未保存');}
   await this.commit(changes,{head:fields,originals});prepared.commit();
  });
 }
 applyChanges(changes:StateChangeSet):Promise<void>{
  const captured=captureStorageChanges(changes);
  const memoryRecords=changes.collections.memories?.put;
  const snapshot=memoryRecords?.length?prepareMemoryBodySnapshot({memories:memoryRecords} as State):undefined;snapshot?.catch(()=>{});
  return this.queue(async()=>{
   const prepared=await snapshot;
   const input=prepared?{...captured,collections:{...captured.collections,memories:{...captured.collections.memories,put:prepared.state.memories}},memoryBodies:[...(captured.memoryBodies??[]),...prepared.bodies]}:captured;
   for(const book of input.collections.books?.put??[])if(book.text)throw Error('局部提交只接受原文元信息，完整原文请走导入');
   await this.commit(await prepareStorageChanges(input));prepared?.commit();
  });
 }
 private async commit(changes:StoredStateChangeSet,full?:{head:Record<string,unknown>;originals:{version:string;length:number;chunks:{text:string;hash:string}[]}[]}):Promise<void>{
  const memoryBodies=[...new Map((changes.memoryBodies??[]).map(b=>[b.key,b])).values()];
  for(const body of memoryBodies)if(body.key!=='memory-body-'+body.hash||await hashText(body.text)!==body.hash)throw Error('阅读正文对象校验失败');
  for(const body of changes.taskMaterials??[])if(!this.verifiedTaskBodies.has(body)){if(body.key!=='task-material-'+body.hash||await hashText(JSON.stringify(body.value))!==body.hash)throw Error('任务材料正文校验失败');this.verifiedTaskBodies.add(body);}
  const newMemoryBodies:MemoryBody[]=[];for(const body of memoryBodies){const prior=await this.get<MemoryBody>('memoryBodies',body.key);if(prior&&(prior.hash!==body.hash||prior.text!==body.text))throw Error('不可变阅读正文对象冲突');if(!prior)newMemoryBodies.push(body);}
  const newTaskBodies:TaskMaterialBody[]=[];for(const body of changes.taskMaterials??[]){if(this.writtenTaskMaterials.has(body.key))continue;const prior=await this.get<TaskMaterialBody>('taskMaterials',body.key);if(prior&&(prior.hash!==body.hash||JSON.stringify(prior.value)!==JSON.stringify(body.value)))throw Error('不可变任务材料对象冲突');if(!prior)newTaskBodies.push(body);}
  const db=await this.database;
  await new Promise<void>((resolve,reject)=>{
   const tx=db.transaction(['head','entities','memoryBodies','taskMaterials','textMeta','textChunks'],'readwrite');const heads=tx.objectStore('head'),entities=tx.objectStore('entities');let failure:Error|undefined;
   const abort=(message:string)=>{failure=Error(message);tx.abort();};
   tx.oncomplete=()=>{for(const body of changes.taskMaterials??[])this.writtenTaskMaterials.add(body.key);resolve();};tx.onerror=()=>reject(failure??tx.error);tx.onabort=()=>reject(failure??tx.error??Error('本地事务未保存'));
   // Content-addressed keys were checked above; publication of refs shares tx.
   for(const body of newMemoryBodies)tx.objectStore('memoryBodies').put(body,body.key);
   for(const body of newTaskBodies)tx.objectStore('taskMaterials').put(body,body.key);
   for(const original of full?.originals??[]){tx.objectStore('textMeta').put({version:original.version,length:original.length,chunkChars},original.version);original.chunks.forEach((chunk,index)=>tx.objectStore('textChunks').put(chunk,[original.version,index]));}
   const headReq=heads.get('current');headReq.onsuccess=()=>{
    if(!full&&!headReq.result){abort('局部资料尚未初始化');return;}
    const head=full?{...full.head}:{...headReq.result};Object.assign(head,changes.set);for(const key of changes.unset??[])delete head[key];head.schema=1;
    if(full)entities.clear();let nextOrder=(head.storageOrder as number|undefined)??0,pending=stateCollections.reduce((n,name)=>n+(changes.collections[name]?.put?.length??0),0);
    const publishHead=()=>{head.storageOrder=nextOrder;heads.put(head,'current');heads.put(true,'authority');};
    for(const name of stateCollections){const change=changes.collections[name];if(!change)continue;for(const key of change.remove??[])entities.delete([name,key]);for(const value of change.put??[]){const key=stateRecordKey(name,value as any);if(typeof key!=='string'||!key){abort('实体存储身份缺失');return;}const req=entities.get([name,key]);req.onsuccess=()=>{entities.put({collection:name,value,order:req.result?.order??nextOrder++},[name,key]);if(!--pending)publishHead();};}}
    if(!pending)publishHead();
   };
   for(const name of stateCollections)for(const value of changes.collections[name]?.put??[]){const record=value as any;
    const check=(store:string,key:string)=>{const req=tx.objectStore(store).count(key);req.onsuccess=()=>{if(!req.result)abort('局部提交的正文引用未保存');};};
    if(name==='books'){const req=tx.objectStore('textMeta').get(record.version);req.onsuccess=()=>{if(!req.result||req.result.version!==record.version||req.result.length!==record.textLength)abort('局部书籍提交的原文版本或长度尚未保存');};}
    if(name==='memories'){if(!record.bodyRef){abort('阅读正文引用缺失');return;}check('memoryBodies',record.bodyRef.key);}
    if(record.materialRef)check('taskMaterials',record.materialRef.key);for(const key of ['pendingReceipt','maintenanceDispatch','agentResponse'])if(record[key]?.materialRef)check('taskMaterials',record[key].materialRef.key);
   }
  });
 }
 async loadObservations<T>():Promise<T|undefined>{return this.get<T>('observations','current');}
 saveObservations(value:unknown):Promise<void>{const copy=structuredClone(value);return this.queue(()=>this.putSingle('observations','current',copy));}
 async close():Promise<void>{await this.writing.catch(()=>{});(await this.database).close();}
}
export class LocalStore extends IndexedRecordStore {constructor(){super('yixu-reading',6);}}
