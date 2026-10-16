import {bookTextSlice,bookLength} from './books.ts';
import type {Book,DocumentEdit,DocumentRevision,Evidence,Memory,Range,ReadingReply,Understanding} from './types.ts';
import {covers,mergeRanges} from './books.ts';
import {isCurrentMemory,isEvidenceAllowed} from './context.ts';
import {requireMemoryText} from './memory-bodies.ts';
import {READING_DOCUMENT_MAX_CHARS} from './types.ts';

export function parseDocumentSourceIds(raw:unknown,field='sourceIds'):string[]|undefined {
  if(raw===undefined)return;
  if(!Array.isArray(raw))throw Error(`文档${field}须为本轮实际p编号数组，原答保持`);
  let invalid=-1;raw.some((id,index)=>{if(typeof id!=='string'||!/^p[1-9]\d{0,5}$/.test(id)){invalid=index;return true;}return false;});
  if(invalid>=0)throw Error(`文档${field}[${invalid}]须为本轮实际p编号，原答保持`);
  return [...new Set(raw as string[])];
}
export function parseDocumentEdits(value:{edits?:unknown;appendText?:unknown},field='edits'):{edits?:DocumentEdit[];appendText?:string} {
  const {edits,appendText}=value;
  if(edits===undefined&&appendText===undefined)return{};
  if(edits!==undefined&&(!Array.isArray(edits)||edits.length>32))throw Error('局部修订edits须为最多32项的数组，原答保持');
  const parsed=(edits as unknown[]|undefined)?.map((raw,index)=>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('局部修订条目无效，原答保持');
    const e=raw as Record<string,unknown>;
    if(Object.keys(e).some(k=>!['oldText','newText','sourceIds'].includes(k))||typeof e.oldText!=='string'||!e.oldText||e.oldText.length>READING_DOCUMENT_MAX_CHARS||typeof e.newText!=='string'||e.newText.length>READING_DOCUMENT_MAX_CHARS||e.oldText===e.newText)throw Error('局部修订须给逐字oldText与不同的newText，原答保持');
    const sourceIds=parseDocumentSourceIds(e.sourceIds,`${field}[${index}].sourceIds`);
    return{oldText:e.oldText,newText:e.newText,...(sourceIds!==undefined?{sourceIds}:{})};
  });
  if(appendText!==undefined&&(typeof appendText!=='string'||!appendText.trim()||appendText.length>READING_DOCUMENT_MAX_CHARS))throw Error('局部追加appendText须为明确的非空正文，原答保持');
  if(!parsed?.length&&appendText===undefined)throw Error('局部修订须有实际替换或追加，原答保持');
  return{...(parsed?{edits:parsed}:{}),...(typeof appendText==='string'?{appendText}:{})};
}

/** All matches refer to the same supplied old body; edits never match text
 * produced by an earlier edit. Untouched UTF-16 slices are copied verbatim. */
