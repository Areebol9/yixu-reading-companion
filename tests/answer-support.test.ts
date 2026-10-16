import test from 'node:test';
import assert from 'node:assert/strict';
import { importBook } from '../src/core/books.ts';
import { ReadingSources } from '../src/core/reading-sources.ts';
import { validateAnswerSupport } from '../src/core/answer-support.ts';
import { focusedExpressionReminder } from '../src/core/reading-output.ts';
import type { Book, Memory } from '../src/core/types.ts';

async function fixture() {
  const book = await importBook('ENGINE MOCK provenance', '登记员甲表示：校准仍未完成。\n次日，操作员乙完成校准。\n未读记录。');
  book.frontMatterIncluded = true;
  const end = book.text.indexOf('未读记录');
  book.known = [{ start: 0, end }];
  const sources = new ReadingSources();
  sources.render(book, book.known[0]);
  return { book, passages: sources.passages };
}

test('本轮原文与自然主张逐字并列，指定连续引文返回原字句UTF16位置', async () => {
  const { book, passages } = await fixture(), statement = '  ENGINE MOCK 待核：登记当时未完成，次日完成。  ';
  const quote = '次日，操作员乙完成校准。';
  const input = { claims: [{ statement, sourceId: 'p1', quote }] }, before = structuredClone(input);
  const result = validateAnswerSupport(book, passages, input);
  const start = book.text.indexOf(quote);
  assert.deepEqual(result.checks, [{ statement, sourceId: 'p1', quote, evidence: { bookId: book.id, version: book.version, start, end: start + quote.length } }]);
  assert.deepEqual(input, before);
  assert.equal(validateAnswerSupport(book, passages, { claims: [{ statement, sourceId: 'p1' }] }).checks[0].quote, passages.get('p1')!.text);
  // An incorrect claim is preserved for the current model to compare; matching
  // original words alone never certifies the statement's meaning.
  const wrong = 'ENGINE MOCK 登记当时校准已经完成。';
  assert.equal(validateAnswerSupport(book, passages, { claims: [{ statement: wrong, sourceId: 'p1', quote }] }).checks[0].statement, wrong);
});

test('非本轮p、别书版本、撤回许可和改写原段拒绝；已有p不扩大许可', async () => {
  const { book, passages } = await fixture();
  const input = { claims: [{ statement: 'ENGINE MOCK 校准状态待核。', sourceId: 'p1' }] };
  assert.throws(() => validateAnswerSupport(book, passages, { claims: [{ ...input.claims[0], sourceId: 'p99' }] }), /本轮/);
  const original = passages.get('p1')!;
  for (const invalid of [{ ...original, evidence: { ...original.evidence, bookId: 'other' } }, { ...original, evidence: { ...original.evidence, version: 'other' } }, { ...original, text: original.text.replace('仍未', '已经') }]) {
    assert.throws(() => validateAnswerSupport(book, new Map([['p1', invalid]]), input), /版本、阅读许可或原字句/);
  }
  const revoked: Book = { ...book, known: [{ start: 0, end: 5 }] };
  assert.throws(() => validateAnswerSupport(revoked, passages, input), /阅读许可/);
  assert.deepEqual(validateAnswerSupport(revoked, passages, input, [original.evidence]).checks[0].evidence, original.evidence);
  const invalidPosition: NonNullable<Memory['sourceQuote']> = { ...original, evidence: { ...original.evidence, start: 0.5 } };
  assert.throws(() => validateAnswerSupport(book, new Map([['p1', invalidPosition]]), input), /原字句/);
});

test('跳句拼接、删字和规范化伪引文拒绝，仅允许指定原段的连续字句', async () => {
  const { book, passages } = await fixture();
  for (const quote of ['登记员甲表示：校准仍未完成。次日，操作员乙完成校准。', '登记员甲表示：校准仍未完成。……次日，操作员乙完成校准。', '次日,操作员乙完成校准。', '校准已完成。']) {
    assert.throws(() => validateAnswerSupport(book, passages, { claims: [{ statement: 'ENGINE MOCK 校准状态待核。', sourceId: 'p1', quote }] }), /连续逐字/);
  }
  assert.throws(() => validateAnswerSupport(book, passages, { claims: [] }), /1至4/);
  assert.throws(() => validateAnswerSupport(book, passages, { claims: [{ statement: '检'.repeat(401), sourceId: 'p1' }] }), /400/);
});

test('事实长答同样提示按需核关键主张，感受交流继续自然回应', () => {
  assert.ok(focusedExpressionReminder('为什么校准当晚没有立即完成？', true));
  assert.ok(focusedExpressionReminder('分析登记与后续校准的时序，并确认关系。'.repeat(20), true));
  assert.equal(focusedExpressionReminder('这里给你什么感受？'), undefined);
  assert.equal(focusedExpressionReminder('是不是很心酸？'), undefined);
});
