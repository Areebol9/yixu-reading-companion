import { evidence, readText } from './context.ts';
import type { Book, Memory, ModelMessage, Range } from './types.ts';

/** Stable, turn-local handles for short passages already shown to the model. */
export class ReadingSources {
  readonly passages = new Map<string, NonNullable<Memory['sourceQuote']>>();
  private byRange = new Map<string, string>();
  private nextId = 1;

  restore(passages: Iterable<[string, NonNullable<Memory['sourceQuote']>]>): void {
    this.passages.clear();this.byRange.clear();this.nextId=1;
    for(const [key,value]of passages){
      const q=structuredClone(value),r=q.evidence;
      this.passages.set(key,q);this.byRange.set(`${r.bookId}:${r.version}:${r.start}:${r.end}`,key);
      this.nextId=Math.max(this.nextId,Number(key.slice(1))+1);
    }
  }

  render(book: Book, range: Range, extra: Range[] = []): string {
    const raw = readText(book, range, extra), parts: string[] = [];
    let offset = 0;
    while (offset < raw.length) {
      let end = Math.min(raw.length, offset + 200);
      if (end < raw.length && raw.charCodeAt(end - 1) >= 0xd800 && raw.charCodeAt(end - 1) <= 0xdbff) end--;
      const lineEnd = raw.lastIndexOf('\n', end - 1);
      if (lineEnd > offset + 7) end = lineEnd + 1;
      const span = { start: range.start + offset, end: range.start + end }, text = raw.slice(offset, end);
      const key = `${book.id}:${book.version}:${span.start}:${span.end}`;
      let source = this.byRange.get(key);
      if (!source) {
        source = 'p' + this.nextId++; this.byRange.set(key, source);
        this.passages.set(source, { text, evidence: evidence(book, span) });
      }
      parts.push(`【${source}】${text}`); offset = end;
    }
    return parts.join('\n');
  }
  results<T extends { source: string; text: string; start?: number; end?: number }>(book: Book, results: T[], extra: Range[] = []): T[] {
    return results.map(r => r.source === '获准原文' && r.start !== undefined && r.end !== undefined
      ? { ...r, text: this.render(book, { start: r.start, end: r.end }, extra) } : r);
  }
  messages(book: Book, messages: ModelMessage[], extra: Range[] = []): ModelMessage[] {
    return messages.map(message => {
      if (message.role === 'system') return message;
      let data: any;
      try { data = JSON.parse(message.content); } catch { return message; }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return message;
      if (data.currentRange) data.current = this.render(book, data.currentRange, extra);
      for (const key of ['previousReadings', 'additionalReadings', 'supportingReadings']) if (Array.isArray(data[key])) data[key] = data[key].map((r: Range) => ({ ...r, text: this.render(book, r, extra) }));
      if (data.toolResults) data.toolResults = this.results(book, data.toolResults, extra);
      return { ...message, content: JSON.stringify(data) };
    });
  }
}
