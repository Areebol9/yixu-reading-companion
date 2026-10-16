import type { WorkbenchPage } from './contract.ts';

/** Only fully visible text lines inside the reader and browser viewport are offered. */
export function visibleReadingRange(paper: HTMLElement | null, content: HTMLElement | null, page?: WorkbenchPage) {
  if (!paper || !content || !page || !content.getClientRects().length) return;
  const box = paper.getBoundingClientRect();
  const top = Math.max(0, box.top + paper.clientTop), bottom = Math.min(window.innerHeight, box.bottom - paper.clientTop);
  if (bottom <= top) return;
  let first: number | undefined, last: number | undefined;
  for (const element of content.querySelectorAll<HTMLElement>('[data-reading-start]')) {
    const node = element.firstChild, offset = Number(element.dataset.readingStart), limit = Number(element.dataset.readingEnd);
    if (node?.nodeType !== Node.TEXT_NODE || !Number.isSafeInteger(offset) || !Number.isSafeInteger(limit)) continue;
    const text = node.textContent ?? '', length = text.length, bounds = element.getBoundingClientRect();
    if (!length || limit - offset !== length || offset < page.start || limit > page.end || bounds.bottom <= top || bounds.top >= bottom) continue;
    const range = document.createRange();
    const rect = (index: number) => { range.setStart(node, index); range.setEnd(node, index + 1); return range.getBoundingClientRect(); };
    const lowerBound = (test: (index: number) => boolean) => { let low = 0, high = length; while (low < high) { const middle = (low + high) >>> 1; if (test(middle)) high = middle; else low = middle + 1; } return low; };
    let start = lowerBound(index => rect(index).top >= top), end = lowerBound(index => rect(index).bottom > bottom);
    if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start] ?? '')) start++;
    if (end > 0 && /[\uDC00-\uDFFF]/u.test(text[end] ?? '')) end--;
    if (end <= start || !text.slice(start, end).trim()) continue;
    first ??= offset + start; last = offset + end;
  }
  // Only original-text spans participate: tools, paragraph comments and labels are excluded.
  if (first !== undefined && last !== undefined && last > first) return { start: first, end: last };
}

export function restoreReadingPosition(paper: HTMLElement | null, content: HTMLElement | null, position: number) {
  if (!paper || !content) return;
  paper.scrollTop = 0;
  if (position <= Number(content.querySelector<HTMLElement>('[data-reading-start]')?.dataset.readingStart ?? position)) return;
  const target = [...content.querySelectorAll<HTMLElement>('[data-reading-start]')].find(element => Number(element.dataset.readingEnd) > position);
  const node = target?.firstChild;
  if (!target || node?.nodeType !== Node.TEXT_NODE) return;
  const index = Math.max(0, Math.min((node.textContent?.length ?? 1) - 1, position - Number(target.dataset.readingStart)));
  const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + 1);
  paper.scrollTop = Math.max(0, range.getBoundingClientRect().top - paper.getBoundingClientRect().top - 24);
}
