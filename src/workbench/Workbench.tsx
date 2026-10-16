import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { WorkbenchClient, ReplyRating, WorkbenchSnapshot } from './contract.ts';
import type { Chat } from '../core/types.ts';
import { decodeBook } from '../core/books.ts';
import { Dialog, Drawer, EmptyReader, ImportDialog, Notice } from './components.tsx';
import { Icon } from './icons.tsx';
import { SettingsPanel } from './SettingsPanel.tsx';
import type { SettingsDraft } from './SettingsPanel.tsx';
import { PartnerPanel } from './PartnerPanel.tsx';
import { ReadingRangePanel } from './ReadingRangePanel.tsx';
import { restoreReadingPosition, visibleReadingRange } from './visible-reading.ts';
import { isVolumeHeading, readingParagraphs } from './reading-layout.ts';
import { UnderstandingPanel } from './UnderstandingPanel.tsx';
import { ParagraphNotesPanel, useParagraphNotes } from './ParagraphNotes.tsx';
import { ActivityPanel } from './ActivityPanel.tsx';
import { ProcessEvents } from './ProcessEvents.tsx';
import type { ParagraphDraft } from './ParagraphNotes.tsx';
import { workbenchErrorLabel as readableError, readingStatusLabel } from './copy.ts';

const number = (value: number) => Intl.NumberFormat('zh-CN').format(value);
const time = (value: number) => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const duration = (value: number) => value < 1000 ? `${Math.max(1, Math.round(value))} 毫秒` : `${(value / 1000).toFixed(1)} 秒`;
const ratingOptions: { value: ReplyRating; label: string; icon: 'check' | 'heart' | 'flag' }[] = [{ value: 'accurate', label: '准确', icon: 'check' }, { value: 'resonant', label: '有共鸣', icon: 'heart' }, { value: 'verify', label: '需要核实', icon: 'flag' }];
type DetailTab = 'understanding' | 'process' | 'budget' | 'sessions';
function downloadJSON(result:{name:string;text:string}){const url=URL.createObjectURL(new Blob([result.text],{type:'application/json;charset=utf-8'})),anchor=document.createElement('a');anchor.href=url;anchor.download=result.name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}

function ReplyVisibility({ chatId, client, text, visible }: { chatId: string; client: WorkbenchClient; text: string; visible: boolean }) {
  const firstLine = useRef<HTMLSpanElement>(null);
  const firstIndex = Math.max(0, text.search(/\S/u));
  const firstGlyph = Array.from(text.slice(firstIndex))[0] ?? '';
  useEffect(() => {
    const element = firstLine.current;
    if (!element || !text.trim() || !visible) return;
    let intersecting = false, frame = 0, recorded = false;
    const record = () => {
      if (recorded || !intersecting || document.visibilityState !== 'visible') return;
      frame = requestAnimationFrame(() => {
        if (intersecting && document.visibilityState === 'visible') { recorded = true; client.recordVisible(chatId, firstIndex, firstIndex + firstGlyph.length); }
      });
    };
    const observer = new IntersectionObserver(entries => { intersecting = !!entries[0]?.isIntersecting; if (intersecting) record(); }, { threshold: .1 });
    observer.observe(element);
    document.addEventListener('visibilitychange', record);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', record); };
  }, [chatId, client, text, visible]);
  return <>{text.slice(0, firstIndex)}<span ref={firstLine}>{firstGlyph}</span>{text.slice(firstIndex + firstGlyph.length)}</>;
}

