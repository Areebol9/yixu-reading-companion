/** Index detached immutable collection arrays once. Replacements share positions;
 * only membership/order changes need a new index. No archive or record is copied. */
const indexes=new WeakMap<readonly unknown[],Map<string,ReadonlyMap<string,number>>>();
/** Only for one-to-one projections that preserve every identity and position. */
export function inheritRecordIndexes(source:readonly unknown[],target:readonly unknown[]):void{
  const known=indexes.get(source);if(known)indexes.set(target,known);
}
export function recordIndex<T>(values:readonly T[],scope:string,keyOf:(value:T)=>string):ReadonlyMap<string,number>{
  let scopes=indexes.get(values);if(!scopes){scopes=new Map();indexes.set(values,scopes);}
  let index=scopes.get(scope);if(!index){index=new Map(values.map((value,position)=>[keyOf(value),position]));scopes.set(scope,index);}return index;
}
export function updateRecordArray<T>(values:readonly T[],scope:string,keyOf:(value:T)=>string,put:readonly T[]=[],remove:readonly string[]=[]):T[]{
  const index=recordIndex(values,scope,keyOf),removed=new Set(remove),puts=new Map(put.map(value=>[keyOf(value),value]));
  if(!removed.size&&!puts.size)return values as T[];
  if(!removed.size&&[...puts.keys()].every(key=>index.has(key))){
    const next=values.slice();for(const [key,value]of puts)next[index.get(key)!]=value;
    indexes.set(next,new Map([[scope,index]]));return next;
  }
  const next:T[]=[];
  for(const value of values){const key=keyOf(value);if(removed.has(key))continue;next.push(puts.get(key)??value);puts.delete(key);}
  next.push(...puts.values());return next;
}
