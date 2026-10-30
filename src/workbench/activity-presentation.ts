import { t, locale } from './i18n.ts';
import type { ApplicationSnapshot } from '../core/application-contract.ts';
import type {WorkbenchClient} from './contract.ts';
import type {ReadingRecoveryDecision,ReadingRecoveryExecution,ReadingRecoveryCapability} from '../core/types.ts';

export type Activity = NonNullable<ApplicationSnapshot['activities']>[number];
export const activeActivityStages = new Set(['preparing', 'waiting-model', 'tools', 'validating', 'saving']);
const settledStages = new Set(['complete', 'quiet', 'obsolete']);
const roles: Activity['kind'][] = ['question', 'scene', 'maintenance', 'expression'];

export function activityResponsibility(activity: Activity): NonNullable<Activity['responsibility']> {
  if(activity.stage==='paused'&&activity.recovery?.responsibility==='running')return 'unfinished';
  return activity.recovery?.responsibility??activity.responsibility ?? (activeActivityStages.has(activity.stage) ? 'running' : settledStages.has(activity.stage) ? 'history' : 'unfinished');
}

type ExecutableRecovery=ReadingRecoveryDecision&{execution:Exclude<ReadingRecoveryExecution,'none'>;availability:'available';action:NonNullable<ReadingRecoveryCapability['action']>};
export function availableRecovery(activity:Activity):ExecutableRecovery|undefined{
  const decision=activity.recovery;
  return decision?.availability==='available'&&decision.execution!=='none'&&decision.target&&decision.action?decision as ExecutableRecovery:undefined;
}
export function automaticRecoveryInProgress(activity: Activity): boolean {
  if(activity.stage==='paused')return false;
  const responsibility = activityResponsibility(activity);
  return (responsibility === 'running' || responsibility === 'unfinished') && activity.recovery?.automatic === true && (activity.recovery.automaticState === 'queued' || activity.recovery.automaticState === 'running');
}
export function recoveryActionLabel(decision:NonNullable<Activity['recovery']>):string{
  if(decision.execution==='receipt')return t("查看这次回复是否已保存");
  if(decision.execution==='local-result')return decision.target?.kind==='question'?t("继续保存这次回答"):t("继续保存已有回复");
  return decision.target?.kind==='question'?t("继续回答这个问题"):decision.target?.kind==='scene'?t("继续这段共读"):t("继续整理");
}
export function performRecovery(client:Pick<WorkbenchClient,'recoverReading'>,decision:NonNullable<Activity['recovery']>):Promise<void>{
  const {target,execution}=decision;
  if(decision.availability!=='available'||!target||execution==='none'||!decision.action)throw Error(t("这次处理的进度已变化，请查看当前可用的操作。"));
  return client.recoverReading(target,execution);
}

export function activityScopeLabel(app: ApplicationSnapshot, activity: Activity): string {
  if (!activity.sessionId) return t("本书记录");
  return activity.sessionId === app.session?.id ? app.session.active === false ? t("本次共读已结束") : t("本次共读") : t("此前共读");
}

/** Controls current prompts only. Every record remains available in processing details. */
export function shouldShowCurrentRecovery(activity: Activity, app: Pick<ApplicationSnapshot, 'session' | 'state'>): boolean {
  const responsibility = activityResponsibility(activity);
  if (responsibility === 'history' || responsibility === 'settlement' || (activity.recovery?.automatic && activity.recovery.automaticState !== 'stopped') || !availableRecovery(activity)) return false;
  if (activity.kind === 'question' || activity.kind === 'maintenance') return true;
  const sessionId = activity.sessionId ?? app.state.chats.find(chat => chat.id === (activity.questionId ?? activity.chatId))?.sessionId;
  return app.session?.active !== false && !!sessionId && sessionId === app.session?.id;
}

