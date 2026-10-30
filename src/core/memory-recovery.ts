import {hydrateMemoryBodies} from './memory-bodies.ts';
import {prepareMemoryIdentities} from './memory-identity.ts';
import {prepareDependencyStamp} from './reading-drafts.ts';
import {prepareQueryMaterial} from './query-checkpoints.ts';
import type {Memory,ReadingDraftMaterial,State,Store,QueryMaterial} from './types.ts';

/** Prepare only carriers already resident; resolving an owner stays its caller's job. */
export async function prepareLoadedDependencies(state:State,owners?:readonly object[]):Promise<void>{
  const selected=owners&&new Set(owners),includes=(owner:object)=>!selected||selected.has(owner);
  const query=async(m:ReadingDraftMaterial|undefined,result?:Parameters<typeof prepareQueryMaterial>[2])=>{if(m?.dependencyStampVersion===3)await prepareQueryMaterial(state,m as QueryMaterial,result);};
  for(const d of state.readingDrafts??[])if(includes(d)&&d.material?.dependencyStampVersion===3)await prepareDependencyStamp(state,{...d.material,memoryIds:[...d.material.memoryIds,...(d.material.partialMemoryIds??[])]},d.result);
  // Explicit recovery may select a blocked receipt whose material is distinct
  // from its dispatch snapshot. Prepare that exact loaded object as well.
  for(const r of state.companionReadingReceipts??[])if(includes(r)&&(r.status==='received'||!!selected))await query(r.material as QueryMaterial|undefined);
  for(const q of state.queryCheckpoints??[])if((includes(q)||!!q.pendingReceipt&&includes(q.pendingReceipt))&&q.status!=='consumed'){await query(q.material,q.status==='ready'?q.result:undefined);await query(q.pendingReceipt?.material as QueryMaterial|undefined);}
  for(const record of state.agentSessions??[])if(includes(record)){await query(record.material?.material);await query(record.material?.inheritedMaterial);}
  for(const usage of state.usage)if(usage.maintenanceDispatch&&includes(usage.maintenanceDispatch))await query(usage.maintenanceDispatch.material?.material);
}

function contentStamp(stamp:string):boolean {try{return JSON.parse(stamp).sourceStampVersion===2;}catch{return false;}}
/** Only historical stamps that contain actual text need the matching bodies.
 * Keep all checkpoints untouched if a required body is absent or corrupt. */
export async function prepareMemoryRecovery(state:State,store:Store):Promise<void> {
  const ids=new Set<string>(),inline:Memory[]=[];
  const material=(m:ReadingDraftMaterial|undefined)=>{if(m&&m.sourceStampVersion!==2)for(const id of [...m.memoryIds,...('partialMemoryIds'in m?(m.partialMemoryIds as string[]??[]):[])])ids.add(id);};
  for(const d of state.readingDrafts??[])material(d.material);
  for(const r of state.companionReadingReceipts??[])if(r.status==='received')material(r.material);
  for(const q of state.queryCheckpoints??[])if(q.status!=='consumed'){
    material(q.material);
    material(q.pendingReceipt?.material);
    for(const a of q.acquired)if(a.kind==='memory'&&!contentStamp(a.stamp))ids.add(a.id);
  }
  for(const record of state.agentSessions??[]){material(record.material?.material);material(record.material?.inheritedMaterial);}
  for(const usage of state.usage)material(usage.maintenanceDispatch?.material?.material);
  for(const p of state.companionCorrectionRepairs??[])if(p.status==='pending'){
    if(!contentStamp(p.dependencyStamp))for(const id of [p.oldMemoryId,...p.memoryIds,...p.correctionIds])ids.add(id);
    if(p.oldDraft)inline.push(p.oldDraft);
    for(const h of p.focusHandoffs??[])if(!contentStamp(h.sourceStamp))for(const id of h.after.focusIds)ids.add(id);
  }
  for(const task of state.tasks??[])if(['running','interrupted'].includes(task.status))for(const item of task.items)if(item.status==='pending'){
    ids.add(item.memoryId);
    const m=state.memories.find(m=>m.id===item.memoryId);
    if(m?.answersPartOf)ids.add(m.answersPartOf);
  }
  const targets=state.memories.filter(m=>ids.has(m.id));
  await hydrateMemoryBodies(store,[...targets,...inline]);
  // v2 dependencies require no bodies, but any inline edited text must be hashed.
  await prepareMemoryIdentities([...state.memories.filter(m=>typeof m.text==='string'),...inline]);
  await prepareLoadedDependencies(state);
}
