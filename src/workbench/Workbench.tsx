import { t, locale, setInterfaceLanguage, systemLanguage, useInterfaceLanguage } from './i18n.ts';
import {MarkdownMessage} from './MarkdownMessage.tsx';
import {BookDirectory} from './BookDirectory.tsx';
import {conversationBelongsToPartner} from '../core/discussion-recall.ts';
import {usageTokens} from '../core/accounting.ts';
import {formatTokens} from './token-display.ts';
import {workbenchAutomationAttributes,workbenchSourceIdentity,sameWorkbenchSource} from './events.ts';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { WorkbenchClient, ReplyRating, WorkbenchSnapshot, WorkbenchExportFile,WorkbenchSourceIdentity } from './contract.ts';
import type {ReadingRecoveryCapability} from '../core/types.ts';
import { decodeBook } from '../core/books.ts';
import { Dialog, Drawer, EmptyReader, ImportDialog, Notice } from './components.tsx';
import { Icon } from './icons.tsx';
import { SettingsPanel } from './SettingsPanel.tsx';
import type { SettingsDraft } from './SettingsPanel.tsx';
import { PartnerPanel } from './PartnerPanel.tsx';
import { PartnerAvatar, PartnerMessageAuthor } from './PartnerAvatar.tsx';
import { ReadingRangePanel } from './ReadingRangePanel.tsx';
import { restoreReadingPosition, visibleReadingRange } from './visible-reading.ts';
import { readingParagraphs } from './reading-layout.ts';
import { UnderstandingPanel } from './UnderstandingPanel.tsx';
import { ParagraphNotesPanel, useParagraphNotes } from './ParagraphNotes.tsx';
import { ReadingStatusControls } from './ReadingStatusControls.tsx';
import type { PublishedReplyTarget } from './PublishedReplyPreview.tsx';
import { PublishedReplyPreview } from './PublishedReplyPreview.tsx';
import { EmojiPicker, MessageEmojiReactions, isEmojiOnlyText } from './EmojiInteraction.tsx';
import { ActivityPanel } from './ActivityPanel.tsx';
import { ProcessEvents } from './ProcessEvents.tsx';
import type { ParagraphDraft } from './ParagraphNotes.tsx';
import { messageDraftKey, paragraphDraftKey, useWorkbenchDrafts } from './drafts.ts';
import { workbenchErrorLabel as readableError, readingStatusLabel, recoveryReasonLabel } from './copy.ts';
import {AutoReadingControls} from './AutoReadingControls.tsx';
import {BookDetailsPanel} from './BookDetailsPanel.tsx';
import {useReadingViewport} from './use-reading-viewport.ts';
import {useAutoReading} from './use-auto-reading.ts';
import type {AutoReadingSettings} from './contract.ts';
import {availableRecovery,recoveryActionLabel,performRecovery,shouldShowCurrentRecovery} from './activity-presentation.ts';
import {ReplyVisibility} from './ReplyVisibility.tsx';
import type {ChatSummary} from '../core/ui-records.ts';
import {bookVersionAllowsRange} from '../core/book-versions.ts';
import {useChatViewport} from './use-chat-viewport.ts';
import {useConversationMessages} from './use-conversation-messages.ts';
import {useDesktopWindowState,nativeReadingVisible,manualReadingVisible} from './desktop-window.ts';

const number = (value: number) => Intl.NumberFormat(locale()).format(value);
const time = (value: number) => new Date(value).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const duration = (value: number) => value < 1000 ? t("{0} 毫秒",Math.max(1, Math.round(value))) : t("{0} 秒",(value / 1000).toFixed(1));
const ratingOptions: { value: ReplyRating; label: string; icon: 'check' | 'heart' | 'flag' }[] = [{ value: 'accurate', get label(){return t("准确");}, icon: 'check' }, { value: 'resonant', get label(){return t("有共鸣");}, icon: 'heart' }, { value: 'verify', get label(){return t("需要核实");}, icon: 'flag' }];
type DetailTab = 'understanding' | 'process' | 'budget' | 'sessions';
async function downloadJSON(load:()=>Promise<WorkbenchExportFile>){
  type Writable={write(value:Uint8Array|string):Promise<void>;close():Promise<void>;abort():Promise<void>};
  const picker=(window as unknown as {showSaveFilePicker?:(options:unknown)=>Promise<{createWritable():Promise<Writable>}>}).showSaveFilePicker;
  // Open the native chooser in the original user gesture, before export preparation awaits.
  let target:{createWritable():Promise<Writable>}|undefined;
  if(picker)try{target=await picker.call(window,{get suggestedName(){return t("伴读记录.json");},types:[{get description(){return t("伴读 JSON");},accept:{'application/json':['.json']}}]});}catch(error){if((error as Error).name==='AbortError')return false;throw error;}
  const result=await load();let response:Response|undefined;
  if('download'in result){
    if(!result.download.url||!result.download.token)throw Error(t("正常导出缺少宿主下载连接"));
    response=await fetch(result.download.url,{headers:{Authorization:'Bearer '+result.download.token}});
    if(!response.ok||response.headers.get('X-Content-SHA256')!==result.download.sha256)throw Error(t("宿主导出文件身份不符，原存档保持"));
  }
  if(target){const file=await target.createWritable();try{
    if(response){if(!response.body)throw Error(t("正常导出文件流不可用"));const reader=response.body.getReader();let bytes=0;for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.length;await file.write(next.value);}if('download'in result&&bytes!==result.download.bytes)throw Error(t("下载文件长度不符，请保留原存档后重新导出"));}
    else if('text'in result)await file.write(result.text);
    await file.close();
  }catch(error){await file.abort();throw error;}return 'saved' as const;}
  const blob=response?await response.blob():new Blob(['text'in result?result.text:''],{type:'application/json;charset=utf-8'});
  const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=result.name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),10000);return 'requested' as const;
}