export function readingStatusPresentation(app: ApplicationSnapshot, bookId: string, following: boolean, sceneRecoveryHandled = false) {
  const all = app.activities.filter(item => item.bookId === bookId && (!app.state.partnerId || item.partnerId === app.state.partnerId||item.kind==='maintenance'&&app.state.maintenanceJobs?.some(job=>job.id===item.jobId&&job.bookId===bookId&&job.scope==='book')));
  const paused = app.readingControl?.state === 'paused', stopping = app.readingControl?.state === 'stopping';
  const sessionId = (item: Activity) => item.sessionId ?? app.state.chats.find(chat => chat.id === (item.questionId ?? item.chatId))?.sessionId;
  const currentScope = (item: Activity) => app.session?.active !== false && !!sessionId(item) && sessionId(item) === app.session?.id;
  const unfinished = all.filter(item => activityResponsibility(item) === 'unfinished');
  const historical = all.filter(item => ['history','settlement'].includes(activityResponsibility(item))).sort((a,b) => (b.endedAt ?? b.updatedAt)-(a.endedAt ?? a.updatedAt));
  const queuedQuestion = (item: Activity) => item.kind === 'question' && currentScope(item);
  const visible = all.filter(item => activityResponsibility(item) === 'running' || automaticRecoveryInProgress(item) || activityResponsibility(item) === 'unfinished' && (
    item.stage === 'waiting-publish' && (currentScope(item) || item.responsibility === undefined && !sessionId(item)) ||
    item.stage === 'queued' && (queuedQuestion(item) || following && !paused && !stopping && app.session?.active !== false && (currentScope(item) || item.kind === 'maintenance' && !sessionId(item)))
  ));
  const pending = unfinished.filter(item => !visible.includes(item));
  const attention = pending.filter(item => !(sceneRecoveryHandled && item.kind === 'scene') && shouldShowCurrentRecovery(item, app));
  const chips = roles.flatMap(kind => {
    const group = visible.filter(item => item.kind === kind);
    if (!group.length) return [];
    const working = group.some(item => activeActivityStages.has(item.stage));
    let label = kind === 'question' ? working ? t("正在回应你") : t("等待回应你")
      : kind === 'scene' ? working ? t("正在读这一段") : t("等候这段共读")
      : kind === 'maintenance' ? working ? t("整理前文理解") : t("理解整理已排队")
      : working ? group.some(item => item.purpose === 'paragraph-comment') ? t("留下段评") : t("准备分享想法") : t("有想法待分享");
    const stage = group.filter(item => activeActivityStages.has(item.stage)).sort((a,b) => b.updatedAt-a.updatedAt)[0]?.stage;
    if(stage === 'tools') label = kind === 'question' ? t("查阅后回应你") : kind === 'scene' ? t("查阅相关资料") : kind === 'maintenance' ? t("查阅前文资料") : t("查阅相关想法");
    if(stage === 'saving') label = kind === 'question' ? t("保存这次回应") : kind === 'scene' ? t("保存这段共读") : kind === 'maintenance' ? t("保存理解与概要") : group.some(item => item.purpose === 'paragraph-comment') ? t("保存段评") : t("保存分享的想法");
    if(stage === 'validating') label = kind === 'question' ? t("核对这次回应") : kind === 'scene' ? t("核对这段共读") : kind === 'maintenance' ? t("核对前文理解") : t("核对分享内容");
    if(stage === 'preparing') label = kind === 'question' ? t("准备回应你") : kind === 'scene' ? t("准备这一段共读") : kind === 'maintenance' ? t("梳理前文材料") : t("准备分享想法");
    return [{ kind, label, working }];
  });
  const needsAttention = attention.length > 0;
  const onlyMaintenance = attention.every(item => item.kind === 'maintenance');
  const onlyQuestions = attention.length > 0 && attention.every(item => item.kind === 'question');
  const previousQuestions = onlyQuestions && attention.every(item => !!sessionId(item) && (sessionId(item) !== app.session?.id || app.session?.active === false));
  const onlyUncertain = attention.length > 0 && attention.every(item => item.recovery?.execution==='receipt');
  const local=attention.length>0&&attention.every(item=>item.recovery?.execution==='local-result');
  const attentionLabel = local?t("已有回复待保存"):onlyUncertain?t("这次回复待确认"):onlyMaintenance?t("后台整理需处理"):previousQuestions?t("此前有问题待继续"):onlyQuestions?t("有问题待继续"):t("有共读事项需处理");
  return { all, current: visible, pending, historical, chips, attention, needsAttention, attentionLabel, stopping, idle: following && app.session?.active !== false && !paused && !stopping && !chips.length };
}

