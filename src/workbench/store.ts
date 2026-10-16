import {IndexedRecordStore} from '../platform/storage.ts';
import type {WorkbenchSession} from './contract.ts';
import {stateCollections} from '../core/types.ts';
import type {State,MemoryBody,MemoryBodyRef,TaskMaterialBody,TaskMaterialRef} from '../core/types.ts';
import {resolveStorageMaterials} from '../core/storage-records.ts';
import {hydrateMemoryBodies,requireMemoryText} from '../core/memory-bodies.ts';
import {hashText} from '../core/text-hash.ts';

const sessionIndex='yixu-workbench-sessions-v1';
const activeSessionKey='yixu-workbench-active-session-v1';
export function workbenchSessions():WorkbenchSession[]{
 try {const list=JSON.parse(localStorage.getItem(sessionIndex)??'[]');return Array.isArray(list)?list.filter(s=>/^[0-9a-f-]{36}$/i.test(s.id)&&['offline','live'].includes(s.mode)):[];}catch{return [];}
}
export function rememberSession(session:WorkbenchSession){const previous=workbenchSessions().find(s=>s.id===session.id);localStorage.setItem(sessionIndex,JSON.stringify([{...session,...(previous?.archivedAt?{archivedAt:previous.archivedAt}:{})},...workbenchSessions().filter(s=>s.id!==session.id)]));}
export function availableWorkbenchSessions(){return workbenchSessions().filter(session=>!session.archivedAt);}
export function activeWorkbenchSession():WorkbenchSession|undefined{return availableWorkbenchSessions().find(session=>session.id===localStorage.getItem(activeSessionKey));}
export function markWorkbenchSessionActive(id:string){if(!availableWorkbenchSessions().some(session=>session.id===id))throw Error('阅读存档不存在或已归档，不能作为当前阅读存档');localStorage.setItem(activeSessionKey,id);}
export function archiveWorkbenchSessions(ids:readonly string[],currentId:string):number{
 const list=workbenchSessions(),activeId=activeWorkbenchSession()?.id,selected=new Set(ids);
 if(selected.has(currentId)||activeId&&activeId!==currentId&&selected.has(activeId))throw Error('当前或其它页面正在使用的阅读存档不能归档，请先结束并切换到新存档');
 let count=0;const at=Date.now(),next=list.map(session=>selected.has(session.id)&&!session.archivedAt?(count++,{...session,archivedAt:at}):session);localStorage.setItem(sessionIndex,JSON.stringify(next));return count;
}

/** A detached, read-only download. No engine, restore, schema upgrade or active
 * session switch is involved, including for legacy database layouts. */
export async function exportArchivedWorkbenchBackup(sessionId:string):Promise<string>{
 if(!workbenchSessions().some(session=>session.id===sessionId&&session.archivedAt))throw Error('归档存档不存在');
 const db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open('yixu-workbench-'+sessionId);request.onupgradeneeded=()=>{request.transaction?.abort();reject(Error('归档原资料库不存在，未创建空档'));};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
 const read=<T>(name:string,key:IDBValidKey):Promise<T|undefined>=>!db.objectStoreNames.contains(name)?Promise.resolve(undefined):new Promise((resolve,reject)=>{const request=db.transaction(name,'readonly').objectStore(name).get(key);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
 try{
  const snapshot=await new Promise<{head?:Record<string,unknown>;authority?:boolean;entries:{collection:string;value:unknown;order:number}[];legacy?:State}>((resolve,reject)=>{
   const stores=['head','entities','state'].filter(name=>db.objectStoreNames.contains(name)),tx=db.transaction(stores,'readonly');
   const head=stores.includes('head')?tx.objectStore('head').get('current'):undefined,authority=stores.includes('head')?tx.objectStore('head').get('authority'):undefined,entries=stores.includes('entities')?tx.objectStore('entities').getAll():undefined,legacy=stores.includes('state')?tx.objectStore('state').get('current'):undefined;
   tx.oncomplete=()=>resolve({head:head?.result,authority:authority?.result,entries:entries?.result??[],legacy:legacy?.result});tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });
  const head=snapshot.head;let state:State;
  if(head){state={...head} as unknown as State;delete (state as any).storageOrder;for(const name of stateCollections)(state as any)[name]=[];
   const entries=snapshot.entries;
   for(const entry of entries.sort((a,b)=>a.order-b.order))if((stateCollections as readonly string[]).includes(entry.collection))(state as any)[entry.collection].push(entry.value);
  }else{if(snapshot.authority)throw Error('归档原资料头缺失，未回退其它存档');const legacy=snapshot.legacy;if(!legacy)throw Error('归档原资料不存在');state=legacy;}
  delete (state as State&{secrets?:unknown}).secrets;
  const owners=[...(state.readingDrafts??[]),...(state.companionReadingReceipts??[]),...(state.queryCheckpoints??[]),...(state.queryCheckpoints??[]).flatMap(q=>q.pendingReceipt?[q.pendingReceipt]:[]),...state.usage.flatMap(u=>u.maintenanceDispatch?[u.maintenanceDispatch]:[])];
  await resolveStorageMaterials(owners,async(refs:readonly TaskMaterialRef[])=>{const found=await Promise.all(refs.map(ref=>read<TaskMaterialBody>('taskMaterials',ref.key)));return found.filter((value):value is TaskMaterialBody=>!!value);});for(const owner of owners)delete owner.materialRef;
  for(let i=0;i<state.memories.length;i+=64){const batch=state.memories.slice(i,i+64);await hydrateMemoryBodies({async load(){return state;},async save(){throw Error('归档导出不允许保存');},readMemoryBodies:async(refs:readonly MemoryBodyRef[])=>{const found=await Promise.all(refs.map(ref=>read<MemoryBody>('memoryBodies',ref.key)));return found.filter((value):value is MemoryBody=>!!value);}},batch);for(const memory of batch){requireMemoryText(memory);delete memory.bodyRef;}}
  for(const book of state.books){if(book.text)continue;const meta=await read<{length:number;chunkChars:number}>('textMeta',book.version);if(meta){let text='';for(let i=0;i<Math.ceil(meta.length/meta.chunkChars);i++){const chunk=await read<{text:string;hash:string}>('textChunks',[book.version,i]);if(!chunk||await hashText(chunk.text)!==chunk.hash)throw Error('归档原文块缺失或校验不符');text+=chunk.text;}if(text.length!==meta.length||await hashText(text)!==book.version)throw Error('归档原文版本不符');book.text=text;}else{const text=await read<string>('texts',book.version)??await read<string>('texts',book.id+':'+book.version);if(text===undefined)throw Error('归档原文缺失');book.text=text;}}
  return JSON.stringify({...state,exportedAt:new Date().toISOString()});
 }finally{db.close();}
}

/** Independent session database, same typed transaction and range adapter. */
export class WorkbenchStore extends IndexedRecordStore {
 constructor(sessionId:string){
  if(!/^[0-9a-f-]{36}$/i.test(sessionId))throw Error('测试场次标识无效');
  super('yixu-workbench-'+sessionId,4);
 }
}
