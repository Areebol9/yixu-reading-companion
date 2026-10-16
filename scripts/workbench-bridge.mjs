import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {validateService} from '../src/core/services.ts';
import {readingRequestPayloadHash} from '../src/core/terminated-reading-continuation.ts';

const sha=value=>createHash('sha256').update(value).digest('hex');
export class WorkbenchError extends Error { constructor(message,status=400){super(message);this.status=status;} }
export async function readConfiguration(file){
 try {const result=JSON.parse(await readFile(file,'utf8'));if(!result||Array.isArray(result)||typeof result!=='object')throw Error();return result;}
 catch(error){if(error.code==='ENOENT')return {};throw new WorkbenchError('本地服务配置无法读取，请检查配置文件',503);}
}
async function writeConfiguration(file,value){
 await mkdir(dirname(file),{recursive:true});const temporary=file+'.'+randomUUID()+'.tmp';
 await writeFile(temporary,JSON.stringify(value,null,2),{mode:0o600});await rename(temporary,file);
}
export function serviceMetadata(services,scope){return Object.entries(services).map(([id,value])=>({id,...(value.name?{name:value.name}:{}),baseUrl:value.baseUrl,model:value.model,effort:value.effort??'high',contextLimit:value.contextLimit,maxOutput:value.maxOutput??4096,hasKey:!!value.apiKey,scope}));}
export async function saveConfigurationSecret(file,input){
 const services=await readConfiguration(file),existing=Object.hasOwn(services,input.id)?services[input.id]:undefined;
 let checked;try {checked=validateService(input.service??{id:input.id,...existing,maxOutput:existing?.maxOutput??4096});}catch(error){throw new WorkbenchError(error.message);}
 if(checked.id!==input.id||typeof input.key!=='string'||input.key.length>1024)throw new WorkbenchError('配置无效');
 if(existing?.baseUrl!==checked.baseUrl&&!input.key)throw new WorkbenchError('新地址需要单独提供密钥');
 services[input.id]={...existing,name:checked.name,baseUrl:checked.baseUrl,model:checked.model,effort:checked.effort,thinking:checked.thinking,contextLimit:checked.contextLimit,maxOutput:checked.maxOutput,apiKey:input.key||existing?.apiKey||''};
 await writeConfiguration(file,services);return {ok:true};
}

export function createWorkbenchBridge(workspaceRoot=process.cwd()){
 const sharedFile=resolve(workspaceRoot,'.local/model-services.json'),configFile=resolve(workspaceRoot,'.local/workbench-model-services.json');
 const requestsFile=resolve(workspaceRoot,'.local/workbench-model-requests.json');
 // Serialize mutations so concurrent responses cannot discard configuration or receipts.
 let mutation=Promise.resolve();const serialize=fn=>{const next=mutation.then(fn);mutation=next.catch(()=>{});return next;};
 const configuration=()=>readConfiguration(configFile);
 return {
  configuration,
  async queryReceipt(input){
   if(!input||Object.keys(input).some(k=>k!=='requestId')||typeof input.requestId!=='string'||!/^[0-9a-f-]{36}$/i.test(input.requestId))throw new WorkbenchError('原回执请求编号无效');
   const row=(await readConfiguration(requestsFile))[input.requestId],audit=row?.localTermination;
   if(row?.status!=='unknown'||!/^[a-f0-9]{64}$/.test(row.payloadHash??'')||!/^[a-f0-9]{64}$/.test(row.corePayloadHash??'')||audit?.kind!=='http-fetch-finally-exited'||!Number.isSafeInteger(audit.at)||audit.at<row.createdAt)throw new WorkbenchError('原HTTP请求尚无可核验的本地退出事实，unknown与费用保持',409);
   return {requestId:input.requestId,inputHash:row.corePayloadHash,termination:{serviceId:row.serviceId,hostPayloadHash:row.payloadHash,terminationEvidence:JSON.stringify({requestId:input.requestId,serviceId:row.serviceId,localAttemptEnded:audit,providerSettlement:'unknown'}),payloadEvidence:JSON.stringify({requestId:input.requestId,serviceId:row.serviceId,hostPayloadHash:row.payloadHash,corePayloadHash:row.corePayloadHash})}};
  },
  async services(){const [shared,local]=await Promise.all([readConfiguration(sharedFile),configuration()]);return [...serviceMetadata(shared,'shared'),...serviceMetadata(local,'workbench')];},
  useService(input){return serialize(async()=>{
   if(typeof input.sourceId!=='string')throw new WorkbenchError('请明确选择一个本地服务');
   const shared=await readConfiguration(sharedFile);if(!Object.hasOwn(shared,input.sourceId))throw new WorkbenchError('所选本地服务不存在',404);
   const services=await configuration();services[input.sourceId]=structuredClone(shared[input.sourceId]);await writeConfiguration(configFile,services);
   return {ok:true,service:serviceMetadata({[input.sourceId]:services[input.sourceId]},'workbench')[0]};
  });},
  saveSecret(input){return serialize(()=>saveConfigurationSecret(configFile,input));},
  async sources(input={}){if(Object.keys(input).some(key=>key!=='includeHistorical')||input.includeHistorical!==undefined&&typeof input.includeHistorical!=='boolean')throw new WorkbenchError('本机来源列表参数无效');return [];},
  async source(){throw new WorkbenchError('请在阅读界面导入自己的TXT文件或阅读备份',404);},
  // Keep identity and hashes; the browser owns the original material and replies.
  reserveRequest(requestId,serviceId,body){return serialize(async()=>{
   const records=await readConfiguration(requestsFile),payloadHash=sha(JSON.stringify({serviceId,body}));
   if(Object.hasOwn(records,requestId)||Object.values(records).some(r=>r.payloadHash===payloadHash&&['unknown','dispatch-started'].includes(r.status)))throw new WorkbenchError('此请求已发送或结果尚未确定，已停止重复派发',409);
   const corePayloadHash=await readingRequestPayloadHash(body.messages??[],(body.tools??[]).map(t=>t.function??t));
   records[requestId]={serviceId,payloadHash,corePayloadHash,status:'dispatch-started',createdAt:Date.now()};await writeConfiguration(requestsFile,records);
  });},
  finishRequest(requestId,status,termination){return serialize(async()=>{
   const records=await readConfiguration(requestsFile);if(!records[requestId])return;
   if(!['returned','unknown'].includes(status))throw new WorkbenchError('请求完成状态无效');records[requestId].status=status;
   if(status==='unknown'&&termination?.kind==='http-fetch-finally-exited')records[requestId].localTermination={kind:'http-fetch-finally-exited',at:Date.now()};
   await writeConfiguration(requestsFile,records);return records[requestId];
  });}
 };
}