export function Workbench({ client }: { client: WorkbenchClient }) {
  const language=useInterfaceLanguage();
  const desktopWindow=useDesktopWindowState(),manualWindowVisible=nativeReadingVisible(desktopWindow),developerMode=desktopWindow.developerMode;
  const snapshot = useSyncExternalStore(listener => client.subscribe(listener), () => client.getSnapshot());
  const { app, book, page } = snapshot;
  const initializingLanguage=useRef<string|undefined>(undefined);
  useEffect(()=>{
    const saved=app.state.settings.language;
    const next=saved??systemLanguage();
    setInterfaceLanguage(next);
    void window.yixuDesktop?.setLanguage?.(next).catch(()=>{});
    if(!saved&&initializingLanguage.current!==snapshot.sessionId){
      initializingLanguage.current=snapshot.sessionId;
      void client.setLanguage(next,true).catch(error=>console.error('Save interface language:',error));
    }
  },[client,snapshot.sessionId,app.state.settings.language]);
  const retainedPage=useRef<{archiveId:string;page:NonNullable<WorkbenchSnapshot['page']>}|undefined>(undefined);
  if(page)retainedPage.current={archiveId:snapshot.sessionId,page};
  const previousPage=retainedPage.current;
  const readerPage=page??(previousPage?.archiveId===snapshot.sessionId&&previousPage.page.bookId===book?.id&&previousPage.page.version===book?.version?previousPage.page:undefined);
  const readerParagraphs=useMemo(()=>readerPage?readingParagraphs(readerPage.text,readerPage.start,readerPage.chapterTitle):[],[readerPage?.text,readerPage?.start,readerPage?.chapterTitle]);
  const [importOpen, setImportOpen] = useState(false), [settingsOpen, setSettingsOpen] = useState(false), [detail, setDetail] = useState<DetailTab | undefined>();
  const [mobileTab, setMobileTab] = useState<'reading' | 'chat'>('reading'), [navOpen, setNavOpen] = useState(false), [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [partnerOpen, setPartnerOpen] = useState(false), [rangeOpen, setRangeOpen] = useState(false), [experienceOpen, setExperienceOpen] = useState(false), [experienceNote, setExperienceNote] = useState('');
  const [renameOpen, setRenameOpen] = useState(false), [conversationName, setConversationName] = useState('');
  const [bookDetailsOpen, setBookDetailsOpen] = useState(false);
  const [emojiOpen,setEmojiOpen]=useState(false);
  const [focusedPublication,setFocusedPublication]=useState<string>();
  const [unreadReplies,setUnreadReplies]=useState<readonly PublishedReplyTarget[]>([]);
  const [paragraphPublication,setParagraphPublication]=useState<PublishedReplyTarget>();
  const [endingRequested,setEndingRequested]=useState(false);
  const [pauseRequested,setPauseRequested]=useState(false);
  const pauseRef=useRef(false);
  const endingRef=useRef(false);
  const [chapterSearch, setChapterSearch] = useState(''), [fontSize, setFontSize] = useState(19);
  const [historyConversation, setHistoryConversation] = useState('');
  const [localNotice, setLocalNotice] = useState(''), [localError, setLocalError] = useState(''), [positionOpen, setPositionOpen] = useState(false), [positionDraft, setPositionDraft] = useState('');
  const sourceProducer=useRef({id:crypto.randomUUID(),sequence:0});
  const [sourceRegistration,setSourceRegistration]=useState<{archiveId:string;connectionEpoch:string;epoch:string}>();
  const sourceRegistrationRef=useRef<typeof sourceRegistration>(undefined);
  const [reviewChat, setReviewChat] = useState<string | undefined>(), [reviewNote, setReviewNote] = useState('');
  const [noteParagraph, setNoteParagraph] = useState<number>();
  const [automaticHere,setAutomaticHere]=useState(false);
  const sendingDrafts = useRef(new Set<string>());
  const [sendingMessageKeys,setSendingMessageKeys]=useState<ReadonlySet<string>>(()=>new Set());
  const composer = useRef<HTMLTextAreaElement>(null), sourcePaper = useRef<HTMLDivElement>(null), sourceContent = useRef<HTMLDivElement>(null);
  const [mobileLayout,setMobileLayout]=useState(()=>matchMedia('(max-width:760px)').matches);
  useEffect(()=>{const media=matchMedia('(max-width:760px)'),change=()=>setMobileLayout(media.matches);media.addEventListener('change',change);return()=>media.removeEventListener('change',change);},[]);
  const partner = app.state.partners.find(item => item.id === app.state.partnerId);
  const conversations = app.state.conversations.filter(item => item.bookId === book?.id && conversationBelongsToPartner(app.state,item)).slice().sort((a, b) => b.createdAt - a.createdAt);
  const conversationContinuity=app.conversationContinuity?.find(item=>item.bookId===book?.id&&item.partnerId===app.state.partnerId);
  const activeConversation = conversations.some(item=>item.id===conversationContinuity?.conversationId)?conversationContinuity!.conversationId:app.session?.bookId === book?.id && conversations.some(item=>item.id===app.session?.id) ? app.session?.id : conversations[0]?.id;
  const displayedConversation = conversations.some(item => item.id === historyConversation) ? historyConversation : activeConversation;
  const displayedConversationRecord=conversations.find(item=>item.id===displayedConversation);
  const previousConversation=conversations.find(item=>item.id===(displayedConversationRecord?.previousConversationId??(displayedConversation===activeConversation?conversationContinuity?.previousConversationId:undefined)));
  const drafts = useWorkbenchDrafts(client, snapshot, setLocalError);
  const messageKey = book ? messageDraftKey(book.id, book.version, displayedConversation) : '';
  const message = book ? drafts.read(snapshot.sessionId, messageKey, snapshot.drafts?.[messageKey]).text : '';
  const setMessage = (text: string) => { if (book) drafts.set(snapshot.sessionId, messageKey, { text }); };
  const busy = app.busy || snapshot.busyAction;
  const paused = pauseRequested||app.readingControl?.state === 'paused', stopping = endingRequested||app.readingControl?.state === 'stopping';
  const activeSession = app.session?.bookId === book?.id && app.session?.active ? app.session : undefined;
  const readingSession = app.session?.bookId === book?.id && app.session?.active && app.session.mode === 'reading' ? app.session : undefined;
  const quiet = app.session?.quiet ?? app.state.settings.defaultQuiet;
  const partnerThinking=app.activities.some(item=>item.bookId===book?.id&&item.partnerId===app.state.partnerId&&item.kind!=='maintenance'&&['preparing','waiting-model','tools'].includes(item.stage));
  const shownError=localError;
  const length = book?.textLength ?? 0;
  const knownChars = book?.known.reduce((total, range) => total + range.end - range.start, 0) ?? 0;
  const selectedChapter = page?.chapterIndex ?? 0;
  const positionChapter = book?.chapters.slice().reverse().find(chapter => chapter.start <= Number(positionDraft))?.index ?? selectedChapter;
  const paragraphs = useMemo(() => page ? readingParagraphs(page.text, page.start, page.chapterTitle) : [], [page?.text, page?.start, page?.chapterTitle]);
  // Core revision also covers forgotten dependencies and excluded source chats.
  const notesRevision = String(app.revision);
  const paragraphNotes = useParagraphNotes(client, book?.id, page, notesRevision,book,{archiveId:snapshot.sessionId,partnerId:app.state.partnerId});
  const linkedAnchor=paragraphPublication&&paragraphPublication.bookId===book?.id?paragraphPublication.anchor:undefined;
  const linkedNotes=useParagraphNotes(client,book?.id,linkedAnchor,notesRevision,book,{archiveId:snapshot.sessionId,partnerId:app.state.partnerId});
  const selectedParagraph = paragraphs.find(paragraph => paragraph.start === noteParagraph)??(linkedAnchor?{start:linkedAnchor.start,end:linkedAnchor.end,text:linkedAnchor.quote,version:linkedAnchor.version}:undefined);
  const selectedNotes=linkedAnchor?linkedNotes:paragraphNotes;
  const closeNotes=()=>{setNoteParagraph(undefined);setParagraphPublication(undefined);};
  const openParagraph=(start:number)=>{setParagraphPublication(undefined);setNoteParagraph(start);};
  const notesFor = (paragraph: { start: number; end: number }) => paragraphNotes.items.filter(comment => comment.anchor.start < paragraph.end && comment.anchor.end > paragraph.start);
  const selectedNoteKey = book && selectedParagraph ? paragraphDraftKey(book.id, ('version' in selectedParagraph?selectedParagraph.version:undefined)??book.version, selectedParagraph.start, selectedParagraph.end) : '';
  const noteDraftProps = {
    draft: drafts.read(snapshot.sessionId, selectedNoteKey, snapshot.drafts?.[selectedNoteKey]),
    onDraftChange: (draft: ParagraphDraft) => { if (selectedNoteKey) drafts.set(snapshot.sessionId, selectedNoteKey, draft); },
    onPublished: (submitted: ParagraphDraft) => drafts.clearSubmitted(snapshot.sessionId, selectedNoteKey, submitted),
    onDetails: () => setDetail('process'),
  };
  const overlayOpen = importOpen || settingsOpen || !!detail || positionOpen || !!reviewChat || partnerOpen || rangeOpen || experienceOpen || renameOpen || bookDetailsOpen || !!selectedParagraph && mobileLayout || navOpen && matchMedia('(max-width:1030px)').matches;
  const chatVisible=manualWindowVisible&&snapshot.sourceOwner?.producerId===sourceProducer.current.id&&!overlayOpen&&!selectedParagraph&&(!mobileLayout||mobileTab==='chat');
  const conversationMessages=useConversationMessages(client,snapshot,displayedConversation,focusedPublication,chatVisible),chats=conversationMessages.messages;
  const chatViewport=useChatViewport(JSON.stringify([snapshot.sessionId,book?.id,displayedConversation]),chats.map(chat=>chat.id),chatVisible,{available:conversationMessages.hasEarlier,loading:conversationMessages.loading,error:conversationMessages.error,load:conversationMessages.loadEarlier,retain:conversationMessages.retain,retained:conversationMessages.retained,resume:()=>returnToLatest()});
  const conversationStreams=snapshot.streamingReplies?.filter(reply=>reply.bookId===book?.id&&reply.conversationId===displayedConversation&&!reply.paragraphCommentId)??[];
  function returnToLatest(){setFocusedPublication(undefined);conversationMessages.showLatest();chatViewport.latest();}

  async function run(action: () => Promise<unknown>, success?: string) {
    setLocalError('');
    try { await action(); if (success) setLocalNotice(success); }
    catch (error) { setLocalError(error instanceof Error ? error.message : t("操作暂时未完成，请查看处理详情。")); }
  }
  async function captureSource(source:WorkbenchSourceIdentity,visible:boolean,range?:{start:number;end:number},startFollowing=false,automatic=false){
    if(!automatic&&!manualReadingVisible()){visible=false;range=undefined;}
    let registration=sourceRegistrationRef.current;
    if(startFollowing&&registration){
      const epoch=await client.activateReadingSource(sourceProducer.current.id,registration.epoch);
      if(!epoch)throw Error(t("暂时无法开始伴读，请稍后再试。"));
      registration={...registration,epoch};sourceRegistrationRef.current=registration;setSourceRegistration(registration);
    }
    if(!registration||registration.archiveId!==source.archiveId||registration.connectionEpoch!==snapshot.sourceConnectionEpoch)throw Error(t("当前屏幕来源尚未连接，请等待正文就绪后再开始。"));
    const receipt=await client.captureReadingSource({source,producerId:sourceProducer.current.id,sourceEpoch:registration.epoch,sequence:++sourceProducer.current.sequence,visible,readingMode:automatic?'developer-auto':'manual',...(range?{range}:{}),...(startFollowing?{startFollowing:true}:{})});
    return receipt;
  }
  async function startAutomatic(settings:AutoReadingSettings){
    if(!snapshot.modelReady&&snapshot.mode==='live'){setDetail(undefined);setSettingsOpen(false);setPartnerOpen(true);return;}
    if(snapshot.backgroundModelReady===false){setDetail(undefined);setSettingsOpen(true);return;}
    const source=workbenchSourceIdentity(snapshot),registration=sourceRegistration,range=visibleReadingRange(sourcePaper.current,sourceContent.current,page);
    if(!source||!registration||!range)throw Error(t("请等待当前正文显示和连接完成后开始"));
    await client.startAutoReading({source,producerId:sourceProducer.current.id,sourceEpoch:registration.epoch,sequence:++sourceProducer.current.sequence,visible:true,range,readingMode:'developer-auto'},settings);
    const owner=client.getSnapshot().sourceOwner;if(owner?.producerId===sourceProducer.current.id){const next={...registration,epoch:owner.epoch};sourceRegistrationRef.current=next;setSourceRegistration(next);}
    setAutomaticHere(client.getSnapshot().autoReading?.phase==='reading');
  }
  const startAutomaticRef=useRef(startAutomatic);
  useLayoutEffect(()=>{startAutomaticRef.current=startAutomatic;});
  useEffect(()=>{
    const desktop=window.yixuDesktop;
    if(!desktop?.onAutoReadingRequested||!desktop.respondAutoReading)return;
    return desktop.onAutoReadingRequested(request=>{
      void(async()=>{
        let result:{ok:boolean;error?:string};
        try{
          await startAutomaticRef.current(request.settings);
          if(client.getSnapshot().autoReading?.phase!=='reading')throw Error(t("自动阅读尚未开始，请确认模型服务、当前正文与屏幕来源已准备好"));
          result={ok:true};
        }catch(error){result={ok:false,error:error instanceof Error?error.message:t("自动阅读启动未完成")};}
        await desktop.respondAutoReading!(request.id,result);
      })().catch(error=>setLocalError(error instanceof Error?error.message:t("自动阅读启动回执未送达，请核对当前状态")));
    });
  },[client]);
  useEffect(()=>{if(snapshot.autoReading?.phase!=='reading')setAutomaticHere(false);},[snapshot.autoReading?.phase]);
  useAutoReading(client,snapshot,sourcePaper,sourceContent,automaticHere,async()=>{
    const source=workbenchSourceIdentity(snapshot),range=visibleReadingRange(sourcePaper.current,sourceContent.current,page);
    if(!source||!range)throw Error(t("当前正文不可见"));return captureSource(source,true,range,false,true);
  });
  function closeNavigation() {
    setNavOpen(false);
    if (matchMedia('(max-width:1030px)').matches) {
      const directoryButton = document.querySelector<HTMLButtonElement>('.nav-toggle');
      (directoryButton?.getClientRects().length ? directoryButton : document.querySelector<HTMLButtonElement>('.brand-mark'))?.focus({ preventScroll: true });
    }
  }
  useLayoutEffect(() => { if (page) restoreReadingPosition(sourcePaper.current, sourceContent.current, page.position); }, [page?.start, page?.navigationRevision, book?.id]);
  useEffect(()=>{
    let cancelled=false;sourceRegistrationRef.current=undefined;setSourceRegistration(undefined);
    if(snapshot.sourceConnectionEpoch)void client.registerReadingSource(sourceProducer.current.id,snapshot.sessionId,snapshot.sourceConnectionEpoch).then(epoch=>{
      if(!cancelled){const registration={archiveId:snapshot.sessionId,connectionEpoch:snapshot.sourceConnectionEpoch!,epoch};sourceRegistrationRef.current=registration;setSourceRegistration(registration);}
    }).catch(error=>{if(!cancelled)setLocalError(error instanceof Error?error.message:t("屏幕来源连接未完成"));});
    return()=>{cancelled=true;const registration=sourceRegistrationRef.current;if(registration)void client.releaseReadingSource(sourceProducer.current.id,registration.epoch).catch(()=>{});};
  },[client,snapshot.sessionId,snapshot.sourceConnectionEpoch]);
  useEffect(()=>{
    if(!window.yixuDesktop||!manualWindowVisible||!sourceRegistration||snapshot.sourceOwner)return;
    void client.activateReadingSource(sourceProducer.current.id,sourceRegistration.epoch,true).then(epoch=>{const current=sourceRegistrationRef.current;if(epoch&&current?.archiveId===sourceRegistration.archiveId&&current.connectionEpoch===sourceRegistration.connectionEpoch){const next={...current,epoch};sourceRegistrationRef.current=next;setSourceRegistration(next);}}).catch(()=>{});
  },[client,manualWindowVisible,sourceRegistration,snapshot.sourceOwner]);
  useEffect(() => { setHistoryConversation('');setParagraphPublication(undefined); }, [snapshot.sessionId,book?.id,app.state.partnerId]);
  useEffect(() => { setNoteParagraph(undefined); }, [book?.id, page?.start]);
  useEffect(() => { setBookDetailsOpen(false); }, [book?.id, snapshot.sessionId]);
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
  useEffect(() => { if (!localNotice) return; const timer = setTimeout(() => setLocalNotice(''), 4000); return () => clearTimeout(timer); }, [localNotice]);
  const viewportSource=workbenchSourceIdentity(snapshot);
  useReadingViewport({
    scope:JSON.stringify([snapshot.sessionId,book?.id,page?.start,page?.end,page?.navigationRevision,page?.prepared,snapshot.sourceConnectionEpoch,snapshot.sourceOwner?.epoch,sourceRegistration?.epoch,fontSize,overlayOpen,mobileTab,navOpen,noteParagraph,manualWindowVisible,snapshot.following]),
    enabled:!pauseRequested&&!endingRequested&&snapshot.autoReading?.phase!=='reading'&&snapshot.sourceOwner?.producerId===sourceProducer.current.id&&!!viewportSource&&sourceRegistration?.archiveId===snapshot.sessionId&&sourceRegistration?.connectionEpoch===snapshot.sourceConnectionEpoch,
    element:sourcePaper,
    measure:()=>{const visible=manualReadingVisible()&&!overlayOpen&&!(navOpen&&matchMedia('(max-width:1030px)').matches)&&!(selectedParagraph&&mobileLayout)&&document.visibilityState==='visible'&&(!mobileLayout||mobileTab==='reading');const range=visible?visibleReadingRange(sourcePaper.current,sourceContent.current,page):undefined;return{visible:visible&&!!range,...(range?{range}:{})};},
    deliver:view=>captureSource(viewportSource!,view.visible,view.range),
    onError:error=>setLocalError(error instanceof Error?error.message:t("暂时无法同步阅读位置，请稍后继续。")),
  });
  function beginFollowing() {
    if(pauseRef.current||endingRef.current)return;
    if(snapshot.sessionArchived){setLocalError(t("此存档已归档，请使用当前正常存档或新建阅读存档。"));return;}
    const startFromVisible = () => {
      const current = client.getSnapshot();
      if(current.connectionError){setLocalError(t("与本机程序的连接中断了。连接恢复后，请重新开始伴读；已有记录会保留。"));return;}
      const source=workbenchSourceIdentity(snapshot);
      if(!source||!sameWorkbenchSource(source,workbenchSourceIdentity(current))||snapshot.sourceConnectionEpoch!==current.sourceConnectionEpoch){setLocalNotice(t("阅读位置正在切换，请等待当前正文显示后再开始伴读。"));return;}
      if (!current.modelReady) { setPartnerOpen(true); return; }
      if(current.backgroundModelReady===false){setSettingsOpen(true);return;}
      if (current.app.readingControl?.state === 'stopping') return;
      const firstBody = current.book?.frontMatterIncluded ? 0 : current.book?.frontMatterEnd ?? 0;
      const range = visibleReadingRange(sourcePaper.current, sourceContent.current, page);
      if (!range) { setLocalError(t("请回到原文，确保正文出现在屏幕上，再开始伴读。")); return; }
      const firstLine = paragraphs.find(paragraph => !paragraph.heading);
      if (current.book && !current.book.known.length && (!current.page?.firstReadingSection || range.start > (firstLine?.start ?? firstBody))) { setRangeOpen(true); return; }
      void run(async()=>{const receipt=await captureSource(source,true,range,true);if(receipt.status==='obsolete')setLocalNotice(t("阅读位置已切换，请从当前可见正文开始伴读。"));});
    };
    // On narrow screens the reading pane is hidden while chatting. Restore it
    // before measuring the visible range, without offering hidden text.
    if (matchMedia('(max-width:760px)').matches && mobileTab !== 'reading') {
      setMobileTab('reading'); requestAnimationFrame(startFromVisible);
    } else startFromVisible();
  }
  async function importFile(file: File) {
    if(client.importFile)await client.importFile(file);
    else if (/\.json$/i.test(file.name)) await client.importBackup(await file.text());
    else await client.importTxt(file.name, decodeBook(await file.arrayBuffer()));
    setLocalNotice(t("资料已放入书架。选好实际读点与前文范围，再开始伴读。"));
  }
  async function download(backup = false) {
    const saved=await downloadJSON(async()=>{await drafts.flushCurrentArchive();return backup ? client.exportBackup() : client.exportSession();});
    if(saved==='saved')setLocalNotice(backup ? t("完整共读备份文件已保存。") : t("本次记录文件已保存，包含过程与人工评价。"));
    else if(saved==='requested')setLocalNotice(backup?t("已请求下载完整共读备份，请查看下载文件。"):t("已请求下载本次记录，请查看下载文件。"));
  }
  async function pauseReading(){
    if(pauseRef.current)return;pauseRef.current=true;setPauseRequested(true);
    try{await run(()=>client.pause());}finally{pauseRef.current=false;setPauseRequested(false);}
  }
  async function endReading(){
    if(endingRef.current)return;endingRef.current=true;setEndingRequested(true);
    try{await run(()=>client.stop());}finally{endingRef.current=false;setEndingRequested(false);}
  }
  function send() {
    const text = message.trim();
    if (!text || !book || snapshot.busyAction || stopping) return;
    if (!snapshot.modelReady) { setPartnerOpen(true); return; }
    const archiveId = snapshot.sessionId, key = messageKey, submitted = { text: message }, operation = JSON.stringify([archiveId, key, text]);
    if (sendingDrafts.current.has(operation)) return;
    const before = !displayedConversation ? new Set(app.state.chats.filter(chat => chat.bookId === book.id).map(chat => chat.id)) : undefined;
    sendingDrafts.current.add(operation);setSendingMessageKeys(new Set(sendingDrafts.current));
    returnToLatest();
    void run(async () => {
      try { await client.sendMessage(text, false, displayedConversation); drafts.clearSubmitted(archiveId, key, submitted); }
      catch (error) {
        // A first question can create its topic before the model request fails.
        // Use that persisted user message, never a new active topic guessed later.
        const current = client.getSnapshot();
        const created = before && current.sessionId === archiveId ? current.app.state.chats.filter(chat => !before.has(chat.id) && chat.bookId === book.id && chat.role === 'user' && chat.text === text && chat.sessionId) : [];
        if (created.length === 1) drafts.moveSubmitted(archiveId, key, messageDraftKey(book.id, book.version, created[0].sessionId), submitted);
        throw error;
      } finally { sendingDrafts.current.delete(operation);setSendingMessageKeys(new Set(sendingDrafts.current)); }
    });
  }
  function openPublication(chat:PublishedReplyTarget){
    setFocusedPublication(chat.id);setMobileTab('chat');
    if(chat.presentation==='paragraph'&&chat.anchor){
      const paragraph=book&&bookVersionAllowsRange(book,chat.anchor.version,chat.anchor)?paragraphs.find(item=>item.start<chat.anchor!.end&&item.end>chat.anchor!.start):undefined;
      if(paragraph)openParagraph(paragraph.start);
      else{setNoteParagraph(undefined);setParagraphPublication(chat);}
    }else{closeNotes();if(chat.sessionId)setHistoryConversation(chat.sessionId);}
  }
  useEffect(()=>{
    if(!focusedPublication)return;
    chatViewport.pause();
    const element=document.querySelector<HTMLElement>(`[data-comment-id="${CSS.escape(focusedPublication)}"], [data-chat-id="${CSS.escape(focusedPublication)}"]`);
    if(!element)return;
    conversationMessages.retain();
    element.scrollIntoView({block:'nearest',behavior:'smooth'});element.setAttribute('tabindex','-1');element.focus({preventScroll:true});setFocusedPublication(undefined);
  },[focusedPublication,noteParagraph,selectedNotes.items,chats,mobileTab]);
  function insertEmoji(emoji:string){
    const input=composer.current,start=input?.selectionStart??message.length,end=input?.selectionEnd??start;
    setMessage(message.slice(0,start)+emoji+message.slice(end));setEmojiOpen(false);
    requestAnimationFrame(()=>{input?.focus();input?.setSelectionRange(start+emoji.length,start+emoji.length);});
  }
  async function saveSettings(draft: SettingsDraft) {
    if (snapshot.mode !== draft.mode) await client.switchMode(draft.mode);
    await client.updateSettings({ serviceId: draft.serviceId, thinking:draft.thinking,temperature:draft.temperature??null,topP:draft.topP??null, baseUrl: draft.endpoint.trim(), model: draft.model.trim(), apiKey: draft.apiKey || undefined, maxOutput: draft.maxOutput, tokenLimit: draft.tokenLimit, contextLimit: draft.contextLimit, effort: draft.effort, pageChars: draft.pageChars });
    setLocalNotice(draft.mode === 'live' ? t("后台模型与用量设置已保存。伙伴的模型绑定保持不变。") : t("已保存界面演示设置。"));
  }

  return <div className={`wb${sidebarCollapsed ? ' shelf-collapsed' : ''}`}>
    <header className="wb-topbar" inert={partnerOpen} aria-hidden={partnerOpen || undefined}><div className="brand"><button className="brand-mark" onClick={() => { setMobileTab('reading'); setSidebarCollapsed(false); setNavOpen(!navOpen); }} aria-label={t("打开书架与目录")}><Icon name="book" size={24} /></button><div><h1>{t("宜序伴读")}</h1><small>{window.yixuDesktop ? t("阅 读 与 交 流") : t("共 读 测 试 台")}</small></div></div><div className="topbar-context"><span>{book?.title ?? t("选择书籍，开始共读")}</span><span className={`mode-pill${snapshot.mode === 'live' ? ' live' : ''}`}><i className="status-dot" />{snapshot.mode === 'live' ? t("AI共读") : t("界面演示")}</span></div><div className="topbar-actions"><div className="conversation-notice-anchor"><PublishedReplyPreview client={client} snapshot={snapshot} enabled={manualWindowVisible&&!overlayOpen&&snapshot.sourceOwner?.producerId===sourceProducer.current.id} onOpen={openPublication} onUnreadChange={(_unread,_latest,replies)=>setUnreadReplies(replies??[])} /><ReadingStatusControls actionError={localError} onDismissError={()=>setLocalError('')} onReconnect={async()=>{await client.reconnect?.();}} snapshot={snapshot} unreadReplies={unreadReplies} onLocatePending={offset=>void run(()=>client.jumpTo(offset))} onClearUnread={async replies=>{if(book)await client.clearUnreadMessages(book.id,{partnerId:app.state.partnerId,targetIds:replies.map(reply=>reply.id)});}} onOpenReply={openPublication} onConversation={()=>{closeNotes();setMobileTab('chat');requestAnimationFrame(()=>composer.current?.focus());}} onDetails={()=>setDetail('process')} onModels={role=>role==='conversation'?setPartnerOpen(true):setSettingsOpen(true)} onRecovery={decision=>performRecovery(client,decision)} onMaintenanceAction={(jobId,action)=>action==="dismiss"?client.dismissMaintenance(jobId):client.restoreMaintenance(jobId)} /></div><button className="btn btn-outline btn-small" aria-label={t("导出本次记录")} onClick={() => void run(() => download())}><Icon name="export" size={16} /><span>{t("导出阅读记录")}</span></button><button className="btn btn-small" aria-label={t("打开设置")} onClick={() => setSettingsOpen(true)}><Icon name="settings" size={17} /><span>{t("设置")}</span></button></div></header>
    <nav className="mobile-nav" aria-label={t("工作区")} inert={partnerOpen} aria-hidden={partnerOpen || undefined}><button className={mobileTab === 'reading' ? 'selected' : ''} onClick={() => setMobileTab('reading')}><Icon name="book" size={15} />{t("阅读原文")}</button><button className={mobileTab === 'chat' ? 'selected' : ''} onClick={() => setMobileTab('chat')}><Icon name="chat" size={15} />{t("伙伴交流")}{chats.length ? ` · ${chats.length}` : ''}</button></nav>
    {snapshot.sessionArchived&&<div className="callout amber" role="status">{t("此存档已归档，停止新增处理。")}<button className="btn btn-small" onClick={()=>void run(()=>client.createSession(snapshot.mode))}>{t("新建阅读存档")}</button></div>}
    <main className="wb-layout" inert={partnerOpen} aria-hidden={partnerOpen || undefined}>
      {navOpen && <button type="button" className="nav-backdrop" tabIndex={-1} aria-label={t("关闭目录遮罩")} onClick={closeNavigation} />}
      <aside className={`sidebar${navOpen ? ' nav-open' : ''}`} aria-label={t("书架与目录")}><section className="sidebar-books"><div className="side-heading"><h2>{t("我的书架")}</h2><button className="icon-btn shelf-hide" aria-label={navOpen ? t("关闭书架与目录") : t("收起书架")} onClick={() => { closeNavigation(); setSidebarCollapsed(true); }}><Icon name="close" size={13} /></button><span className="section-eyebrow">{app.state.books.filter(item => !item.archived).length} {t("本")}</span></div><button className="btn import-btn" onClick={() => { setImportOpen(true); setNavOpen(false); }}><Icon name="plus" size={16} />{t("添加书籍或备份")}</button><div className="book-list">{app.state.books.filter(item => !item.archived).map(item => <button className={`book-item${item.id === book?.id ? ' selected' : ''}`} key={item.id} onClick={() => void run(async () => { await client.selectBook(item.id); setChapterSearch(''); setNavOpen(false); })}><div className="book-cover"><Icon name="book" size={17} /></div><div><strong>{item.title}</strong><small>{item.directory?.entries.length??item.chapters.length} {t("个目录项 ·")}{number(item.textLength)} {t("字")}</small></div></button>)}</div>{!app.state.books.length && <p className="side-empty">{t("添加正在阅读的书籍，")}<br />{t("从当前进度开始共读。")}</p>}</section>
      {!!snapshot.sources.filter(source=>!source.historical).length && <section><div className="side-heading"><h2>{t("示例阅读存档")}</h2></div>{snapshot.sources.filter(source=>!source.historical).map(source => <button key={source.id} className="book-item" disabled={source.available === false || snapshot.busyAction} onClick={() => void run(() => client.importSource(source.id), t("已创建独立阅读存档，原存档保留。"))}><Icon name="history" size={16} /><div><strong>{source.title}</strong><small>{t("原文示例 · 从当前阅读形成理解")}</small></div></button>)}</section>}
      <div className="sidebar-divider" /><section className="sidebar-directory"><div className="side-heading"><h2>{t("章节目录")}</h2>{book && <button className="text-action" onClick={() => { setPositionDraft(String(client.getSnapshot().page?.position ?? 0)); setPositionOpen(true); }}>{t("选择阅读位置")}<Icon name="chevron" size={11} /></button>}</div>{book && <div className="chapter-search"><Icon name="search" size={14} /><input aria-label={t("搜索章节")} placeholder={t("查找章节")} value={chapterSearch} onChange={event => setChapterSearch(event.target.value)} /></div>}{book&&<BookDirectory book={book} position={page?.position??book.position} search={chapterSearch} onClearSearch={()=>setChapterSearch('')} onSelect={start=>{void run(async()=>{await client.jumpTo(start);setNavOpen(false);});}}/>}{!book && <p className="side-empty">{t("导入后自动整理目录。")}</p>}</section><div className="sidebar-bottom"><div className="local-badge"><Icon name="leaf" size={15} />{t("保存在本机阅读存档")}</div><p>{t("读点与伙伴理解分别记录。")}<br />{t("随时导出，接着上次共读。")}</p><button className="text-action" style={{ marginTop: 13 }} onClick={() => setDetail('sessions')}><Icon name="history" size={12} />{t("查看阅读存档")}</button></div></aside>
      <section className={`reader-column${mobileTab !== 'reading' ? ' mobile-hidden' : ''}`} aria-label={t("原文阅读区")}><div className="reader-heading"><div><div className="reader-book-title"><h2>{book?.title ?? t("阅读原文")}</h2>{book&&<button className="text-action book-info-button" aria-haspopup="dialog" onClick={()=>setBookDetailsOpen(true)}>{t("书籍信息")}<Icon name="chevron" size={11} /></button>}</div><small>{t("按章连续阅读")}</small></div><div className="reading-options"><button className="icon-btn nav-toggle" aria-label={t("打开目录")} onClick={() => { setSidebarCollapsed(false); setNavOpen(!navOpen); }}><Icon name="folder" size={16} /></button><button className="icon-btn shelf-show" aria-label={t("展开书架与目录")} onClick={() => setSidebarCollapsed(false)}><Icon name="folder" size={16} /></button><button onClick={() => setFontSize(value => Math.max(15, value - 1))} aria-label={t("缩小原文字号")} disabled={fontSize <= 15}>A−</button><button onClick={() => setFontSize(value => Math.min(28, value + 1))} aria-label={t("放大原文字号")} disabled={fontSize >= 28}>A+</button></div></div>
      <details className="reading-status-panel"><summary>{t("阅读进度")}<span>{t("位置与伙伴理解")}<Icon name="chevron" size={12} /></span></summary><div className="reading-status"><div><span>{t("浏览位置")}</span><strong>{page?.chapterTitle ?? t("先选择一本书")}</strong><button className="text-action" disabled={!book} onClick={() => { setPositionDraft(String(client.getSnapshot().page?.position ?? 0)); setPositionOpen(true); }}>{t("调整阅读位置")}</button></div><div><span>{t("允许伙伴阅读的内容")}</span><strong>{knownChars ? page?.authorized ? t("当前章节已允许阅读") : t("已确认部分已读范围") : t("请先确认已读前文")}</strong><button className="text-action" disabled={!book} onClick={() => setRangeOpen(true)}>{t("补读前文")}</button></div><div><span>{snapshot.mode === 'offline' ? t("演示进度") : t("伙伴理解进度")}</span><strong>{page?.coverage?.status === 'complete' ? snapshot.mode === 'offline' ? t("当前获准正文演示已完成") : t("当前获准正文已理解") : page?.coverage?.allowedChars ? t("本章获准正文待理解 ") + number(page.coverage.missingChars) + t(" 字") : t("本章正文尚未获准阅读")}</strong><button className="text-action" onClick={() => setDetail('understanding')}>{t("查看伙伴理解")}</button></div></div></details>
      <article {...workbenchAutomationAttributes({...snapshot,error:localError||snapshot.error},!overlayOpen&&(!matchMedia('(max-width:760px)').matches||mobileTab==='reading'))} className="reader-paper" ref={sourcePaper} tabIndex={0} role="region" aria-label={t("原文滚动区")} aria-busy={snapshot.pageLoading||undefined}>{snapshot.pageLoading&&<p className="inline-note" role="status">{readerPage?t("正在载入章节，当前仍显示「{0}」",readerPage.chapterTitle):t("正在载入本章正文")}</p>}{readerPage ? <div className="paper-content" inert={!page} ref={sourceContent} style={{ fontSize }}>{!readerParagraphs.some(paragraph => paragraph.heading) && <h1 className="chapter-title">{readerPage.chapterTitle}</h1>}{readerParagraphs.map(paragraph => paragraph.heading ? <h1 className="chapter-title" key={paragraph.start}>{paragraph.text}</h1> : <p className={`reading-paragraph${noteParagraph === paragraph.start ? ' selected-for-note' : ''}`} key={paragraph.start}><span className="paragraph-text-action" data-reading-start={paragraph.start} data-reading-end={paragraph.end} role="button" tabIndex={0} aria-label={t("查看本段段评")} onClick={event => { if (event.detail > 1 || !window.getSelection()?.isCollapsed) return; openParagraph(paragraph.start); }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openParagraph(paragraph.start); } }}>{paragraph.text}</span>{notesFor(paragraph).length > 0 && <button className="paragraph-note-count has-notes" aria-label={t("查看本段段评，{0}条",notesFor(paragraph).length)} title={t("查看本段段评")} onClick={() => openParagraph(paragraph.start)}><span>{notesFor(paragraph).length}</span></button>}</p>)}<nav className="chapter-navigation" aria-label={t("章末导航")}><button className="btn btn-outline" disabled={!page || readerPage.previousChapterStart === undefined} onClick={() => void run(() => client.turnPage(-1))}>{t("上一章")}</button><button className="btn btn-outline" onClick={() => { setSidebarCollapsed(false); setNavOpen(true); }}>{t("目录")}</button><button className="btn btn-outline" disabled={!page || readerPage.nextChapterStart === undefined} onClick={() => void run(() => client.turnPage(1))}>{t("下一章")}</button></nav></div> : book ? <div className="reader-empty">{snapshot.pageLoading?t("正在载入本章正文"):t("本章正文尚未载入，请从目录重新选择章节。")}</div> : <EmptyReader onImport={() => setImportOpen(true)} onSettings={() => setSettingsOpen(true)} />}</article>
      <div className="reading-position-line" role="meter" aria-label={t("全书浏览位置")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={length ? Math.round((page?.position ?? 0) / length * 100) : 0}><span style={{width: `${length ? (page?.position ?? 0) / length * 100 : 0}%`}} /></div><div className="reader-controls"><div className="material-actions">{stopping ? <button className="btn btn-subtle btn-small" disabled><span className="busy-dot" />{t("正在收取回复并保存记录")}</button> : pauseRequested ? <button className="btn btn-subtle btn-small" disabled><Icon name="pause" size={13}/>{t("正在暂停…")}</button> : snapshot.following && !paused ? <button className="btn btn-primary btn-small" onClick={() => void pauseReading()}><Icon name="pause" size={13} />{t("暂停伴读")}</button> : <button className="btn btn-primary btn-small" disabled={pauseRequested || !book || !page || snapshot.pageLoading || snapshot.busyAction || stopping} onClick={beginFollowing}><Icon name="play" size={13} />{readingSession ? t("继续伴读") : t("开始伴读")}</button>}{activeSession && <button className="btn btn-small" disabled={stopping} onClick={() => void endReading()} title={t("结束本次共读并保存已有记录")}><Icon name="stop" size={13} />{t("结束本次共读")}</button>}</div></div></section>
      <aside className={`companion-column${mobileTab !== 'chat' ? ' mobile-hidden' : ''}`} aria-label={t("伙伴交流区")}><div className="companion-chat-pane" aria-hidden={!!selectedParagraph && !matchMedia('(max-width:760px)').matches} inert={!!selectedParagraph && !matchMedia('(max-width:760px)').matches}><header className="companion-header"><div className="companion-title-row"><button className="companion-id companion-profile-entry" onClick={() => setPartnerOpen(true)} aria-label={t("查看{0}的资料",partner?.name ?? t("阅读伙伴"))}><PartnerAvatar client={client} avatar={partner?.avatar} name={partner?.name ?? t("阅读伙伴")} /><span><h2>{partner?.name ?? t("阅读伙伴")}</h2><p>{partnerThinking?t("正在思考…"):stopping?t("正在结束共读"):paused?t("伴读已暂停"):snapshot.following?t("一起读书"):activeSession?.mode==='discussion'?t("交流中"):t("随时可以聊聊")}</p></span><Icon name="chevron" size={14} /></button></div><div className="quiet-control"><span><Icon name="quiet" size={14} />{t("安静模式")}<small style={{ marginLeft: 5 }}>{quiet ? t("不主动发言，可留段评") : t("允许主动发言和段评")}</small></span><button className="switch" role="switch" aria-label={t("安静模式")} title={t("关闭主动即时发言，仍可留下段评和回应明确提问")} aria-checked={quiet} onClick={() => void run(() => client.setQuiet(!quiet))}><span /></button></div></header>
      <div className="chat-session-selector"><span>{t("话题与交流")}</span><select aria-label={t("浏览话题与交流")} value={displayedConversation ?? ""} onChange={event => setHistoryConversation(event.target.value)}>{!conversations.length && <option value="">{t("尚无话题")}</option>}{conversations.map(conversation => <option key={conversation.id} value={conversation.id}>{conversation.id === activeConversation ? t("当前 · ") : t("历史 · ")}{conversation.title}</option>)}</select><button className="icon-btn" aria-label={t("重命名话题")} disabled={!displayedConversation || busy} onClick={() => { setConversationName(conversations.find(item => item.id === displayedConversation)?.title ?? ''); setRenameOpen(true); }}><Icon name="settings" size={13} /></button><button className="icon-btn" aria-label={t("新建对话")} title={t("新建独立对话，原有记录保留")} disabled={!book || busy} onClick={() => void run(async () => {await client.newDiscussion();setHistoryConversation('');})}><Icon name="plus" size={13} /></button></div>{previousConversation&&<div className="conversation-continuity"><button className="text-action" onClick={()=>setHistoryConversation(previousConversation.id)} aria-label={t("查看上一段交流")}>{t("接续自「")}{previousConversation.title}{t("」 · 查看上一段")}</button></div>}<div className="companion-conversation" ref={chatViewport.scroller} tabIndex={0} aria-label={t("交流记录")} aria-live="polite"><div className="conversation-intro">{snapshot.importedHistory ? snapshot.importedHistory.includes('功能检查') ? t("独立准备的理解 · 功能检查问答另存") : t("已载入历史材料 · 当前存档单独记录") : t("当前话题")}</div>{conversationMessages.hasEarlier&&<button className="chat-history-more text-action" disabled={conversationMessages.loading} onClick={()=>{chatViewport.pause();void conversationMessages.loadEarlier();}}>{conversationMessages.loading?t("正在读取历史交流…"):t("向上滚动查看更早消息")}</button>}{conversationMessages.error&&<p className="form-error" role="alert">{conversationMessages.error}<button className="text-action" onClick={()=>void conversationMessages.retry()}>{t("重试")}</button></p>}{!chats.length && !conversationStreams.length && <div className="chat-empty"><Icon name="chat" size={28} /><h3>{t("随时和伙伴聊聊")}</h3><p>{snapshot.mode === 'offline' ? t("开启界面演示后可试用翻章、段评和交流操作。演示使用固定技术回复，实际伴读需选择模型服务。") : t("确认阅读位置与已读范围后，可以开始伴读或直接提问。也可以在原文旁发表段评。")}</p></div>}{chats.map(chat => <ChatMessage key={chat.id} chat={chat} snapshot={snapshot} client={client} visible={chatVisible} onRecovery={decision=>void run(()=>performRecovery(client,decision))} onExpand={() => void run(() => client.expandReply(chat.id))} onReview={() => { setReviewChat(chat.id); setReviewNote(snapshot.ratings[chat.id]?.note ?? ''); }} />)}{!conversationMessages.detached&&conversationStreams.map(reply=><div className="chat-message assistant" key={reply.requestId}><div className="chat-meta"><PartnerMessageAuthor client={client} partners={app.state.partners} partnerId={reply.partnerId} /></div><small>{reply.state==='saving'?t("正在保存回应…"):reply.state==='incomplete'?t("回应尚未收全，已收到的内容保留"):t("正在回应…")}</small><MarkdownMessage text={reply.text} /></div>)}</div>{conversationMessages.retained&&<button className="chat-new-messages" onClick={returnToLatest}>{conversationMessages.hasNewer||conversationStreams.length?t("有新交流 · 查看最新"):t("返回最新交流")}</button>}{!conversationMessages.retained&&chatViewport.pending > 0 && <button className="chat-new-messages" onClick={chatViewport.latest}>{t("有")}{chatViewport.pending} {t("条新消息 · 查看最新")}</button>}
      <div className="composer-wrap">{displayedConversation && displayedConversation !== activeConversation && <p className="inline-note" style={{ marginBottom: 9 }}>{t("正在查看历史交流。发送消息会继续这个话题。")}</p>}{busy && <div style={{ display: 'flex', gap: 7, marginBottom: 10 }}><button className="btn btn-outline btn-small" disabled={paused || stopping} onClick={() => void pauseReading()}><Icon name="pause" size={12} />{t("暂停伴读")}</button><button className="btn btn-small" disabled={stopping} onClick={() => void endReading()}><Icon name="stop" size={12} />{t("结束本次共读")}</button></div>}{!stopping && book && readingSession && (paused || !snapshot.following) && <button className="btn btn-subtle btn-small" style={{ marginBottom: 10 }} disabled={pauseRequested || snapshot.pageLoading || snapshot.busyAction} onClick={beginFollowing}><Icon name="play" size={12} />{t("继续伴读")}</button>}<div className="composer"><textarea ref={composer} aria-label={t("和伙伴聊聊")} value={message} onChange={event => setMessage(event.target.value)} placeholder={book ? t("想说点什么，就在这里插话…") : t("先导入一本书，再开始交流…")} disabled={!book} rows={2} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} />{emojiOpen&&<EmojiPicker onSelect={insertEmoji} onClose={()=>setEmojiOpen(false)}/>}<div className="composer-bottom"><button type="button" className="icon-btn" disabled={!book} aria-label={t("插入表情")} aria-expanded={emojiOpen} onClick={()=>setEmojiOpen(value=>!value)}>☺</button><small className="keyboard-hint" role="status">{sendingMessageKeys.has(JSON.stringify([snapshot.sessionId,messageKey,message.trim()]))?t("正在发送…"):t("Enter 发送 · Shift + Enter 换行")}</small><button className="send-button" aria-label={t("发送消息")} disabled={!book || !message.trim() || snapshot.busyAction || stopping || sendingMessageKeys.has(JSON.stringify([snapshot.sessionId,messageKey,message.trim()]))} onClick={send}><Icon name="arrow" size={17} /></button></div></div><div className="companion-footnote"><button className="text-action" onClick={() => setExperienceOpen(true)}><Icon name="flag" size={12} />{t("记录阅读感受")}</button><button className="text-action" onClick={() => setDetail('process')}>{t("查看处理详情")}<Icon name="chevron" size={10} /></button></div></div></div>{selectedParagraph && !matchMedia('(max-width:760px)').matches && <ParagraphNotesPanel presentationVisible={manualWindowVisible&&snapshot.sourceOwner?.producerId===sourceProducer.current.id} inline key={selectedNoteKey} client={client} snapshot={snapshot} paragraph={selectedParagraph} {...noteDraftProps} comments={selectedNotes.items.filter(comment=>comment.anchor.start<selectedParagraph.end&&comment.anchor.end>selectedParagraph.start)} error={selectedNotes.error} loading={selectedNotes.loading} onClose={closeNotes} onConversation={(id,chatId) => { if (id) setHistoryConversation(id); if(chatId)setFocusedPublication(chatId); setMobileTab('chat'); }} />}</aside>
    </main>
    {localNotice && <Notice text={localNotice} onClose={() => setLocalNotice('')} />}
    {importOpen && <ImportDialog onClose={() => setImportOpen(false)} onFile={importFile} onText={(title, text) => client.importTxt(title, text)} />}
    {bookDetailsOpen && book && <BookDetailsPanel key={book.id} book={book} onGetProjectLocations={()=>client.getBookProjectLocations()} onSetProjectDirectory={directory=>client.setBookProjectRootDirectory(directory)} backgroundModelReady={snapshot.backgroundModelReady} onRecognizeDirectory={async useModel=>{await client.recognizeBookDirectory(book.id,useModel);}} onClose={()=>setBookDetailsOpen(false)} onRename={title=>client.renameBook(book.id,title)} onExtend={raw=>client.extendBookSource(book.id,raw)} onExtendFile={client.extendBookSourceFile?file=>client.extendBookSourceFile!(book.id,file):undefined} />}
    {settingsOpen && <SettingsPanel language={language} onLanguageChange={async value=>{await client.setLanguage(value,true);setInterfaceLanguage(value);void window.yixuDesktop?.setLanguage?.(value).catch(()=>{});}} developerContent={<section aria-label={t("开发者选项")}><h3>{t("自动伴读")}</h3>{!snapshot.modelReady&&<div className="callout amber">{t("当前伙伴需要先绑定可用的模型。")}<button className="text-action" onClick={()=>{setSettingsOpen(false);setPartnerOpen(true);}}>{t("前往伙伴设置")}</button></div>}<p className="form-hint">{t("按设定速度自动翻阅当前书籍，伙伴同步跟读和整理。可设置终止章节与累计用量上限，并在后台运行。")}</p><p className="form-hint">{t("点击开始后才会运行并产生模型用量。停止后不再自动翻页，已发出的请求继续收取和保存。")}</p><AutoReadingControls client={client} snapshot={snapshot} onStart={async settings=>{await startAutomatic(settings);if(client.getSnapshot().autoReading?.phase==='reading')setSettingsOpen(false);}} onError={setLocalError}/></section>} developerMode={developerMode} initial={{ thinking:snapshot.settings.thinking,temperature:snapshot.settings.temperature??undefined,topP:snapshot.settings.topP??undefined, serviceId: snapshot.settings.serviceId, mode: snapshot.mode, endpoint: snapshot.settings.model === 'offline-ui-rehearsal' ? '' : snapshot.settings.baseUrl, model: snapshot.settings.model === 'offline-ui-rehearsal' ? 'gpt-6-luna' : snapshot.settings.model, effort: snapshot.settings.effort, apiKey: '', tokenLimit: snapshot.settings.tokenLimit, maxOutput: snapshot.settings.maxOutput, contextLimit: snapshot.settings.contextLimit, pageChars: snapshot.settings.pageChars }} secretPresent={snapshot.hasKey} modelReady={snapshot.backgroundModelReady??snapshot.modelReady} services={snapshot.services} onRefreshServices={() => client.refreshServices()} onUseService={async id => { const selected=await client.useService(id),next=client.getSnapshot(); return { thinking:selected.thinking,temperature:selected.temperature,topP:selected.topP,serviceId: selected.id, mode: next.mode, endpoint: selected.baseUrl, model: selected.model, effort: selected.effort ?? next.settings.effort, apiKey: '', tokenLimit: next.settings.tokenLimit, maxOutput: selected.maxOutput ?? next.settings.maxOutput, contextLimit: selected.contextLimit ?? next.settings.contextLimit, pageChars: next.settings.pageChars }; }} onSave={saveSettings} onClose={() => { client.discardServiceSelection(); setSettingsOpen(false); }} />}
    {detail && <DetailPanel client={client} snapshot={snapshot} tab={detail} onTab={setDetail} onClose={() => setDetail(undefined)} onAction={action => void run(action)} onExport={backup => void run(() => download(backup))} onSettings={() => { setDetail(undefined); setSettingsOpen(true); }} />}
    {positionOpen && <Dialog title={t("选择阅读位置")} onClose={() => setPositionOpen(false)}><p className="callout">{t("选择章节定位，章内位置可在下方精确调整。定位只改变浏览位置。跟随阅读开启时接上实际可见正文，跳过的空白区间仍需你明确确认。")}</p><label className="form-field"><span>{t("跳到章节")}</span><select value={positionChapter} onChange={event => setPositionDraft(String(book?.chapters.find(item => item.index === Number(event.target.value))?.start ?? 0))}>{book?.chapters.map(chapter => <option key={chapter.index} value={chapter.index}>{chapter.title}</option>)}</select></label><details className="exact-range"><summary>{t("精确到章内文字位置")}</summary><label className="form-field"><span>{t("原文字符位置 · 0—")}{number(Math.max(0, length - 1))}</span><input type="number" value={positionDraft} min={0} max={Math.max(0, length - 1)} onChange={event => setPositionDraft(event.target.value)} /></label></details><button className="btn btn-primary" onClick={() => { const target = Number(positionDraft); if (!Number.isSafeInteger(target) || target < 0 || target >= length) { setLocalError(t("请输入原文范围内的整数位置。")); return; } void run(async () => { await client.jumpTo(target); setPositionOpen(false); }); }}>{t("前往这个位置")}<Icon name="arrow" size={15} /></button></Dialog>}
    {reviewChat && <Dialog title={t("回复评价")} onClose={() => setReviewChat(undefined)}><div className="review-summary">{ratingOptions.map(option => <button key={option.value} className={`evaluation-btn${snapshot.ratings[reviewChat]?.values.includes(option.value) ? ' selected' : ''}`} aria-pressed={snapshot.ratings[reviewChat]?.values.includes(option.value) ?? false} onClick={() => client.markReply(reviewChat, option.value)}><Icon name={option.icon} size={13} />{option.label}</button>)}<button className={`evaluation-btn${snapshot.ratings[reviewChat]?.helpful ? ' selected' : ''}`} onClick={() => client.markHelpful(reviewChat)}>{t("有帮助")}</button></div><label className="form-field"><span>{t("补充说明（选填）")}</span><textarea rows={4} value={reviewNote} onChange={event => setReviewNote(event.target.value)} placeholder={t("记下实际感受或需要核对的地方")} /></label><button className="btn btn-primary" onClick={() => { client.markNote(reviewNote, reviewChat); setReviewChat(undefined); setLocalNotice(t("感受与说明已记入阅读记录。")); }}>{t("保存备注")}<Icon name="check" size={14} /></button></Dialog>}
    {partnerOpen && <PartnerPanel client={client} snapshot={snapshot} onClose={() => setPartnerOpen(false)} />}
    {selectedParagraph && matchMedia('(max-width:760px)').matches && <ParagraphNotesPanel presentationVisible={manualWindowVisible&&snapshot.sourceOwner?.producerId===sourceProducer.current.id} key={selectedNoteKey} client={client} snapshot={snapshot} paragraph={selectedParagraph} {...noteDraftProps} comments={selectedNotes.items.filter(comment=>comment.anchor.start<selectedParagraph.end&&comment.anchor.end>selectedParagraph.start)} error={selectedNotes.error} loading={selectedNotes.loading} onClose={closeNotes} onConversation={(id,chatId) => { if (id) setHistoryConversation(id); if(chatId)setFocusedPublication(chatId); setMobileTab('chat'); }} />}
    {rangeOpen && <ReadingRangePanel client={client} snapshot={snapshot} onClose={() => setRangeOpen(false)} />}
    {experienceOpen && <Dialog title={t("阅读反馈")} onClose={() => setExperienceOpen(false)}><p className="callout">{t("可以记录某个时刻、一次等待，或整体相处感受。备注保存在本机的阅读记录里。")}</p><label className="form-field"><span>{t("补充说明")}</span><textarea rows={5} value={experienceNote} onChange={event => setExperienceNote(event.target.value)} placeholder={t("按自己的感受记录即可")} /></label><button className="btn btn-primary" disabled={!experienceNote.trim()} onClick={() => { client.markNote(experienceNote.trim()); setExperienceNote(''); setExperienceOpen(false); setLocalNotice(t("补充说明已保存。")); }}>{t("保存备注")}<Icon name="check" size={14} /></button></Dialog>}
    {renameOpen && <Dialog title={t("重命名话题")} onClose={() => setRenameOpen(false)}><label className="form-field"><span>{t("话题名称")}</span><input value={conversationName} maxLength={300} onChange={event => setConversationName(event.target.value)} /></label><p className="form-hint">{t("自己起的名称会保留，原有阅读范围与交流内容分别保存。")}</p><button className="btn btn-primary" disabled={!conversationName.trim()} onClick={() => void run(async () => { if (displayedConversation) await client.renameConversation(displayedConversation, conversationName); setRenameOpen(false); })}>{t("保存名称")}</button></Dialog>}
  </div>;
}

