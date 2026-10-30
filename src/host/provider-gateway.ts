import {Worker} from 'node:worker_threads';
import type {ModelStreamObserver} from '../core/provider-stream.ts';
import {ModelReceiptSaveError,modelEnvelopeError} from '../core/errors.ts';
import {ModelOutputError} from '../core/model.ts';
import {postLocalModelJson} from './local-model-request.ts';

/** Provider I/O and its existing receipt ledger run apart from reading/UI work.
 * The HTTP contract, archive environment and immutable originals stay unchanged. */
export async function providerBridge(){
  const worker=new Worker(new URL('./provider-gateway-worker.mjs',import.meta.url));
  let failure:Error|undefined,closing:Promise<void>|undefined,closed=false,closeResolve:(()=>void)|undefined,closeReject:((error:Error)=>void)|undefined;
  let readyResolve!:(port:number)=>void,readyReject!:(error:Error)=>void;
  const ready=new Promise<number>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const fail=(error:Error)=>{failure=error;readyReject(error);closeReject?.(error);};
  worker.on('error',fail);
  worker.on('exit',code=>{if(!closed)fail(Error(`模型接收线程已退出（${code}），原请求记录保留。`));});
  worker.on('message',(message:{type:string;port?:number;message?:string})=>{
    if(message.type==='ready'&&message.port!==undefined&&Number.isSafeInteger(message.port)&&message.port>0)readyResolve(message.port);
    else if(message.type==='closed'){closed=true;closeResolve?.();}
    else if(message.type==='close-error'){closeReject?.(Error(message.message??'模型接收线程尚未正常关闭'));closing=undefined;}
    else if(message.type==='failed')fail(Error(message.message??'模型接收线程未能启动'));
  });
  const port=await ready;
  const request=async<T>(method:string,input:unknown={},signal?:AbortSignal,onStream?:ModelStreamObserver):Promise<T>=>{
    if(failure)throw failure;if(closing||closed)throw Error('模型接收入口正在关闭');
    const response=await postLocalModelJson(new URL(`http://127.0.0.1:${port}/api/${method}`),input,signal,onStream);
    const value=response.value as Parameters<typeof modelEnvelopeError>[0]&{modelReceiptPending?:{message:string;response:ConstructorParameters<typeof ModelReceiptSaveError>[1]};modelOutputError?:{message:string;response:ConstructorParameters<typeof ModelOutputError>[1];reason:ConstructorParameters<typeof ModelOutputError>[2];outcome:ConstructorParameters<typeof ModelOutputError>[3]}};
    if(value?.modelReceiptPending)throw new ModelReceiptSaveError(value.modelReceiptPending.message,value.modelReceiptPending.response);
    if(!response.ok){if(method==='workbenchModel')throw modelEnvelopeError(value);throw Error(value.error??'本机服务请求未完成');}
    if(method==='workbenchModel'&&value?.modelOutputError)throw new ModelOutputError(value.modelOutputError.message,value.modelOutputError.response,value.modelOutputError.reason,value.modelOutputError.outcome);
    return value as T;
  };
  return{request,close:()=>{
    if(closed)return Promise.resolve();if(failure)return Promise.reject(failure);
    return closing??=(new Promise<void>((resolve,reject)=>{closeResolve=resolve;closeReject=reject;worker.postMessage({type:'close'});}));
  }};
}
