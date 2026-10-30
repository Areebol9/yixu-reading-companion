import {Context} from '@deepseek-ai/cordis';
import {join} from 'node:path';
import {installNativeProductSessionEvents} from './session-persistence.ts';
import Loader from '@deepseek-ai/cordis-plugin-loader';

/** Same official services and configuration as dsh/bundle, without the archive
 * HTTP/domain owner. Workers own DSH execution; the host remains the sole DB writer. */
export async function createWorkerContext(nativeRoot:string){
  const ctx=new Context();
  const plugins:[string,Record<string,unknown>?][]=[
    ['cordis-plugin-timer'],['dsh-llm'],['dsh-session'],['dsh-session-projection'],['dsh-session-persistence-jsonl',{root:join(nativeRoot,'sessions')}],
    ['dsh-storage'],['dsh-storage-json',{root:join(nativeRoot,'storages')}],['dsh-storage-domain',{backend:'json'}],['dsh-workspace'],['dsh-working-directory'],['dsh-fs-local'],['dsh-subprocess-local'],['dsh-sandbox-policy',{mode:'read-only'}],['dsh-sandbox-local'],['dsh-ptc-runtime-node',{executionMode:'per-call'}],['dsh-workflow-ptc'],['dsh-skill'],['dsh-session-query-sqlite',{openAt:'never',path:':memory:'}],['dsh-tools'],['dsh-system-prompt',{includeHarnessIdentity:false,includeRuntimeContext:false,personaPrefix:''}],['dsh-agent'],['dsh-agent-loop',{agents:[],maxParallelToolCalls:2}],['dsh-token-meter'],['dsh-compaction-basic',{auto:false}],['dsh-jobs-local'],['dsh-goal'],['dsh-goal-round-driver'],['dsh-subagent'],['dsh-subagent-spawn-in-process'],['dsh-subagent-fork-in-process'],['dsh-agent-preset-registry',{default:'companion'}],
    ...['companion','companion-maintenance','companion-review','companion-preparation'].map(id=>['dsh-agent-preset',{id,plugins:[]}] as [string,Record<string,unknown>]),
  ];
  try{await ctx.plugin(Loader,{baseUrl:import.meta.url});for(const[name,config]of plugins){await ctx.loader.create({name:'@deepseek-ai/'+name,config});await ctx.loader.await();}for(const service of ['agentPresets','workingDirectory','sessionPersistence','subagents','jobs','goals'] as const)if(!ctx.get(service))throw Error('DSH执行线程缺少正式服务：'+service);const release=installNativeProductSessionEvents(ctx);return{ctx,async dispose(){release();await ctx.fiber.dispose();}};}catch(error){await ctx.fiber.dispose();throw error;}
}