function ChatMessage({ chat, snapshot, client, visible, onReview, onRecovery, onExpand }: { chat: ChatSummary; snapshot: WorkbenchSnapshot; client: WorkbenchClient; visible: boolean; onReview: () => void; onRecovery: (decision:ReadingRecoveryCapability) => void; onExpand: () => void }) {
  const rating = snapshot.ratings[chat.id], timing = snapshot.timings[chat.id];
  const [reacting,setReacting]=useState(false),[reactionError,setReactionError]=useState('');
  const reactions=chat.emojiReactions;
  const source=chat.expressionAnchor??(chat.readingReaction?chat.formationRanges?.at(-1):undefined),sourceBook=snapshot.app.state.books.find(book=>book.id===chat.bookId),sourceChapter=source&&sourceBook?.chapters.find(chapter=>chapter.start<=source.start&&chapter.end>source.start);
  const toggleReaction=async(emoji:string,active:boolean)=>{if(reacting)return;setReacting(true);setReactionError('');try{await client.setMessageEmojiReaction(chat.bookId,chat.id,emoji,active);}catch(error){setReactionError(readableError(error instanceof Error?error.message:String(error)));}finally{setReacting(false);}};

  const recoveries=snapshot.app.activities.filter(activity=>shouldShowCurrentRecovery(activity,snapshot.app)).map(availableRecovery).filter(decision=>decision?.target?.kind==='question'&&decision.target.questionId===chat.id);
  const historicalCheck = snapshot.importedHistory?.includes('功能检查') && chat.createdAt < (snapshot.sessions.find(item => item.id === snapshot.sessionId)?.createdAt ?? 0);
  return <article className={`chat-message ${chat.role}`} data-chat-id={chat.id}><div className="chat-meta">{chat.role === 'assistant' ? <PartnerMessageAuthor client={client} partners={snapshot.app.state.partners} partnerId={chat.partnerId} /> : <span>{t("我")}</span>}{historicalCheck && <small>{t("功能检查（历史）")}</small>}<time dateTime={new Date(chat.createdAt).toISOString()}>{time(chat.createdAt)}</time>{source&&sourceChapter&&<button className="text-action" title={t("查看这条发言对应的原文")} onClick={()=>void client.jumpTo(source.start).catch(error=>setReactionError(readableError(String(error))))}>{sourceChapter.title}</button>}</div><div className={`chat-body${isEmojiOnlyText(chat.text)?' emoji-only-text':''}`}>{chat.role === 'assistant' && chat.text.trim() ? <ReplyVisibility chatId={chat.id} client={client} text={chat.text} visible={visible} confirmed={timing?.visibleAt !== undefined} message={chat} /> : <MarkdownMessage text={chat.text} />}</div><MessageEmojiReactions reactions={reactions} disabled={reacting} actorNames={Object.fromEntries(snapshot.app.state.partners.map(item=>[item.id,item.name]))} onToggle={(emoji,active)=>void toggleReaction(emoji,active)}/>{reactionError&&<p className="form-error" role="alert">{reactionError}</p>}{chat.role === 'user' && ['pending', 'failed', 'stopped'].includes(chat.delivery ?? '') && <div className="reply-delivery">{chat.delivery === 'pending' ? t("等待伙伴回复，翻页不会取消问题") : chat.delivery === 'stopped' ? t("本次回复已停止，原问题仍保留") : t("回复未完成，可查看处理详情")}{chat.delivery !== 'pending' && recoveries.map(decision=><button key={JSON.stringify(decision!.target)} className="text-action" onClick={()=>onRecovery(decision!)}>{recoveryActionLabel(decision!)}</button>)}</div>}{chat.role === 'assistant' && <div className="chat-evaluations">{chat.expansionOffered && <button className="text-action" onClick={onExpand}>{t("展开聊聊")}</button>}<button className={`text-action${rating ? ' noted' : ''}`} title={timing?.firstVisibleMs !== undefined ? t("首个可见回应 {0}，详细过程可在阅读记录查看",duration(timing.firstVisibleMs)) : undefined} onClick={onReview}><Icon name="flag" size={11} />{rating ? t("查看感受备注") : t("记下感受")}</button></div>}</article>;
}