export function Workbench({ client }: { client: WorkbenchClient }) {
  const snapshot = useSyncExternalStore(listener => client.subscribe(listener), () => client.getSnapshot());
  const { app, book, page } = snapshot;
  const [importOpen, setImportOpen] = useState(false), [settingsOpen, setSettingsOpen] = useState(false), [detail, setDetail] = useState<DetailTab | undefined>();
  const [mobileTab, setMobileTab] = useState<'reading' | 'chat'>('reading'), [navOpen, setNavOpen] = useState(false), [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [partnerOpen, setPartnerOpen] = useState(false), [rangeOpen, setRangeOpen] = useState(false), [experienceOpen, setExperienceOpen] = useState(false), [experienceNote, setExperienceNote] = useState('');
  const [renameOpen, setRenameOpen] = useState(false), [conversationName, setConversationName] = useState('');
  const [message, setMessage] = useState(''), [chapterSearch, setChapterSearch] = useState(''), [fontSize, setFontSize] = useState(19);
  const [historyConversation, setHistoryConversation] = useState('');
  const [localNotice, setLocalNotice] = useState(''), [localError, setLocalError] = useState(''), [positionOpen, setPositionOpen] = useState(false), [positionDraft, setPositionDraft] = useState('');
  const [reviewChat, setReviewChat] = useState<string | undefined>(), [reviewNote, setReviewNote] = useState('');
  const [noteParagraph, setNoteParagraph] = useState<number>();
  const [paragraphDrafts, setParagraphDrafts] = useState<Record<string, ParagraphDraft>>({});
  const chatEnd = useRef<HTMLDivElement>(null), composer = useRef<HTMLTextAreaElement>(null), sourcePaper = useRef<HTMLDivElement>(null), sourceContent = useRef<HTMLDivElement>(null);
  const partner = app.state.partners.find(item => item.id === app.state.partnerId);
  const conversations = app.state.conversations.filter(item => item.bookId === book?.id).slice().sort((a, b) => b.createdAt - a.createdAt);
  const activeConversation = app.session?.bookId === book?.id ? app.session?.id ?? conversations[0]?.id : conversations[0]?.id;
  const displayedConversation = conversations.some(item => item.id === historyConversation) ? historyConversation : activeConversation;
  const chats = app.state.chats.filter(chat => chat.bookId === book?.id && chat.sessionId === displayedConversation && chat.presentation !== 'paragraph' && !chat.excluded && (!chat.readingReaction || chat.readingReaction.status === 'delivered')).slice(-80);
  const busy = app.busy || snapshot.busyAction;
  const paused = app.readingControl?.state === 'paused', stopping = app.readingControl?.state === 'stopping';
  const activeSession = app.session?.bookId === book?.id && app.session?.active ? app.session : undefined;
  const readingSession = app.session?.bookId === book?.id && app.session?.active && app.session.mode === 'reading' ? app.session : undefined;
  const quiet = app.session?.quiet ?? app.state.settings.defaultQuiet;
  const sceneFlow = app.session?.bookId === book?.id ? app.readingFlow : undefined;
  const sceneSavePending = !!book && !!app.readingFlow?.sceneSaveBookIds.includes(book.id);
  const sceneRestorePending = !!book && !!app.readingFlow?.sceneRestoreBookIds.includes(book.id);
  const sceneRecoveryPending = sceneSavePending || sceneRestorePending;
  const errorShownInActivity = !!(localError || snapshot.error) && app.activities.some(activity => activity.bookId === book?.id && ['failed', 'unknown', 'paused'].includes(activity.stage) && activity.reason === (localError || snapshot.error));
  const length = book?.textLength ?? 0;
  const knownChars = book?.known.reduce((total, range) => total + range.end - range.start, 0) ?? 0;
  const selectedChapter = page?.chapterIndex ?? 0;
  const positionChapter = book?.chapters.slice().reverse().find(chapter => chapter.start <= Number(positionDraft))?.index ?? selectedChapter;
  const chapterList = book?.chapters.filter(chapter => !chapterSearch.trim() || chapter.title.toLowerCase().includes(chapterSearch.trim().toLowerCase())) ?? [];
  const paragraphs = useMemo(() => page ? readingParagraphs(page.text, page.start, page.chapterTitle) : [], [page?.text, page?.start, page?.chapterTitle]);
  // Core revision also covers forgotten dependencies and excluded source chats.
  const notesRevision = String(app.revision);
  const paragraphNotes = useParagraphNotes(client, book?.id, page, notesRevision);
  const selectedParagraph = paragraphs.find(paragraph => paragraph.start === noteParagraph);
  const notesFor = (paragraph: { start: number; end: number }) => paragraphNotes.items.filter(comment => comment.anchor.start < paragraph.end && comment.anchor.end > paragraph.start);
  const selectedNoteKey = `${snapshot.sessionId}:${book?.id}:${page?.version}:${selectedParagraph?.start}`;
  const noteDraftProps = {
    draft: paragraphDrafts[selectedNoteKey] ?? { text: '' },
    onDraftChange: (draft: ParagraphDraft) => setParagraphDrafts(previous => ({ ...previous, [selectedNoteKey]: draft })),
    onPublished: (submitted: ParagraphDraft) => setParagraphDrafts(previous => {
      const current = previous[selectedNoteKey];
      if (!current || current.text !== submitted.text || current.parentId !== submitted.parentId) return previous;
      const next = { ...previous }; delete next[selectedNoteKey]; return next;
    }),
    onDetails: () => setDetail('process'),
  };
  const overlayOpen = importOpen || settingsOpen || !!detail || positionOpen || !!reviewChat || partnerOpen || rangeOpen || experienceOpen || renameOpen || noteParagraph !== undefined && matchMedia('(max-width:760px)').matches || navOpen && matchMedia('(max-width:1030px)').matches;

  async function run(action: () => Promise<unknown>, success?: string) {
    setLocalError('');
    try { await action(); if (success) setLocalNotice(success); }
    catch (error) { setLocalError(error instanceof Error ? error.message : '操作暂时未完成，请查看处理详情。'); }
  }
  function closeNavigation() {
    setNavOpen(false);
    if (matchMedia('(max-width:1030px)').matches) {
      const directoryButton = document.querySelector<HTMLButtonElement>('.nav-toggle');
      (directoryButton?.getClientRects().length ? directoryButton : document.querySelector<HTMLButtonElement>('.brand-mark'))?.focus({ preventScroll: true });
    }
  }
  useLayoutEffect(() => { if (page) restoreReadingPosition(sourcePaper.current, sourceContent.current, page.position); }, [page?.start, page?.navigationRevision, book?.id]);
  useEffect(() => { setHistoryConversation(''); }, [book?.id, activeConversation]);
  useEffect(() => { setNoteParagraph(undefined); }, [book?.id, page?.start]);
  useEffect(() => { const scroller = chatEnd.current?.parentElement; if (chats.length && scroller && !overlayOpen && noteParagraph === undefined && (!matchMedia('(max-width:760px)').matches || mobileTab === 'chat')) scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' }); }, [chats.length, chats.at(-1)?.text]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement;
      if (event.key === 'Escape' && navOpen && !document.querySelector('[role="dialog"]') && matchMedia('(max-width:1030px)').matches) { event.preventDefault(); closeNavigation(); return; }
      if (overlayOpen || element.closest('input,textarea,select,button,[contenteditable=true]')) return;
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); void run(() => client.turnPage(event.key === 'ArrowRight' ? 1 : -1)); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [client, overlayOpen, navOpen]);
  useEffect(() => {
    if ((!localNotice && !snapshot.notice) || localError || snapshot.error) return;
    const timer = setTimeout(() => { setLocalNotice(''); client.clearNotice(); }, 4500);
    return () => clearTimeout(timer);
  }, [client, localNotice, snapshot.notice, localError, snapshot.error]);
  useEffect(() => {
    let frame = 0;
    const capture = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => {
      const visible = !overlayOpen && !(navOpen && matchMedia('(max-width:1030px)').matches) && !(noteParagraph !== undefined && matchMedia('(max-width:760px)').matches) && document.visibilityState === 'visible' && (!matchMedia('(max-width:760px)').matches || mobileTab === 'reading');
      const range = visible ? visibleReadingRange(sourcePaper.current, sourceContent.current, client.getSnapshot().page) : undefined;
      client.setSourceVisible(visible && !!range,range);
      if (range) client.recordReadingPosition(range.start);
      if (range && client.getSnapshot().following) void client.followVisible(range).catch(error => setLocalError(error instanceof Error ? error.message : '跟随暂时未接上，请暂停后继续。'));
    }); };
    const paper = sourcePaper.current, resize = new ResizeObserver(capture);
    if (paper) resize.observe(paper);
    paper?.addEventListener('scroll', capture); window.addEventListener('resize', capture); window.addEventListener('scroll', capture); document.addEventListener('visibilitychange', capture); capture();
    return () => { cancelAnimationFrame(frame); resize.disconnect(); paper?.removeEventListener('scroll', capture); window.removeEventListener('resize', capture); window.removeEventListener('scroll', capture); document.removeEventListener('visibilitychange', capture); client.setSourceVisible(false); };
  }, [client, page?.start, page?.prepared, book?.id, snapshot.following, fontSize, overlayOpen, mobileTab, navOpen, noteParagraph]);
  function beginFollowing() {
    if(snapshot.sessionArchived){setLocalError('此存档已归档，请使用当前正常存档或新建阅读存档。');return;}
    const startFromVisible = () => {
      const current = client.getSnapshot();
      if (!current.modelReady) { setSettingsOpen(true); return; }
      if (current.app.readingControl?.state === 'stopping') return;
      const firstBody = current.book?.frontMatterIncluded ? 0 : current.book?.frontMatterEnd ?? 0;
      const range = visibleReadingRange(sourcePaper.current, sourceContent.current, current.page);
      if (!range) { setLocalError('请回到原文，确保正文出现在屏幕上，再开始伴读。'); return; }
      const firstLine = paragraphs.find(paragraph => !paragraph.heading);
      if (current.book && !current.book.known.length && (!current.page?.firstReadingSection || range.start > (firstLine?.start ?? firstBody))) { setRangeOpen(true); return; }
      void run(() => client.startFollowing(range));
    };
    // On narrow screens the reading pane is hidden while chatting. Restore it
    // before measuring the visible range, without offering hidden text.
    if (matchMedia('(max-width:760px)').matches && mobileTab !== 'reading') {
      setMobileTab('reading'); requestAnimationFrame(startFromVisible);
    } else startFromVisible();
  }
  async function importFile(file: File) {
    if (/\.json$/i.test(file.name)) await client.importBackup(await file.text());
    else await client.importTxt(file.name, decodeBook(await file.arrayBuffer()));
    setLocalNotice('资料已放入书架。选好实际读点与前文范围，再开始伴读。');
  }
  async function download(backup = false) {
    const result = await (backup ? client.exportBackup() : client.exportSession());
    downloadJSON(result);
    setLocalNotice(backup ? '完整共读备份已导出。' : '本次记录已导出，包含过程与人工评价。');
  }
  function send() {
    const text = message.trim();
    if (!text || !book || snapshot.busyAction || stopping) return;
    setMessage('');
    if (!snapshot.modelReady) { setMessage(text); setSettingsOpen(true); return; }
    void run(async () => { try { await client.sendMessage(text, false, displayedConversation); } catch (error) { setMessage(previous => previous || text); throw error; } });
  }
  async function saveSettings(draft: SettingsDraft) {
    if (snapshot.mode !== draft.mode) await client.switchMode(draft.mode);
    await client.updateSettings({ baseUrl: draft.endpoint.trim(), model: draft.model.trim(), apiKey: draft.apiKey || undefined, maxOutput: draft.maxOutput, tokenLimit: draft.tokenLimit, contextLimit: draft.contextLimit, effort: draft.effort, pageChars: draft.pageChars });
    setLocalNotice(draft.mode === 'live' ? 'AI共读已设置。开始共读或发问时会产生实际请求。' : '已保存界面演示设置。');
  }

  return <div className={`wb${sidebarCollapsed ? ' shelf-collapsed' : ''}${book ? ' has-book' : ' empty-book'}`}>
    <header className="wb-topbar"><div className="brand"><button className="brand-mark" onClick={() => { setMobileTab('reading'); setSidebarCollapsed(false); setNavOpen(!navOpen); }} aria-label="打开书架与目录"><Icon name="book" size={24} /></button><div><h1>宜序伴读</h1><small>Yixu Reading Companion</small></div></div><div className="topbar-context"><span>{book?.title ?? '选择书籍，开始共读'}</span><span className={`mode-pill${snapshot.mode === 'live' ? ' live' : ''}`}><i className="status-dot" />{snapshot.mode === 'live' ? 'AI共读' : '演示模式'}</span></div><div className="topbar-actions"><button className="btn btn-outline btn-small" aria-label="导出本次记录" onClick={() => void run(() => download())}><Icon name="export" size={16} /><span>导出阅读记录</span></button><button className="btn btn-small" aria-label="打开设置" onClick={() => setSettingsOpen(true)}><Icon name="settings" size={17} /><span>模型设置</span></button></div></header>
    <nav className="mobile-nav" aria-label="工作区"><button className={mobileTab === 'reading' ? 'selected' : ''} onClick={() => setMobileTab('reading')}><Icon name="book" size={15} />阅读原文</button><button className={mobileTab === 'chat' ? 'selected' : ''} onClick={() => setMobileTab('chat')}><Icon name="chat" size={15} />伙伴交流{chats.length ? ` · ${chats.length}` : ''}</button></nav>
    <ActivityPanel app={app} bookId={book?.id} following={snapshot.following} sceneRecoveryHandled={sceneRecoveryPending} onDetails={() => setDetail('process')} />
    {snapshot.sessionArchived&&<div className="callout amber" role="status">此存档已归档，停止新增处理。<button className="btn btn-small" onClick={()=>void run(()=>client.createSession(snapshot.mode))}>新建阅读存档</button></div>}
    <main className="wb-layout">
      {navOpen && <button type="button" className="nav-backdrop" tabIndex={-1} aria-label="关闭目录遮罩" onClick={closeNavigation} />}
      <aside className={`sidebar${navOpen ? ' nav-open' : ''}`} aria-label="书架与目录"><section className="shelf-section"><div className="side-heading"><h2>我的书架</h2><button className="icon-btn shelf-hide" aria-label={navOpen ? "关闭书架与目录" : "收起书架"} onClick={() => { closeNavigation(); setSidebarCollapsed(true); }}><Icon name="close" size={13} /></button><span className="section-eyebrow">{app.state.books.filter(item => !item.archived).length} 本</span></div><button className="btn import-btn" onClick={() => { setImportOpen(true); setNavOpen(false); }}><Icon name="plus" size={16} />添加书籍或备份</button><div className="book-list">{app.state.books.filter(item => !item.archived).map(item => <button className={`book-item${item.id === book?.id ? ' selected' : ''}`} key={item.id} onClick={() => void run(async () => { await client.selectBook(item.id); setChapterSearch(''); setNavOpen(false); })}><div className="book-cover"><span>{item.title}</span><Icon name="book" size={17} /></div><div><strong>{item.title}</strong><small>{item.chapters.length} 个目录项 · {number(item.textLength)} 字</small></div></button>)}</div>{!app.state.books.length && <p className="side-empty">添加正在阅读的书籍，<br />从当前进度开始共读。</p>}</section>
      {!!snapshot.sources.filter(source=>!source.historical).length && <section><div className="side-heading"><h2>示例阅读存档</h2></div>{snapshot.sources.filter(source=>!source.historical).map(source => <button key={source.id} className="book-item" disabled={source.available === false || snapshot.busyAction} onClick={() => void run(() => client.importSource(source.id), '已创建独立阅读存档，原存档保留。')}><Icon name="history" size={16} /><div><strong>{source.title}</strong><small>{'原文示例 · 从当前阅读形成理解'}</small></div></button>)}</section>}
      <div className="sidebar-divider" /><section className="directory-section"><div className="side-heading"><h2>章节目录</h2>{book && <button className="text-action" onClick={() => { setPositionDraft(String(client.getSnapshot().page?.position ?? 0)); setPositionOpen(true); }}>选择阅读位置<Icon name="chevron" size={11} /></button>}</div>{book && <div className="chapter-search"><Icon name="search" size={14} /><input aria-label="搜索章节" placeholder="查找章节" value={chapterSearch} onChange={event => setChapterSearch(event.target.value)} /></div>}<div className="chapter-list">{chapterList.map(chapter => isVolumeHeading(chapter.title) ? <h3 className="directory-volume" key={chapter.index}><button onClick={() => void run(async () => { await client.jumpTo(chapter.start); setNavOpen(false); })}>{chapter.title}</button></h3> : <button key={chapter.index} className={`chapter-item${chapter.index === selectedChapter ? ' selected' : ''}`} onClick={() => void run(async () => { await client.jumpTo(chapter.start); setNavOpen(false); })}><span>{chapter.title}</span>{chapter.index === selectedChapter && <Icon name="chevron" size={10} />}</button>)}</div>{!book && <p className="side-empty">导入后自动整理目录。</p>}{book && !chapterList.length && <p className="side-empty">试试其他章节名称。</p>}</section><div className="sidebar-bottom"><div className="local-badge"><Icon name="leaf" size={15} />保存在当前浏览器</div><p>读点与伙伴理解分别记录。<br />随时导出，接着上次共读。</p><button className="text-action" style={{ marginTop: 13 }} onClick={() => setDetail('sessions')}><Icon name="history" size={12} />查看阅读存档</button></div></aside>
      <section className={`reader-column${mobileTab !== 'reading' ? ' mobile-hidden' : ''}`} aria-label="原文阅读区"><div className="reader-heading"><div><h2>{book?.title ?? '阅读原文'}</h2><small>按章连续阅读</small></div><div className="reader-toolbar-actions"><div className="reading-options"><button className="icon-btn nav-toggle" aria-label="打开目录" onClick={() => { setSidebarCollapsed(false); setNavOpen(!navOpen); }}><Icon name="folder" size={16} /></button><button className="icon-btn shelf-show" aria-label="展开书架与目录" onClick={() => setSidebarCollapsed(false)}><Icon name="folder" size={16} /></button><button onClick={() => setFontSize(value => Math.max(15, value - 1))} aria-label="缩小原文字号" disabled={fontSize <= 15}>A−</button><button onClick={() => setFontSize(value => Math.min(28, value + 1))} aria-label="放大原文字号" disabled={fontSize >= 28}>A+</button></div><div className="reader-controls"><div className="material-actions">{stopping ? <button className="btn btn-subtle btn-small" disabled><span className="busy-dot" />正在收取回复并保存记录</button> : snapshot.following || busy && readingSession && !paused ? <button className="btn btn-primary btn-small" onClick={() => void run(() => client.pause())}><Icon name="pause" size={13} />暂停伴读</button> : <button className="btn btn-primary btn-small" disabled={!book || !page || snapshot.pageLoading || snapshot.busyAction || stopping} onClick={beginFollowing}><Icon name="play" size={13} />{readingSession ? '继续伴读' : '开始伴读'}</button>}{activeSession && <button className="btn btn-small" disabled={stopping} onClick={() => void run(() => client.stop())} title="结束本次共读并保存已有记录"><Icon name="stop" size={13} />结束本次共读</button>}</div></div></div></div>
      <details className="reading-status-panel"><summary>阅读状态 · {stopping ? '正在收取回复并保存记录' : paused ? '已暂停伴读' : snapshot.following ? '正在伴读' : '自行阅读'}{page?.coverage?.status === 'complete' && ' · 当前获准正文已理解'}<span>阅读进度与伙伴理解<Icon name="chevron" size={12} /></span></summary><div className="reading-status"><div><span>浏览位置</span><strong>{page?.chapterTitle ?? '先选择一本书'}</strong><button className="text-action" disabled={!book} onClick={() => { setPositionDraft(String(client.getSnapshot().page?.position ?? 0)); setPositionOpen(true); }}>调整阅读位置</button></div><div><span>允许伙伴阅读的内容</span><strong>{knownChars ? page?.authorized ? '当前章节已允许阅读' : '已确认部分已读范围' : '请先确认已读前文'}</strong><button className="text-action" disabled={!book} onClick={() => setRangeOpen(true)}>补读前文</button></div><div><span>{snapshot.mode === 'offline' ? '演示进度' : '伙伴理解进度'}</span><strong>{page?.coverage?.status === 'complete' ? snapshot.mode === 'offline' ? '当前获准正文演示已完成' : '当前获准正文已理解' : page?.coverage?.allowedChars ? '本章获准正文待理解 ' + number(page.coverage.missingChars) + ' 字' : '本章正文尚未获准阅读'}</strong><button className="text-action" onClick={() => setDetail('understanding')}>查看伙伴理解</button></div></div><p className="material-note">{sceneFlow?.deferredExpressions ? <><button className="text-action" onClick={() => setDetail('process')}>等待合适时机 · 查看处理详情</button></> : snapshot.mode === 'offline' ? '演示模式使用固定技术回应。切换真实模型后，才能体验实际伴读。' : snapshot.following ? '伴读已开启，伙伴按屏幕中的正文跟读。翻章或滚动会继续提供实际可见的文字。' : '开始伴读后，伙伴跟随屏幕中的正文。你可以随时提问或开启安静模式。'}</p></details>
      {snapshot.mode === 'live' && !snapshot.modelReady && <div className="readiness-banner"><span><strong>选择模型服务</strong><small>可先浏览书籍和历史记录。选择模型服务并保存后，即可开始AI共读。</small></span><button className="btn btn-small btn-primary" onClick={() => setSettingsOpen(true)}>选择模型服务</button></div>}
      {!!(sceneRecoveryPending || !errorShownInActivity && (localError || snapshot.error)) && <div className="readiness-banner"><span><strong>{sceneSavePending ? '原结果待保存' : sceneRestorePending ? '已收到结果待恢复' : '本次处理未完成'}</strong><small>{sceneSavePending ? '已有结果尚未完成保存。继续保存会复用原结果，不重新请求模型。' : sceneRestorePending ? '复用已收到的结果继续保存和核对发表条件，不重新请求模型或开启伴读。' : readableError(localError || snapshot.error)}</small></span><div className="recovery-actions">{sceneRecoveryPending && book && <button className="btn btn-small" disabled={snapshot.busyAction || stopping} onClick={() => void run(() => client.resumeSceneParticipation(book.id))}>{sceneSavePending ? '继续保存原结果' : '恢复已收到结果'}</button>}<button className="text-action" onClick={() => setDetail('process')}>处理详情</button>{!sceneRecoveryPending && <button className="text-action" onClick={() => setSettingsOpen(true)}>模型设置</button>}</div></div>}
      <article className="reader-paper" ref={sourcePaper}>{snapshot.pageLoading ? <div className="reader-empty">正在载入本章正文</div> : page ? <div className="paper-content" ref={sourceContent} style={{ fontSize }}>{!paragraphs.some(paragraph => paragraph.heading) && <h1 className="chapter-title">{page.chapterTitle}</h1>}{paragraphs.map(paragraph => paragraph.heading ? <h1 className="chapter-title" key={paragraph.start}>{paragraph.text}</h1> : <p className={`reading-paragraph${noteParagraph === paragraph.start ? ' selected-for-note' : ''}`} key={paragraph.start}><span className="paragraph-text-action" data-reading-start={paragraph.start} data-reading-end={paragraph.end} role="button" tabIndex={0} aria-label="查看本段段评" onClick={event => { if (event.detail > 1 || !window.getSelection()?.isCollapsed) return; setNoteParagraph(paragraph.start); }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setNoteParagraph(paragraph.start); } }}>{paragraph.text}</span>{!paragraphNotes.loading && !paragraphNotes.error && notesFor(paragraph).length > 0 && <button className="paragraph-note-count has-notes" aria-label={`查看本段段评，${notesFor(paragraph).length}条`} title="本机段评" onClick={() => setNoteParagraph(paragraph.start)}><Icon name="chat" size={12} /><span>{notesFor(paragraph).length}</span></button>}</p>)}<nav className="chapter-navigation" aria-label="章末导航"><button className="btn btn-outline" disabled={page.previousChapterStart === undefined} onClick={() => void run(() => client.turnPage(-1))}>上一章</button><button className="btn btn-outline" onClick={() => { setSidebarCollapsed(false); setNavOpen(true); }}>目录</button><button className="btn btn-outline" disabled={page.nextChapterStart === undefined} onClick={() => void run(() => client.turnPage(1))}>下一章</button></nav></div> : <EmptyReader onImport={() => setImportOpen(true)} onSettings={() => setSettingsOpen(true)} />}</article>
      </section>
      <aside className={`companion-column${mobileTab !== 'chat' ? ' mobile-hidden' : ''}`} aria-label="伙伴交流区"><div className="companion-chat-pane" aria-hidden={!!selectedParagraph && !matchMedia('(max-width:760px)').matches} inert={!!selectedParagraph && !matchMedia('(max-width:760px)').matches}><header className="companion-header"><div className="companion-title-row"><div className="companion-id"><div className="companion-avatar"><Icon name="leaf" size={21} /></div><div><h2>{partner?.name ?? '阅读伙伴'}</h2><p>{snapshot.mode === 'live' ? 'AI共读' : '演示模式'} · {stopping ? '正在收取回复并保存记录' : paused ? app.readingControl?.inFlight ? '已暂停伴读，正在收取已有回复' : '已暂停伴读' : snapshot.following ? '伴读已开启' : activeSession?.mode === 'discussion' ? '话题交流' : '伴读未开启'}</p></div></div><button className="icon-btn" onClick={() => setPartnerOpen(true)} title="伙伴设置" aria-label="伙伴设置"><Icon name="history" size={17} /></button></div><div className="quiet-control"><span><Icon name="quiet" size={14} />安静模式<small style={{ marginLeft: 5 }}>{quiet ? '不主动发言，可留段评' : '允许主动发言和段评'}</small></span><button className="switch" role="switch" aria-label="安静模式" title="关闭主动即时发言，仍可留下段评和回应明确提问" aria-checked={quiet} onClick={() => void run(() => client.setQuiet(!quiet))}><span /></button></div></header>
      <div className="chat-session-selector"><span>话题与交流</span><select aria-label="浏览话题与交流" value={displayedConversation ?? ""} onChange={event => setHistoryConversation(event.target.value)}>{!conversations.length && <option value="">尚无话题</option>}{conversations.map(conversation => <option key={conversation.id} value={conversation.id}>{conversation.id === activeConversation ? "当前 · " : "历史 · "}{conversation.title}</option>)}</select><button className="icon-btn" aria-label="重命名话题" disabled={!displayedConversation || busy} onClick={() => { setConversationName(conversations.find(item => item.id === displayedConversation)?.title ?? ''); setRenameOpen(true); }}><Icon name="settings" size={13} /></button><button className="icon-btn" aria-label="新建话题" disabled={!book || busy} onClick={() => void run(async () => setHistoryConversation(await client.newDiscussion()))}><Icon name="plus" size={13} /></button></div><div className="companion-conversation" aria-live="polite"><div className="conversation-intro">{snapshot.importedHistory ? snapshot.importedHistory.includes('功能检查') ? '独立准备的理解 · 功能检查问答另存' : '已载入历史材料 · 当前存档单独记录' : '当前话题'}</div>{!chats.length && <div className="chat-empty"><Icon name="book" size={54} /><h3>随时和伙伴聊聊</h3><p>{snapshot.mode === 'offline' ? '开启演示模式后可试用翻章、段评和交流操作。演示使用固定技术回复，实际伴读需选择模型服务。' : '确认阅读位置与已读范围后，可以开始伴读或直接提问。也可以在原文旁发表段评。'}</p></div>}{chats.map(chat => <ChatMessage key={chat.id} chat={chat as Chat} snapshot={snapshot} client={client} visible={!overlayOpen && noteParagraph === undefined && (!matchMedia('(max-width:760px)').matches || mobileTab === 'chat') && !!snapshot.timings[chat.id]} onRetry={() => void run(() => client.retryQuestion(chat.id))} onRecover={() => void run(() => client.recoverQuestionReceipt(chat.id))} onExpand={() => void run(() => client.expandReply(chat.id))} onReview={() => { setReviewChat(chat.id); setReviewNote(snapshot.ratings[chat.id]?.note ?? ''); }} />)}{busy && app.activities === undefined && <div className="busy-note"><span className="busy-dot" /><span>{stopping ? '正在收取回复并保存记录，完成后结束本次共读。' : paused ? '已暂停新增处理，已发出的请求会继续收取并保存。' : readingStatusLabel(app.status || '正在阅读当前内容…')}<br /><small>你可以继续阅读或结束本次共读。</small></span></div>}<div ref={chatEnd} /></div>
      <div className="composer-wrap">{displayedConversation && displayedConversation !== activeConversation && <p className="inline-note" style={{ marginBottom: 9 }}>正在查看历史交流。发送消息会继续这个话题。</p>}{busy && <div style={{ display: 'flex', gap: 7, marginBottom: 10 }}><button className="btn btn-outline btn-small" disabled={paused || stopping} onClick={() => void run(() => client.pause())}><Icon name="pause" size={12} />暂停伴读</button><button className="btn btn-small" disabled={stopping} onClick={() => void run(() => client.stop())}><Icon name="stop" size={12} />结束本次共读</button></div>}{!stopping && book && readingSession && (paused || !busy && !readingSession.observing) && <button className="btn btn-subtle btn-small" style={{ marginBottom: 10 }} onClick={beginFollowing}><Icon name="play" size={12} />继续伴读</button>}<div className="composer"><textarea ref={composer} aria-label="和伙伴聊聊" value={message} onChange={event => setMessage(event.target.value)} placeholder={book ? '想说点什么，就在这里插话…' : '先导入一本书，再开始交流…'} disabled={!book} rows={2} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} /><div className="composer-bottom"><small className="keyboard-hint">Enter 发送 · Shift + Enter 换行</small><button className="send-button" aria-label="发送消息" disabled={!book || !message.trim() || snapshot.busyAction || stopping} onClick={send}><Icon name="arrow" size={17} /></button></div></div><div className="companion-footnote"><button className="text-action" onClick={() => setExperienceOpen(true)}><Icon name="flag" size={12} />记录阅读感受</button><button className="text-action" onClick={() => setDetail('process')}>查看处理详情<Icon name="chevron" size={10} /></button></div></div></div>{selectedParagraph && !matchMedia('(max-width:760px)').matches && <ParagraphNotesPanel inline key={`${book?.id}:${selectedParagraph.start}`} client={client} snapshot={snapshot} paragraph={selectedParagraph} {...noteDraftProps} comments={notesFor(selectedParagraph)} error={paragraphNotes.error} loading={paragraphNotes.loading} onClose={() => setNoteParagraph(undefined)} onConversation={id => { if (id) setHistoryConversation(id); setMobileTab('chat'); }} />}</aside>
    </main><footer className="wb-footer"><span><i className="status-dot" />{snapshot.mode === 'live' ? `${snapshot.settings.model} / ${snapshot.settings.effort} · ${snapshot.modelReady ? '模型服务已启用' : '模型服务待启用'}` : '演示模式 · 固定技术回应'}</span><button className="text-action" onClick={() => setDetail('understanding')}>查看伙伴理解</button><button className="text-action" onClick={() => setDetail('sessions')}>阅读存档</button></footer>
    {(localError || snapshot.error || localNotice || snapshot.notice) && <Notice text={localError || snapshot.error ? readableError(localError || snapshot.error) : localNotice || snapshot.notice} error={!!(localError || snapshot.error)} onClose={() => { setLocalError(''); setLocalNotice(''); client.clearNotice(); }} />}
    {importOpen && <ImportDialog onClose={() => setImportOpen(false)} onFile={importFile} onText={(title, text) => client.importTxt(title, text)} />}
    {settingsOpen && <SettingsPanel initial={{ mode: snapshot.mode, endpoint: snapshot.settings.model === 'offline-ui-rehearsal' ? '' : snapshot.settings.baseUrl, model: snapshot.settings.model === 'offline-ui-rehearsal' ? 'gpt-6-luna' : snapshot.settings.model, effort: snapshot.settings.effort, apiKey: '', tokenLimit: snapshot.settings.tokenLimit, maxOutput: snapshot.settings.maxOutput, contextLimit: snapshot.settings.contextLimit, pageChars: snapshot.settings.pageChars }} secretPresent={snapshot.hasKey} services={snapshot.services} onRefreshServices={() => client.refreshServices()} onUseService={async id => { await client.useService(id); const next = client.getSnapshot(), selected = next.selectedService; return { mode: next.mode, endpoint: selected?.baseUrl ?? next.settings.baseUrl, model: selected?.model ?? next.settings.model, effort: selected?.effort ?? next.settings.effort, apiKey: '', tokenLimit: next.settings.tokenLimit, maxOutput: Math.min(selected?.maxOutput ?? next.settings.maxOutput, 16384), contextLimit: selected?.contextLimit ?? next.settings.contextLimit, pageChars: next.settings.pageChars }; }} onSave={saveSettings} onClose={() => { client.discardServiceSelection(); setSettingsOpen(false); }} />}
    {detail && <DetailPanel client={client} snapshot={snapshot} tab={detail} onTab={setDetail} onClose={() => setDetail(undefined)} onAction={action => void run(action)} onExport={backup => void run(() => download(backup))} onSettings={() => { setDetail(undefined); setSettingsOpen(true); }} />}
    {positionOpen && <Dialog title="选择阅读位置" onClose={() => setPositionOpen(false)}><p className="callout">选择章节定位，章内位置可在下方精确调整。定位只改变浏览位置。跟随阅读开启时接上实际可见正文，跳过的空白区间仍需你明确确认。</p><label className="form-field"><span>跳到章节</span><select value={positionChapter} onChange={event => setPositionDraft(String(book?.chapters.find(item => item.index === Number(event.target.value))?.start ?? 0))}>{book?.chapters.map(chapter => <option key={chapter.index} value={chapter.index}>{chapter.title}</option>)}</select></label><details className="exact-range"><summary>精确到章内文字位置</summary><label className="form-field"><span>原文字符位置 · 0—{number(Math.max(0, length - 1))}</span><input type="number" value={positionDraft} min={0} max={Math.max(0, length - 1)} onChange={event => setPositionDraft(event.target.value)} /></label></details><button className="btn btn-primary" onClick={() => { const target = Number(positionDraft); if (!Number.isSafeInteger(target) || target < 0 || target >= length) { setLocalError('请输入原文范围内的整数位置。'); return; } void run(async () => { await client.jumpTo(target); setPositionOpen(false); }); }}>前往这个位置<Icon name="arrow" size={15} /></button></Dialog>}
    {reviewChat && <Dialog title="回复评价" onClose={() => setReviewChat(undefined)}><div className="review-summary">{ratingOptions.map(option => <button key={option.value} className={`evaluation-btn${snapshot.ratings[reviewChat]?.values.includes(option.value) ? ' selected' : ''}`} aria-pressed={snapshot.ratings[reviewChat]?.values.includes(option.value) ?? false} onClick={() => client.markReply(reviewChat, option.value)}><Icon name={option.icon} size={13} />{option.label}</button>)}<button className={`evaluation-btn${snapshot.ratings[reviewChat]?.helpful ? ' selected' : ''}`} onClick={() => client.markHelpful(reviewChat)}>有帮助</button></div><label className="form-field"><span>补充说明（选填）</span><textarea rows={4} value={reviewNote} onChange={event => setReviewNote(event.target.value)} placeholder="记下实际感受或需要核对的地方" /></label><button className="btn btn-primary" onClick={() => { client.markNote(reviewNote, reviewChat); setReviewChat(undefined); setLocalNotice('感受与说明已记入阅读记录。'); }}>保存备注<Icon name="check" size={14} /></button></Dialog>}
    {partnerOpen && <PartnerPanel client={client} snapshot={snapshot} onClose={() => setPartnerOpen(false)} />}
    {selectedParagraph && matchMedia('(max-width:760px)').matches && <ParagraphNotesPanel key={`${book?.id}:${selectedParagraph.start}`} client={client} snapshot={snapshot} paragraph={selectedParagraph} {...noteDraftProps} comments={notesFor(selectedParagraph)} error={paragraphNotes.error} loading={paragraphNotes.loading} onClose={() => setNoteParagraph(undefined)} onConversation={id => { if (id) setHistoryConversation(id); setMobileTab('chat'); }} />}
    {rangeOpen && <ReadingRangePanel client={client} snapshot={snapshot} onClose={() => setRangeOpen(false)} />}
    {experienceOpen && <Dialog title="阅读反馈" onClose={() => setExperienceOpen(false)}><p className="callout">可以记录某个时刻、一次等待，或整体相处感受。备注保存在本机的阅读记录里。</p><label className="form-field"><span>补充说明</span><textarea rows={5} value={experienceNote} onChange={event => setExperienceNote(event.target.value)} placeholder="按自己的感受记录即可" /></label><button className="btn btn-primary" disabled={!experienceNote.trim()} onClick={() => { client.markNote(experienceNote.trim()); setExperienceNote(''); setExperienceOpen(false); setLocalNotice('补充说明已保存。'); }}>保存备注<Icon name="check" size={14} /></button></Dialog>}
    {renameOpen && <Dialog title="重命名话题" onClose={() => setRenameOpen(false)}><label className="form-field"><span>话题名称</span><input value={conversationName} maxLength={300} onChange={event => setConversationName(event.target.value)} /></label><p className="form-hint">自己起的名称会保留，原有阅读范围与交流内容分别保存。</p><button className="btn btn-primary" disabled={!conversationName.trim()} onClick={() => void run(async () => { if (displayedConversation) await client.renameConversation(displayedConversation, conversationName); setRenameOpen(false); })}>保存名称</button></Dialog>}
  </div>;
}

