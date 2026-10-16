import { bookLength, hasBookText, releaseTextIndex, requireBookText,mergeRanges,covers,locateObservation } from './books.ts';
import {hashText} from './text-hash.ts';
import type { Book, Store,Range } from './types.ts';

export async function loadOriginalRanges(store:Store,book:Book,ranges:Range[]):Promise<void>{
  if(hasBookText(book))return;
  const missing=mergeRanges(ranges).filter(r=>!covers(book.residentRanges??[],r));if(!missing.length)return;
  if(!store.readBookRanges)throw Error('范围原文接口不可用，请先更新本机存储；未自动载入整书');
  const response=await store.readBookRanges(book.version,missing);
  if(response.version!==book.version||response.length!==bookLength(book)||response.pieces.length!==missing.length)throw Error('范围原文版本或长度不一致');
  for(let i=0;i<missing.length;i++){const expected=missing[i],piece=response.pieces[i];if(piece.start!==expected.start||piece.end!==expected.end||piece.text.length!==piece.end-piece.start||await hashText(piece.text)!==piece.hash)throw Error('范围原文正文校验失败');}
  book.residentRanges=[...(book.residentRanges??[]),...response.pieces.map(({start,end,text})=>({start,end,text}))];
}
export async function rangeOriginal(store:Store,book:Book,ranges:Range[]):Promise<Book>{
  const scoped:Book={...book,text:'',textLength:bookLength(book),residentRanges:[]};
  if(hasBookText(book)){scoped.residentRanges=ranges.map(r=>({...r,text:book.text.slice(r.start,r.end)}));return scoped;}
  await loadOriginalRanges(store,scoped,ranges);return scoped;
}
/** Chunked storage with the existing normalization/OCR resolver. Exhaust the
 * corpus before declaring uniqueness; a search window never grants permission. */
export async function locateRangeObservation(store:Store,book:Book,observed:string,coverage:'fragments'|'continuous-page'='fragments'):Promise<ReturnType<typeof locateObservation>>{
  if(hasBookText(book))return locateObservation(book,observed,coverage);
  if(!store.readBookRanges)throw Error('范围定位接口不可用');
  const matches=new Map<string,Extract<ReturnType<typeof locateObservation>,{status:'matched'}>>(),length=bookLength(book),overlap=Math.max(4096,observed.length*3);
  for(let start=0;start<length;start+=65536){
    const end=Math.min(length,start+65536+overlap),part=await rangeOriginal(store,book,[{start,end}]),text=part.residentRanges![0].text;
    const local:Book={...book,version:book.version+':'+start,text,textLength:text.length,residentRanges:undefined};
    const found=locateObservation(local,observed,coverage);releaseTextIndex(local.version);
    if(found.status==='ambiguous')return{status:'ambiguous'};
    if(found.status==='matched'){
      const range={start:found.range.start+start,end:found.range.end+start},ranges=found.ranges.map(r=>({start:r.start+start,end:r.end+start}));
      matches.set(JSON.stringify(ranges),{...found,range,ranges});if(matches.size>1)return{status:'ambiguous'};
    }
  }
  return matches.size?[...matches.values()][0]:{status:'missing'};
}

/** The active book stays resident; other originals are leased only while needed. */
export class Originals {
  private leases = new Map<Book, number>();
  private loading = new Map<Book, Promise<void>>();
  private recent?: Book;
  private store: Store; private books: () => Book[]; private active: () => string | undefined;
  constructor(store: Store, books: () => Book[], active: () => string | undefined) { this.store = store; this.books = books; this.active = active; }
  async use<T>(book: Book, operation: (book: Book) => T | Promise<T>): Promise<T> {
    this.leases.set(book, (this.leases.get(book) ?? 0) + 1);
    try { await this.ensure(book); return await operation(book); }
    finally {
      const count = this.leases.get(book)! - 1;
      if (count) this.leases.set(book, count); else this.leases.delete(book);
      this.prune();
    }
  }
  async ensure(book: Book): Promise<void> {
    if (hasBookText(book)) { this.recent = book; return; }
    if (!this.store.readBookText) { requireBookText(book); return; }
    let loading = this.loading.get(book);
    if (!loading) {
      loading = this.store.readBookText(book.version).then(text => {
        if (typeof text !== 'string' || text.length !== bookLength(book) || !text.length) throw new Error('原文长度校验失败，未继续读取');
        if (!this.books().includes(book)) throw new DOMException('资料已切换', 'AbortError');
        book.text = text; this.recent = book;
      }).finally(() => { this.loading.delete(book); this.prune(); });
      this.loading.set(book, loading);
    }
    await loading;
  }
  // Call only after new originals are saved. A store without a reload port keeps inline data.
  prune(): void {
    if (!this.store.readBookText) return;
    const books = this.books(), active = this.active();
    const idle = !active ? this.recent ?? books.slice().reverse().find(hasBookText) : undefined;
    for (const book of books) if (book.id !== active && book !== idle && !this.leases.has(book) && !this.loading.has(book) && hasBookText(book)) {
      book.textLength = bookLength(book); book.text = ''; releaseTextIndex(book.version);
    }
    if (this.recent && !books.includes(this.recent)) { releaseTextIndex(this.recent.version); this.recent = undefined; }
    this.store.retainBookTexts?.(books);
  }
}
