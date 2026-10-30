import {bookVersionAllowsRange} from './book-versions.ts';
import { mergeRanges } from './books.ts';
import { isEvidenceAllowed } from './context.ts';
import { chatBelongsToPartner } from './discussion-recall.ts';
import { permittedStages } from './stage-state.ts';
import type { Book, Chat, Memory, NarrativeMode, Range, ReadingMode, ReadingProfile, State } from './types.ts';

export function readingProfile(book: Pick<Book, 'readingStrategy' | 'narrativeMode'|'arcCandidate'|'worldCandidate'>, fallback: NarrativeMode = 'legacy'): ReadingProfile {
  const readingStrategy = book.readingStrategy ?? 'companion';
  return { readingStrategy, narrativeMode: readingStrategy !== 'structured' ? 'legacy' : book.narrativeMode ?? fallback,...(readingStrategy==='structured'&&(book.narrativeMode??fallback)==='stages'&&book.arcCandidate?{arcCandidate:book.arcCandidate}:{}),...(readingStrategy==='structured'&&(book.narrativeMode??fallback)==='stages'&&book.worldCandidate?{worldCandidate:book.worldCandidate}:{}) };
}
export function modeProfile(mode: ReadingMode): ReadingProfile {
  if (!['companion', 'legacy', 'stages', 'full-original'].includes(mode)) throw Error('共读资料方式无效');
  return { readingStrategy: mode === 'companion' ? 'companion' : mode === 'full-original' ? 'full-original' : 'structured', narrativeMode: mode === 'stages' ? 'stages' : 'legacy' };
}
export function profileMode(profile: ReadingProfile): ReadingMode {
  return profile.readingStrategy === 'companion' ? 'companion' : profile.readingStrategy === 'full-original' ? 'full-original' : profile.narrativeMode;
}
/** Derived coverage is neither book-wide original processing nor an asOf fence. */
export function stageCoverage(state: State, book: Book, source: Memory['source'] = 'reading', extra: Range[] = []): Range[] {
  return mergeRanges(permittedStages(state, book, { source, extra }).flatMap(m => m.stageNarrative!.ranges));
}
/** Shared by the renderer and core, before any pending flag or model request. */
export function canRetryQuestion(state: State, chat: Chat | undefined): chat is Chat {
  if (!chat || chat.role !== 'user' || chat.excluded || chat.outdatedBy || chat.replacedBy || chat.futureGrant ||
    !['failed', 'stopped'].includes(chat.delivery ?? '') || !chatBelongsToPartner(state, chat) || !chat.evidence.length) return false;
  const book = state.books.find(b => b.id === chat.bookId);
  return !!book && chat.evidence.every(e => e.bookId === book.id && bookVersionAllowsRange(book,e.version,e)) && isEvidenceAllowed(book, chat.evidence) &&
    state.conversations.some(c => c.id === chat.sessionId && c.bookId === chat.bookId) &&
    !state.chats.some(c => c.role === 'assistant' && c.replyTo === chat.id && c.sessionId === chat.sessionId && c.bookId === chat.bookId &&
      !c.excluded && !c.outdatedBy && !c.replacedBy && chatBelongsToPartner(state, c));
}