function ChatMessage({ chat, snapshot, client, visible, onReview, onRetry, onRecover, onExpand }: { chat: Chat; snapshot: WorkbenchSnapshot; client: WorkbenchClient; visible: boolean; onReview: () => void; onRetry: () => void; onRecover: () => void; onExpand: () => void }) {
  const rating = snapshot.ratings[chat.id], timing = snapshot.timings[chat.id];
  const recoverable = snapshot.app.state.usage.some(u => u.questionId === chat.id && u.dispatchState !== 'not-dispatched' && (u.status === 'unknown' || u.status === 'reserved' || !!u.hostQueryReceipt)) || snapshot.app.questionProgress?.some(q => q.questionId === chat.id && q.receiptPending);
  const historicalCheck = snapshot.importedHistory?.includes('功能检查') && chat.createdAt < (snapshot.sessions.find(item => item.id === snapshot.sessionId)?.createdAt ?? 0);
  return <article className={`chat-message ${chat.role}`}><div className="chat-meta"><span>{historicalCheck ? chat.role === 'assistant' ? '功能检查回复（历史）' : '功能检查输入（历史）' : chat.role === 'assistant' ? '伙伴' : '我'}</span><time dateTime={new Date(chat.createdAt).toISOString()}>{time(chat.createdAt)}</time></div><div className="chat-body">{chat.role === 'assistant' && chat.text.trim() ? <ReplyVisibility chatId={chat.id} client={client} text={chat.text} visible={visible} /> : chat.text}</div>{chat.role === 'user' && ['pending', 'failed', 'stopped'].includes(chat.delivery ?? '') && <div className="reply-delivery">{chat.delivery === 'pending' ? '等待伙伴回复，翻页不会取消问题' : chat.delivery === 'stopped' ? '本次回复已停止，原问题仍保留' : '回复未完成，可查看处理详情'}{chat.delivery !== 'pending' && <button className="text-action" onClick={recoverable ? onRecover : onRetry}>{recoverable ? '取回原回复' : '继续回答'}</button>}</div>}{chat.role === 'assistant' && <div className="chat-evaluations">{chat.expansionOffered && <button className="text-action" onClick={onExpand}>展开聊聊</button>}<button className={`text-action${rating ? ' noted' : ''}`} title={timing?.firstVisibleMs !== undefined ? `首个可见回应 ${duration(timing.firstVisibleMs)}，详细过程可在阅读记录查看` : undefined} onClick={onReview}><Icon name="flag" size={11} />{rating ? '查看感受备注' : '记下感受'}</button></div>}</article>;
}