export function activityTime(activity: Activity, now: number): string {
  if (activityResponsibility(activity) !== 'running') return new Date(activity.endedAt ?? activity.updatedAt ?? activity.since).toLocaleString(locale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const seconds = Math.max(0, Math.floor((now - activity.since) / 1000));
  return seconds < 60 ? t("已进行 {0} 秒",seconds) : t("已进行 {0} 分 {1} 秒",Math.floor(seconds / 60),seconds % 60);
}

export function activityLabel(activity: Activity): string {
  const { kind, stage, purpose } = activity;
  if (activityResponsibility(activity) === 'settlement') return t("历史费用待确认，记录已保留");
  if(stage==='paused'&&activityResponsibility(activity)!=='history')return kind==='question'?t("这个问题待继续，已有回复和进度已保存"):t("已暂停，已有回复和进度已保存");
  // The live phase is more precise than a recovery's generic running owner.
  if(activityResponsibility(activity)==='running'){
    if(stage==='waiting-model')return t("已发送材料，等待模型返回");
    if(stage==='tools')return t("正在查阅相关资料");
    if(stage==='validating')return t("正在核对已收到的结果");
    if(stage==='saving')return purpose==='paragraph-comment'?t("正在保存段评"):kind==='maintenance'?t("正在保存理解与概要"):t("正在保存已有结果");
    if(stage==='preparing')return t("正在整理所需材料");
  }
  if (automaticRecoveryInProgress(activity)) return activity.recovery?.automaticState === 'queued'
    ? activity.recovery.execution === 'local-result' ? t("已有回复正在等待自动保存") : t("正在等待自动继续处理")
    : activity.recovery?.execution === 'local-result' ? t("正在自动保存已有回复") : t("正在自动继续处理");
  if(activity.recovery?.kind==='history'&&activity.recovery.reason&&!settledStages.has(stage))return t("这次处理未能全部完成，已有回复和记录已保留");
  if(activity.recovery?.availability==='running')return kind==='question'?t("正在回应你的消息"):kind==='maintenance'?t("正在整理前文理解"):t("正在处理这次共读");
  if(activity.recovery?.availability==='blocked')return kind==='question'?t("这个问题已保留，暂时无法继续"):t("已有进度已保留，暂时无法继续");
  if(activityResponsibility(activity)==='history'&&['failed','queued','paused'].includes(stage))return t("这次处理未完成，记录已保留");
  if(activity.recovery?.execution==='local-result')return t("已收到回复，保存尚未完成");
  if(activity.recovery?.execution==='receipt')return t("这次请求的结果待确认");
  if(activity.recovery?.execution==='continue')return kind==='question'?t("这个问题等待继续回答"):t("已有进度可以继续处理");
  if (stage === 'unknown') return t("这次请求的结果或费用待确认");
  if (stage === 'failed') return activityResponsibility(activity) === 'history' ? t("这次处理曾遇到问题") : t("这次处理未完成");
  if (stage === 'paused') return kind === 'question' ? t("这个问题待继续，进度已保留") : t("已暂停，进度已保留");
  if (stage === 'complete') return kind === 'maintenance' ? t("理解与概要已保存") : kind === 'scene' ? t("这段共读已完成") : purpose === 'paragraph-comment' ? t("段评已保存") : kind === 'expression' ? t("想法已分享") : t("本次回应已完成");
  if (stage === 'quiet') return t("这段安静陪读");
  if (stage === 'obsolete') return t("已随阅读进度略过");
  if (stage === 'waiting-publish') return t("想法已准备好，等待分享时机");
  if (stage === 'queued') return kind === 'maintenance' ? t("等待整理理解") : kind === 'question' ? t("等待回应你的消息") : t("等待继续共读");
  if (stage === 'saving') return purpose === 'paragraph-comment' ? t("正在保存段评") : kind === 'maintenance' ? t("正在保存理解与概要") : t("正在保存已有结果");
  if (stage === 'tools') return t("正在查阅相关资料");
  if (stage === 'validating') return t("正在核对已收到的结果");
  if (stage === 'preparing') return t("正在整理所需材料");
  return kind === 'maintenance' ? t("正在整理前文理解") : kind === 'question' ? t("正在回应你的消息") : kind === 'expression' ? t("正在准备分享") : t("正在读这一段");
}

export type ReadingActivityExplanation = {
  title:string; detail:string; impact:string; next:string;
  group:'working'|'queued'|'paused'|'problem';
  actionLabel?:string; decision?:ReturnType<typeof availableRecovery>;
};
/** Explain saved facts and the effect of an available action, without making the reader diagnose it. */
export function explainReadingActivity(app:ApplicationSnapshot,activity:Activity,following?:boolean):ReadingActivityExplanation{
  const maintenance=activity.kind==='maintenance',job=activity.jobId?app.state.maintenanceJobs?.find(item=>item.id===activity.jobId):undefined;
  const title=maintenance?job?.ranges.length?t("整理已读内容"):job?.viewTargets?.length?t("更新全书与近期概要"):t("整理这次交流"):activity.kind==='question'?activity.purpose==='paragraph-reply'?t("回应你的段评"):t("回应你的消息"):activity.kind==='scene'?t("阅读当前段落"):t("发表伙伴的想法");
  const impact=maintenance?t("此前保存的理解和交流仍可查看；这部分内容暂未加入最新整理。"):t("这次回应尚未送达，原消息仍保留。");
  const reason=activity.reason??activity.recovery?.reason??'';
  const decision=shouldShowCurrentRecovery(activity,app)?availableRecovery(activity):undefined;
  const automatic=automaticRecoveryInProgress(activity);
  if(activity.stage==='paused'&&activityResponsibility(activity)!=='history'){
    const received=activity.requestId&&app.state.usage.some(usage=>usage.id===activity.requestId&&usage.status==='complete'&&usage.dispatchState==='response-received');
    return{title,detail:received?t("模型结果已收到并保留，继续伴读后接着核对和处理。"):t("伴读已暂停，这项工作的进度已保存。"),impact:'',next:decision?t("点击继续后会接着处理，可能产生新的模型用量。"):t("继续伴读后会接着处理，可能产生新的模型用量。"),group:'paused',decision,actionLabel:decision?(maintenance?t("继续这项整理"):t("继续这次回应")):undefined};
  }
  if(activityResponsibility(activity)==='running'||automatic&&activity.recovery?.automaticState==='running'){
    const detail=activity.stage==='saving'?t("正在把收到的内容保存到阅读记录。"):activity.stage==='validating'?t("已收到结果，正在核对能否保存到当前记录。"):activity.stage==='tools'?t("正在查阅与这项任务有关的原文和已有记录。"):activity.stage==='waiting-model'?t("已向模型发送材料，正在等它返回结果。"):automatic&&activity.recovery?.execution==='local-result'?t("正在保存此前收到的结果。"):t("正在准备这项任务需要的原文和记录。");
    return{title,detail,impact:'',get next(){return t("正在自动进行，无需操作。");},group:'working'};
  }
  const interrupted=/已停止新增模型|已暂停|暂停.*新增|主动停止/.test(reason)||activity.stage==='paused';
  const awaitingOther=/等待同书|另一.*任务|其他.*任务|同书.*运行/.test(activity.recovery?.reason??'');
  const stoppedOnly=interrupted&&!/冲突|缺少|无效|失败|不符|失效/.test(reason);
  if(activity.stage==='queued'||automatic||awaitingOther&&activity.stage!=='failed'){const paused=following===false||app.readingControl?.state==='paused';return{title,detail:awaitingOther?t("同一本书的另一项整理正在进行，这项在等待。"):paused?t("待整理的材料已保存，伴读暂停期间尚未开始。"):t("材料已经保存，正在等待前面的工作完成。"),impact:'',next:automatic?t("应用会自动接着处理，无需操作。"):paused?t("继续伴读后再处理这部分内容。"):t("可以继续阅读；有实际结果后会更新这里。"),group:'queued'};}
  if(stoppedOnly)return{title,get detail(){return t("伴读暂停时，这项工作还没有完成，已有进度已保存。");},impact:'',next:decision?t("点击后接着这项工作，可能产生新的模型用量。"):t("继续伴读后可接着处理。"),group:'paused',decision,actionLabel:decision?(maintenance?t("继续这项整理"):t("继续这次回应")):undefined};
  if(activity.stage==='waiting-publish')return{title,get detail(){return t("想法已经准备好，相关段落读完后再分享。");},impact:'',get next(){return t("无需操作，继续按自己的节奏阅读。");},group:'queued'};
  let detail:string;
  if(/并发冲突|已有新的实际发布头|版本.*冲突|资料.*变化/.test(reason))detail=t("整理期间相关记录又有了更新，这份结果还没有合并到最新记录。");
  else if(/实际取得.*全文|目录只供导航|未读取.*材料|未取得.*全文/.test(reason))detail=t("这次整理要修改一份尚未完整读取的资料，需要补齐正文后再保存。");
  else if(/views缺少|缺少.*概要|JSON|schema|字段|参数|未通过|原字句已失效|候选|身份/.test(reason))detail=t("程序未能正确接收这次结果，相关内容还没有保存完成。");
  else if(/许可.*撤回|形成范围已撤回|正文许可/.test(reason))detail=t("这项工作用到的原文已不在当前允许使用的范围内，处理已停止。");
  else if(/额度|预算|上限/.test(reason))detail=t("这项工作因用量上限停止，已有进度仍保留。");
  else if(/网络|连接|timeout|socket|中断/i.test(reason)||activity.recovery?.execution==='receipt')detail=t("这次请求未确认收到完整结果；直接重新发送可能重复生成和计费。");
  else if(decision?.execution==='local-result')detail=t("结果已经收到，但还没有保存到阅读记录。");
  else detail=t("这项工作未能完成，程序还没有给出可确定的原因。");
  const actionLabel=decision?.execution==='local-result'?t("保存已收到的结果"):decision?.execution==='receipt'?t("检查是否收到回复"):decision?.execution==='continue'?t("接着完成这项工作"):undefined;
  const next=awaitingOther?t("同一本书的另一项整理仍在进行；结束后程序会重新判断这项工作能否继续。"):decision?.execution==='local-result'?t("点击后保存已收到的结果，无需再次使用模型。"):decision?.execution==='receipt'?t("由程序检查这一次请求，不重新发送你的消息。"):decision?.execution==='continue'?t("保留原进度，让模型依据当前资料继续，可能产生新的用量。"):t("当前没有可执行的恢复操作；无需反复点击或重新发送。诊断记录保留在下方。");
  return{title,detail,impact,next,group:'problem',decision,actionLabel};
}