function PublishedViewPanel({snapshot}:{snapshot:WorkbenchSnapshot}){
  const progress=snapshot.app.readingViews?.find(v=>v.bookId===snapshot.book?.id)?.progress;
  if(!progress)return null;
  const labels={get overview(){return t("已读故事概览");},get current(){return t("当前状态");},get topic(){return t("相关主题");},get arc(){return t("故事线");}};
  const gap=progress.uncheckedRanges.reduce((n,r)=>n+r.end-r.start,0);
  return <section className="memory-section"><h3>{t("阅读概要")}</h3>{!progress.views.length&&<p>{t("尚未形成概要。已有完整理解仍可展开查看；当前交流可以继续。")}</p>}{progress.views.map(v=><details key={v.id}><summary>{labels[v.kind]} · {v.key}</summary><p style={{whiteSpace:'pre-wrap'}}>{v.text}</p>{v.lagging&&<p>{t("已有新增理解或认识版本等待概要核对；当前展示原发布版本，不代表这些变化已经整理进概要。")}</p>}<small>{t("已核对原文")}{v.ranges.reduce((n,r)=>n+r.end-r.start,0).toLocaleString(locale())} {t("字 ·")}{v.chatIds.length} {t("条交流 ·")}{v.adoptedMemories===undefined?t("旧概要未记录采用版本"):t("采用 {0} 份完整理解",v.adoptedMemories.length)}</small>{!!v.adoptedMemories?.length&&<details><summary>{t("处理来源与阅读阶段")}</summary>{v.adoptedMemories.map(m=><p key={m.id}>{m.title??t("完整理解")}<br/>{t("形成范围：")}{m.formationRanges.length?m.formationRanges.map(r=>`${r.start}–${r.end}`).join('、'):t("原记录未注明")}</p>)}</details>}</details>)}{gap>0&&<p>{gap.toLocaleString(locale())} {t("字已读原文尚未记录概要的原文核对范围；已采用的完整理解与其形成阶段分别列出。")}</p>}{progress.unabsorbedChatIds.length>0&&<p>{t("概要未直接选用的交流：")}{progress.unabsorbedChatIds.length} {t("条。")}</p>}{progress.maintenance.map(j=><p key={j.id}>{j.status==='blocked'?t("后台整理未完成"):j.status==='running'?t("正在整理伙伴理解"):t("等待后台整理")}{j.viewTargets?.length?t(" · 待更新概要：")+j.targetLabels?.map(target=>labels[target.kind]+(target.key?' · '+target.key:'')).join('、'):''}{j.reason?'：'+readableError(j.reason):''}</p>)}</section>;
}