function PublishedViewPanel({snapshot}:{snapshot:WorkbenchSnapshot}){
  const progress=snapshot.app.readingViews?.find(v=>v.bookId===snapshot.book?.id)?.progress;
  if(!progress)return null;
  const labels={overview:'已读故事概览',current:'当前状态',topic:'相关主题',arc:'故事线'};
  const gap=progress.uncheckedRanges.reduce((n,r)=>n+r.end-r.start,0);
  return <section className="memory-section"><h3>阅读概要</h3>{!progress.views.length&&<p>尚未形成概要。已有完整理解仍可展开查看；当前交流可以继续。</p>}{progress.views.map(v=><details key={v.id}><summary>{labels[v.kind]} · {v.key}</summary><p style={{whiteSpace:'pre-wrap'}}>{v.text}</p>{v.lagging&&<p>采用的认识已有后继版本，概要待更新；当前仍展示原发布版本。</p>}<small>已核对原文 {v.ranges.reduce((n,r)=>n+r.end-r.start,0).toLocaleString()} 字 · {v.chatIds.length} 条交流 · {v.adoptedMemories===undefined?'旧概要未记录采用版本':`采用 ${v.adoptedMemories.length} 份完整理解`}</small>{!!v.adoptedMemories?.length&&<details><summary>处理来源与阅读阶段</summary>{v.adoptedMemories.map(m=><p key={m.id}>{m.title??'完整理解'}<br/>形成范围：{m.formationRanges.length?m.formationRanges.map(r=>`${r.start}–${r.end}`).join('、'):'原记录未注明'}</p>)}</details>}</details>)}{gap>0&&<p>{gap.toLocaleString()} 字已读原文尚未记录概要的原文核对范围；已采用的完整理解与其形成阶段分别列出。</p>}{progress.unabsorbedChatIds.length>0&&<p>概要未直接选用的交流：{progress.unabsorbedChatIds.length} 条。</p>}{progress.maintenance.map(j=><p key={j.id}>{j.status==='blocked'?'后台整理未完成':j.status==='running'?'正在整理伙伴理解':'等待后台整理'}{j.viewTargets?.length?' · 待更新概要：'+j.targetLabels?.map(target=>labels[target.kind]+(target.key?' · '+target.key:'')).join('、'):''}{j.reason?'：'+readableError(j.reason):''}</p>)}</section>;
}

