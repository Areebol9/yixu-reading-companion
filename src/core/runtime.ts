import { ReadingEngine } from './engine.ts';
import { recoverInterruptedState } from './startup.ts';
import { initialState } from './state.ts';
import {prepareMemoryRecovery} from './memory-recovery.ts';
import type { ModelPort, Range, Store } from './types.ts';

type HostMethod = 'readingSources' | 'startCapture' | 'stopCapture' | 'readingStatus' | 'reaction' | 'startVoice' | 'stopVoice' | 'cancelVoice';
export type RuntimeHost = { available: boolean; request<T = unknown>(method: HostMethod, payload?: unknown): Promise<T> };
type Anchor = { bookId: string; sessionId: string; generation: number; token: string };
type CaptureAnchor = Anchor & { sourceId: string };
type VoiceAnchor = Anchor & { span: Range; conversationId?: string };
export type RuntimeUIEvent =
  | { kind: 'error' | 'notice'; text: string }
  | { kind: 'keyboard'; visible: boolean }
  | { kind: 'openConversation'; bookId: string; sessionId: string; generation: number }
  | { kind: 'draft'; bookId: string; conversationId: string; text: string };

// Shared startup for UI and future native runtimes. Storage and model transport are injected.
export async function restoreReadingEngine(store: Store, model: ModelPort) {
  const loaded=await store.load(),state=loaded??initialState();
  await prepareMemoryRecovery(state,store);
  const recovery = recoverInterruptedState(state);
  if (!loaded||recovery.changed) await store.save(state);
  return { engine: new ReadingEngine(state, store, model), recovery };
}

