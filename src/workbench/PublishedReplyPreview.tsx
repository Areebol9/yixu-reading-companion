import { t } from './i18n.ts';
import {hasUnreadPresentation} from '../core/message-reactions.ts';
import {useEffect,useMemo,useRef,useState} from 'react';
import type {PublishedReplyView} from '../core/application-contract.ts';
import type {WorkbenchClient,WorkbenchSnapshot} from './contract.ts';
import './published-reply-preview.css';

export type PublishedReplyTarget=PublishedReplyView;
function publishedTargets(snapshot:WorkbenchSnapshot):PublishedReplyTarget[]{
  return (snapshot.app.recentPublications??[]).filter(reply=>reply.bookId===snapshot.book?.id);
}
function previewText(text:string):string{
  const first=text.trim().split(/(?<=[，。！？；、\n])/u)[0]??text.trim();
  const glyphs=[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(first)].map(item=>item.segment);
  return glyphs.length>38?glyphs.slice(0,38).join('')+'…':first;
}
type Preview={scope:string;chat:PublishedReplyTarget;more:number;expiresAt:number};
export function PublishedReplyPreview({client,snapshot,enabled,onOpen,onUnreadChange}:{
  client:WorkbenchClient;snapshot:WorkbenchSnapshot;enabled:boolean;onOpen:(chat:PublishedReplyTarget)=>void;onUnreadChange?:(hasUnread:boolean,latestUnread:PublishedReplyTarget|undefined,unread:readonly PublishedReplyTarget[])=>void;
}){
  const scope=JSON.stringify([snapshot.sessionId,snapshot.book?.id,snapshot.app.state.partnerId,snapshot.book?.version]);
  const [preview,setPreview]=useState<Preview>();
  const [visible,setVisible]=useState(()=>document.visibilityState==='visible');
  const latest=useRef({snapshot,scope,enabled});latest.current={snapshot,scope,enabled};
  const mounted=useRef(true),unreadCallback=useRef(onUnreadChange);unreadCallback.current=onUnreadChange;
  const claiming=useRef(new Set<string>()),claimed=useRef(new Set<string>());
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[client]);
  useEffect(()=>{setPreview(undefined);claimed.current.clear();},[client,scope]);
  const targets=useMemo(()=>publishedTargets(snapshot),[snapshot.app.recentPublications,snapshot.book?.id]);
  // A short notice never consumes the persistent unread record.
  const unread=useMemo(()=>targets.filter(chat=>hasUnreadPresentation(chat)),[targets]);
  const unreadKey=JSON.stringify([scope,unread.map(chat=>chat.id)]);
  useEffect(()=>{unreadCallback.current?.(unread.length>0,unread.at(-1),unread);},[scope,unread]);
  useEffect(()=>{
    setPreview(previous=>previous&&(previous.scope!==scope||!enabled||!visible||!targets.some(chat=>chat.id===previous.chat.id&&hasUnreadPresentation(chat)))?undefined:previous);
    if(!enabled||!visible)return;
    const candidates=unread.filter(chat=>chat.presentation==='paragraph'&&chat.presentationReceipt?.notifiedAt===undefined&&!claimed.current.has(chat.id)&&!claiming.current.has(chat.id));
    for(const candidate of candidates)claiming.current.add(candidate.id);
    void (async()=>{
      for(const candidate of candidates){
        try{
          const before=latest.current;
          if(!mounted.current||before.scope!==scope||!before.enabled||document.visibilityState!=='visible')continue;
          const live=publishedTargets(before.snapshot).find(chat=>chat.id===candidate.id);
          if(!live||!hasUnreadPresentation(live))continue;
          const firstNotice=await client.recordMessagePresentation(live.bookId,live.id,'notified'),after=latest.current;
          if(firstNotice&&after.scope===scope)claimed.current.add(candidate.id);
          if(!firstNotice||!mounted.current||after.scope!==scope||!after.enabled||document.visibilityState!=='visible')continue;
          const available=publishedTargets(after.snapshot).find(chat=>chat.id===candidate.id);
          if(!available||!hasUnreadPresentation(available))continue;
          setPreview(previous=>previous?.scope===scope?{...previous,more:previous.more+1}:{scope,chat:available,more:0,expiresAt:Date.now()+4000});
        }catch{/* The persistent unread entry remains available. */}
        finally{claiming.current.delete(candidate.id);}
      }
    })();
  },[client,targets,unreadKey,scope,enabled,visible]);
  const expiresAt=preview?.expiresAt;
  useEffect(()=>{if(expiresAt===undefined)return;const timer=setTimeout(()=>setPreview(undefined),Math.max(0,expiresAt-Date.now()));return()=>clearTimeout(timer);},[expiresAt]);
  useEffect(()=>{
    const hide=()=>{setVisible(document.visibilityState==='visible');if(document.visibilityState!=='visible')setPreview(undefined);};document.addEventListener('visibilitychange',hide);return()=>document.removeEventListener('visibilitychange',hide);
  },[]);
  if(!preview||preview.scope!==scope||!enabled)return null;
  return <div className="published-reply-preview" role="status"><button type="button" className="published-preview-open" onClick={()=>{onOpen(preview.chat);setPreview(undefined);}}><span className="published-preview-label">{t("伙伴的段评")}{preview.more>0?t(" · 另 {0} 条",preview.more):''}</span><span className="published-preview-quote">{previewText(preview.chat.text)}</span></button><button type="button" className="published-preview-close" aria-label={t("收起段评预览")} onClick={()=>setPreview(undefined)}>×</button></div>;
}
