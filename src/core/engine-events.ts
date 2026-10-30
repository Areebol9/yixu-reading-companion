import {stateCollections,stateRecordKey} from './types.ts';
import type {StateChangeSet,StateCollection} from './types.ts';

/** Committed domain changes and transient execution status have separate costs. */
export type EngineChange={changes?:StateChangeSet;reset?:boolean};

export function mergeEngineChanges(previous:EngineChange|undefined,next:EngineChange):EngineChange{
  if(previous?.reset||next.reset)return{reset:true};
  if(!previous?.changes)return next;
  if(!next.changes)return previous;
  const a=previous.changes,b=next.changes,collections:StateChangeSet['collections']={...a.collections};
  for(const name of stateCollections){
    const incoming=b.collections[name];if(!incoming)continue;
    const old=collections[name],put=new Map((old?.put??[]).map(value=>[stateRecordKey(name,value as never),value])),remove=new Set(old?.remove??[]);
    for(const key of incoming.remove??[]){put.delete(key);remove.add(key);}
    for(const value of incoming.put??[]){const key=stateRecordKey(name,value as never);remove.delete(key);put.set(key,value);}
    (collections as Record<StateCollection,unknown>)[name]={...(put.size?{put:[...put.values()]}:{}),...(remove.size?{remove:[...remove]}:{})};
  }
  const set={...a.set,...b.set},unset=new Set(a.unset??[]);
  for(const key of Object.keys(b.set??{}))unset.delete(key as 'resume');
  for(const key of b.unset??[]){delete set[key];unset.add(key);}
  return{changes:{id:b.id,collections,...(Object.keys(set).length?{set}:{}),...(unset.size?{unset:[...unset]}:{})}};
}
