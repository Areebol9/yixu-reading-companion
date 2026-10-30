import { t, locale, systemText } from './i18n.ts';
import { useEffect,useState } from 'react';
import type { WorkbenchClient,WorkbenchEvent,WorkbenchSnapshot } from './contract.ts';
import { currentProcessEvents, groupProcessEvents } from './process-events.ts';

const pageSize=20;
export function ProcessEvents({snapshot,client}:{snapshot:WorkbenchSnapshot;client:WorkbenchClient}){
  const [history,setHistory]=useState(false),[limit,setLimit]=useState(pageSize),[older,setOlder]=useState<WorkbenchEvent[]>([]),[hasEarlier,setHasEarlier]=useState<boolean>(),[loading,setLoading]=useState(false),[error,setError]=useState('');
  useEffect(()=>{setHistory(false);setOlder([]);setHasEarlier(undefined);setLimit(pageSize);setError('');},[snapshot.sessionId]);
  useEffect(()=>{if(history)setOlder(value=>[...new Map([...value,...snapshot.events].map(event=>[event.id,event])).values()]);},[history,snapshot.events]);
  const rows=history?[...new Map([...older,...snapshot.events].map(event=>[event.id,event])).values()].sort((a,b)=>a.at-b.at):currentProcessEvents(snapshot),groups=groupProcessEvents(rows);
  const more=hasEarlier??snapshot.eventHistory?.hasEarlier??false;
  const showMore=async()=>{if(groups.length>limit){setLimit(value=>value+pageSize);return;}if(loading)return;setLoading(true);setError('');try{const page=await client.listProcessEvents(rows[0]?.id);setOlder([...new Map([...page.events,...rows].map(event=>[event.id,event])).values()]);setHasEarlier(page.hasEarlier);setLimit(value=>value+pageSize);}catch(error){setError(error instanceof Error?error.message:t("较早记录暂时未能读取"));}finally{setLoading(false);}};
  return <section className="process-events" aria-label={t("操作记录")}>
    <div className="process-events-heading"><h3>{t("操作记录")}</h3><button className="text-action" type="button" onClick={()=>{setHistory(value=>!value);setLimit(pageSize);}}>{history?t("返回本次相关"):t("查看全部历史")}</button></div>
    {!groups.length&&<p className="form-hint">{history?t("尚未留下操作记录。"):t("当前没有相关操作记录，历史记录可按需查看。")}</p>}
    <ol className="event-list">{groups.slice(0,limit).map(group=><li className="event-item" key={group.event.id}>
      <time>{new Date(group.event.at).toLocaleString(locale(),{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'})}{group.count>1?t(" · 相同记录 {0} 次",group.count):''}</time><h3>{systemText(group.event.title,'操作记录')}</h3>
      {(group.event.detail||group.event.requestId||group.event.chatId||group.event.elapsedMs!==undefined)&&<details className="event-identifiers"><summary>{t("查看记录内容")}</summary><p>{group.event.title}</p>{group.event.detail&&<p>{group.event.detail}</p>}{group.event.elapsedMs!==undefined&&<p>{t("本次记录耗时")}{(group.event.elapsedMs/1000).toFixed(1)} {t("秒")}</p>}{group.event.requestId&&<p>{t("请求：")}<code>{group.event.requestId}</code></p>}{group.event.chatId&&<p>{t("交流记录：")}<code>{group.event.chatId}</code></p>}</details>}
    </li>)}</ol>
    {(groups.length>limit||history&&more)&&<button type="button" className="btn btn-outline btn-small" disabled={loading} onClick={()=>void showMore()}>{loading?t("正在读取…"):t("再看较早记录")}</button>}
    {error&&<p className="form-error">{error}</p>}
    {groups.length>0&&<p className="process-events-note">{t("原始记录随阅读存档完整保留，可导出查看。")}</p>}
  </section>;
}
