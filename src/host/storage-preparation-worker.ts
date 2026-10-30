import {parentPort,workerData} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {prepareContent,type PreparedContent,type ContentPreparationCache} from './content-objects.ts';
import {ReceiptTexts} from './stored-text.ts';
import {prepareStorageChanges} from '../core/storage-records.ts';
import {stateCollections,stateRecordKey,type StateChangeSet} from '../core/types.ts';

const receipts=workerData.receiptDirectory?new ReceiptTexts(workerData.receiptDirectory):undefined;
parentPort!.on('message',async({id,input,values}:{id:number;input?:StateChangeSet;values?:unknown[]})=>{
  try{
    if(values){parentPort!.postMessage({id,result:values.map(value=>prepareContent(value,receipts))});return;}
    const changes=await prepareStorageChanges(input!),encoded:{key:string;content:PreparedContent}[]=[],objects=new Map(),cache:ContentPreparationCache=new WeakMap();
    const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
    for(const [bucket,bodies]of [['memoryBodies',changes.memoryBodies??[]],['taskMaterials',changes.taskMaterials??[]]] as const){
      for(const body of bodies){const hash=digest(bucket==='memoryBodies'?(body as any).text:JSON.stringify((body as any).value));if(body.hash!==hash||body.key!==(bucket==='memoryBodies'?'memory-body-':'task-material-')+hash)throw Error('不可变正文对象校验失败');encoded.push({key:bucket+':'+body.key,content:prepareContent(body,receipts)});}
    }
    for(const name of stateCollections)for(const value of changes.collections[name]?.put??[]){const key=stateRecordKey(name,value as never);if(!key)throw Error('实体存储身份缺失');encoded.push({key:'entity:'+name+':'+key,content:prepareContent(value,receipts,cache)});}
    for(const value of encoded)for(const object of value.content.objects)objects.set(object.hash,object);
    const immutable=[];for(const name of ['memories','publishedViews'] as const)for(const value of changes.collections[name]?.put??[])immutable.push({identity:name+':'+stateRecordKey(name,value as never),hash:name==='memories'?(value as any).bodyRef.hash:digest((value as any).text)});
    const bodies=[...changes.memoryBodies??[]].map(body=>({bucket:'memoryBodies',key:body.key,hash:body.hash})).concat((changes.taskMaterials??[]).map(body=>({bucket:'taskMaterials',key:body.key,hash:body.hash})));
    const {memoryBodies,taskMaterials,...metadata}=changes;
    parentPort!.postMessage({id,result:{changes:metadata,encoded:encoded.map(({key,content})=>[key,content.json]),objects:[...objects.values()],bodies,immutable}});
  }catch(error){parentPort!.postMessage({id,error:error instanceof Error?error.message:String(error)});}
});
