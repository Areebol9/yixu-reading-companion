import {hashText} from './text-hash.ts';
import type {ReadingDraftMaterial,State} from './types.ts';

export type DependencyNode={kind:string;id:string;hash:string;bytes:number};
export type DependencyNodeConflict={kind:string;id:string;change:'missing'|'changed'|'added'};
type Json=null|boolean|number|string|Json[]|{[key:string]:Json};
type Prepared={value:Json;node:DependencyNode};
const prepared=new WeakMap<object,Map<string,Prepared[]>>();
const projectionOwners=new WeakMap<object,object>();
/** Staged habit reconciliation clones entities but is not a new archive. This
 * shares a cache owner only; every staged semantic value is still checked. */
export function linkDependencyProjectionOwners(staged:State,source:State):void{
  for(const name of ['memories','chats','habits','publishedViews','readings','companionCorrectionRepairs'] as const){
    const originals=new Map((source[name]??[]).map(item=>[item.id,item]));
    for(const item of staged[name]??[]){const original=originals.get(item.id);if(original)projectionOwners.set(item,projectionOwners.get(original)??original);}
  }
}
export class DependencyPreparationRequired extends Error {
  constructor(kind:string,id:string,readonly changed:boolean){super('Dependency source version is not prepared: '+kind+' '+id);}
}

/** A verified structural clone may inherit preparation, never a cold import. */
export function inheritDependencyPreparation(from:ReadingDraftMaterial,to:ReadingDraftMaterial):void {
  for(let i=0;i<from.passages.length;i++){
    const source=from.passages[i][1],target=to.passages[i]?.[1],cache=prepared.get(source);
    if(target&&cache&&equal(capture(source),capture(target)))prepared.set(target,cache);
  }
}

/** Capture container mutations without retaining a second escaped JSON copy of
 * large source strings. Primitive strings still share their original value. */
function capture(value:unknown,parents=new Set<object>()):Json {
  if(value===null||value===undefined)return null;
  if(typeof value==='string'||typeof value==='boolean')return value;
  if(typeof value==='number')return Number.isFinite(value)?value:null;
  if(typeof value!=='object')throw Error('Dependency source is not JSON data');
  if(parents.has(value))throw Error('Dependency source contains a cycle');
  parents.add(value);
  try {
    if(Array.isArray(value))return value.map(item=>capture(item,parents));
    const record=value as Record<string,unknown>;
    return Object.fromEntries(Object.keys(record).sort().filter(key=>record[key]!==undefined).map(key=>[key,capture(record[key],parents)]));
  } finally {parents.delete(value);}
}
function equal(a:Json,b:Json):boolean {
  if(a===b)return true;
  if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
  const ak=Object.keys(a),bk=Object.keys(b);if(ak.length!==bk.length)return false;
  return ak.every((key,index)=>key===bk[index]&&equal((a as Record<string,Json>)[key],(b as Record<string,Json>)[key]));
}
/** Compare a verified snapshot directly to live JSON before allocating another
 * deep capture. Missing/undefined properties retain capture's exact semantics. */
function equalLive(snapshot:Json,value:unknown,parents=new Set<object>()):boolean{
  if(value===undefined||value===null)return snapshot===null;
  if(typeof value==='number')return snapshot===(Number.isFinite(value)?value:null);
  if(typeof value!=='object')return snapshot===value;
  if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot)!==Array.isArray(value)||parents.has(value))return false;
  parents.add(value);try{
    if(Array.isArray(value))return Array.isArray(snapshot)&&snapshot.length===value.length&&value.every((item,index)=>equalLive(snapshot[index],item,parents));
    const live=value as Record<string,unknown>,keys=Object.keys(live).filter(key=>live[key]!==undefined),old=Object.keys(snapshot);
    return keys.length===old.length&&old.every(key=>Object.hasOwn(live,key)&&live[key]!==undefined&&equalLive((snapshot as Record<string,Json>)[key],live[key],parents));
  }finally{parents.delete(value);}
}
function nodeKey(kind:string,id:string){if(!kind||!id)throw Error('Dependency node requires its actual source identity');return JSON.stringify([kind,id]);}

/** Preparation is explicit and asynchronous. A cached ID alone is never proof
 * that the current source has the same content, including in-place edits. */
export async function prepareDependencyNode(owner:object,kind:string,id:string,value:unknown):Promise<DependencyNode> {
  const key=nodeKey(kind,id),old=prepared.get(owner)?.get(key)?.find(old=>equalLive(old.value,value));
  if(old)return {...old.node};
  const snapshot=capture(value);
  const text=JSON.stringify(snapshot),hash=await hashText(JSON.stringify(['yixu-dependency-node/v3',kind,id,snapshot]));
  if(!equal(snapshot,capture(value)))throw Error('Dependency source changed during version preparation');
  const node={kind,id,hash,bytes:new TextEncoder().encode(text).byteLength};
  let nodes=prepared.get(owner);if(!nodes)prepared.set(owner,nodes=new Map());
  const versions=nodes.get(key)??[];
  // Frozen and live state may legitimately coexist while a request is in flight.
  if(!versions.some(old=>equal(old.value,snapshot)))versions.push({value:snapshot,node});
  nodes.set(key,versions);return {...node};
}

export function dependencyNode(owner:object,kind:string,id:string,value:unknown):DependencyNode {
  const old=prepared.get(owner)?.get(nodeKey(kind,id))?.find(old=>equalLive(old.value,value));
  if(!old)throw new DependencyPreparationRequired(kind,id,prepared.get(owner)?.has(nodeKey(kind,id))??false);
  return {...old.node};
}
/** Only an actually prepared, hash-verified original may explain a historical
 * node mismatch. A source label or equal displayed text is insufficient. */