function SessionArchives({client,snapshot,onAction}:{client:WorkbenchClient;snapshot:WorkbenchSnapshot;onAction:(action:()=>Promise<unknown>)=>void}){
  const [exporting,setExporting]=useState(''),active=snapshot.sessions.filter(session=>!session.archivedAt),archived=snapshot.sessions.filter(session=>session.archivedAt),historical=snapshot.sources.filter(source=>source.historical);
  const exportFile=(id:string,load:()=>Promise<WorkbenchExportFile>)=>onAction(async()=>{setExporting(id);try{await downloadJSON(load);}finally{setExporting('');}});
  return <><div className="callout">{t("当前存档独立保存读点、理解和交流。归档旧存档后，仅在下方历史归档保留元信息与完整备份导出，不会自动打开或接续旧任务。")}</div><div className="archive-actions"><button className="btn btn-outline" onClick={()=>onAction(()=>client.createSession(snapshot.mode))}><Icon name="plus" size={15}/>{t("新建")}{snapshot.mode==='live'?t("AI共读"):t("界面演示")}{t("存档")}</button><button className="btn btn-small" disabled={snapshot.busyAction||!active.some(session=>session.id!==snapshot.sessionId)} onClick={()=>onAction(()=>client.archiveOtherSessions())}>{t("归档其它存档")}</button></div>
  {active.map(session=><div className="archive-session-row" key={session.id}><button className={`book-item${session.id===snapshot.sessionId?' selected':''}`} onClick={()=>onAction(()=>client.openSession(session.id))}><Icon name="history" size={17}/><div><strong>{session.title}</strong><small>{new Date(session.createdAt).toLocaleString(locale())} · {session.mode==='live'?t("真实模型"):t("界面演示")}{session.id===snapshot.sessionId?t(" · 当前"):''}</small></div></button>{session.id!==snapshot.sessionId&&<button className="btn btn-small" disabled={snapshot.busyAction} onClick={()=>onAction(()=>client.archiveSession(session.id))}>{t("归档")}</button>}</div>)}
  <details className="archive-history" onToggle={event=>{if(event.currentTarget.open&&!snapshot.historicalSourcesLoaded)onAction(()=>client.loadHistoricalSources());}}><summary>{t("历史归档（")}{archived.length} {t("份存档）")}</summary><p className="form-hint">{t("归档资料仅供查阅元信息与下载，不会进入当前理解、阅读队列或模型请求。")}</p>
  {archived.map(session=><article className="archive-record" key={session.id}><div><strong>{session.title}</strong><small>{t("建立于")}{new Date(session.createdAt).toLocaleString(locale())} · {session.mode==='live'?t("真实模型"):t("界面演示")}<br/>{t("归档于")}{new Date(session.archivedAt!).toLocaleString(locale())}</small></div><button className="btn btn-small" disabled={!!exporting} onClick={()=>exportFile(session.id,()=>client.exportArchivedBackup(session.id))}>{exporting===session.id?t("正在导出…"):t("导出归档备份")}</button></article>)}
  {!snapshot.historicalSourcesLoaded?<p>{t("正在读取历史资料清单…")}</p>:historical.length>0&&<><h3>{t("历史示例资料")}</h3>{historical.map(source=><article className="archive-record" key={source.id}><div><strong>{source.title}</strong><small>{source.description??(source.readThrough?t("历史读点 {0} 章",source.readThrough):t("历史共读资料"))}</small></div><button className="btn btn-small" disabled={source.available===false||!!exporting} onClick={()=>exportFile(source.id,()=>client.exportHistoricalSource(source.id))}>{exporting===source.id?t("正在导出…"):t("导出历史资料")}</button></article>)}</>}
  </details></>;
}

