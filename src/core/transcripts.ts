import {id} from './books.ts';
import type {Chat,State} from './types.ts';
import {reconcileHabits} from './habits.ts';

/** The recognition was wrong, so retire everything exposed to those words, not just
 * model-declared attribution. Historical messages remain available to the reader. */
export function reconcileTranscriptRevisions(state: State): void {
  const selected = new Map((state.transcriptRevisions ?? []).map(r => [r.originalId, r]));
  for (const revision of state.transcriptRevisions ?? []) {
    const chosen = selected.get(revision.originalId)!;
    const chatIds = new Set([revision.originalId, ...(chosen.id !== revision.id ? [revision.replacementId] : [])]), memoryIds = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const memory of state.memories) if (memory.bookId === revision.bookId && !memoryIds.has(memory.id) &&
        (memory.chatIds.some(id => chatIds.has(id)) || memory.parents.some(id => memoryIds.has(id)))) {
        memoryIds.add(memory.id); changed = true;
      }
      for (const chat of state.chats) if (chat.bookId === revision.bookId && !chatIds.has(chat.id) && chat.id !== revision.replacementId &&
        (chat.contextChatIds?.some(id => chatIds.has(id)) || chat.memoryIds?.some(id => memoryIds.has(id)) || !!chat.replyTo && chatIds.has(chat.replyTo))) {
        chatIds.add(chat.id); changed = true;
      }
    }
    for (const memory of state.memories) if (memoryIds.has(memory.id)) memory.invalidatedBy ??= chosen.id;
    for (const chat of state.chats) if (chatIds.has(chat.id)) chat.outdatedBy ??= chosen.id;
    const original = state.chats.find(c => c.id === revision.originalId);
    if (original) { original.replacedBy = chosen.replacementId; if (original.delivery === 'pending' || original.delivery === 'failed') original.delivery = 'stopped'; }
  }
  reconcileHabits(state);
}

export function reviseTranscript(state: State, chatId: string, text: string): Chat {
  const original = state.chats.find(c => c.id === chatId && c.role === 'user' && c.input === 'voice');
  if (!original || original.excluded || original.replacedBy || original.futureGrant) throw new Error('请更正当前有效的语音转写');
  const value = text.trim();
  if (!value || value.length > 12000) throw new Error('转写内容请填写 1 至 12000 个字符');
  if (value === original.text) return original;
  const replacement: Chat = { id: id(), bookId: original.bookId, partnerId:original.partnerId, sessionId: original.sessionId, role: 'user', text: value,
    evidence: structuredClone(original.evidence), createdAt: Date.now(), excluded: false, delivery: 'stopped', input: 'voice', corrects: original.id };
  (state.transcriptRevisions ??= []).push({ id: id(), bookId: original.bookId, originalId: original.id, replacementId: replacement.id, createdAt: Date.now() });
  state.chats.push(replacement); reconcileTranscriptRevisions(state);
  return replacement;
}
