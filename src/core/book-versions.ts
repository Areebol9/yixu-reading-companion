import {validateBookChapters} from './book-directory.ts';
import type {Book,Range} from './types.ts';
import {bookLength,importBook} from './books.ts';
import {hashText} from './text-hash.ts';

type VersionBoundary=Pick<Book,'version'|'sourceLineage'>&{text?:string;textLength?:number};
export function bookVersionPrefixLength(book:VersionBoundary,version:string):number|undefined{
  if(version===book.version)return book.textLength??book.text?.length??0;
  if(book.sourceLineage?.currentVersion!==book.version)return undefined;
  return book.sourceLineage.prefixes.find(prefix=>prefix.version===version)?.chars;
}
export function bookVersionAllowsRange(book:VersionBoundary,version:string,range:Range):boolean{
  const length=bookVersionPrefixLength(book,version);return length!==undefined&&Number.isSafeInteger(range.start)&&Number.isSafeInteger(range.end)&&range.start>=0&&range.end>range.start&&range.end<=length;
}
export function bookVersionAllowsRanges(book:Book,version:string,ranges:readonly Range[]):boolean{
  return (version===book.version||ranges.length>0)&&ranges.every(range=>bookVersionAllowsRange(book,version,range));
}
/** A historical task retains its exact original identity and permitted extent. */
export function resolveBookVersion(book:Book|undefined,version:string):Book|undefined{
  if(!book)return undefined;
  const length=bookVersionPrefixLength(book,version);if(length===undefined)return undefined;if(version===book.version)return book;
  const clip=(ranges:readonly Range[]|undefined)=>ranges?.filter(range=>range.start<length).map(range=>({start:range.start,end:Math.min(range.end,length)}));
  const earlier=book.sourceLineage?.prefixes.filter(prefix=>prefix.chars<length)??[];
  return{...book,version,text:book.text?book.text.slice(0,length):'',textLength:length,sourceLineage:earlier.length?{currentVersion:version,prefixes:earlier}:undefined,
    chapters:book.chapters.filter(chapter=>chapter.start<length).map(chapter=>({...chapter,end:Math.min(chapter.end,length),...(chapter.contentEnd!==undefined?{contentEnd:Math.min(chapter.contentEnd,length)}:{})})),
    position:Math.min(book.position,length),known:clip(book.known)!,prepared:clip(book.prepared)!,buffered:clip(book.buffered),backgroundPrepared:clip(book.backgroundPrepared),fullOriginalPending:clip(book.fullOriginalPending),
    residentRanges:book.residentRanges?.filter(range=>range.start<length).map(range=>({...range,end:Math.min(range.end,length),text:range.text.slice(0,length-range.start)})),
    sceneObserved:book.sceneObserved?.map(item=>({...item,ranges:clip(item.ranges)!})),
  };
}
/** Runs only on source installation/import/cold recovery, never on page turns. */
export async function validateBookSourceLineage(book:Book,readOriginal?:(version:string)=>Promise<string>):Promise<void>{
  const lineage=book.sourceLineage;if(!lineage)return;
  if(!lineage||lineage.currentVersion!==book.version||!Array.isArray(lineage.prefixes)||!lineage.prefixes.length)throw Error('原文版本接续证明无效');
  const current=book.text.length===bookLength(book)?book.text:await readOriginal?.(book.version);
  if(typeof current!=='string'||current.length!==bookLength(book)||await hashText(current)!==book.version)throw Error('当前原文与版本接续证明不符');
  const seen=new Set<string>();
  for(const prefix of lineage.prefixes){
    if(!prefix||!/^[a-f0-9]{64}$/.test(prefix.version)||prefix.version===book.version||seen.has(prefix.version)||!Number.isSafeInteger(prefix.chars)||prefix.chars<=0||prefix.chars>=current.length||!Number.isSafeInteger(prefix.chapters)||prefix.chapters<1)throw Error('前缀版本接续边界无效');
    seen.add(prefix.version);const text=current.slice(0,prefix.chars);
    if(await hashText(text)!==prefix.version)throw Error('前缀原文与旧版本不一致');
    if(readOriginal){const original=await readOriginal(prefix.version);if(original!==text||await hashText(original)!==prefix.version)throw Error('旧原文仓与已验前缀不一致');}
  }
}
export function bodyChapterCount(book:{chapters:readonly {title:string;kind?:string}[];directory?:{entries:readonly {title:string;kind?:string}[]}}):number{return(book.directory?.entries??book.chapters).filter(chapter=>chapter.kind?chapter.kind==='chapter':/^(?:第[零〇一二三四五六七八九十百千万两\d]+章|chapter\s+\d+)/iu.test(chapter.title)).length;}
/** Explicit one-time source extension. Existing permissions and records retain
 * their coordinates; no appended text becomes read or prepared. */
export async function prepareBookSourceExtension(book:Book,oldText:string,raw:string,title=book.title):Promise<Book>{
  if(oldText.length!==bookLength(book)||await hashText(oldText)!==book.version)throw Error('当前原文身份尚未核实，未接续来源');
  await validateBookSourceLineage({...book,text:oldText});
  const full=await importBook(title,raw);
  if(full.text.length<=oldText.length||!full.text.startsWith(oldText))throw Error('新来源未完整保留原文前缀，未更换书籍版本');
  if(!full.chapters.some(chapter=>chapter.start===oldText.length))throw Error('原文件末尾未对应新来源章节边界，未自动接续');
  validateBookChapters(book.chapters,oldText.length);
  const appended=full.chapters.filter(chapter=>chapter.start>=oldText.length).map((chapter,index)=>({...chapter,index:book.chapters.length+index,parentIndex:undefined}));
  const prefixes=[...(book.sourceLineage?.prefixes??[]),{version:book.version,chars:oldText.length,chapters:bodyChapterCount(book)}];
  const next:Book={...book,title:full.title,version:full.version,text:full.text,textLength:full.text.length,chapters:[...book.chapters,...appended],directory:full.directory,sourceLineage:{currentVersion:full.version,prefixes},residentRanges:undefined};
  await validateBookSourceLineage(next);return next;
}
