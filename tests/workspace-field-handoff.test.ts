import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../src/core/state.ts';
import { importBook } from '../src/core/books.ts';
import { restoreBackup } from '../src/core/backup.ts';
import { planWorkspace, pruneCompanionWorkspaces, validateCompanionWorkspaces, workspaceFor, workspaceVersion, workspaceVersionMatches } from '../src/core/companion-workspace.ts';
import type { Chat, Memory, ReadingReply } from '../src/core/types.ts';

async function fixture() {
  const state = initialState(), book = await importBook('ENGINE MOCK field handoff', '第一章 工程\nENGINE MOCK permitted text.');
  book.frontMatterIncluded = true; book.known = [{ start: 0, end: book.text.length }]; state.books = [book];
  const evidence = [{ ...book.known[0], bookId: book.id, version: book.version }];
  const memory = (id: string, kind: Memory['kind']): Memory => ({ id, kind, text: 'ENGINE MOCK ' + id, bookId: book.id, partnerId: state.partnerId, evidence, parents: [], chatIds: [], createdAt: 1, forgotten: false, source: 'reading' });
  state.memories = [memory('old', 'opinion'), memory('new', 'opinion'), memory('focus-a', 'question'), memory('focus-b', 'question')];
  state.conversations = [{ id: 'session', bookId: book.id, title: 'ENGINE MOCK dialogue', manualTitle: false, start: 0, end: book.text.length, createdAt: 1 }];
  const chat = (id: string, createdAt: number, role: Chat['role'] = 'user', replyTo?: string): Chat => ({ id, bookId: book.id, partnerId: state.partnerId, sessionId: 'session', role, text: 'ENGINE MOCK ' + id, evidence, createdAt, excluded: false, ...(replyTo ? { replyTo } : {}) });
  state.chats = [chat('q-old', 10), chat('q-new', 20), chat('answer-new', 30, 'assistant', 'q-new'), chat('answer-old-late', 40, 'assistant', 'q-old'), chat('answer-new-retry', 25, 'assistant', 'q-new')];
  const write = (proposal: ReadingReply['workspace'], chatId?: string) => planWorkspace(state, book, proposal, { memoryIds: state.memories.map(m => m.id) }, { expectedRevision: workspaceFor(state, book).revision, ...(chatId ? { chatId } : {}) });
  write({ understanding: 'old', focus: ['focus-a'] });
  return { state, book, write };
}

test('chat及focus变化允许后台理解按字段交接，保留当前focus与lastChat；同值字段版本不变', async () => {
  const { state, book, write } = await fixture(), anchor = workspaceVersion(workspaceFor(state, book));
  write({}, 'q-new');
  assert.deepEqual(workspaceVersion(workspaceFor(state, book)), anchor);
  write({ focus: ['focus-b'] }, 'answer-new');
  const before = workspaceFor(state, book);
  assert.equal(workspaceVersionMatches(before, anchor, { understanding: 'new' }), true);
  assert.equal(workspaceVersionMatches(before, anchor, {}), true);
  assert.equal(workspaceVersionMatches(before, anchor, undefined), true);
  assert.equal(workspaceVersionMatches(before, anchor, { focus: ['focus-a'] }), false);
  write({ understanding: 'new' });
  const handed = workspaceFor(state, book);
  assert.equal(handed.understandingId, 'new'); assert.deepEqual(handed.focusIds, ['focus-b']); assert.equal(handed.lastChatId, 'answer-new');
  assert.equal(handed.focusRevision, before.focusRevision); assert.equal(handed.understandingRevision, handed.revision);
  const stable = workspaceVersion(handed); write({ understanding: 'new', focus: ['focus-b'] });
  assert.deepEqual(workspaceVersion(workspaceFor(state, book)), stable);
});

test('理解更新拒绝旧覆写；focus-only交接保留新理解，字段ABA即使值相同仍拒绝', async () => {
  const { state, book, write } = await fixture(), anchor = workspaceVersion(workspaceFor(state, book));
  write({ understanding: 'new' });
  assert.equal(workspaceVersionMatches(workspaceFor(state, book), anchor, { understanding: 'old' }), false);
  assert.equal(workspaceVersionMatches(workspaceFor(state, book), anchor, { focus: ['focus-b'] }), true);
  write({ focus: ['focus-b'] }); assert.equal(workspaceFor(state, book).understandingId, 'new');
  write({ understanding: 'old', focus: ['focus-a'] });
  assert.equal(workspaceVersionMatches(workspaceFor(state, book), anchor, { understanding: 'new' }), false);
  assert.equal(workspaceVersionMatches(workspaceFor(state, book), anchor, { focus: ['focus-b'] }), false);
});

