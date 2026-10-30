import type {Observations} from './events.ts';
import type {WorkbenchDraft,AutoReadingSettings} from './contract.ts';
import type {State} from '../core/types.ts';
import {bookLength} from '../core/books.ts';
import {validateAutoReading} from './auto-reading.ts';
import {bookVersionPrefixLength,bookVersionAllowsRange,resolveBookVersion} from '../core/book-versions.ts';

export function validateWorkbenchDraft(state:State,key:string,value:WorkbenchDraft|null){
 let identity:unknown;try{identity=JSON.parse(key);}catch{throw Error('草稿定位无效');}
 if(!Array.isArray(identity)||!['message','paragraph'].includes(identity[0]))throw Error('草稿类型无效');
 const [kind,bookId,version,start,end]=identity,book=state.books.find(book=>book.id===bookId&&bookVersionPrefixLength(book,version)!==undefined);if(!book)throw Error('草稿不属于当前书籍版本');
 if(kind==='message'&&(identity.length!==4||start!==null&&!state.conversations.some(item=>item.id===start&&item.bookId===bookId)))throw Error('草稿话题不属于本书');
 if(kind==='paragraph'&&(identity.length!==5||!bookVersionAllowsRange(book,version,{start,end})))throw Error('草稿段落定位无效');
 if(value!==null&&(!value||typeof value.text!=='string'||!Number.isFinite(value.updatedAt)||value.parentId!==undefined&&(kind!=='paragraph'||typeof value.parentId!=='string')))throw Error('草稿字段无效');
}
/** UI metadata is restored separately and never becomes model material or a chat. */
export function takeBackupWorkbenchMetadata(state:State):Partial<ObservationMetadata>{
 const envelope=state as unknown as Record<string,unknown>,value=envelope.workbenchMetadata as Record<string,unknown>|undefined;delete envelope.workbenchMetadata;
 if(value===undefined)return{};if(!value||value.schema!=='yixu-workbench-metadata/v1')throw Error('备份界面记录格式无效');
 const {schema:_,...metadata}=value;
 if(metadata.selectedBookId!==undefined&&metadata.selectedBookId!==''&&!state.books.some(book=>book.id===metadata.selectedBookId)||metadata.pagePosition!==undefined&&(!Number.isSafeInteger(metadata.pagePosition)||Number(metadata.pagePosition)<0)||metadata.pageChars!==undefined&&(!Number.isSafeInteger(metadata.pageChars)||Number(metadata.pageChars)<=0)||metadata.importedHistory!==undefined&&typeof metadata.importedHistory!=='string')throw Error('备份浏览位置记录无效');
 if(metadata.drafts!==undefined){if(!metadata.drafts||typeof metadata.drafts!=='object'||Array.isArray(metadata.drafts))throw Error('备份草稿格式无效');for(const [key,draft]of Object.entries(metadata.drafts))validateWorkbenchDraft(state,key,draft as WorkbenchDraft);}
 if(metadata.autoReadingSettings!==undefined){const settings=metadata.autoReadingSettings as AutoReadingSettings,book=resolveBookVersion(state.books.find(book=>book.id===settings?.bookId),settings?.version);if(!book)throw Error('备份自动伴读设置不属于本存档');validateAutoReading(settings,book);}
 if(metadata.observations!==undefined){const log=metadata.observations as Observations;if(!log||!Array.isArray(log.events)||['ratings','timings','questions','readyDomains'].some(key=>!log[key as keyof Observations]||typeof log[key as keyof Observations]!=='object'||Array.isArray(log[key as keyof Observations])))throw Error('备份观察记录格式无效');}
 return Object.fromEntries(['drafts','observations','pagePosition','selectedBookId','pageChars','importedHistory','autoReadingSettings'].filter(key=>metadata[key]!==undefined).map(key=>[key,metadata[key]])) as Partial<ObservationMetadata>;
}

export type ObservationMetadata={observations:Observations;drafts?:Record<string,WorkbenchDraft>;pagePosition:number;selectedBookId:string;pageChars:number;importedHistory?:string;autoReadingSettings?:AutoReadingSettings};
/** Captured changes only. Absolute event positions preserve ordering on retry. */
export type ObservationChanges={
 header:Omit<ObservationMetadata,'observations'|'drafts'>;
 eventStart:number;
 events:Observations['events'];
 ratings:Observations['ratings'];timings:Observations['timings'];
 questions:Observations['questions'];readyDomains:Observations['readyDomains'];
 drafts?:Record<string,WorkbenchDraft|null>;
};