function SessionArchives({client,snapshot,onAction}:{client:WorkbenchClient;snapshot:WorkbenchSnapshot;onAction:(action:()=>Promise<unknown>)=>void}){
  const [exporting,setExporting]=useState(''),active=snapshot.sessions.filter(session=>!session.archivedAt),archived=snapshot.sessions.filter(session=>session.archivedAt),historical=snapshot.sources.filter(source=>source.historical);
  const exportFile=(id:string,load:()=>Promise<{name:string;text:string}>)=>onAction(async()=>{setExporting(id);try{downloadJSON(await load());}finally{setExporting('');}});
  return <><div className="callout">当前存档独立保存读点、理解和交流。归档旧存档后，仅在下方历史归档保留元信息与完整备份导出，不会自动打开或接续旧任务。</div><div className="archive-actions"><button className="btn btn-outline" onClick={()=>onAction(()=>client.createSession(snapshot.mode))}><Icon name="plus" size={15}/>新建{snapshot.mode==='live'?'AI共读':'演示模式'}存档</button><button className="btn btn-small" disabled={snapshot.busyAction||!active.some(session=>session.id!==snapshot.sessionId)} onClick={()=>onAction(()=>client.archiveOtherSessions())}>归档其它存档</button></div>
  {active.map(session=><div className="archive-session-row" key={session.id}><button className={`book-item${session.id===snapshot.sessionId?' selected':''}`} onClick={()=>onAction(()=>client.openSession(session.id))}><Icon name="history" size={17}/><div><strong>{session.title}</strong><small>{new Date(session.createdAt).toLocaleString('zh-CN')} · {session.mode==='live'?'真实模型':'演示模式'}{session.id===snapshot.sessionId?' · 当前':''}</small></div></button>{session.id!==snapshot.sessionId&&<button className="btn btn-small" disabled={snapshot.busyAction} onClick={()=>onAction(()=>client.archiveSession(session.id))}>归档</button>}</div>)}
  <details className="archive-history" onToggle={event=>{if(event.currentTarget.open&&!snapshot.historicalSourcesLoaded)onAction(()=>client.loadHistoricalSources());}}><summary>历史归档（{archived.length} 份存档）</summary><p className="form-hint">归档资料仅供查阅元信息与下载，不会进入当前理解、阅读队列或模型请求。</p>
  {archived.map(session=><article className="archive-record" key={session.id}><div><strong>{session.title}</strong><small>建立于 {new Date(session.createdAt).toLocaleString('zh-CN')} · {session.mode==='live'?'真实模型':'演示模式'}<br/>归档于 {new Date(session.archivedAt!).toLocaleString('zh-CN')}</small></div><button className="btn btn-small" disabled={!!exporting} onClick={()=>exportFile(session.id,()=>client.exportArchivedBackup(session.id))}>{exporting===session.id?'正在导出…':'导出归档备份'}</button></article>)}
  {!snapshot.historicalSourcesLoaded?<p>正在读取历史资料清单…</p>:historical.length>0&&<><h3>历史示例资料</h3>{historical.map(source=><article className="archive-record" key={source.id}><div><strong>{source.title}</strong><small>{source.description??(source.readThrough?`历史读点 ${source.readThrough} 章`:'历史共读资料')}</small></div><button className="btn btn-small" disabled={source.available===false||!!exporting} onClick={()=>exportFile(source.id,()=>client.exportHistoricalSource(source.id))}>{exporting===source.id?'正在导出…':'导出历史资料'}</button></article>)}</>}
  </details></>;
}

