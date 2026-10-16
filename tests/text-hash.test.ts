import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { importBook } from '../src/core/books.ts';
import { configureTextHasher } from '../src/core/text-hash.ts';

test('正文规范化后再计算版本，中文、表情与孤立代理字符符合UTF-8规则', async () => {
  const raw = '\uFEFF第一章 工程\r\n甲乙🙂\0\ud800\r记录';
  const book = await importBook('工程.txt', raw);
  assert.equal(book.text, '第一章 工程\n甲乙🙂\0\ud800\n记录');
  assert.equal(book.version, createHash('sha256').update(book.text, 'utf8').digest('hex'));
});
test('嵌入宿主直接接收规范化全文，导入不再把正文展开为跨桥数值数组', async () => {
  const text = '第一章 工程\n' + '长篇工程记录。'.repeat(150000); let received = '';
  configureTextHasher(async value => { received = value; return createHash('sha256').update(value).digest('hex'); });
  try {
    const book = await importBook('工程规模', text); assert.equal(received, text);
    assert.equal(book.version, createHash('sha256').update(text).digest('hex')); assert.equal(book.known.length, 0);
  } finally { configureTextHasher(); }
});
test('宿主散列失败或返回无效版本时中止导入', async () => {
  try {
    configureTextHasher(async () => 'not-a-version'); await assert.rejects(importBook('工程', '正文'), /版本计算失败/);
    configureTextHasher(async () => { throw new Error('本地计算失败'); }); await assert.rejects(importBook('工程', '正文'), /本地计算失败/);
  } finally { configureTextHasher(); }
});
