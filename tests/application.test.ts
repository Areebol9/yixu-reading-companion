import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalApplication } from '../src/core/application.ts';
import { ReadingEngine } from '../src/core/engine.ts';
import { ReadingRuntime } from '../src/core/runtime.ts';
import { initialState } from '../src/core/state.ts';
import { createReadingDraft } from '../src/core/reading-drafts.ts';
import { evidence } from '../src/core/context.ts';
import type { State, ModelPort, Store } from '../src/core/types.ts';

const original = '第一章 工程记录\n设备AX共3件，编号001，存放位置为甲柜。\n第二章 后续\nCOMMAND-FUTURE-SENTINEL';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; }
async function fixture(model?: ModelPort) {
  let saved: State | undefined, fail = false, wait: ReturnType<typeof deferred> | undefined;
  const entered = deferred();
  const store: Store = { async load() { return saved && structuredClone(saved); }, async save(value) {
    const copy = structuredClone(value); if (fail) throw new Error('保存失败');
    const blocking = wait; wait = undefined; if (blocking) { entered.resolve(); await blocking.promise; }
    saved = copy;
  } };
  const state = initialState();
  const engine = new ReadingEngine(state, store, model ?? { async complete(service, messages) {
    assert.equal(JSON.stringify(messages).includes('COMMAND-FUTURE-SENTINEL'), false);
    return { content: JSON.stringify({ reply: '数量为3件。', thoughts: [{ kind: 'story', text: '设备AX为3件。' }], wantsLong: false }), input: 20, output: 10, estimated: false, elapsedMs: 1 };
  } });
  const runtime = new ReadingRuntime(engine, { available: false, async request() { throw new Error('无设备操作'); } });
  const calls: string[] = [], secretGate = { pending: undefined as ReturnType<typeof deferred> | undefined };
  const application = new LocalApplication(runtime, async <T>(method: string, payload: any) => {
    calls.push(method); if (secretGate.pending) await secretGate.pending.promise;
    if (method === 'services') return [{ id: 'wechat', hasKey: true }] as T;
    if (method === 'configureSearch') return { endpoint: payload.endpoint } as T;
    if (method === 'exportSecrets') return { wechat: 'fixture-secret' } as T;
    return {} as T;
  });
  const added = await application.command('importText', '工程命令测试.txt', original), book = engine.book(added.bookId);
  await application.command('setKnown', book.id, book.chapters[0].end); book.prepared = [...book.known];
  return { application, engine, runtime, state, store, book, calls, secretGate, entered,
    saved: () => saved!, fail: (value: boolean) => { fail = value; }, block: () => { wait = deferred(); return wait; } };
}

test('界面只有不可变元数据，所有正文导入与定位通过核心命令', async () => {
  const f = await fixture(), app = f.application;
  const prior = app.snapshot;
  assert.equal('text' in prior.state.books[0], false); assert.equal(prior.state.books[0].textLength, original.length);
  assert.throws(() => { (prior.state.books[0] as any).position = 0; }, TypeError);
  assert.throws(() => { (prior.state.settings.services as any).push({}); }, TypeError);
  await assert.rejects(app.command('persist' as any), /未知/);
  assert.deepEqual(await app.command('importText', '另一文件名.txt', original), { bookId: f.book.id, existing: true });
  await app.command('setArchived', f.book.id, true);
  assert.equal(prior.state.books[0].archived, false); assert.equal(app.snapshot.state.books[0].archived, true);
  await app.command('locatePosition', f.book.id, '设备AX共3件，编号001，存放位置为甲柜。');
  assert.equal(f.book.position, original.indexOf('。') + 1);
  assert.ok(app.snapshot.revision > prior.revision); f.runtime.dispose();
});

test('未发布理解草稿只在核心保存，不进入界面状态或跨桥消息',async()=>{
 const f=await fixture(),range=f.book.known[0];
 f.state.readingDrafts=[createReadingDraft(f.state,f.book,{source:'reading',ranges:[range],input:'工程页面'},
  {reply:'DRAFT-PRIVATE-SENTINEL',thoughts:[],wantsLong:false},[],
  {messages:[{role:'user',content:'DRAFT-PRIVATE-SENTINEL'}],refs:[evidence(f.book,range)],originalRanges:[range],memoryIds:[],chatIds:[],habitIds:[],passages:[]},'ready')];
 f.engine.emit();assert.equal('readingDrafts' in f.application.snapshot.state,false);assert.equal(JSON.stringify(f.application.snapshot).includes('DRAFT-PRIVATE-SENTINEL'),false);f.runtime.dispose();
});

test('慢速保存期间的新问题和权限进度保留，保存失败不发布伙伴或预算修改', async () => {
  const f = await fixture(), app = f.application;
  const gate = f.block();
  const editing = app.command('updateLimits', { costLimit: 2 }); await f.entered.promise;
  f.state.chats.push({ id: 'during-save', bookId: f.book.id, sessionId: 's', role: 'user', text: '工程数量', evidence: [], createdAt: 1, excluded: false });
  f.book.position = 12;
  gate.resolve(); await editing;
  assert.equal(f.state.chats[0].id, 'during-save'); assert.equal(f.book.position, 12);
  assert.equal(f.saved().settings.costBudgetId, f.state.settings.costBudgetId);
  await f.engine.persist(); assert.equal(f.saved().chats[0].id, 'during-save');
  const name = app.snapshot.state.partners[0].name;
  f.fail(true);
  await assert.rejects(app.command('updatePartner', 'default', '工程测试伙伴', '事实记录'), /保存失败/);
  assert.equal(app.snapshot.state.partners[0].name, name);
  await assert.rejects(app.command('updateLimits', { costLimit: 5 }), /保存失败/);
  assert.equal(app.snapshot.state.settings.costLimit, 2);
  f.fail(false); f.runtime.dispose();
});

