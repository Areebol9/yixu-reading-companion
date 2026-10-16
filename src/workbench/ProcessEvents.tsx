import { useState } from 'react';
import type { WorkbenchSnapshot } from './contract.ts';
import { currentProcessEvents, groupProcessEvents } from './process-events.ts';

const pageSize=20;
export function ProcessEvents({snapshot}:{snapshot:WorkbenchSnapshot}){
  const [history,setHistory]=useState(false),[limit,setLimit]=useState(pageSize);
  const groups=groupProcessEvents(history?snapshot.events:currentProcessEvents(snapshot));
  return <section className="process-events" aria-label="操作记录">
    <div className="process-events-heading"><h3>操作记录</h3><button className="text-action" type="button" onClick={()=>{setHistory(value=>!value);setLimit(pageSize);}}>{history?'返回本次相关':'查看全部历史'}</button></div>
    {!groups.length&&<p className="form-hint">{history?'尚未留下操作记录。':'当前没有相关操作记录，历史记录可按需查看。'}</p>}
    <ol className="event-list">{groups.slice(0,limit).map(group=><li className="event-item" key={group.event.id}>
      <time>{new Date(group.event.at).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'})}{group.count>1?` · 相同记录 ${group.count} 次`:''}</time><h3>{group.event.title}</h3>
      {(group.event.detail||group.event.requestId||group.event.chatId||group.event.elapsedMs!==undefined)&&<details className="event-identifiers"><summary>查看记录内容</summary>{group.event.detail&&<p>{group.event.detail}</p>}{group.event.elapsedMs!==undefined&&<p>本次记录耗时 {(group.event.elapsedMs/1000).toFixed(1)} 秒</p>}{group.event.requestId&&<p>请求：<code>{group.event.requestId}</code></p>}{group.event.chatId&&<p>交流记录：<code>{group.event.chatId}</code></p>}</details>}
    </li>)}</ol>
    {groups.length>limit&&<button type="button" className="btn btn-outline btn-small" onClick={()=>setLimit(value=>value+pageSize)}>再看较早记录</button>}
    {groups.length>0&&<p className="process-events-note">原始记录随阅读存档完整保留，可导出查看。</p>}
  </section>;
}
