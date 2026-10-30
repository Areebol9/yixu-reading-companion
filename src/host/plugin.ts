import {resolve, join, isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {Context} from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-workspace';
import type {} from '@deepseek-ai/dsh-cmdline';
import {ArchiveHost} from './archive-host.ts';
import {serveArchive} from './http.ts';
import type {CompanionHostService, HostDomainFactory} from './contract.ts';
import {bindNativeHome} from './native-home.ts';
import {mkdir,writeFile,rename} from 'node:fs/promises';

declare module '@deepseek-ai/cordis' {
  interface Context { companionHost: CompanionHostService }
}

export const name = 'yixu-companion-host';
export const inject = ['agents','sessions','sessionPersistence','workspaceRegistry','agentPresets','workingDirectory','fs','subprocess','sandbox','sandboxPolicy','ptcRuntime','workflowEngine','skills','sessionQuery','subagents','jobs','goals'];
export interface Config { dataRoot: string; archiveId: string; nativeHome:string;domainModule?: string; port?: number; origins?: string[] }

/** Loaded by official Profile→Bundle→Loader; never creates another root Context. */
export function apply(ctx: Context, config: Config) {
  if (!isAbsolute(config.dataRoot) || !isAbsolute(config.nativeHome??'') || !/^[a-z0-9-]{1,100}$/i.test(config.archiveId)) throw Error('伴读宿主需要独立数据目录、原生日志home和明确存档身份');
  const port = config.port ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw Error('伴读宿主端口无效');
  const directory = join(resolve(config.dataRoot), 'archives', config.archiveId);
  let host: ArchiveHost | undefined;
  let closeTransport: (() => Promise<void>) | undefined;
  let phase: ReturnType<CompanionHostService['status']>['phase'] = 'awaiting-domain', failure: string | undefined;
  let registered = false, opening: Promise<void> | undefined, closing: Promise<void> | undefined;
  let startupKeepalive:ReturnType<typeof setInterval>|undefined;
  const releaseStartup=()=>{if(startupKeepalive){clearInterval(startupKeepalive);startupKeepalive=undefined;}};
  const startup=async(stage:string,error?:string)=>{
    // Startup diagnostics do not own the archive lifecycle. A Windows reader
    // can temporarily prevent replacement; preserve the business result.
    try{await mkdir(directory,{recursive:true});const file=join(directory,'startup.json');await writeFile(file+'.pending',JSON.stringify({schema:'yixu-host-startup-v1',archiveId:config.archiveId,pid:process.pid,stage,at:Date.now(),...(error?{error}:{})}),{mode:0o600});await rename(file+'.pending',file);}
    catch(diagnosticError){ctx.logger.warn('伴读启动诊断写入失败（%s）：%s',stage,String(diagnosticError));}
  };
  let resolveReady!: () => void, rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => {});
  const close = () => closing ??= (async () => {
    if (phase === 'awaiting-domain') rejectReady(Error('领域工厂未注册，宿主已关闭'));
    phase = 'stopping';releaseStartup(); await opening?.catch(() => {});
    if (host) await host.stop('伴读宿主正常关闭');
    await closeTransport?.(); phase = 'closed';
  })().catch(error=>{closing=undefined;phase='failed';failure=error instanceof Error?error.message:String(error);throw error;});
  const service: CompanionHostService = {
    status: () => ({phase, ...(failure ? {error: failure} : {})}), whenReady: () => ready,
    async shutdown() { await close(); const exit = ctx.get('appExit'); if (exit) exit(0); },
    registerDomainFactory(factory) {
      if (registered || phase !== 'awaiting-domain') throw Error('此存档已绑定领域执行所有者');
      if (typeof factory?.openArchive !== 'function') throw Error('领域工厂缺少openArchive');
      registered = true; phase = 'opening';
      // Official cold JSONL work may await unref'ed workers. This standalone host
      // has no UI/server handle until ready; retain only its opening lifecycle.
      startupKeepalive=setInterval(()=>{},1000);
      opening = (async () => {
        try {
          await startup('binding-native-home');
          await bindNativeHome(config.dataRoot,config.nativeHome);
          host = await ArchiveHost.open(ctx, factory, config.archiveId, directory,startup);
          closeTransport = await serveArchive(host, {port, directory, origins: config.origins ?? [], shutdown: () => service.shutdown()});
          phase = 'ready';await startup('ready'); resolveReady();
        } catch (error) { phase = 'failed'; failure = error instanceof Error ? error.message : String(error);await startup('failed',failure);process.exitCode=1; rejectReady(error); throw error; }
        finally{releaseStartup();}
      })();
      void opening.catch(error => ctx.logger.error('伴读领域宿主未就绪：%s', String(error)));
      return close;
    },
  };
  ctx.provide('companionHost', service);
  ctx.effect(() => close, 'yixu.archive-owner');
  // Optional deployment factory; another declared plugin may register directly instead.
  if (config.domainModule) {
    if (!isAbsolute(config.domainModule)) throw Error('领域工厂模块须为绝对路径');
    void import(pathToFileURL(config.domainModule).href).then(imported => {
      service.registerDomainFactory(imported.default ?? imported.domainFactory);
    }).catch(error => { phase = 'failed'; failure = String(error); rejectReady(error); ctx.logger.error('领域工厂加载失败：%s', failure); });
  }
}
