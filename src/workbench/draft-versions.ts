import type {BookView} from '../core/application-contract.ts';
import type {WorkbenchDraft} from './contract.ts';
import {bookVersionPrefixLength,bookVersionAllowsRange} from '../core/book-versions.ts';

/** Only the same conversation or exact paragraph coordinates may inherit a
 * draft. The certified prefix keeps the source bytes unchanged. */
export function currentDraftKey(book:BookView,key:string):string|undefined{
 let identity:unknown;try{identity=JSON.parse(key);}catch{return;}
 if(!Array.isArray(identity))return;
 const [kind,bookId,version,start,end]=identity;
 if(bookId!==book.id||typeof version!=='string'||bookVersionPrefixLength(book,version)===undefined)return;
 if(kind==='message'&&(identity.length!==4||start!==null&&typeof start!=='string'))return;
 if(kind==='paragraph'&&(identity.length!==5||!bookVersionAllowsRange(book,version,{start,end})))return;
 if(kind!=='message'&&kind!=='paragraph')return;
 return JSON.stringify([kind,bookId,book.version,...identity.slice(3)]);
}

export function inheritedDrafts(book:BookView,drafts:Record<string,WorkbenchDraft>):Record<string,WorkbenchDraft>{
 const added:Record<string,WorkbenchDraft>={};
 for(const [key,draft]of Object.entries(drafts)){
  const current=currentDraftKey(book,key);if(!current||current===key||drafts[current])continue;
  if(!added[current]||added[current].updatedAt<draft.updatedAt)added[current]={...draft};
 }
 return added;
}
