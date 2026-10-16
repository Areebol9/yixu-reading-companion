import { useEffect, useState } from 'react';
import type { ApplicationSnapshot } from '../core/application-contract.ts';
import { workbenchErrorLabel } from './copy.ts';
import { Icon } from './icons.tsx';
import type { IconName } from './icons.tsx';
import { activeActivityStages, activityTime, readingStatusPresentation, resumableMaintenanceJob } from './activity-presentation.ts';
import type { Activity } from './activity-presentation.ts';

const roleLabels = { scene: '现场共读', question: '与你交流', maintenance: '理解整理', expression: '伙伴想法' };
const roleIcons: Record<Activity['kind'], IconName> = { scene: 'book', question: 'chat', maintenance: 'leaf', expression: 'spark' };

export function activityLabel(activity: Activity): string {
  const { kind, stage, purpose } = activity;
  if (stage === 'unknown') return '回复结果待确认';
  if (stage === 'failed') return '需要继续处理';
  if (stage === 'paused') return '已暂停，进度已保留';
  if (stage === 'complete') return kind === 'maintenance' ? '理解与概要已保存' : kind === 'scene' ? '这段共读已完成' : purpose === 'paragraph-comment' ? '段评已保存' : kind === 'expression' ? '想法已分享' : '本次回应已完成';
  if (stage === 'quiet') return '这段安静陪读';
  if (stage === 'obsolete') return '已随阅读进度略过';
  if (stage === 'waiting-publish') return '想法已准备好，等待分享时机';
  if (stage === 'queued') return kind === 'maintenance' ? '等待整理理解' : kind === 'question' ? '等待回应你的消息' : '等待继续共读';
  if (stage === 'saving') return purpose === 'paragraph-comment' ? '正在保存段评' : kind === 'maintenance' ? '正在保存理解与概要' : '正在保存已有结果';
  if (stage === 'tools') return '正在查阅相关资料';
  if (stage === 'validating') return '正在核对已收到的结果';
  if (stage === 'preparing') return '正在整理所需材料';
  return kind === 'maintenance' ? '正在整理前文理解' : kind === 'question' ? '正在回应你的消息' : kind === 'expression' ? '正在准备分享' : '正在读这一段';
}

export function ActivityPanel({ app, bookId, following, detail = false, onDetails, onResumeMaintenance, actionBusy = false, sceneRecoveryHandled = false }: {
  app: ApplicationSnapshot; bookId?: string; following: boolean; detail?: boolean; onDetails?: () => void;
  onResumeMaintenance?: (jobId: string) => void; actionBusy?: boolean; sceneRecoveryHandled?: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  const [historyOpen,setHistoryOpen]=useState(false),[historyLimit,setHistoryLimit]=useState(12);
  const presentation = readingStatusPresentation(app, bookId ?? '', following, sceneRecoveryHandled);
  const ticking = detail && presentation.all.some(item => activeActivityStages.has(item.stage));
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  if (!bookId) return null;

  if (!detail) {
    if (!presentation.chips.length && !presentation.needsAttention && !presentation.idle && !presentation.stopping) return null;
    return <section className="reading-presence" aria-label="共读状态">
      <div className="reading-presence-items" role="status" aria-live="polite" aria-atomic="true">
        {presentation.stopping && <span className="presence-note"><Icon name="check" size={14} />收取已有回复并保存</span>}
        {presentation.chips.map(chip => <span className={`presence-chip${chip.working ? ' is-working' : ' is-waiting'}`} key={chip.kind} data-presence-role={chip.kind}><Icon name={roleIcons[chip.kind]} size={14} /><span>{chip.label}</span>{chip.working && <i className="presence-dot" />}</span>)}
        {presentation.idle && <span className="presence-idle"><Icon name="leaf" size={14} />安静陪你读</span>}
        {presentation.needsAttention && <button type="button" className="presence-attention" onClick={onDetails} aria-label={`${presentation.attentionLabel}，查看完整处理记录`}><span className="attention-dot" />{presentation.attentionLabel}<Icon name="chevron" size={12} /></button>}
      </div>
    </section>;
  }

  const progress = app.maintenanceProgress.find(item => item.bookId === bookId);
  const historical = presentation.all.filter(item=>['complete','quiet','obsolete'].includes(item.stage));
  const current = presentation.all.filter(item=>!['complete','quiet','obsolete'].includes(item.stage));
  const renderActivity = (activity:Activity) => {
    const working = activeActivityStages.has(activity.stage),resumeJobId = resumableMaintenanceJob(app, activity);
    return <li className={`activity-record phase-${activity.stage}`} key={activity.id} data-activity-id={activity.id} data-activity-phase={activity.stage}>
      <span className="activity-record-icon"><Icon name={roleIcons[activity.kind]} size={16} /></span>
      <div className="activity-record-body"><div className="activity-record-heading"><span>{roleLabels[activity.kind]}</span><time aria-live="off" dateTime={new Date(working ? activity.since : activity.endedAt ?? activity.updatedAt ?? activity.since).toISOString()}>{activityTime(activity, now)}</time></div><strong>{activityLabel(activity)}</strong>{activity.reason && <p>{workbenchErrorLabel(activity.reason)}</p>}{activity.progress?.modelRounds ? <small>已收到 {activity.progress.modelRounds} 轮结果</small> : null}{resumeJobId && onResumeMaintenance && <button type="button" className="activity-resume" disabled={actionBusy} onClick={() => onResumeMaintenance(resumeJobId)}>继续整理<Icon name="arrow" size={13} /></button>}</div>
    </li>;
  };
  return <section className="activity-detail" aria-label="完整处理记录">
    <h3>当前处理</h3>
    {!current.length && <p className="activity-detail-empty">当前没有待处理事项。</p>}
    <ul className="activity-records">{current.map(renderActivity)}</ul>
    {progress && (progress.missingChars > 0 || progress.workingChars > 0 || progress.overviewPending > 0) && <p className="activity-detail-progress">正在理解 {progress.workingChars.toLocaleString()} 字 · 排队 {progress.queuedChars.toLocaleString()} 字{progress.blockedChars > 0 ? ` · 待接续 ${progress.blockedChars.toLocaleString()} 字` : ''}{progress.overviewPending > 0 ? ` · 概要待更新 ${progress.overviewPending} 项` : ''}</p>}
    {!!historical.length&&<details className="activity-history" onToggle={event=>setHistoryOpen(event.currentTarget.open)}><summary>已完成与已承接记录 · {historical.length}</summary>{historyOpen&&<><ul className="activity-records">{historical.slice(0,historyLimit).map(renderActivity)}</ul>{historical.length>historyLimit&&<button type="button" className="btn btn-outline btn-small" onClick={()=>setHistoryLimit(value=>value+12)}>再看较早记录</button>}</>}</details>}
  </section>;
}
