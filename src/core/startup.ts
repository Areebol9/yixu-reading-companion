import { evidence, isEvidenceAllowed, reconcileCorrections } from './context.ts';
import { mergeRanges } from './books.ts';
import {pruneReadingDrafts,validateReadingDrafts} from './reading-drafts.ts';
import {pruneReviewSources,validateReviewTasks} from './review-tasks.ts';
import {recoverCompanionWorkspaces} from './companion-workspace.ts';
import {pruneCompanionReadingReceipts,validateCompanionReadingReceipts} from './companion-receipts.ts';
import type { State } from './types.ts';
import {validateCorrectionRepairs,pruneCorrectionRepairs} from './companion-correction-repair.ts';
import {validatePublishedViews} from './published-views.ts';
import {validateMaintenanceDispatchHeaders} from './maintenance-dispatch.ts';

export type StartupRecovery = { changed: boolean; questions: number; temporaryQuestions: number; unknownCalls: number; interruptedTasks?: number };

// A saved "pending" record has no live worker after process death or backup import.
// Reconcile that fact before exposing actions; restarting never issues requests itself.
export function recoverInterruptedState(state: State): StartupRecovery {
  const result: StartupRecovery = { changed: false, questions: 0, temporaryQuestions: 0, unknownCalls: 0 };
  validatePublishedViews(state);
  validateMaintenanceDispatchHeaders(state);
  for(const job of state.maintenanceJobs??[])if(job.status==='running'){job.status='blocked';job.reason='维护执行已中断，原材料与未完成覆盖保留';result.changed=true;}
  const flags=()=>JSON.stringify([state.memories.map(m=>[m.invalidatedBy,m.forgotten,m.backgroundOrigin]),state.chats.map(c=>[c.outdatedBy,c.replacedBy,c.excluded,c.delivery]),
    (state.habits??[]).map(h=>[h.invalidatedBy,h.forgotten,h.retiredBy])]);
  const before=flags();reconcileCorrections(state);
  if(flags()!==before)result.changed=true;
  if(recoverCompanionWorkspaces(state))result.changed=true;
  validateCorrectionRepairs(state);
  if(pruneCorrectionRepairs(state))result.changed=true;
  validateReadingDrafts(state,false);
  if(pruneReadingDrafts(state))result.changed=true;
  validateCompanionReadingReceipts(state);
  if(pruneCompanionReadingReceipts(state))result.changed=true;
  validateReviewTasks(state);
  if(pruneReviewSources(state))result.changed=true;
  // Older reviews stored only selected citations in evidence and lost their
  // wider reading exposure. Exact historical exposure cannot be reconstructed;
  // retain citations separately and fence them by this checkpoint + lineage.
  const books = new Map(state.books.map(b => [b.id, b])), memories = new Map(state.memories.map(m => [m.id, m]));
  for (const memory of state.memories) if (memory.source === 'review' && memory.reviewDisposition === 'supported' && !memory.sourceEvidence && memory.evidence.length) {
    const book = books.get(memory.bookId); if (!book) continue;
    memory.sourceEvidence = memory.evidence.map(r => ({ ...r }));
    const ancestors = memory.parents.map(id => memories.get(id)).filter(m => m?.bookId === book.id).flatMap(m => m!.evidence);
    memory.evidence = mergeRanges([...memory.evidence, ...book.known, ...ancestors]).map(r => evidence(book, r)); result.changed = true;
  }
  for (const task of state.tasks ?? []) if (task.status === 'running') {
    task.status = task.items.some(i => i.status === 'pending') ? 'interrupted' : 'complete';
    task.stopReason = task.status === 'interrupted' ? 'restart' : undefined;
    task.updatedAt = Math.max(task.updatedAt, Date.now()); result.changed = true;
    if (task.status === 'interrupted') result.interruptedTasks = (result.interruptedTasks ?? 0) + 1;
  }
  for (const usage of state.usage) if (usage.status === 'reserved') {
    usage.status = 'unknown'; result.unknownCalls++; result.changed = true;
  }
  for (const chat of state.chats) if (chat.role === 'user' && chat.delivery === 'pending') {
    const book = state.books.find(b => b.id === chat.bookId);
    const valid = !!book && !chat.excluded && !chat.outdatedBy && !chat.replacedBy && chat.evidence.length > 0 && isEvidenceAllowed(book, chat.evidence);
    const answered = state.chats.some(reply => reply.role === 'assistant' && reply.replyTo === chat.id && reply.bookId === chat.bookId && reply.sessionId === chat.sessionId && !reply.excluded && !reply.outdatedBy);
    if (valid && answered) chat.delivery = 'answered';
    else if (valid && !chat.futureGrant) { chat.delivery = 'failed'; result.questions++; }
    else { chat.delivery = 'stopped'; if (chat.futureGrant) result.temporaryQuestions++; }
    result.changed = true;
  }
  const resume = state.resume;
  if (resume && (!state.books.some(b => b.id === resume.bookId) || !state.conversations.some(c => c.id === resume.conversationId && c.bookId === resume.bookId && c.kind !== 'discussion'))) {
    state.resume = undefined; result.changed = true;
  }
  if (!state.settings.searchProvider) {
    Object.assign(state.settings, { searchEnabled: false, searchProvider: 'exa', searchEndpoint: 'https://mcp.exa.ai/mcp' });
    result.changed = true;
  }
  return result;
}
