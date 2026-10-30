import { t, locale } from './i18n.ts';
import {useEffect,useState} from 'react';
import type {ApplicationSnapshot} from '../core/application-contract.ts';
import type {Activity} from './activity-presentation.ts';
import {activityResponsibility} from './activity-presentation.ts';
import {subtractRanges} from '../core/books.ts';
import {workbenchErrorLabel} from './copy.ts';
import './reading-presence.css';

export type MaintenanceTaskAction=(jobId:string,action:'dismiss'|'restore')=>Promise<void>;
function taskJob(app:ApplicationSnapshot,activity:Activity){
  const job=activity.jobId&&app.state.maintenanceJobs?.find(item=>item.id===activity.jobId);
  return job&&(!activity.requestId||activity.requestId===job.pendingDispatch?.usageId)?job:undefined;
}

/** Show actual work stages, not a guessed percentage of a model response. */
export function ReadingTaskProgress({app,activity}:{app:ApplicationSnapshot;activity:Activity}){
  const job=taskJob(app,activity),usage=app.state.usage.find(item=>item.id===(activity.requestId??job?.pendingDispatch?.usageId));
  const complete=activity.stage==='complete'||activity.stage==='quiet';
  const received=usage?.status==='complete'&&usage.dispatchState==='response-received';
  const sent=usage?.dispatchState==='dispatch-started'||usage?.dispatchState==='response-received'||usage?.status==='unknown';
  const phase=complete?4:activity.stage==='saving'?3:activity.stage==='validating'||received&&['failed','paused','unknown','obsolete'].includes(activity.stage)?2:sent||['waiting-model','tools'].includes(activity.stage)?1:0;
  const working=activityResponsibility(activity)==='running',blocked=!working&&!complete;
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{if(!working)return;setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[working,activity.since]);
  const book=app.state.books.find(item=>item.id===activity.bookId),remaining=job&&book?subtractRanges([...job.ranges],[...book.prepared]).reduce((total,range)=>total+range.end-range.start,0):0;
  const pendingChats=activity.progress?.pendingChats??job?.chatIds.length??0,pendingViews=activity.progress?.pendingViews??job?.viewTargets?.length??0;
  return <div className="reading-task-progress">
    <ol aria-label={t("处理步骤")}>{[t("准备材料"),t("模型处理"),t("核对结果"),t("保存完成")].map((label,index)=><li key={label} className={index<phase?'is-done':index===phase?(blocked?'is-stopped':'is-current'):'is-next'} aria-current={index===phase?'step':undefined}><i aria-hidden="true">{index<phase?'✓':index+1}</i><span>{label}</span></li>)}</ol>
    {job&&<p className="reading-task-work">{[remaining?t("{0} 字原文",remaining.toLocaleString(locale())):undefined,pendingChats?t("{0} 条交流",pendingChats):undefined,pendingViews?t("{0} 份概要",pendingViews):undefined].filter(Boolean).join(' · ')||t("正在完成最后的保存")}{job.dismissed?t(" · 已停止自动处理"):''}</p>}
    {!!(activity.progress?.savedDocuments||activity.progress?.savedViews)&&<small>{t("已保存")}{[activity.progress.savedDocuments?t("{0} 份资料",activity.progress.savedDocuments):undefined,activity.progress.savedViews?t("{0} 份概要",activity.progress.savedViews):undefined].filter(Boolean).join('、')}{t("，继续处理剩余内容。")}</small>}
    {working&&<small>{activity.stage==='tools'?t("正在查阅资料"):activity.stage==='waiting-model'?t("等待模型返回内容"):t("当前步骤")} {t("· 已用")}{Math.max(0,Math.floor((now-activity.since)/1000))} {t("秒")}</small>}
    {job?.dismissed&&<small>{t("未完成的内容保留在历史中，恢复并继续后才会处理。")}</small>}
  </div>;
}

export function MaintenanceTaskActions({app,activity,onAction,disabled=false}:{app:ApplicationSnapshot;activity:Activity;onAction?:MaintenanceTaskAction;disabled?:boolean}){
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const job=taskJob(app,activity);
  if(!job||!onAction||activityResponsibility(activity)==='running')return null;
  const act=async()=>{if(busy||disabled)return;setBusy(true);setError('');try{await onAction(job.id,job.dismissed?'restore':'dismiss');}catch(cause){setError(workbenchErrorLabel(cause instanceof Error?cause.message:String(cause)));}finally{setBusy(false);}};
  return <div className="maintenance-task-actions"><button type="button" className="reading-status-link" disabled={busy||disabled} onClick={()=>void act()}>{busy?t("正在处理…"):job.dismissed?t("恢复并继续"):t("清除这项待办")}</button><small>{job.dismissed?t("接着处理原任务；需要模型继续时会产生用量。"):t("停止自动重试并移入历史；聊天、原答和费用记录保留。")}</small>{error&&<p className="reading-status-error" role="alert">{error}</p>}</div>;
}