function DetailPanel({ client, snapshot, tab, onTab, onClose, onAction, onExport, onSettings }: { client: WorkbenchClient; snapshot: WorkbenchSnapshot; tab: DetailTab; onTab: (tab: DetailTab) => void; onClose: () => void; onAction: (action: () => Promise<unknown>) => void; onExport: (backup: boolean) => void; onSettings: () => void }) {
  const usage = snapshot.app.state.usage;
  const tokens = usageTokens(usage).tokens;
  const unknown = usage.filter(item => item.status === 'unknown').length;
  const flow = snapshot.app.readingFlow;




  const tabs: { value: DetailTab; label: string }[] = [{ value: 'understanding', get label(){return t("伙伴理解");} }, { value: 'process', get label(){return t("处理详情");} }, { value: 'budget', get label(){return t("用量预算");} }, { value: 'sessions', get label(){return t("阅读存档");} }];
  return <Drawer title={t("阅读记录")} subtitle={t("查看伙伴理解、运行状态、用量和阅读存档")} onClose={onClose} tabs={<nav className="drawer-tabs" aria-label={t("记录内容")}>{tabs.map(item => <button key={item.value} className={tab === item.value ? 'selected' : ''} onClick={() => onTab(item.value)}>{item.label}</button>)}</nav>} footer={<><button className="btn btn-small" onClick={() => onExport(true)}><Icon name="export" size={14} />{t("导出备份")}</button><button className="btn btn-primary btn-small" onClick={() => onExport(false)}><Icon name="export" size={14} />{t("导出阅读记录")}</button></>}>
    {tab === 'understanding' && <><PublishedViewPanel snapshot={snapshot} /><UnderstandingPanel client={client} snapshot={snapshot} /></>}
    {tab === 'process' && <><ActivityPanel app={snapshot.app} bookId={snapshot.book?.id} following={snapshot.following} detail actionBusy={snapshot.busyAction} onRecovery={decision=>onAction(()=>performRecovery(client,decision))} onMaintenanceAction={(jobId,action)=>action==="dismiss"?client.dismissMaintenance(jobId):client.restoreMaintenance(jobId)} />{!!snapshot.app.readingFlow?.deferredExpressions && <div className="callout"><strong>{t("等待合适时机")}</strong><p>{t("有")}{snapshot.app.readingFlow.deferredExpressions} {t("条已准备的反应等待发表。相关条件改变后会重新判断，已过时或超出许可的内容会停止交付；这项判断复用原结果。")}</p></div>}<ProcessEvents snapshot={snapshot} client={client} /></>}
    {tab === 'budget' && <>{snapshot.mode === 'offline' && <div className="callout">{t("本存档外部模型调用为零。下方包含导入的历史用量和当前固定回应的零用量记录。")}</div>}<div className="detail-stat-grid"><div className="detail-stat"><strong>{formatTokens(tokens)}</strong><span>{t("累计 token（含预留）")}</span></div><div className="detail-stat"><strong>{usage.length}</strong><span>{t("模型请求记录")}</span></div></div><h3 style={{ fontSize: 13 }}>{t("累计上限")}{formatTokens(snapshot.settings.tokenLimit)} token</h3><div className="budget-bar"><span style={{ width: `${snapshot.settings.tokenLimit ? tokens / snapshot.settings.tokenLimit * 100 : 0}%` }} /></div><p className="form-hint">{t("实际费用以模型服务商的账单为准。")}</p>{unknown > 0 && <details className="exact-range"><summary>{t("历史用量说明")}</summary><p className="form-hint">{unknown} {t("笔历史请求尚未获得最终用量，暂按预留计入；原记录可在处理详情中查看。")}</p></details>}<div className="form-section" style={{ marginTop: 25 }}><h3>{t("当前模型服务")}</h3><p>{snapshot.settings.model} / {snapshot.settings.effort}<br />{snapshot.settings.baseUrl || t("请在模型设置中填写服务地址")}<br />{t("单次输出上限")}{formatTokens(snapshot.settings.maxOutput)} token</p></div><button className="btn btn-outline" onClick={onSettings}><Icon name="settings" size={15} />{t("调整模型设置")}</button></>}

    {tab === 'sessions' && <SessionArchives client={client} snapshot={snapshot} onAction={onAction} /> }
  </Drawer>;
}
