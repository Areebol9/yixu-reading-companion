import { t } from './i18n.ts';
import { workbenchErrorLabel, recoveryReasonLabel } from './copy.ts';
import { useDesktopWindowState } from './desktop-window.ts';
import { useEffect, useRef, useState } from 'react';
import type { MemoryDiscoveryResult } from '../core/memory-discovery.ts';
import { memoryTextLimit } from '../core/types.ts';
import type { WorkbenchClient, WorkbenchSnapshot } from './contract.ts';
import { Dialog } from './components.tsx';
import { Icon } from './icons.tsx';
import {availableRecovery,recoveryActionLabel,activityLabel,performRecovery,shouldShowCurrentRecovery} from './activity-presentation.ts';

function MemoryEvidence({client,bookId,memoryId,rangeLabel}:{client:WorkbenchClient;bookId:string;memoryId:string;rangeLabel:(start:number,end:number)=>string}){
  const [ranges,setRanges]=useState<{start:number;end:number}[]>(),[error,setError]=useState(''),loading=useRef(false);
  return <details className="memory-evidence" onToggle={event=>{if(!event.currentTarget.open||ranges||loading.current)return;loading.current=true;setError('');void client.readMemoryEvidence(bookId,memoryId).then(setRanges,error=>setError(error instanceof Error?error.message:t("原文依据暂时未能读取"))).finally(()=>{loading.current=false;});}}><summary>{t("原文依据")}</summary>{error?<p className="form-error">{error}</p>:ranges?ranges.map((range,index)=><p className="form-hint" key={index}>{rangeLabel(range.start,range.end)} {t("· 文字位置")}{range.start}—{range.end}</p>):<p className="form-hint">{t("正在读取…")}</p>}</details>;
}

