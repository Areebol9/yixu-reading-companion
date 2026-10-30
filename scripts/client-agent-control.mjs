import http from 'node:http';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {mkdir,writeFile,rename,readFile,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {workbenchCommands} from '../src/workbench/contract.ts';

const uuid=value=>typeof value==='string'&&/^[0-9a-f-]{36}$/i.test(value);
const operationId=value=>typeof value==='string'&&/^[a-z0-9-]{8,100}$/i.test(value);
const sourceCommands=new Set(['recordReadingPosition','provideToCurrent','startReading','startFollowing','followVisible','setSourceVisible','registerReadingSource','captureReadingSource','confirmParagraphRead','recordVisible','startAutoReading','advanceAutoReading']);
class AgentControlError extends Error {constructor(message,status=409,details={}){super(message);this.status=status;this.details=details;}}
const json=(response,status,value)=>{if(response.destroyed)return;response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});response.end(JSON.stringify(value));};
const publicConnection=value=>({archiveId:value.archiveId,epoch:value.epoch,pid:value.pid});
const errorText=error=>error instanceof Error?error.message:String(error);

/** Authenticated local transport over the existing archive commands and receipts.
 * It does not create reading observations, model requests or a second task queue. */
export async function startClientAgentControl({dataRoot,coordinator,pageOrigin,nativeControl}={}){
 if(!dataRoot||typeof coordinator!=='function'||typeof nativeControl!=='function')throw Error('本机agent入口缺少独立数据目录或桌面连接');
 const page=new URL(pageOrigin);if(page.protocol!=='http:'||page.hostname!=='127.0.0.1'||page.origin!==pageOrigin)throw Error('本机agent入口需要准确的客户端页面来源');
 const instanceId=randomUUID(),token=randomBytes(32).toString('hex'),discoveryFile=join(resolve(dataRoot),'agent-connection.json');
 let closing=false,closed,displayArchive,latestConnection;
 const notified=new Set();
 const validateConnection=value=>{
  const url=new URL(value?.url);if(value.schema!=='yixu-companion-connection-v1'||!uuid(value.archiveId)||!uuid(value.epoch)||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!/^\d+$/.test(url.port)||!/^[a-f0-9]{64}$/i.test(value.token??''))throw new AgentControlError('存档宿主连接身份无效');return value;
 };
 const current=async()=>latestConnection=validateConnection(await coordinator.readConnection());
 // Initialize the same normal archive even when no renderer has been loaded.
 const initial=validateConnection(await coordinator({action:'current'},pageOrigin));displayArchive=initial.archiveId;latestConnection=initial;
 async function selected(input,{requireCurrent=false,readOnly=false}={}){
  if(!uuid(input?.archiveId)||!uuid(input?.epoch))throw new AgentControlError('请先读取status，并携带准确的archiveId与epoch',400);
  const connection=requireCurrent?await current():validateConnection(await (readOnly?coordinator.readConnection({archiveId:input.archiveId}):coordinator({action:'connect',archiveId:input.archiveId},pageOrigin)));
  if(connection.archiveId!==input.archiveId||connection.epoch!==input.epoch)throw new AgentControlError('当前存档或宿主已变化，原操作未改投，请核对原记录',409,{archiveId:input.archiveId,epoch:input.epoch,dispatch:'not-dispatched'});
  return connection;
 }
 async function hostJson(connection,path,init={}){
  const response=await fetch(new URL(path,connection.url),{...init,headers:{Authorization:'Bearer '+connection.token,...init.headers},signal:AbortSignal.timeout(15000)});
  let value;try{value=await response.json();}catch{throw new AgentControlError('宿主回执尚未完整返回，请查询原操作标识');}
  if(!response.ok)throw new AgentControlError(value.error??'宿主未接受本次操作',response.status);
  if(value.epoch!==undefined&&value.epoch!==connection.epoch)throw new AgentControlError('宿主代次已变化，原操作身份保持');
  return value;
 }
 async function synchronizeArchive(connection){
  if(displayArchive===connection.archiveId)return;displayArchive=connection.archiveId;
  try{await nativeControl('archive-changed');}catch{/* Opening the main interface can reconnect to the current archive later. */}
 }
 async function followReceipt(value,connection){
  const target=value.state==='complete'?value.receipt?.value?.connectArchiveId:undefined;
  if(target&&!coordinator.isShuttingDown()&&!notified.has(connection.epoch+':'+value.id)){
   const next=validateConnection(await coordinator({action:'connect',archiveId:target},pageOrigin));
   await synchronizeArchive(next);notified.add(connection.epoch+':'+value.id);
  }
  return value;
 }
 async function status(){
  let [lifecycle,nativeState]=await Promise.all([coordinator.ownedHosts(),nativeControl('status')]);
  let connection,frame;
  const terminal=lifecycle.hosts?.find(host=>host.archiveId===latestConnection?.archiveId&&host.exit&&['failed','closed'].includes(host.phase));
  if(terminal)return{schema:'yixu-desktop-agent-status-v1',instanceId,pid:process.pid,sessionId:latestConnection.archiveId,connection:publicConnection(latestConnection),lifecycle,nativeState,hostStatusAvailable:false,hostStatusError:terminal.error??'原阅读宿主已退出，未完成请求与原存档保持；保存状态须核对退出记录'};
  try{connection=await current();frame=await hostJson(connection,'/status');}
  catch(error){
   // The owner can exit between the lifecycle read and the HTTP request.
   if(!lifecycle.shuttingDown)lifecycle=await coordinator.ownedHosts();
   const failed=lifecycle.hosts?.some(host=>host.archiveId===(connection??latestConnection)?.archiveId&&['failed','closed'].includes(host.phase));
   if(!lifecycle.shuttingDown&&!failed)throw error;
   return{schema:'yixu-desktop-agent-status-v1',instanceId,pid:process.pid,sessionId:latestConnection.archiveId,connection:publicConnection(latestConnection),lifecycle,nativeState,hostStatusAvailable:false,hostStatusError:errorText(error)};
  }
  if(!lifecycle.shuttingDown)await synchronizeArchive(connection);
  if(frame.status?.sessionId!==connection.archiveId)throw new AgentControlError('当前存档状态与宿主身份不符');
  return{schema:'yixu-desktop-agent-status-v1',instanceId,pid:process.pid,connection:publicConnection(connection),sequence:frame.sequence,...frame.status,lifecycle,nativeState};
 }
 async function snapshot(){
  const connection=await current();if(!coordinator.isShuttingDown())await synchronizeArchive(connection);const frame=await hostJson(connection,'/snapshot');
  if(frame.snapshot?.sessionId!==connection.archiveId)throw new AgentControlError('当前存档快照与宿主身份不符');
  return{schema:'yixu-desktop-agent-snapshot-v1',instanceId,pid:process.pid,connection:publicConnection(connection),frame};
 }
 async function command(input){
  if(!operationId(input.commandId)||!Array.isArray(input.args)||!workbenchCommands.includes(input.name))throw new AgentControlError('command需要原commandId、有效name和args数组',400);
  if(sourceCommands.has(input.name))throw new AgentControlError('正文可见和人工已读由阅读窗口登记；开发者自动阅读请使用auto-read入口',403,{dispatch:'not-dispatched'});
  const connection=await selected(input,{requireCurrent:true});
  const request={id:input.commandId,epoch:input.epoch,name:input.name,args:input.args};
  let value;
  try{value=await hostJson(connection,'/command?async=1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});}
  catch(error){throw new AgentControlError(error instanceof AgentControlError?error.message:'原操作是否被接受尚未确认；请按原commandId查询operation，勿自动重发',error.status??409,{commandId:input.commandId,archiveId:input.archiveId,epoch:input.epoch,dispatch:error.details?.dispatch??'unknown'});}
  if(value.id!==input.commandId||value.epoch!==input.epoch)throw new AgentControlError('原操作回执身份不符，请查询原commandId',409,{commandId:input.commandId,archiveId:input.archiveId,epoch:input.epoch,dispatch:'unknown'});
  return followReceipt(value,connection);
 }
 async function operation(input){
  if(!operationId(input.commandId))throw new AgentControlError('operation需要原commandId',400);
  const connection=await selected(input,{readOnly:true}),value=await hostJson(connection,'/operations/'+encodeURIComponent(input.commandId)+'?epoch='+encodeURIComponent(input.epoch));
  if(value.id!==input.commandId||value.epoch!==input.epoch)throw new AgentControlError('原操作回执身份不符');return followReceipt(value,connection);
 }
 const authorized=request=>{const actual=Buffer.from(request.headers.authorization??''),expected=Buffer.from('Bearer '+token);return actual.length===expected.length&&timingSafeEqual(actual,expected);};
 const server=http.createServer(async(request,response)=>{
  let dispatch;
  try{
   const address=server.address(),host='127.0.0.1:'+address.port;
   if(request.headers.host!==host||request.headers.origin!==undefined||request.headers['x-yixu-client']!=='local-agent')return json(response,403,{error:'仅接受本机agent的明确认证连接'});
   if(!authorized(request))return json(response,401,{error:'需要本机agent连接授权'});
   if(closing)return json(response,409,{error:'客户端正在保存并退出，原任务保持'});
   const url=new URL(request.url,'http://'+host);
   if(request.method==='POST'&&url.pathname==='/api/desktop-agent/import'){
    if(String(request.headers['content-type']).split(';')[0]!=='application/octet-stream')throw new AgentControlError('文件导入需要application/octet-stream',400);
    const input=Object.fromEntries(url.searchParams),kind=input.kind;if(!['text','backup','book-source'].includes(kind)||typeof input.name!=='string'||!input.name||input.name.length>255)throw new AgentControlError('文件导入类型或名称无效',400);
    if(kind==='book-source'&&(!input.bookId||input.bookId.length>200||input.title!==undefined&&(!input.title.trim()||input.title.length>200||/[\r\n\u0000-\u001f]/u.test(input.title))))throw new AgentControlError('接续原文需要准确的bookId和有效书名',400);
    const connection=await selected(input,{requireCurrent:true}),target=new URL('/imports',connection.url);target.searchParams.set('kind',kind);target.searchParams.set('name',input.name);
    if(kind==='book-source'){target.searchParams.set('bookId',input.bookId);if(input.title!==undefined)target.searchParams.set('title',input.title);}
    dispatch={archiveId:input.archiveId,epoch:input.epoch,dispatch:'unknown'};
    const abort=new AbortController();request.once('aborted',()=>abort.abort());
    const result=await fetch(target,{method:'POST',headers:{Authorization:'Bearer '+connection.token,'Content-Type':'application/octet-stream'},body:request,duplex:'half',signal:abort.signal});
    const value=await result.json();if(!result.ok)return json(response,result.status,value);
    if(value.connectArchiveId){const next=validateConnection(await coordinator({action:'connect',archiveId:value.connectArchiveId},pageOrigin));await synchronizeArchive(next);}
    return json(response,result.status,value);
   }
   if(request.method==='GET'&&url.pathname.startsWith('/api/desktop-agent/download/')){
    const id=url.pathname.slice('/api/desktop-agent/download/'.length);if(!operationId(id))throw new AgentControlError('下载标识无效',400);
    const connection=await selected(Object.fromEntries(url.searchParams)),abort=new AbortController();response.once('close',()=>abort.abort());
    const result=await fetch(new URL('/downloads/'+encodeURIComponent(id),connection.url),{headers:{Authorization:'Bearer '+connection.token},signal:abort.signal});
    if(!result.ok)return json(response,result.status,await result.json());
    const headers=Object.fromEntries(['content-type','content-length','content-disposition','x-content-sha256'].flatMap(key=>result.headers.has(key)?[[key,result.headers.get(key)]]:[]));response.writeHead(result.status,{...headers,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    if(!result.body)throw new AgentControlError('下载原件尚未可读取');await pipeline(Readable.fromWeb(result.body),response);return;
   }
   if(request.method!=='POST'||url.pathname!=='/api/desktop-agent')return json(response,404,{error:'未知本机agent入口'});
   if(String(request.headers['content-type']).split(';')[0]!=='application/json')throw new AgentControlError('请求内容需要application/json',400);
   const chunks=[];let size=0;for await(const part of request){size+=part.length;if(size>1_500_000)throw new AgentControlError('操作内容过大，请通过文件导入入口发送正文',413);chunks.push(part);}
   let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new AgentControlError('请求需要完整JSON对象',400);}
   if(!input||typeof input!=='object'||Array.isArray(input))throw new AgentControlError('请求需要JSON对象',400);
   let value;
   if(input.action==='status')value=await status();
   else if(input.action==='snapshot')value=await snapshot();
   else if(input.action==='command')value=await command(input);
   else if(input.action==='operation')value=await operation(input);
   else if(input.action==='pause')value=await coordinator.pauseOwned();
   else if(input.action==='auto-read'){
    if(!input.settings||typeof input.settings!=='object'||Array.isArray(input.settings))throw new AgentControlError('自动阅读需要明确settings对象',400);
    value=await nativeControl('start-auto-reading',input.settings);
   }
   else if(['open','hide','quit'].includes(input.action))value=await nativeControl(input.action);
   else throw new AgentControlError('未知本机agent操作',400);
   json(response,200,value);
  }catch(error){if(response.headersSent){response.destroy();return;}json(response,error.status??409,{error:errorText(error),...(dispatch??{}),...(error.details??{})});}
 });
 await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});
 const discovery={schema:'yixu-desktop-agent-v1',instanceId,pid:process.pid,url:'http://127.0.0.1:'+server.address().port,token};
 try{await mkdir(resolve(dataRoot),{recursive:true});const pending=discoveryFile+'.'+instanceId+'.tmp';await writeFile(pending,JSON.stringify(discovery),{mode:0o600,flag:'wx'});await rename(pending,discoveryFile);}
 catch(error){await new Promise(done=>server.close(done));throw error;}
 return{discoveryFile,close:()=>closed??=(async()=>{closing=true;await new Promise((done,reject)=>server.close(error=>error?reject(error):done()));try{const value=JSON.parse(await readFile(discoveryFile,'utf8'));if(value.instanceId===instanceId)await unlink(discoveryFile);}catch(error){if(error.code!=='ENOENT')throw error;}})()};
}
