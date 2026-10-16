import { useEffect, useRef, useState } from 'react';
import type { WorkbenchClient, WorkbenchPage, WorkbenchParagraphComment, WorkbenchSnapshot } from './contract.ts';
import { covers } from '../core/books.ts';
import { Drawer } from './components.tsx';
import { Icon } from './icons.tsx';
import { workbenchErrorLabel } from './copy.ts';

export type ParagraphDraft = { text: string; parentId?: string };

export function useParagraphNotes(client: WorkbenchClient, bookId: string | undefined, page: WorkbenchPage | undefined, revision: string) {
  const [result, setResult] = useState<{ items: WorkbenchParagraphComment[]; error: string; loading: boolean }>({ items: [], error: '', loading: false });
  useEffect(() => {
    let active = true;
    setResult({ items: [], error: '', loading: !!bookId && !!page });
    if (!bookId || !page) return;
    void (async () => {
      const items = new Map<string, WorkbenchParagraphComment>(), cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const next = await client.listParagraphComments(bookId, { ranges: [{ start: page.start, end: page.end }], cursor });
        if (!active) return;
        for (const item of next.items) if (item.anchor.version === page.version) items.set(item.id, item);
        cursor = next.nextCursor;
        if (cursor && cursors.has(cursor)) throw Error('段评读取未完成，请重新打开本段段评。');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      if (active) setResult({ items: [...items.values()], error: '', loading: false });
    })().catch(error => { if (active) setResult({ items: [], error: error instanceof Error ? error.message : '段评暂时无法读取，请重新打开。', loading: false }); });
    return () => { active = false; };
  }, [client, bookId, page?.start, page?.end, page?.version, revision]);
  return result;
}

