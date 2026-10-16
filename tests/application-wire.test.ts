import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationServer } from '../src/core/application-wire.ts';
import { RemoteApplication } from '../src/platform/remote-application.ts';
import { ReadingEngine } from '../src/core/engine.ts';
import { ReadingRuntime } from '../src/core/runtime.ts';
import { LocalApplication } from '../src/core/application.ts';
import { initialState } from '../src/core/state.ts';
import { validateMigration } from '../src/core/migration.ts';
import { pageText } from '../src/core/page-text.ts';
import type { ApplicationFrame, ApplicationRequest, ApplicationResult } from '../src/core/application-wire.ts';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; }
async function fixture() {
  const state = initialState();
  const engine = new ReadingEngine(state, { async load() { return undefined; }, async save() {} }, { async complete() { throw new Error('此检查不能调用模型'); } });
  const runtime = new ReadingRuntime(engine, { available: false, async request() { return {} as never; } });
  const local = new LocalApplication(runtime, async () => ({} as never));
  const book = await local.command('importText', '工程资料', '第一章 工程\n设备AX为3件。\n第二章 后文\n尚未允许');
  let remote: RemoteApplication;
  const emitted: { kind: string; value: any }[] = [];
  const server = new ApplicationServer(local, (kind, value) => { emitted.push({ kind, value: structuredClone(value) }); if (kind === 'frame') remote?.receive(structuredClone(value) as ApplicationFrame); else remote?.result(structuredClone(value) as ApplicationResult); });
  remote = new RemoteApplication(server.frame(), r => { void server.receive(structuredClone(r)); }, (epoch, sequence) => server.acknowledge(epoch, sequence));
  return { state, engine, runtime, local, server, remote, emitted, bookId: book.bookId };
}
test('序列化命令实际修改核心，返回前更新界面快照且重复投递只执行一次', async () => {
  const f = await fixture();
  const id = await f.remote.command('newDiscussion', f.bookId);
  assert.equal(f.remote.snapshot.state.conversations[0].id, id);
  const request: ApplicationRequest = { id: crypto.randomUUID(), epoch: f.server.epoch, name: 'newDiscussion', args: [f.bookId] };
  await Promise.all([f.server.receive(request), f.server.receive(structuredClone(request))]);
  assert.equal(f.state.conversations.length, 2);
  await f.server.receive({ ...request, name: 'stop', args: [] });
  assert.match(f.emitted.at(-1)!.value.error, /不同请求/);
  await f.remote.command('stop'); f.runtime.dispose();
});
test('旧实例、错误参数和乱序快照不能重新启动任务或回退阅读界面', async () => {
  const f = await fixture(), prior = f.server.frame();
  await f.remote.command('setArchived', f.bookId, true); const revision = f.remote.snapshot.revision;
  f.remote.receive(prior); assert.equal(f.remote.snapshot.revision, revision); assert.equal(f.remote.snapshot.state.books[0].archived, true);
  await f.server.receive({ id: crypto.randomUUID(), epoch: 'old-core', name: 'startReading', args: [f.bookId] });
  assert.match(f.emitted.at(-1)!.value.error, /重新启动/); assert.equal(f.engine.session, undefined);
  await f.server.receive({ id: crypto.randomUUID(), epoch: f.server.epoch, name: 'quiet', args: ['true'] });
  assert.match(f.emitted.at(-1)!.value.error, /参数类型/); f.runtime.dispose();
});

test('正常传输中省略的可选参数沿用默认值，确认章节不会把起始位置变成null', async () => {
  const f = await fixture(), book = f.engine.book(f.bookId), end = book.chapters[0].end;
  await f.remote.command('setKnown', book.id, end);
  assert.equal(book.position, end); assert.deepEqual(book.known, [{ start: 0, end }]);
  const request: ApplicationRequest = { id: crypto.randomUUID(), epoch: f.server.epoch, name: 'setKnown', args: [book.id, end, null] };
  await f.server.receive(JSON.parse(JSON.stringify(request)));
  assert.equal(f.emitted.at(-1)!.value.error, undefined); assert.deepEqual(book.known, [{ start: 0, end }]);
  f.runtime.dispose();
});

test('定位预览经序列化传到界面，确认命令只接受当前定位标识', async () => {
  const f = await fixture(), book = f.engine.book(f.bookId);
  // This case exercises the explicit legacy location preview, not automatic companion observation.
  book.readingStrategy='structured';
  await f.remote.command('startReading', book.id); f.engine.observing(true);
  await f.engine.observe(book.id, book.text.slice(0, book.chapters[0].end));
  f.server.publish(); const location = f.remote.snapshot.locatedPosition!;
  assert.ok(location); assert.deepEqual(book.known, []);
  await assert.rejects(f.remote.command('confirmLocatedPosition', book.id, 'stale-location'), /定位结果已更新/);
  await f.remote.command('confirmLocatedPosition', book.id, location.id);
  assert.deepEqual(book.known, [{ start: 0, end: location.position }]);
  assert.equal(f.remote.snapshot.locatedPosition, undefined); assert.equal(f.remote.snapshot.session?.prepared, false);
  assert.equal(f.state.usage.length, 0); f.runtime.dispose();
});

