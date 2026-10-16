import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {StringDecoder} from 'node:string_decoder';
import {createWorkbenchBridge,readConfiguration,saveConfigurationSecret,WorkbenchError} from './workbench-bridge.mjs';
import {configureSearch,searchWeb,readWebPage,searchConfig} from './web-access.mjs';
import {dispatchRole,canAdmitDispatch} from './local-reading-admission.mjs';
const MODEL_REQUEST_TIMEOUT_MS=20*60*1000;

const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
export function createLocalBridge({port=Number(process.env.YIXU_PORT??process.env.YIXU_WORKBENCH_PORT??4323),workspaceRoot=process.cwd(),fetchImpl=fetch,logger=console.log}={}){
const configFile=resolve(workspaceRoot,'.local/model-services.json'),root=resolve(workspaceRoot,'dist'),active=new Map(),workbench=createWorkbenchBridge(workspaceRoot);
const config=()=>readConfiguration(configFile);
const devPort=Number(process.env.YIXU_DEV_PORT??5174);
if(!Number.isSafeInteger(devPort)||devPort<1024||devPort>65535)throw Error('YIXU_DEV_PORT应为1024至65535之间的本地端口');
const server=http.createServer(async(req,res)=>{
 let modelRequest=false,modelDispatchStarted=false,modelRequestId,workbenchRequest=false;
 try {
  const port=server.address()?.port;
  const allowedHosts=new Set([`127.0.0.1:${port}`,`127.0.0.1:${devPort}`,`localhost:${devPort}`]);
  const allowedOrigins=new Set([...allowedHosts].map(host=>'http://'+host));
  if(!allowedHosts.has(req.headers.host)) return json(res,403,{error:'本地访问来源不符'});
  if(req.headers.origin && !allowedOrigins.has(req.headers.origin)) return json(res,403,{error:'只接受本机客户端请求'});
  const url=new URL(req.url,'http://127.0.0.1');
  modelRequest=['/api/model','/api/workbenchModel'].includes(url.pathname);workbenchRequest=url.pathname==='/api/workbenchModel';
  if(url.pathname.startsWith('/api/')) {
   if(req.method!=='POST'||req.headers['x-yixu-client']!=='local-app'||!String(req.headers['content-type']).startsWith('application/json'))return json(res,403,{error:'请求类型不符'});
   // HTTP chunks may end inside a UTF-8 character. Count transport bytes
   // separately; the existing request limit remains decoded UTF-16 length.
   const decoder=new StringDecoder('utf8');let text='',requestUtf8Bytes=0;
   for await(const part of req){requestUtf8Bytes+=part.length;text+=decoder.write(part);if(text.length>1_500_000)return json(res,413,{error:'请求过大'});}
   text+=decoder.end();if(text.length>1_500_000)return json(res,413,{error:'请求过大'});
   const input=JSON.parse(text||'{}'), method=url.pathname.slice(5);
   if(!input||typeof input!=='object'||Array.isArray(input))return json(res,400,{error:'请求内容应为JSON对象'});
   if(method==='workbenchServices')return json(res,200,await workbench.services());
   if(method==='workbenchUseService')return json(res,200,await workbench.useService(input));
   if(method==='workbenchSaveSecret')return json(res,200,await workbench.saveSecret(input));
   if(method==='workbenchSources')return json(res,200,await workbench.sources(input));
   if(method==='workbenchSource')return json(res,200,await workbench.source(input));
   if(method==='workbenchQueryReceipt'){if(active.has(input.requestId))throw new WorkbenchError('原请求仍在当前宿主处理中，未出具终止证明',409);return json(res,200,await workbench.queryReceipt(input));}
   const services=await (workbenchRequest?workbench.configuration():config());
   if(method==='services')return json(res,200,Object.entries(services).map(([id,v])=>({id,baseUrl:v.baseUrl,model:v.model,contextLimit:v.contextLimit,hasKey:!!v.apiKey})));
   if(modelRequest){
    modelRequestId=typeof input.requestId==='string'&&/^[0-9a-f-]{36}$/i.test(input.requestId)?input.requestId:randomUUID();
    const rejectModel=(status,error,retryable=false)=>json(res,status,{error,dispatch:'not-dispatched',requestId:modelRequestId,retryable});
    let role;try{role=dispatchRole(input.dispatchRole);}catch{return rejectModel(400,'模型派发角色无效');}
    const service=Object.hasOwn(services,input.serviceId)?services[input.serviceId]:undefined;
    if(!service?.apiKey || service.baseUrl!==input.baseUrl)return rejectModel(400,'渠道与已授权配置不一致');
    const body=input.body;
    if(!Array.isArray(body?.messages)||body.model!==service.model)return rejectModel(400,'模型与本地配置不一致');
    const bytes=Buffer.byteLength(JSON.stringify(body),'utf8');
    if(bytes+Number(body.max_tokens||0)+2048>service.contextLimit)return rejectModel(413,'超过渠道上下文边界');
    if(!Number.isSafeInteger(body.max_tokens)||body.max_tokens<256||body.max_tokens>16384)return rejectModel(400,'输出预算无效');
    if(workbenchRequest&&body.max_tokens>(service.maxOutput??4096))return rejectModel(400,'超过测试服务的单次输出限制');
    if(active.has(modelRequestId))return rejectModel(409,'原请求仍在处理，未重复派发');
    if(!canAdmitDispatch([...active.values()],role))return rejectModel(429,'已有模型请求正在处理',true);
    const controller=new AbortController(), callId=modelRequestId;active.set(callId,role);
    const timer=setTimeout(()=>controller.abort(),MODEL_REQUEST_TIMEOUT_MS);
    res.on('close',()=>{if(!res.writableEnded)controller.abort();});
    try{
     const started=Date.now();
     if(workbenchRequest)await workbench.reserveRequest(modelRequestId,input.serviceId,body);
     modelDispatchStarted=true;
     logger(JSON.stringify({callId,stage:'dispatch-started',service:input.serviceId,scope:workbenchRequest?'workbench':'shared',requestUtf8Bytes,requestUtf16Chars:text.length}));
     const upstream=await fetchImpl(service.baseUrl.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+service.apiKey},body:JSON.stringify(body),redirect:'error',signal:controller.signal});
     const result=await upstream.json();
     // Response is delivered to the local application only. No prompts, keys or reasoning are logged.
     if(workbenchRequest)await workbench.finishRequest(callId,'returned');
     logger(JSON.stringify({callId,stage:'response-received',service:input.serviceId,status:upstream.status,elapsedMs:Date.now()-started,input:result.usage?.prompt_tokens,output:result.usage?.completion_tokens}));
     if(!res.destroyed)json(res,200,{status:upstream.status,body:result});
    }finally{clearTimeout(timer);active.delete(callId);}return;
   }
   if(method==='saveSecret'){
    return json(res,200,await saveConfigurationSecret(configFile,input));
   }
   if(method==='exportSecrets'){
    if(input.includeKeys!==true)return json(res,400,{error:'需明确选择携带密钥'});
    const result=Object.fromEntries(Object.entries(services).map(([id,v])=>[id,v.apiKey])),search=await searchConfig();
    if(search?.apiKey)result.search=search.apiKey;return json(res,200,result);
   }
   if(method==='configureSearch')return json(res,200,await configureSearch(input));
   if(method==='search'||method==='readPage'){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
    res.on('close',()=>{if(!res.writableEnded)controller.abort();});
    try{return json(res,200,await (method==='search'?searchWeb(input,controller.signal):readWebPage(input,controller.signal)));}finally{clearTimeout(timer);}
   }
   return json(res,400,{error:'当前浏览器入口不提供此设备能力'});
  }
  if(req.method!=='GET')return json(res,405,{error:'不支持此请求'});
  const relative=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname), path=resolve(root,'.'+relative);
  if(!path.startsWith(root+sep))return json(res,403,{error:'路径不符'});
  const body=await readFile(path);
  res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'})[extname(path)]||'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});res.end(body);
 } catch(error) {
  if(error.modelReceiptPending)return json(res,error.status??409,{modelReceiptPending:error.modelReceiptPending});
  if(modelRequest){
   if(workbenchRequest&&modelDispatchStarted)try{await workbench.finishRequest(modelRequestId,'unknown',{kind:'http-fetch-finally-exited'});}catch{}
   logger(JSON.stringify({callId:modelRequestId,stage:modelDispatchStarted?'unknown':'not-dispatched'}));
   if(!res.headersSent&&!res.destroyed)json(res,!modelDispatchStarted&&error instanceof WorkbenchError?error.status:500,{error:modelDispatchStarted?'模型请求的结果或结算尚未确定，已停止自动重问':error instanceof WorkbenchError?error.message:'模型请求未发出，请检查本地服务配置',dispatch:modelDispatchStarted?'unknown':'not-dispatched',requestId:modelRequestId});
   return;
  }
  if(error instanceof WorkbenchError)return json(res,error.status,{error:error.message});
  const networkFailure=error?.name==='AbortError'||error?.name==='TimeoutError'||error?.name==='TypeError'&&error?.cause;
  if(!res.headersSent&&!res.destroyed)json(res,500,{error:networkFailure?'网络请求中断或超时，已保留任务':'本地服务处理失败，请检查配置与构建结果',retryable:!!networkFailure});
 }
});
return server;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const port=Number(process.env.YIXU_PORT??process.env.YIXU_WORKBENCH_PORT??4323);
 if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('YIXU_PORT应为1024至65535之间的本地端口');
 createLocalBridge({port}).listen(port,'127.0.0.1',()=>console.log(`宜序伴读本地入口 http://127.0.0.1:${port}`));
}
