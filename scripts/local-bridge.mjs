import {ProviderSseDecoder} from '../src/core/provider-stream.ts';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {StringDecoder} from 'node:string_decoder';
import {configureSearch,searchWeb,readWebPage,searchConfig} from './web-access.mjs';
import {dispatchRole,canAdmitDispatch} from './local-reading-admission.mjs';
import {validateProviderCapabilities} from '../src/core/provider-capabilities.ts';
import {parseNativeToolResponse,ModelOutputError} from '../src/core/model.ts';
import {modelRequestParameters} from '../src/core/model-parameters.ts';
import {isDeepStrictEqual} from 'node:util';
import {performance} from 'node:perf_hooks';
import {isMainThread} from 'node:worker_threads';

// The public runtime never loads research carriers, frozen experiments or sources.
const clientMode=process.env.YIXU_DESKTOP==='1';
const bridgeModule=await (clientMode?import('./client-bridge.mjs'):import('./workbench-bridge.mjs'));
const {readConfiguration,saveConfigurationSecret,WorkbenchError}=bridgeModule;
const createBridge=clientMode?bridgeModule.createClientBridge:bridgeModule.createWorkbenchBridge;
const researchHttp=clientMode?undefined:await import('./workbench-automation/fresh-http.mjs');
const nativeReader=clientMode?undefined:await import('./workbench-native-reader.mjs');
const freshHttpSchema=researchHttp?.freshHttpSchema,nativeReaderId=nativeReader?.nativeReaderId;
const isFreshHttpError=error=>!!researchHttp&&error instanceof researchHttp.FreshHttpError;
const MODEL_REQUEST_TIMEOUT_MS=20*60*1000;

