import { t, locale } from './i18n.ts';
import {MarkdownMessage} from './MarkdownMessage.tsx';
import { Fragment, useEffect, useRef, useState } from 'react';
import type { WorkbenchClient, WorkbenchPage, WorkbenchParagraphComment, WorkbenchSnapshot } from './contract.ts';
import { covers } from '../core/books.ts';
import { Drawer } from './components.tsx';
import { Icon } from './icons.tsx';
import { workbenchErrorLabel } from './copy.ts';
import {automaticRecoveryInProgress,availableRecovery,performRecovery,recoveryActionLabel,shouldShowCurrentRecovery} from './activity-presentation.ts';
import type {ReadingRecoveryCapability} from '../core/types.ts';
import {bookVersionAllowsRange} from '../core/book-versions.ts';
import type {BookView} from '../core/application-contract.ts';
import {EmojiPicker,isEmojiOnlyText,MessageEmojiReactions} from './EmojiInteraction.tsx';
import {ReplyVisibility} from './ReplyVisibility.tsx';
import {PartnerMessageAuthor,messagePartner} from './PartnerAvatar.tsx';

export type ParagraphDraft = { text: string; parentId?: string };

export function useParagraphNotes(client: WorkbenchClient, bookId: string | undefined, page: Pick<WorkbenchPage,'version'|'start'|'end'> | undefined, revision: string,book?:BookView,context?:{archiveId:string;partnerId:string}) {
  const scope = bookId && page ? JSON.stringify([context?.archiveId,bookId,context?.partnerId,page.version,page.start,page.end]) : '';
  const lineage = JSON.stringify(book?.sourceLineage ?? null);
  const [result, setResult] = useState<{ client?: WorkbenchClient; scope: string; items: WorkbenchParagraphComment[]; error: string; loading: boolean }>({ scope: '', items: [], error: '', loading: false });
  const refresh = useRef<((revision: string) => void) | undefined>(undefined);
  useEffect(() => {
    let active = true, running = false, dirty = false, latestRevision = revision;
    setResult(previous => previous.client === client && previous.scope === scope ? { ...previous, error: '', loading: !!scope } : { client, scope, items: [], error: '', loading: !!scope });
    if (!bookId || !page) { refresh.current = undefined; return; }
    const load = async () => {
      if (running || !active) return;
      running = true;
      try {
        do {
          dirty = false;
          setResult(previous => previous.client === client && previous.scope === scope ? { ...previous, error: '', loading: previous.loading || !!previous.error } : { client, scope, items: [], error: '', loading: true });
          try {
            const items = new Map<string, WorkbenchParagraphComment>(), cursors = new Set<string>();
            let cursor: string | undefined;
            do {
              const next = await client.listParagraphComments(bookId, { ranges: [{ start: page.start, end: page.end }], cursor });
              if (!active) return;
              for (const item of next.items) if (item.anchor.version === page.version||book?.id===bookId&&book.version===page.version&&item.anchor.bookId===bookId&&bookVersionAllowsRange(book,item.anchor.version,item.anchor)) items.set(item.id, item);
              cursor = next.nextCursor;
              if (cursor && cursors.has(cursor)) throw Error(t("段评读取未完成，请重新打开本段段评。"));
              if (cursor) cursors.add(cursor);
            } while (cursor);
            if (active) setResult({ client, scope, items: [...items.values()], error: '', loading: false });
          } catch (error) {
            if (active) setResult(previous => ({ client, scope, items: previous.client === client && previous.scope === scope ? previous.items : [], error: error instanceof Error ? error.message : t("段评暂时无法读取，请重新打开。"), loading: false }));
          }
        } while (active && dirty);
      } finally { running = false; }
    };
    const requestRefresh = (nextRevision: string) => {
      if (!active || nextRevision === latestRevision) return;
      latestRevision = nextRevision; dirty = true; void load();
    };
    refresh.current = requestRefresh;
    void load();
    return () => { active = false; if (refresh.current === requestRefresh) refresh.current = undefined; };
  }, [client, scope, lineage]);
  useEffect(() => { refresh.current?.(revision); }, [revision]);
  return result.client === client && result.scope === scope ? result : { items: [], error: '', loading: !!scope };
}