export function applyDocumentRevision(previous:Memory,proposal:Pick<Understanding,'edits'|'appendText'|'sourceIds'|'quoteSource'>,field='document'):DocumentRevisionResult {
  if(previous.kind!=='opinion'||!isCurrentMemory(previous))throw Error('局部修订只可接续本轮取得全文的有效opinion具体旧版，原答保持');
  const old=requireMemoryText(previous),parsed=parseDocumentEdits(proposal);
  const errors:string[]=[];
  const located=(parsed.edits??[]).flatMap((edit,index)=>{
    const start=old.indexOf(edit.oldText);
    if(start<0||old.indexOf(edit.oldText,start+1)>=0){errors.push(`${field}.edits[${index}].oldText在具体旧版${previous.id}（UTF-16 ${old.length}字符）${start<0?'未匹配':'有多处匹配'}，须唯一逐字定位`);return[];}
    return[{edit,index,before:{start,end:start+edit.oldText.length}}];
  }).sort((a,b)=>a.before.start-b.before.start);
  for(const [i,item]of located.entries())if(i>0&&item.before.start<located[i-1].before.end)errors.push(`${field}.edits[${item.index}].oldText与edits[${located[i-1].index}]在具体旧版${previous.id}重叠`);
  const rebuiltChars=old.length+(parsed.edits??[]).reduce((n,edit)=>n+edit.newText.length-edit.oldText.length,0)+(parsed.appendText?.length??0);
  if(rebuiltChars>READING_DOCUMENT_MAX_CHARS)errors.push(`${field}具体旧版${previous.id}的${errors.length?'定位成立后预计':'重建'}正文${rebuiltChars}字符（UTF-16：旧全文${old.length}，edits净变化${(parsed.edits??[]).reduce((n,e)=>n+e.newText.length-e.oldText.length,0)}，追加${parsed.appendText?.length??0}），上限${READING_DOCUMENT_MAX_CHARS}，旧稿剩余${READING_DOCUMENT_MAX_CHARS-old.length}；须按实际内容修订或独立create，原答不删写`);
  if(errors.length)throw new ReadingDocumentError(errors);
  const fallback=proposal.sourceIds??(proposal.quoteSource?[proposal.quoteSource]:[]);
  let text='',cursor=0;const changes:{before:Range;after:Range;sourceIds:string[]}[]=[];
  for(const {edit,before}of located){
    text+=old.slice(cursor,before.start);const start=text.length;text+=edit.newText;
    changes.push({before,after:{start,end:text.length},sourceIds:edit.sourceIds??fallback});cursor=before.end;
  }
  text+=old.slice(cursor);
  if(parsed.appendText!==undefined){const start=text.length;text+=parsed.appendText;changes.push({before:{start:old.length,end:old.length},after:{start,end:text.length},sourceIds:fallback});}
  if(!text.trim())throw Error(`${field}局部修订后的完整正文须非空，原答保持`);
  return{text,changes};
}
export type DocumentRevisionResult={text:string;changes:{before:Range;after:Range;sourceIds:string[]}[]};
export class ReadingDocumentError extends Error {
  readonly errors:string[];
  constructor(errors:string[]){super(errors.join('\n'));this.errors=errors;this.name='ReadingDocumentError';}
}
export function prepareDocumentRevisions(result:ReadingReply,resolve:(id:string)=>Memory|undefined):{result:ReadingReply;revisions:Map<number,DocumentRevisionResult>} {
  const errors:string[]=[],revisions=new Map<number,DocumentRevisionResult>();
  const thoughts=result.thoughts.map((thought,index)=>{
    if(thought.edits===undefined&&thought.appendText===undefined)return thought;
    try{
      if(thought.kind!=='opinion'||!thought.updates||!thought.updateReason?.trim())throw Error('局部修订须指向已有opinion全文和明确变化原因');
      const old=resolve(thought.updates);if(!old)throw Error('局部修订目标须为本轮实际取得全文的m编号，目录只供导航');
      const revision=applyDocumentRevision(old,thought,`documents[${index}]`);revisions.set(index,revision);
      return{...thought,text:revision.text,documentOperation:'revise' as const};
    }catch(error){errors.push(...(error instanceof ReadingDocumentError?error.errors:[`documents[${index}]：${(error as Error).message}`]));return thought;}
  });
  if(errors.length)throw new ReadingDocumentError(errors);
  return{result:{...result,thoughts},revisions};
}

/** Resolve only actual full-body sources; navigation IDs do not grant write authority. */
export function materializeDocumentRevisions(result:ReadingReply,resolve:(id:string)=>Memory|undefined):ReadingReply {
  return prepareDocumentRevisions(result,resolve).result;
}

