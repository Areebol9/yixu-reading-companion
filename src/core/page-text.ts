import { Parser } from 'htmlparser2';
import { publicWebUrl } from './web.ts';
import type { WebPage } from './web.ts';

// Streaming, non-rendering parser: no DOM, resource loads or script execution.
export function pageText(url: string, html: string): WebPage {
  const address = publicWebUrl(url);
  const excluded = new Set(['script','style','iframe','object','noscript','svg','math','nav','footer','header','aside','form','button','input','textarea','select']);
  const blocks = new Set(['p','h1','h2','h3','h4','h5','li','br','tr','div','section']);
  const stack: string[] = [], buffers = { title: '', body: '', article: '', main: '' };
  let hidden = 0, title = 0, article = 0, main = 0, head = 0;
  const append = (key: keyof typeof buffers, text: string) => { const limit = key === 'title' ? 240 : 18000; if (buffers[key].length < limit) buffers[key] += text.slice(0, limit - buffers[key].length); };
  const text = (value: string) => {
    if (hidden) return;
    if (title) append('title', value);
    if (!head) { append('body', value); if (article) append('article', value); if (main) append('main', value); }
  };
  new Parser({
    onopentag(name) {
      if (stack.length > 2048) throw new Error('网页结构过深，未继续处理');
      stack.push(name); if (excluded.has(name)) hidden++;
      if (name === 'title') title++; if (name === 'head') head++; if (name === 'article') article++; if (name === 'main') main++;
      if (blocks.has(name)) text('\n');
    },
    ontext: text,
    onclosetag(name) {
      if (blocks.has(name)) text('\n');
      stack.pop(); if (excluded.has(name)) hidden--;
      if (name === 'title') title--; if (name === 'head') head--; if (name === 'article') article--; if (name === 'main') main--;
    },
  }, { decodeEntities: true }).end(html.slice(0, 2_000_000));
  const clean = (value: string) => value.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
  return { title: clean(buffers.title) || address.hostname, url: address.toString(), extract: clean(buffers.article || buffers.main || buffers.body) };
}