function DetailPanel({ client, snapshot, tab, onTab, onClose, onAction, onExport, onSettings }: { client: WorkbenchClient; snapshot: WorkbenchSnapshot; tab: DetailTab; onTab: (tab: DetailTab) => void; onClose: () => void; onAction: (action: () => Promise<unknown>) => void; onExport: (backup: boolean) => void; onSettings: () => void }) {
  const usage = snapshot.app.state.usage;
  const tokens = usage.reduce((total, item) => total + item.input + item.output, 0);
  const unknown = usage.filter(item => item.status === 'unknown').length;
  const tabs: { value: DetailTab; label: string }[] = [{ value: 'understanding', label: '伙伴理解' }, { value: 'process', label: '处理详情' }, { value: 'budget', label: '用量预算' }, { value: 'sessions', label: '阅读存档' }];
  return <Drawer title="阅读记录" subtitle="查看伙伴理解、运行状态、用量和阅读存档" onClose={onClose} tabs={<nav className="drawer-tabs" aria-label="记录内容">{tabs.map(item => <button key={item.value} className={tab === item.value ? 'selected' : ''} onClick={() => onTab(item.value)}>{item.label}</button>)}</nav>} footer={<><button className="btn btn-small" onClick={() => onExport(true)}><Icon name="export" size={14} />导出备份</button><button className="btn btn-primary btn-small" onClick={() => onExport(false)}><Icon name="export" size={14} />导出阅读记录</button></>}>
    {tab === 'understanding' && <><PublishedViewPanel snapshot={snapshot} /><UnderstandingPanel client={client} snapshot={snapshot} /></>}
    {tab === 'process' && <><ActivityPanel app={snapshot.app} bookId={snapshot.book?.id} following={snapshot.following} detail actionBusy={snapshot.busyAction || snapshot.app.readingControl?.state === 'stopping'} onResumeMaintenance={jobId => onAction(() => client.resumeMaintenance(jobId))} />{snapshot.app.readingFlow && (snapshot.app.readingFlow.sceneSavePending || !!snapshot.app.readingFlow.sceneRestoreBookIds.length) && <div className="callout amber"><strong>{snapshot.app.readingFlow.sceneSavePending ? '原结果待保存' : '已收到结果待恢复'}</strong><p>沿已收到的原结果接续保存和核对发表条件，不重新请求模型或开启伴读。深度理解进度分别保留。</p>{snapshot.book && [...snapshot.app.readingFlow.sceneSaveBookIds, ...snapshot.app.readingFlow.sceneRestoreBookIds].includes(snapshot.book.id) ? <button className="btn btn-outline btn-small" disabled={snapshot.busyAction || snapshot.app.readingControl?.state === 'stopping'} onClick={() => onAction(() => client.resumeSceneParticipation(snapshot.book!.id))}>{snapshot.app.readingFlow.sceneSaveBookIds.includes(snapshot.book.id) ? '继续保存原结果' : '恢复已收到结果'}</button> : <p>请先从书架打开对应书籍：{snapshot.app.state.books.filter(item => snapshot.app.readingFlow && [...snapshot.app.readingFlow.sceneSaveBookIds, ...snapshot.app.readingFlow.sceneRestoreBookIds].includes(item.id)).map(item => item.title).join('、')}。</p>}</div>}{!!snapshot.app.readingFlow?.deferredExpressions && <div className="callout"><strong>等待合适时机</strong><p>有 {snapshot.app.readingFlow.deferredExpressions} 条已准备的反应等待发表。相关条件改变后会重新判断，已过时或超出许可的内容会停止交付；这项判断复用原结果。</p></div>}<ProcessEvents snapshot={snapshot} /></>}
    {tab === 'budget' && <>{snapshot.mode === 'offline' && <div className="callout">本存档外部模型调用为零。下方包含导入的历史用量和当前固定回应的零用量记录。</div>}<div className="detail-stat-grid"><div className="detail-stat"><strong>{number(tokens)}</strong><span>累计 token（含预留）</span></div><div className="detail-stat"><strong>{usage.length}</strong><span>模型请求记录</span></div></div><h3 style={{ fontSize: 13 }}>累计上限 {number(snapshot.settings.tokenLimit)} token</h3><div className="budget-bar"><span style={{ width: `${snapshot.settings.tokenLimit ? tokens / snapshot.settings.tokenLimit * 100 : 0}%` }} /></div><p className="form-hint">历史请求与未确定结算持续保留。真实费用需渠道账单或可核查单价。</p>{unknown > 0 && <div className="callout amber" style={{ marginTop: 16 }}>{unknown} 笔请求的结果或结算尚未确定，原记录已保留。</div>}<div className="form-section" style={{ marginTop: 25 }}><h3>当前模型服务</h3><p>{snapshot.settings.model} / {snapshot.settings.effort}<br />{snapshot.settings.baseUrl || '请在模型设置中填写服务地址'}<br />单次输出上限 {number(snapshot.settings.maxOutput)} token</p></div><button className="btn btn-outline" onClick={onSettings}><Icon name="settings" size={15} />调整模型设置</button></>}
    {tab === 'sessions' && <SessionArchives client={client} snapshot={snapshot} onAction={onAction} /> }
  </Drawer>;
}
