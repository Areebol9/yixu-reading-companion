import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {randomBytes, timingSafeEqual,randomUUID,createHash} from 'node:crypto';
import {mkdir, writeFile, readFile, unlink,rename} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {ArchiveHost} from './archive-host.ts';
import type {HostRequest,HostFrame} from './contract.ts';
import {createReadStream,createWriteStream} from 'node:fs';
import {once} from 'node:events';
import {diffProjection} from './projection-delta.ts';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {bookSourceFile} from '../core/books.ts';

/** Loopback capability transport. SSE disconnect removes only a subscriber. */
export async function serveArchive(host: ArchiveHost, config: {port: number; directory: string; origins: string[]; shutdown?: () => Promise<void>}) {
  const token = randomBytes(32).toString('hex');
  const subscriptions = new Map<ServerResponse,()=>void>();
  let transportClosing=false;
  const endSubscription=(response:ServerResponse)=>{
    // A long response is still active when server.close() first checks idle
    // sockets. Flush its final bytes, then finish that read-only connection.
    const socket=response.socket;
    if(response.writableFinished)socket?.end();
    else{response.once('finish',()=>socket?.end());if(!response.writableEnded)response.end();}
  };
  const authorized = (request: IncomingMessage) => {
    const actual = Buffer.from(request.headers.authorization ?? ''), expected = Buffer.from('Bearer ' + token);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const json = (response: ServerResponse, status: number, value: unknown) => { response.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}); response.end(JSON.stringify(value)); };
  const server = createServer(async (request, response) => {
    try {
      const origin = request.headers.origin;
      if (origin && !config.origins.includes(origin)) return json(response, 403, {error: '此页面未绑定伴读宿主'});
      if (origin) response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      if (request.method === 'OPTIONS') { response.writeHead(204, {'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST'}); response.end(); return; }
      if (!authorized(request)) return json(response, 401, {error: '需要本机连接授权'});
      if(transportClosing){response.setHeader('Connection','close');return json(response,503,{error:'宿主已保存，正在关闭连接'});}
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if(request.method==='POST'&&path==='/imports'){
        const url=new URL(request.url!,'http://127.0.0.1'),kind=url.searchParams.get('kind'),name=url.searchParams.get('name')??'导入文本',bookId=url.searchParams.get('bookId')??undefined,title=url.searchParams.get('title')??undefined;
        if(kind!=='backup'&&kind!=='text'&&kind!=='book-source')return json(response,400,{error:'文件导入类型无效'});
        const sourcePath=kind==='backup'?undefined:bookSourceFile({name,path:url.searchParams.get('sourcePath')??undefined})?.path;
        if(kind==='book-source'&&(!bookId||bookId.length>200||title!==undefined&&(!title.trim()||title.length>200||/[\r\n\u0000-\u001f]/u.test(title))))return json(response,400,{error:'接续原文需要准确的bookId和有效书名'});
        const id=randomUUID(),directory=join(config.directory,'imports',id),filename=join(directory,'upload.bin'),receipt=join(directory,'progress.json');await mkdir(directory,{recursive:true});
        const state:Record<string,unknown>={schema:'yixu-file-import-v1',id,name,kind,stage:'uploading',startedAt:Date.now()};
        let recording=Promise.resolve();const progress=(stage:string,details:Record<string,unknown>={})=>{Object.assign(state,{stage,...details});const text=JSON.stringify(state);return recording=recording.then(async()=>{await writeFile(receipt+'.pending',text,{mode:0o600});await rename(receipt+'.pending',receipt);});};
        try{
          await progress('uploading');const digest=createHash('sha256');let bytes=0;
          await pipeline(request,new Transform({transform(chunk,_encoding,done){bytes+=chunk.length;digest.update(chunk);done(null,chunk);}}),createWriteStream(filename,{flags:'wx',mode:0o600}));
          const sha256=digest.digest('hex');await progress('uploaded',{bytes,sha256});
          const result=await host.importFile({filename,kind,name,sourcePath,...(kind==='book-source'?{bookId,title}:{}),bytes,sha256,progress});
          await progress('complete',{completedAt:Date.now()});await unlink(filename);return json(response,200,{id,bytes,sha256,status:'complete',...result});
        }catch(error){await progress('failed',{error:String(error),failedAt:Date.now()});throw error;}
      }
      if (request.method === 'POST' && path === '/shutdown' && config.shutdown) {
        json(response, 202, {accepted: true,archiveId:host.archiveId,epoch:host.epoch});
        void config.shutdown().catch(error => console.error('宿主正常收尾未完成：', error)); return;
      }
      if(request.method==='GET'&&path==='/lifecycle')return json(response,200,host.lifecycle());
      if(request.method==='GET'&&path.startsWith('/partner-avatars/')){const dataUrl=await host.partnerAvatar(path.slice('/partner-avatars/'.length));return json(response,dataUrl?200:404,{dataUrl});}
      if(request.method==='GET'&&path==='/status')return json(response,200,host.statusFrame());
      if(request.method==='POST'&&path==='/pause'){await host.pause();return json(response,200,host.lifecycle());}
      if (request.method === 'GET' && path === '/snapshot') return json(response, 200, host.frame());
      if(request.method==='GET'&&path.startsWith('/operations/')){
        const status=host.commandStatus(path.slice('/operations/'.length),new URL(request.url!,'http://127.0.0.1').searchParams.get('epoch')??'');
        return status?json(response,200,status):json(response,404,{error:'宿主未确认接收该操作，不能自动重新提交；请核对原操作标识与应用记录'});
      }
      // Transport clock only: it neither advances reading nor owns application state.
      // A host timer keeps browser background throttling out of the reading cadence.
      if(request.method==='GET'&&path==='/reading-delay'){
        const ms=Number(new URL(request.url!,'http://127.0.0.1').searchParams.get('ms'));
        if(!Number.isFinite(ms)||ms<0||ms>2_147_483_647)return json(response,400,{error:'阅读等待时间无效'});
        const timer=setTimeout(()=>json(response,200,{elapsed:true}),Math.ceil(ms));
        const cleanup=()=>{clearTimeout(timer);subscriptions.delete(response);};
        subscriptions.set(response,cleanup);response.once('close',cleanup);
        return;
      }
      if(request.method==='GET'&&path.startsWith('/exports/')){
        const progress=await host.exportStatus(path.slice('/exports/'.length));
        return progress?json(response,200,progress):json(response,404,{error:'未找到该导出进度，原命令结果仍须核实，请勿自动重发'});
      }
      if(request.method==='GET'&&path.startsWith('/downloads/')){
        const item=await host.download(path.slice('/downloads/'.length));if(!item)return json(response,404,{error:'该导出尚未就绪，请查询原导出进度'});
        response.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Content-Length':item.bytes,'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(item.name),'X-Content-SHA256':item.sha256,'Access-Control-Expose-Headers':'X-Content-SHA256, Content-Length, Content-Disposition'});
        const stream=createReadStream(item.filename);stream.on('error',()=>response.destroy());response.once('close',()=>stream.destroy());stream.pipe(response);return;
      }
      if (request.method === 'GET' && path === '/events') {
        let previous:HostFrame|undefined,latest:HostFrame|undefined,sending=false,closed=false,ready=false,unsubscribe:(()=>void)|undefined,scheduled:NodeJS.Immediate|undefined;
        const cleanup=()=>{if(closed)return;closed=true;if(scheduled)clearImmediate(scheduled);unsubscribe?.();subscriptions.delete(response);};response.once('close',cleanup);
        const pump=async()=>{
          if(sending||closed)return;sending=true;
          try{while(latest&&!closed){const frame=latest;latest=undefined;
            const value=previous&&(previous.snapshot as {sessionId?:string}).sessionId===(frame.snapshot as {sessionId?:string}).sessionId?{epoch:frame.epoch,sequence:frame.sequence,baseSequence:previous.sequence,patch:diffProjection(previous.snapshot,frame.snapshot),events:frame.events}:frame;
            if(!response.write('data: '+JSON.stringify(value)+'\n\n'))await new Promise<void>((resolve,reject)=>{const clean=()=>{response.off('drain',drain);response.off('close',close);response.off('error',error);};const drain=()=>{clean();resolve();},close=()=>{clean();resolve();},error=(failure:Error)=>{clean();reject(failure);};response.once('drain',drain);response.once('close',close);response.once('error',error);});previous=frame;
          }}catch(error){if(!closed){console.error('伴读事件流发送未完成：',error);cleanup();response.end();}}finally{sending=false;}
        };
        const schedule=()=>{if(sending||scheduled||closed)return;scheduled=setImmediate(()=>{scheduled=undefined;void pump();});};
        // Register before preparing the first frame so shutdown also owns a
        // subscriber that is still awaiting reconnect/save preparation.
        subscriptions.set(response,cleanup);
        try{unsubscribe=await host.subscribe(frame=>{latest=frame;if(ready)schedule();});}
        catch(error){cleanup();console.error('伴读事件连接准备未完成：',error);throw error;}
        if(closed||transportClosing){unsubscribe();if(!response.writableEnded)endSubscription(response);return;}
        // Reconnect may save application state. Its error must remain a normal
        // JSON response, not an empty successful SSE stream before first frame.
        response.writeHead(200, {'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive'});
        ready=true;schedule();return;
      }
      if (request.method === 'POST' && path === '/command') {
        let size = 0; const chunks: Buffer[] = [];
        for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 32 * 1024 * 1024) throw Error('操作过大，请使用正文分块导入入口'); chunks.push(bytes); }
        const input=JSON.parse(Buffer.concat(chunks).toString('utf8')) as HostRequest;
        if(new URL(request.url!,'http://127.0.0.1').searchParams.get('async')==='1')return json(response,202,host.acceptCommand(input));
        const result = await host.command(input);
        return json(response, 200, result);
      }
      return json(response, 404, {error: '未知宿主入口'});
    } catch (error) { if (!response.headersSent) json(response, 409, {error: error instanceof Error ? error.message : String(error)}); else response.end(); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw Error('宿主监听地址不可用');
  const connection = {schema: 'yixu-companion-connection-v1', pid: process.pid, archiveId: host.archiveId, epoch: host.epoch, url: `http://127.0.0.1:${address.port}`, token};
  await mkdir(config.directory, {recursive: true});
  await writeFile(join(config.directory, 'connection.json'), JSON.stringify(connection), {mode: 0o600});
  const aliases=new Set([config.directory]);let active=host.archiveId, writing=Promise.resolve();
  const stopAliases=host.observeArchive(id=>{
    if(id===active)return;active=id;
    writing=writing.then(async()=>{const directory=join(dirname(config.directory),id);await mkdir(directory,{recursive:true});await writeFile(join(directory,'connection.json'),JSON.stringify({...connection,archiveId:id}),{mode:0o600});aliases.add(directory);});
    void writing.catch(error=>console.error('当前存档连接发布未完成：',error));
  });
  let transportClosed=false;
  return async () => {
    transportClosing=true;
    stopAliases();await writing;
    for (const [response,cleanup] of subscriptions){cleanup();endSubscription(response);}
    if(!transportClosed){await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));transportClosed=true;}
    for(const directory of aliases){const path = join(directory, 'connection.json');
      try { if (JSON.parse(await readFile(path, 'utf8')).epoch === host.epoch) await unlink(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  };
}
