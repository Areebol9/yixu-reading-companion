import { t, locale } from './i18n.ts';
import { useEffect, useState } from 'react';
import type { ApplicationSnapshot } from '../core/application-contract.ts';
import { workbenchErrorLabel, recoveryReasonLabel } from './copy.ts';
import { useDesktopWindowState } from './desktop-window.ts';
import { Icon } from './icons.tsx';
import type { IconName } from './icons.tsx';
import { explainReadingActivity, activityResponsibility, activityScopeLabel, activityTime, readingStatusPresentation, availableRecovery,recoveryActionLabel, activityLabel, shouldShowCurrentRecovery, automaticRecoveryInProgress } from './activity-presentation.ts';
import type { Activity } from './activity-presentation.ts';
import {ReadingTaskProgress,MaintenanceTaskActions} from './ReadingTaskProgress.tsx';
import type {MaintenanceTaskAction} from './ReadingTaskProgress.tsx';

const roleLabels = { get scene(){return t("现场共读");}, get question(){return t("与你交流");}, get maintenance(){return t("理解整理");}, get expression(){return t("伙伴想法");} };
const roleIcons: Record<Activity['kind'], IconName> = { scene: 'book', question: 'chat', maintenance: 'leaf', expression: 'spark' };

export function ActivityPanel({ app, bookId, following, detail = false,onRecovery,onMaintenanceAction, actionBusy = false, sceneRecoveryHandled = false }: {
  app: ApplicationSnapshot; bookId?: string; following: boolean; detail?: boolean; onDetails?: () => void;
  onRecovery?:(decision:NonNullable<Activity['recovery']>)=>void;actionBusy?: boolean; sceneRecoveryHandled?: boolean;
  onMaintenanceAction?:MaintenanceTaskAction;
}) {
  const [now, setNow] = useState(Date.now());
  const { developerMode } = useDesktopWindowState();
  const [historyOpen,setHistoryOpen]=useState(false),[historyLimit,setHistoryLimit]=useState(12);
  const presentation = readingStatusPresentation(app, bookId ?? '', following, sceneRecoveryHandled);
  const ticking = detail && presentation.all.some(item => activityResponsibility(item) === 'running');
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  if (!bookId || !detail) return null;

  const progress = app.maintenanceProgress.find(item => item.bookId === bookId);
  const { historical, current, pending } = presentation;
  const renderActivity = (activity:Activity) => {
    const responsibility=activityResponsibility(activity),working = responsibility === 'running',available=availableRecovery(activity),decision=shouldShowCurrentRecovery(activity,app)||available?.execution==='receipt'?available:undefined;
    const explanation=!['history','settlement'].includes(responsibility)?explainReadingActivity(app,activity,following):undefined;
    const question=activity.questionId?app.state.chats.find(chat=>chat.id===activity.questionId&&!chat.excluded):undefined;
    return <li className={`activity-record phase-${activity.stage}`} key={activity.id} data-activity-id={activity.id} data-activity-phase={activity.stage} data-activity-responsibility={responsibility}>
      <span className="activity-record-icon"><Icon name={roleIcons[activity.kind]} size={16} /></span>
      <div className="activity-record-body"><div className="activity-record-heading"><span>{roleLabels[activity.kind]} · {activityScopeLabel(app,activity)}</span><time aria-live="off" dateTime={new Date(working ? activity.since : activity.endedAt ?? activity.updatedAt ?? activity.since).toISOString()}>{activityTime(activity, now)}</time></div><strong>{explanation?.title??activityLabel(activity)}</strong>
        {question&&<p>{t("你的问题：")}{question.text}</p>}
        <ReadingTaskProgress app={app} activity={activity}/>
        {explanation?<><p>{explanation.detail}</p>{explanation.impact&&<p>{explanation.impact}</p>}<p>{explanation.next}</p></>:(activity.recovery?.reason||activity.reason)&&<p>{automaticRecoveryInProgress(activity) ? t("应用会自动继续处理，已收到的回复会保留。") : activity.recovery ? recoveryReasonLabel(activity.recovery) : workbenchErrorLabel(activity.reason!)}</p>}
        {developerMode && (activity.recovery?.reason || activity.reason) && <details className="activity-diagnostics"><summary>{t("开发诊断")}</summary><pre>{[activity.recovery?.reason, activity.reason].filter((value, index, values) => value && values.indexOf(value) === index).join('\n')}</pre></details>}
        {activity.progress?.modelRounds ? <small>{t("已收到")}{activity.progress.modelRounds} {t("轮结果")}</small> : null}
        {decision&&onRecovery&&<button type="button" className="activity-resume" disabled={actionBusy} onClick={()=>onRecovery(decision)}>{explanation?.actionLabel??recoveryActionLabel(decision)}<Icon name="arrow" size={13}/></button>}
        <MaintenanceTaskActions app={app} activity={activity} onAction={onMaintenanceAction} disabled={actionBusy}/>
      </div>
    </li>;
  };
  return <section className="activity-detail" aria-label={t("完整处理记录")}>
    <h3>{t("当前处理")}</h3>
    {!current.length && <p className="activity-detail-empty">{t("当前没有正在执行的任务。")}</p>}
    <ul className="activity-records">{current.map(renderActivity)}</ul>
    {!!pending.length&&<><h3>{t("尚待完成的事项")}</h3><ul className="activity-records">{pending.map(renderActivity)}</ul></>}
    {progress && (progress.queuedChars > 0 || progress.workingChars > 0 || progress.blockedChars > 0 || progress.overviewPending > 0 || progress.pendingChatCount > 0) && <p className="activity-detail-progress">{[progress.workingChars?t("正在理解 {0} 字",progress.workingChars.toLocaleString(locale())):undefined,progress.queuedChars?t("{0} 字排队",progress.queuedChars.toLocaleString(locale())):undefined,progress.blockedChars?t("{0} 字待继续整理",progress.blockedChars.toLocaleString(locale())):undefined,progress.pendingChatCount?t("{0} 条交流待整理",progress.pendingChatCount):undefined,progress.overviewPending?t("{0} 份概要待核对",progress.overviewPending):undefined].filter(Boolean).join(' · ')}</p>}
    {!!historical.length&&<details className="activity-history" onToggle={event=>setHistoryOpen(event.currentTarget.open)}><summary>{historical.some(item=>activityResponsibility(item)==='settlement')?t("历史处理与结果待确认"):t("历史处理记录")} · {historical.length}</summary>{historyOpen&&<><ul className="activity-records">{historical.slice(0,historyLimit).map(renderActivity)}</ul>{historical.length>historyLimit&&<button type="button" className="btn btn-outline btn-small" onClick={()=>setHistoryLimit(value=>value+12)}>{t("再看较早记录")}</button>}</>}</details>}
  </section>;
}

export {activityLabel} from './activity-presentation.ts';
