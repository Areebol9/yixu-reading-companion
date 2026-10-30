import {mergeRanges,subtractRanges} from './books.ts';
import {memoryContentIdentity} from './memory-identity.ts';
import {requireMemoryText} from './memory-bodies.ts';
import type {Memory,Range,Understanding} from './types.ts';
import type {MaterialExposure} from './material-projection.ts';
import {locateDocumentEdits,ReadingDocumentError} from './document-revision.ts';

export type DocumentReadWindow={view?:'full'|'outline'|'changes';startLine?:number;endLine?:number};
export type DocumentChangeMaterial={previousId:string;previousHash:string;currentId:string;currentHash:string;changes:{before:Range&{text:string};after:Range&{text:string};context:Range&{text:string}}[]};

/** Stored versions remain complete. This surface exposes only exact changed
 * spans and nearby whole lines; the already read old body supplies the rest. */
export function documentReadChanges(previous:Memory,current:Memory){
  const revision=current.documentRevision,old=requireMemoryText(previous),text=requireMemoryText(current),beforeIdentity=memoryContentIdentity(previous),afterIdentity=memoryContentIdentity(current);
  if(!revision||revision.previousId!==previous.id||current.correctionOf!==previous.id||!revision.changes.length)throw Error('该版本没有可核对的准确局部差异，请读取全文');
  let oldCursor=0,newCursor=0;
  const changes=revision.changes.map(change=>{
    const {before,after}=change;
    if(before.start<oldCursor||after.start<newCursor||before.end<before.start||after.end<after.start||before.end>old.length||after.end>text.length||old.slice(oldCursor,before.start)!==text.slice(newCursor,after.start))throw Error('保存的局部差异与不可变版本正文不符');
    oldCursor=before.end;newCursor=after.end;
    // Include the containing lines plus a neighbouring line on each side.
    const first=text.lastIndexOf('\n',Math.max(0,after.start-1)),start=first<0?0:text.lastIndexOf('\n',Math.max(0,first-1))+1;
    const lineEnd=text.indexOf('\n',after.end),nextEnd=lineEnd<0?-1:text.indexOf('\n',lineEnd+1),end=nextEnd<0?text.length:nextEnd+1;
    return{before:{...before,text:old.slice(before.start,before.end)},after:{...after,text:text.slice(after.start,after.end)},context:{start,end,text:text.slice(start,end)}};
  });
  if(old.slice(oldCursor)!==text.slice(newCursor))throw Error('保存的局部差异遗漏了正文变动');
  const documentChange:DocumentChangeMaterial={previousId:previous.id,previousHash:beforeIdentity.hash,currentId:current.id,currentHash:afterIdentity.hash,changes};
  return{id:current.id,version:afterIdentity.hash,bodyFormat:'partial' as const,writeBase:{version:current.id,hash:afterIdentity.hash},documentChange,notice:'这是准确差异和局部上下文；实际读过所列旧版全文后，可据此核对新版概要。仍可按需取全文。'};
}

/** A delta proves review only together with an actual full read of its old
 * body. This grants summary review, never full rewrite/merge authority. */