export type DocumentSourceContext={book:Book;refs:Evidence[];originalRanges:Range[];passages:ReadonlyMap<string,NonNullable<Memory['sourceQuote']>>};
export function documentSourceEvidence(ids:readonly string[],ctx:DocumentSourceContext):Evidence[] {
  const {book,refs,originalRanges,passages}=ctx;
  const sources=ids.map(id=>{
    const p=passages.get(id),e=p?.evidence;
    if(!p||!e||e.bookId!==book.id||e.version!==book.version||!Number.isSafeInteger(e.start)||!Number.isSafeInteger(e.end)||e.start<0||e.end<=e.start||!covers(refs,e)||!covers(originalRanges,e)||!isEvidenceAllowed(book,[e])||bookTextSlice(book,e.start,e.end)!==p.text)throw Error(`文档出处${id}须为本轮实际提供的获准原句，原答保持`);
    return e;
  });
  return mergeRanges(sources).map(r=>({bookId:book.id,version:book.version,...r}));
}
export function bindDocumentRevision(previous:Memory,thought:Understanding,ctx:DocumentSourceContext,prepared?:DocumentRevisionResult):DocumentRevision {
  const applied=prepared??applyDocumentRevision(previous,thought);
  if(thought.text!==applied.text)throw Error('局部修订正文与本轮旧全文不一致，原答保持');
  return{previousId:previous.id,changes:applied.changes.map(change=>({before:change.before,after:change.after,sourceEvidence:documentSourceEvidence(change.sourceIds,ctx)}))};
}

/** Restore the computed mapping without trusting caller-supplied offsets. */
export function validateDocumentRevision(memory:Memory,previous:Memory|undefined,book:Book):void {
  const revision=memory.documentRevision;if(!revision)return;
  const fail=()=>{throw Error('文档局部修订的正文区间或来源关联无效');};
  if(!previous||revision.previousId!==previous.id||previous.id===memory.id||memory.kind!=='opinion'||previous.kind!=='opinion'||memory.bookId!==previous.bookId||memory.partnerId!==previous.partnerId||memory.revisionKind!=='development'||memory.correctionOf!==previous.id||!memory.parents.includes(previous.id)||!previous.evidence.every(e=>e.bookId===book.id&&e.version===book.version&&covers(memory.evidence,e))||memory.basis&&!memory.basis.memoryIds.includes(previous.id)||Object.keys(revision).some(k=>!['previousId','changes'].includes(k))||!Array.isArray(revision.changes)||!revision.changes.length||revision.changes.length>33)fail();
  const old=requireMemoryText(previous!),text=requireMemoryText(memory),range=(r:Range,length:number)=>r&&Object.keys(r).every(k=>['start','end'].includes(k))&&Number.isSafeInteger(r.start)&&Number.isSafeInteger(r.end)&&r.start>=0&&r.end>=r.start&&r.end<=length;
  let oldCursor=0,newCursor=0;
  for(const [i,change]of revision.changes.entries()){
    if(!change||Object.keys(change).some(k=>!['before','after','sourceEvidence'].includes(k))||!range(change.before,old.length)||!range(change.after,text.length)||change.before.start<oldCursor||change.after.start<newCursor||change.before.start===change.before.end&&(change.before.start!==old.length||i!==revision.changes.length-1)||old.slice(oldCursor,change.before.start)!==text.slice(newCursor,change.after.start)||old.slice(change.before.start,change.before.end)===text.slice(change.after.start,change.after.end)||!Array.isArray(change.sourceEvidence)||change.sourceEvidence.length>8)fail();
    const original=old.slice(change.before.start,change.before.end);
    if(original&&old.indexOf(original)!==change.before.start||original&&old.indexOf(original,change.before.start+1)>=0)fail();
    for(const e of change.sourceEvidence){if(!e||e.bookId!==book.id||e.version!==book.version||!Number.isSafeInteger(e.start)||!Number.isSafeInteger(e.end)||e.start<0||e.end<=e.start||e.end>bookLength(book)||!covers(memory.evidence,e)||!covers(memory.sourceEvidence??[],e))fail();}
    oldCursor=change.before.end;newCursor=change.after.end;
  }
  if(old.slice(oldCursor)!==text.slice(newCursor))fail();
}
