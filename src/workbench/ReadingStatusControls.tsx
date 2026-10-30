import { t, locale } from './i18n.ts';
import {hasUnreadPresentation} from '../core/message-reactions.ts';
import {useEffect,useId,useRef,useState} from 'react';
import type {ReadingRecoveryCapability} from '../core/types.ts';
import type {WorkbenchSnapshot} from './contract.ts';
import type {PublishedReplyTarget} from './PublishedReplyPreview.tsx';
import {Icon} from './icons.tsx';
import {activityResponsibility,explainReadingActivity,readingStatusPresentation} from './activity-presentation.ts';
import type {Activity,ReadingActivityExplanation} from './activity-presentation.ts';
import {workbenchErrorLabel} from './copy.ts';
import './reading-presence.css';
import {ReadingTaskProgress,MaintenanceTaskActions} from './ReadingTaskProgress.tsx';
import type {MaintenanceTaskAction} from './ReadingTaskProgress.tsx';

type StatusRole='conversation'|'maintenance';
const names={get conversation(){return t("伙伴交流");},get maintenance(){return t("后台整理");}};
const groupNames={get working(){return t("正在进行");},get queued(){return t("等待中");},get paused(){return t("已暂停");},get problem(){return t("未完成的事项");}};
const brief=(text:string)=>{const glyphs=Array.from(text.trim());return glyphs.length>72?glyphs.slice(0,72).join('')+'…':text.trim();};
export type ReadingStatusControlsProps={
  snapshot:WorkbenchSnapshot;unreadReplies?:readonly PublishedReplyTarget[];
  onClearUnread:(replies:readonly PublishedReplyTarget[])=>Promise<void>;
  onLocatePending:(offset:number)=>void;
  onOpenReply:(reply:PublishedReplyTarget)=>void;onConversation:()=>void;onDetails:()=>void;
  onModels:(role:StatusRole)=>void;onRecovery:(decision:ReadingRecoveryCapability)=>Promise<void>;
  onMaintenanceAction?:MaintenanceTaskAction;
  onReconnect?:()=>Promise<void>;actionError?:string;onDismissError?:()=>void;
};
export function ReadingStatusControls({snapshot,unreadReplies=[],onClearUnread,onLocatePending,onOpenReply,onConversation,onDetails,onModels,onRecovery,onMaintenanceAction,onReconnect,actionError,onDismissError}:ReadingStatusControlsProps){
  const {app}=snapshot,bookId=snapshot.book?.id??snapshot.selectedBookId;
  const presentation=readingStatusPresentation(app,bookId??'',snapshot.following);
  const progress=app.maintenanceProgress.find(item=>item.bookId===bookId);
  const [open,setOpen]=useState<StatusRole>();
  const [busy,setBusy]=useState<string>();
  const [error,setError]=useState('');
  const [cleared,setCleared]=useState(false);
  const [expanded,setExpanded]=useState<ReadonlySet<string>>(new Set());
  const [pauseNotice,setPauseNotice]=useState(false);
  const root=useRef<HTMLDivElement>(null),buttons=useRef<Partial<Record<StatusRole,HTMLButtonElement>>>({});
  const popupId=useId();
  const paused=app.readingControl?.state==='paused'||!snapshot.following;
  const priorPause=useRef({bookId,paused});
  useEffect(()=>{setOpen(undefined);setError('');setExpanded(new Set());setPauseNotice(false);setCleared(false);},[bookId,app.state.partnerId]);
  useEffect(()=>{const previous=priorPause.current;priorPause.current={bookId,paused};if(previous.bookId===bookId&&!previous.paused&&paused)setPauseNotice(true);if(!paused)setPauseNotice(false);},[bookId,paused]);
  useEffect(()=>{if(!pauseNotice)return;const timer=setTimeout(()=>setPauseNotice(false),6500);return()=>clearTimeout(timer);},[pauseNotice]);
  useEffect(()=>{
    if(!open)return;
    const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&!root.current?.contains(event.target))setOpen(undefined);};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();setOpen(undefined);buttons.current[open]?.focus({preventScroll:true});}};
    document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',escape);};
  },[open]);
  if(!bookId&&!actionError&&!snapshot.connectionError)return null;
  const roleOf=(activity:Activity):StatusRole=>activity.kind==='maintenance'?'maintenance':'conversation';
  const items=presentation.all.filter(item=>!['history','settlement'].includes(activityResponsibility(item))&&(item.kind==='maintenance'||item.kind==='question'||activityResponsibility(item)==='running'||!!item.sessionId&&item.sessionId===app.session?.id)).map(activity=>({activity,explanation:explainReadingActivity(app,activity,snapshot.following)}));
  const statuses=(['conversation','maintenance'] as const).map(role=>{
    const own=items.filter(item=>roleOf(item.activity)===role);
    const issues=own.filter(item=>item.explanation.group==='problem').length;
    const working=own.filter(item=>item.explanation.group==='working').length;
    const waiting=own.length-issues-working;
    const needsModel=snapshot.mode==='live'&&(role==='conversation'?!snapshot.modelReady:snapshot.backgroundModelReady===false);
    const disconnected=role==='conversation'&&!!snapshot.connectionError;
    const tone=disconnected||needsModel||issues||role==='conversation'&&actionError?'attention':role==='conversation'&&unreadReplies.length?'reply':working?'working':'idle';
    const summary=[role==='conversation'&&unreadReplies.length?t("{0} 条未读",unreadReplies.length):undefined,working?t("{0} 项正在进行",working):undefined,waiting?t("{0} 项等待或暂停",waiting):undefined,issues?t("{0} 项未完成",issues):undefined,needsModel?t("需要设置模型"):undefined,disconnected?t("连接中断"):undefined].filter(Boolean).join('，')||t("暂无新活动");
    return{role,own,issues,working,needsModel,disconnected,tone,summary};
  });
  const selected=statuses.find(item=>item.role===open);
  const launch=(action:()=>void)=>{setOpen(undefined);setError('');action();};
  const run=async(key:string,action:()=>Promise<void>)=>{if(busy)return;setBusy(key);setError('');try{await action();}catch(cause){setError(workbenchErrorLabel(cause instanceof Error?cause.message:String(cause)));}finally{setBusy(undefined);}};
  const ongoing=items.filter(item=>item.explanation.group==='working').length;
  const remainder=progress?progress.queuedChars+progress.workingChars+progress.blockedChars:0;
  const pauseText=t("已暂停 · {0}{1}{2}",remainder?t("还有 {0} 字待整理",remainder.toLocaleString(locale())):t("暂无正文排队"),progress?.overviewPending?t(" · {0} 份概要待更新",progress.overviewPending):'',ongoing?t(" · {0} 项仍在收尾",ongoing):'');
  const renderItem=({activity,explanation:e}:{activity:Activity;explanation:ReadingActivityExplanation})=>{
    const question=activity.questionId?app.state.chats.find(item=>item.id===activity.questionId):undefined;
    return <li key={activity.id} className={`presence-task group-${e.group}`} data-activity-id={activity.id}>
      <div className="presence-task-heading"><strong>{e.title}</strong><time dateTime={new Date(activity.startedAt).toISOString()}>{new Date(activity.startedAt).toLocaleString(locale(),{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})}</time></div>{question&&<blockquote>{brief(question.text)}</blockquote>}
      <p>{e.detail}</p>{e.impact&&<p className="presence-impact">{e.impact}</p>}<p className="presence-next">{e.next}</p>
      <ReadingTaskProgress app={app} activity={activity}/>
      {e.decision&&e.actionLabel&&<button className="reading-status-recovery" disabled={!!busy} onClick={()=>void run(activity.id,()=>onRecovery(e.decision!))}>{busy===activity.id?t("正在处理…"):e.actionLabel}<Icon name="arrow" size={13}/></button>}
      <MaintenanceTaskActions app={app} activity={activity} onAction={onMaintenanceAction} disabled={!!busy}/>
    </li>;
  };
  const renderMessages=(replies:readonly PublishedReplyTarget[],read=false)=>{
    const categories=[['reply',t("回应我的消息")],['paragraph',t("伙伴段评")],['share',t("伙伴分享")]] as const;
    return categories.map(([category,label])=>{
      const list=replies.filter(reply=>(reply.replyTo?'reply':reply.presentation==='paragraph'?'paragraph':'share')===category).slice().sort((a,b)=>b.createdAt-a.createdAt);
      const key=(read?'read:':'unread:')+category;if(!list.length)return null;
      return <section className="presence-group" key={key}><h4>{label}<span>{list.length}</span></h4><ul className="presence-messages">{(expanded.has(key)?list:list.slice(0,4)).map(reply=><li key={reply.id}><button onClick={()=>launch(()=>onOpenReply(reply))}><span>{brief(reply.text)}</span><time>{new Date(reply.createdAt).toLocaleTimeString(locale(),{hour:'2-digit',minute:'2-digit',hour12:false})}</time><Icon name="chevron" size={12}/></button></li>)}</ul>{list.length>4&&!expanded.has(key)&&<button className="reading-status-link" onClick={()=>setExpanded(value=>new Set([...value,key]))}>{t("展开其余")}{list.length-4} {t("条")}</button>}</section>;
    });
  };
  const recent=(app.recentPublications??[]).filter(reply=>reply.bookId===bookId&&!hasUnreadPresentation(reply));
  return <div className="reading-status-controls" ref={root} aria-label={t("交流与后台活动")}>
    {statuses.map(status=><button key={status.role} ref={element=>{if(element)buttons.current[status.role]=element;}} className={`reading-status-trigger tone-${status.tone}${open===status.role?' is-open':''}`} title={`${names[status.role]}：${status.summary}`} aria-label={`${names[status.role]}：${status.summary}`} aria-haspopup="dialog" aria-expanded={open===status.role} aria-controls={open===status.role?popupId:undefined} data-reading-status-role={status.role} data-reading-status-tone={status.tone} onClick={()=>{setOpen(value=>value===status.role?undefined:status.role);setPauseNotice(false);setError('');}}>
      <Icon name={status.role==='conversation'?'chat':'leaf'} size={20}/>{status.role==='conversation'&&unreadReplies.length>0?<span className="presence-count" aria-hidden="true">{unreadReplies.length>99?'99+':unreadReplies.length}</span>:status.issues>0?<span className="presence-issue-dot" aria-hidden="true"/>:null}
    </button>)}
    {pauseNotice&&<button className="presence-pause-notice" role="status" onClick={()=>{setOpen('maintenance');setPauseNotice(false);}}>{pauseText}<Icon name="chevron" size={12}/></button>}
    {selected&&<section id={popupId} className="reading-status-popover" role="dialog" aria-modal="false" aria-labelledby={`${popupId}-title`}>
      <header><h3 id={`${popupId}-title`}>{names[selected.role]}</h3><button className="icon-btn" aria-label={t("关闭活动面板")} onClick={()=>{setOpen(undefined);buttons.current[selected.role]?.focus({preventScroll:true});}}><Icon name="close" size={15}/></button></header>
      {selected.role==='maintenance'&&progress&&<section className="presence-progress" aria-label={t("后台积压")}>
        <div><strong>{t("待整理")}{remainder.toLocaleString(locale())} {t("字")}</strong><span className={(progress.pendingChapterCount??0)>=3?'pressure-high':(progress.pendingChapterCount??0)>=2?'pressure-rising':''}>{!remainder?t("暂无正文排队"):(progress.pendingChapterCount??0)>=3?t("已超过预期"):(progress.pendingChapterCount??0)>=2?t("已有积压"):t("正在跟进")}</span></div>
        {remainder>0&&<><div className="presence-pressure-bar" role="img" aria-label={t("正在处理 {0} 字，排队 {1} 字，受阻 {2} 字",progress.workingChars,progress.queuedChars,progress.blockedChars)}><span className="pressure-working" style={{width:`${progress.workingChars/remainder*100}%`}}/><span className="pressure-queued" style={{width:`${progress.queuedChars/remainder*100}%`}}/><span className="pressure-blocked" style={{width:`${progress.blockedChars/remainder*100}%`}}/></div><div className="presence-pressure-legend"><span>{t("处理中")}{progress.workingChars.toLocaleString(locale())}</span><span>{t("排队")}{progress.queuedChars.toLocaleString(locale())}</span><span>{t("受阻")}{progress.blockedChars.toLocaleString(locale())}</span></div></>}
        {progress.oldestPending&&<button className="reading-status-link" onClick={()=>launch(()=>onLocatePending(progress.oldestPending!.start))}>{t("最早待整理：")}{progress.oldestPending.chapterTitle??t("已读片段")}<Icon name="chevron" size={12}/></button>}
        {(progress.pendingChapterCount??0)>=2&&<p>{progress.pendingChapterCount} {t("个实际已读章节仍有内容待整理")}{(progress.pendingChapterCount??0)>=3?t("，后台已落后于伴读预期"):''}。</p>}
        {!!progress.pendingChatCount&&<p>{progress.pendingChatCount} {t("条交流待整理，已经发出的消息仍可正常查看。")}</p>}<p>{progress.overviewPending?t("另有 {0} 份概要待更新。",progress.overviewPending):t("暂无概要更新排队。")}</p><small>{t("只统计已安排整理的内容；伙伴尚未了解的其他章节不计入排队。")}</small>
      </section>}
      {selected.disconnected&&<div className="presence-notice"><strong>{t("暂时连不上本机程序")}</strong><p>{t("页面里的进度可能未更新。重新连接会查询原操作的结果，不重复发送。")}</p>{onReconnect&&<button className="reading-status-recovery" disabled={!!busy} onClick={()=>void run('connection',onReconnect)}>{t("重新连接")}</button>}</div>}
      {selected.needsModel&&<div className="presence-notice"><strong>{selected.role==='conversation'?t("伙伴还没有可用的模型"):t("后台整理还没有可用的模型")}</strong><p>{t("阅读和已有记录仍可查看；选择并保存模型后，才能继续")}{selected.role==='conversation'?t("回应"):t("整理")}。</p><button className="reading-status-recovery" onClick={()=>launch(()=>onModels(selected.role))}>{selected.role==='conversation'?t('设置伙伴模型'):t('设置后台模型')}</button></div>}
      {selected.role==='conversation'&&actionError&&<div className="presence-notice"><strong>{t("刚才的操作没有完成")}</strong><p>{workbenchErrorLabel(actionError)}</p>{onDismissError&&<button className="reading-status-link" onClick={onDismissError}>{t("收起这条提示")}</button>}</div>}
      {(snapshot.clientOperations??[]).filter(operation=>operation.role===selected.role&&(!operation.bookId||operation.bookId===bookId)).map(operation=><div className="presence-notice" key={operation.id}><strong>{operation.command==='recognizeBookDirectory'?t("正在识别书籍目录"):operation.state==='confirming'?t("正在确认刚才的操作"):t("正在保存刚才的操作")}</strong><p>{operation.command==='recognizeBookDirectory'?t("正在识别章节标题和目录层级，完成后更新导航。已有目录与阅读记录保留。"):operation.state==='confirming'?t("暂未收到完成确认，程序会继续查询。无需重复点击；现有内容保留。"):t("完成后会自动更新这里，现有内容保留。")}</p></div>)}
      {selected.role==='conversation'&&<div className="presence-unread-actions"><span>{unreadReplies.length?t("{0} 条未读",unreadReplies.length):cleared?t("已清空未读"):t("暂无未读")}</span><button className="reading-status-link" disabled={!unreadReplies.length||!!busy} title={t("清除当前未读标记，所有消息仍保留")} onClick={()=>{const selectedReplies=[...unreadReplies];void run('clear-unread',async()=>{await onClearUnread(selectedReplies);setCleared(true);});}}>{busy==='clear-unread'?t("正在标记…"):t("全部标为已读")}</button></div>}
      {selected.role==='conversation'&&renderMessages(unreadReplies)}
      {(['working','queued','paused','problem'] as const).map(group=>{const list=selected.own.filter(item=>item.explanation.group===group),key=selected.role+group;if(!list.length)return null;return <section className="presence-group" key={group}><h4>{groupNames[group]}<span>{list.length}</span></h4><ul className="presence-tasks">{(expanded.has(key)?list:list.slice(0,3)).map(renderItem)}</ul>{list.length>3&&!expanded.has(key)&&<button className="reading-status-link" onClick={()=>setExpanded(value=>new Set([...value,key]))}>{t("展开其余")}{list.length-3} {t("项")}</button>}</section>;})}
      {!selected.own.length&&!selected.needsModel&&!selected.disconnected&&<p className="presence-empty">{selected.role==='conversation'?unreadReplies.length?t("点击上面的消息，在侧栏查看完整内容。"):t("暂时没有等待中的回应，随时可以聊聊。"):remainder?t("目前未在整理，继续伴读后接着处理。"):t("目前没有正在进行的整理。")}</p>}
      {selected.role==='conversation'&&recent.length>0&&<details className="presence-recent"><summary>{t("最近消息 ·")}{recent.length}</summary>{renderMessages(recent,true)}</details>}
      {error&&<p className="reading-status-error" role="alert">{error}</p>}
      <footer>{selected.role==='conversation'&&<button className="reading-status-link" onClick={()=>launch(onConversation)}>{t("打开交流")}<Icon name="arrow" size={13}/></button>}<button className="reading-status-link reading-status-details" onClick={()=>launch(onDetails)}>{t("完整记录")}<Icon name="chevron" size={12}/></button></footer>
    </section>}
  </div>;
}
