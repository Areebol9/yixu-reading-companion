import type { Chapter } from '../core/types.ts';
import { covers } from '../core/books.ts';
import { readingCoverage } from '../core/reading-progress.ts';

export const isVolumeHeading = (title: string) => /^第[零〇一二三四五六七八九十百千万两\d]+[卷部集](?:\s|[：:]|$)/u.test(title);

/** Layout keeps the book's original UTF-16 coordinates, including line breaks. */
export function readingParagraphs(text: string, start: number, title: string) {
  const lines: { start: number; end: number; text: string; heading: boolean }[] = [];
  let first = true;
  for (const match of text.matchAll(/[^\n]+/gu)) {
    if (!match[0].trim()) continue;
    const offset = start + match.index!;
    lines.push({ start: offset, end: offset + match[0].length, text: match[0], heading: first && match[0].trim() === title });
    first = false;
  }
  return lines;
}

/** The rendered chapter title and whitespace are layout, not unread body text. */
export function chapterBodyCoverage(text: string, start: number, title: string, book: Parameters<typeof readingCoverage>[0]) {
  const body = readingParagraphs(text, start, title).filter(paragraph => !paragraph.heading).flatMap(paragraph =>
    [...paragraph.text.matchAll(/\S+/gu)].map(match => ({ start: paragraph.start + match.index!, end: paragraph.start + match.index! + match[0].length })));
  const counts = body.reduce((total, range) => {
    const next = readingCoverage(book, range);
    return { allowedChars: total.allowedChars + next.allowedChars, preparedChars: total.preparedChars + next.preparedChars, missingChars: total.missingChars + next.missingChars };
  }, { allowedChars: 0, preparedChars: 0, missingChars: 0 });
  const known = book.known.map(item => ({ ...item }));
  return { authorized: body.length > 0 && body.every(range => covers(known, range)), coverage: { ...counts, status: (!counts.allowedChars ? 'none' : counts.missingChars ? 'partial' : 'complete') as 'none' | 'partial' | 'complete' } };
}

export function chapterReadingRange(chapters: readonly Chapter[], boundary: number, position: number, original: string|number, pureVolumeHeadings:ReadonlySet<number>=new Set()) {
  const length = typeof original==='string'?original.length:original;
  let target = Math.max(boundary, Math.min(position, Math.max(boundary, length - 1)));
  const readable = chapters.filter(item => item.end > boundary && !pureVolumeHeadings.has(item.index) && !(typeof original==='string'&&isVolumeHeading(item.title)&&original.slice(item.start,item.end).trim()===item.title));
  const chapter = readable.find(item => item.start <= target && item.end > target) ?? readable.find(item => item.start >= target) ?? readable.at(-1);
  if (!chapter) return;
  target = Math.max(Math.max(boundary, chapter.start), Math.min(target, chapter.end - 1));
  const index = readable.findIndex(item => item.index === chapter.index);
  return {
    chapter, start: Math.max(boundary, chapter.start), end: Math.min(length, chapter.end), position: target,
    firstReadingSection: index === 0,
    previousChapterStart: readable[index - 1] ? Math.max(boundary, readable[index - 1].start) : undefined,
    nextChapterStart: readable[index + 1]?.start,
  };
}
