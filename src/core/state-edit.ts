import {stateCollections,stateRecordKey} from './types.ts';
import type {State,StateCollection,StateChangeSet} from './types.ts';
import {bookLength} from './books.ts';

export type StateEditScope={collections?:Partial<Record<StateCollection,readonly string[]|'all'>>;fields?:readonly (keyof State)[]};

/** Unselected records are available to validation without copying their cold
 * bodies or original responses. Editors may only mutate their declared scope. */
export function scopedStateCopy(state:State,scope:StateEditScope):State {
  const copy={...state};
  for(const name of stateCollections){
    const selection=scope.collections?.[name];if(!selection)continue;
    const ids=selection==='all'?undefined:new Set(selection);
    (copy as any)[name]=(state[name]??[]).map((record:any)=>{
      if(ids&&!ids.has(stateRecordKey(name,record)))return record;
      if(name==='books'){const {text,residentRanges,...metadata}=record;return {...structuredClone(metadata),text,...(residentRanges?{residentRanges}:{})};}
      if(name==='memories'){const {text,...metadata}=record;return {...structuredClone(metadata),...(text!==undefined?{text}:{})};}
      return structuredClone(record);
    });
  }
  for(const field of scope.fields??[]){
    if(!['settings','partnerId','resume'].includes(field))throw Error('保存字段须使用记录集合或设置字段');
    (copy as any)[field]=structuredClone(state[field]);
  }
  return copy;
}

/** Inspect only changed collection containers and selected records. Shared
 * immutable originals/materials never enter a whole-archive JSON comparison. */
export function stateEditChanges(before:State,after:State):Omit<StateChangeSet,'id'> {
  const collections:StateChangeSet['collections']={};
  for(const name of stateCollections){
    if(before[name]===after[name])continue;
    const old=new Map((before[name]??[]).map(record=>[stateRecordKey(name,record),record]));
    const remaining=new Set(old.keys()),put:any[]=[];
    for(const record of after[name]??[]){
      const key=stateRecordKey(name,record),previous=old.get(key);remaining.delete(key);
      if(record===previous)continue;
      const comparable=(value:any)=>{if(name!=='books'||!value)return value;const {text,residentRanges,...metadata}=value;return {...metadata,textLength:bookLength(value)};};
      if(!previous||JSON.stringify(comparable(record))!==JSON.stringify(comparable(previous)))put.push(record);
    }
    const remove=[...remaining];if(put.length||remove.length)(collections as any)[name]={...(put.length?{put}:{}),...(remove.length?{remove}:{})};
  }
  const set:NonNullable<StateChangeSet['set']>={},unset:NonNullable<StateChangeSet['unset']>=[];
  for(const field of ['settings','partnerId','resume'] as const)if(before[field]!==after[field]&&JSON.stringify(before[field])!==JSON.stringify(after[field])){
    if(field==='resume'&&after.resume===undefined)unset.push('resume');else (set as any)[field]=after[field];
  }
  return {collections,...(Object.keys(set).length?{set}:{}),...(unset.length?{unset}:{})};
}

// Apply only a saved edit's changes to the current in-memory state. Other events
// may have appended questions or advanced progress while the store was writing.
export function mergeStateEdit<T>(before: T, after: T, current: T): T {
  if (before === after) return current;
  if (Array.isArray(before) && Array.isArray(after) && Array.isArray(current)) {
    const identified = [...before, ...after, ...current].every((item: unknown) => item !== null && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string');
    if (identified) {
      const previous = new Map(before.map(item => [item.id, item]));
      const saved = new Map(after.map(item => [item.id, item]));
      const present = new Set(current.map(item => item.id));
      const result = current.filter(item => !previous.has(item.id) || saved.has(item.id)).map(item => previous.has(item.id) && saved.has(item.id) ? mergeStateEdit(previous.get(item.id), saved.get(item.id), item) : item);
      for (const item of after) if (!previous.has(item.id) && !present.has(item.id)) result.push(item);
      return result as T;
    }
    return (JSON.stringify(before) === JSON.stringify(after) ? current : after) as T;
  }
  if (before && after && current && typeof before === 'object' && typeof after === 'object' && typeof current === 'object') {
    const left = before as Record<string, unknown>, right = after as Record<string, unknown>;
    let live = current as Record<string, unknown>;
    const writable = () => { if (Object.isFrozen(live)) live = {...live}; return live; };
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (!(key in right)) { if (key in left && key in live) delete writable()[key]; }
      else if (!(key in left)) writable()[key] = right[key];
      else { const value = mergeStateEdit(left[key], right[key], live[key]); if (value !== live[key]) writable()[key] = value; }
    }
    return live as T;
  }
  return after;
}
