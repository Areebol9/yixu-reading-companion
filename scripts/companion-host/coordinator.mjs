import {mkdir, readFile, writeFile, rename, rm, access, opendir} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {NodeStore} from '../../src/host/node-store.ts';
import {SessionRepository} from '../../src/host/session-repository.ts';
import {startCompanionHost} from './start.mjs';
import {readReadingProject} from '../../src/host/reading-project.ts';

const sha = text => createHash('sha256').update(text).digest('hex');
const validId = id => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id);
const exists = async file => { try { await access(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };

/** Same-origin startup and one current-archive migration, not a model gateway. */
export function createCompanionCoordinator(workspaceRoot,{startHost=startCompanionHost,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
  const dataRoot = resolve(workspaceRoot, process.env.YIXU_COMPANION_DATA_ROOT??'.local/companion-host/data');
  const home=resolve(workspaceRoot,process.env.YIXU_COMPANION_HOME??'.local/companion-host/dsh-home');
  const transfers = new Map(), starting = new Map(), liveConnections=new Map(), owners=new Map();
  let shuttingDown=false,openingCurrent;
  const directory = id => join(dataRoot, 'archives', id);
  const catalogFile=join(dataRoot, 'sessions.json');
  const repository = () => new SessionRepository(catalogFile, async () => { throw Error('迁移入口不导出归档'); });
  const hasArchiveDirectoryEntry=async()=>{
    let directory;
    try{directory=await opendir(join(dataRoot,'archives'));}catch(error){if(error.code==='ENOENT')return false;throw error;}
    try{return !!await directory.read();}finally{await directory.close();}
  };
  const publishMigrationCatalog=async receipt=>{
    const repo=repository();
    if(!validId(receipt.session?.id)||!Array.isArray(receipt.metadata))throw Error('迁移收据缺少原存档目录，未建立替代空档');
    for(const session of receipt.metadata)if(validId(session.id)&&['offline','live'].includes(session.mode)&&!repo.list().some(item=>item.id===session.id))repo.remember({...session,storageLocation:session.id===receipt.archiveId?'host':'browser'});
    const current=repo.list().find(session=>session.id===receipt.archiveId);
    if(!current)repo.remember({...receipt.session,storageLocation:'host'});
    else if(current.storageLocation==='browser')repo.remember({...current,storageLocation:'host'});
    if(!repo.active())repo.markActive(receipt.archiveId);
    await repo.flush();
  };
  const connection = async id => {
    try {
      const value = JSON.parse(await readFile(join(directory(id), 'connection.json'), 'utf8'));
      const url=new URL(value.url);
      if (value.schema!=='yixu-companion-connection-v1'||value.archiveId !== id || url.protocol!=='http:'||url.hostname !== '127.0.0.1'||!Number.isSafeInteger(value.pid)||value.pid<1||typeof value.epoch!=='string'||!value.epoch||!/^[a-f0-9]{64}$/.test(value.token)) throw Error('宿主连接身份不符');
      const response = await fetch(new URL('/lifecycle', url), {headers: {Authorization: 'Bearer ' + value.token}, signal: AbortSignal.timeout(2000)});
      if (!response.ok) return; const frame=await response.json();
      if(frame.epoch!==value.epoch)return;
      if(frame.archiveId!==id)throw Error('该宿主已切换到另一正常存档，请从当前入口重新选择原存档；未自动切档');
      return value;
    } catch (e) { if (e.code === 'ENOENT' || e instanceof TypeError || e.name === 'TimeoutError') return; throw e; }
  };
  const bindOwner=(owner,value)=>{
    if(!owner||owner.exited||owner.error||owner.archiveId!==value.archiveId||owner.pid!==value.pid||owner.child.pid!==value.pid)return false;
    if(owner.connection&&owner.connection.epoch!==value.epoch)throw Error('自有宿主连接的epoch已变化，未接管其他进程');
    owner.connection=value;liveConnections.set(owner.archiveId,value);return true;
  };
  const bindAvailableOwner=async owner=>{if(owner.connection)return owner.connection;const value=await connection(owner.archiveId);return value&&bindOwner(owner,value)?value:undefined;};
  const startupFailure=async owner=>{
    if(owner.error)return owner.error;
    try{const value=JSON.parse(await readFile(join(directory(owner.archiveId),'startup.json'),'utf8'));if(value.archiveId===owner.archiveId&&value.pid===owner.pid&&value.stage==='failed')return value.error??'宿主启动失败';}
    catch(error){if(error.code!=='ENOENT')console.warn('伴读启动诊断读取失败：',error.message);}
  };
  const waitForOwnerConnection=async owner=>{
    for(;;){
      const failure=await startupFailure(owner);if(failure)throw Error('官方伴读宿主启动失败：'+failure);
      if(owner.exited)throw Error('官方伴读宿主启动失败：'+JSON.stringify(owner.exited));
      const value=await bindAvailableOwner(owner);if(value)return value;
      await wait(200);
    }
  };
  async function connect(id, origin) {
    if(shuttingDown)throw Error('客户端正在收取回复并保存，暂不打开其他存档');
    if (!validId(id)) throw Error('阅读存档身份无效');
    if (!await exists(join(directory(id), 'domain.sqlite'))) throw Error('上次阅读的存档文件暂时无法找到。请检查原存放位置后重新打开；已有记录保持原样。');
    const owned=owners.get(id);
    if(owned?.exited){const failure=await startupFailure(owned);throw Error('原阅读宿主已退出'+(failure?'：'+failure:'')+'，退出情况已保留；请关闭客户端后重新打开原存档，未自动重启或重发请求');}
    if(owned&&!owned.exited){if(owned.error)throw Error(owned.error);return waitForOwnerConnection(owned);}
    const current = await connection(id);
    if(current){
      if(process.env.YIXU_DESKTOP==='1'&&!bindOwner(owners.get(id),current))throw Error('这份存档仍有另一启动层的后台运行，当前客户端未接管它；请先从原应用正常退出，原存档与后台保持');
      return current;
    }
    // An archive switch can publish to the page before its connection alias reaches disk.
    // Resolve only the launchers this coordinator already owns; never spawn a competing writer.
    for(const value of liveConnections.values())try{
      const response=await fetch(new URL('/snapshot',value.url),{headers:{Authorization:'Bearer '+value.token},signal:AbortSignal.timeout(2000)});
      if(response.ok){const frame=await response.json();if(frame.epoch===value.epoch&&frame.snapshot?.sessionId===id)return{...value,archiveId:id};}
    }catch{}
    if (starting.has(id)) return starting.get(id);
    const task = (async () => {
      const child = await startHost(['--archive', id, '--domain-module', join(workspaceRoot, 'src/host/domain.ts'),'--data-root',dataRoot,'--home',home, '--origin', origin]);
      const owner={archiveId:id,pid:child.pid,child,connection:undefined,exit:undefined,exited:undefined};
      owner.exit=new Promise((resolve,reject)=>{
        child.once('exit',(code,signal)=>{
          owner.exited={code,signal};
          owner.exitRecord=(async()=>{
            let epoch=owner.connection?.epoch;
            if(!epoch)try{const value=JSON.parse(await readFile(join(directory(id),'connection.json'),'utf8'));if(value.archiveId===id&&value.pid===owner.pid)epoch=value.epoch;}catch{}
            const record={archiveId:id,pid:owner.pid,epoch:epoch??null,code,signal,time:Date.now()},file=join(directory(id),'host-exit.json'),pending=file+'.'+randomUUID()+'.tmp';
            await writeFile(pending,JSON.stringify(record),{mode:0o600});await rename(pending,file);
          })().catch(error=>{owner.exitRecordError=error.message;});
          void owner.exitRecord.then(()=>resolve(owner.exited));
        });
        child.once('error',error=>{owner.error=error.message;reject(error);});
      });void owner.exit.catch(()=>{});owners.set(id,owner);
      child.once('exit', () => {liveConnections.delete(id);if(starting.get(id)===task)starting.delete(id);});
      return waitForOwnerConnection(owner);
    })();
    // Keep a failed startup promise: a new request must not spawn a duplicate owner.
    starting.set(id, task); return task;
  }
  const companionConnection=async function(input, origin) {
    if(shuttingDown)throw Error('客户端正在收取回复并保存，暂不接纳新操作');
    if (!origin || !['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) throw Error('宿主仅接收本机同源页面');
    if (input.action === 'connect') return connect(input.archiveId, origin);
    if (input.action === 'new'||input.action==='current') {
      return openingCurrent??=(async()=>{
      if(process.env.YIXU_OPENED_PROJECT_DIRECTORY){
        const project=await readReadingProject(process.env.YIXU_OPENED_PROJECT_DIRECTORY);
        if(project.archiveId!==process.env.YIXU_OPENED_PROJECT_ARCHIVE_ID||resolve(dataRoot)!==resolve(process.env.YIXU_OPENED_PROJECT_DIRECTORY,'data'))throw Error('所选工程与启动位置不一致，请重新打开工程。');
        const repo=repository();
        if(!repo.list().some(item=>item.id===project.archiveId))repo.remember({id:project.archiveId,mode:'live',title:project.title,createdAt:project.createdAt,storageLocation:'host'});
        repo.markActive(project.archiveId);await repo.flush();
        return connect(project.archiveId,origin);
      }
      // Browser migration uses "new" for startup with no browser archive. Explicit
      // archive creation belongs to the application's createSession command.
      let catalog;
      try{catalog=SessionRepository.readCatalog(catalogFile);}catch(error){throw Error('无法读取阅读存档目录：'+error.message+'；原资料保留，未创建替代空档');}
      if(catalog?.activeId!==undefined){
        const active=catalog.sessions.find(session=>session.id===catalog.activeId&&!session.archivedAt);
        if(!active)throw Error('当前阅读存档在目录中缺失或已归档；未切换其他存档或创建空档');
        if(active.storageLocation==='browser')throw Error('当前阅读存档仍在原浏览器，请从原入口完成迁移；未创建替代空档');
        return connect(active.id,origin);
      }
      if(catalog?.sessions.length)throw Error('阅读存档目录已有记录，但当前存档未登记；未替换为其他存档或空档');
      // Looking at one directory entry is enough to distinguish a pristine data
      // root from a lost catalog. Never enumerate or adopt historical archives.
      if(await hasArchiveDirectoryEntry())throw Error('发现已有存档目录，但阅读存档索引缺失或为空；原资料保留，未创建替代空档');
      const id = randomUUID(), repo = repository();
      // Desktop begins with an empty live archive; only browser rehearsal gets a guide.
      const mode=process.env.YIXU_DESKTOP==='1'?'live':'offline';
      const store = new NodeStore(join(directory(id), 'domain.sqlite'));
      const {initialWorkbenchState} = await import('../../src/workbench/runtime.ts');
      try { await store.save(initialWorkbenchState(mode)); } finally { await store.close(); }
      await writeFile(join(directory(id), 'new-user.json'), JSON.stringify({archiveId:id}), {mode:0o600});
      repo.remember({id, mode, title:mode==='live'?'真实共读':'界面演示', createdAt: Date.now(), storageLocation: 'host'}); repo.markActive(id); await repo.flush();
      return connect(id, origin);
      })().finally(()=>{openingCurrent=undefined;});
    }
    if(process.env.YIXU_DESKTOP==='1')throw Error('新客户端使用自己的存档；原浏览器资料保持原位，请显式导入新版完整备份');
    if (input.action === 'prepare') {
      const {session, metadata} = input;
      if (!validId(session?.id) || !['offline', 'live'].includes(session.mode) || session.archivedAt || !Array.isArray(metadata) || !metadata.some(item => item.id === session.id)) throw Error('当前正常存档身份不完整');
      if (await exists(join(directory(session.id), 'domain.sqlite'))) {
        if (!await exists(join(directory(session.id), 'browser-migration.json'))) throw Error('同名宿主存档已有不同来源，未覆盖');
        return {phase: 'verify-existing'};
      }
      const previous = [...transfers.entries()].find(([,item]) => item.session.id === session.id);
      if (previous) {
        await previous[1].tail.catch(()=>{}); await previous[1].store.close().catch(()=>{});
        // Preserve a failed unpublished staging copy; never overwrite the source or reuse partial rows.
        transfers.delete(previous[0]);
      }
      const transferId = randomUUID(), stage = join(dataRoot, 'migration', transferId); await mkdir(stage, {recursive: true});
      const store = new NodeStore(join(stage, 'domain.sqlite'));
      transfers.set(transferId, {session, metadata, stage, store, index: 0, part: 0, digest: '', tail: Promise.resolve()});
      return {phase: 'migration-required', transferId};
    }
    if (input.action === 'part') {
      const transfer = transfers.get(input.transferId); if (!transfer) throw Error('迁移传输不存在；原存档未更改');
      const operation = transfer.tail.then(async () => {
        const {index, part, parts, text, hash} = input;
        if (index !== transfer.index || part !== transfer.part || !Number.isSafeInteger(parts) || parts < 1 || typeof text !== 'string' || text.length > 200000 || !/^[a-f0-9]{64}$/.test(hash)) throw Error('迁移分块次序或身份不符');
        if (!part) { transfer.parts = parts; transfer.hash = hash; }
        if (transfer.parts !== parts || transfer.hash !== hash) throw Error('迁移记录在传输中变化');
        await writeFile(join(transfer.stage, 'row-' + part), text, {encoding: 'utf16le', mode: 0o600}); transfer.part++;
        if (transfer.part === parts) {
          const buffers = []; for (let i = 0; i < parts; i++) buffers.push(await readFile(join(transfer.stage, 'row-' + i)));
          const raw = Buffer.concat(buffers).toString('utf16le'); if (sha(raw) !== hash) throw Error('迁移记录摘要不符');
          const record = JSON.parse(raw); await transfer.store.importBrowserRecord(record.store, record.key, record.value);
          transfer.digest = sha(transfer.digest + hash); transfer.index++; transfer.part = 0;
          for (let i = 0; i < parts; i++) await rm(join(transfer.stage, 'row-' + i));
        }
        return {accepted: true, index, part};
      });
      transfer.tail = operation; return operation;
    }
    if (input.action === 'commit') {
      if (!validId(input.archiveId)) throw Error('存档身份无效');
      const transfer = transfers.get(input.transferId);
      if (!transfer) {
        const receipt = JSON.parse(await readFile(join(directory(input.archiveId), 'browser-migration.json'), 'utf8'));
        if (JSON.stringify(receipt.manifest) !== JSON.stringify(input.manifest)) throw Error('同名存档与原浏览器内容有差异，未覆盖');
        await publishMigrationCatalog(receipt);
        return connect(input.archiveId, origin);
      }
      await transfer.tail;
      if (transfer.session.id !== input.archiveId || transfer.part || transfer.index !== input.manifest?.count || transfer.digest !== input.manifest?.digest) throw Error('迁移完整摘要不符，未发布');
      const verified = await transfer.store.validateBrowserImport(); await transfer.store.close();
      const receipt={schema:'yixu-browser-migration-v1',archiveId:input.archiveId,manifest:input.manifest,verified,session:transfer.session,metadata:transfer.metadata,migratedAt:Date.now()};
      await writeFile(join(transfer.stage, 'browser-migration.json'), JSON.stringify(receipt), {mode: 0o600});
      await mkdir(join(dataRoot, 'archives'), {recursive: true});
      if (await exists(directory(input.archiveId))) throw Error('目标存档已存在，未覆盖');
      await rename(transfer.stage, directory(input.archiveId));
      await publishMigrationCatalog(receipt);transfers.delete(input.transferId);
      return connect(input.archiveId, origin);
    }
    throw Error('未知的宿主连接操作');
  };
  const requestOwner=async(owner,path,method='GET')=>{
    if(!owner.connection)await waitForOwnerConnection(owner);
    const response=await fetch(new URL(path,owner.connection.url),{method,headers:{Authorization:'Bearer '+owner.connection.token},signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw Error('宿主管理操作未完成：'+response.status+' '+await response.text());
    const result=await response.json();if(result.epoch!==owner.connection.epoch)throw Error('宿主身份已变化，未操作其他进程');return result;
  };
  // Read-only lookup never launches a host, changes archive selection or opens
  // a new owner. It remains available while shutdown drains existing work.
  companionConnection.readConnection=async({archiveId}={})=>{
    const id=archiveId??SessionRepository.readCatalog(catalogFile)?.activeId;
    if(!validId(id))throw Error('当前没有已打开的阅读存档');
    // The child exit event owns liveness. A busy event loop can delay an HTTP
    // probe without closing its connection or authorizing a second writer.
    const owned=owners.get(id);
    if(owned?.exited){const failure=await startupFailure(owned);throw Error('当前阅读宿主已退出'+(failure?'：'+failure:'')+'，原存档与未完成请求保持；请查看退出记录');}
    if(owned?.connection&&!owned.exited&&!owned.error)return owned.connection;
    const value=await connection(id);
    if(!value)throw Error('当前存档已关闭连接，请查看客户端退出状态');
    if(process.env.YIXU_DESKTOP==='1'&&![...owners.values()].some(owner=>!owner.exited&&owner.pid===value.pid&&owner.connection?.epoch===value.epoch))throw Error('此存档不属于当前客户端的已打开宿主');
    return value;
  };
  companionConnection.isShuttingDown=()=>shuttingDown;
  companionConnection.ownedHosts=async()=>({schema:'yixu-owned-hosts-v1',shuttingDown,hosts:await Promise.all([...owners.values()].map(async owner=>{
    if(owner.exited){const failure=await startupFailure(owner);return{archiveId:owner.archiveId,pid:owner.pid,epoch:owner.connection?.epoch,phase:owner.exited.code===0?'closed':'failed',exit:owner.exited,...(failure?{error:failure}:{}),...(owner.exited.code!==0?{saveStatus:'unconfirmed'}:{}),...(owner.exitRecordError?{exitRecordError:owner.exitRecordError}:{})};}
    if(!owner.connection)try{await bindAvailableOwner(owner);if(!owner.connection){const failure=await startupFailure(owner);return{archiveId:owner.archiveId,pid:owner.pid,phase:failure?'failed':'opening',...(failure?{error:failure}:{})};}}catch(error){return{archiveId:owner.archiveId,pid:owner.pid,phase:'unavailable',error:error instanceof Error?error.message:String(error)};}
    try{return{...await requestOwner(owner,'/lifecycle'),pid:owner.pid};}
    catch(error){return{archiveId:owner.archiveId,pid:owner.pid,phase:'unavailable',error:error instanceof Error?error.message:String(error)};}
  }))});
  companionConnection.pauseOwned=async()=>{
    await Promise.allSettled([...starting.values()]);
    await Promise.all([...owners.values()].filter(owner=>!owner.exited).map(owner=>requestOwner(owner,'/pause','POST')));
    return companionConnection.ownedHosts();
  };
  let shutdown;
  companionConnection.shutdownOwned=()=>shutdown??=(async()=>{
    shuttingDown=true;await Promise.allSettled([...starting.values()]);
    await Promise.all([...owners.values()].map(async owner=>{
      if(!owner.exited){
        try{await requestOwner(owner,'/shutdown','POST');}catch(error){if(!owner.exited)throw error;}
        while(!owner.exited){
          let state;try{state=await requestOwner(owner,'/lifecycle');}catch{/* Transport can close before the official launcher finishes exiting. */}
          if(state?.phase==='failed')throw Error(state.error??'宿主保存尚未完成，请修复原因后再次退出');
          if(!owner.exited)await Promise.race([owner.exit,new Promise(resolve=>setTimeout(resolve,500))]);
        }
      }
      // A dead owner cannot collect or confirm more work. Retain its failed
      // lifecycle and unconfirmed save state while allowing its desktop to close.
      if(owner.exitRecord)await owner.exitRecord;
    }));
    return companionConnection.ownedHosts();
  })().catch(error=>{shutdown=undefined;throw error;});
  return companionConnection;
}
