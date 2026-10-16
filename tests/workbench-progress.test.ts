import test from 'node:test';
import assert from 'node:assert/strict';
import { chapterBodyCoverage } from '../src/workbench/reading-layout.ts';

test('整章标题与空白不制造正文理解缺口，真实获准正文欠缺仍保留', () => {
  const text = '第一章 工程记录\n  已经理解。\n\n 尚未读入。\n\n', bodyStart = text.indexOf('已经理解。'), bodyEnd = bodyStart + '已经理解。'.length, nextStart = text.indexOf('尚未读入。'), nextEnd = nextStart + '尚未读入。'.length;
  const full = chapterBodyCoverage(text, 0, '第一章 工程记录', { known: [{ start: 0, end: text.length }], prepared: [{ start: bodyStart, end: bodyEnd }, { start: nextStart, end: nextEnd }] });
  assert.equal(full.authorized, true); assert.equal(full.coverage.status, 'complete'); assert.equal(full.coverage.missingChars, 0);
  const actualGap = chapterBodyCoverage(text, 0, '第一章 工程记录', { known: [{ start: 0, end: text.length }], prepared: [{ start: bodyStart, end: bodyEnd }] });
  assert.equal(actualGap.coverage.status, 'partial'); assert.equal(actualGap.coverage.missingChars, nextEnd - nextStart);
  const partialPermission = chapterBodyCoverage(text, 0, '第一章 工程记录', { known: [{ start: bodyStart, end: bodyEnd }], prepared: [{ start: bodyStart, end: bodyEnd }] });
  assert.equal(partialPermission.authorized, false); assert.equal(partialPermission.coverage.status, 'complete'); assert.equal(partialPermission.coverage.allowedChars, bodyEnd - bodyStart);
});
