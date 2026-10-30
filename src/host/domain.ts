import {join, dirname} from 'node:path';
import {WorkbenchController} from '../workbench/runtime.ts';
import {workbenchCommands} from '../workbench/contract.ts';
import {WorkerHarnessRuntime} from '../agent/worker-runtime.ts';
import {HarnessFactReviewer} from '../agent/fact-reviewer.ts';
import {createNativeSessionReader,createNativeSessionStreamReader,relocateNativeSession,installNativeProductSessionEvents} from '../agent/session-persistence.ts';
import {NodeStore} from './node-store.ts';
import {DomainComputation} from './domain-computation.ts';
import {SessionRepository} from './session-repository.ts';
import {BookProjectRegistry} from './project-registry.ts';
import {ownArchive} from './owner.ts';
import {access, unlink,readFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {ArchiveDownloads} from './downloads.ts';
import {readJsonFile} from './json-reader.ts';
import {isPortableBackup,readPortableBackup} from './content-object-backup.ts';
import {createNativePrefixReader,createNativeConversationCheckpointReader} from './content-object-native.ts';
import {recoverCommittedSessions} from '../agent/committed-recovery.ts';
import type {HostDomainFactory} from './contract.ts';
import type {Context} from '@deepseek-ai/cordis';
import * as OfficialJsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import {createNativeSpillStreamReader,restoreNativeSpills} from '../agent/spill.ts';
import {providerBridge} from './provider-gateway.ts';

/** File transport only. Ownership, version proof and saving stay in the normal
 * application operation, after the explicitly selected archive is paused. */
export async function importBookSourceFile(controller:Pick<WorkbenchController,'getSnapshot'|'extendBookSource'>,input:{filename:string;bookId?:string;title?:string}){
  const snapshot=controller.getSnapshot(),control=snapshot.app.readingControl;
  if(!input.bookId||!snapshot.app.state.books.some(book=>book.id===input.bookId)||snapshot.following||snapshot.busyAction||snapshot.app.busy||control?.state==='running'||control?.state==='stopping'||control?.inFlight)throw Error('请先暂停并收好当前请求，再接续指定书籍的完整原文');
  const {decodeBook}=await import('../core/books.ts'),bytes=await readFile(input.filename);
  await controller.extendBookSource(input.bookId,decodeBook(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer),input.title);
}

const factory: HostDomainFactory = {
  async openArchive({archiveId, archiveDirectory, dshContext, projectRegistry}) {
    const dataRoot = dirname(dirname(archiveDirectory));
    const stores = new Map<string, NodeStore>(), projects = new Map([[archiveId, projectRegistry]]);
    let portableImport:NodeStore|undefined;
    const bridge = await providerBridge();
    const computation=new DomainComputation();
    const releaseNativeEvents=installNativeProductSessionEvents(dshContext);
    const sessions = new SessionRepository(join(dataRoot, 'sessions.json'), async id => {
      throw Error('归档导出须走宿主分块下载；浏览器原件保留在原归档入口');
    });
    const downloads=new ArchiveDownloads(join(dataRoot,'downloads'),id=>id===archiveId||sessions.list().some(session=>session.id===id&&session.archivedAt&&session.storageLocation!=='browser'));
    const registry = (id: string) => {
      if(id!==archiveId)throw Error('书籍工程仅由所属存档launcher拥有');return projectRegistry;
    };
    const createStore = async (id: string) => {
      const directory = join(dataRoot, 'archives', id);
      if (sessions.list().find(session => session.id === id)?.storageLocation === 'browser') throw Error('此存档保留在原浏览器，尚未迁移；请从原存档入口完成迁移后打开');
      const filename=join(directory,'domain.sqlite');
      if(id===archiveId)await access(filename);
      if(portableImport&&id!==archiveId){await mkdir(directory,{recursive:true});await portableImport.createExportSnapshot(filename);}
      const store = new NodeStore(filename,join(dataRoot,'receipts'));
      if(id===archiveId){store.readNativeAgentSession = createNativeSessionReader(dshContext,join(process.env.DSH_HOME!,'archives',id,'sessions'));store.readNativeAgentSessionStream=createNativeSessionStreamReader(dshContext,join(process.env.DSH_HOME!,'archives',id,'sessions'));store.readNativeAgentOriginal=createNativePrefixReader(join(process.env.DSH_HOME!,'archives',id,'sessions'),store.readNativeAgentSessionStream);store.readNativeConversationCheckpoint=createNativeConversationCheckpointReader(join(process.env.DSH_HOME!,'archives',id,'sessions'));store.readNativeAgentSpills=createNativeSpillStreamReader();stores.set(id, store);}return store;
    };
    let controller: WorkbenchController;
    const synchronizeProjects=async()=>{const snapshot=controller.getSnapshot();for(const book of snapshot.app.state.books)await registry(snapshot.sessionId).ensure(book);for(const partner of snapshot.app.state.partners)await registry(snapshot.sessionId).ensurePartner(partner);};
    try {
      controller = await WorkbenchController.create({sessions, createStore, initialArchiveId: archiveId,fixedArchiveId:archiveId, browserEvents: false,developerMode:process.env.YIXU_DESKTOP!=='1'||process.env.YIXU_DEVELOPER_MODE==='1',
        createHarness: () => new WorkerHarnessRuntime(join(process.env.DSH_HOME!,'archives',archiveId)), bridge: bridge.request,
        createFactReviewer(runner){if(!(runner instanceof WorkerHarnessRuntime))throw Error('事实核对必须使用同一宿主原生runtime');return new HarnessFactReviewer(runner);},
        async initializeEngine(id,engine){
          engine.computationPort=computation;
          await engine.initializeNativeSessions(async input=>{
            const record=engine.state.agentSessions?.find(record=>record.native?.sessionId===input.reference.sessionId),book=engine.state.books.find(book=>book.id===record?.bookId);if(!book)throw Error('原生会话所属书籍不存在');
            const projectDirectory=(await registry(id).ensure(book)).executionDirectory;
            return restoreNativeSpills({...input,projectDirectory,reference:await relocateNativeSession(dshContext,{...input,projectDirectory,nativeRoot:join(process.env.DSH_HOME!,'archives',id,'sessions')})});
          });
          const report=await recoverCommittedSessions({context:dshContext,engine,projectDirectory:async bookId=>{const book=engine.state.books.find(book=>book.id===bookId);if(!book)throw Error('冷恢复任务所属书籍不存在');return(await registry(id).ensure(book)).executionDirectory;}});
          for(const item of report)if(item.error)console.warn('原生提交收妥保留原任务：',item.sessionId,item.error);
        },
        async projectDirectory(id, bookId) {
          const state = stores.get(id)?.readProjectionState(), book = state?.books.find(book => book.id === bookId); if (!book) throw Error('任务所属书籍不存在');
          return (await registry(id).ensure(book)).directory;
        },
        async sessionDirectory(id,bookId){
          const state=stores.get(id)?.readProjectionState(),book=state?.books.find(book=>book.id===bookId);if(!book)throw Error('任务所属书籍不存在');
          return(await registry(id).ensure(book)).executionDirectory;
        },
        async getBookProjectLocations(id){return registry(id).getLocations();},
        async setBookProjectRootDirectory(id,rootDirectory){return registry(id).setRootDirectory(rootDirectory);},
        async attachAgentSession(id, bookId, sessionId) { await registry(id).attachSession(bookId, sessionId); },
        async prepareExport(input){
          if(controller?.getSnapshot().sessionId===input.archiveId){const store=stores.get(input.archiveId);if(!store)throw Error('导出所属存档未打开');return downloads.prepare(store,input);}
          if(!sessions.list().some(session=>session.id===input.archiveId&&session.archivedAt&&session.storageLocation!=='browser'))throw Error('归档尚在原浏览器，原件保持');
          const file=join(dataRoot,'archives',input.archiveId,'domain.sqlite');await access(file);const store=new NodeStore(file,join(dataRoot,'receipts'));
          const isolated=dshContext.isolate('sessionPersistence'),fork=isolated.plugin(OfficialJsonl,{root:join(process.env.DSH_HOME!,'archives',input.archiveId,'sessions')});
          try{await fork.await();store.readNativeAgentSessionStream=createNativeSessionStreamReader(isolated,join(process.env.DSH_HOME!,'archives',input.archiveId,'sessions'));store.readNativeAgentOriginal=createNativePrefixReader(join(process.env.DSH_HOME!,'archives',input.archiveId,'sessions'),store.readNativeAgentSessionStream);store.readNativeConversationCheckpoint=createNativeConversationCheckpointReader(join(process.env.DSH_HOME!,'archives',input.archiveId,'sessions'));store.readNativeAgentSpills=createNativeSpillStreamReader();return await downloads.prepare(store,input);}finally{await store.close();await fork.dispose();}
        },
      });
      try {
        await access(join(archiveDirectory, 'new-user.json'));
        if (controller.getSnapshot().mode==='offline'&&!controller.getSnapshot().app.state.books.length) {const {offlineGuide}=await import('../workbench/offline-model.ts');await controller.importTxt(offlineGuide.title,offlineGuide.text);}
        await unlink(join(archiveDirectory, 'new-user.json'));
      } catch (error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      await synchronizeProjects();
    } catch (error) { for (const store of stores.values()) await store.close().catch(() => {}); await computation.dispose();await bridge.close();releaseNativeEvents(); throw error; }
    return {
      client: {getSnapshot: controller.getSnapshot, subscribe: controller.subscribe,
        async command(name, ...args) {
          if (!(workbenchCommands as readonly string[]).includes(name)) throw Error('未知工作台命令');
          if(process.env.YIXU_DESKTOP==='1'&&['importBackup','importSource'].includes(name))throw Error('请通过添加书籍或备份入口显式导入新版完整备份');
          const result=await (controller[name as typeof workbenchCommands[number]] as (...args: unknown[]) => unknown).apply(controller, args);
          const connectArchiveId=['importBackup','importSource','createSession','switchMode','openSession','createPartner','adoptPartnerPersona'].includes(name)?controller.takeConnectionTarget():undefined;
          if(['importTxt','importBackup','importSource','createSession','switchMode','openSession'].includes(name))await synchronizeProjects();
          return connectArchiveId?{connectArchiveId}:result;
        },
      },
      flush: () => controller.flush(), stop: () => controller.stop(), pause:()=>controller.pause(),
      detachReadingSource: () => controller.detachReadingSource(), reconnectClient: () => controller.reconnectClient(),
      partnerAvatar:id=>controller.getPartnerAvatar(id),
      download:id=>downloads.get(id),
      exportStatus:id=>downloads.status(id),
      async importFile(input){
        await input.progress('validating');
        if(input.kind==='backup'){
          let last=Promise.resolve(),reported=performance.now();const progress=(collection:string,count:number)=>{if(performance.now()-reported>=500){reported=performance.now();last=last.then(()=>input.progress('parsing',{collection,count}));}};
          if(await isPortableBackup(input.filename)){
            if(portableImport)throw Error('Another portable import is already being published');
            const staging=new NodeStore(join(dataRoot,'imports',randomUUID(),'domain.sqlite'));
            try{const state=await readPortableBackup(input.filename,staging,progress);await last;await input.progress('validating');portableImport=staging;await controller.importBackupState(state);}
            finally{portableImport=undefined;await staging.close();}
          }else{if(process.env.YIXU_DESKTOP==='1')throw Error('新客户端仅接收新版完整便携备份，原文件保持');const parsed=await readJsonFile(input.filename,progress);await last;await input.progress('validating');await controller.importBackupState(parsed);}
        }else if(input.kind==='book-source')await importBookSourceFile(controller,input);
        else{const {decodeBook}=await import('../core/books.ts');const bytes=await readFile(input.filename);await controller.importTxt(input.name,decodeBook(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer));}
        const connectArchiveId=input.kind==='backup'?controller.takeConnectionTarget():undefined;await synchronizeProjects();await controller.flush();await input.progress('published',{archiveId:connectArchiveId??archiveId});return connectArchiveId?{connectArchiveId}:undefined;
      },
      async dispose() { await controller.dispose(); await computation.dispose();await bridge.close();releaseNativeEvents(); },
    };
  },
};
export default factory;
