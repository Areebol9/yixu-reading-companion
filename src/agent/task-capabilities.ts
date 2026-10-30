import type {Context} from '@deepseek-ai/cordis';
import type {Agent} from '@deepseek-ai/dsh-agent';
import * as Todo from '@deepseek-ai/dsh-tool-todo';
import * as GoalTools from '@deepseek-ai/dsh-tool-goal';
import * as JobTools from '@deepseek-ai/dsh-tool-jobs';
import * as SkillTools from '@deepseek-ai/dsh-tool-skill';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import type {} from '@deepseek-ai/dsh-goal';
import type {} from '@deepseek-ai/dsh-skill';
import type {AgentRunRequest} from '../core/agent-port.ts';

/** Native planning state never substitutes for a domain commit or source permission. */
export async function installTaskCapabilities<T>(scope:Context,agent:Agent,input:AgentRunRequest<T>):Promise<string[]>{
  if(!input.task)return[];
  const presets=scope.get('agentPresets');if(!presets)throw Error('伴读任务需要原生preset服务');
  const current=presets.composedPreset(scope);
  if(current!==input.task.presetId){
    // PTC inherits the parent's preset; select is the public blank-session transition.
    if(agent.session.header.origin==='subagent')await presets.select(agent,input.task.presetId);
    else await presets.mount(scope,input.task.presetId);
  }
  scope.systemPrompt.context({name:'yixu:task-identity',order:290,required:true,interpolate:false,text:()=>JSON.stringify(input.task)});
  // A chapter maintenance job already has durable scope and a completion port.
  // Keep planning/job/skill tools for tasks that actually need those capabilities.
  if(!allowsTaskPlanning(input))return[];
  await scope.plugin(Todo,{allowParallelInProgress:true});
  await scope.plugin(GoalTools,{});
  await scope.plugin(JobTools,{completionDelivery:'quiet'});
  await scope.plugin(SkillTools,{});
  const skills=[
    {name:'reading-evidence-review',description:'有具体疑点时核对本任务获准正文与相关认识，交接可追查结论。',content:'先明确疑点与当前有效许可。按需取得相关原文、认识或真实交流，区分全文、片段与预览。核对具体来源版本和冲突，只返回结论、范围及来源入口；不把子任务自报完成当成领域提交，不调用父任务发表出口。'},
    {name:'reading-source-correction',description:'用户更正或来源变化时核对具体影响，保持原话与经历身份。',content:'保留用户说法、原文事实与伙伴原判断各自身份。定位受影响文档和实际读写版本，按获准材料核对。强来源失效由领域退出原上下文；不以提醒代替撤权，不复制已失效或遗忘材料。真实版本冲突只取必要差异。'},
    {name:'reading-task-handoff',description:'有限多步工作交接时保存原任务、未决责任与成果入口。',content:'记录当前目标、实际已提交成果、原答与请求身份、未决工具或unknown、材料入口及下一项获准动作。完整材料留工程资料库，交接用简短结论与结果引用。Todo与Goal只呈现执行计划，领域提交回执消费业务责任；不生成虚构共同经历或新许可。'},
  ];
  const registry=scope.get('skills');if(!registry)throw Error('伴读任务需要原生Skills服务');for(const skill of skills)registry.register({...skill,source:'runtime'});
  scope.systemPrompt.section({name:'yixu:native-planning',order:5,interpolate:false,text:'复杂且有限的任务可用Todo记录计划，用Goal接续确实未完成的工作，按需加载伴读方法。普通阅读不先派经理。原任务、许可、预算、真实提交及唯一发表入口保持权威；计划完成或Goal完成不会代替领域提交。只有需要综合判断的子任务才向父任务交付结论，其他工作由caller收取结果引用。'});
  return['todo_write','get_goal','create_goal','update_goal','job_list','job_output','job_kill','skill'];
}

/** Routine reading has a durable domain task already. Only explicitly scoped
 * review/preparation work needs native planning and delegation capabilities. */
export function allowsTaskPlanning(input:Pick<AgentRunRequest<unknown>,'task'>){
  return input.task?.role==='review'||input.task?.role==='preparation';
}

/** Wait for the upstream driver; this observer never creates an input or a model call. */
export async function waitForNativeTask(ctx:Context,agent:Agent,signal:AbortSignal,committed:()=>boolean=()=>false):Promise<void>{
  while(true){
    await agent.whenIdle();if(committed())return;signal.throwIfAborted();
    if(await ctx.get('subagents')?.waitForChildren(agent))continue;
    const goal=ctx.get('goals')?.get(agent);
    if(!goal||goal.phase!=='active'||goal.activation!=='armed')return;
    await new Promise<void>((resolve,reject)=>{
      const cleanups:(()=>void)[]=[];const finish=()=>{for(const cleanup of cleanups)cleanup();resolve();};
      const check=()=>{const current=ctx.get('goals')?.get(agent);if(agent.status!=='idle'||!current||current.phase!=='active'||current.activation!=='armed')finish();};
      cleanups.push(ctx.on('agent/status',payload=>{if(payload.agent===agent)check();}));
      cleanups.push(ctx.on('goal/changed',()=>check()));
      cleanups.push(ctx.on('goal/activation-changed',()=>check()));
      const abort=()=>{for(const cleanup of cleanups)cleanup();reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});cleanups.push(()=>signal.removeEventListener('abort',abort));
      if(signal.aborted)abort();else check();
    });
  }
}
