import {hashText} from './text-hash.ts';
import {stateCollections} from './types.ts';
import type {State,StateChangeSet,StoredStateChangeSet,TaskMaterialBody,TaskMaterialRef,Store} from './types.ts';
import {decodeAgentSession,encodeAgentSession,type StoredMaterial} from './agent-session-storage.ts';

type DomainMaterial=Exclude<TaskMaterialBody['value'],import('./types.ts').AgentSessionEventChunk|import('./types.ts').AgentSessionManifest|import('./types.ts').AgentSessionMigrationSource|import('./types.ts').AgentSessionSpillBody>;
const materialRefs=new WeakMap<object,Promise<StoredMaterial>>();
const resolvedRefs=new WeakMap<object,TaskMaterialRef>();
/** Metadata belongs to the transaction; immutable task bodies keep their identity. */
export function captureStorageChanges(input:StateChangeSet):StateChangeSet{
  const {collections,taskMaterials,...head}=input;
  const captured=structuredClone(head),records:Record<string,unknown>={};
  for(const name of stateCollections){
    const change=collections[name];if(!change)continue;
    records[name]={...(change.remove?{remove:[...change.remove]}:{}),...(change.put?{put:change.put.map(value=>{
      const {material,pendingReceipt,maintenanceDispatch,agentResponse,formationSources,...metadata}=value as Record<string,any>;
      const copy=structuredClone(metadata);
      // A plan's exposure audit is immutable and shared by its results. Preserve
      // that identity through the single worker message instead of copying the
      // complete audit into each record before structured-clone transport.
      if(formationSources)copy.formationSources=formationSources;
      if(material)copy.material=material;
      if(pendingReceipt){const {material:pendingMaterial,...pendingMetadata}=pendingReceipt;copy.pendingReceipt=structuredClone(pendingMetadata);if(pendingMaterial)copy.pendingReceipt.material=pendingMaterial;}
      if(maintenanceDispatch){const {material:dispatchMaterial,...dispatchMetadata}=maintenanceDispatch;copy.maintenanceDispatch=structuredClone(dispatchMetadata);if(dispatchMaterial)copy.maintenanceDispatch.material=dispatchMaterial;}
      if(agentResponse){const {material:responseMaterial,...responseMetadata}=agentResponse;copy.agentResponse=structuredClone(responseMetadata);if(responseMaterial)copy.agentResponse.material=responseMaterial;}
      return copy;
    })}:{})};
  }
  return{...captured,collections:records,...(taskMaterials?{taskMaterials:taskMaterials.map(body=>({...body}))}:{})} as StateChangeSet;
}
async function materialBody(value:TaskMaterialBody['value']):Promise<StoredMaterial>{
  if('kind'in value&&value.kind==='agent-session-v1')return encodeAgentSession(value,materialBody);
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
/** Called only with the reference returned by a successful Store commit. The
 * caller retains the exact immutable material object submitted to that write. */
export function acknowledgeTaskMaterial(value:TaskMaterialBody['value'],ref:TaskMaterialRef):void{
  validateTaskMaterialRef(ref);resolvedRefs.set(value,{...ref});
  materialRefs.set(value,Promise.resolve({ref:{...ref},body:{key:ref.key,hash:ref.hash,value}}));
}
export function releaseStorageMaterials(owners:readonly {material?:DomainMaterial;materialRef?:TaskMaterialRef}[]):void{
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
      if(record.material){const stored=await materialBody(record.material);for(const body of stored.dependencies??[])bodies.set(body.key,body);bodies.set(stored.body.key,stored.body);resolvedRefs.set(record.material,stored.ref);delete record.material;record.materialRef=stored.ref;}
      for(const key of ['pendingReceipt','maintenanceDispatch','agentResponse'])if(record[key]?.material){const stored=await materialBody(record[key].material);bodies.set(stored.body.key,stored.body);const {material:_,...pending}=record[key];record[key]={...pending,materialRef:stored.ref};}
      const {formationSources,...metadata}=record,copy=structuredClone(metadata);if(formationSources)copy.formationSources=formationSources;put.push(copy);
    }
    collections[name]={...(change.put?{put}:{}),...(change.remove?{remove:[...change.remove]}:{})};
  }
  return{...input,collections,memoryBodies:[...memoryBodies.values()],taskMaterials:[...bodies.values()]} as StoredStateChangeSet;
}
export function validateTaskMaterialRef(ref:TaskMaterialRef):void{
  if(!ref||typeof ref.hash!=='string'||!/^[a-f0-9]{64}$/.test(ref.hash)||ref.key!=='task-material-'+ref.hash||!Number.isSafeInteger(ref.bytes)||ref.bytes<1)throw Error('原任务材料引用无效');
}
/** Every private task body shares the same transfer and integrity boundary. */
export function storageMaterialOwners(state:State):{material?:DomainMaterial;materialRef?:TaskMaterialRef}[]{
  return [...(state.readingDrafts??[]),...(state.companionReadingReceipts??[]),...(state.queryCheckpoints??[]),...(state.agentSessions??[]),
    ...(state.queryCheckpoints??[]).flatMap(record=>record.pendingReceipt?[record.pendingReceipt]:[]),
    ...state.usage.flatMap(usage=>[...(usage.maintenanceDispatch?[usage.maintenanceDispatch]:[]),...(usage.agentResponse?[usage.agentResponse]:[])])];
}
/** Storage-local references are resolved before domain validation. Legacy inline
 * material is retained exactly; no missing source or empty message is invented. */