const json=(res,status,value)=>{if(res.yixuStreaming){if(!res.destroyed&&!res.writableEnded)res.end(JSON.stringify({type:'result',status,body:value})+'\n');return;}res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
const beginStream=res=>{res.yixuStreaming=true;res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Accel-Buffering':'no'});res.flushHeaders();};
export function safeModelFailure(error,stage){
 const trusted=error instanceof WorkbenchError||isFreshHttpError(error);
 const status=Number.isInteger(error?.status)&&error.status>=400&&error.status<=599?error.status:500;
 const systemCode=['ENOENT','EACCES','EPERM','EIO','ENOSPC','EMFILE','ENFILE','EBUSY'].includes(error?.code)?error.code:undefined;
 const failure=trusted&&error.failure?structuredClone(error.failure):{category:trusted?'configuration':'internal',code:systemCode??(trusted?'WORKBENCH_REQUEST_REJECTED':'LOCAL_INTERNAL_ERROR'),status,stage,recovery:'explicit',...(['Error','SyntaxError','TypeError','RangeError'].includes(error?.name)?{errorName:error.name}:{})};
 const labels={budget:'本轮HTTP总预算已用尽，原账和任务保持；请处理原预算条件后显式接续',concurrency:'HTTP并发名额暂被占用，等待所列原请求收妥后接续',lock:'HTTP账本锁暂被占用，原请求未派发；锁释放后可显式接续',configuration:'本轮HTTP冻结条件校验未通过，请核对原条件后显式接续',integrity:'原HTTP请求或回执完整性校验未通过，原记录和费用保持',authentication:'本轮HTTP认证不可用，请恢复原认证后显式接续',internal:'本地内部处理失败，模型请求未发出；原任务已保留'};
 return{status,error:isFreshHttpError(error)?labels[failure.category]:trusted?error.message:labels.internal,failure,retryable:false};
}
// Names/codes only: exception messages may contain URLs, private input or keys.
export function transportFailure(error){
 const code=value=>typeof value==='string'&&/^[a-zA-Z0-9_]{1,80}$/.test(value)?value:undefined;
 return{errorName:code(error?.name),errorCode:code(error?.code),causeName:code(error?.cause?.name),causeCode:code(error?.cause?.code)};
}
export function createLocalBridge({port=4318,workspaceRoot=process.cwd(),distRoot,defaultDocument='index.html',fetchImpl=fetch,logger=console.log,bridgeFactory=createBridge}={}){
const configFile=resolve(workspaceRoot,clientMode?(process.env.YIXU_CLIENT_DATA_ROOT??'.local/client-data'):'.local','model-services.json'),root=resolve(workspaceRoot,distRoot??'dist'),active=new Map(),workbench=bridgeFactory(workspaceRoot);
const config=()=>readConfiguration(configFile);
const server=http.createServer(async(req,res)=>{
 let modelRequest=false,modelDispatchStarted=false,modelRequestId,modelStage='request-validation',workbenchRequest=false,nativeRequest=false,nativeInvoked=false;
 try {
  const port=server.address()?.port;
  const allowedOrigins=new Set([`http://127.0.0.1:${port}`,'http://127.0.0.1:5173','http://localhost:5173']);
  if(!['127.0.0.1:'+port,'127.0.0.1:5173','localhost:5173'].includes(req.headers.host)) return json(res,403,{error:'本地访问来源不符'});
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
   if(modelRequest)modelRequestId=typeof input.requestId==='string'&&/^[0-9a-f-]{36}$/i.test(input.requestId)?input.requestId:randomUUID();
   modelStage='configuration-read';
   const isolated=await workbench.nativeConfiguration();
   if(isolated&&[freshHttpSchema,'workbench-native-reader/fresh-test-v1'].includes(isolated.schema)&&['model','services','saveSecret','exportSecrets','configureSearch','search','readPage'].includes(method))return json(res,403,{error:'独立测试仅使用冻结的私有服务与来源',...(modelRequest?{dispatch:'not-dispatched',requestId:input.requestId}:{})});
   if(method==='companionConnection'){
    try{return json(res,200,await workbench.companionConnection(input,req.headers.origin??`http://127.0.0.1:${port}`));}
    catch(error){logger(JSON.stringify({component:'companionConnection',action:input.action,error:String(error)}));return json(res,error.status??500,{error:error instanceof Error?error.message:'当前存档宿主连接未完成'});}
   }
   if(method==='workbenchServices')return json(res,200,await workbench.services());
   if(method==='workbenchBudget')return json(res,200,await workbench.budget(input));
   if(method==='workbenchUpdateBudget')return json(res,200,await workbench.updateBudget(input));
   if(method==='workbenchUseService')return json(res,200,await workbench.useService(input));
   if(method==='workbenchBindService'){if(!workbench.bindService)throw new WorkbenchError('当前研究渠道不支持创建伙伴独立模型绑定',409);return json(res,200,await workbench.bindService(input));}
   if(method==='workbenchSaveSecret')return json(res,200,await workbench.saveSecret(input));
   if(method==='workbenchSources')return json(res,200,await workbench.sources(input));
   if(method==='workbenchSource')return json(res,200,await workbench.source(input));
   if(method==='workbenchCloseAttempt')return json(res,200,await workbench.closeAttempt(input,{isActive:id=>active.has(id)}));
   if(method==='workbenchQueryReceipt'){if(active.has(input.requestId))throw new WorkbenchError('原请求仍在当前宿主处理中，未出具终止证明',409);return json(res,200,await workbench.queryReceipt(input));}
   const services=await (workbenchRequest?workbench.configuration():config());
   if(method==='services')return json(res,200,Object.entries(services).map(([id,v])=>({id,baseUrl:v.baseUrl,model:v.model,contextLimit:v.contextLimit,hasKey:!!v.apiKey})));
   if(modelRequest){
    modelRequestId=typeof input.requestId==='string'&&/^[0-9a-f-]{36}$/i.test(input.requestId)?input.requestId:randomUUID();
    modelStage='request-validation';
    const rejectModel=(status,error,retryable=false)=>json(res,status,{error,dispatch:'not-dispatched',requestId:modelRequestId,retryable:false,failure:{category:retryable?'concurrency':'configuration',code:retryable?'LOCAL_CONCURRENCY_BUSY':'LOCAL_REQUEST_REJECTED',status,stage:'request-validation',recovery:retryable?'condition-change':'explicit',...(retryable?{blockerRequestIds:[...active.keys()]}:{})}});
    try{await workbench.assertRequestOpen(modelRequestId);}catch(error){if(error.code==='LOCAL_ATTEMPT_CLOSED')return json(res,409,{error:'原本地尝试已封闭，历史结果与费用仍未知；请读取原证明',dispatch:'unknown',requestId:modelRequestId,retryable:false});throw error;}
    let role;try{role=dispatchRole(input.dispatchRole);}catch{return rejectModel(400,'模型派发角色无效');}
    const service=Object.hasOwn(services,input.serviceId)?services[input.serviceId]:undefined;
    const subagent=workbenchRequest&&workbench.subagentConfiguration?await workbench.subagentConfiguration():undefined;
    if(subagent&&service?.subagentTestSource===subagent.service.id){
     if(service.baseUrl!==subagent.service.baseUrl||service.model!==subagent.service.model||input.baseUrl!==service.baseUrl||input.body?.model!==service.model||!Array.isArray(input.body?.messages))return rejectModel(400,'请求与本机子代理渠道身份不符');
     const body=input.body,parameters=modelRequestParameters({...service,id:input.serviceId});
     if(['thinking','reasoning_effort','temperature','top_p'].some(key=>!isDeepStrictEqual(body[key],parameters[key])))return rejectModel(400,'子代理请求参数与独立绑定不一致');
     if(!Number.isSafeInteger(body.max_tokens)||body.max_tokens<256||body.max_tokens>service.maxOutput)return rejectModel(400,'子代理输出额度与独立绑定不一致');
     const contract=await workbench.validateHttpRequest({...service,id:input.serviceId},body,input.businessPayload);
     if(active.has(modelRequestId))return rejectModel(409,'原请求仍在处理，未重复派发');
     if(!canAdmitDispatch([...active.values()],role))return rejectModel(429,'已有模型请求正在处理',true);
     const controller=new AbortController(),started=Date.now();active.set(modelRequestId,role);res.on('close',()=>{if(!res.writableEnded)controller.abort();});
     try{
      // Existing archive journal owns request admission, payload and original reply.
      // The queue is one immutable carrier, never a second business controller.
      await workbench.reserveRequest(modelRequestId,input.serviceId,body,{businessPayload:contract.payload});
      const {invokeSubagent}=await import('./subagent-test-transport.mjs');
      const result=await invokeSubagent({...subagent,service:{...service,id:input.serviceId}},{...input,requestId:modelRequestId,businessPayload:contract.payload},controller.signal,{onDispatched:()=>{modelDispatchStarted=true;logger(JSON.stringify({callId:modelRequestId,stage:'subagent-test-queued',service:input.serviceId,model:service.model,requestedEffort:service.effort,actualExecutorEffort:subagent.actualExecutorEffort,actualUsage:null}));}});
      await workbench.finishHttpRequest(modelRequestId,{service:{...service,id:input.serviceId},...contract,status:result.status,response:result.body,headers:result.headers,elapsedMs:Date.now()-started,transport:{kind:'subagent-test',actualExecutorEffort:subagent.actualExecutorEffort,actualUsage:null,nativeCLIReceipt:false}});
      if(!res.destroyed)json(res,200,result);
     }finally{
      try{if(modelDispatchStarted)await workbench.finishRequest(modelRequestId,'unknown',{kind:'http-fetch-finally-exited',transport:{kind:'subagent-test',actualUsage:null}});}
      finally{active.delete(modelRequestId);}
     }
     return;
    }
    if(nativeReader&&workbenchRequest&&input.serviceId===nativeReaderId){
     nativeRequest=true;
     const native=await workbench.nativeConfiguration(),controller=new AbortController();
     if(!native?.authenticated)return rejectModel(503,'本机 Luna 阅读认证不可用');
     if(input.baseUrl!==native.service.baseUrl||input.body?.model!==native.service.model||!Array.isArray(input.body?.messages))return rejectModel(400,'请求与本机 Luna High 服务不符');
     const nativeBody=input.body;
     if(!Number.isSafeInteger(nativeBody.max_tokens)||nativeBody.max_tokens<256||nativeBody.max_tokens>native.service.maxOutput)return rejectModel(400,'输出预算与本机服务不符');
     if(active.has(modelRequestId))return rejectModel(409,'原请求仍在处理，未重复派发');
     if(!canAdmitDispatch([...active.values()],role))return rejectModel(429,'已有模型请求正在处理',true);
     active.set(modelRequestId,role);res.on('close',()=>{if(!res.writableEnded)controller.abort();});
     const started=Date.now();
     try{
      await workbench.reserveRequest(modelRequestId,input.serviceId,nativeBody);
      logger(JSON.stringify({callId:modelRequestId,stage:'host-admission',service:input.serviceId,model:native.service.model,effort:native.service.effort,scope:'workbench-original-budget',requestUtf8Bytes,requestUtf16Chars:text.length}));
      nativeInvoked=true;const result=await nativeReader.invokeNativeReader(native,{...input,requestId:modelRequestId},controller.signal);
      await workbench.finishRequest(modelRequestId);
      logger(JSON.stringify({callId:modelRequestId,stage:'response-received',service:input.serviceId,elapsedMs:Date.now()-started,input:result.body.usage.prompt_tokens,output:result.body.usage.completion_tokens}));
      if(!res.destroyed)json(res,200,result);
     }catch(error){
      const outcome=await workbench.nativeOutcome(modelRequestId);await workbench.finishRequest(modelRequestId);
      const delivery=nativeReader.nativeOutcomeEnvelope(native,modelRequestId,outcome,nativeBody.tools?.length?'completeTools':'complete',Date.now()-started,error);
      logger(JSON.stringify({callId:modelRequestId,stage:outcome.kind,service:input.serviceId}));if(!res.destroyed)json(res,delivery.status,delivery.body);
     }finally{active.delete(modelRequestId);}return;
    }
    if(!service?.apiKey || service.baseUrl!==input.baseUrl)return rejectModel(400,'渠道与已授权配置不一致');
    const body=input.body;
    if(!Array.isArray(body?.messages)||body.model!==service.model)return rejectModel(400,'模型与本地配置不一致');
    const parameters=modelRequestParameters({...service,id:input.serviceId,effort:service.effort??'high'});
    if(service.binding&&['thinking','reasoning_effort','temperature','top_p'].some(key=>!isDeepStrictEqual(body[key],parameters[key])))return rejectModel(400,'请求参数与已保存的独立模型配置不一致');
    if(!Number.isSafeInteger(body.max_tokens)||body.max_tokens<256||body.max_tokens>(service.maxOutput??16384))return rejectModel(400,'输出预算无效');
    if(workbenchRequest&&body.max_tokens>(service.maxOutput??4096))return rejectModel(400,'超过测试服务的单次输出限制');
    if(service.providerCapabilities)try{validateProviderCapabilities(service.providerCapabilities,{...service,maxOutput:body.max_tokens});if(service.providerCapabilities.transport!=='native-http')return rejectModel(400,'HTTP入口不接收CLI文本渠道，未回退');}catch(error){return rejectModel(400,error.message);}
    const httpContract=await workbench.validateHttpRequest({...service,id:input.serviceId},body,input.businessPayload);
    if(active.has(modelRequestId))return rejectModel(409,'原请求仍在处理，未重复派发');
    if(!canAdmitDispatch([...active.values()],role))return rejectModel(429,'已有模型请求正在处理',true);
    const controller=new AbortController(), callId=modelRequestId;active.set(callId,role);
    const transport={startedAt:Date.now(),receivedBytes:0,stage:'admission',state:'active'};
    const loopStart=performance.eventLoopUtilization();
    let decodeMs=0,forwardMs=0,fragments=0,peakQueuedBytes=0;
    const recordProcessing=()=>{const loop=performance.eventLoopUtilization(loopStart);transport.processing={thread:isMainThread?'main':'provider-worker',eventLoopActiveMs:loop.active,eventLoopIdleMs:loop.idle,eventLoopUtilization:loop.utilization,decodeMs,forwardMs,fragments,peakQueuedBytes};};
    const abort=source=>{if(!controller.signal.aborted){transport.abortSource=source;controller.abort();}};
    const timer=setTimeout(()=>abort('local-timeout'),MODEL_REQUEST_TIMEOUT_MS);
    res.on('close',()=>{if(!res.writableEnded)abort('client-connection-closed');});
    try{
     const started=Date.now();
     if(workbenchRequest){modelStage='ledger-admission';await workbench.reserveRequest(modelRequestId,input.serviceId,body,{businessPayload:httpContract.payload,dispatchRole:role});}
     modelDispatchStarted=true;
     transport.stage='fetch';transport.dispatchAt=Date.now();
     logger(JSON.stringify({callId,stage:'dispatch-started',service:input.serviceId,scope:workbenchRequest?'workbench':'shared',requestUtf8Bytes,requestUtf16Chars:text.length}));
     const upstream=await fetchImpl(service.baseUrl.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+service.apiKey},body:JSON.stringify(body),redirect:'error',signal:controller.signal});
     transport.headersAt=Date.now();transport.httpStatus=upstream.status;transport.stage='body';
     let rawBody,rawBodyHash,result;
     const isStream=upstream.status>=200&&upstream.status<300&&upstream.headers?.get('content-type')?.includes('text/event-stream');
     if(isStream){
      if(body.stream!==true||!upstream.body)throw Error('提供方流式载体与请求不符');
      beginStream(res);
      const decoder=new ProviderSseDecoder(delta=>{const begin=performance.now(),field=delta.type==='reasoning'?'firstReasoningAt':delta.type==='text'?'firstTextAt':'firstToolFragmentAt';transport[field]??=Date.now();fragments++;if(!res.destroyed){res.write(JSON.stringify({type:'delta',delta})+'\n');peakQueuedBytes=Math.max(peakQueuedBytes,res.writableLength);}forwardMs+=performance.now()-begin;});
      const wireHash=createHash('sha256'),wireParts=[];
      try{
       for await(const part of upstream.body){const bytes=Buffer.from(part);transport.firstByteAt??=Date.now();transport.lastByteAt=Date.now();transport.receivedBytes+=bytes.length;wireParts.push(bytes);wireHash.update(bytes);const begin=performance.now(),forwardBefore=forwardMs;decoder.push(bytes);decodeMs+=performance.now()-begin-(forwardMs-forwardBefore);}
       transport.stage='stream-terminal';result=decoder.end();rawBody=decoder.rawBody;rawBodyHash=wireHash.digest('hex');Object.assign(transport,decoder.terminalState,{completeStream:true});
      }catch(error){
       rawBody=decoder.rawBody;rawBodyHash=wireHash.digest('hex');
       Object.assign(transport,transportFailure(error),decoder.terminalState,{state:'interrupted',endedAt:Date.now()});
       recordProcessing();
       // Partial bytes are retained as unknown evidence, never as a model answer.
       const wire=createHash('sha256').update(rawBody,'utf8').digest('hex')===rawBodyHash?{rawBody,rawBodyHash}:{rawBodyBase64:Buffer.concat(wireParts).toString('base64'),rawBodyHash};
       if(workbenchRequest)try{await workbench.finishHttpRequest(callId,{service:{...service,id:input.serviceId},...httpContract,status:upstream.status,response:undefined,...wire,transport,elapsedMs:Date.now()-started,headers:{'content-type':upstream.headers.get('content-type')}});}catch(saveError){logger(JSON.stringify({callId,stage:'partial-receipt-save-failed',failure:safeModelFailure(saveError,'ledger-write').failure}));}
       throw error;
      }
     }else if(typeof upstream.arrayBuffer==='function'){
      const responseBytes=Buffer.from(await upstream.arrayBuffer());transport.lastByteAt=Date.now();transport.receivedBytes=responseBytes.length;rawBody=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(responseBytes);rawBodyHash=createHash('sha256').update(responseBytes).digest('hex');
      try{result=JSON.parse(rawBody.replace(/^\uFEFF/,''));}catch{result={};}
     }else if(fetchImpl!==fetch&&typeof upstream.json==='function')result=await upstream.json(); // Injected legacy mocks have derived JSON, not wire bytes.
     else throw Error('HTTP原始响应载体不可读取');
     transport.state='received';transport.endedAt=Date.now();transport.usagePresent=!!result?.usage;transport.stage='receipt-save';
     recordProcessing();
     const headers=Object.fromEntries(['retry-after','content-type'].flatMap(name=>{const value=upstream.headers?.get(name);return value==null?[]:[[name,value]];}));
     const endpoint=service.baseUrl.replace(/\/$/,'')+'/chat/completions',retryAfter=headers['retry-after'],delay=retryAfter===undefined?undefined:/^\d+(\.\d+)?$/.test(retryAfter)?Number(retryAfter)*1000:Math.max(0,Date.parse(retryAfter)-Date.now());
     // Only documented direct-provider refusal statuses prove no generation is pending.
     const termination=service.providerCapabilities?.provider==='deepseek'&&service.providerCapabilities.transport==='native-http'&&['https://api.deepseek.com/chat/completions','https://api.deepseek.com/v1/chat/completions','https://api.deepseek.com/beta/chat/completions'].includes(endpoint)&&[429,503].includes(upstream.status)&&headers['content-type']?.includes('application/json')&&result?.error&&typeof result.error==='object'&&!Array.isArray(result.error)&&result.choices===undefined?{version:'provider-termination-v1',kind:'provider-rejected',requestId:callId,provider:'deepseek',status:upstream.status,responseHash:createHash('sha256').update(JSON.stringify(result)).digest('hex'),endedAt:Date.now(),endpoint,noResult:true,...(Number.isFinite(delay)?{retryAfterMs:delay}:{})}:undefined;
     // Response is delivered to the local application only. No prompts, keys or reasoning are logged.
     if(workbenchRequest)try{await workbench.finishHttpRequest(callId,{service:{...service,id:input.serviceId},...httpContract,status:upstream.status,response:result,rawBody,rawBodyHash,elapsedMs:Date.now()-started,termination,headers,transport});}catch(saveError){
      logger(JSON.stringify({callId,stage:'receipt-save-failed',failure:safeModelFailure(saveError,'ledger-write').failure}));
      let retained;try{retained=parseNativeToolResponse({...service,id:input.serviceId},httpContract.payload.messages,httpContract.payload.tools,{status:upstream.status,body:result,rawBody,rawBodyHash},Date.now()-started,callId,httpContract.schema);}catch(error){if(error instanceof ModelOutputError)retained=error.response;}
      if(retained){if(!res.destroyed)json(res,409,{modelReceiptPending:{message:'HTTP完整结果已收到，本地回执保存失败；原答保留，未重新派发',response:retained}});return;}throw saveError;
     }
     logger(JSON.stringify({callId,stage:'response-received',service:input.serviceId,status:upstream.status,elapsedMs:Date.now()-started,input:result.usage?.prompt_tokens,output:result.usage?.completion_tokens}));
     if(!res.destroyed)json(res,200,{status:upstream.status,body:result,rawBody,rawBodyHash,...(termination?{termination}:{}),headers});
    }catch(error){Object.assign(transport,transportFailure(error),{endedAt:Date.now()});if(transport.state==='active')transport.state='interrupted';throw error;}
    finally{clearTimeout(timer);if(workbenchRequest&&modelDispatchStarted)try{await workbench.finishRequest(callId,'unknown',{kind:'http-fetch-finally-exited',transport});}catch(saveError){logger(JSON.stringify({callId,stage:'transport-exit-save-failed',failure:safeModelFailure(saveError,'ledger-write').failure}));}active.delete(callId);}return;
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
  const relative=decodeURIComponent(url.pathname==='/'?'/'+defaultDocument:url.pathname), path=resolve(root,'.'+relative);
  if(!path.startsWith(root+sep))return json(res,403,{error:'路径不符'});
  const body=await readFile(path);
  res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'})[extname(path)]||'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});res.end(body);
 } catch(error) {
  if(error.modelReceiptPending)return json(res,error.status??409,{modelReceiptPending:error.modelReceiptPending});
  if(modelRequest){
   if(nativeRequest){if(!res.headersSent&&!res.destroyed)json(res,500,{error:'本地原生回执处理尚未完成，原请求与费用记录保留',requestId:modelRequestId,...(!nativeInvoked?{dispatch:'not-dispatched'}:{})});return;}
   if(workbenchRequest&&modelDispatchStarted)try{await workbench.finishRequest(modelRequestId,'unknown',{kind:'http-fetch-finally-exited'});}catch{}
   const safe=modelDispatchStarted?undefined:safeModelFailure(error,modelStage);
   logger(JSON.stringify({callId:modelRequestId,stage:modelDispatchStarted?'unknown':'not-dispatched',...(safe?{failure:safe.failure}:{})}));
   if((!res.headersSent||res.yixuStreaming)&&!res.destroyed)json(res,safe?.status??500,{error:modelDispatchStarted?'模型请求的结果或结算尚未确定，已停止自动重问':safe.error,dispatch:modelDispatchStarted?'unknown':'not-dispatched',requestId:modelRequestId,...(safe?{failure:safe.failure,retryable:false}:{})});
   return;
  }
  if(error instanceof WorkbenchError)return json(res,error.status,{error:error.message});
  if(isFreshHttpError(error)){
   const safe=safeModelFailure(error,error.failure.stage);
   return json(res,safe.status,{error:error.failure.code==='HTTP_RECEIPT_PENDING'?'原HTTP回执尚待确认，原请求与费用预留保持，未重新派发':safe.error,failure:safe.failure,retryable:false});
  }
  const networkFailure=error?.name==='AbortError'||error?.name==='TimeoutError'||error?.name==='TypeError'&&error?.cause;
  if(!res.headersSent&&!res.destroyed)json(res,500,{error:networkFailure?'网络请求中断或超时，已保留任务':'本地服务处理失败，请检查配置与构建结果',retryable:!!networkFailure});
 }
});
return server;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const port=Number(process.env.YIXU_PORT??4318);
 if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('YIXU_PORT应为1024至65535之间的本地端口');
 createLocalBridge({port}).listen(port,'127.0.0.1',()=>console.log(`宜序伴读本地入口 http://127.0.0.1:${port}`));
}
