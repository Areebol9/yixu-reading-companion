import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { application, startupRecovery } from './platform/app-runtime.ts';
import { exaFetchedPage, exaSearchPages } from './core/mcp-search.ts';
import { filterWebPages } from './core/web.ts';
import type { WebPage } from './core/web.ts';
import { pageText } from './platform/web-text.ts';
import { hostCall, isNative, nativeCall } from './platform/bridge.ts';
import { chapterAt, decodeBook } from './core/books.ts';
import { canFollowReading } from './core/reading-units.ts';
import { canRetryQuestion, readingProfile, profileMode, stageCoverage } from './core/reading-mode.ts';
import { subtractRanges } from './core/books.ts';
import { isCurrentUnderstanding, isEvidenceAllowed } from './core/context.ts';
import { accounting } from './core/accounting.ts';
import {currentHabits,habitOptions} from './core/habits.ts';
import {currentBookVoiceChoice} from './core/reading-policy.ts';
import type { HabitKey, Memory, Service, ReadingMode, State, Book, Chat } from './core/types.ts';
import { memoryTextLimit } from './core/types.ts';
import type { BookView, ReadonlyData } from './core/application-contract.ts';
import type { LimitsPatch, ServicePatch } from './core/application.ts';
import './style.css';
import { useAppDialog } from './AppDialog.tsx';
import type { ReadingSourceInfo } from './platform/contracts.ts';

const number = (n: number) => Intl.NumberFormat('zh-CN').format(n);
const kindNames = { story: '书中理解', opinion: '伙伴看法', question: '待解线索', shared: '共同经历', user: '用户偏好', context: '阅读简报',stage:'阶段叙事',state:'当前状态',arc:'故事弧线' };
const tabs = [{ id: 'books', label: '书架', icon: '▤' }, { id: 'reading', label: '共读', icon: '◌' }, { id: 'memory', label: '记忆', icon: '◇' }, { id: 'partner', label: '伙伴', icon: '◎' }, { id: 'settings', label: '设置', icon: '⚙' }];

