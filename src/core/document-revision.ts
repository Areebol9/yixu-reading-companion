import {sameDocumentOwner} from './book-document-ownership.ts';
import {bookVersionAllowsRange} from './book-versions.ts';
import {bookTextSlice,bookLength} from './books.ts';
import type {Book,DocumentEdit,DocumentRevision,Evidence,Memory,Range,ReadingReply,Understanding} from './types.ts';
import {covers,mergeRanges} from './books.ts';
import {isCurrentMemory,isEvidenceAllowed} from './context.ts';
import {requireMemoryText} from './memory-bodies.ts';
import {memoryContentIdentity} from './memory-identity.ts';
import type {DocumentReadRequirement} from './document-reading.ts';

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
  if(edits!==undefined&&(!Array.isArray(edits)))throw Error('局部修订edits须为数组，原答保持');
  const parsed=(edits as unknown[]|undefined)?.map((raw,index)=>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('局部修订条目无效，原答保持');
    const e=raw as Record<string,unknown>;
    if(Object.keys(e).some(k=>!['oldText','location','newText','sourceIds'].includes(k))||typeof e.newText!=='string'||e.oldText!==undefined&&(typeof e.oldText!=='string'||!e.oldText||e.oldText===e.newText)||e.oldText===undefined&&e.location===undefined)throw Error('局部修订须给oldText或该具体版本的准确location，以及不同的newText，原答保持');
    const location=parseDocumentLocation(e.location);
    const sourceIds=parseDocumentSourceIds(e.sourceIds,`${field}[${index}].sourceIds`);
    return{...(typeof e.oldText==='string'?{oldText:e.oldText}:{}),...(location?{location}:{}),newText:e.newText,...(sourceIds!==undefined?{sourceIds}:{})};
  });
  if(appendText!==undefined&&(typeof appendText!=='string'||!appendText.trim()))throw Error('局部追加appendText须为明确的非空正文，原答保持');
  if(!parsed?.length&&appendText===undefined)throw Error('局部修订须有实际替换或追加，原答保持');
  return{...(parsed?{edits:parsed}:{}),...(typeof appendText==='string'?{appendText}:{})};
}
export const documentLocationSchema={type:'object',properties:{version:{type:'string',minLength:1},hash:{type:'string',pattern:'^[a-f0-9]{64}$'},start:{type:'integer',minimum:0},end:{type:'integer',minimum:0},startLine:{type:'integer',minimum:1},endLine:{type:'integer',minimum:1}},required:['version','hash'],oneOf:[{required:['start','end'],not:{anyOf:[{required:['startLine']},{required:['endLine']}]}},{required:['startLine','endLine'],not:{anyOf:[{required:['start']},{required:['end']}]}}],additionalProperties:false};
export function parseDocumentLocation(raw:unknown):import('./types.ts').DocumentLocation|undefined{
  if(raw===undefined)return;
  const l=raw as import('./types.ts').DocumentLocation;
  if(!l||typeof l!=='object'||Array.isArray(l)||Object.keys(l).some(k=>!['version','hash','start','end','startLine','endLine'].includes(k))||typeof l.version!=='string'||!l.version||typeof l.hash!=='string'||!/^[a-f0-9]{64}$/.test(l.hash))throw Error('局部定位须明确具体版本version及正文hash');
  const offsets=l.start!==undefined||l.end!==undefined,lines=l.startLine!==undefined||l.endLine!==undefined;
  if(offsets===lines||offsets&&(!Number.isSafeInteger(l.start)||!Number.isSafeInteger(l.end)||l.start!<0||l.end!<=l.start!)||lines&&(!Number.isSafeInteger(l.startLine)||!Number.isSafeInteger(l.endLine)||l.startLine!<1||l.endLine!<l.startLine!))throw Error('局部定位须为准确start/end或包含首末行的startLine/endLine');
  return{...l};
}

/** All matches refer to the same supplied old body; edits never match text
 * produced by an earlier edit. Untouched UTF-16 slices are copied verbatim. */
