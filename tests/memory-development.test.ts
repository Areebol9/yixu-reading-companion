import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importBook } from '../src/core/books.ts';
import { correctMemory, evidence, forgetMemory, isCurrentMemory, usableMemories } from '../src/core/context.ts';
import { planMemories, validateDevelopments } from '../src/core/memory-plan.ts';
import { restoreBackup } from '../src/core/backup.ts';
import { ReadingEngine } from '../src/core/engine.ts';
import { initialState } from '../src/core/state.ts';
import type { Memory, ModelMessage, ModelPort, ReadingReply, State } from '../src/core/types.ts';

const basis = { memoryIds: ['old'], chatIds: [] };
const result = (updates = 'old'): ReadingReply => ({ reply: '新记录已经说明设备甲用于测量温度。', replyBasis: basis, reinforce: [], wantsLong: false,
  thoughts: [{ kind: 'story', text: '设备甲用于测量温度。', basis, updates, updateReason: '后续登记明确了用途，原疑问已得到回答。' }] });
const fields = (messages: ModelMessage[]) => messages.flatMap(m => { try { return [JSON.parse(m.content)]; } catch { return []; } });
test('旧疑问应由答案接续，新问题独立保存，不能以换题代替解决', async () => {
  const { state, book } = await fixture();
  const reply = result();
  reply.thoughts[0] = { ...reply.thoughts[0], kind: 'question', text: '设备甲是否还需要校准？' };
  assert.throws(() => validateDevelopments(state, book, reply, ['old']), /新的疑问请单独记录/);
  const resolved = result();
  resolved.thoughts.push({ kind: 'question', text: '设备甲是否还需要校准？', basis });
  const plan = planMemories(state, book, resolved, [evidence(book, book.known[0])], ['old'], [], 'reading');
  assert.equal(plan.added.length, 2);
  assert.equal(plan.added[0].correctionOf, 'old'); assert.equal(plan.added[0].kind, 'story');
  assert.equal(plan.added[1].correctionOf, undefined); assert.equal(plan.added[1].kind, 'question');
  assert.equal(plan.developments?.length, 1);
});
async function fixture(respond: (messages: ModelMessage[]) => ReadingReply = () => result()) {
  const state = initialState(), book = await importBook('理解进展资料', '第一章 起始\n设备甲的用途尚未登记，当前需等待后续说明。\n第二章 补充\n设备甲用于测量温度。后续资料已登记。');
  const earlier = { start: 0, end: book.chapters[1].start };
  book.known = [{ start: 0, end: book.text.length }]; book.prepared = [...book.known]; book.position = book.text.length;
  state.books = [book]; state.settings.services[0].enabled = true;
  state.conversations.push({ id: 'past', bookId: book.id, title: '以前的讨论', start: 0, end: earlier.end, createdAt: 1, manualTitle: false });
  const old: Memory = { id: 'old', bookId: book.id, partnerId: state.partnerId, kind: 'question', text: '设备甲的用途是什么？', source: 'reading', evidence: [evidence(book, earlier)], createdAt: 1, parents: [], chatIds: ['past-question'], basis: { memoryIds: [], chatIds: ['past-question'] }, forgotten: false };
  state.memories.push(old, { ...old, id: 'shared', kind: 'shared', text: '讨论过设备甲的用途。', source: 'conversation', parents: ['old'], chatIds: ['past-reply'], basis: { memoryIds: ['old'], chatIds: ['past-reply'] } });
  state.chats.push(
    { id: 'past-question', bookId: book.id, sessionId: 'past', role: 'user', text: '设备甲是做什么的？', evidence: old.evidence, excluded: false, createdAt: 1 },
    { id: 'past-reply', bookId: book.id, sessionId: 'past', role: 'assistant', text: '现有登记还没有说明用途。', evidence: old.evidence, excluded: false, createdAt: 2, memoryIds: ['old'], basis }
  );
  let reject = false, saved: State | undefined; const requests: ModelMessage[][] = [];
  const model: ModelPort = { async complete(_service, messages) { requests.push(messages); return { content: JSON.stringify(respond(messages)), input: 10, output: 10, estimated: false, elapsedMs: 1 }; } };
  const engine = new ReadingEngine(state, { async load() { return saved; }, async save(value) { if (reject && value.memories.some(m => m.revisionKind === 'development')) throw new Error('disk unavailable'); saved = structuredClone(value); } }, model);
  await engine.startReading(book.id);
  return { state, book, old, earlier, engine, requests, saved: () => saved!, rejectSave: () => { reject = true; } };
}

