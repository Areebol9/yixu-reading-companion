import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importBook, readingStart } from '../src/core/books.ts';
import { isEvidenceAllowed, readText, searchText, usableMemories } from '../src/core/context.ts';
import { ReadingEngine } from '../src/core/engine.ts';
import { initialState } from '../src/core/state.ts';
import { restoreBackup } from '../src/core/backup.ts';

const marker = 'UNREAD-FINAL-RECORD';
const original = `工程资料\n内容简介：\n末尾记录含${marker}，设备最终报废。\n第一章 登记\n工程设备AX现登记为3件，记录编号001。\n第二章 变更\n工程设备AX变更为5件。`;
test('界面只读元数据沿用原文权限，旧简介、未读、跨书及超长引用不显示', async () => {
  const book = await importBook('工程书', original), start = readingStart(book), end = book.chapters[1].end;
  const boundary = Object.freeze({ id: book.id, version: book.version, frontMatterEnd: book.frontMatterEnd, textLength: original.length, known: Object.freeze([{ start, end }]) });
  const ref = { bookId: book.id, version: book.version, start, end };
  assert.equal(isEvidenceAllowed(boundary, Object.freeze([Object.freeze(ref)])), true);
  for (const changed of [{ start: 0 }, { end: end + 1 }, { bookId: 'other' }, { version: 'other' }]) assert.equal(isEvidenceAllowed(boundary, [{ ...ref, ...changed }]), false);
  assert.equal(isEvidenceAllowed({ ...boundary, textLength: end - 1 }, [ref]), false);
  assert.equal(isEvidenceAllowed({ ...boundary, textLength: undefined }, [ref]), false);
});
async function fixture() {
  const state = initialState(), book = await importBook('工程书', original), inputs: string[] = [];
  state.books = [book]; state.settings.services[0].enabled = true;
  const engine = new ReadingEngine(state, { async load() { return state; }, async save() {} }, { async complete(_s,m) {
    inputs.push(JSON.stringify(m)); return { content: JSON.stringify({ reply: '', thoughts: [{ kind: 'story', text: inputs.at(-1)!.includes(marker) ? marker : '工程设备AX登记为3件。' }], wantsLong: false }), input: 1, output: 1, estimated: false, elapsedMs: 1 };
  } });
  return { state, book, engine, inputs };
}

test('明确的书前简介单独识别，正文中的简介措辞和正常序章不被误删', async () => {
  const f = await fixture(); assert.equal(readingStart(f.book), original.indexOf('第一章'));
  const prologue = await importBook('工程', '内容简介：\n后续摘要\n序章\n工程先导记录。\n第一章 登记\n数量为3。');
  assert.equal(readingStart(prologue), prologue.text.indexOf('序章'));
  const body = await importBook('工程', '第一章 登记\n内容简介：\n当前登记事项。\n第二章 变更\n新记录。'); assert.equal(readingStart(body), 0);
  const ordinary = await importBook('工程', '前言\n记录来源与日期。\n第一章 登记\n数量为3。'); assert.equal(readingStart(ordinary), 0);
});

test('确认章末和真实跟屏均不把简介授予模型，明确允许后可读，关闭后旧记忆退出并重新准备', async () => {
  const f = await fixture(), end = f.book.chapters[1].end;
  await f.engine.setKnown(f.book.id, end); assert.deepEqual(f.book.known, [{ start: readingStart(f.book), end }]);
  await f.engine.startReading(f.book.id);
  await f.engine.prepare(f.book.id); assert.equal(f.inputs.length, 1); assert.ok(!f.inputs[0].includes(marker));
  assert.throws(() => readText(f.book, { start: 0, end: readingStart(f.book) }), /超出/); assert.deepEqual(searchText(f.book, marker), []);
  f.engine.observing(true); await f.engine.observe(f.book.id, original.slice(0, readingStart(f.book)));
  assert.equal(f.inputs.length, 1); assert.equal(f.book.known[0].start, readingStart(f.book));
  await f.engine.setFrontMatterIncluded(f.book.id, true); assert.equal(readingStart(f.book), 0);
  await f.engine.prepare(f.book.id); assert.ok(f.inputs.at(-1)!.includes(marker));
  const old = f.state.memories.filter(m => m.evidence.some(e => e.start === 0)); assert.ok(old.length);
  await f.engine.setFrontMatterIncluded(f.book.id, false);
  assert.equal(f.engine.session?.prepared, false); assert.deepEqual(f.book.prepared, []);
  assert.ok(old.every(m => !usableMemories(f.state, f.book).includes(m)));
  await f.engine.prepare(f.book.id); assert.ok(!f.inputs.at(-1)!.includes(marker)); f.engine.stop();
});

test('旧资料首次加载补齐简介边界，不删除历史，受简介影响的准备覆盖不能被沿用', async () => {
  const f = await fixture(), end = f.book.chapters[1].end;
  delete f.book.frontMatterEnd; f.book.known = [{ start: 0, end }]; f.book.prepared = [{ start: 0, end }]; f.book.position = end;
  f.state.memories.push({ id: 'old', bookId: f.book.id, partnerId: f.state.partnerId, kind: 'story', text: marker, evidence: [{ bookId: f.book.id, version: f.book.version, start: 0, end }], source: 'preparation', parents: [], chatIds: [], forgotten: false, createdAt: 1 });
  await f.engine.startReading(f.book.id);
  assert.equal(f.engine.session?.prepared, false); assert.deepEqual(f.book.prepared, []); assert.ok(f.book.known[0].start > 0);
  assert.equal(f.state.memories.length, 1); assert.deepEqual(usableMemories(f.state, f.book), []); f.engine.stop();
});

test('恢复旧备份重新识别边界并退出简介记忆，伪造元数据不能把简介伪装成已读正文', async () => {
  const f = await fixture(), end = f.book.chapters[1].end;
  f.book.frontMatterEnd = 0; f.book.position = end; f.book.known = [{ start: 0, end }]; f.book.prepared = [{ start: 0, end }];
  const restored = await restoreBackup(JSON.stringify(f.state), initialState()), book = restored.books[0];
  assert.ok(readingStart(book) > 0); assert.deepEqual(book.prepared, []); assert.deepEqual(book.known, [{ start: readingStart(book), end }]);
  f.book.frontMatterIncluded = true;
  const allowed = await restoreBackup(JSON.stringify(f.state), initialState()); assert.equal(readingStart(allowed.books[0]), 0);
  const local = structuredClone(f.state); local.books[0].frontMatterIncluded = false;
  const revoked = await restoreBackup(JSON.stringify(f.state), local);
  assert.equal(revoked.books[0].frontMatterIncluded, false); assert.ok(readingStart(revoked.books[0]) > 0); assert.deepEqual(revoked.books[0].prepared, []);
});