export async function restoreStorageMaterials(state:State,read:Store['readTaskMaterials']):Promise<void>{
  const owners=storageMaterialOwners(state);
  const refs=new Map<string,TaskMaterialRef>();
  for(const owner of owners)if(owner.materialRef){validateTaskMaterialRef(owner.materialRef);const prior=refs.get(owner.materialRef.key);if(prior&&(prior.hash!==owner.materialRef.hash||prior.bytes!==owner.materialRef.bytes))throw Error('同份原任务材料的引用校验信息不一致');refs.set(owner.materialRef.key,owner.materialRef);}
  // Startup keeps cold/blocked identities outside the live state. Their domain
  // bodies are validated only when that original task is explicitly consumed.
}
export async function resolveStorageMaterials(owners:readonly {material?:DomainMaterial;materialRef?:TaskMaterialRef}[],read:Store['readTaskMaterials']):Promise<void>{
  const refs=new Map<string,TaskMaterialRef>();
  for(const owner of owners)if(owner.materialRef&&!owner.material){validateTaskMaterialRef(owner.materialRef);const prior=refs.get(owner.materialRef.key);if(prior&&(prior.hash!==owner.materialRef.hash||prior.bytes!==owner.materialRef.bytes))throw Error('同份原任务材料的引用校验信息不一致');refs.set(owner.materialRef.key,owner.materialRef);}
  if(!refs.size)return;if(!read)throw Error('原任务材料存储不可用，未恢复为空任务');
  const verified=new Map<string,{ref:TaskMaterialRef;body:TaskMaterialBody}>();
  const verify=async(body:TaskMaterialBody,ref:TaskMaterialRef)=>{validateTaskMaterialRef(ref);const known=verified.get(ref.key);if(known){if(known.ref.hash!==ref.hash||known.ref.bytes!==ref.bytes)throw Error('同份原任务材料的引用校验信息不一致');return known.body;}const text=JSON.stringify(body.value);if(body.key!==ref.key||body.hash!==ref.hash||await hashText(text)!==ref.hash||new TextEncoder().encode(text).length!==ref.bytes)throw Error('原任务材料正文校验失败');verified.set(ref.key,{ref,body});return body;};
  const bodies=await read([...refs.values()]);
  for(const body of bodies){const ref=refs.get(body.key);if(!ref||verified.has(body.key))throw Error('原任务材料返回身份不符');await verify(body,ref);}
  const readOne=async(ref:TaskMaterialRef)=>{validateTaskMaterialRef(ref);const known=verified.get(ref.key);if(known){if(known.ref.hash!==ref.hash||known.ref.bytes!==ref.bytes)throw Error('同份原任务材料的引用校验信息不一致');return known.body;}const values=await read([ref]);if(values.length!==1){if(values.length===0)throw Error('原任务材料缺失，原答保持');throw Error('原任务材料返回身份不符');}return verify(values[0],ref);};
  const loaded=new Map<string,DomainMaterial>();
  for(const ref of refs.values()){
    const body=verified.get(ref.key)?.body;if(!body)throw Error('原任务材料缺失，原答保持');
    let material:DomainMaterial;
    if('kind'in body.value&&body.value.kind==='agent-session-manifest-v1')material=await decodeAgentSession(body.value,{ref,body},readOne);
    else if('kind'in body.value&&body.value.kind==='agent-session-events-v1')throw Error('原任务材料不能直接引用事件分块');
    else if('kind'in body.value&&body.value.kind==='agent-session-migration-source-v1')throw Error('原迁移副本不能直接作为领域材料');
    else if('kind'in body.value&&body.value.kind==='agent-session-spill-v1')throw Error('长结果正文不能直接作为领域材料');
    else material=body.value;
    loaded.set(ref.key,material);resolvedRefs.set(material,ref);materialRefs.set(material,Promise.resolve({ref,body}));
  }
  // Assign only after every requested body and transitive dependency is valid.
  for(const owner of owners)if(owner.materialRef&&!owner.material)owner.material=loaded.get(owner.materialRef.key)!;
}
