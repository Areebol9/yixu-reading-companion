import { useEffect, useReducer, useRef } from 'react';
import type { WorkbenchClient, WorkbenchDraft, WorkbenchSnapshot } from './contract.ts';

export const messageDraftKey = (bookId: string, version: string, conversationId?: string) => JSON.stringify(['message', bookId, version, conversationId ?? null]);
export const paragraphDraftKey = (bookId: string, version: string, start: number, end: number) => JSON.stringify(['paragraph', bookId, version, start, end]);
type DraftText = { text: string; parentId?: string };
type PendingDraft = { archiveId: string; key: string; value: WorkbenchDraft | null; revision: string; acknowledged?: boolean };
const prefix = 'yixu:pending-draft:v1:';
const storageKey = (archiveId: string, key: string) => prefix + JSON.stringify([archiveId, key]);
const same = (a: DraftText | null | undefined, b: DraftText | null | undefined) => (a?.text ?? '') === (b?.text ?? '') && a?.parentId === b?.parentId;

/** Only unsaved text is buffered here. Host observations remain the portable authority. */
class DraftBuffer {
  private pending = new Map<string, PendingDraft>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = new Map<string, Promise<void>>();
  private listeners = new Set<() => void>();
  private loaded = new Set<string>();
  private saved = new Map<string, Record<string, WorkbenchDraft>>();
  constructor(private client: WorkbenchClient, private error: (message: string) => void) {}
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit() { for (const listener of this.listeners) listener(); }
  private writePending(id: string, pending?: PendingDraft) {
    try { if (pending) localStorage.setItem(id, JSON.stringify(pending)); else localStorage.removeItem(id); }
    catch { this.error('浏览器草稿缓冲未保存，正在保留输入并尝试保存到当前存档。'); }
  }
  activate(archiveId: string) {
    if (!this.loaded.has(archiveId)) {
      this.loaded.add(archiveId);
      try {
        const archivePrefix = prefix + JSON.stringify([archiveId]).slice(0, -1) + ',';
        for (let i = 0; i < localStorage.length; i++) {
          const id = localStorage.key(i); if (!id?.startsWith(archivePrefix)) continue;
          const saved = JSON.parse(localStorage.getItem(id) ?? 'null') as PendingDraft | null;
          if (!saved || saved.archiveId !== archiveId || typeof saved.key !== 'string' || typeof saved.revision !== 'string' || id !== storageKey(archiveId, saved.key)) continue;
          if (saved.value !== null && (!saved.value || typeof saved.value.text !== 'string' || !Number.isFinite(saved.value.updatedAt) || saved.value.parentId !== undefined && typeof saved.value.parentId !== 'string')) continue;
          this.pending.set(id, { ...saved, acknowledged: false });
        }
      } catch { this.error('有一份本机草稿缓冲未能读取，当前输入仍可继续保存。'); }
      this.emit();
    }
    for (const [id, pending] of this.pending) if (pending.archiveId === archiveId && !pending.acknowledged) this.schedule(id);
  }
  read(archiveId: string, key: string, saved?: WorkbenchDraft): DraftText {
    const pending = this.pending.get(storageKey(archiveId, key));
    return pending ? pending.value ?? { text: '' } : saved ?? { text: '' };
  }
  reconcile(snapshot: WorkbenchSnapshot) {
    this.saved.set(snapshot.sessionId, snapshot.drafts ?? {});
    for (const [id, pending] of this.pending) {
      if (pending.archiveId !== snapshot.sessionId || !pending.acknowledged) continue;
      const saved = snapshot.drafts?.[pending.key];
      if (pending.value ? saved?.updatedAt !== pending.value.updatedAt || !same(saved, pending.value) : !!saved) continue;
      this.pending.delete(id); this.writePending(id);
    }
  }
  set(archiveId: string, key: string, value: DraftText | null) {
    const id = storageKey(archiveId, key);
    const pending: PendingDraft = { archiveId, key, value: value && (value.text || value.parentId) ? { ...value, updatedAt: Date.now() } : null, revision: crypto.randomUUID() };
    this.pending.set(id, pending); this.writePending(id, pending); this.emit(); this.schedule(id);
  }
  clearSubmitted(archiveId: string, key: string, submitted: DraftText) {
    // Read this original key even when the user has switched book, topic or paragraph.
    const snapshot = this.client.getSnapshot();
    const pending = this.pending.get(storageKey(archiveId, key));
    const current = pending ? pending.value : snapshot.sessionId === archiveId ? snapshot.drafts?.[key] : this.saved.get(archiveId)?.[key];
    if (current && same(current, submitted)) this.set(archiveId, key, null);
  }
  moveSubmitted(archiveId: string, sourceKey: string, targetKey: string, submitted: DraftText) {
    const snapshot = this.client.getSnapshot();
    if (snapshot.sessionId !== archiveId) return;
    const source = this.read(archiveId, sourceKey, snapshot.drafts?.[sourceKey]);
    const target = this.read(archiveId, targetKey, snapshot.drafts?.[targetKey]);
    if (!same(source, submitted) || target.text || target.parentId) return;
    this.set(archiveId, targetKey, submitted);
    this.set(archiveId, sourceKey, null);
  }
  private schedule(id: string) {
    clearTimeout(this.timers.get(id));
    this.timers.set(id, setTimeout(() => { this.timers.delete(id); void this.flush(id); }, 300));
  }
  async flushCurrentArchive() {
    const archiveId = this.client.getSnapshot().sessionId;
    const ids = [...this.pending].filter(([, pending]) => pending.archiveId === archiveId).map(([id]) => id);
    await Promise.all(ids.map(async id => {
      clearTimeout(this.timers.get(id)); this.timers.delete(id);
      await this.running.get(id);
      await this.flush(id);
      if (this.pending.get(id) && !this.pending.get(id)!.acknowledged) throw Error('草稿尚未保存到当前存档，输入已保留，请在保存完成后导出。');
    }));
    if (this.client.getSnapshot().sessionId !== archiveId) throw Error('草稿保存期间已切换存档，请从当前存档重新导出。');
  }
  private flush(id: string): Promise<void> {
    const running = this.running.get(id); if (running) return running;
    const pending = this.pending.get(id);
    if (!pending || pending.acknowledged || this.client.getSnapshot().sessionId !== pending.archiveId) return Promise.resolve();
    const task = this.save(id, pending); this.running.set(id, task); return task;
  }
  private async save(id: string, pending: PendingDraft) {
    try {
      await this.client.saveDraft(pending.key, pending.value);
      const current = this.pending.get(id);
      if (current?.revision === pending.revision) {
        current.acknowledged = true;
        // Keep the overlay until the corresponding host projection has arrived.
        this.reconcile(this.client.getSnapshot()); this.emit();
      }
    } catch (error) { this.error(error instanceof Error ? '草稿尚未保存到存档：' + error.message : '草稿尚未保存到存档，输入保留在本机。'); }
    finally {
      this.running.delete(id);
      const current = this.pending.get(id);
      // A newer edit waits for this write; a failed write is not retried in a loop.
      if (current && current.revision !== pending.revision && !current.acknowledged) this.schedule(id);
    }
  }
}

export function useWorkbenchDrafts(client: WorkbenchClient, snapshot: WorkbenchSnapshot, onError: (message: string) => void) {
  const error = useRef(onError); error.current = onError;
  const buffer = useRef<{ client: WorkbenchClient; value: DraftBuffer } | undefined>(undefined);
  if (!buffer.current || buffer.current.client !== client) buffer.current = { client, value: new DraftBuffer(client, message => error.current(message)) };
  const drafts = buffer.current.value;
  const [, refresh] = useReducer((version: number) => version + 1, 0);
  useEffect(() => drafts.subscribe(refresh), [drafts]);
  useEffect(() => { drafts.activate(snapshot.sessionId); }, [drafts, snapshot.sessionId]);
  useEffect(() => { drafts.reconcile(snapshot); }, [drafts, snapshot]);
  return drafts;
}