export function UnderstandingPanel({ client, snapshot }: { client: WorkbenchClient; snapshot: WorkbenchSnapshot }) {
  const [topic, setTopic] = useState(''), [subject, setSubject] = useState('');
  const [result, setResult] = useState<MemoryDiscoveryResult>(), [opened, setOpened] = useState<{ id: string; text: string; key?: string }>();
  const [editing, setEditing] = useState<string>(), [draft, setDraft] = useState(''), [forgetting, setForgetting] = useState<string>();
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const { developerMode } = useDesktopWindowState();
  const request = useRef(0), bodyRequest = useRef(0), query = useRef<{ topic?: string; subject?: string }>({});
  const book = snapshot.book;
  async function search(next = false) {
    if (!book) return;
    const id = ++request.current; setBusy(true); setError('');
    if (!next) query.current = { ...(topic.trim() ? { topic: topic.trim() } : {}), ...(subject.trim() ? { subject: subject.trim() } : {}) };
    try { const value = await client.discoverKnowledgeDocuments(book.id, { ...query.current, ...(next && result?.nextCursor ? { cursor: result.nextCursor } : {}) }); if (id === request.current) setResult(prior => next && prior ? { ...value, items: [...prior.items, ...value.items] } : value); }
    catch (error) { if (id === request.current) setError(error instanceof Error ? error.message : t("伙伴理解未能加载，请重新查找。")); }
    finally { if (id === request.current) setBusy(false); }
  }
  useEffect(() => { setResult(undefined); setOpened(undefined); setEditing(undefined); setForgetting(undefined); void search(); return () => { request.current++; bodyRequest.current++; }; }, [book?.id, snapshot.sessionId, snapshot.app.state.partnerId]);
  // Drop cached full prose when a correction, forgetting operation or source version changes.
  useEffect(() => { if (opened) { const memory = snapshot.app.state.memories.find(item => item.id === opened.id); if (!memory || memory.forgotten || memory.replacedBy || memory.invalidatedBy || memory.bodyRef?.key !== opened.key) { bodyRequest.current++; setOpened(undefined); } } }, [snapshot.app.revision, opened?.id, opened?.key]);
  async function open(id: string) { if (!book) return; setError(''); const token = ++bodyRequest.current; try { const text = await client.readMemoryBody(book.id, id); if (token === bodyRequest.current) setOpened({ id, text, key: snapshot.app.state.memories.find(item => item.id === id)?.bodyRef?.key }); } catch (error) { setError(error instanceof Error ? error.message : t("完整理解暂时读取未完成。")); } }
  async function saveCorrection() { if (!editing) return; setBusy(true); setError(''); try { await client.correctMemory(editing, draft); setEditing(undefined); setOpened(undefined); await search(); } catch (error) { setError(error instanceof Error ? error.message : t("更正暂未保存，请保留内容后重试。")); } finally { setBusy(false); } }
  async function forget() { if (!forgetting) return; setBusy(true); setError(''); try { await client.forgetMemory(forgetting); setForgetting(undefined); setOpened(undefined); await search(); } catch (error) { setError(error instanceof Error ? error.message : t("忘记操作暂未完成。")); } finally { setBusy(false); } }
  const editingMemory = snapshot.app.state.memories.find(memory => memory.id === editing);
  const rangeLabel = (start: number, end: number) => { const first = book?.chapters.find(chapter => chapter.start <= start && chapter.end > start), last = book?.chapters.find(chapter => chapter.start < end && chapter.end >= end); return t("{0}内{1}",first?.title ?? t("原文"),first?.index !== last?.index ? t(" — {0}内",last?.title ?? t("原文")) : ''); };
  return <>
    <div className="callout">{t("查看伙伴保存的理解，可按主题或人物查找。展开全文可查看依据、推测和仍未确定的内容。")}</div>
    {snapshot.app.activities.filter(activity=>activity.bookId===book?.id&&activity.kind==='maintenance'&&(!snapshot.app.state.partnerId||activity.partnerId===snapshot.app.state.partnerId||snapshot.app.state.maintenanceJobs?.some(job=>job.id===activity.jobId&&job.scope==='book'))&&shouldShowCurrentRecovery(activity,snapshot.app)).map(activity=>{
      const decision=availableRecovery(activity)!;
      const recover=()=>{setBusy(true);setError('');void performRecovery(client,decision).then(()=>search()).catch(error=>setError(error instanceof Error?error.message:String(error))).finally(()=>setBusy(false));};
      return <div className="callout amber" key={activity.id}><strong>{activityLabel(activity)}</strong><p>{recoveryReasonLabel(decision)}</p>{developerMode && decision.reason && <details><summary>{t("开发诊断")}</summary><pre>{decision.reason}</pre></details>}<button className="btn btn-outline btn-small" disabled={busy||snapshot.busyAction} onClick={recover}>{recoveryActionLabel(decision)}</button></div>;
    })}
    <form className="knowledge-search" onSubmit={event => { event.preventDefault(); void search(); }}><label className="form-field"><span>{t("主题或设定")}</span><input value={topic} onChange={event => setTopic(event.target.value)} placeholder={t("输入想了解的主题")} /></label><label className="form-field"><span>{t("人物或组织")}</span><input value={subject} onChange={event => setSubject(event.target.value)} placeholder={t("输入对象名称")} /></label><button className="btn btn-outline btn-small" disabled={busy || !book}><Icon name="search" size={14} />{busy ? t("正在找…") : t("查找")}</button>{(topic || subject) && <button className="text-action" type="button" onClick={() => { setTopic(''); setSubject(''); query.current = {}; setResult(undefined); const id = ++request.current; if (book) void client.discoverKnowledgeDocuments(book.id).then(value => { if (id === request.current) setResult(value); }).catch(error => setError(String(error))); }}>{t("查看全部")}</button>}</form>
    {error && <><p className="callout amber" role="alert">{workbenchErrorLabel(error)}</p>{developerMode && <details><summary>{t("开发诊断")}</summary><pre>{error}</pre></details>}</>}
    {!book && <p className="empty-detail">{t("选好一本书，再查看这本书的伙伴理解。")}</p>}
    {book && result && !result.items.length && <p className="empty-detail">{topic || subject ? t("暂未找到相应的已保存认识，可以换一个主题或对象。") : t("开始真实共读后，伙伴保存的理解会出现在这里。")}</p>}
    {result?.items.filter(item => { const memory = snapshot.app.state.memories.find(memory => memory.id === item.id); return memory && !memory.forgotten && !memory.invalidatedBy && !memory.replacedBy; }).map(item => { const memory = snapshot.app.state.memories.find(memory => memory.id === item.id)!; const expanded = opened?.id === item.id; return <article className="memory-item" key={item.id}><h3>{item.title || memory.documentTitle || t("伙伴理解")}</h3>{item.knowledgeDistribution?.topics.length ? <div className="knowledge-tags" aria-label={t("理解主题")}>{item.knowledgeDistribution.topics.map(tag => <span key={tag}>{tag}</span>)}</div> : null}{item.knowledgeMatchedBy === 'body-fallback' && (topic || subject) && <small className="form-hint">{t("在已有正文中找到相关内容")}</small>}{expanded ? <><p className="memory-prose">{opened.text}</p><div className="memory-actions"><button className="text-action" onClick={() => setOpened(undefined)}>{t("收起全文")}</button><button className="text-action" onClick={() => { setDraft(opened.text); setEditing(item.id); }}>{t("更正这份理解")}</button><button className="text-action" onClick={() => setForgetting(item.id)}>{t("忘记这份理解")}</button></div></> : <button className="btn btn-outline btn-small" onClick={() => void open(item.id)}>{t("查看全文")}<Icon name="chevron" size={12} /></button>}{memory.evidenceCount>0&&<MemoryEvidence client={client} bookId={memory.bookId} memoryId={memory.id} rangeLabel={rangeLabel}/>}</article>; })}
    {result?.nextCursor && <button className="btn btn-outline" disabled={busy} onClick={() => void search(true)}>{t("加载更多")}</button>}
    {editing && <Dialog title={t("更正这份理解")} onClose={() => setEditing(undefined)}><p className="callout">{t("更正保存为新版本，相关旧理解不再用于后续交流。完整正文中仍有效的部分一并保留；已有聊天保持原记录。")}</p><label className="form-field"><span>{t("更正后的完整内容")}</span><textarea rows={12} value={draft} maxLength={memoryTextLimit(editingMemory?.kind)} onChange={event => setDraft(event.target.value)} /></label>{error && <p className="callout amber" role="alert">{workbenchErrorLabel(error)}</p>}<button className="btn btn-primary" disabled={busy || !draft.trim()} onClick={() => void saveCorrection()}>{t("保存更正")}</button></Dialog>}
    {forgetting && <Dialog title={t("让伙伴忘记这份理解")} onClose={() => setForgetting(undefined)}><p className="callout">{t("这份内容与依赖它的相关认识会退出后续交流，历史交流仍可回看。这项操作与删除聊天分别处理。")}</p>{error && <p className="callout amber" role="alert">{workbenchErrorLabel(error)}</p>}<div className="dialog-actions"><button className="btn btn-outline" onClick={() => setForgetting(undefined)}>{t("保留这份理解")}</button><button className="btn btn-primary" disabled={busy} onClick={() => void forget()}>{t("确认忘记")}</button></div></Dialog>}
  </>;
}