export function dependencyNodeSnapshot(entity:object,kind:string,id:string,hash:string):unknown|undefined {
  const owner=projectionOwners.get(entity)??entity;
  const value=prepared.get(owner)?.get(nodeKey(kind,id))?.find(value=>value.node.hash===hash)?.value;
  return value===undefined?undefined:structuredClone(value);
}

/** Conflict reports identify the individual read, rather than hiding every
 * source and write precondition behind one package hash. */
export function dependencyNodeConflicts(previous:readonly DependencyNode[],current:readonly DependencyNode[]):DependencyNodeConflict[] {
  const before=new Map(previous.map(node=>[nodeKey(node.kind,node.id),node])),after=new Map(current.map(node=>[nodeKey(node.kind,node.id),node]));
  const conflicts:DependencyNodeConflict[]=[];
  for(const node of previous){const now=after.get(nodeKey(node.kind,node.id));if(!now)conflicts.push({kind:node.kind,id:node.id,change:'missing'});else if(now.hash!==node.hash||now.bytes!==node.bytes)conflicts.push({kind:node.kind,id:node.id,change:'changed'});}
  for(const node of current)if(!before.has(nodeKey(node.kind,node.id)))conflicts.push({kind:node.kind,id:node.id,change:'added'});
  return conflicts;
}

type Source={owner:object;kind:string;id:string;value:unknown};
type Projection=Record<string,any>;

/** The projection preserves all historical semantic fields. Only actual source
 * entities become read-set nodes; immutable formation options stay explicit. */
function nodeProjection(state:State,material:ReadingDraftMaterial,input:Projection,read:(source:Source)=>unknown):Projection {
  const output:Projection={...input,dependencyStampVersion:3};
  // Cache residency follows actual entities, not replaceable state/array views.
  const entities:Record<string,readonly {id:string}[]>={memory:state.memories,chat:state.chats,habit:state.habits??[],view:state.publishedViews??[],scene:state.readings??[]};
  const nodes=(kind:string,ids:string[],values:unknown[])=>ids.map((id,index)=>{const entity=entities[kind].find(entity=>entity.id===id)??values[index] as object;return values[index]==null?{kind,id,missing:true}:read({owner:projectionOwners.get(entity)??entity,kind,id,value:values[index]});});
  output.memories=nodes('memory',material.memoryIds,input.memories);
  output.chats=nodes('chat',material.chatIds,input.chats);
  output.habits=nodes('habit',material.habitIds,input.habits);
  if(input.views)output.views=nodes('view',material.viewIds??[],input.views);
  if(input.sceneRecords)output.sceneRecords=nodes('scene',material.sceneRecordIds??[],input.sceneRecords);
  output.originalSources={refs:material.refs,ranges:material.originalRanges,passages:material.passages.map(([label,passage])=>[label,read({owner:passage,kind:'original',id:JSON.stringify([passage.evidence.bookId,passage.evidence.version,passage.evidence.start,passage.evidence.end]),value:passage})])};
  if(input.correctionRepair!==undefined){const repair=state.companionCorrectionRepairs?.find(repair=>repair.id===material.correctionRepairId);output.correctionRepair=repair?read({owner:projectionOwners.get(repair)??repair,kind:'correction-repair',id:material.correctionRepairId!,value:input.correctionRepair}):null;}
  if(input.delegatedSources)output.delegatedSources=input.delegatedSources.map((source:Projection,index:number)=>{
    const delegated=material.delegatedSources![index];
    const nested:ReadingDraftMaterial={messages:[],refs:[],originalRanges:delegated.originalRanges,memoryIds:delegated.memoryIds,chatIds:delegated.chatIds,habitIds:[],passages:[],viewIds:delegated.viewIds,sourceStampVersion:2,basisStampVersion:1,dependencyStampVersion:3,readingStrategy:material.readingStrategy};
    return {...source,dependencies:nodeProjection(state,nested,source.dependencies,read)};
  });
  // Permissions and destructive changes remain visible preconditions, separate
  // from immutable content versions. Ordinary development keeps its old source.
  output.guards={
    memories:material.memoryIds.map(id=>{const m=state.memories.find(m=>m.id===id),next=state.memories.find(n=>n.id===m?.replacedBy);return{id,missing:!m,forgotten:m?.forgotten,invalidatedBy:m?.invalidatedBy,replacedBy:material.readingStrategy==='companion'&&next?.revisionKind==='development'?undefined:m?.replacedBy};}),
    chats:material.chatIds.map(id=>{const c=state.chats.find(c=>c.id===id);return{id,missing:!c,excluded:c?.excluded,outdatedBy:c?.outdatedBy,replacedBy:c?.replacedBy,futureGrant:c?.futureGrant};}),
    habits:material.habitIds.map(id=>{const h=state.habits?.find(h=>h.id===id);return{id,missing:!h,forgotten:h?.forgotten,retiredBy:h?.retiredBy,invalidatedBy:h?.invalidatedBy};}),
  };
  return output;
}

export async function prepareDependencyProjection(state:State,material:ReadingDraftMaterial,projection:Projection):Promise<void> {
  const sources:Source[]=[];nodeProjection(state,material,projection,source=>{sources.push(source);return null;});
  await Promise.all(sources.map(source=>prepareDependencyNode(source.owner,source.kind,source.id,source.value)));
}

export function dependencyProjection(state:State,material:ReadingDraftMaterial,projection:Projection):Projection {
  return nodeProjection(state,material,projection,source=>dependencyNode(source.owner,source.kind,source.id,source.value));
}