function App() {
  const view = application.snapshot;
  const {confirm: confirmAction, prompt: promptText, dialog} = useAppDialog();
  const [, update] = useState(0), [tab, setTab] = useState('books');
  const [bookId, setBookId] = useState(view.state.resume?.bookId ?? view.state.books.find(b => !b.archived)?.id ?? '');
  const [error, setError] = useState(''), [notice, setNotice] = useState(startupRecovery.questions || startupRecovery.unknownCalls || startupRecovery.temporaryQuestions || startupRecovery.interruptedTasks
    ? '上次未完成的处理已停止，记录和用量已保留。可在原对话接着回应，或开启共读补齐前文。' + (startupRecovery.interruptedTasks ? '事实核对可在记忆页继续。' : '') + (startupRecovery.temporaryQuestions ? '涉及后文的问题需要重新授权。' : '') : '');
  const [drafts, setDrafts] = useState<Record<string,string>>({}), [positionText, setPositionText] = useState(''), [chapter, setChapter] = useState(0);
  const [discussionRequest, setDiscussionRequest] = useState(0);
  const [showArchived, setShowArchived] = useState(false), [includeKeys, setIncludeKeys] = useState(false);
  const [key, setKey] = useState('');
  const { recording, voiceDraft, captureStarting } = view;
  const [partnerDraft, setPartnerDraft] = useState<{ id: string; name: string; traits: string }>();
  const [limitsDraft, setLimitsDraft] = useState<LimitsPatch>({});
  const [selectedConversation, setSelectedConversation] = useState('');
  const [editingMemory, setEditingMemory] = useState(''), [memoryDraft, setMemoryDraft] = useState('');
  const [openedMemory, setOpenedMemory] = useState<{id:string;key?:string;text:string}>();
  const memoryRequest = useRef(0);
  const [editingTranscript, setEditingTranscript] = useState(''), [transcriptDraft, setTranscriptDraft] = useState('');
  const [futureQuestion, setFutureQuestion] = useState(''), [futureFrom, setFutureFrom] = useState(0), [futureTo, setFutureTo] = useState(0), [evaluationOnly, setEvaluationOnly] = useState(true);
  const [searchKey, setSearchKey] = useState('');
  const [checkingSearch, setCheckingSearch] = useState(false);
  const [readingSources, setReadingSources] = useState<ReadingSourceInfo[]>([]), [sourcesLoading, setSourcesLoading] = useState(false);
  const searchCheckController = useRef<AbortController | undefined>(undefined);
  const recoveryRevision = useRef(view.recoveryRevision);
  const input = useRef<HTMLInputElement>(null), backupInput = useRef<HTMLInputElement>(null), chatEnd = useRef<HTMLDivElement>(null);
  const book = view.state.books.find(b => b.id === bookId);
  const readingSourceId = book?.readingSourceId ?? 'qidian';
  const selectedMode=profileMode(readingProfile(book??{}));
  const derivedCoverage=book?stageCoverage(view.state as unknown as State,book as unknown as Book):[];
  const derivedGaps=book?subtractRanges([...book.known],derivedCoverage):[];
  const readingSource = readingSources.find(s => s.id === readingSourceId);
  const readingPrepared = !!book && canFollowReading(book,view.session?.active&&view.session.bookId===book.id?view.session.readingStrategy??'structured':book.readingStrategy??'structured');
  const session = view.session?.active && view.session.bookId === bookId ? view.session : undefined;
  const locatedPosition = view.locatedPosition?.bookId === bookId && !session?.prepared ? view.locatedPosition : undefined;
  const conversations = view.state.conversations.filter(c => c.bookId === bookId).sort((a, b) => b.createdAt - a.createdAt);
  const conversationId = selectedConversation || session?.id || conversations[0]?.id;
  const draftKey = (bookId: string, conversationId?: string) => JSON.stringify([bookId, conversationId ?? '']);
  const setDraft = (bookId: string, conversationId: string | undefined, value: string) => setDrafts(previous => ({ ...previous, [draftKey(bookId, conversationId)]: value }));
  const message = drafts[draftKey(bookId, conversationId)] ?? '';
  const setMessage = (value: string) => setDraft(bookId, conversationId, value);
  const chats = view.state.chats.filter(c => c.bookId === bookId && c.sessionId === conversationId);
  const bookMemories = view.state.memories.filter(m => book && m.bookId === bookId && m.partnerId === view.state.partnerId && !m.forgotten && isEvidenceAllowed(book, m.evidence)).slice().reverse();
  const memoryVersions = new Map(view.state.memories.map(m => [m.id, m]));
  const currentMemoryIds = new Set(bookMemories.filter(m => book && isCurrentUnderstanding(m, memoryVersions.get(m.replacedBy ?? ''), book)).map(m => m.id));
  const reviewTasks = (view.state.tasks ?? []).filter(t => t.bookId === bookId && t.partnerId === view.state.partnerId).slice().reverse();
  const pendingReview = reviewTasks.find(t => t.status === 'running' || t.status === 'interrupted');
  const service = view.state.settings.services.find(s => s.id === view.state.settings.serviceId)!;
  const partner = view.state.partners.find(p => p.id === view.state.partnerId)!;
  const budget = accounting(view.state), usage = budget.tokens;
  const money = (value: number) => value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  const run = async (action: () => Promise<unknown>) => { setError(''); try { await action(); } catch (e) { if ((e as Error).name !== 'AbortError') setError((e as Error).message); } };
  useEffect(() => { memoryRequest.current++; setOpenedMemory(undefined); setEditingMemory(''); setMemoryDraft(''); }, [bookId,view.state.partnerId]);
  const openMemory = async (m: ReadonlyData<Memory>, editing = false) => {
    const request = ++memoryRequest.current, text = await application.command('readMemoryBody', m.bookId, m.id);
    if (request !== memoryRequest.current) return;
    setOpenedMemory({id:m.id,key:m.bodyRef?.key,text});
    if (editing) { setEditingMemory(m.id); setMemoryDraft(text); }
  };
  const memoryCard = (m: ReadonlyData<Memory>) => <article className="panel memory-card" key={m.id}>
    <div className="panel-heading"><span className={'memory-kind kind-' + m.kind}>{kindNames[m.kind]}</span><small>{new Date(m.createdAt).toLocaleDateString('zh-CN')}</small></div>
    {editingMemory === m.id && !m.replacedBy && !m.invalidatedBy ? <label>更正内容<textarea rows={4} maxLength={memoryTextLimit(m.kind)} value={memoryDraft} onChange={e => setMemoryDraft(e.target.value)}/></label> : <><p>{m.documentTitle ?? kindNames[m.kind]}</p>{m.navigationCues?.length ? <p className="hint">{m.navigationCues.join(' · ')}</p> : null}{openedMemory?.id === m.id && openedMemory.key === m.bodyRef?.key ? <><p>{openedMemory.text}</p><button className="textbutton" onClick={()=>setOpenedMemory(undefined)}>收起档案</button></> : <button className="textbutton" onClick={()=>void run(()=>openMemory(m))}>查看完整档案</button>}</>}<small className="muted">{m.replacedBy && !currentMemoryIds.has(m.id) ? '已有更新版本 · 历史记录' : m.invalidatedBy ? '依据已更正 · 旧判断已停用' : m.revisionKind === 'development' ? '随阅读更新的理解' : m.source === 'review' ? m.reviewDisposition === 'unsupported' ? '本次原文依据不足 · 暂停使用' : m.backgroundOrigin ? '独立阅读背景 · 依据已核对' : m.kind==='opinion' ? '事实依据已核对 · 当时看法保留' : m.kind==='question' ? '事实依据已核对 · 原问条件保留' : '已回查原文 · 仍可更正' : m.source === 'correction' ? '用户更正' : m.source === 'preparation' ? '前文准备' : m.source === 'reading' ? '阅读中形成' : m.source === 'background' ? '独立阅读背景' : '来自实际交流'}</small>
    {m.revisionKind === 'development' && <p className="hint">更新原因：{m.revisionReason}</p>}
    {m.source==='review'&&m.reviewReason&&<p className="hint">依据核对：{m.reviewReason}</p>}
    {m.sourceQuote && <details className="memory-quote"><summary>查看原文短引</summary><p>{m.sourceQuote.text}</p><small className="muted">短引用于回查，记下的理解仍可更正。</small></details>}
    <div className="button-row">{!m.replacedBy && !m.invalidatedBy && (editingMemory === m.id ? <><button className="primary" disabled={!memoryDraft.trim()} onClick={() => void run(async () => { await application.command('correctMemory', m.id, memoryDraft); setEditingMemory(''); setMemoryDraft(''); setOpenedMemory(undefined); setNotice('更正已保存，相关旧判断已停用，历史聊天保留'); })}>保存更正</button><button className="textbutton" onClick={() => { setEditingMemory(''); setMemoryDraft(''); }}>取消更正</button></> : <button className="textbutton" onClick={() => void run(()=>openMemory(m,true))}>更正</button>)}
    {['story','context','question','opinion','stage','state'].includes(m.kind) && !m.replacedBy && !m.forgotten && m.source !== 'correction' && <button className="textbutton" disabled={view.busy} onClick={() => void run(() => application.command('reviewFact', m.id))}>{m.kind==='state'?m.stateProjection?.writeVersion===2?'核对状态条目':'核对并建立状态条目':m.kind==='opinion'?'核对看法的事实依据':m.kind==='question'?'核对当时疑问':m.invalidatedBy?'按原文重新核对':'回查原文'}</button>}
    <button className="textbutton danger" onClick={() => void run(async () => { if (await confirmAction('忘记这件事、相关更正版本及依赖它的理解。原聊天保留供回看，但不再用于伙伴记忆。')) { await application.command('forgetMemory', m.id); } })}>忘记此事</button></div>
  </article>;
  useEffect(() => {
    const sync = () => {
      update(n => n + 1);
      if (recoveryRevision.current !== application.snapshot.recoveryRevision) { recoveryRevision.current = application.snapshot.recoveryRevision; setError(''); setNotice('已接续未完成的任务'); }
      for (const event of application.takeUIEvents()) {
        if (event.kind === 'error') setError(event.text);
        if (event.kind === 'notice') setNotice(event.text);
        if (event.kind === 'keyboard') document.documentElement.classList.toggle('keyboard-open', event.visible);
        if (event.kind === 'openConversation') { setBookId(event.bookId); setSelectedConversation(''); setTab('reading'); setDiscussionRequest(application.snapshot.session?.prepared ? 1 : 0); window.scrollTo(0, 0); }
        if (event.kind === 'draft') setDraft(event.bookId, event.conversationId, event.text);
      }
    };
    const unsubscribe = application.subscribe(sync); sync();
    return unsubscribe;
  }, []);
  useEffect(() => { const area = chatEnd.current?.parentElement; if (tab === 'reading' && area) area.scrollTo({ top: area.scrollHeight, behavior: 'smooth' }); }, [chats.length, tab]);
  useEffect(() => { window.scrollTo(0, 0); }, [tab, bookId]);
  useEffect(() => {
    if (tab !== 'reading' || !discussionRequest) return;
    const frame = requestAnimationFrame(() => { window.scrollTo(0, 0); const area = chatEnd.current?.parentElement; if (area) area.scrollTo({ top: area.scrollHeight }); });
    return () => cancelAnimationFrame(frame);
  }, [discussionRequest, tab, bookId]);
  useEffect(() => { setFutureFrom(0); setFutureTo(0); setFutureQuestion(''); setPositionText(''); const current = application.snapshot.state.books.find(b => b.id === bookId); setChapter(current ? chapterAt(current, Math.max(0, current.position - 1)).index : 0); }, [bookId]);
  async function refreshReadingSources() {
    if (!isNative()) return;
    setSourcesLoading(true);
    try { setReadingSources(await nativeCall<ReadingSourceInfo[]>('readingSources')); }
    finally { setSourcesLoading(false); }
  }
  useEffect(() => { if (isNative()) void run(refreshReadingSources); }, []);
  async function selectReadingSource(sourceId: string) {
    if (!book) return;
    await application.command('selectReadingSource', book.id, sourceId);
  }
  async function importFile(file?: File) {
    if (!file) return;
    const result = await application.command('importText', file.name, decodeBook(await file.arrayBuffer()));
    const book = application.snapshot.state.books.find(b => b.id === result.bookId)!;
    await chooseBook(book);
    if (result.existing) setNotice('这份原文已经导入，已打开原来的共读');
  }
  async function chooseBook(b: BookView) { await application.command('selectBook', b.id); setBookId(b.id); setChapter(chapterAt(b, Math.max(0, b.position - 1)).index); setSelectedConversation(''); setDiscussionRequest(0); setTab('reading'); }
  async function begin() { if (!book) return; const id = await application.command('startReading', book.id); setSelectedConversation(''); if (!conversationId && message && id) { setDraft(book.id, id, message); setDraft(book.id, undefined, ''); } }
  async function voice() { if (book) await application.command('startOrSendVoice', book.id, conversationId); }
  async function cancelVoice() { await application.command('cancelVoice'); }
  async function capture() {
    if (!book || captureStarting) return;
    if (!readingSource?.installed) throw new Error('请先选择已安装的阅读应用');
    await application.command('startCapture', book.id, readingSource.id); setSelectedConversation('');
    if (!conversationId && message && application.snapshot.session) { setDraft(book.id, application.snapshot.session.id, message); setDraft(book.id, undefined, ''); }
  }
  async function exportData() {
    const text = await application.command('exportBackup', includeKeys);
    const today = new Date(), date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    if (isNative()) await nativeCall('exportFile', { name: `宜序伴读备份-${date}.json`, text });
    else { const url = URL.createObjectURL(new Blob([text], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = `宜序伴读备份-${date}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    setNotice('备份已导出' + (includeKeys ? '，包含服务密钥，请妥善保管' : ''));
  }
  async function restore(file?: File) {
    if (!file) return;
    const raw = await file.text(), preview = await application.command('previewBackup', raw);
    if (!await confirmAction(`备份文件：${file.name}\n恢复后预计有 ${preview.books} 本书、${preview.chats} 条聊天。将替换当前书籍与记录，本机已知的忘记、更正和用量会保留。建议先导出当前记录。`, '恢复这份备份？')) return;
    const withKeys = preview.hasSecrets && await confirmAction('此备份带有服务密钥，是否一并恢复？取消后仍会恢复书籍与记录。', '恢复服务密钥？');
    const restored = await application.command('restoreBackup', raw, withKeys);
    setBookId(restored.bookId); setPartnerDraft(undefined); setLimitsDraft({});
    setNotice(restored.secretError ?? '已恢复备份。模型服务保持关闭，可在设置中开启。');
  }
  const saveService = (patch: ServicePatch) => void run(() => application.command('updateService', service.id, patch));
  async function enableService() {
    await application.command('enableService', service.id, key); setKey('');
    setNotice('服务已启用。开始共读时会向所选服务发送获准资料。');
  }
  async function checkSearch() {
    if (checkingSearch || !view.state.settings.searchEnabled) return;
    setCheckingSearch(true);
    const controller = new AbortController(); searchCheckController.current = controller;
    try {
      const settings = view.state.settings;
      const result = await hostCall<WebPage[] | { format: 'exa'; content: string }>('search', { query: '植物叶片为什么呈绿色 光谱吸收', provider: settings.searchProvider, endpoint: settings.searchEndpoint }, controller.signal);
      const pages = filterWebPages(Array.isArray(result) ? result : exaSearchPages(result.content), '');
      if (!pages.length) throw new Error('搜索未返回可用来源');
      const raw = await hostCall<{ url: string; html?: string; format?: 'exa'; content?: string }>('readPage', { url: pages[0].url }, controller.signal);
      const page = raw.format === 'exa' ? exaFetchedPage(raw.content!, raw.url) : pageText(raw.url, raw.html!);
      await application.command('setWebResult');
      setNotice(`搜索已取得 ${pages.length} 个可用来源，网页读取成功：${page.title}（${page.extract.length} 字符）。`);
    } catch (error) { if ((error as Error).name !== 'AbortError') await application.command('setWebResult', (error as Error).message); throw error; }
    finally { if (searchCheckController.current === controller) searchCheckController.current = undefined; setCheckingSearch(false); }
  }
  return <div className={'app' + (tab === 'reading' && discussionRequest ? ' discussion-active' : '')}>
    {dialog}
    <aside className="sidebar"><div className="brand"><span className="brandmark">序</span><div><strong>宜序伴读</strong><small>共读 · 本地保存</small></div></div><nav>{tabs.map(t => <button key={t.id} className={tab === t.id ? 'nav active' : 'nav'} onClick={() => setTab(t.id)}><span>{t.icon}</span>{t.label}</button>)}{!isNative()&&<a className="nav" href="./workbench.html"><span>▧</span>人工测试台</a>}</nav><div className="sidebar-foot"><span className="dot"/>原型 0.1<span>{isNative() ? 'Android 客户端' : '本地调试入口'}</span></div></aside>
    <main><header className="topbar"><span className="eyebrow">{tabs.find(t => t.id === tab)?.label}</span><div className="top-actions"><span className="local-badge">本地资料</span><button className="iconbutton" onClick={() => setTab('settings')}>设置</button></div></header>
      {error && <div role="alert" className="banner error">{error}<button onClick={() => setError('')}>关闭</button></div>}
      {notice && <div role="status" className="banner">{notice}<button onClick={() => setNotice('')}>关闭</button></div>}
      {(budget.tokenLevel > 0 || budget.costLevel > 0) && <div role="status" className="banner"><span>{budget.tokenLevel === 2 || budget.costLevel === 2 ? '已达到所设用量或费用上限，超出余额的新请求会暂停。' : '已接近所设用量或费用上限，可查看剩余额度。'}</span><button onClick={() => setTab('settings')}>查看用量</button></div>}
      <input ref={input} type="file" accept=".txt,text/plain" hidden onChange={e => { void run(() => importFile(e.target.files?.[0])); e.target.value = ''; }}/>
      <input ref={backupInput} type="file" accept=".json" hidden onChange={e => { void run(() => restore(e.target.files?.[0])); e.target.value = ''; }}/>
      {tab === 'books' && <section className="page"><div className="page-heading"><div><p className="eyebrow">我的书架</p><h1>继续阅读</h1><p className="muted">从正在读的位置接上，保留每本书的理解与交流。</p></div><button className="primary" onClick={() => input.current?.click()}>＋ 导入 TXT</button></div><div className="section-title"><h2>{showArchived ? '已归档' : '最近共读'}</h2><button className="textbutton" onClick={() => setShowArchived(!showArchived)}>{showArchived ? '返回书架' : '查看归档'}</button></div>
        <div className="books-grid">{view.state.books.filter(b => b.archived === showArchived).map((b, i) => <button className="book-card" key={b.id} onClick={() => void run(() => chooseBook(b))}><div className={'book-cover cover-' + i % 4}><span>共读记录</span><strong>{b.title}</strong><small>{b.chapters.length} 项目录</small></div><div className="book-meta"><h3>{b.title}</h3><p>{b.position ? chapterAt(b, b.position - 1).title : '等待确认阅读位置'}</p><div className="progress-track"><i style={{ width: (100 * b.position / b.textLength) + '%' }}/></div><small>{Math.round(100 * b.position / b.textLength)}% · {view.state.chats.filter(c => c.bookId === b.id).length} 条交流</small></div></button>)}</div>
        {!view.state.books.filter(b => b.archived === showArchived).length && <div className="empty"><div className="empty-icon">▤</div><h2>{showArchived ? '归档中还没有书' : '添加正在读的那本书'}</h2><p>导入用户自行提供的 TXT，确认已经读过的范围。<br/>完整文件保存在本机，模型按阅读权限使用其中的内容。</p>{!showArchived && <button className="primary" onClick={() => input.current?.click()}>选择 TXT 文件</button>}</div>}
        <div className="info-row"><span>无需宜序账号</span><span>记录保存在设备中</span><button className="textbutton" onClick={() => setTab('settings')}>备份与迁移 →</button></div></section>}
      {tab === 'reading' && <section className="page reading-page">{!book ? <div className="empty"><h1>先选择一本书</h1><button className="primary" onClick={() => setTab('books')}>前往书架</button></div> : <><div className="page-heading compact"><div><p className="eyebrow">当前作品</p><h1>{book.title}</h1><p className="muted">{chapterAt(book, Math.max(0, book.position - 1)).title} · 已确认 {number(book.known.reduce((n, r) => n + r.end - r.start, 0))} 字符</p></div><button className="textbutton" onClick={() => void run(async () => { await application.command('setArchived', book.id, !book.archived); setNotice(!book.archived ? '已归档，资料和记忆保留' : '已移回书架'); })}>{book.archived ? '移回书架' : '归档'}</button></div>
        <div className="reading-layout"><div className="reading-controls"><div className="panel"><div className="panel-heading"><h2>阅读位置</h2><span className="pill">用户确认</span></div>{locatedPosition && <div className="located-position"><h3>已定位到：{locatedPosition.chapter}</h3><p className="observation-text">{locatedPosition.excerpt}</p><p className="hint">从正文开始到此处将作为已读许可。定位在本地完成；完整原文方式可直接共读，其他方式明确准备后接续已处理资料。</p><button className="primary full" disabled={view.busy} onClick={() => void run(async () => { await application.command('confirmLocatedPosition', book.id, locatedPosition.id); if(selectedMode!=='full-original')await application.command('prepare', book.id); })}>{selectedMode==='full-original'?'确认已读至此，直接共读':'确认已读至此，准备前文'}</button></div>}{!!book.frontMatterEnd && <label className="toggle"><input type="checkbox" checked={!!book.frontMatterIncluded} onChange={e => void run(() => application.command('setFrontMatterIncluded', book.id, e.target.checked))}/>允许伙伴读取书前简介<span>简介可能涉及后续情节，默认单独保留。</span></label>}<label>已经读到的章节<select value={chapter} onChange={e => setChapter(Number(e.target.value))}>{book.chapters.map(c => <option key={c.index} value={c.index}>{c.title}</option>)}</select></label><button className="secondary full" onClick={() => void run(() => application.command('setKnown', book.id, book.chapters[chapter].end))}>确认已读至本章末尾</button><details><summary>在章内定位</summary><label>粘贴当前已读片段<textarea value={positionText} onChange={e => setPositionText(e.target.value)} placeholder="至少十个连续字符"/></label><button className="secondary" onClick={() => void run(async () => { await application.command('locatePosition', book.id, positionText); setNotice('已读范围已更新到片段末尾'); })}>确认已读至片段末尾</button></details>{view.lastObservation && <details><summary>最近识别的片段</summary><p className="observation-text">{view.lastObservation}</p><p className="hint">仅供核对位置，未对应的片段不会作为正文交给模型。</p></details>}</div>
        <div className="panel session-panel"><div className="panel-heading"><h2>本次共读</h2><span className={'status-dot ' + (session ? 'on' : '')}/></div><p className="session-status">{session ? view.status : '尚未开启'}</p><label>本书共读资料<select value={selectedMode} disabled={view.busy||captureStarting||view.voiceActive||!!view.progress} onChange={e=>void run(()=>application.command('setReadingMode',book.id,e.target.value as ReadingMode))}><option value="companion">持续伴读</option><option value="legacy">现有阅读资料</option><option value="stages">阶段与持续条件（候选）</option><option value="full-original">完整获准原文（候选）</option></select></label><p className="hint">选择仅作用后续任务，不自动请求模型；已有草稿和待办保持形成时的方式。</p><p className="hint">已实际处理 {number(book.prepared.reduce((n,r)=>n+r.end-r.start,0))} 字符。{selectedMode==='stages'&&<>有效阶段资料覆盖 {number(derivedCoverage.reduce((n,r)=>n+r.end-r.start,0))} 字符，获准范围尚缺 {number(derivedGaps.reduce((n,r)=>n+r.end-r.start,0))} 字符；跟读资格与派生覆盖分开，需补充时明确准备。</>}</p>{isNative() && <div className="reading-source"><label>阅读应用<select value={readingSourceId} disabled={sourcesLoading || captureStarting} onChange={e => void run(() => selectReadingSource(e.target.value))}>{!readingSources.some(s => s.id === readingSourceId) && <option value={readingSourceId}>{sourcesLoading ? '正在检查阅读应用' : '请重新选择阅读应用'}</option>}{readingSources.map(s => <option key={s.id} value={s.id} disabled={!s.installed}>{s.name}{!s.installed ? ' · 未安装' : !s.tested ? ' · 实验适配' : ''}</option>)}</select></label>{readingSource && <p className="hint">{readingSource.tested ? `已在 ${readingSource.name} ${readingSource.testedVersion} 样机验证。` : '实验适配，尚未实机验证。仅识别已适配的正文页，段评暂不接入。'}{readingSource.installed && readingSource.version ? ` 本机版本：${readingSource.version}。` : ''}</p>}<button className="textbutton" disabled={sourcesLoading || captureStarting} onClick={() => void run(refreshReadingSources)}>刷新应用</button></div>}{view.progress && <><progress max={view.progress.total} value={view.progress.done}/><small>{view.progress.done} / {view.progress.total} 段</small></>}
          {!session ? <><button className="primary full" onClick={() => void run(begin)}>{view.state.resume?.bookId === book.id ? '接续上次共读' : '开启共读'}</button>{isNative() && <button className="secondary full" disabled={!readingSource?.installed || captureStarting || view.voiceActive} onClick={() => void run(capture)}>{captureStarting ? '等待系统确认' : readingPrepared ? '在外部阅读 App 中跟随' : '定位当前阅读页'}</button>}</> : <><button className="primary full" disabled={view.busy || !book.known.length} onClick={() => void run(() => application.command('prepare', book.id))}>{selectedMode==='stages'?'明确准备并补齐阶段资料':selectedMode==='full-original'?'明确处理获准前文':session.prepared ? '检查并补齐前文' : '准备已确认前文'}</button><button className="secondary full" disabled={!isNative() || !readingSource?.installed || captureStarting || view.voiceActive} onClick={() => void run(capture)}>{captureStarting ? '等待系统确认' : session.prepared ? '在外部阅读 App 中跟随' : '定位当前阅读页'}</button>{!session.prepared && <p className="hint">可先定位外部阅读页，或手动确认章节和片段。前文准备完成后开始自动理解。</p>}{!!book.buffered?.length && <p className="hint">未读完的句段已保留，等待后续页面补齐；尚未计入已理解内容。</p>}<label className="toggle"><input type="checkbox" checked={session.quiet} onChange={e => void run(() => application.command('quiet', e.target.checked))}/>安静共读<span>仍会理解，可随时提问</span></label><button className="textbutton full" disabled={session.mode !== 'reading'} onClick={() => void run(async () => { setSelectedConversation(''); await application.command('finishReading', book.id); })}>读到这里</button><div className="button-row"><button className="secondary" onClick={() => void run(() => application.command('pause'))}>暂停</button><button className="textbutton danger" onClick={() => void run(() => application.command('stop'))}>结束共读</button></div></>}
          {!isNative() && <p className="hint">浏览器用于调试；外部跟随由 Android 客户端提供。</p>}{view.lastLatency !== undefined && <p className="hint">最近模型响应 {(view.lastLatency / 1000).toFixed(1)} 秒</p>}</div></div>
        <div className="chat-panel"><div className="chat-heading"><div><h2>{discussionRequest ? book.title : '共读交流'}</h2>{!discussionRequest && <small>{book.title} · 默认文字回应</small>}</div><select aria-label="选择对话" value={conversationId ?? ''} onChange={e => setSelectedConversation(e.target.value)}><option value="">当前对话</option>{conversations.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select><button className="textbutton" onClick={() => void run(async () => { setSelectedConversation(await application.command('newDiscussion', book.id)); })}>新建讨论</button><button className="textbutton" disabled={!conversationId} onClick={() => void run(async () => { const c = view.state.conversations.find(c => c.id === conversationId); if (!c) return; const title = await promptText("修改对话标题", c.title); if (title?.trim()) await application.command('renameConversation', c.id, title); })}>改名</button>{isNative() && <div className="button-row reader-actions"><button className="secondary" disabled={!readingSource?.installed || captureStarting || view.voiceActive} onClick={() => void run(capture)}>回到阅读</button><button className="textbutton" onClick={() => { setDiscussionRequest(discussionRequest ? 0 : 1); window.scrollTo(0, 0); }}>{discussionRequest ? '阅读设置' : '专注讨论'}</button><small className="reader-status">{session ? view.status : '尚未开启'}</small></div>}</div>
          <>{session && conversationId !== session.id && <div className="chat-context"><span>本次阅读记录仍保留</span><button className="textbutton" onClick={() => setSelectedConversation('')}>返回本次共读</button></div>}</><div className="chat-scroll">{!chats.length && <div className="chat-empty"><span>◌</span><h3>从当前阅读继续</h3><p>先定位当前页并准备已读前文，<br/>再接续共读，也可讨论已确认的内容。</p></div>}{chats.map(c => <article className={'message ' + c.role} key={c.id}><div className="message-label">{c.role === 'user' ? '读者' : view.state.partners.find(p => p.id === view.state.partnerId)?.name}<time>{new Date(c.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div>{editingTranscript === c.id && !c.replacedBy ? <div className="transcript-editor"><label>更正语音转写<textarea rows={3} maxLength={12000} value={transcriptDraft} onChange={e => setTranscriptDraft(e.target.value)}/></label><div className="button-row"><button className="primary" disabled={!transcriptDraft.trim() || transcriptDraft.trim() === c.text} onClick={() => void run(async () => { const work = application.command('correctTranscript', c.id, transcriptDraft); setEditingTranscript(''); await work; setNotice('转写已更正，已按原位置重新回应'); })}>保存并重新回应</button><button className="textbutton" onClick={() => setEditingTranscript('')}>取消更正</button></div></div> : c.longReply && c.role === 'assistant' ? <div>{c.text.split(/\n\s*\n/).filter(Boolean).map((part,index)=><p key={index}>{part}</p>)}</div> : <p>{c.text}</p>}{c.input === 'voice' && <small className="hint">{c.replacedBy ? '原语音转写 · 已有更正版本' : c.corrects ? '语音转写 · 已更正' : '语音转写'}</small>}{c.futureGrant && <small className="hint">本次后文许可 · 不用于普通共读</small>}{c.webSources?.map(ref => <a className="source-link" key={ref.url} href={ref.url} target="_blank" rel="noreferrer" onClick={e => { if (isNative()) { e.preventDefault(); void run(() => nativeCall('openWebSource', { url: ref.url })); } }}>资料来源：{ref.title} ↗</a>)}<div className="message-actions">{c.expansionOffered && !c.excluded && !c.outdatedBy && !c.futureGrant && <button onClick={() => void run(() => application.command('expandReply', c.id))}>展开这条</button>}{c.input === 'voice' && c.role === 'user' && !c.excluded && !c.replacedBy && editingTranscript !== c.id && <button onClick={() => { setEditingTranscript(c.id); setTranscriptDraft(c.text); }}>更正转写</button>}{c.excluded && <small>已退出伙伴可用记忆</small>}{c.outdatedBy && !c.excluded && <small>相关记录已有更正 · 保留当时聊天</small>}{c.memoryResult && <small>{({ saved: '本轮已保存记忆', reused: '本轮沿用已有记忆', not_saved: '本轮仅保留聊天记录', temporary: '仅本次后文许可 · 未写入记忆' })[c.memoryResult.status]}</small>}{c.role === 'user' && c.delivery === 'pending' && <small>{session?.id === c.sessionId ? '等待回应' : '上次任务未完成'}</small>}{canRetryQuestion(view.state as unknown as State,c as unknown as Chat)&&<><small>保留原题，按当前本书方式重新回应</small><button disabled={view.busy} onClick={() => void run(() => application.command('retryQuestion', c.id))}>接着回应这条</button></>}<button onClick={() => void run(async () => { await application.command('deleteChat', c.id); })}>删除此条聊天</button></div></article>)}<div ref={chatEnd}/></div>{view.busy && session?.id === conversationId && <p className="chat-status" role="status">{view.status}</p>}
          <form className="composer" onSubmit={e => { e.preventDefault(); const text = message; if (!text.trim()) return; setMessage(''); void run(async () => { await application.command('ask', book.id, text, false, conversationId); }); }}><textarea value={message} onChange={e => setMessage(e.target.value)} placeholder="接着聊，或说说对这段内容的看法…" aria-label="交流内容"/><div className="composer-bottom"><button type="button" className={'textbutton ' + (recording ? 'danger' : '')} disabled={!isNative() || view.voiceActive && !recording && !voiceDraft} onClick={() => void run(voice)}>{recording ? '结束录音并发送' : voiceDraft ? '发送语音转写' : view.voiceActive ? '正在转写' : '♬ 说一句'}</button>{view.voiceActive && <button type="button" className="textbutton danger" onClick={() => void run(cancelVoice)}>取消录音</button>}<button type="button" className="textbutton" onClick={() => void run(() => application.command('ask', book.id, '请详细展开刚才讨论的内容。', true, conversationId))}>展开讨论</button><button className="primary" disabled={!message.trim()}>发送 ↑</button></div>{voiceDraft && <p className="hint">待发送转写：{voiceDraft}</p>}</form>
          <details className="future-permission"><summary>本次问题允许查看指定后文</summary><p className="hint">所选章节会提供给当前模型，仅用于这一个问题，不改变实际阅读进度，也不会加入普通共读记忆。</p><div className="field-row"><label>起始章节<select value={futureFrom} onChange={e => setFutureFrom(Number(e.target.value))}>{book.chapters.map(c => <option key={c.index} value={c.index}>{c.title}</option>)}</select></label><label>结束章节<select value={futureTo} onChange={e => setFutureTo(Number(e.target.value))}>{book.chapters.map(c => <option key={c.index} value={c.index}>{c.title}</option>)}</select></label></div><label className="toggle"><input type="checkbox" checked={evaluationOnly} onChange={e => setEvaluationOnly(e.target.checked)}/>只评价阅读质量，不透露具体后续</label><label>本次问题<textarea value={futureQuestion} onChange={e => setFutureQuestion(e.target.value)}/></label><button className="secondary" disabled={!futureQuestion.trim() || futureTo < futureFrom || view.busy} onClick={() => void run(async () => { await application.command('askWithFuture', book.id, futureQuestion, { start: book.chapters[futureFrom].start, end: book.chapters[futureTo].end }, evaluationOnly, conversationId); setFutureQuestion(''); })}>授权本次问题并发送</button></details>
        </div></div></> }</section>}
      {tab === 'memory' && <section className="page"><div className="page-heading"><div><p className="eyebrow">保留与修正</p><h1>共读记忆</h1><p className="muted">查看书中理解、伙伴看法和实际交流；需要时可以更正或忘记。</p></div><select value={bookId} onChange={e => setBookId(e.target.value)}><option value="">选择作品</option>{view.state.books.map(b => <option key={b.id} value={b.id}>{b.title}</option>)}</select></div>
        {book && <div className="panel"><button className="secondary" disabled={view.busy || !!pendingReview} onClick={() => void run(() => application.command('reviewFacts', book.id))}>核对尚未核对的事实</button><p className="hint">按当前获准原文核对，暂停屏幕跟随；原记录保留。每条核对会使用所选模型，计入现有用量限额。</p>
          {reviewTasks.slice(0, 3).map(task => <div key={task.id} className="review-task"><p role="status">事实核对 · {task.status === 'running' ? '进行中' : task.status === 'interrupted' ? '待继续' : task.status === 'complete' ? '已完成' : '已取消'} · {task.items.filter(i => i.status !== 'pending').length}/{task.items.length}</p><p className="hint">已核对 {task.items.filter(i => i.status === 'reviewed').length} 条，其中 {task.items.filter(i => i.disposition === 'unsupported').length} 条依据不足；跳过 {task.items.filter(i => i.status === 'skipped').length} 条已变更或当前不可用的记录。</p>
            {task.status === 'interrupted' && <><p className="hint">已保存的修订会保留。继续时只处理剩余条目；中断前未提交的单条核对会重新处理，可能再次产生用量。</p><button className="secondary" disabled={view.busy} onClick={() => void run(() => application.command('resumeFactReview', task.id))}>继续核对</button></>}
            {task.status === 'running' && <button className="textbutton" onClick={() => void run(() => application.command('pause'))}>暂停核对</button>}
            {(task.status === 'running' || task.status === 'interrupted') && <button className="textbutton" onClick={() => void run(() => application.command('cancelFactReview', task.id))}>取消剩余核对</button>}
          </div>)}
        </div>}<div className="memory-grid">{bookMemories.filter(m => currentMemoryIds.has(m.id)).map(memoryCard)}</div>
        {!currentMemoryIds.size && <div className="empty"><h2>还没有可显示的当前记忆</h2><p>前文准备和共读会逐步形成相关记录。</p></div>}
        {bookMemories.some(m => !currentMemoryIds.has(m.id)) && <details><summary>查看更新前的记录</summary><p className="hint">保留当时的记录供回看，已退出当前理解。</p><div className="memory-grid">{bookMemories.filter(m => !currentMemoryIds.has(m.id)).map(memoryCard)}</div></details>}
      </section>}
      {tab === 'partner' && <section className="page narrow"><p className="eyebrow">当前伙伴</p><h1>伙伴与阅读背景</h1><div className="panel"><label>名称<input value={partnerDraft?.id === partner.id ? partnerDraft.name : partner.name} onChange={e => setPartnerDraft({ ...(partnerDraft?.id === partner.id ? partnerDraft : partner), name: e.target.value })}/></label><label>特点与相处要求<textarea rows={5} value={partnerDraft?.id === partner.id ? partnerDraft.traits : partner.traits} onChange={e => setPartnerDraft({ ...(partnerDraft?.id === partner.id ? partnerDraft : partner), traits: e.target.value })}/></label><button className="textbutton" disabled={(partnerDraft?.id === partner.id ? partnerDraft.traits : partner.traits).includes(currentBookVoiceChoice)} onClick={() => { const draft = partnerDraft?.id === partner.id ? partnerDraft : partner; setPartnerDraft({ id: partner.id, name: draft.name, traits: [draft.traits.trim(), currentBookVoiceChoice].filter(Boolean).join("\n\n") }); }}>加入随当前作品文风</button><p className="hint">选用后，阅读理解在保存时承接原文文风，后续接续、修改与交流沿原文和已有正文延续。保存特点后生效。</p><button className="primary" onClick={() => void run(async () => { const draft = partnerDraft?.id === partner.id ? partnerDraft : partner; await application.command('updatePartner', partner.id, draft.name, draft.traits); setPartnerDraft(undefined); setNotice('伙伴特点已保存，真实共读经历保留'); })}>保存特点</button></div><div className="panel"><h2>通用相处习惯</h2><p>这些习惯适用于当前伙伴的各本书。书中人物、剧情与具体讨论仍分别保留。</p>{(Object.keys(habitOptions) as HabitKey[]).map(key => { const current = currentHabits(view.state).find(h => h.key === key), setting = habitOptions[key]; return <div key={key}><label>{setting.label}<select aria-label={'通用习惯：' + setting.label} value={current?.value ?? ''} onChange={e => void run(() => application.command('setCommonHabit', key, e.target.value))}><option value="" disabled>尚未设置</option>{Object.entries(setting.values).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>{current && <button className="textbutton danger" onClick={() => void run(async () => { await application.command('setCommonHabit', key); setNotice('已忘记这项通用习惯，相关旧认识退出后续使用'); })}>忘记{setting.label}习惯</button>}</div>; })}<p className="hint">明确的日常相处要求可以在交流中自动保存；当前支持回复长短和追问频率。仅限某次或某本书的要求留在当次语境中。</p></div><div className="panel"><h2>已有阅读背景</h2><p>约二十本热门作品的阅读背景仍需按确定书单完整处理并核查。当前原型尚未装入这套背景，模型内部知识不计入已读书目。</p><span className="pill">已完整处理 {partner.backgroundBooks.length} 本用户追加资料</span><p className="hint">完整处理表示原文覆盖已完成，理解质量仍需结合原文核对；不冒充项目默认二十本背景已交付。</p><label>追加独立阅读背景<select value={bookId} onChange={e => setBookId(e.target.value)}><option value="">选择已导入的作品</option>{view.state.books.map(b => <option key={b.id} value={b.id}>{b.title}</option>)}</select></label><button className="secondary" disabled={!book || view.busy} onClick={() => void run(async () => { if (!book || !await confirmAction('本次将向所选模型处理这本书的完整正文，建立伙伴独立阅读背景。不会改变用户已读进度，也不记为共同经历。继续？')) return; await application.command('prepareBackground', book.id); })}>完整准备这本书</button>{view.progress && <p>{view.status} · {view.progress.done}/{view.progress.total}</p>}</div></section>}
      {tab === 'settings' && <section className="page settings-page"><p className="eyebrow">服务与数据</p><h1>使用设置</h1><div className="settings-grid"><div className="panel"><h2>模型服务</h2><button className="textbutton" onClick={() => void run(async () => { await application.command('addService'); setKey(''); })}>＋ 添加自定义服务</button><label>当前渠道<select value={service.id} onChange={e => { setKey(''); void run(() => application.command('selectService', e.target.value)); }}>{view.state.settings.services.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label>模型<input value={service.model} onChange={e => saveService({ model: e.target.value })}/></label><label>服务地址<input readOnly={!service.id.startsWith('custom-')} value={service.baseUrl} onChange={e => saveService({ baseUrl: e.target.value })}/></label><div className="field-row"><label>思考强度<select value={service.effort} onChange={e => saveService({ effort: e.target.value as Service['effort'] })}><option value="medium">中</option><option value="high">高</option></select></label><label>上下文上限<input type="number" value={service.contextLimit} onChange={e => saveService({ contextLimit: Math.max(4096, Math.min(service.id === 'wechat' ? 200000 : 1000000, Number(e.target.value))) })}/></label></div>{service.id.startsWith('custom-') && <><label>显示名称<input value={service.name} onChange={e => saveService({ name: e.target.value })}/></label><label>思考参数<select value={service.thinking ?? 'none'} onChange={e => saveService({ thinking: e.target.value as Service['thinking'] })}><option value="none">标准 Chat Completions</option><option value="deepseek">DeepSeek 思考扩展</option></select></label><p className="hint">自定义服务需支持 Chat Completions 与 JSON 输出。填写服务商给出的模型名、上下文和独立密钥，更换地址后重新保存启用。</p></>}<label>API Key<input type="password" autoComplete="off" value={key} onChange={e => setKey(e.target.value)} placeholder="留空保留已有密钥"/></label><div className="button-row"><button className="secondary" onClick={() => void run(enableService)}>保存并启用</button><button className="textbutton" onClick={() => saveService({ enabled: false })}>关闭</button><span className="pill">{service.enabled ? '已启用' : '未启用'}</span></div><label className="toggle"><input type="checkbox" checked={service.fallback} onChange={e => saveService({ fallback: e.target.checked })}/>允许此渠道作为自动备用</label><p className="hint">阅读资料、相关记忆和交流会按任务发送到此服务。腾讯渠道最多 200K；官方 medium 当前映射为 high。</p></div>
        <div className="panel"><h2>用量与限额</h2>
          <label>持续跟读的思考强度<select value={view.state.settings.readingEffort ?? 'medium'} onChange={e => void run(() => application.command('updateLimits', { readingEffort: e.target.value as 'medium' | 'high' }))}><option value="medium">中</option><option value="high">高</option></select></label>
          <p className="hint">前文准备和主动交流沿用渠道设置，持续跟读可单独比较速度与理解效果。</p>
          <div className="usage-number">{number(usage)}<small> tokens</small></div><p className="muted">包括准备、交流及尚未确认结算的保守预留</p>
          <label>本机累计用量上限<input type="number" min="0" value={limitsDraft.tokenLimit ?? view.state.settings.tokenLimit} onChange={e => setLimitsDraft({ ...limitsDraft, tokenLimit: Number(e.target.value) })}/></label>
          <label>单次最大输出<input type="number" min="256" max="65536" value={service.maxOutput} onChange={e => saveService({ maxOutput: Math.max(256, Math.min(65536, Number(e.target.value))) })}/></label>
          <details><summary>当前模型的估算单价</summary><p className="hint">以下统一填写人民币单价；其他币种请先换算。缓存折扣、免费额度和最终费用以服务商账单为准。</p>
            <div className="field-row"><label>输入单价（元／百万 tokens）<input type="number" min="0" step="any" value={service.inputPrice ?? ''} onChange={e => saveService({ inputPrice: e.target.value === '' ? null : Number(e.target.value) })} placeholder="未配置"/></label>
            <label>输出单价（元／百万 tokens）<input type="number" min="0" step="any" value={service.outputPrice ?? ''} onChange={e => saveService({ outputPrice: e.target.value === '' ? null : Number(e.target.value) })} placeholder="未配置"/></label></div>
          </details>
          <p>{view.state.usage.length === 0 ? '尚无模型用量记录' : budget.allUnknown === view.state.usage.length ? '当前调用记录均未估价' : <>有单价记录的估算小计：¥{money(budget.allCost)}</>}{budget.allUnknown > 0 && <small>；{budget.allUnknown} 次请求未配置单价</small>}</p>
          <label>模型费用上限（元，可留空）<input type="number" min="0" step="any" value={('costLimit' in limitsDraft ? limitsDraft.costLimit : view.state.settings.costLimit) ?? ''} placeholder="仅使用 token 限额" onChange={e => setLimitsDraft({ ...limitsDraft, costLimit: e.target.value === '' ? null : Number(e.target.value) })}/></label>
          {view.state.settings.costBudgetId && <p className="hint">本次费用预算自 {new Date(view.state.settings.costBudgetStartedAt!).toLocaleString('zh-CN')} 起累计。已估算 ¥{money(budget.cost)}{budget.unknown > 0 ? `，另有${budget.unknown}次未定价请求` : ''}。关闭再启用、切书和换模型均保留累计。</p>}
          <button className="secondary" onClick={() => void run(async () => { await application.command('updateLimits', limitsDraft); setLimitsDraft({}); setNotice('用量设置已保存'); })}>保存用量设置</button>
          <p className="hint">金额上限约束本次预算内的模型请求；独立搜索服务的收费尚未计入。填写单价不会追算过去未定价的调用。达到限额会停止新请求，调高限额不会重启已经结束的会话。本机应用内的记录不覆盖其他工具和设备。</p>
          <div className="usage-list">{view.state.usage.slice(-5).reverse().map(u => <div key={u.id}><span>{u.purpose}</span><span>{number(u.input + u.output)} tokens · {u.cost === undefined ? '未估价' : `约¥${money(u.cost)}`}{u.estimated ? ' · 用量估算' : ''}</span></div>)}</div>
        </div>
        <div className="panel"><h2>备份与迁移</h2><p>导出伙伴、书籍原文、进度、记忆和聊天，供用户自己保存与导入。</p><label className="toggle"><input type="checkbox" checked={includeKeys} onChange={e => setIncludeKeys(e.target.checked)}/>一并导出 API Key 与服务配置</label>{includeKeys && <p className="hint">携带密钥的备份以明文保存，请存放在自己可信的位置。</p>}<div className="button-row"><button className="primary" onClick={() => void run(exportData)}>导出备份</button><button className="secondary" onClick={() => backupInput.current?.click()}>导入备份</button></div><p className="hint">备份保留导出时的内容。恢复后不会自动开始跟随或付费调用。</p></div><div className="panel"><h2>按需联网</h2>
          <label>搜索服务<select value={view.state.settings.searchProvider ?? 'exa'} onChange={e => { const provider = e.target.value as 'searxng' | 'tavily' | 'exa'; searchCheckController.current?.abort(); setSearchKey(''); void run(() => application.command('selectSearch', provider)); }}><option value="exa">Exa 匿名检索（无需密钥）</option><option value="searxng">SearXNG 兼容接口</option><option value="tavily">Tavily Search</option></select></label>
          <label>搜索接口地址<input value={view.state.settings.searchEndpoint} readOnly={view.state.settings.searchProvider !== 'searxng'} onChange={e => { searchCheckController.current?.abort(); void run(() => application.command('setSearchEndpoint', e.target.value)); }} placeholder="搜索服务提供的 HTTPS 接口地址"/></label>
          {view.state.settings.searchProvider !== 'exa' && <label>搜索 API Key<input type="password" autoComplete="off" value={searchKey} onChange={e => setSearchKey(e.target.value)} placeholder="按服务需要填写；留空保留同一地址的密钥"/></label>}
          <div className="button-row"><button className="secondary" disabled={!view.state.settings.searchEndpoint} onClick={() => void run(async () => { await application.command('enableSearch', searchKey); setSearchKey(''); setNotice('已启用按需搜索与网页读取'); })}>保存并启用联网</button><button className="textbutton" disabled={!view.state.settings.searchEnabled || checkingSearch} onClick={() => void run(checkSearch)}>{checkingSearch ? '正在检查' : '检查搜索与网页读取'}</button><button className="textbutton" onClick={() => void run(async () => { searchCheckController.current?.abort(); await application.command('disableSearch'); })}>关闭联网</button><span className="pill">{view.state.settings.searchEnabled ? view.webPausedReason ? '暂不可用' : '已启用' : '未启用'}</span></div>
          {view.state.settings.searchProvider === 'exa' && <p className="hint">匿名额度由 Exa 提供，查询词与要读取的公开网页地址会发送给 Exa。无需账号和密钥；达到匿名限额时暂停，不自动切换付费服务。</p>}<p className="hint">查询词发往所选搜索服务；需要正文时访问结果中的公开网页。所取得的资料会提供给当前模型，并保留来源。当前作品内容仍受阅读范围约束。配套服务的额度与计费以提供方为准。检查功能会搜索叶片颜色，并读取一个返回的公开网页。</p>
        </div><div className="panel"><h2>设备能力</h2><dl><div><dt>运行环境</dt><dd>{isNative() ? 'Android 原生宿主' : '桌面浏览器调试'}</dd></div><div><dt>屏幕跟随</dt><dd>{isNative() ? '按授权开启' : '在 Android 客户端提供'}</dd></div><div><dt>按需语音</dt><dd>{isNative() ? '本地中文识别，按需录音' : '需要原生客户端'}</dd></div><div><dt>设备网络</dt><dd>{view.connectionAvailable ? '可用' : '暂不可用'}</dd></div><div><dt>联网</dt><dd>{view.state.settings.searchEnabled ? '按需搜索与网页读取' : '未开启'}</dd></div></dl>{isNative() && <button className="secondary" onClick={() => void run(() => nativeCall('permissions'))}>配置阅读权限</button>}{isNative() && <><p className="hint">语音在本机转写，结束录音后将文字交给当前模型。可随时取消；单次两分钟，达到时保留转写供发送。</p><button className="textbutton" onClick={() => void run(async () => { const result = await nativeCall<{ text: string; elapsedMs: number; audioMs: number }>('voiceCheck'); setNotice(`本地音频检查：${result.text}；处理 ${(result.elapsedMs / 1000).toFixed(1)} 秒，音频 ${(result.audioMs / 1000).toFixed(1)} 秒。`); })}>检查本地语音（原型联调）</button></>}</div></div></section>}
    </main><nav className="mobile-nav">{tabs.map(t => <button className={tab === t.id ? 'active' : ''} key={t.id} onClick={() => setTab(t.id)}><span>{t.icon}</span>{t.label}</button>)}</nav>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App/>);
