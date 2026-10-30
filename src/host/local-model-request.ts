import {LocalModelStreamDecoder} from '../core/provider-stream.ts';
import type {ModelStreamObserver} from '../core/provider-stream.ts';
import {request} from 'node:http';

/** The local model gateway owns its existing collection deadline. Keep this
 * transport on the caller's AbortSignal, without fetch's hidden headers timer. */
export function postLocalModelJson(url:URL,input:unknown,signal?:AbortSignal,onStream?:ModelStreamObserver):Promise<{ok:boolean;status:number;value:unknown}>{
  if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.username||url.password)throw Error('模型桥仅访问本机HTTP入口');
  signal?.throwIfAborted();const body=JSON.stringify(input);
  return new Promise((resolve,reject)=>{
    const operation=request(url,{method:'POST',agent:false,signal,headers:{'Content-Type':'application/json','X-Yixu-Client':'local-app','Content-Length':Buffer.byteLength(body)}},response=>{
      const chunks:Buffer[]=[],stream=String(response.headers['content-type']).includes('application/x-ndjson')?new LocalModelStreamDecoder(onStream):undefined;
      response.on('data',(chunk:Buffer)=>{try{if(stream)stream.push(chunk);else chunks.push(chunk);}catch(error){response.destroy(error as Error);reject(error);}});response.once('error',reject);
      response.once('aborted',()=>reject(Error('本机模型流式响应中断，原请求结果未知')));
      response.once('end',()=>{try{if(stream){resolve(stream.end());return;}const status=response.statusCode??0;resolve({ok:status>=200&&status<300,status,value:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}catch(error){reject(error);}});
    });
    operation.once('error',reject);
    // No independent inactivity/headers deadline: the existing native gateway
    // deadline and this exact caller signal remain the cancellation authority.
    operation.setTimeout(0);operation.end(body);
  });
}
