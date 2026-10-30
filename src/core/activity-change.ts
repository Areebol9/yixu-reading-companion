import {bookLength,covers} from './books.ts';
import type {Book,Chat,Range,State,StateChangeSet} from './types.ts';

type Snapshot=undefined|null|string|number|boolean|Snapshot[]|{[key:string]:Snapshot};
type BookSnapshot={metadata:Snapshot;known:Range[];frontMatterIncluded:boolean};

/** Copy structural values, retaining primitive strings without serializing or
 * hashing prose. This also detects changes made in place before a save. Domain
 * records contain JSON values; undefined properties have no stored meaning. */
function snapshot(value:unknown):Snapshot{
  if(value===undefined||value===null||typeof value==='string'||typeof value==='number'||typeof value==='boolean')return value;
  if(Array.isArray(value))return value.map(snapshot);
  return Object.fromEntries(Object.entries(value as object).filter(([,value])=>value!==undefined).map(([key,value])=>[key,snapshot(value)]));
}
function same(before:Snapshot,value:unknown):boolean{
  if(before===value)return true;
  if(!before||!value||typeof before!=='object'||typeof value!=='object')return false;
  if(Array.isArray(before))return Array.isArray(value)&&before.length===value.length&&before.every((item,index)=>same(item,value[index]));
  if(Array.isArray(value))return false;
  const entries=Object.entries(value).filter(([,value])=>value!==undefined);
  return Object.keys(before).length===entries.length&&entries.every(([key,value])=>Object.hasOwn(before,key)&&same(before[key],value));
}
function chatSource(chat:Chat){
  const {presentationReceipt,emojiReactions,readerInteraction,...source}=chat;
  return source;
}
function bookSource(book:Book){
  const {text,residentRanges,position,sceneObserved,known,frontMatterIncluded,textLength,...metadata}=book;
  return {...metadata,textLength:bookLength(book)};
}
function bookSnapshot(book:Book):BookSnapshot{
  return {metadata:snapshot(bookSource(book)),known:book.known.map(({start,end})=>({start,end})),frontMatterIncluded:book.frontMatterIncluded===true};
}

/** Invalidation of the recovery inventory, not an activity or task store. It
 * retains only source snapshots for chat/book records and three small headers.
 * initialize is the one cold scan; apply visits only the actual changed rows.
 *
 * Engine calls apply after a successful commit, and increments its inventory
 * version only when true. Live owners, active request IDs and runtime controls
 * keep their existing independent cache dependencies. */
export class ActivityChangeCache{
  private initialized=false;
  private chats=new Map<string,Snapshot>();
  private books=new Map<string,BookSnapshot>();
  private headers=new Map<string,Snapshot>();
  private expansions:string[]=[];
  /** A grant expansion preserves old valid recovery records. The engine may
   * refresh blocked decisions for these books without rebuilding the archive's
   * entire recovery inventory. It must still check permission when executing. */
  get expandedBookIds():readonly string[]{return this.expansions;}

  initialize(state:State):void{
    this.chats.clear();this.books.clear();this.headers.clear();this.expansions=[];
    for(const chat of state.chats)this.chats.set(chat.id,snapshot(chatSource(chat)));
    for(const book of state.books)this.books.set(book.id,bookSnapshot(book));
    for(const key of ['settings','partnerId','resume'] as const)this.headers.set(key,snapshot(state[key]));
    this.initialized=true;
  }
  apply(changes:StateChangeSet,currentState:State):boolean{
    if(!this.initialized){this.initialize(currentState);return true;}
    this.expansions=[];let invalidate=false;
    for(const [name,change]of Object.entries(changes.collections)){
      if(!change)continue;
      if(name==='chats'){
        for(const id of change.remove??[]){if(this.chats.delete(id))invalidate=true;}
        for(const chat of new Map((changes.collections.chats?.put??[]).map(chat=>[chat.id,chat])).values()){
          const value=chatSource(chat);if(!this.chats.has(chat.id)||!same(this.chats.get(chat.id),value))invalidate=true;
          this.chats.set(chat.id,snapshot(value));
        }
      }else if(name==='books'){
        for(const id of change.remove??[]){if(this.books.delete(id))invalidate=true;}
        for(const book of new Map((changes.collections.books?.put??[]).map(book=>[book.id,book])).values()){
          const previous=this.books.get(book.id),included=book.frontMatterIncluded===true;
          const expanded=!!previous&&previous.known.every(range=>covers(book.known,range))&&(!previous.frontMatterIncluded||included);
          if(!previous||!same(previous.metadata,bookSource(book))||!expanded)invalidate=true;
          else if(book.known.some(range=>!covers(previous.known,range))||included&&!previous.frontMatterIncluded)this.expansions.push(book.id);
          this.books.set(book.id,bookSnapshot(book));
        }
      }else if(change.put?.length||change.remove?.length){
        // Durable task, fee, document, owner and withdrawal changes can alter a
        // recovery decision. Their existing operations already identify actual
        // writes, so no second record inventory or body comparison is needed.
        invalidate=true;
      }
    }
    for(const [key,value]of Object.entries(changes.set??{})){
      if(!same(this.headers.get(key),value))invalidate=true;
      this.headers.set(key,snapshot(value));
    }
    for(const key of changes.unset??[]){if(this.headers.get(key)!==undefined)invalidate=true;this.headers.set(key,undefined);}
    return invalidate;
  }
}