// Owns the reading scene and native lifecycle. UI subscriptions only render state;
// removing a screen does not stop observation, lose a voice result, or revoke its anchor.
export class ReadingRuntime {
  readonly engine: ReadingEngine;
  readonly host: RuntimeHost;
  recording = false;
  voiceDraft = '';
  private captureOpening?:AbortController;
  get captureStarting():boolean {return !!this.captureOpening;}
  private capture?: CaptureAnchor;
  private voice?: VoiceAnchor;
  private voiceStarting = false;
  private listeners = new Set<() => void>();
  private uiEvents: RuntimeUIEvent[] = [];
  private lastStatus = '';
  private disposed = false;
  private unsubscribe: () => void;
  get voiceActive(): boolean { return !!this.voice; }
  constructor(engine: ReadingEngine, host: RuntimeHost) {
    this.engine = engine; this.host = host;
    this.unsubscribe = engine.subscribe(() => this.sync());
    engine.onReaction = text => {
      const capture = this.capture;
      if (capture && this.live(capture)) void this.host.request('reaction', { captureToken: capture.token, text }).catch(e => this.reportError(e));
    };
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit(): void { if (!this.disposed) this.listeners.forEach(listener => listener()); }
  takeUIEvents(): RuntimeUIEvent[] {
    return this.uiEvents.splice(0).filter(event => event.kind !== 'openConversation' ||
      this.engine.session?.active && this.engine.session.bookId === event.bookId && this.engine.session.id === event.sessionId && this.engine.session.generation === event.generation);
  }
  private post(event: RuntimeUIEvent): void {
    if (this.disposed) return;
    // Navigation/status events can be superseded; unsent voice text must be retained.
    if (event.kind !== 'draft') this.uiEvents = this.uiEvents.filter(e => e.kind !== event.kind);
    this.uiEvents.push(event); this.emit();
  }
  reportError(error: unknown): void {
    if ((error as Error)?.name !== 'AbortError') this.post({ kind: 'error', text: (error as Error)?.message || '设备能力暂不可用' });
  }
  private live(anchor: Anchor): boolean {
    const current = this.engine.session;
    return !this.disposed && !!current?.active && current.bookId === anchor.bookId && current.id === anchor.sessionId && current.generation === anchor.generation;
  }
  private requireHost(): void { if (this.disposed) throw new DOMException('运行已结束', 'AbortError'); if (!this.host.available) throw new Error('此功能需要原生客户端'); }
  private sync(): void {
    const voice = this.voice, capture = this.capture;
    if (voice && !this.live(voice)) {
      this.voice = undefined; this.recording = false; this.voiceDraft = '';
      void this.host.request('cancelVoice', { token: voice.token }).catch(e => this.reportError(e));
    }
    if (capture && !this.live(capture)) {
      this.capture = undefined; this.lastStatus = '';
      void this.host.request('stopCapture', { captureToken: capture.token }).catch(e => this.reportError(e));
    }
    if (this.capture && this.engine.session?.observing) {
      const value = { captureToken: this.capture.token, text: this.engine.status, ready: this.engine.session.prepared && !/校正|对应|未准备|失败|暂停/.test(this.engine.status) };
      const key = JSON.stringify(value);
      if (key !== this.lastStatus) { this.lastStatus = key; void this.host.request('readingStatus', value).catch(e => this.reportError(e)); }
    }
    this.emit();
  }
  async startCapture(bookId: string, sourceId: string): Promise<void> {
    this.requireHost();
    if (this.captureStarting) return;
    if (this.voice || this.voiceStarting) throw new Error('请先结束当前语音，再开启屏幕跟随');
    const opening=new AbortController();this.captureOpening=opening;this.emit();
    let anchor: CaptureAnchor | undefined;
    try {
      await this.engine.startReading(bookId,opening.signal);
      opening.signal.throwIfAborted();
      const current = this.engine.session!, generation = current?.generation;
      if (!current?.active || current !== this.engine.session || current.generation !== generation || current.bookId !== bookId) throw new DOMException('共读已切换', 'AbortError');
      if (this.capture && this.capture.sourceId !== sourceId) {
        const old=this.capture;this.capture=undefined;this.lastStatus='';
        this.engine.observing(false);this.engine.sourceActive(false);
        await this.host.request('stopCapture',{captureToken:old.token});
      }
      opening.signal.throwIfAborted();
      if (!current.active || current !== this.engine.session || current.generation !== generation) throw new DOMException('共读已切换', 'AbortError');
      anchor = this.capture ?? { bookId, sessionId: current.id, generation: current.generation, token: crypto.randomUUID(), sourceId };
      this.capture = anchor;
      const sources = await this.host.request<{ id: string; installed: boolean }[]>('readingSources');
      if (this.capture !== anchor || !this.live(anchor)) throw new DOMException('屏幕跟随已取消', 'AbortError');
      if (!sources.some(s => s.id === sourceId && s.installed)) throw new Error('请先选择已安装的阅读应用');
      await this.host.request('startCapture', { sourceId, title: this.engine.book(bookId).title, captureToken: anchor.token });
      if (this.capture !== anchor || !this.live(anchor)) throw new DOMException('屏幕跟随已取消', 'AbortError');
      this.engine.observing(true);
    } catch (error) {
      const cancelled = anchor && (this.capture !== anchor || !this.live(anchor));
      if (anchor && this.capture === anchor) {
        this.capture = undefined; this.engine.observing(false);
        await this.host.request('stopCapture', { captureToken: anchor.token }).catch(e => this.reportError(e));
      }
      if (cancelled) throw new DOMException('屏幕跟随已取消', 'AbortError');
      throw error;
    } finally { if(this.captureOpening===opening)this.captureOpening=undefined;this.emit(); }
  }
  async stopCapture(): Promise<void> {
    this.captureOpening?.abort(new DOMException('屏幕跟随已取消','AbortError'));this.captureOpening=undefined;
    const anchor = this.capture; this.capture = undefined; this.lastStatus = '';
    this.engine.observing(false); this.engine.sourceActive(false);
    if (anchor) await this.host.request('stopCapture', { captureToken: anchor.token });
  }
  async selectReadingSource(bookId: string, sourceId: string): Promise<void> {
    this.requireHost();
    if (this.captureStarting) throw new Error('请先完成或取消当前采集确认');
    const sources = await this.host.request<{ id: string; installed: boolean }[]>('readingSources');
    if (!sources.some(s => s.id === sourceId && s.installed)) throw new Error('所选阅读应用不可用');
    if (this.capture || this.engine.session?.observing) await this.stopCapture();
    this.engine.book(bookId).readingSourceId = sourceId; await this.engine.persist();
  }
  async startOrSendVoice(bookId: string, conversationId?: string): Promise<void> {
    this.requireHost();
    if (this.voiceStarting) return;
    if (this.voice) { await this.host.request('stopVoice', { token: this.voice.token }); this.recording = false; this.emit(); return; }
    if (this.captureStarting) throw new Error('请先完成或取消屏幕采集确认');
    this.voiceStarting = true;
    try {
      if (!this.engine.session?.active || this.engine.session.bookId !== bookId) {
        const opening = this.engine.start(bookId, conversationId), session = this.engine.session!, generation = session?.generation;
        await opening;
        if (!session?.active || session !== this.engine.session || generation !== session.generation) throw new DOMException('共读已切换', 'AbortError');
      }
      const current = this.engine.session!, book = this.engine.book(bookId);
      const known = book.known.find(r => r.start < book.position && r.end >= book.position);
      if (!known) throw new Error('请先确认阅读位置');
      if (!current.active || current.bookId !== bookId) throw new DOMException('共读已切换', 'AbortError');
      const anchor: VoiceAnchor = { bookId, sessionId: current.id, generation: current.generation, span: { start: Math.max(known.start, book.position - 2000), end: book.position }, token: crypto.randomUUID(), conversationId };
      this.voice = anchor; this.recording = true; this.voiceDraft = ''; this.emit();
      try { await this.host.request('startVoice', { token: anchor.token }); }
      catch (error) { if (this.voice === anchor) { this.voice = undefined; this.recording = false; this.emit(); throw error; } }
    } finally { this.voiceStarting = false; }
  }
  async cancelVoice(): Promise<void> {
    const anchor = this.voice; this.voice = undefined; this.recording = false; this.voiceDraft = ''; this.emit();
    if (anchor) await this.host.request('cancelVoice', { token: anchor.token });
  }
  async receive(name: string, payload: unknown): Promise<void> {
    if (this.disposed) return;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('设备事件格式无效');
    const p = payload as Record<string, unknown>;
    if (name === 'network') { if (typeof p.online === 'boolean') this.engine.setNetworkAvailable(p.online); return; }
    if (name === 'keyboard') { if (typeof p.visible === 'boolean') this.post({ kind: 'keyboard', visible: p.visible }); return; }
    if (name === 'error') { this.reportError(new Error(typeof p.message === 'string' ? p.message : '设备能力暂不可用')); return; }
    if (['observation', 'source', 'stop', 'quiet', 'captureStopped', 'openConversation'].includes(name)) {
      const anchor = this.capture;
      if (!anchor || !this.live(anchor) || p.captureToken !== anchor.token || p.sourceId !== anchor.sourceId) return;
      if (name === 'observation') {
        if (typeof p.text !== 'string' || p.text.length > 16000 || p.kind !== undefined && p.kind !== 'body' && p.kind !== 'comment') throw new Error('阅读事件内容无效');
        if (p.coverage !== undefined && p.coverage !== 'fragments' && p.coverage !== 'continuous-page') throw new Error('页面覆盖信息无效');
        await this.engine.observe(anchor.bookId, p.text, p.kind as 'body' | 'comment' | undefined, p.coverage as 'fragments' | 'continuous-page' | undefined);
      }
      if (name === 'source' && typeof p.active === 'boolean') this.engine.sourceActive(p.active);
      if (name === 'stop') this.engine.stop();
      if (name === 'quiet') this.engine.quiet(!this.engine.session?.quiet);
      if (name === 'openConversation') this.post({ kind: 'openConversation', bookId: anchor.bookId, sessionId: anchor.sessionId, generation: anchor.generation });
      if (name === 'captureStopped') {
        this.capture = undefined; this.lastStatus = ''; this.engine.observing(false);
        this.engine.status = '屏幕跟随已停止，已有资料仍可讨论'; this.engine.emit();
      }
      return;
    }
    const anchor = this.voice;
    if (!anchor || !this.live(anchor) || p.token !== anchor.token) return;
    if (name === 'voiceDraft') {
      this.recording = false; this.voiceDraft = typeof p.text === 'string' ? p.text : '';
      if (!this.voiceDraft) {
        this.voice = undefined; void this.host.request('cancelVoice', { token: anchor.token }).catch(e => this.reportError(e));
        this.post({ kind: 'notice', text: '未识别到可发送的语音内容' });
      }
      this.emit();
    }
    if (name === 'voiceError') {
      this.voice = undefined; this.recording = false; this.voiceDraft = ''; this.emit();
      this.reportError(new Error(typeof p.message === 'string' ? p.message : '语音识别暂不可用'));
    }
    if (name === 'voice') {
      this.voice = undefined; this.recording = false; this.voiceDraft = ''; this.emit();
      if (typeof p.text !== 'string' || !p.text.trim()) return;
      const text = p.text, started = Date.now();
      try { await this.engine.askAt(anchor.bookId, text, anchor.span, anchor.sessionId, anchor.generation, anchor.conversationId); }
      catch (error) {
        if ((error as Error).name === 'AbortError') return;
        if (!this.engine.state.chats.some(c => c.bookId === anchor.bookId && c.input === 'voice' && c.text === text && c.createdAt >= started)) this.post({ kind: 'draft', bookId: anchor.bookId, conversationId: anchor.conversationId ?? anchor.sessionId, text });
        this.reportError(error);
      }
    }
  }
  dispose(): void {
    this.captureOpening?.abort(new DOMException('运行已结束','AbortError'));this.captureOpening=undefined;
    this.engine.stop(); this.unsubscribe(); this.engine.onReaction = undefined; this.disposed = true; this.listeners.clear();
  }
}
