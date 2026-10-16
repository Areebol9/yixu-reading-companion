import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createLocalBridge} from '../scripts/local-bridge.mjs';
import {readingRequestPayloadHash} from '../src/core/terminated-reading-continuation.ts';

test('真实本地HTTP尝试finally退出后原queryReceipt可核终止，当前在途/缺证据不放行',async()=>{
 const base=resolve('.local/http-bridge-tests');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'termination-proof-'));assert.equal(resolve(root,'..'),base);await mkdir(join(root,'.local'));
 await writeFile(join(root,'.local/workbench-model-services.json'),JSON.stringify({wechat:{model:'engineering',baseUrl:'https://engineering.invalid/v1',apiKey:'controlled',maxOutput:4096}}));
 let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>entered=r),end=new Promise<void>(r=>release=r);let calls=0;
 const server=createLocalBridge({workspaceRoot:root,fetchImpl:async()=>{calls++;entered();await end;throw Error('Controlled original fetch ended');},logger:()=>{}});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as any).port;
 const post=(route:string,value:unknown)=>fetch(`http://127.0.0.1:${port}/api/${route}`,{method:'POST',headers:{'x-yixu-client':'local-app','Content-Type':'application/json'},body:JSON.stringify(value)});
 const requestId='11111111-1111-4111-8111-111111111111',messages=[{role:'user' as const,content:'技术登记。'}],body={model:'engineering',messages,stream:false,max_tokens:4096};
 try{const pending=post('workbenchModel',{serviceId:'wechat',baseUrl:'https://engineering.invalid/v1',secretRef:'wechat',requestId,body});await ready;assert.equal((await post('workbenchQueryReceipt',{requestId})).status,409);release();assert.equal((await pending).status,500);const result=await post('workbenchQueryReceipt',{requestId});assert.equal(result.status,200);const receipt=await result.json() as any;assert.equal(receipt.requestId,requestId);assert.equal(receipt.inputHash,await readingRequestPayloadHash(messages,[]));assert.equal(receipt.termination.serviceId,'wechat');assert.equal(calls,1);const records=JSON.parse(await readFile(join(root,'.local/workbench-model-requests.json'),'utf8'));assert.equal(records[requestId].status,'unknown');assert.equal(records[requestId].localTermination.kind,'http-fetch-finally-exited');delete records[requestId].localTermination;await writeFile(join(root,'.local/workbench-model-requests.json'),JSON.stringify(records));assert.equal((await post('workbenchQueryReceipt',{requestId})).status,409);}finally{release();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});}
});