test('新证据回答旧疑问，原判断退出当前理解，过去聊天和共同经历保持可用', async () => {
  const f = await fixture();
  try {
    await f.engine.ask(f.book.id, '接着看新的用途登记。');
    const next = f.state.memories.find(m => m.revisionKind === 'development')!;
    assert.ok(next); assert.equal(f.old.replacedBy, next.id); assert.equal(next.correctionOf, f.old.id);
    assert.equal(next.kind, 'story'); assert.ok(next.revisionReason?.includes('原疑问'));
    assert.equal(isCurrentMemory(f.old), false); assert.equal(next.invalidatedBy, undefined);
    assert.ok(usableMemories(f.state, f.book).some(m => m.id === next.id));
    assert.equal(usableMemories(f.state, f.book).some(m => m.id === 'old'), false);
    for (const id of ['past-question','past-reply']) assert.equal(f.state.chats.find(c => c.id === id)?.outdatedBy, undefined);
    assert.equal(f.state.memories.find(m => m.id === 'shared')?.invalidatedBy, undefined);
    assert.equal(f.state.chats.at(-1)?.outdatedBy, undefined); assert.equal(f.requests.length, 1);
    assert.equal(f.saved().memories.find(m => m.id === 'old')?.replacedBy, next.id);
    assert.ok(fields(f.requests[0]).find(p => p.memories)?.memories.find((m: any) => m.text === f.old.text).canUpdate);
  } finally { f.engine.stop(); }
});

test('新版本包含后续信息时，较早阅读范围仍只得到当时的理解及相同命中数', async () => {
  const f = await fixture();
  try {
    const before = structuredClone(f.state); await f.engine.ask(f.book.id, '接着看新资料。');
    f.book.known = [f.earlier]; before.books[0].known = [f.earlier];
    const after = usableMemories(f.state, f.book), expected = usableMemories(before, before.books[0]);
    assert.deepEqual(after.map(m => m.id), expected.map(m => m.id));
    assert.equal(after.some(m => m.text.includes('测量温度')), false);
  } finally { f.engine.stop(); }
});

test('较早授权范围中的旧观点仍可参与新的理解，不借助未获准的新版本',async()=>{
  let count=0;
  const f=await fixture(messages=>{
    if(++count===1)return result();
    assert.equal(JSON.stringify(messages).includes('测量温度'),false);
    return {reply:'目前的登记仍有待补充。',replyBasis:basis,thoughts:[{kind:'opinion',text:'应该保留对用途的疑问，等待当前范围内的进一步说明。',basis}],reinforce:[],wantsLong:false};
  });
  try{
    await f.engine.ask(f.book.id,'接着看新资料。');f.book.known=[f.earlier];f.book.position=f.earlier.end;
    await f.engine.ask(f.book.id,'只按现在获准的起始资料讨论。');
    assert.ok(usableMemories(f.state,f.book).some(m=>m.text.includes('应该保留对用途的疑问')));
    assert.equal(usableMemories(f.state,f.book).some(m=>m.text.includes('测量温度')),false);
  }finally{f.engine.stop();}
});

test('新理解保存失败时，旧版本及原聊天不先退档', async () => {
  const f = await fixture();
  try {
    const before = structuredClone(f.state.memories); f.rejectSave();
    await assert.rejects(f.engine.ask(f.book.id, '看新的登记。'), /disk unavailable/);
    assert.deepEqual(f.state.memories, before); assert.equal(f.old.replacedBy, undefined);
    assert.equal(f.state.chats.find(c => c.id === 'past-reply')?.outdatedBy, undefined);
    assert.equal(f.state.chats.filter(c => c.role === 'assistant').length, 1);
  } finally { f.engine.stop(); }
});