test('大文件导入的在途重复请求只执行一次，变更正文被拒绝，完成后不缓存全文回执', async () => {
  const f = await fixture(), entered = deferred(), release = deferred(); let calls = 0;
  f.engine.store.save = async () => { calls++; entered.resolve(); await release.promise; };
  const request: ApplicationRequest = { id: crypto.randomUUID(), epoch: f.server.epoch, name: 'importText', args: ['工程大文件', '工程记录。'.repeat(7000)] };
  const first = f.server.receive(request); await entered.promise;
  const repeated = f.server.receive(structuredClone(request));
  await f.server.receive({ ...request, args: [request.args[0], String(request.args[1]) + '修改'] });
  assert.match(f.emitted.at(-1)!.value.error, /不同请求/);
  release.resolve(); await Promise.all([first, repeated]); assert.equal(calls, 1); assert.equal(f.state.books.length, 2);
  await f.server.receive(structuredClone(request)); assert.equal(calls, 1); assert.match(f.emitted.at(-1)!.value.error, /已完成/);
  f.runtime.dispose();
});
test('界面重连取得最新状态和未确认提示，消费后不重复', async () => {
  const f = await fixture(); await f.local.command('startReading', f.bookId);
  f.runtime.reportError(new Error('工程提示')); const frame = f.server.frame();
  const reconnected = new RemoteApplication(frame, r => { void f.server.receive(r); }, (epoch, sequence) => f.server.acknowledge(epoch, sequence));
  assert.equal(reconnected.takeUIEvents()[0].kind, 'error');
  reconnected.receive(f.server.frame()); assert.equal(reconnected.takeUIEvents().length, 0);
  await f.local.command('stop'); assert.equal(f.server.frame().snapshot.session?.active, false); f.runtime.dispose();
});
test('核心重启拒绝旧界面未完成的等待，不自动重发操作', async () => {
  const f = await fixture(); let sends = 0;
  const remote = new RemoteApplication(f.server.frame(), () => { sends++; }, () => {});
  const pending = remote.command('prepare', f.bookId);
  const rejected = assert.rejects(pending, /重启/);
  remote.receive({ ...f.server.frame(), epoch: crypto.randomUUID() }); await rejected;
  assert.equal(sends, 1); f.runtime.dispose();
});
test('迁移保留原服务选择、权限、记忆与用量，失去执行者的任务整理为手动接续', async () => {
  const f = await fixture(); const book = f.engine.book(f.bookId);
  await f.local.command('setKnown', book.id, book.chapters[0].end); await f.local.command('startReading', book.id);
  f.state.settings.services[0].enabled = true; f.state.settings.searchEnabled = true;
  f.state.usage.push({ id: 'unfinished', serviceId: 'wechat', purpose: '工程调用', time: 1, input: 50, output: 20, estimated: true, status: 'reserved' });
  f.state.chats.push({ id: 'pending', bookId: book.id, sessionId: f.engine.session!.id, text: '数量', role: 'user', evidence: [{ bookId: book.id, version: book.version, start: 0, end: book.position }], createdAt: 1, excluded: false, delivery: 'pending' });
  const result = await validateMigration(f.state);
  assert.equal(result.state.settings.services[0].enabled, true); assert.equal(result.state.settings.searchEnabled, true);
  assert.deepEqual(result.state.books[0].known, book.known); assert.deepEqual(result.state.resume, f.state.resume);
  assert.equal(result.state.chats[0].delivery, 'failed'); assert.equal(result.state.usage[0].status, 'unknown'); assert.equal(result.state.usage[0].input, 50);
  assert.equal(result.recovery.questions, 1); assert.equal(result.recovery.unknownCalls, 1); f.runtime.dispose();
});
test('无浏览器解析保留正文、中文与实体，排除脚本导航并限制输出体积', () => {
  const page = pageText('https://example.org', '<head><title>资料 &amp; 工程</title></head><nav>导航</nav><main><p>外围</p><article><p>设备&#65;X &lt; 4</p><script src="https://evil.invalid/x">执行</script><form>提交</form><p>后续记录</p></article></main>');
  assert.equal(page.title, '资料 & 工程'); assert.match(page.extract, /设备AX < 4/); assert.match(page.extract, /后续记录/);
  assert.doesNotMatch(page.extract, /外围|导航|执行|提交/);
  assert.ok(pageText('https://example.org/', '<p>' + '甲'.repeat(100000) + '</p>').extract.length <= 18000);
  assert.throws(() => pageText('https://wikipedia.org./', '<p>来源</p>'));
});
