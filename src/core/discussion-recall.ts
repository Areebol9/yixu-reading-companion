import { normalize } from './books.ts';
import { chatAllowsMemory,isEvidenceAllowed } from './context.ts';
import { recallTerms } from './recall.ts';
import type { Book, Chat, DiscussionQuery, Range, State } from './types.ts';

export function legacyPartnerOwnsUnlabelled(state:{readonly partnerId:string;readonly partners:readonly {readonly id:string;readonly legacyUnlabelled?:true}[]}):boolean{return state.partners.some(partner=>partner.id===state.partnerId&&partner.legacyUnlabelled===true)||state.partners.length===1&&state.partners[0].id===state.partnerId;}
export function conversationBelongsToPartner(state:{readonly partnerId:string;readonly partners:readonly {readonly id:string;readonly legacyUnlabelled?:true}[]},conversation:{readonly partnerId?:string}):boolean{return conversation.partnerId===state.partnerId||!conversation.partnerId&&legacyPartnerOwnsUnlabelled(state);}

export function chatBelongsToPartner(state: State, chat: Chat): boolean {
  return chat.partnerId === state.partnerId || !chat.partnerId && legacyPartnerOwnsUnlabelled(state);
}
export function parseDiscussionQuery(raw: unknown): DiscussionQuery {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('交流回查参数无效');
  const q = raw as Record<string, unknown>;
  if (Object.keys(q).some(k => !['query','offset','chatId','textStart'].includes(k)) ||
    q.query !== undefined && (typeof q.query !== 'string' || q.query.length > 160) ||
    q.offset !== undefined && (!Number.isSafeInteger(q.offset) || Number(q.offset) < 0) ||
    q.chatId !== undefined && (typeof q.chatId !== 'string' || !q.chatId || q.chatId.length > 128) ||
    q.textStart !== undefined && (!Number.isSafeInteger(q.textStart) || Number(q.textStart) < 0 || !q.chatId) ||
    q.chatId !== undefined && (q.query !== undefined || q.offset !== undefined)) throw new Error('交流回查参数无效');
  return { query: typeof q.query === 'string' ? q.query.trim() : undefined, offset: q.offset as number | undefined,
    chatId: q.chatId as string | undefined, textStart: q.textStart as number | undefined };
}

/** Actual utterances, not a generated recollection. Permission precedes matching,
 * count and paging; old unlabelled multi-partner records are not attributed. */
export function searchDiscussions(state: State, book: Book, request: DiscussionQuery, extra: Range[] = []) {
  const allowed = state.chats.filter(c => c.presentation!=='paragraph' && c.bookId === book.id && chatBelongsToPartner(state, c) && chatAllowsMemory(state,c) && !c.excluded && !c.outdatedBy && !c.replacedBy && !c.futureGrant && c.delivery !== 'pending' && (!c.publication || c.publication.status === 'published') && (!c.readingReaction || c.readingReaction.status === 'delivered') && isEvidenceAllowed(book, c.evidence, extra));
  const query = normalize(request.query ?? ''), terms = recallTerms(query);
  const ranked = allowed.map(chat => {
    const text = normalize(chat.text), words = recallTerms(text);
    let score = query && text.includes(query) ? 2 : 0;
    for (const term of terms) if (words.has(term)) score += 1 / Math.max(1, terms.size);
    return { chat, score };
  }).filter(x => request.chatId ? x.chat.id === request.chatId : !query || x.score > 0)
    .sort((a, b) => b.score - a.score || b.chat.createdAt - a.chat.createdAt || a.chat.id.localeCompare(b.chat.id));
  const items: { chat: Chat; text: string; textStart: number; textEnd: number; nextTextStart?: number }[] = [];
  let offset = request.offset ?? 0, remaining = 4000;
  while (offset < ranked.length && remaining > 0 && items.length < 6) {
    const chat = ranked[offset++].chat, start = request.chatId ? request.textStart ?? 0 : 0;
    if (start >= chat.text.length) continue;
    const end = Math.min(chat.text.length, start + Math.min(remaining, request.chatId ? 4000 : 1400));
    items.push({ chat, text: chat.text.slice(start, end), textStart: start, textEnd: end, nextTextStart: end < chat.text.length ? end : undefined });
    remaining -= end - start;
  }
  return { items, total: ranked.length, nextOffset: !request.chatId && offset < ranked.length ? offset : undefined };
}