export function ParagraphNotesPanel({ client, snapshot, paragraph, comments, error, loading, draft, onDraftChange, onPublished, onClose, onConversation, onDetails, inline = false, presentationVisible=false }: {
  client: WorkbenchClient; snapshot: WorkbenchSnapshot; paragraph: { start: number; end: number; text: string; version?:string };
  comments: WorkbenchParagraphComment[]; error: string; loading: boolean; draft: ParagraphDraft;
  onDraftChange: (draft: ParagraphDraft) => void; onPublished: (submitted: ParagraphDraft) => void;
  onClose: () => void; onConversation: (conversationId?: string,chatId?:string) => void; onDetails: () => void; inline?: boolean; presentationVisible?:boolean;
}) {
  const [saving, setSaving] = useState(false), [requesting, setRequesting] = useState<string>(), [liking, setLiking] = useState<string>(), [confirming, setConfirming] = useState(false);
  const [actionError, setActionError] = useState(''), [notice, setNotice] = useState('');
  const [reacting,setReacting]=useState<ReadonlySet<string>>(new Set()),[choosingEmoji,setChoosingEmoji]=useState(false);
  const reactionRequests=useRef(new Set<string>());
  const retainedStreams=useRef(new Map<string,NonNullable<WorkbenchSnapshot['streamingReplies']>[number]>()),streamScope=useRef('');
  const composer = useRef<HTMLTextAreaElement>(null), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),4000);return()=>clearTimeout(timer);},[notice]);
  const book = snapshot.book, stopping = snapshot.app.readingControl?.state === 'stopping';
  const partnerName = snapshot.app.state.partners.find(item => item.id === snapshot.app.state.partnerId)?.name || t("伙伴");
  const author = (comment: WorkbenchParagraphComment) => comment.role === 'user' ? t("我") : messagePartner(snapshot.app.state.partners,comment.partnerId)?.name || t("未命名伙伴");
  const target = draft.parentId ? comments.find(comment => comment.id === draft.parentId) : undefined;
  const sourceAnchor = target?.anchor ?? { start: paragraph.start, end: paragraph.end, quote: paragraph.text, version: paragraph.version ?? book?.version ?? '' };
  const compatible=!!book&&bookVersionAllowsRange(book,sourceAnchor.version,sourceAnchor);
  const anchor={...sourceAnchor,version:book?.version??''};
  const allowed = compatible && !!book && covers(book.known, anchor);
  const commentMap = new Map(comments.map(comment => [comment.id, comment]));
  const currentStreamScope=JSON.stringify([snapshot.sessionId,book?.id,snapshot.app.state.partnerId]);
  if(streamScope.current!==currentStreamScope){streamScope.current=currentStreamScope;retainedStreams.current.clear();}
  for(const reply of snapshot.streamingReplies??[])if(reply.bookId===book?.id&&reply.paragraphCommentId&&commentMap.has(reply.paragraphCommentId)){
    for(const [id,previous]of retainedStreams.current)if(previous.questionId===reply.questionId&&id!==reply.requestId)retainedStreams.current.delete(id);
    retainedStreams.current.set(reply.requestId,reply);
  }
  // The queried comment list can arrive after the commit snapshot. Keep the
  // displayed words until that same thread's saved answer is actually here.
  for(const [id,reply] of retainedStreams.current)if(comments.some(comment=>comment.role==='assistant'&&comment.replyTo===reply.paragraphCommentId))retainedStreams.current.delete(id);
  const depth = (comment: WorkbenchParagraphComment) => {
    let level = 0, next = comment.replyTo, seen = new Set([comment.id]);
    while (next && commentMap.has(next) && !seen.has(next)) { seen.add(next); level++; next = commentMap.get(next)?.replyTo; }
    return Math.min(level, 3);
  };
  const root = (comment: WorkbenchParagraphComment) => {
    let item = comment, seen = new Set([item.id]);
    while (item.replyTo && commentMap.has(item.replyTo) && !seen.has(item.replyTo)) { item = commentMap.get(item.replyTo)!; seen.add(item.id); }
    return item;
  };
  const ordered = comments.slice().sort((a, b) => root(a).createdAt - root(b).createdAt || root(a).id.localeCompare(root(b).id) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  async function publish() {
    if (!book || !draft.text.trim() || !allowed || saving || stopping || draft.parentId && !target) return;
    const submitted = { ...draft };
    setSaving(true); setActionError(''); setNotice('');
    try {
      await client.postParagraphComment(book.id, { range: { start: anchor.start, end: anchor.end }, version: anchor.version, quote: anchor.quote, text: submitted.text, parentId: submitted.parentId });
      onPublished(submitted);
      if (active.current) setNotice(t("已发表并保存。"));
    } catch (error) { if (active.current) setActionError(workbenchErrorLabel(error instanceof Error ? error.message : t("段评保存未完成。输入已保留，请查看处理详情。"))); }
    finally { if (active.current) setSaving(false); }
  }
  async function like(comment: WorkbenchParagraphComment) {
    if (!book || liking) return;
    setLiking(comment.id); setActionError('');
    try { await client.setParagraphCommentLiked(book.id, comment.id, !comment.liked); }
    catch (error) { if (active.current) setActionError(workbenchErrorLabel(error instanceof Error ? error.message : t("点赞未保存，请重试。"))); }
    finally { if (active.current) setLiking(undefined); }
  }
  async function react(comment:WorkbenchParagraphComment,emoji:string,value:boolean){
    if(!book||reactionRequests.current.has(comment.id))return;
    reactionRequests.current.add(comment.id);setReacting(new Set(reactionRequests.current));setActionError('');
    try{await client.setMessageEmojiReaction(book.id,comment.id,emoji,value);}
    catch(error){if(active.current)setActionError(workbenchErrorLabel(error instanceof Error?error.message:t("表情回应未保存，请重试。")));}
    finally{reactionRequests.current.delete(comment.id);if(active.current)setReacting(new Set(reactionRequests.current));}
  }
  async function openConversationMessage(chatId:string){
    if(!book)return;setActionError('');
    try{const page=await client.listConversationMessages(book.id,{aroundId:chatId,limit:1});if(active.current){onConversation(page.conversationId,chatId);onClose();}}
    catch(error){if(active.current)setActionError(workbenchErrorLabel(error instanceof Error?error.message:t("这条交流暂时未能打开")));}
  }
  async function confirmRead() {
    if (!book || !compatible || confirming || stopping) return;
    setConfirming(true); setActionError('');
    try { await client.confirmParagraphRead(book.id, { start: anchor.start, end: anchor.end }, anchor.version); }
    catch (error) { if (active.current) setActionError(workbenchErrorLabel(error instanceof Error ? error.message : t("已读范围确认未完成，请重试。"))); }
    finally { if (active.current) setConfirming(false); }
  }
  async function requestReply(comment: WorkbenchParagraphComment, decision?:ReadingRecoveryCapability) {
    if (!book || requesting || !decision && stopping) return;
    if (!decision && !snapshot.modelReady) { setActionError(t("请先在“模型设置”中选择模型服务并保存，再请伙伴回应。已发表的段评会保留。")); return; }
    setRequesting(comment.id); setActionError(''); setNotice('');
    try { await (decision ? performRecovery(client,decision) : client.requestParagraphReply(book.id, comment.id)); if (active.current) setNotice(decision?t("回应状态已更新。"):t("已邀请伙伴回应，可以继续阅读。")); }
    catch (error) { if (active.current) setActionError(workbenchErrorLabel(error instanceof Error ? error.message : t("回应未完成，请查看处理详情。原段评已保留。"))); }
    finally { if (active.current) setRequesting(undefined); }
  }
  const close = () => { if (!saving) onClose(); };
  const content = <>
    <blockquote className="paragraph-source">{paragraph.text.length > 180 ? paragraph.text.slice(0, 180) + '…' : paragraph.text}</blockquote>
    {paragraph.text.length > 180 && <details className="note-anchor"><summary>{t("查看本段全文")}</summary><blockquote>{paragraph.text}</blockquote></details>}
    {error && <p className="callout amber" role="alert">{workbenchErrorLabel(error)}</p>}
    {loading && <p className="form-hint" role="status">{t("正在读取段评…")}</p>}
    {!comments.length && !error && !loading && <p className="empty-detail">{t("可以为本段写下第一条段评。")}</p>}
    {ordered.map((comment,index) => {
      const parent = comment.replyTo ? commentMap.get(comment.replyTo) : undefined;
      const formedAt = book?.chapters.find(chapter => chapter.start < comment.formedThrough && chapter.end >= comment.formedThrough)?.title;
      const shared = comment.sharedChatId;
      const answer = comment.replyChatId&&!commentMap.has(comment.replyChatId)?comment.replyChatId:undefined;
      const replied = comment.delivery === 'answered' || !!comment.replyChatId || !!answer || comments.some(item => item.role === 'assistant' && item.replyTo === comment.id);
      const pending = comment.delivery === 'pending';
      const questionActivities=snapshot.app.activities.filter(activity=>activity.bookId===book?.id&&(!activity.partnerId||activity.partnerId===snapshot.app.state.partnerId)&&(activity.questionId===comment.id||activity.recovery?.target?.kind==='question'&&activity.recovery.target.questionId===comment.id));
      const recoveries=questionActivities.filter(activity=>shouldShowCurrentRecovery(activity,snapshot.app)).map(availableRecovery).filter((decision):decision is NonNullable<ReturnType<typeof availableRecovery>>=>!!decision&&decision.target?.kind==='question'&&decision.target.questionId===comment.id);
      const savingReply=questionActivities.some(automaticRecoveryInProgress);
      const threadRoot=root(comment).id;
      const streams=root(ordered[index+1]??comment).id!==threadRoot||index===ordered.length-1?[...retainedStreams.current.values()].filter(reply=>reply.paragraphCommentId&&commentMap.has(reply.paragraphCommentId)&&root(commentMap.get(reply.paragraphCommentId)!).id===threadRoot):[];
      return <Fragment key={comment.id}><article className={`paragraph-note${draft.parentId === comment.id ? ' selected' : ''}`} style={{ marginLeft: depth(comment) * 12 }} data-comment-id={comment.id}>
        <div className="paragraph-note-meta">{comment.role === 'assistant' ? <PartnerMessageAuthor client={client} partners={snapshot.app.state.partners} partnerId={comment.partnerId} /> : <span>{t("我")}</span>}<span>{comment.status === 'outdated' ? t(" · 历史段评") : ''}{comment.recoveredFrom?t(" · 先前回复已保存"):''}</span><time dateTime={new Date(comment.createdAt).toISOString()}>{new Date(comment.createdAt).toLocaleString(locale())}</time></div>
        {comment.replyTo && <div className="note-reply-target">{parent ? t("回复{0}：{1}{2}",author(parent),parent.text.slice(0, 70),parent.text.length > 70 ? '…' : '') : t("回复原线程中的历史评论")}</div>}
        <div className={isEmojiOnlyText(comment.text)?'emoji-only-text':undefined}>{comment.role==='assistant'?<ReplyVisibility chatId={comment.id} client={client} text={comment.text} visible={presentationVisible} confirmed={false} recordTiming={false} paragraphComment={comment}/>:<MarkdownMessage text={comment.text}/>}</div>
        <MessageEmojiReactions reactions={comment.emojiReactions} partnerName={partnerName} disabled={reacting.has(comment.id)} onToggle={(emoji,value)=>void react(comment,emoji,value)}/>
        {comment.role === 'assistant' && <small>{comment.formedThrough > paragraph.end ? t("后续阅读时发表 · ") : ''}{t("形成时读到")}{formedAt ?? t("已确认的阅读范围")}</small>}
        {comment.anchor.start < paragraph.start || comment.anchor.end > paragraph.end ? <details className="note-anchor"><summary>{t("查看完整引用原文")}</summary><blockquote>{comment.anchor.quote}</blockquote></details> : null}
        <div className="memory-actions"><button className="text-action" onClick={() => { onDraftChange({ ...draft, parentId: comment.id }); setActionError(''); composer.current?.focus(); }}>{t("回复")}</button><button className={`text-action${comment.liked ? ' liked' : ''}`} aria-pressed={comment.liked} aria-busy={liking===comment.id} disabled={!!liking} onClick={() => void like(comment)}><Icon name="heart" size={12} />{liking===comment.id ? t("保存中…") : comment.liked ? t("取消赞") : t("点赞")}</button>{comment.role === 'user' && !replied && recoveries.map(decision=><button key={JSON.stringify(decision!.target)} className="text-action" disabled={!!requesting||snapshot.busyAction} onClick={()=>void requestReply(comment,decision!)}>{requesting===comment.id?t("正在处理…"):recoveryActionLabel(decision!)}</button>)}{comment.role === 'user' && !replied && !recoveries.length && !savingReply && comment.delivery===undefined && <button className="text-action" disabled={!!requesting||stopping} onClick={()=>void requestReply(comment)}>{requesting===comment.id?t("等待回应…"):t("请伙伴回应")}</button>}{comment.role === 'user' && !replied && !savingReply && pending && !recoveries.length && <small>{t("正在回应")}</small>}{savingReply&&<small>{t("正在保存回应")}</small>}{comment.role === 'user' && !replied && !savingReply && ['failed','stopped'].includes(comment.delivery??'') && !recoveries.length && <button className="text-action" onClick={onDetails}>{t("查看原问题状态")}</button>}{answer && <button className="text-action" onClick={() => void openConversationMessage(answer)}>{t("查看伙伴回应")}</button>}{shared && <button className="text-action" onClick={() => void openConversationMessage(shared)}>{t("查看相关话题")}</button>}</div>
        {replied && comment.role === 'user' && <small>{t("伙伴已回应这条评论。")}</small>}
      </article>{streams.map(reply=><article className="paragraph-note paragraph-stream-reply" key={reply.requestId} style={{marginLeft:Math.min(depth(commentMap.get(reply.paragraphCommentId!)!)+1,3)*12}}><div className="paragraph-note-meta"><PartnerMessageAuthor client={client} partners={snapshot.app.state.partners} partnerId={reply.partnerId} /></div><small>{reply.state==='saving'?t("正在保存回应…"):reply.state==='incomplete'?t("回应尚未收全，已收到的内容保留"):t("正在回应…")}</small><MarkdownMessage text={reply.text}/></article>)}</Fragment>;
    })}
    <div className="note-followup"><h3>{draft.parentId ? t("回复段评") : t("写段评")}</h3>{target && <div className="note-composer-target">{t("回复")}{author(target)}：{target.text.slice(0, 100)}{target.text.length > 100 ? '…' : ''}<button className="text-action" onClick={() => onDraftChange({ text: draft.text })}>{t("改为评论本段")}</button></div>}{draft.parentId && !target && !loading && <p className="callout amber">{t("所回复的评论当前不可用。输入仍保留，可改为评论本段。")}</p>}<label className="form-field"><span>{draft.parentId ? t("回复内容") : t("段评内容")}</span><textarea ref={composer} aria-label={t("段评内容")} rows={4} maxLength={20000} value={draft.text} onChange={event => onDraftChange({ ...draft, text: event.target.value })} disabled={saving} /></label>
      {!allowed && <div className="callout amber">{t("本段尚未完整获准使用。输入会保留。")}<p>{t("如果已经读过完整段落，可只授权本段，阅读进度会更新至段末；此操作不补读、不请求模型。")}</p><button className="btn btn-outline btn-small" disabled={confirming || stopping} onClick={() => void confirmRead()}>{confirming ? t("正在确认…") : t("确认我已读过本段")}</button></div>}
      <div className="note-composer-emoji"><button type="button" className="text-action" aria-expanded={choosingEmoji} disabled={saving} onClick={()=>setChoosingEmoji(value=>!value)}>{t("插入表情")}</button>{choosingEmoji&&<EmojiPicker onClose={()=>setChoosingEmoji(false)} onSelect={emoji=>{const start=composer.current?.selectionStart??draft.text.length,end=composer.current?.selectionEnd??start;onDraftChange({...draft,text:draft.text.slice(0,start)+emoji+draft.text.slice(end)});requestAnimationFrame(()=>{composer.current?.focus();composer.current?.setSelectionRange(start+emoji.length,start+emoji.length);});}}/>}</div>
      <p className="form-hint">{t("发表会保存到当前阅读存档。")}{snapshot.mode === 'offline' ? t("当前是界面演示，明确回应使用固定技术回复。") : snapshot.following && snapshot.app.readingControl?.state !== 'paused' ? t("伙伴可在对应阅读现场自然参与；明确回应请使用评论下方的按钮。") : t("暂停或未开启伴读时只保存；明确请伙伴回应会使用模型服务。")}{t("点赞和表情回应只记录本条互动，不会请求模型。")}</p>
      {notice && <p className="paragraph-feedback" role="status">{notice}</p>}{actionError && <div className="callout amber" role="alert">{actionError}<button className="text-action" onClick={onDetails}>{t("查看处理详情")}</button></div>}
      <button className="btn btn-primary" disabled={saving || !draft.text.trim() || !allowed || stopping || !!draft.parentId && !target} onClick={() => void publish()}>{saving ? t("正在保存…") : draft.parentId ? t("发表回复") : t("发表段评")}</button>
    </div>
  </>;
  return inline ? <section className="inline-note-panel" aria-label={t("本段段评")}><header className="inline-note-header"><div><h2>{t("本段段评")}</h2><p>{t("我与伙伴的评论，保存在本机阅读存档")}</p></div><button className="icon-btn" aria-label={t("关闭段评，返回交流")} disabled={saving} onClick={close}><Icon name="close" size={16} /></button></header><div className="inline-note-content">{content}</div></section> : <Drawer title={t("本段段评")} subtitle={t("我与伙伴的评论，保存在本机阅读存档")} onClose={close}>{content}</Drawer>;
}
