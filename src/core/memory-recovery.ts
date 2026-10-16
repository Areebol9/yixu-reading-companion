import {hydrateMemoryBodies} from './memory-bodies.ts';
import {prepareMemoryIdentities} from './memory-identity.ts';
import type {Memory,ReadingDraftMaterial,State,Store} from './types.ts';

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
    for(const a of q.acquired)if(a.kind==='memory'&&!contentStamp(a.stamp))ids.add(a.id);
  }
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
}