export function ParagraphNotesPanel({ client, snapshot, paragraph, comments, error, loading, draft, onDraftChange, onPublished, onClose, onConversation, onDetails, inline = false }: {
  client: WorkbenchClient; snapshot: WorkbenchSnapshot; paragraph: { start: number; end: number; text: string };
  comments: WorkbenchParagraphComment[]; error: string; loading: boolean; draft: ParagraphDraft;
  onDraftChange: (draft: ParagraphDraft) => void; onPublished: (submitted: ParagraphDraft) => void;
  onClose: () => void; onConversation: (conversationId?: string) => void; onDetails: () => void; inline?: boolean;
}) {
  const [saving, setSaving] = useState(false), [requesting, setRequesting] = useState<string>(), [liking, setLiking] = useState<string>(), [confirming, setConfirming] = useState(false);
  const [actionError, setActionError] = useState(''), [notice, setNotice] = useState('');
  const composer = useRef<HTMLTextAreaElement>(null), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const book = snapshot.book, stopping = snapshot.app.readingControl?.state === 'stopping';
  const partnerName = snapshot.app.state.partners.find(item => item.id === snapshot.app.state.partnerId)?.name || '伙伴';
  const author = (comment: WorkbenchParagraphComment) => comment.role === 'user' ? '我' : partnerName;
  const target = draft.parentId ? comments.find(comment => comment.id === draft.parentId) : undefined;
  const anchor = target?.anchor ?? { start: paragraph.start, end: paragraph.end, quote: paragraph.text, version: book?.version ?? '' };
  const allowed = !!book && covers(book.known, anchor);
  const commentMap = new Map(comments.map(comment => [comment.id, comment]));
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
      if (active.current) setNotice('已发表并保存到本机。需要明确回应时，点击这条评论的“请伙伴回应”。');
    } catch (error) { if (active.current) setActionError(workbenchErrorLabel(error instanceof Error ? error.message : '段评保存未完成。输入已保留，请查看处理详情。')); }
    finally { if (active.current) setSaving(false); }
  }
  async function like(comment: WorkbenchParagraphComment) {
    if (!book || liking) return;
    setLiking(comment.id); setActionError('');
    try { await client.setParagraphCommentLiked(book.id, comment.id, !comment.liked); }
    catch (error) { if (active.current) setActionError(workbenchErrorLabel(error instanceof Error ? error.message : '点赞未保存，请重试。')); }
    finally { if (active.current) setLiking(undefined); }
  }
  async function confirmRead() {
    if (!book || confirming || stopping) return;
    setConfirming(true); setActionError('');
    try { await client.confirmParagraphRead(book.id, { start: anchor.start, end: anchor.end }, anchor.version); }
    catch (error) { if (active.current) setActionError(workbenchErrorLabel(error instanceof Error ? error.message : '已读范围确认未完成，请重试。')); }
    finally { if (active.current) setConfirming(false); }
  }
  async function requestReply(comment: WorkbenchParagraphComment, recover = false) {
    if (!book || requesting || stopping) return;
    if (!recover && !snapshot.modelReady) { setActionError('请先在“模型设置”中选择模型服务并保存，再请伙伴回应。已发表的段评会保留。'); return; }
    setRequesting(comment.id); setActionError(''); setNotice('');
    try { await (recover ? client.recoverQuestionReceipt(comment.id) : client.requestParagraphReply(book.id, comment.id)); if (active.current) setNotice('回应状态已更新，可在相关话题中查看。'); }
    catch (error) { if (active.current) setActionError(workbenchErrorLabel(error instanceof Error ? error.message : '回应未完成，请查看处理详情。原段评已保留。')); }
    finally { if (active.current) setRequesting(undefined); }
  }
  const close = () => { if (!saving) onClose(); };
  const content = <>
    <blockquote className="paragraph-source">{paragraph.text.length > 180 ? paragraph.text.slice(0, 180) + '…' : paragraph.text}</blockquote>
    {paragraph.text.length > 180 && <details className="note-anchor"><summary>查看本段全文</summary><blockquote>{paragraph.text}</blockquote></details>}
    {error && <p className="callout amber" role="alert">{workbenchErrorLabel(error)}</p>}
    {loading && <p className="form-hint" role="status">正在读取段评…</p>}
    {!comments.length && !error && !loading && <p className="empty-detail">可以为本段写下第一条段评。</p>}
    {ordered.map(comment => {
      const parent = comment.replyTo ? commentMap.get(comment.replyTo) : undefined;
      const formedAt = book?.chapters.find(chapter => chapter.start < comment.formedThrough && chapter.end >= comment.formedThrough)?.title;
      const shared = comment.sharedChatId ? snapshot.app.state.chats.find(chat => chat.id === comment.sharedChatId) : undefined;
      const answer = snapshot.app.state.chats.find(chat => chat.role === 'assistant' && chat.replyTo === comment.id && !chat.excluded);
      const replied = comment.delivery === 'answered' || !!comment.replyChatId || !!answer || comments.some(item => item.role === 'assistant' && item.replyTo === comment.id);
      const pending = comment.delivery === 'pending';
      return <article className={`paragraph-note${draft.parentId === comment.id ? ' selected' : ''}`} style={{ marginLeft: depth(comment) * 12 }} key={comment.id}>
        <div className="paragraph-note-meta"><span>{author(comment)}{comment.status === 'outdated' ? ' · 历史段评' : ''}</span><time dateTime={new Date(comment.createdAt).toISOString()}>{new Date(comment.createdAt).toLocaleString('zh-CN')}</time></div>
        {comment.replyTo && <div className="note-reply-target">{parent ? `回复${author(parent)}：${parent.text.slice(0, 70)}${parent.text.length > 70 ? '…' : ''}` : '回复原线程中的历史评论'}</div>}
        <p>{comment.text}</p>
        {comment.role === 'assistant' && <small>{comment.formedThrough > paragraph.end ? '后续阅读时发表 · ' : ''}形成时读到{formedAt ?? '已确认的阅读范围'}</small>}
        {comment.anchor.start < paragraph.start || comment.anchor.end > paragraph.end ? <details className="note-anchor"><summary>查看完整引用原文</summary><blockquote>{comment.anchor.quote}</blockquote></details> : null}
        <div className="memory-actions"><button className="text-action" onClick={() => { onDraftChange({ ...draft, parentId: comment.id }); setActionError(''); composer.current?.focus(); }}>回复</button><button className={`text-action${comment.liked ? ' liked' : ''}`} aria-pressed={comment.liked} disabled={!!liking} onClick={() => void like(comment)}><Icon name="heart" size={12} />{comment.liked ? '取消赞' : '点赞'}</button>{comment.role === 'user' && !replied && <button className="text-action" disabled={!!requesting || pending || stopping} onClick={() => void requestReply(comment, comment.receiptPending)}>{requesting === comment.id ? '等待回应…' : comment.receiptPending ? '取回原回复' : pending ? '正在回应' : comment.delivery === 'failed' || comment.delivery === 'stopped' ? '继续回应' : '请伙伴回应'}</button>}{answer && <button className="text-action" onClick={() => { onConversation(answer.sessionId); onClose(); }}>查看伙伴回应</button>}{shared && <button className="text-action" onClick={() => { onConversation(shared.sessionId); onClose(); }}>查看相关话题</button>}</div>
        {replied && comment.role === 'user' && <small>伙伴已回应这条评论。</small>}
      </article>;
    })}
    <div className="note-followup"><h3>{draft.parentId ? '回复段评' : '写段评'}</h3>{target && <div className="note-composer-target">回复{author(target)}：{target.text.slice(0, 100)}{target.text.length > 100 ? '…' : ''}<button className="text-action" onClick={() => onDraftChange({ text: draft.text })}>改为评论本段</button></div>}{draft.parentId && !target && !loading && <p className="callout amber">所回复的评论当前不可用。输入仍保留，可改为评论本段。</p>}<label className="form-field"><span>{draft.parentId ? '回复内容' : '段评内容'}</span><textarea ref={composer} aria-label="段评内容" rows={4} maxLength={20000} value={draft.text} onChange={event => onDraftChange({ ...draft, text: event.target.value })} disabled={saving} /></label>
      {!allowed && <div className="callout amber">本段尚未完整获准使用。输入会保留。<p>如果已经读过完整段落，可只授权本段，阅读进度会更新至段末；此操作不补读、不请求模型。</p><button className="btn btn-outline btn-small" disabled={confirming || stopping} onClick={() => void confirmRead()}>{confirming ? '正在确认…' : '确认我已读过本段'}</button></div>}
      <p className="form-hint">发表会保存到当前阅读存档。{snapshot.mode === 'offline' ? '当前是界面演示，明确回应使用固定技术回复。' : snapshot.following && snapshot.app.readingControl?.state !== 'paused' ? '伙伴可在对应阅读现场自然参与；明确回应请使用评论下方的按钮。' : '暂停或未开启伴读时只保存；明确请伙伴回应会使用模型服务。'}点赞只记录本人状态，不会请求模型。</p>
      {notice && <p className="callout" role="status">{notice}</p>}{actionError && <div className="callout amber" role="alert">{actionError}<button className="text-action" onClick={onDetails}>查看处理详情</button></div>}
      <button className="btn btn-primary" disabled={saving || !draft.text.trim() || !allowed || stopping || !!draft.parentId && !target} onClick={() => void publish()}>{saving ? '正在保存…' : draft.parentId ? '发表回复' : '发表段评'}</button>
    </div>
  </>;
  return inline ? <section className="inline-note-panel" aria-label="本段段评"><header className="inline-note-header"><div><h2>本段段评</h2><p>我与伙伴的评论，保存在本机阅读存档</p></div><button className="icon-btn" aria-label="关闭段评，返回交流" disabled={saving} onClick={close}><Icon name="close" size={16} /></button></header><div className="inline-note-content">{content}</div></section> : <Drawer title="本段段评" subtitle="我与伙伴的评论，保存在本机阅读存档" onClose={close}>{content}</Drawer>;
}