export function deltaReviewedMemoryIds(memories:readonly Memory[],materials:readonly MaterialExposure[]):Set<string>{
  const byId=new Map(memories.map(memory=>[memory.id,memory])),reviewed=new Set<string>();
  for(const memory of memories){const identity=memoryContentIdentity(memory),ranges=observedMemoryRanges(memory,materials);if(ranges.length===1&&ranges[0].start===0&&ranges[0].end===identity.chars)reviewed.add(memory.id);}
  let changed=true;while(changed){changed=false;for(const memory of memories){if(reviewed.has(memory.id))continue;const identity=memoryContentIdentity(memory),previousId=memory.documentRevision?.previousId,previous=previousId?byId.get(previousId):undefined;
    if(previous&&reviewed.has(previous.id)&&materials.some(material=>material.kind==='memory'&&material.id===memory.id&&material.version===identity.hash&&material.change?.previousId===previous.id&&material.change.previousHash===memoryContentIdentity(previous).hash&&material.hash===identity.hash)){reviewed.add(memory.id);changed=true;}
  }}
  return reviewed;
}
/** Missing bytes of one immutable document version; these never grant a read. */
export type DocumentReadRequirement={id:string;version:string;ranges:Range[]};
export const documentReadParameters={type:'object',properties:{
  ids:{type:'array',minItems:1,items:{type:'string'}},
  view:{type:'string',enum:['full','outline','changes'],description:'默认全文；changes提供该版相对直接前驱的准确差异及局部上下文，供已读旧版后的概要维护；无准确差异时仍取全文。outline仅导航，目录不算正文阅读。'},
  startLine:{type:'integer',minimum:1,description:'可选，从1开始的正文行号；省略从首行开始。'},
  endLine:{type:'integer',minimum:1,description:'含末行；省略读到文件末。可一次读取多个ids的同一区间。追加appendText前须实际读到目标版本末行，outline预览不算正文。'}
},required:['ids'],additionalProperties:false};
export function parseDocumentReadWindow(raw:unknown):{ids:string[]}&DocumentReadWindow{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('文档读取须有ids及可选行范围');
  const value=raw as Record<string,unknown>;
  if(Object.keys(value).some(k=>!['ids','view','startLine','endLine'].includes(k))||!Array.isArray(value.ids)||!value.ids.length||value.ids.some(id=>typeof id!=='string'||!id))throw Error('文档读取参数无效');
  if(value.view!==undefined&&!['full','outline','changes'].includes(value.view as string))throw Error('文档读取view须为full、outline或changes');
  if(value.view==='changes'&&(value.startLine!==undefined||value.endLine!==undefined))throw Error('准确差异读取不同时指定行范围；可另按行读取');
  for(const key of ['startLine','endLine'])if(value[key]!==undefined&&(!Number.isSafeInteger(value[key])||(value[key] as number)<1))throw Error('行号须为大于0的整数');
  if(value.startLine!==undefined&&value.endLine!==undefined&&(value.endLine as number)<(value.startLine as number))throw Error('结束行须不小于开始行');
  return value as {ids:string[]}&DocumentReadWindow;
}
/** Line windows keep their exact UTF-16 offsets, including original newlines. */
export function documentReadSlice(memory:Memory,window:DocumentReadWindow){
  if(window.view==='changes')throw Error('准确差异须同时取得该版与直接前驱，请使用documentReadChanges');
  const text=requireMemoryText(memory),starts=[0];
  for(let i=0;i<text.length;i++)if(text[i]==='\n'&&i+1<text.length)starts.push(i+1);
  const totalLines=starts.length,startLine=window.startLine??1,endLine=window.endLine??totalLines;
  if(startLine>totalLines||endLine>totalLines)throw Error(`文档${memory.id}共${totalLines}行，请使用实际行范围`);
  const start=starts[startLine-1],end=starts[endLine]??text.length;
  if(window.view==='outline'){
    // Structural navigation only: never repeat a preview of every body line.
    // Full/partial reads below remain the sole source of body read evidence.
    const lines=starts.map((offset,index)=>text.slice(offset,starts[index+1]??text.length).trim());
    const headings:{title:string;level:number;startLine:number}[]=[];
    for(let index=0;index<lines.length;index++){
      const line=lines[index],markdown=/^(#{1,6})\s+(.+?)(?:\s+#+)?$/.exec(line);
      if(markdown)headings.push({title:markdown[2].slice(0,120),level:markdown[1].length,startLine:index+1});
      else if(line&&line.length<=120&&/^(?:=+|-+)$/.test(lines[index+1]??'')){
        headings.push({title:line,level:lines[index+1][0]==='='?1:2,startLine:index+1});index++;
      }
      else if(line.length<=120&&/^第[零〇一二三四五六七八九十百千万两\d]+[章节部卷篇](?:\s|[：:、.．]|$)/u.test(line))headings.push({title:line,level:1,startLine:index+1});
    }
    const range=(first:number,last:number)=>({startLine:Math.max(first,startLine),endLine:Math.min(last,endLine)});
    if(headings.length){
      const outline:{title?:string;startLine:number;endLine:number}[]=[];
      if(headings[0].startLine>startLine)outline.push(range(1,headings[0].startLine-1));
      headings.forEach((heading,index)=>{
        const next=headings.slice(index+1).find(item=>item.level<=heading.level),last=next?next.startLine-1:totalLines;
        if(heading.startLine<=endLine&&last>=startLine)outline.push({title:heading.title,...range(heading.startLine,last)});
      });
      return{bodyFormat:'preview' as const,navigationOnly:true,totalLines,chars:text.length,startLine,endLine,outlineKind:'sections' as const,outline};
    }
    const paragraphs:{startLine:number;endLine:number}[]=[];
    for(let index=0;index<lines.length;index++)if(lines[index]){
      const first=index+1;while(index+1<lines.length&&lines[index+1])index++;
      paragraphs.push({startLine:first,endLine:index+1});
    }
    // Sixteen consecutive paragraphs share one navigation entry; the caller
    // chooses which exact lines to read, without host relevance selection.
    const outline:{startParagraph:number;endParagraph:number;startLine:number;endLine:number}[]=[];
    for(let index=0;index<paragraphs.length;index+=16){
      const last=Math.min(index+15,paragraphs.length-1),firstLine=paragraphs[index].startLine,lastLine=paragraphs[last].endLine;
      if(firstLine<=endLine&&lastLine>=startLine)outline.push({startParagraph:index+1,endParagraph:last+1,...range(firstLine,lastLine)});
    }
    return{bodyFormat:'preview' as const,navigationOnly:true,totalLines,chars:text.length,startLine,endLine,outlineKind:'paragraphs' as const,outline};
  }
  const hash=memoryContentIdentity(memory).hash;
  return{text:text.slice(start,end),start,end,startLine,endLine,totalLines,writeBase:{version:memory.id,hash},location:{version:memory.id,hash,start,end},bodyFormat:start===0&&end===text.length?'full' as const:'partial' as const};
}
export function observedMemoryRanges(memory:Memory,materials:readonly MaterialExposure[]):Range[]{
  const identity=memoryContentIdentity(memory);
  return mergeRanges(materials.filter(m=>m.kind==='memory'&&m.id===memory.id&&m.version===identity.hash&&m.mode!=='preview').flatMap(m=>m.mode==='full'&&m.hash===identity.hash&&m.chars===identity.chars?[{start:0,end:identity.chars}]:m.ranges??[]));
}
/** Validate byte coverage only; the model owns whether that context suffices. */
export function revisionReadRanges(memory:Memory,thought:Understanding,field='document',label=memory.id):Range[]{
  const text=requireMemoryText(memory),ranges:Range[]=[];
  const {located,errors,issues}=locateDocumentEdits(memory,thought.edits??[],field,label);
  if(errors.length)throw new ReadingDocumentError(errors,undefined,undefined,issues);
  ranges.push(...located.map(item=>item.before));
  if(thought.appendText!==undefined){const start=text.lastIndexOf('\n',Math.max(0,text.length-2))+1;ranges.push({start,end:text.length});}
  return ranges;
}
export function canReadRevision(memory:Memory,thought:Understanding,materials:readonly MaterialExposure[]):boolean{
  return missingRevisionReadRanges(memory,thought,materials)===undefined;
}
export function missingDocumentReadRanges(memory:Memory,requiredRanges:readonly Range[],materials:readonly MaterialExposure[]):DocumentReadRequirement|undefined{
  const identity=memoryContentIdentity(memory),ranges=subtractRanges([...requiredRanges],observedMemoryRanges(memory,materials));
  return ranges.length?{id:memory.id,version:identity.hash,ranges}:undefined;
}
export function missingRevisionReadRanges(memory:Memory,thought:Understanding,materials:readonly MaterialExposure[],field='document',label=memory.id):DocumentReadRequirement|undefined{
  return missingDocumentReadRanges(memory,revisionReadRanges(memory,thought,field,label),materials);
}
/** Supplement exactly the missing spans, without loading a different version
 * or silently widening a partial edit into a full-body read. */
export function documentReadRangeSlices(memory:Memory,requirement:DocumentReadRequirement){
  const text=requireMemoryText(memory),identity=memoryContentIdentity(memory);
  if(requirement.id!==memory.id||requirement.version!==identity.hash)throw Error('缺失读取范围与实际文档版本不符，原候选保持');
  const splitsPair=(offset:number)=>offset>0&&offset<text.length&&text.charCodeAt(offset-1)>=0xd800&&text.charCodeAt(offset-1)<=0xdbff&&text.charCodeAt(offset)>=0xdc00&&text.charCodeAt(offset)<=0xdfff;
  if(!requirement.ranges.length||requirement.ranges.some(range=>!Number.isSafeInteger(range.start)||!Number.isSafeInteger(range.end)||range.start<0||range.end<=range.start||range.end>text.length||splitsPair(range.start)||splitsPair(range.end)))throw Error('缺失读取范围须为该文档内完整有效的UTF-16片段');
  const starts=[0];for(let i=0;i<text.length;i++)if(text[i]==='\n'&&i+1<text.length)starts.push(i+1);
  const lineAt=(offset:number)=>{let line=1;while(line<starts.length&&starts[line]<=offset)line++;return line;};
  return mergeRanges(requirement.ranges).map(({start,end})=>({text:text.slice(start,end),start,end,startLine:lineAt(start),endLine:lineAt(end-1),totalLines:starts.length,writeBase:{version:memory.id,hash:identity.hash},location:{version:memory.id,hash:identity.hash,start,end},bodyFormat:start===0&&end===text.length?'full' as const:'partial' as const}));
}
