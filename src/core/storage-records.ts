import {hashText} from './text-hash.ts';
import {stateCollections} from './types.ts';
import type {State,StateChangeSet,StoredStateChangeSet,TaskMaterialBody,TaskMaterialRef,Store} from './types.ts';

const materialRefs=new WeakMap<object,Promise<{ref:TaskMaterialRef;body:TaskMaterialBody}>>();
const resolvedRefs=new WeakMap<object,TaskMaterialRef>();
/** Metadata belongs to the transaction; immutable task bodies keep their identity. */
export function captureStorageChanges(input:StateChangeSet):StateChangeSet{
  const {collections,taskMaterials,...head}=input;
  const captured=structuredClone(head),records:Record<string,unknown>={};
  for(const name of stateCollections){
    const change=collections[name];if(!change)continue;
    records[name]={...(change.remove?{remove:[...change.remove]}:{}),...(change.put?{put:change.put.map(value=>{
      const {material,pendingReceipt,maintenanceDispatch,...metadata}=value as Record<string,any>;
      const copy=structuredClone(metadata);
      if(material)copy.material=material;
      if(pendingReceipt){const {material:pendingMaterial,...pendingMetadata}=pendingReceipt;copy.pendingReceipt=structuredClone(pendingMetadata);if(pendingMaterial)copy.pendingReceipt.material=pendingMaterial;}
      if(maintenanceDispatch){const {material:dispatchMaterial,...dispatchMetadata}=maintenanceDispatch;copy.maintenanceDispatch=structuredClone(dispatchMetadata);if(dispatchMaterial)copy.maintenanceDispatch.material=dispatchMaterial;}
      return copy;
    })}:{})};
  }
  return{...captured,collections:records,...(taskMaterials?{taskMaterials:taskMaterials.map(body=>({...body}))}:{})} as StateChangeSet;
}
async function materialBody(value:TaskMaterialBody['value']):Promise<{ref:TaskMaterialRef;body:TaskMaterialBody}>{
  let saved=materialRefs.get(value);
  if(!saved){
    // Capture one immutable body before any asynchronous work. Live task material
    // is never a second public snapshot or an adapter-specific interpretation.
    const text=JSON.stringify(value);
    saved=hashText(text).then(hash=>{const key='task-material-'+hash,ref={key,hash,bytes:new TextEncoder().encode(text).length};resolvedRefs.set(value,ref);return{ref,body:{key,hash,value:JSON.parse(text)}};});
    materialRefs.set(value,saved);
  }
  return saved;
}
export async function taskMaterialReference(value:TaskMaterialBody['value']):Promise<TaskMaterialRef>{return{...(await materialBody(value)).ref};}
export function releaseStorageMaterials(owners:readonly {material?:TaskMaterialBody['value'];materialRef?:TaskMaterialRef}[]):void{
  for(const owner of owners)if(owner.material&&owner.materialRef&&resolvedRefs.get(owner.material)?.key===owner.materialRef.key)delete owner.material;
}
export async function prepareStorageChanges(input:StateChangeSet):Promise<StoredStateChangeSet>{
  const bodies=new Map((input.taskMaterials??[]).map(body=>[body.key,body]));
  const memoryBodies=new Map((input.memoryBodies??[]).map(body=>[body.key,body]));
  const collections:Record<string,unknown>={};
  for(const name of stateCollections){
    const change=input.collections[name];if(!change)continue;
    const put=[];
    for(const value of change.put??[]){
      const record={...value} as Record<string,any>;
      if(name==='books'){if(record.text)throw Error('局部书籍提交只能保存元信息，原文导入须走明确导入事务');delete record.residentRanges;}
      if(name==='memories'&&typeof record.text==='string'){
        const hash=await hashText(record.text),key='memory-body-'+hash;
        memoryBodies.set(key,{key,hash,text:record.text});record.bodyRef={key,hash,chars:record.text.length};delete record.text;
      }
      if(record.material){const stored=await materialBody(record.material);bodies.set(stored.body.key,stored.body);delete record.material;record.materialRef=stored.ref;}
      for(const key of ['pendingReceipt','maintenanceDispatch'])if(record[key]?.material){const stored=await materialBody(record[key].material);bodies.set(stored.body.key,stored.body);const {material:_,...pending}=record[key];record[key]={...pending,materialRef:stored.ref};}
      put.push(structuredClone(record));
    }
    collections[name]={...(change.put?{put}:{}),...(change.remove?{remove:[...change.remove]}:{})};
  }
  return{...input,collections,memoryBodies:[...memoryBodies.values()],taskMaterials:[...bodies.values()]} as StoredStateChangeSet;
}
export function validateTaskMaterialRef(ref:TaskMaterialRef):void{
  if(!ref||typeof ref.hash!=='string'||!/^[a-f0-9]{64}$/.test(ref.hash)||ref.key!=='task-material-'+ref.hash||!Number.isSafeInteger(ref.bytes)||ref.bytes<1)throw Error('原任务材料引用无效');
}
/** Storage-local references are resolved before domain validation. Legacy inline
 * material is retained exactly; no missing source or empty message is invented. */