test('界面退出订阅仍完成原问题，改名保留且删除聊天不删除记忆', async () => {
  const f = await fixture(), app = f.application;
  f.state.settings.services[0].enabled = true;
  await app.command('startReading', f.book.id);
  const conversation = f.engine.session!.id;
  await app.command('renameConversation', conversation, '工程核对');
  let updates = 0; const detach = app.subscribe(() => updates++); detach();
  await app.command('ask', f.book.id, '设备数量是多少？');
  assert.equal(updates, 0); assert.equal(app.snapshot.state.chats.length, 2);
  const memory = f.state.memories[0]; assert.ok(memory);
  await app.command('deleteChat', f.state.chats[1].id);
  assert.equal(f.state.memories.find(m => m.id === memory.id)?.forgotten, false);
  await app.command('forgetMemory', memory.id);
  assert.equal(f.state.memories.find(m => m.id === memory.id)?.forgotten, true);
  assert.ok(f.state.forgotten.some(m => m.id === memory.id));
  assert.equal(f.state.conversations[0].title, '工程核对'); assert.equal(f.state.conversations[0].manualTitle, true);
  await app.command('stop'); f.runtime.dispose();
});

test('配置正在启用时更改或关闭，旧完成事件不能重新启用服务', async () => {
  const f = await fixture(), app = f.application;
  f.secretGate.pending = deferred();
  const enabling = app.command('enableService', 'wechat', '');
  await app.command('updateService', 'wechat', { enabled: false });
  f.secretGate.pending.resolve(); await assert.rejects(enabling, /配置已改变|取消/);
  assert.equal(f.state.settings.services[0].enabled, false);
  f.secretGate.pending = undefined;
  await app.command('updateService', 'wechat', { inputPrice: 1 });
  await app.command('updateService', 'wechat', { inputPrice: null });
  assert.equal('inputPrice' in f.state.settings.services[0], false);
  await assert.rejects(app.command('updateService', 'wechat', { enabled: true } as any), /无效/);
  await assert.rejects(app.command('updateService', 'wechat', { contextLimit: 200001 }), /上下文/);
  const gate = f.block(), pending = app.command('enableSearch', ''); await f.entered.promise;
  const closing = app.command('disableSearch'); gate.resolve(); await assert.rejects(pending, /取消/); await closing;
  assert.equal(f.state.settings.searchEnabled, false); assert.equal(f.saved().settings.searchEnabled, false); f.runtime.dispose();
});

test('备份正文只按导出命令提供，密钥可选且恢复不自动开启服务', async () => {
  const f = await fixture(), app = f.application;
  f.state.settings.services[0].enabled = true;
  const raw = await app.command('exportBackup', false);
  assert.equal(JSON.parse(raw).books[0].text, original); assert.equal('secrets' in JSON.parse(raw), false);
  assert.equal(f.calls.includes('exportSecrets'), false);
  const keyed = await app.command('exportBackup', true); assert.ok(JSON.parse(keyed).secrets.wechat);
  assert.deepEqual(await app.command('previewBackup', keyed), { books: 1, chats: 0, hasSecrets: true });
  const returned = await app.command('restoreBackup', keyed, false);
  assert.equal(returned.bookId, f.book.id); assert.equal('secrets' in f.engine.state, false);
  assert.equal(f.engine.state.settings.services[0].enabled, false); assert.equal(f.engine.session?.active ?? false, false);
  assert.equal(f.calls.includes('saveSecret'), false); f.runtime.dispose();
});

test('资料恢复后密钥导入失败会返回单独结果，已恢复资料仍可显示且服务保持关闭', async () => {
  const f = await fixture(), raw = await f.application.command('exportBackup', true);
  const app = new LocalApplication(f.runtime, async () => { throw new Error('宿主密钥存储不可用'); });
  const restored = await app.command('restoreBackup', raw, true);
  assert.equal(restored.bookId, f.book.id); assert.match(restored.secretError!, /部分服务密钥/);
  assert.equal(app.snapshot.state.settings.services[0].enabled, false);
  assert.equal('secrets' in f.engine.state, false); f.runtime.dispose();
});

test('数据恢复写盘期间阻止另一界面开启任务，失败后保留原记录且可以继续操作', async () => {
  const f = await fixture(), app = f.application;
  const raw = await app.command('exportBackup', false), gate = f.block();
  const restoring = app.command('restoreBackup', raw, false); await f.entered.promise;
  await assert.rejects(app.command('startReading', f.book.id), /恢复备份/);
  gate.resolve(); await restoring;
  await app.command('startReading', f.book.id); await app.command('stop');
  const before = f.engine.state; f.fail(true);
  await assert.rejects(app.command('restoreBackup', raw, false), /保存失败/);
  assert.equal(f.engine.state, before);
  f.fail(false); await app.command('setArchived', f.book.id, true);
  assert.equal(app.snapshot.state.books[0].archived, true); f.runtime.dispose();
});