test('不能更新用户偏好、共同经历、事实、用户更正、他书或未提供的条目', async () => {
  const f = await fixture();
  try {
    for (const patch of [{kind:'user'}, {kind:'shared'}, {kind:'story'}, {source:'correction'}, {bookId:'other'}, {partnerId:'other'}, {source:'background'}]) {
      const saved = { ...f.old }; Object.assign(f.old, patch);
      assert.throws(() => validateDevelopments(f.state, f.book, result(), ['old']), /只能更新/);
      Object.assign(f.old, saved);
    }
    assert.throws(() => validateDevelopments(f.state, f.book, result(), []), /只能更新/);
    const duplicate = result(); duplicate.thoughts.push({ ...duplicate.thoughts[0] });
    assert.throws(() => validateDevelopments(f.state, f.book, duplicate, ['old']), /只能更新/);
  } finally { f.engine.stop(); }
});

test('未请求新记忆和单次后文许可不更新已有观点', async () => {
  const f = await fixture();
  try {
    await f.engine.ask(f.book.id, '这次不要保存新记忆，讨论新登记。');
    assert.equal(f.old.replacedBy, undefined); assert.equal(f.state.memories.length, 2);
    f.book.known = [f.earlier];
    await f.engine.askWithFuture(f.book.id, '本次临时查看补充登记。', { start: f.earlier.end, end: f.book.text.length });
    assert.equal(f.old.replacedBy, undefined); assert.equal(f.state.memories.length, 2);
  } finally { f.engine.stop(); }
});

test('独立背景只发展自身观点，普通共读不能改写背景档案', async () => {
  const f = await fixture(messages => {
    const context=fields(messages).find(p=>p.memories);
    const memory = [...context.memories,...(context.questionIndex??[])].find((m: any) => m.text === f.old.text);
    assert.equal(memory?.canUpdate, true); return result();
  });
  try {
    f.old.source = 'background'; f.book.known = [f.earlier]; f.book.prepared = [f.earlier]; f.book.position = f.earlier.end;
    f.book.backgroundPrepared = [f.earlier];
    const known = structuredClone(f.book.known);
    await f.engine.prepareBackground(f.book.id);
    const next = f.state.memories.find(m => m.revisionKind === 'development')!;
    assert.equal(next.source, 'background'); assert.equal(f.old.replacedBy, next.id); assert.deepEqual(f.book.known, known);
    assert.deepEqual(usableMemories(f.state, f.book).filter(m => m.id === 'old').map(m => m.text), [f.old.text]);
    assert.throws(() => validateDevelopments(f.state, f.book, result(next.id), [next.id]), /只能更新/);
  } finally { f.engine.stop(); }
});

test('旧备份不能复活被接续的版本，忘记覆盖整条版本链；用户纠正仍按纠错处理', async () => {
  const f = await fixture();
  try {
    const oldBackup = JSON.stringify(f.state); await f.engine.ask(f.book.id, '继续新的资料。');
    const next = f.state.memories.find(m => m.revisionKind === 'development')!;
    const restored = await restoreBackup(oldBackup, f.state);
    assert.equal(restored.memories.find(m => m.id === 'old')?.replacedBy, next.id);
    assert.ok(usableMemories(restored, restored.books[0]).some(m => m.id === next.id));
    forgetMemory(restored, next.id);
    assert.ok(restored.memories.filter(m => [next.id,'old'].includes(m.id)).every(m => m.forgotten));
    const manual = correctMemory(f.state, next.id, '用户对用途记录的明确更正。');
    assert.equal(manual.source, 'correction'); assert.equal(manual.revisionKind, undefined); assert.equal(manual.revisionReason, undefined);
    const malformed = structuredClone(f.state); malformed.memories.find(m => m.id === next.id)!.revisionReason = '';
    await assert.rejects(restoreBackup(JSON.stringify(malformed), initialState()), /理解更新/);
  } finally { f.engine.stop(); }
});

test('同义重复不制造无意义版本', async () => {
  const f = await fixture();
  try {
    const update = result(); update.thoughts[0].kind = 'question'; update.thoughts[0].text = f.old.text;
    const plan = planMemories(f.state, f.book, update, f.old.evidence, ['old'], [], 'reading');
    assert.equal(plan.added.length, 0); assert.equal(plan.developments?.length, 0); assert.deepEqual(plan.reused, ['old']);
  } finally { f.engine.stop(); }
});