test('较老问题迟到答案不覆盖lastChat，同一问题的新答可替换；同时刻按提问顺序', async () => {
  const { state, book, write } = await fixture();
  write({}, 'answer-new'); write({}, 'answer-old-late');
  assert.equal(workspaceFor(state, book).lastChatId, 'answer-new');
  write({}, 'answer-new-retry'); assert.equal(workspaceFor(state, book).lastChatId, 'answer-new-retry');
  const newer = state.chats.find(c => c.id === 'q-new')!; newer.createdAt = 10;
  write({}, 'answer-old-late'); assert.equal(workspaceFor(state, book).lastChatId, 'answer-new-retry');
  state.chats.find(c => c.id === 'answer-old-late')!.excluded = true;
  assert.throws(() => write({}, 'answer-old-late'), /阅读权限/);
});

test('prune只更新实际清理字段的版本，聊天清理保留字段版本，已有权限与完整来源限制仍执行', async () => {
  const { state, book, write } = await fixture(); write({}, 'answer-new');
  const anchor = workspaceVersion(workspaceFor(state, book));
  state.chats.find(c => c.id === 'answer-new')!.excluded = true;
  assert.equal(pruneCompanionWorkspaces(state), true); assert.deepEqual(workspaceVersion(workspaceFor(state, book)), anchor);
  state.memories.find(m => m.id === 'focus-a')!.forgotten = true;
  pruneCompanionWorkspaces(state);
  const focusPruned = workspaceFor(state, book);
  assert.equal(focusPruned.focusRevision, focusPruned.revision); assert.equal(focusPruned.understandingRevision, anchor.understandingRevision);
  state.memories.find(m => m.id === 'old')!.invalidatedBy = 'correction'; pruneCompanionWorkspaces(state);
  const pruned = workspaceFor(state, book);
  assert.equal(pruned.understandingId, undefined); assert.equal(pruned.understandingRevision, pruned.revision); assert.equal(pruned.focusRevision, focusPruned.focusRevision);
  assert.throws(() => write({ understanding: 'old' }), /完整取得/);
  assert.throws(() => planWorkspace(state, book, { understanding: 'new' }, { memoryIds: [] }, { expectedRevision: pruned.revision }), /完整取得/);
  book.known = []; assert.throws(() => write({ understanding: 'new' }), /完整取得/);
});

test('旧工作台备份字段缺省仍可恢复，fallback不改历史；新备份严格检查字段版本', async () => {
  const { state, book, write } = await fixture(), old = structuredClone(state);
  delete old.companionWorkspaces![0].understandingRevision; delete old.companionWorkspaces![0].focusRevision;
  const restored = await restoreBackup(JSON.stringify(old), initialState()), w = workspaceFor(restored, restored.books[0]);
  assert.equal(w.understandingRevision, undefined); assert.equal(w.focusRevision, undefined);
  assert.deepEqual(workspaceVersion(w), { understandingId: 'old', understandingRevision: w.revision, focusRevision: w.revision });
  write({ understanding: 'new' });
  const merged = await restoreBackup(JSON.stringify(old), state);
  assert.deepEqual(workspaceVersion(workspaceFor(merged, merged.books[0])), workspaceVersion(workspaceFor(state, book)));
  const fresh = await restoreBackup(JSON.stringify(state), initialState());
  assert.deepEqual(workspaceVersion(workspaceFor(fresh, fresh.books[0])), workspaceVersion(workspaceFor(state, book)));
  for (const invalid of [-1, 0.5, state.companionWorkspaces![0].revision + 1]) {
    const malformed = structuredClone(state); malformed.companionWorkspaces![0].focusRevision = invalid;
    assert.throws(() => validateCompanionWorkspaces(malformed), /工作台记录/);
  }
  const malformed = structuredClone(state); malformed.companionWorkspaces![0].understandingRevision = -1;
  await assert.rejects(restoreBackup(JSON.stringify(malformed), initialState()), /工作台记录/);
});
