import {stateCollections,stateRecordKey} from '../core/types.ts';
import {recordIndex,updateRecordArray} from '../core/record-arrays.ts';

type Path=string[];
export type ProjectionDelta={set:{path:Path;value:unknown}[];unset:Path[];records:{path:Path;put:{key:string;value:unknown}[];remove:string[];order?:string[]}[];append:{path:Path;values:unknown[]}[]};
const safe=(path:Path)=>path.length>0&&!path.some(key=>['__proto__','constructor','prototype'].includes(key));
const keyOf=(path:Path,item:any)=>path[0]==='app'&&path[1]==='state'&&(stateCollections as readonly string[]).includes(path[2])?stateRecordKey(path[2] as typeof stateCollections[number],item):String(item.id??item.bookId??item.questionId);
const scopeOf=(path:Path)=>path[0]==='app'&&path[1]==='state'?path[2]:JSON.stringify(path);
const equal=(a:unknown,b:unknown)=>a===b||JSON.stringify(a)===JSON.stringify(b);
/** Committed record identities make ordinary body scrolling independent of history size. */
export function diffProjection(before:any,after:any):ProjectionDelta{
  const patch:ProjectionDelta={set:[],unset:[],records:[],append:[]};
  const field=(path:Path,a:any,b:any)=>{if(a===b)return;if(b===undefined){patch.unset.push(path);return;}if(!equal(a,b))patch.set.push({path,value:b});};
  const records=(path:Path,a:any[],b:any[])=>{
    if(a===b)return;
    const scope=scopeOf(path),old=recordIndex(a,scope,item=>keyOf(path,item)),next=recordIndex(b,scope,item=>keyOf(path,item)),put:typeof patch.records[number]['put']=[];
    let reordered=a.length!==b.length;
    for(const [key,index]of next){const position=old.get(key);if(position!==index)reordered=true;if(!equal(position===undefined?undefined:a[position],b[index]))put.push({key,value:b[index]});}
    const remove=reordered?[...old.keys()].filter(key=>!next.has(key)):[],order=reordered?[...next.keys()]:undefined;
    if(put.length||remove.length||order)patch.records.push({path,put,remove,...(order?{order}:{})});
  };
  for(const key of new Set([...Object.keys(before),...Object.keys(after)])){
    if(key==='app')continue;
    if(key==='events'){
      const a=before.events??[],b=after.events??[];
      if(a===b)continue;
      if(b.length>=a.length&&a.every((item:any,index:number)=>item===b[index])){if(b.length>a.length)patch.append.push({path:[key],values:b.slice(a.length)});}
      else records([key],a,b);
    }else if(key==='ratings'||key==='timings'||key==='drafts'){
      if(before[key]===after[key])continue;for(const id of new Set([...Object.keys(before[key]??{}),...Object.keys(after[key]??{})]))field([key,id],before[key]?.[id],after[key]?.[id]);
    }else field([key],before[key],after[key]);
  }
  for(const key of new Set([...Object.keys(before.app??{}),...Object.keys(after.app??{})])){
    if(key==='state')continue;
    if(['activities','maintenanceProgress','questionProgress','readingViews'].includes(key)&&Array.isArray(after.app[key]))records(['app',key],before.app[key]??[],after.app[key]);
    else field(['app',key],before.app?.[key],after.app?.[key]);
  }
  for(const key of new Set([...Object.keys(before.app?.state??{}),...Object.keys(after.app?.state??{})])){
    if((stateCollections as readonly string[]).includes(key)&&Array.isArray(after.app.state[key]))records(['app','state',key],before.app.state[key]??[],after.app.state[key]);
    else field(['app','state',key],before.app?.state?.[key],after.app?.state?.[key]);
  }
  return patch;
}
export function applyProjection<T>(before:T,patch:ProjectionDelta):T{
  let next:any=before;
  const assign=(path:Path,transform:(value:any)=>any,remove=false)=>{
    if(!safe(path))throw Error('宿主增量字段无效');
    const copy=(node:any,index:number):any=>{const clone={...node},key=path[index];if(index===path.length-1){if(remove)delete clone[key];else Object.defineProperty(clone,key,{value:transform(node?.[key]),enumerable:true,writable:true,configurable:true});}else clone[key]=copy(node?.[key],index+1);return clone;};
    next=copy(next,0);
  };
  for(const item of patch.set)assign(item.path,()=>item.value);
  for(const path of patch.unset)assign(path,()=>undefined,true);
  for(const item of patch.append)assign(item.path,value=>[...(value??[]),...item.values]);
  for(const item of patch.records)assign(item.path,(values:any[])=>{
    const scope=scopeOf(item.path),key=(value:any)=>keyOf(item.path,value);
    if(item.put.some(put=>key(put.value)!==put.key))throw Error('宿主增量记录身份无效');
    const records=updateRecordArray(values??[],scope,key,item.put.map(put=>put.value),item.remove);
    if(!item.order)return records;
    const index=recordIndex(records,scope,key);return item.order.map(key=>{const position=index.get(key);if(position===undefined)throw Error('宿主增量记录缺失');return records[position];});
  });
  return next;
}
