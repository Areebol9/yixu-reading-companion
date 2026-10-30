import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {validateService} from '../src/core/services.ts';
import {validateModelParameters} from '../src/core/model-parameters.ts';
import {readingRequestPayloadHash} from '../src/core/terminated-reading-continuation.ts';
import {parseNativeToolResponse,createProviderReceipt} from '../src/core/model.ts';
import {parseProviderWireBody} from '../src/core/provider-stream.ts';
import {compileProviderTools} from '../src/core/provider-schema.ts';
import {verifyProviderTermination} from '../src/core/provider-capabilities.ts';

const sha=value=>createHash('sha256').update(value).digest('hex');
const validId=value=>typeof value==='string'&&/^[0-9a-f-]{36}$/i.test(value);
export class WorkbenchError extends Error {constructor(message,status=400){super(message);this.status=status;}}
export async function readConfiguration(file){
 try {const value=JSON.parse(await readFile(file,'utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value;}
 catch(error){if(error.code==='ENOENT')return {};throw new WorkbenchError('本地服务配置无法读取，请检查配置文件',503);}
}
async function writeConfiguration(file,value){
 await mkdir(dirname(file),{recursive:true});const temporary=file+'.'+randomUUID()+'.tmp';
 await writeFile(temporary,JSON.stringify(value,null,2),{mode:0o600});await rename(temporary,file);
}
export function serviceMetadata(services,scope){return Object.entries(services).map(([id,value])=>({id,...(value.name?{name:value.name}:{}),baseUrl:value.baseUrl,model:value.model,effort:value.effort??'high',thinking:value.thinking,contextLimit:value.contextLimit,maxOutput:value.maxOutput??4096,...(value.temperature!==undefined?{temperature:value.temperature}:{}),...(value.topP!==undefined?{topP:value.topP}:{}),...(value.binding?{binding:true}:{}),...(value.inputPrice!==undefined?{inputPrice:value.inputPrice}:{}),...(value.outputPrice!==undefined?{outputPrice:value.outputPrice}:{}),...(value.providerCapabilities?{providerCapabilities:structuredClone(value.providerCapabilities)}:{}),hasKey:!!value.apiKey,scope}));}
export async function saveConfigurationSecret(file,input){
 const services=await readConfiguration(file),existing=Object.hasOwn(services,input?.id)?services[input.id]:undefined;
 if(existing?.binding)throw new WorkbenchError('伙伴模型绑定独立保留，请重新选择来源渠道');
 let checked;try{checked=validateService(input?.service??{id:input?.id,...existing,maxOutput:existing?.maxOutput??4096});validateModelParameters(checked);}catch(error){throw new WorkbenchError(error.message);}
 if(checked.id!==input.id||typeof input.key!=='string'||input.key.length>1024)throw new WorkbenchError('配置无效');
 if(existing?.baseUrl!==checked.baseUrl&&!input.key)throw new WorkbenchError('新地址需要单独提供密钥');
 services[input.id]={...existing,name:checked.name,baseUrl:checked.baseUrl,model:checked.model,effort:checked.effort,thinking:checked.thinking,contextLimit:checked.contextLimit,maxOutput:checked.maxOutput,apiKey:input.key||existing?.apiKey||''};
 for(const field of ['temperature','topP','inputPrice','outputPrice','providerCapabilities'])if(checked[field]!==undefined)services[input.id][field]=structuredClone(checked[field]);else delete services[input.id][field];
 await writeConfiguration(file,services);return{ok:true};
}
const fenceReceipt=value=>{const {certificate:c,text,fenceSHA}=value;return{requestId:c.requestId,inputHash:c.inputHash,termination:{kind:'local-attempt-fence',serviceId:c.serviceId,cohortId:c.cohortId,protocolSHA:c.protocolSHA,closedAt:c.closedAt,fenceSHA,providerOutcome:'unknown',terminationEvidence:text,payloadEvidence:JSON.stringify({requestId:c.requestId,serviceId:c.serviceId,inputHash:c.inputHash,payloadSHA:c.payloadSHA})}};};

/** Public HTTP adapter. The archive owns authorization, budgets and accounting.
 * This journal retains transport identity and original receipts across restarts. */
export function createClientBridge(workspaceRoot=process.cwd(),{dataRoot=process.env.YIXU_CLIENT_DATA_ROOT,archiveId=process.env.YIXU_COMPANION_ARCHIVE_ID,requestStore,serviceConfigurationFile}={}){
 if(archiveId!==undefined&&!validId(archiveId))throw new WorkbenchError('阅读存档身份无效');
 const root=resolve(workspaceRoot,dataRoot??'.local/client-data'),sharedFile=resolve(root,'model-services.json'),configFile=resolve(root,serviceConfigurationFile??'workbench-model-services.json'),requestsFile=resolve(root,requestStore??(archiveId?'archives/'+archiveId+'/model-requests.json':'workbench-model-requests.json'));
 const receiptFile=id=>resolve(dirname(requestsFile),'http-receipts',id+'.json'),materialFile=id=>resolve(dirname(requestsFile),'http-requests',id+'.json');
 let mutation=Promise.resolve();const serialize=fn=>{const next=mutation.then(fn);mutation=next.catch(()=>{});return next;};
 // Explicit local test opt-in only. No API key or provider usage is invented.
 const testConfiguration=async()=>process.env.YIXU_SUBAGENT_TEST_CONFIG?(await import('./subagent-test-transport.mjs')).readSubagentConfiguration(workspaceRoot):undefined;
 const configuration=async()=>{const values=await readConfiguration(configFile),test=await testConfiguration();return test?{...values,[test.service.id]:{...test.service,subagentTestSource:test.service.id}}:values;};
 const testService=(service,test)=>!!test&&service?.subagentTestSource===test.service.id&&service.baseUrl===test.service.baseUrl&&service.model===test.service.model;
 const metadata=async(values,scope)=>{const test=await testConfiguration();return serviceMetadata(values,scope).map(item=>testService(values[item.id],test)?{...item,hasKey:true,transport:'subagent-test',actualExecutorEffort:test.actualExecutorEffort,actualUsage:null}:item);};
 const checkId=id=>{if(!validId(id))throw new WorkbenchError('原回执请求编号无效');};
 const integrity=()=>new WorkbenchError('原HTTP请求或回执身份不符，原结果与费用保持',409);
 async function material(id,row){
  const value=await readConfiguration(materialFile(id));
  if(value.requestId!==id||sha(JSON.stringify(value))!==row.materialHash||sha(JSON.stringify({serviceId:row.serviceId,body:value.body}))!==row.payloadHash||await readingRequestPayloadHash(value.payload.messages,value.payload.tools)!==row.corePayloadHash)throw integrity();
  return value;
 }
 async function persistReceipt(id,input){
  const records=await readConfiguration(requestsFile),row=records[id];if(!row)throw integrity();
  const saved={requestId:id,...input,service:{...input.service,apiKey:undefined},corePayloadHash:row.corePayloadHash};
  if(input.rawBody!==undefined&&(typeof input.rawBody!=='string'||sha(Buffer.from(input.rawBody,'utf8'))!==input.rawBodyHash||input.response!==undefined&&!isDeepStrictEqual(parseProviderWireBody(input.rawBody),input.response)))throw integrity();
  if(input.rawBodyBase64!==undefined&&(typeof input.rawBodyBase64!=='string'||Buffer.from(input.rawBodyBase64,'base64').toString('base64')!==input.rawBodyBase64||sha(Buffer.from(input.rawBodyBase64,'base64'))!==input.rawBodyHash||input.response!==undefined||input.rawBody!==undefined))throw integrity();
  if(row.receiptHash){const prior=await readConfiguration(receiptFile(id));if(sha(JSON.stringify(prior))!==row.receiptHash||!isDeepStrictEqual(prior,JSON.parse(JSON.stringify(saved))))throw integrity();return row;}
  await writeConfiguration(receiptFile(id),saved);row.receiptHash=sha(JSON.stringify(saved));row.status=input.response!==undefined&&input.status>=200&&input.status<300?'returned':input.termination?'provider-rejected':'unknown';
  await writeConfiguration(requestsFile,records);return row;
 }
 async function saveReceived(id,row,received){
  const original=await material(id,row),receipt=received?.providerReceipt;
  if(received?.requestId!==id||receipt?.version!=='provider-receipt-v1'||receipt.status<200||receipt.status>=300||receipt.bodyEncoding!=='wire-utf8'||typeof receipt.rawBody!=='string'||sha(Buffer.from(receipt.rawBody,'utf8'))!==receipt.rawBodyHash||!Number.isFinite(received.elapsedMs)||received.elapsedMs<0)throw integrity();
  const body=parseProviderWireBody(receipt.rawBody),compiled=await compileProviderTools(original.service,original.payload.tools),raw={status:receipt.status,body,rawBody:receipt.rawBody,rawBodyHash:receipt.rawBodyHash};
  if(!isDeepStrictEqual(compiled.tools,original.body.tools??[])||!isDeepStrictEqual(receipt,createProviderReceipt(original.service,raw,compiled.schema)))throw integrity();
  let parsed;try{parsed=parseNativeToolResponse(original.service,original.payload.messages,original.payload.tools,raw,received.elapsedMs,id,compiled.schema);}catch(error){if(error.name!=='ModelOutputError')throw error;parsed=error.response;}
  if(!parsed||['requestId','content','reasoning','toolCalls','finish','input','output','estimated','elapsedMs','rawTerminal'].some(field=>!isDeepStrictEqual(parsed[field],received[field])))throw integrity();
  await persistReceipt(id,{service:original.service,payload:original.payload,schema:compiled.schema,...raw,response:body,elapsedMs:received.elapsedMs,body:undefined});
 }
 async function queryReceipt(input){
  if(!input||Object.keys(input).some(key=>!['requestId','receivedResponse'].includes(key)))throw new WorkbenchError('原回执参数无效');checkId(input.requestId);
  let row=(await readConfiguration(requestsFile))[input.requestId];if(!row)throw new WorkbenchError('原HTTP请求尚无本地登记，未重新派发',409);
  if(input.receivedResponse!==undefined){await saveReceived(input.requestId,row,input.receivedResponse);row=(await readConfiguration(requestsFile))[input.requestId];}
  // A timed-out test carrier may finish later. Recover only its exact original
  // complete answer into the existing journal; unknown usage remains unknown.
  if(!row.receiptHash&&!row.localAttemptFence&&row.status==='unknown'&&row.localTermination?.kind==='http-fetch-finally-exited'){
   const test=await testConfiguration();
   if(test){
    const original=await material(input.requestId,row),result=await (await import('./subagent-test-transport.mjs')).completedSubagentResponse(test,original);
    if(result){
     const compiled=await compileProviderTools(original.service,original.payload.tools);
     if(!isDeepStrictEqual(compiled.tools,original.body.tools??[]))throw integrity();
     await persistReceipt(input.requestId,{service:original.service,payload:original.payload,schema:compiled.schema,status:result.status,response:result.body,headers:result.headers,elapsedMs:Date.now()-row.createdAt,transport:{kind:'subagent-test',actualExecutorEffort:test.actualExecutorEffort,actualUsage:null,nativeCLIReceipt:false}});
     row=(await readConfiguration(requestsFile))[input.requestId];
    }
   }
  }
  if(row.receiptHash){
   const saved=await readConfiguration(receiptFile(input.requestId));if(sha(JSON.stringify(saved))!==row.receiptHash||saved.requestId!==input.requestId||saved.corePayloadHash!==row.corePayloadHash)throw integrity();
   if(saved.response!==undefined){
    const raw={status:saved.status,body:saved.response,rawBody:saved.rawBody,rawBodyHash:saved.rawBodyHash,termination:saved.termination,headers:saved.headers},providerReceipt=createProviderReceipt(saved.service,raw,saved.schema);
    if(saved.termination){if(!await verifyProviderTermination(saved.termination,providerReceipt,saved.service,input.requestId))throw integrity();return{requestId:input.requestId,inputHash:row.corePayloadHash,providerTermination:saved.termination,providerReceipt};}
    let response,outcome;try{response=parseNativeToolResponse(saved.service,saved.payload.messages,saved.payload.tools,raw,saved.elapsedMs,input.requestId,saved.schema);}catch(error){if(error.name!=='ModelOutputError')throw error;response=error.response;outcome=error.outcome;}
    let transport;
    if(saved.transport?.kind==='subagent-test'){
     const test=await testConfiguration(),original=await material(input.requestId,row),completed=test&&await (await import('./subagent-test-transport.mjs')).completedSubagentResponse(test,original);
     if(!completed||!isDeepStrictEqual(completed.body,saved.response))throw integrity();
     transport='subagent-test';
    }
    return{requestId:input.requestId,inputHash:row.corePayloadHash,payload:saved.payload,response,...(outcome?{outcome}:{}),certificate:{nativeRequestHash:row.payloadHash,acceptedHash:row.receiptHash,resultHash:sha(JSON.stringify(saved.response)),...(transport?{transport}:{})}};
   }
  }
  if(row.localAttemptFence){const value=row.localAttemptFence;if(value.certificate.requestId!==input.requestId||value.certificate.inputHash!==row.corePayloadHash||value.text!==JSON.stringify(value.certificate)||sha(value.text)!==value.fenceSHA)throw integrity();return fenceReceipt(value);}
  if(row.status!=='unknown'||row.localTermination?.kind!=='http-fetch-finally-exited'||!Number.isSafeInteger(row.localTermination.at)||row.localTermination.at<row.createdAt)throw new WorkbenchError('原HTTP结果尚待确认，原请求与费用预留保持，未重新派发',409);
  return{requestId:input.requestId,inputHash:row.corePayloadHash,termination:{serviceId:row.serviceId,hostPayloadHash:row.payloadHash,terminationEvidence:JSON.stringify({requestId:input.requestId,serviceId:row.serviceId,localAttemptEnded:row.localTermination,providerSettlement:'unknown'}),payloadEvidence:JSON.stringify({requestId:input.requestId,serviceId:row.serviceId,hostPayloadHash:row.payloadHash,corePayloadHash:row.corePayloadHash})}};
 }
 return{
  async companionConnection(input,origin){const {companionCoordinator}=await import('./companion-host/registry.mjs');return companionCoordinator(workspaceRoot)(input,origin);},
  configuration,nativeConfiguration:async()=>undefined,subagentConfiguration:testConfiguration,
  queryReceipt:input=>serialize(()=>queryReceipt(input)),
  async assertRequestOpen(id){checkId(id);if((await readConfiguration(requestsFile))[id]?.localAttemptFence){const error=new WorkbenchError('原本地尝试已封闭，原结果与费用预留保持',409);error.code='LOCAL_ATTEMPT_CLOSED';throw error;}},
  async nativeOutcome(){throw new WorkbenchError('当前服务使用HTTP原回执',409);},
  // The ordinary archive budget remains authoritative; no second batch is created.
  async budget(){return null;},
  async updateBudget(input){if(!input||Object.keys(input).some(key=>key!=='tokenLimit')||!Number.isSafeInteger(input.tokenLimit)||input.tokenLimit<0)throw new WorkbenchError('token 总上限应为非负整数');return null;},
  async services(){const [shared,local]=await Promise.all([readConfiguration(sharedFile),configuration()]);return[...await metadata(shared,'shared'),...await metadata(local,'workbench')];},
  bindService(input){return serialize(async()=>{
   if(!input||Object.keys(input).some(key=>!['sourceId','parameters'].includes(key))||typeof input.sourceId!=='string'||!input.sourceId)throw new WorkbenchError('请明确选择一个已配置模型渠道');
   const parameters=input.parameters??{};
   if(typeof parameters!=='object'||Array.isArray(parameters)||Object.keys(parameters).some(key=>!['effort','maxOutput','contextLimit','temperature','topP'].includes(key)))throw new WorkbenchError('伙伴模型参数无效');
   const services=await configuration();let source=Object.hasOwn(services,input.sourceId)?services[input.sourceId]:undefined;
   if(!source){const shared=await readConfiguration(sharedFile);source=Object.hasOwn(shared,input.sourceId)?shared[input.sourceId]:undefined;}
   const test=await testConfiguration(),localExecutor=testService(source,test);
   if(!source?.apiKey&&!localExecutor)throw new WorkbenchError('所选模型渠道尚未配置认证，请先保存模型设置',409);
   const id='partner-model-'+randomUUID();
   const bound={...structuredClone(source),id,name:source.name??input.sourceId,effort:source.effort??'high',maxOutput:source.maxOutput??4096,enabled:true,fallback:false,secretRef:id,thinking:source.thinking??(input.sourceId.startsWith('custom-')?'none':'deepseek'),binding:true};
   for(const [key,value] of Object.entries(parameters)){
    if((key==='temperature'||key==='topP')&&value===null)delete bound[key];else bound[key]=value;
   }
   try{validateModelParameters(bound);services[id]=validateService(bound);}catch(error){throw new WorkbenchError(error.message);}
   await writeConfiguration(configFile,services);
   return (await metadata({[id]:services[id]},'workbench'))[0];
  });},
  useService(input){return serialize(async()=>{if(typeof input?.sourceId!=='string')throw new WorkbenchError('请明确选择一个共享服务');const shared=await readConfiguration(sharedFile);if(!Object.hasOwn(shared,input.sourceId))throw new WorkbenchError('所选共享服务不存在',404);const services=await configuration();services[input.sourceId]=structuredClone(shared[input.sourceId]);await writeConfiguration(configFile,services);return{ok:true,service:serviceMetadata({[input.sourceId]:services[input.sourceId]},'workbench')[0]};});},
  saveSecret:input=>serialize(async()=>{
   const test=await testConfiguration();
   if(test&&input?.id===test.service.id){
    const checked=validateService(input.service);
    if(input.key!==''||checked.id!==test.service.id||['baseUrl','model','effort','maxOutput','contextLimit','thinking'].some(key=>checked[key]!==test.service[key]))throw new WorkbenchError('本机子代理渠道须保持声明的配置，不接受凭据',409);
    return{ok:true};
   }
   return saveConfigurationSecret(configFile,input);
  }),
  async sources(input={}){if(Object.keys(input).some(key=>key!=='includeHistorical')||input.includeHistorical!==undefined&&typeof input.includeHistorical!=='boolean')throw new WorkbenchError('来源列表参数无效');return[];},
  async source(){throw new WorkbenchError('请通过导入TXT或正常存档备份打开书籍',404);},
  reserveRequest(id,serviceId,body,options={}){return serialize(async()=>{
   checkId(id);const records=await readConfiguration(requestsFile),payloadHash=sha(JSON.stringify({serviceId,body}));
   if(Object.hasOwn(records,id)||Object.values(records).some(row=>row.payloadHash===payloadHash&&['unknown','dispatch-started','settlement-pending'].includes(row.status)&&!row.localAttemptFence)){const error=new WorkbenchError('此请求已发送或结果尚未确定，已停止重复派发',409);error.failure={category:'integrity',code:'WORKBENCH_REQUEST_UNRESOLVED',status:409,stage:'ledger-admission',recovery:'receipt'};throw error;}
   const services=await configuration(),service=services[serviceId];if(!service)throw new WorkbenchError('所选服务尚未配置',409);
   const payload=options.businessPayload??{messages:body.messages??[],tools:(body.tools??[]).map(tool=>tool.function??tool)},corePayloadHash=await readingRequestPayloadHash(payload.messages,payload.tools);
   const original={requestId:id,service:{...service,id:serviceId,apiKey:undefined},body,payload};await writeConfiguration(materialFile(id),original);
   records[id]={serviceId,payloadHash,corePayloadHash,materialHash:sha(JSON.stringify(original)),status:'dispatch-started',createdAt:Date.now()};await writeConfiguration(requestsFile,records);
  });},
  async validateHttpRequest(service,body,businessPayload){const payload=businessPayload??{messages:body.messages,tools:(body.tools??[]).map(tool=>tool.function??tool)},compiled=await compileProviderTools({...service,id:service.id??'custom-http-provider'},payload.tools);if(JSON.stringify(payload.messages)!==JSON.stringify(body.messages)||JSON.stringify(compiled.tools)!==JSON.stringify(body.tools??[]))throw new WorkbenchError('HTTP请求与业务工具定义不符，未派发');return{payload,schema:compiled.schema};},
  finishHttpRequest:(id,input)=>serialize(async()=>{checkId(id);return persistReceipt(id,input);}),
  finishRequest(id,status,termination){return serialize(async()=>{checkId(id);const records=await readConfiguration(requestsFile),row=records[id];if(!row)return;if(row.status==='dispatch-started'&&status!==undefined)row.status=status;if(termination?.kind==='http-fetch-finally-exited')row.localTermination??={kind:'http-fetch-finally-exited',at:Date.now()};await writeConfiguration(requestsFile,records);return row;});},
  closeAttempt(input,{isActive}={}){return serialize(async()=>{
   if(typeof isActive!=='function')throw new WorkbenchError('关闭本地尝试需要当前请求执行者确认',409);
   if(!input||Object.keys(input).some(key=>!['requestId','serviceId','inputHash','payload','reservation'].includes(key)))throw integrity();checkId(input.requestId);
   const records=await readConfiguration(requestsFile),row=records[input.requestId];if(!row||row.serviceId!==input.serviceId||row.corePayloadHash!==input.inputHash||await readingRequestPayloadHash(input.payload?.messages,input.payload?.tools)!==row.corePayloadHash)throw integrity();
   if(isActive(input.requestId))return{kind:'processing',requestId:input.requestId};
   const original=await material(input.requestId,row);if(!isDeepStrictEqual(input.payload,original.payload))throw integrity();
   const reservation=input.reservation;if(!reservation||![reservation.inputTokens,reservation.outputTokens,reservation.totalTokens].every(value=>Number.isSafeInteger(value)&&value>=0)||reservation.totalTokens!==reservation.inputTokens+reservation.outputTokens)throw integrity();
   if(row.receiptHash&&(await readConfiguration(receiptFile(input.requestId))).response!==undefined)return queryReceipt({requestId:input.requestId});
   if(row.localAttemptFence){if(!isDeepStrictEqual(row.localAttemptFence.certificate.originalCoreReservation,reservation))throw integrity();return fenceReceipt(row.localAttemptFence);}
   if(!['unknown','dispatch-started'].includes(row.status))throw new WorkbenchError('原HTTP调用已有其他结果，须按原回执处理',409);
   // An abrupt process exit may never run finally. This explicit operation
   // fences the inactive ID now; it does not invent a past exit or settlement.
   // reserveRequest installs active ownership before ledger admission and never
   // reuses an existing ID, so this serialized fence also excludes late dispatch.
   const closedAt=new Date().toISOString(),localClosure={kind:'explicit-inactive-attempt-fence',at:closedAt};
   const inputTokens=Math.max(reservation.inputTokens,Buffer.byteLength(JSON.stringify(original.body),'utf8')+2048),outputTokens=Math.max(reservation.outputTokens,original.body.max_tokens),certificate={schema:'local-reading-attempt-fence/v1',requestId:input.requestId,serviceId:input.serviceId,inputHash:input.inputHash,payloadSHA:sha(JSON.stringify(input.payload)),cohortId:sha(requestsFile),protocolSHA:sha('yixu-client-http-v1'),closedAt,providerOutcome:'unknown',originalCoreReservation:structuredClone(reservation),holdReservation:{inputTokens,outputTokens,totalTokens:inputTokens+outputTokens},transport:'native-http',...(row.localTermination?{localExit:row.localTermination}:{}),localClosure};
   row.status='unknown';
   const text=JSON.stringify(certificate);row.localAttemptFence={certificate,text,fenceSHA:sha(text)};await writeConfiguration(requestsFile,records);return fenceReceipt(row.localAttemptFence);
  });}
 };
}
