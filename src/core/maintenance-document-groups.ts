import {hashText} from './text-hash.ts';

const textFields=new Set(['text','oldText','newText','appendText','documentTitle','updateReason','reviewReason','description','title']);
/** tN is a proposal reference only in structural fields, never prose. */
export function mapDocumentHandles<T>(value:T,bindings:ReadonlyMap<string,string>,field=''):T{
  if(textFields.has(field))return value;
  if(typeof value==='string')return (bindings.get(value)??value) as T;
  if(Array.isArray(value))return value.map(item=>mapDocumentHandles(item,bindings,field)) as T;
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,mapDocumentHandles(item,bindings,key)])) as T;
  return value;
}
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value;
export const maintenanceDocumentHash=(document:unknown)=>hashText(JSON.stringify(canonical(document)));

export function maintenanceDocumentGroups(documents:readonly unknown[],workspace?:{working?:unknown;understanding?:unknown;focus?:unknown}):number[][]{
  const parents=documents.map((_,index)=>index),root=(index:number):number=>parents[index]===index?index:parents[index]=root(parents[index]);
  const join=(a:number,b:number)=>{parents[root(b)]=root(a);};
  const owners=new Map<string,number>();
  const inspect=(value:unknown,index:number,field='')=>{
    if(textFields.has(field))return;
    if(typeof value==='string'&&/^t[1-9]\d*$/u.test(value)){const target=Number(value.slice(1))-1;if(target<documents.length)join(index,target);return;}
    if(Array.isArray(value)){value.forEach(item=>inspect(item,index,field));return;}
    if(value&&typeof value==='object')for(const [key,item]of Object.entries(value))inspect(item,index,key);
  };
  documents.forEach((document,index)=>{
    inspect(document,index);
    if(!document||typeof document!=='object'||Array.isArray(document))return;
    const value=document as Record<string,any>,targets=[value.updates,...(Array.isArray(value.mergePreviousIds)?value.mergePreviousIds:[])].filter((id):id is string=>typeof id==='string');
    const subject=value.organization?.subject;
    if(subject?.key)targets.push('subject:'+JSON.stringify([subject.kind??'',subject.key]));
    for(const target of targets){const prior=owners.get(target);if(prior===undefined)owners.set(target,index);else join(prior,index);}
  });
  // Moving the current entry away from a retired/merged document belongs to
  // the same atomic operation, including newly authored replacement entries.
  const lifecycle=documents.flatMap((document,index)=>document&&typeof document==='object'&&['retire','merge','restore'].includes(String((document as {operation?:unknown}).operation))?[index]:[]);
  if(lifecycle.length&&workspace)for(const index of lifecycle)inspect(workspace,index);
  const groups=new Map<number,number[]>();documents.forEach((_,index)=>{const key=root(index),group=groups.get(key)??[];group.push(index);groups.set(key,group);});return[...groups.values()];
}