export function locateDocumentEdits(previous:Memory,edits:readonly DocumentEdit[],field='document',label=previous.id){
  const old=requireMemoryText(previous),errors:string[]=[],issues:ReadingIssue[]=[];
  const lineStarts=[0];for(let index=0;index<old.length-1;index++)if(old[index]==='\n')lineStarts.push(index+1);
  const totalLines=lineStarts.length,lineAt=(offset:number)=>{let first=0,last=lineStarts.length;while(first+1<last){const middle=(first+last)>>>1;if(lineStarts[middle]<=offset)first=middle;else last=middle;}return first+1;};
  const pointer='/'+field.replace(/\[(\d+)\]/g,'/$1').replace(/\./g,'/');
  const located=edits.flatMap((edit,index)=>{
    if(edit.location){
      try{
        const l=parseDocumentLocation(edit.location)!,identity=memoryContentIdentity(previous);
        if(l.version!==previous.id||l.hash!==identity.hash)throw Error('定位绑定的具体版本或正文hash与当前写入基版不符');
        const start=l.start??lineStarts[l.startLine!-1],end=l.end??lineStarts[l.endLine!]??old.length;
        const splitsPair=(offset:number)=>offset>0&&offset<old.length&&old.charCodeAt(offset-1)>=0xd800&&old.charCodeAt(offset-1)<=0xdbff&&old.charCodeAt(offset)>=0xdc00&&old.charCodeAt(offset)<=0xdfff;
        if(start===undefined||l.endLine!==undefined&&l.endLine>totalLines||end>old.length||start>=end||splitsPair(start)||splitsPair(end))throw Error('定位超出该版本正文或切开完整字符');
        const original=old.slice(start,end);if(edit.oldText!==undefined&&edit.oldText!==original)throw Error('oldText与准确定位处正文不符');
        if(edit.newText===original)throw Error('定位处新旧正文相同，未形成修改');
        return[{edit,index,before:{start,end}}];
      }catch(error){errors.push(`${field}.edits[${index}].location：${(error as Error).message}；原候选保持`);issues.push({code:'DOCUMENT_EDIT_LOCATION',path:`${pointer}/edits/${index}/location`,target:previous.id,version:previous.id});return[];}
    }
    const matches:number[]=[];
    if(edit.oldText)for(let start=old.indexOf(edit.oldText);start>=0;start=old.indexOf(edit.oldText,start+1))matches.push(start);
    if(matches.length!==1){
      const path=`${pointer}/edits/${index}/oldText`;
      errors.push(`${field}.edits[${index}].oldText在${label}具体版本${previous.id}中匹配${matches.length}次，须唯一逐字定位；原基版共${old.length}字符、${totalLines}行，已供入正文直接复用，需定位时用read_memory_documents({ids:["${label}"],view:"outline"})，只修此项，其他edits和原candidate保持`);
      issues.push({code:'DOCUMENT_EDIT_MATCH',path,target:previous.id,documentLabel:label,version:previous.id,...(previous.bodyRef?{bodyHash:previous.bodyRef.hash}:{}),matchCount:matches.length,documentChars:old.length,totalLines,read:{tool:'read_memory_documents',ids:[label],view:'outline'},...(matches.length?{matchLines:[...new Set(matches.map(lineAt))]}:{})});
      return[];
    }
    return[{edit,index,before:{start:matches[0],end:matches[0]+edit.oldText!.length}}];
  }).sort((a,b)=>a.before.start-b.before.start);
  for(const [i,item]of located.entries())if(i>0&&item.before.start<located[i-1].before.end){
    errors.push(`${field}.edits[${item.index}].oldText与edits[${located[i-1].index}]在${label}具体版本${previous.id}重叠；只修重叠项，其他edits和原candidate保持`);
    issues.push({code:'DOCUMENT_EDIT_OVERLAP',path:`${pointer}/edits/${item.index}/oldText`,target:previous.id,documentLabel:label,version:previous.id});
  }
  return{located,errors,issues};
}
export function applyDocumentRevision(previous:Memory,proposal:Pick<Understanding,'edits'|'appendText'|'sourceIds'|'quoteSource'>,field='document'):DocumentRevisionResult {
  if(previous.kind!=='opinion'||!isCurrentMemory(previous))throw Error('局部修订只可接续本轮取得修改范围的有效opinion具体旧版，原答保持');
  const old=requireMemoryText(previous),parsed=parseDocumentEdits(proposal);
  const {located,errors,issues}=locateDocumentEdits(previous,parsed.edits??[],field);
  if(errors.length)throw new ReadingDocumentError(errors,undefined,undefined,issues);
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
export type ReadingIssue={code:string;path:string;target?:string;documentLabel?:string;version?:string;bodyHash?:string;matchCount?:number;documentChars?:number;totalLines?:number;matchLines?:number[];read?:{tool:'read_memory_documents';ids:string[];view:'outline'}};
export class ReadingDocumentError extends Error {
  readonly errors:string[];
  constructor(errors:string[],readonly requiredMemoryIds?:string[],readonly requiredViewIds?:string[],readonly issues?:ReadingIssue[],readonly requiredMemoryRanges?:DocumentReadRequirement[]){super(errors.join('\n'));this.errors=errors;this.name='ReadingDocumentError';}
}
export function prepareDocumentRevisions(result:ReadingReply,resolve:(id:string)=>Memory|undefined):{result:ReadingReply;revisions:Map<number,DocumentRevisionResult>} {
  const errors:string[]=[],issues:ReadingIssue[]=[],revisions=new Map<number,DocumentRevisionResult>();
  const thoughts=result.thoughts.map((thought,index)=>{
    if(['organize','retire','restore'].includes(thought.documentOperation??'')){
      const previous=thought.updates&&resolve(thought.updates);
      if(!previous||previous.kind!=='opinion'||!thought.updateReason?.trim())throw Error('文档整理、退出和重新启用须实际取得目标全文并说明原因');
      if(thought.edits!==undefined||thought.appendText!==undefined)throw Error('文档生命周期操作不混入正文修订');
      if(thought.documentOperation==='restore'?previous.documentState!=='retired'||previous.replacedBy:!isCurrentMemory(previous))throw Error('文档当前状态不支持这次操作，请取得当前版本');
      const text=requireMemoryText(previous);if(thought.text&&thought.text!==text)throw Error('整理或退出不能暗中改写正文，请另行明确修订');return{...thought,text};
    }
    if(thought.documentOperation==='merge'&&(thought.edits!==undefined||thought.appendText!==undefined))throw Error('认识归并须提供完整新text，不能局部修订多个前驱');
    if(thought.edits===undefined&&thought.appendText===undefined)return thought;
    try{
      if(thought.kind!=='opinion'||!thought.updates||!thought.updateReason?.trim())throw Error('局部修订须指向已有opinion全文和明确变化原因');
      const old=resolve(thought.updates);if(!old)throw Error('局部修订目标须为本轮实际取得全文的m编号，目录只供导航');
      const revision=applyDocumentRevision(old,thought,`documents[${index}]`);revisions.set(index,revision);
      return{...thought,text:revision.text,documentOperation:'revise' as const};
    }catch(error){errors.push(...(error instanceof ReadingDocumentError?error.errors:[`documents[${index}]：${(error as Error).message}`]));if(error instanceof ReadingDocumentError)issues.push(...(error.issues??[]));return thought;}
  });
  if(errors.length)throw new ReadingDocumentError(errors,undefined,undefined,issues);
  return{result:{...result,thoughts},revisions};
}

export function validateDocumentLifecycle(memory:Memory,memories:readonly Memory[]):void{
  if(memory.documentState!==undefined&&memory.documentState!=='retired')throw Error('文档退出状态无效');
  if(memory.documentState===undefined&&memory.documentSuccessors!==undefined)throw Error('只有退出文档可登记承接文档');
  if(memory.documentState==='retired'){
    const previous=memories.find(m=>m.id===memory.correctionOf);
    if(memory.kind!=='opinion'||memory.revisionKind!=='development'||!memory.revisionReason?.trim()||!previous||!sameDocumentOwner(previous,memory)||previous.replacedBy!==memory.id)throw Error('文档退出缺少有效前驱和原因');
    if(requireMemoryText(memory)!==requireMemoryText(previous))throw Error('退出文档须保留原正文');
    if(memory.documentSuccessors!==undefined&&(!Array.isArray(memory.documentSuccessors)||!memory.documentSuccessors.length||new Set(memory.documentSuccessors).size!==memory.documentSuccessors.length))throw Error('文档承接关系无效');
    for(const id of memory.documentSuccessors??[]){const next=memories.find(m=>m.id===id);if(!next||next.id===memory.id||next.id===previous.id||!sameDocumentOwner(next,memory))throw Error('文档承接对象须为同书同归属的其他文档');}
  }
}

/** Durable identity links only. Formation additionally checks current permissions and full exposure. */
export function validateMergedMemoryLineage(memory:Memory,memories:readonly Memory[]):void{
  if(memory.mergePreviousIds===undefined)return;
  if(!Array.isArray(memory.mergePreviousIds))throw Error('认识归并前驱无效');
  const ids=[memory.correctionOf,...memory.mergePreviousIds];
  if(memory.kind!=='opinion'||memory.revisionKind!=='development'||!memory.revisionReason?.trim()||!memory.correctionOf||!memory.mergePreviousIds.length||new Set(ids).size!==ids.length||ids.includes(memory.id)||memory.documentRevision)throw Error('认识归并血缘无效');
  for(const id of ids){
    const previous=memories.find(m=>m.id===id);
    if(!previous||previous.kind!=='opinion'||!sameDocumentOwner(previous,memory)||previous.replacedBy!==memory.id||!memory.parents.includes(previous.id)||!memory.formationSources&&memory.basis&&!memory.basis.memoryIds.includes(previous.id))throw Error('认识归并前驱身份或反向血缘无效');
  }
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
    if(!p||!e||e.bookId!==book.id||!bookVersionAllowsRange(book,e.version,e)||!Number.isSafeInteger(e.start)||!Number.isSafeInteger(e.end)||e.start<0||e.end<=e.start||!covers(refs,e)||!covers(originalRanges,e)||!isEvidenceAllowed(book,[e])||bookTextSlice(book,e.start,e.end)!==p.text)throw Error(`文档出处${id}须为本轮实际提供的获准原句，原答保持`);
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
  if(!previous||revision.previousId!==previous.id||previous.id===memory.id||memory.kind!=='opinion'||previous.kind!=='opinion'||!sameDocumentOwner(memory,previous)||memory.revisionKind!=='development'||memory.correctionOf!==previous.id||!memory.parents.includes(previous.id)||!previous.evidence.every(e=>e.bookId===book.id&&bookVersionAllowsRange(book,e.version,e)&&covers(memory.evidence,e))||!memory.formationSources&&memory.basis&&!memory.basis.memoryIds.includes(previous.id)||Object.keys(revision).some(k=>!['previousId','changes'].includes(k))||!Array.isArray(revision.changes)||!revision.changes.length)fail();
  const old=requireMemoryText(previous!),text=requireMemoryText(memory),range=(r:Range,length:number)=>r&&Object.keys(r).every(k=>['start','end'].includes(k))&&Number.isSafeInteger(r.start)&&Number.isSafeInteger(r.end)&&r.start>=0&&r.end>=r.start&&r.end<=length;
  let oldCursor=0,newCursor=0;
  for(const [i,change]of revision.changes.entries()){
    if(!change||Object.keys(change).some(k=>!['before','after','sourceEvidence'].includes(k))||!range(change.before,old.length)||!range(change.after,text.length)||change.before.start<oldCursor||change.after.start<newCursor||change.before.start===change.before.end&&(change.before.start!==old.length||i!==revision.changes.length-1)||old.slice(oldCursor,change.before.start)!==text.slice(newCursor,change.after.start)||old.slice(change.before.start,change.before.end)===text.slice(change.after.start,change.after.end)||!Array.isArray(change.sourceEvidence))fail();
    for(const e of change.sourceEvidence){if(!e||e.bookId!==book.id||!bookVersionAllowsRange(book,e.version,e)||!Number.isSafeInteger(e.start)||!Number.isSafeInteger(e.end)||e.start<0||e.end<=e.start||e.end>bookLength(book)||!covers(memory.evidence,e)||!covers(memory.sourceEvidence??[],e))fail();}
    oldCursor=change.before.end;newCursor=change.after.end;
  }
  if(old.slice(oldCursor)!==text.slice(newCursor))fail();
}
