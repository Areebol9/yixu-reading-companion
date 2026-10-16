import type { ApplicationSnapshot } from '../core/application-contract.ts';

export type Activity = NonNullable<ApplicationSnapshot['activities']>[number];
export const activeActivityStages = new Set(['preparing', 'waiting-model', 'tools', 'validating', 'saving']);
const settledStages = new Set(['complete', 'quiet', 'obsolete']);
const roles: Activity['kind'][] = ['question', 'scene', 'maintenance', 'expression'];

export function readingStatusPresentation(app: ApplicationSnapshot, bookId: string, following: boolean, sceneRecoveryHandled = false) {
  const all = app.activities.filter(item => item.bookId === bookId);
  const paused = app.readingControl?.state === 'paused', stopping = app.readingControl?.state === 'stopping';
  const queuedQuestion = (item: Activity) => item.kind === 'question' && app.state.chats.some(chat => chat.id === item.questionId && chat.delivery === 'pending' && chat.sessionId === app.session?.id);
  const visible = all.filter(item => activeActivityStages.has(item.stage) || item.stage === 'waiting-publish' || item.stage === 'queued' && (queuedQuestion(item) || following && !paused && !stopping));
  const attention = all.filter(item => !settledStages.has(item.stage) && !visible.includes(item) && !(sceneRecoveryHandled && item.kind === 'scene'));
  const chips = roles.flatMap(kind => {
    const group = visible.filter(item => item.kind === kind);
    if (!group.length) return [];
    const working = group.some(item => activeActivityStages.has(item.stage));
    let label = kind === 'question' ? working ? '正在回应你' : '等待回应你'
      : kind === 'scene' ? working ? '正在读这一段' : '等候这段共读'
      : kind === 'maintenance' ? working ? '整理前文理解' : '理解整理已排队'
      : working ? group.some(item => item.purpose === 'paragraph-comment') ? '留下段评' : '准备分享想法' : '有想法待分享';
    const stage = group.filter(item => activeActivityStages.has(item.stage)).sort((a,b) => b.updatedAt-a.updatedAt)[0]?.stage;
    if(stage === 'tools') label = kind === 'question' ? '查阅后回应你' : kind === 'scene' ? '查阅相关资料' : kind === 'maintenance' ? '查阅前文资料' : '查阅相关想法';
    if(stage === 'saving') label = kind === 'question' ? '保存这次回应' : kind === 'scene' ? '保存这段共读' : kind === 'maintenance' ? '保存理解与概要' : group.some(item => item.purpose === 'paragraph-comment') ? '保存段评' : '保存分享的想法';
    if(stage === 'validating') label = kind === 'question' ? '核对这次回应' : kind === 'scene' ? '核对这段共读' : kind === 'maintenance' ? '核对前文理解' : '核对分享内容';
    if(stage === 'preparing') label = kind === 'question' ? '准备回应你' : kind === 'scene' ? '准备这一段共读' : kind === 'maintenance' ? '梳理前文材料' : '准备分享想法';
    return [{ kind, label, working }];
  });
  const progress = app.maintenanceProgress.find(item => item.bookId === bookId);
  const maintenancePending = !!progress && (progress.blockedJobs > 0 || progress.queuedJobs > 0 || progress.missingChars > 0 || progress.overviewPending > 0);
  const needsAttention = attention.length > 0 || maintenancePending && !visible.some(item => item.kind === 'maintenance');
  const onlyMaintenance = attention.every(item => item.kind === 'maintenance');
  return { all, chips, attention, needsAttention, attentionLabel: onlyMaintenance ? '理解整理待继续' : '有待处理事项', stopping, idle: following && !paused && !stopping && !chips.length };
}

export function activityTime(activity: Activity, now: number): string {
  if (!activeActivityStages.has(activity.stage)) return new Date(activity.endedAt ?? activity.updatedAt ?? activity.since).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const seconds = Math.max(0, Math.floor((now - activity.since) / 1000));
  return seconds < 60 ? `已进行 ${seconds} 秒` : `已进行 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export function resumableMaintenanceJob(app: ApplicationSnapshot, activity: Activity): string | undefined {
  if(activity.kind !== 'maintenance' || !activity.jobId || !['failed', 'unknown', 'paused'].includes(activity.stage)) return;
  const job = app.state.maintenanceJobs?.find(item => item.id === activity.jobId),book = app.state.books.find(item => item.id === activity.bookId);
  const ownerActive = app.activities.some(item => item.kind === 'maintenance' && activeActivityStages.has(item.stage)) || app.state.maintenanceJobs?.some(item => item.status === 'running' && item.partnerId === app.state.partnerId && item.bookId === app.session?.bookId);
  if(!job || job.status !== 'blocked' || ownerActive || !book || job.version !== book.version || job.partnerId !== app.state.partnerId || !app.session?.active || app.session.mode !== 'reading' || app.session.bookId !== job.bookId || app.readingControl?.state === 'stopping') return;
  return job.id;
}