export async function restoreStorageMaterials(state:State,read:Store['readTaskMaterials']):Promise<void>{
  const owners:Record<string,any>[]=[];
  for(const name of ['readingDrafts','companionReadingReceipts','queryCheckpoints'] as const)for(const record of state[name]??[]){owners.push(record);if('pendingReceipt' in record&&record.pendingReceipt)owners.push(record.pendingReceipt);}
  for(const usage of state.usage)if(usage.maintenanceDispatch)owners.push(usage.maintenanceDispatch);
  const refs=new Map<string,TaskMaterialRef>();
  for(const owner of owners)if(owner.materialRef){validateTaskMaterialRef(owner.materialRef);const prior=refs.get(owner.materialRef.key);if(prior&&(prior.hash!==owner.materialRef.hash||prior.bytes!==owner.materialRef.bytes))throw Error('同份原任务材料的引用校验信息不一致');refs.set(owner.materialRef.key,owner.materialRef);}
  // Startup keeps cold/blocked identities outside the live state. Their domain
  // bodies are validated only when that original task is explicitly consumed.
}
export async function resolveStorageMaterials(owners:readonly {material?:TaskMaterialBody['value'];materialRef?:TaskMaterialRef}[],read:Store['readTaskMaterials']):Promise<void>{
  const refs=new Map<string,TaskMaterialRef>();
  for(const owner of owners)if(owner.materialRef&&!owner.material){validateTaskMaterialRef(owner.materialRef);const prior=refs.get(owner.materialRef.key);if(prior&&(prior.hash!==owner.materialRef.hash||prior.bytes!==owner.materialRef.bytes))throw Error('同份原任务材料的引用校验信息不一致');refs.set(owner.materialRef.key,owner.materialRef);}
  if(!refs.size)return;if(!read)throw Error('原任务材料存储不可用，未恢复为空任务');
  const bodies=await read([...refs.values()]),loaded=new Map<string,TaskMaterialBody['value']>();
  for(const body of bodies){const ref=refs.get(body.key);if(!ref||loaded.has(body.key))throw Error('原任务材料返回身份不符');const text=JSON.stringify(body.value);if(body.hash!==ref.hash||await hashText(text)!==ref.hash||new TextEncoder().encode(text).length!==ref.bytes)throw Error('原任务材料正文校验失败');loaded.set(body.key,body.value);}
  for(const owner of owners)if(owner.materialRef&&!owner.material){const material=loaded.get(owner.materialRef.key);if(!material)throw Error('原任务材料缺失，原答保持');owner.material=material;resolvedRefs.set(material,owner.materialRef);materialRefs.set(material,Promise.resolve({ref:owner.materialRef,body:{key:owner.materialRef.key,hash:owner.materialRef.hash,value:material}}));}
}
