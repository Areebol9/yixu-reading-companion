import {workbenchCommands} from './contract.ts';
import type {WorkbenchClient, WorkbenchSnapshot, WorkbenchClientOperation} from './contract.ts';
import type {HostFrame,HostDelta,HostRequest,CommandReceipt,CommandStatus} from '../host/contract.ts';
import {applyProjection} from '../host/projection-delta.ts';
import {sourceFileFromSelection} from './desktop-window.ts';

export type CompanionConnection = {schema: 'yixu-companion-connection-v1'; archiveId: string; epoch: string; url: string; token: string};

/** Renderer owns only the transport and a detached projection, never an engine. */
export async function createRemoteWorkbenchClient(connection: CompanionConnection): Promise<WorkbenchClient> {
  const headers = {Authorization: 'Bearer ' + connection.token};
  const url = new URL(connection.url);
  if (connection.schema !== 'yixu-companion-connection-v1' || url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw Error('阅读窗口连接无效，请重新打开客户端');
  let snapshot: WorkbenchSnapshot, hostSnapshot:WorkbenchSnapshot, connectionError:string|undefined, epoch = connection.epoch, sequence = -1, closed = false;
  let redirected:WorkbenchClient|undefined,redirectSubscription:(()=>void)|undefined;
  const listeners = new Set<() => void>(), stop = new AbortController();
  const clientOperations=new Map<string,WorkbenchClientOperation>();
  const publish = () => { for (const listener of listeners) listener(); };
  const project=()=>{if(!hostSnapshot)return;snapshot={...hostSnapshot,...(connectionError?{connectionError}:{}),...(clientOperations.size?{clientOperations:[...clientOperations.values()]}:{})};publish();};
  const delay=(milliseconds:number,wakeable=false)=>new Promise<void>((resolve,reject)=>{
    const clean=()=>{clearTimeout(timer);stop.signal.removeEventListener('abort',abort);if(wakeable)wakeStream=undefined;};
    const done=()=>{clean();resolve();},abort=()=>{clean();reject(Error('伴读界面连接已关闭'));},timer=setTimeout(done,milliseconds);
    if(wakeable)wakeStream=done;stop.signal.addEventListener('abort',abort,{once:true});if(stop.signal.aborted)abort();
  });
  let wakeStream:(()=>void)|undefined,streamAttempt:AbortController|undefined;
  const redirect=async(id:string)=>{
    const response=await fetch('/api/companionConnection',{method:'POST',headers:{'Content-Type':'application/json','X-Yixu-Client':'local-app'},body:JSON.stringify({action:'connect',archiveId:id})});
    const next=await response.json();if(!response.ok)throw Error(next.error??'阅读存档正在准备，请稍后再操作');
    const client=await createRemoteWorkbenchClient(next);closed=true;stop.abort();redirected=client;redirectSubscription=client.subscribe(publish);publish();
  };
  const receive = (frame: HostFrame) => { if(closed)return;if (frame.epoch !== epoch) throw Error('本机程序已重新打开。请重新打开此阅读窗口，已有内容保留。'); if (frame.sequence < sequence) return; sequence = frame.sequence; hostSnapshot = frame.snapshot as WorkbenchSnapshot;connectionError=undefined; if(!import.meta.env?.VITE_YIXU_DESKTOP && !window.yixuDesktop)void import('./archive-migration.ts').then(module=>module.rememberHostArchive(hostSnapshot.sessionId)).catch(fail); project(); };
  const fail = (error: unknown) => { if (!closed&&hostSnapshot) {
    const message=error instanceof Error?error.message:String(error);
    connectionError=/宿主已更换|本机程序已重新打开|需要本机连接授权|此页面未绑定伴读宿主/.test(message)?'此阅读窗口的连接已失效。请重新打开阅读窗口，已有内容保留。':'与本机程序暂时断开，应用会继续尝试恢复连接。已有内容保留。';project();
  } };
  const fetchHost = async (path: string, init: RequestInit = {}, reportTransportFailure=true) => {
    let response:Response;
    try{response=await fetch(new URL(path, url), {...init, headers: {...headers, ...init.headers}, signal: init.signal?AbortSignal.any([stop.signal,init.signal]):stop.signal});}
    catch(error){if(reportTransportFailure&&!closed&&!init.signal?.aborted)fail(error);throw error;}
    if (!response.ok) {const body=await response.json().catch(()=>({}));const error=Object.assign(Error(body.error ?? '本机程序暂时无法处理这次操作，请稍后恢复连接。'),{status:response.status});if(response.status===401||response.status===403)fail(error);throw error;}return response;
  };
  const synchronize=async()=>{if(!closed)receive(await(await fetchHost('/snapshot')).json());};
  // The event stream supplies the initial snapshot and subsequent changes.
  // Focus wakes a disconnected stream without reloading the whole archive.
  const resumeView=()=>{if(document.visibilityState==='visible')wakeStream?.();};
  window.addEventListener('focus',resumeView,{signal:stop.signal});
  window.addEventListener('pageshow',resumeView,{signal:stop.signal});
  document.addEventListener('visibilitychange',resumeView,{signal:stop.signal});
  document.addEventListener('resume',resumeView,{signal:stop.signal});
  let streamReady!:()=>void,streamFailed!:(error:unknown)=>void;
  const firstStreamFrame=new Promise<void>((resolve,reject)=>{streamReady=resolve;streamFailed=reject;});
  let streamReceived=false;
  const consume = async (signal:AbortSignal) => {
    const response = await fetchHost('/events',{signal},false); if (!response.body) throw Error('本机程序的状态连接暂时不可用');
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader(); let pending = '';
    for (;;) {
      const next = await reader.read(); if (next.done) break; pending += next.value;
      let end: number;
      while ((end = pending.indexOf('\n\n')) >= 0) { const event = pending.slice(0, end); pending = pending.slice(end + 2); if (event.startsWith('data: ')){
        const frame=JSON.parse(event.slice(6)) as HostFrame|HostDelta;
        if('patch'in frame){if(frame.epoch!==epoch)throw Error('宿主已更换，请重新连接原存档');if(frame.sequence<=sequence)continue;
          if(frame.baseSequence!==sequence){receive(await(await fetchHost('/snapshot')).json());continue;}
          receive({epoch:frame.epoch,sequence:frame.sequence,snapshot:applyProjection(hostSnapshot,frame.patch),events:frame.events});
        }else receive(frame);
        streamReceived=true;streamReady();
      }}
    }
    if (!closed) throw Error('与本机程序的连接已断开，已有进度已保存。连接恢复后请点击继续伴读');
  };
  const streamTask=(async()=>{
    while(!closed){
      streamAttempt=new AbortController();
      try{await consume(streamAttempt.signal);}
      catch(error){if(closed)return;fail(error);if(!streamReceived){streamFailed(error);closed=true;stop.abort();return;}}
      finally{streamAttempt.abort();}
      if(!closed)try{await delay(2000,true);}catch{return;}
    }
  })();
  void streamTask.catch(fail);
  // The first subscription performs the host's normal reconnect/pause. Do not
  // expose an earlier snapshot on which a renderer could register a stale source.
  await firstStreamFrame;
  const commandReceipt=async(request:HostRequest):Promise<CommandReceipt>=>{
    const transportWait=15000;
    let reply:CommandStatus|CommandReceipt|undefined,postReply:CommandStatus|CommandReceipt|undefined,postError:unknown,postPending=true;
    const startedAt=Date.now(),bookId=snapshot.book?.id??snapshot.selectedBookId,commandStop=new AbortController();
    const pending=(state:WorkbenchClientOperation['state'])=>{
      if(closed)return;
      const previous=clientOperations.get(request.id);if(previous?.state===state)return;
      const role=['preparePrevious','refreshReadingViews','resumeMaintenance','resumeTerminatedMaintenance','closeLostMaintenance','dismissMaintenance','restoreMaintenance','recognizeBookDirectory'].includes(request.name)||request.name==='recoverReading'&&(request.args[0] as {kind?:string}|undefined)?.kind==='maintenance'?'maintenance':'conversation';
      clientOperations.set(request.id,{id:request.id,epoch:request.epoch,command:request.name,role,bookId,startedAt,state});project();
    };
    const statusOf=(error:unknown)=>error&&typeof error==='object'&&'status'in error?Number(error.status):undefined;
    const commandFailure=(error:unknown)=>{
      const status=statusOf(error),message=error instanceof Error?error.message:String(error);
      if(status===401||status===403)return Error('此阅读窗口的连接已失效。请重新打开阅读窗口，已有内容保留。');
      if(status===409&&/宿主已更换/.test(message))return Error('本机程序已重新打开，刚才的操作无法继续确认。请重新打开阅读窗口并核对已有内容。');
      return error;
    };
    const read=async(path:string,init:RequestInit={},timed=true)=>(await(await fetchHost(path,{...init,signal:timed?AbortSignal.any([commandStop.signal,AbortSignal.timeout(transportWait)]):commandStop.signal},false)).json()) as CommandStatus|CommandReceipt;
    // The acknowledgement clock must not cancel an unaccepted POST. A busy
    // host can read the body later than a lookup on another HTTP connection.
    // Keep that one POST alive and query only its ID; never submit it again.
    const posted=read('/command?async=1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)},false).then(value=>{postPending=false;postReply=value;return value;},error=>{postPending=false;postError=error;return undefined;});
    let acknowledgementTimer:ReturnType<typeof setTimeout>|undefined;
    try{
    try{reply=await Promise.race([posted,new Promise<undefined>(resolve=>{acknowledgementTimer=setTimeout(()=>resolve(undefined),transportWait);})]);}
    finally{clearTimeout(acknowledgementTimer);}
    let pollDelay=0;
    for(;;){
      if(closed)throw Error('伴读界面连接已关闭，已提交的内容仍保留。');
      const postStatus=statusOf(postError);if(postStatus&&postStatus>=400&&postStatus<500)throw commandFailure(postError);
      if(postReply){if(!reply)reply=postReply;postReply=undefined;}
      if(reply){
        if(reply.id!==request.id||'epoch'in reply&&reply.epoch!==request.epoch)throw Error('本机程序已更换，无法继续确认刚才的操作。请重新打开阅读窗口并核对已有内容。');
        if(!('state'in reply))return reply;
        if(reply.state==='complete'){if(!reply.receipt||reply.receipt.id!==request.id)throw Error('刚才操作的确认信息不完整，请核对已保存的内容。');return reply.receipt;}
        if(reply.state==='expired')throw Error('刚才操作的确认信息已过期。已有内容保留，请先核对结果后再决定下一步。');
        if(reply.state!=='accepted'&&reply.state!=='running')throw Error('暂时无法识别刚才操作的结果，请核对已保存的内容。');
        if(Date.now()-startedAt>=transportWait)pending('waiting');
      }else pending('confirming');
      if(pollDelay)await delay(pollDelay);
      try{reply=await read('/operations/'+encodeURIComponent(request.id)+'?epoch='+encodeURIComponent(request.epoch));}
      catch(error){
        if(closed)throw Error('伴读界面连接已关闭，已提交的内容仍保留。');
        const status=statusOf(error);
        if(status===404&&(postPending||postReply)){reply=undefined;}
        else if(status===404)throw Error('本机程序未能确认接收到刚才的操作。请先核对已有内容，再决定是否重新操作。');
        else if(status&&status>=400&&status<500)throw commandFailure(error);
        else reply=undefined;
      }
      pollDelay=Math.min(2000,pollDelay?pollDelay*2:250);
    }
    }finally{clearTimeout(acknowledgementTimer);commandStop.abort();if(clientOperations.delete(request.id))project();}
  };
  const target = {
    async reconnect(){if(redirected?.reconnect)return redirected.reconnect();streamAttempt?.abort();wakeStream?.();await synchronize();},
    async waitReadingDelay(milliseconds:number,signal:AbortSignal){
      if(redirected?.waitReadingDelay)return redirected.waitReadingDelay(milliseconds,signal);
      await(await fetchHost('/reading-delay?ms='+encodeURIComponent(Math.max(0,milliseconds)),{signal})).json();
    },
    getSnapshot: () => redirected?.getSnapshot()??snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async dispose() { closed = true; stop.abort();clientOperations.clear();redirectSubscription?.();await redirected?.dispose?.();await streamTask; listeners.clear(); },
    async importFile(file:File){
      if(redirected?.importFile)return redirected.importFile(file);
      const kind=/\.json$/i.test(file.name)?'backup':'text',source=kind==='text'?sourceFileFromSelection(file):undefined;
      const query=new URLSearchParams({kind,name:file.name,...(source?.path?{sourcePath:source.path}:{})});
      const response=await fetchHost('/imports?'+query,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});
      const result=await response.json();if(result.error)throw Error(result.error);if(result.connectArchiveId)await redirect(result.connectArchiveId);
    },
    async extendBookSourceFile(bookId:string,file:File,title?:string){
      if(redirected?.extendBookSourceFile)return redirected.extendBookSourceFile(bookId,file,title);
      const source=sourceFileFromSelection(file),query=new URLSearchParams({kind:'book-source',name:file.name,bookId,...(source.path?{sourcePath:source.path}:{}),...(title!==undefined?{title}:{})});
      const response=await fetchHost('/imports?'+query,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});
      const result=await response.json();if(result.error)throw Error(result.error);await synchronize();
    },
  };
  return new Proxy(target as unknown as WorkbenchClient, {
    get(object, key, receiver) {
      if (typeof key !== 'string' || !(workbenchCommands as readonly string[]).includes(key)) return Reflect.get(object, key, receiver);
      return (...args: unknown[]) => {
        if(redirected)return(redirected[key as keyof WorkbenchClient] as (...values:unknown[])=>unknown)(...args);
        if (closed) return Promise.reject(Error('伴读界面连接已关闭'));
        const browserArchive=key==='exportArchivedBackup'?snapshot.sessions.find(session=>session.id===args[0]&&session.archivedAt&&session.storageLocation==='browser'):undefined;
        if(browserArchive){if(import.meta.env?.VITE_YIXU_DESKTOP || window.yixuDesktop)return Promise.reject(Error('此存档仍在原浏览器，新客户端仅使用自己的正常存档'));return import('./store.ts').then(module=>module.exportArchivedWorkbenchBackup(String(args[0]),browserArchive)).then(text=>({name:'伴读归档备份-'+args[0]+'.json',text}));}
        if(key==='getPartnerAvatar')return fetchHost('/partner-avatars/'+encodeURIComponent(String(args[0]))).then(response=>response.json()).then(value=>value.dataUrl);
        // Never retry a command automatically. Domain receipts own actual side effects.
        const request = {id: crypto.randomUUID(), epoch, name: key, args};
        const task = commandReceipt(request).then(async receipt => { if (receipt.error) throw Error(receipt.error);const value=receipt.value as any;if(value?.connectArchiveId){await redirect(value.connectArchiveId);return;}
          if(value?.download)value.download={...value.download,url:new URL(value.download.path,url).href,token:connection.token};return value; });
        // A domain refusal belongs to its caller; it is not evidence that the
        // host stopped following. Transport failures are recorded by fetchHost.
        void task.catch(()=>{}); return task;
      };
    },
  });
}

/** Same-origin bootstrap returns a private host capability, never model credentials. */
export async function connectWorkbenchHost(progress: (message: string) => void = () => {}): Promise<WorkbenchClient> {
  if(import.meta.env?.VITE_YIXU_DESKTOP || window.yixuDesktop){
    progress('正在打开客户端自己的阅读存档…');
    const response=await fetch('/api/companionConnection',{method:'POST',headers:{'Content-Type':'application/json','X-Yixu-Client':'local-app'},body:JSON.stringify({action:'current'})});
    const connection=await response.json();if(!response.ok)throw Error(connection.error??'客户端存档尚未打开');
    return createRemoteWorkbenchClient(connection);
  }
  const {prepareCurrentArchive}=await import('./archive-migration.ts');
  return createRemoteWorkbenchClient(await prepareCurrentArchive(progress));
}
