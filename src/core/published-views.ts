import {documentScope,memoryReadableByPartner,viewReadableByPartner,sameDocumentOwner} from './book-document-ownership.ts';
import {chatBelongsToPartner} from './discussion-recall.ts';
import {hashText} from './text-hash.ts';
import {id,mergeRanges,subtractRanges,covers,bookLength} from './books.ts';
import {chatAllowsMemory,isEvidenceAllowed,createEvidenceChecker,createChatMemoryChecker,memoryIsForgotten,isUsableSourceVersion} from './context.ts';
import {memoryContentIdentity,prepareMemoryIdentities} from './memory-identity.ts';
import type {Book,Memory,PublishedView,Range,State,ViewProposal,ViewPublication} from './types.ts';
import {canonicalMaintenanceViewTargets,isMaintenanceViewTarget} from './types.ts';
import {ReadingDocumentError} from './document-revision.ts';
import {checkedMaintenanceRanges,intersectRanges,maintenancePendingViewReview} from './reading-continuity.ts';
import {bookVersionAllowsRange,bookVersionAllowsRanges,bookVersionPrefixLength} from './book-versions.ts';
import {ordinaryReadingTask} from './terminated-reading-continuation.ts';
import {formationSources,formationSourceChecker,validateFormationSources} from './formation-sources.ts';
import {deltaReviewedMemoryIds} from './document-reading.ts';
import {maintenanceProcessed,maintenanceProgressFacts} from './maintenance-progress.ts';

const editionAllowsSource=(book:Book,edition:string,source:string,ranges:readonly Range[])=>{const end=bookVersionPrefixLength(book,edition),sourceEnd=bookVersionPrefixLength(book,source);return end!==undefined&&sourceEnd!==undefined&&sourceEnd<=end&&bookVersionAllowsRanges(book,source,ranges);};

export const viewProposalSchema={type:'array',items:{type:'object',properties:{
  target:{type:'string',pattern:'^v[1-9][0-9]*$',description:'修改已提供的概要选择其v编号；程序绑定该已读版本的kind/key/previousId及继承关系，无须重复填写。新建概要才填写kind/key。'},
  operation:{type:'string',enum:['publish','keep','revise']},kind:{type:'string',enum:['overview','current','topic','arc']},key:{type:'string',minLength:1,maxLength:100},text:{type:'string',minLength:1,description:'简明的当前概要，约1800字符为精简目标；保留必要条件，不为凑字数重交。详细认识留在文档中。'},
  edits:{type:'array',minItems:1,items:{type:'object',properties:{oldText:{type:'string',minLength:1},newText:{type:'string'}},required:['oldText','newText'],additionalProperties:false},description:'revise的全部oldText均取自previousId原基版，唯一匹配且互不重叠；不能取自本候选其他newText。newText为空可删除。候选补交替换原edits对应项，不向数组追加对尚未发布结果的再次修改。'},
  sourceMemoryIds:{type:'array',items:{type:'string'},description:'本次明确采用的完整认识版本；审阅但不采用的版本另填reviewedMemoryIds。'},
  reviewedMemoryIds:{type:'array',items:{type:'string'},description:'本次实际取得全文并明确审阅的具体认识版本；不自动成为采用依据。'},reviewReason:{type:'string',minLength:1,maxLength:500,description:'必要时说明有据保留或不采用的简短理由；显式审阅与实际采用分别记录。'},
  reviewChanges:{type:'boolean',enum:[true],description:'明确确认已审阅本批实际供入的待核后继及本包新认识；程序登记具体版本，不自动采用。未核对时勿填。'},
  replaceSources:{type:'boolean',enum:[true],description:'明确以sourceMemoryIds中采用的完整新版替代其已声明接续或合并前驱的当前采用关系；历史来源保留。需同时保留旧观点作当前依据时勿填，改用dropSourceMemoryIds精确选择。'},
  dropSourceMemoryIds:{type:'array',items:{type:'string'},description:'明确移除从sourceViewIds继承的旧采用关系；须同时review对应版本或其发展后继，不撤销历史来源。'},
  sourceIds:{type:'array',items:{type:'string',pattern:'^p[1-9][0-9]*$'}},chatIds:{type:'array',items:{type:'string'}},sourceViewIds:{type:'array',items:{type:'string'}},mergePreviousIds:{type:'array',minItems:1,items:{type:'string'},description:'仅overview/current归并额外旧头；主前继仍填previousId并保持其key。额外前继必须本轮实际取得全文、同kind、同时列入sourceViewIds。'},previousId:{type:'string',description:'承接本轮实际提供的同一概要v；keep/revise还须以sourceViewIds继承该v。变化须明确review，可有理由地不采用新版。'}
},anyOf:[{required:['target']},{required:['kind','key']}],additionalProperties:false}};
/** The maintenance exit asks for a content decision, not a second review form.
 * These decisions explicitly cover this batch; legacy proposals retain their
 * original contract and cannot gain review/adoption assertions by being read. */
export const maintenanceViewDecisionSchema={type:'array',items:{type:'object',properties:{
  target:viewProposalSchema.items.properties.target,
  decision:{type:'string',enum:['keep','revise','publish'],description:'对本批新增正文、交流和文档变化作出的概要决定：keep原文仍成立，revise局部修改，publish重写/新建。每项决定都表示已考虑本批变化，程序记录具体审阅版本；不再另填确认字段。'},
  kind:viewProposalSchema.items.properties.kind,key:viewProposalSchema.items.properties.key,
  text:viewProposalSchema.items.properties.text,edits:viewProposalSchema.items.properties.edits,
  sourceMemoryIds:{type:'array',items:{type:'string'},description:'本次明确采用的m/t正文。采用新版会接替同链旧版的当前引用；旧原件仍保存。如旧观点仍需作为当前依据，同时列出该旧版。省略保留原有采用。'},
  dropSourceMemoryIds:viewProposalSchema.items.properties.dropSourceMemoryIds,
  reviewReason:viewProposalSchema.items.properties.reviewReason,
  sourceIds:viewProposalSchema.items.properties.sourceIds,chatIds:viewProposalSchema.items.properties.chatIds,
  mergePreviousIds:viewProposalSchema.items.properties.mergePreviousIds
},required:['decision'],anyOf:[{required:['target']},{required:['kind','key']}],additionalProperties:false}};
/** Bind a model-selected handle to exactly the version supplied, never a newer
 * live head. No narrative or adoption decision is inferred here. */
export function bindViewTargets(value:unknown,provided:readonly {id:string;kind:string;key:string;version?:string}[]):unknown{
  if(value===undefined)return value;if(!Array.isArray(value))throw new ReadingDocumentError(['views须为数组']);
  const errors:string[]=[];
  const bound=value.map((input,index)=>{
    let raw=input;
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return raw;
    const {readingStage:_readingStage,...content}=raw;raw=content;
    if(Object.hasOwn(raw,'decision')){
      if(!['keep','revise','publish'].includes(raw.decision)||Object.hasOwn(raw,'operation')&&raw.operation!==raw.decision||['reviewChanges','replaceSources'].some(key=>Object.hasOwn(raw,key)&&raw[key]!==true)){errors.push(`views[${index}].decision与operation或审阅确认字段矛盾；保持一个明确的保留/修改决定`);return raw;}
      const {decision,operation:_operation,reviewChanges:_reviewChanges,replaceSources:_replaceSources,...body}=raw;raw={...body,operation:decision,reviewChanges:true,replaceSources:true};
    }
    if(!Object.hasOwn(raw,'target'))return {...raw,sourceMemoryIds:raw.sourceMemoryIds??[]};
    const base=provided.find(v=>v.id===raw.target);
    if(!base){errors.push(`views[${index}].target未实际供入；请使用已读取的v编号`);return raw;}
    const expected={kind:base.kind,key:base.key,previousId:raw.target,sourceViewIds:[raw.target,...(Array.isArray(raw.mergePreviousIds)?raw.mergePreviousIds:[])]};
    const conflicts=(Object.keys(expected) as (keyof typeof expected)[]).filter(k=>Object.hasOwn(raw,k)&&JSON.stringify(raw[k])!==JSON.stringify(expected[k]));
    if(conflicts.length){errors.push(`views[${index}].${conflicts.join('、')}与target所指已读基版冲突`);return raw;}
    const {target,kind:unusedKind,key:unusedKey,previousId:unusedPrevious,sourceViewIds:unusedSources,...body}=raw;
    return {...body,kind:base.kind,key:base.key,previousId:target,sourceViewIds:[target,...(Array.isArray(body.mergePreviousIds)?body.mergePreviousIds:[])],sourceMemoryIds:body.sourceMemoryIds??[]};
  });
  if(errors.length)throw new ReadingDocumentError(errors);return bound;
}
export function parseViewProposals(value:unknown):ViewProposal[]|undefined{
  if(value===undefined)return;if(!Array.isArray(value))throw Error('views须为派生视图数组');
  const editErrors:string[]=[];
  for(const [viewIndex,proposal]of value.entries()){
    if(!proposal||typeof proposal!=='object'||Array.isArray(proposal)||proposal.operation!=='revise')continue;
    const path=`views[${viewIndex}].edits`,edits=proposal.edits;
    if(!Array.isArray(edits)||!edits.length){editErrors.push(`${path}须为非空数组，每项提交oldText/newText局部替换；只修正该概要，不修改documents`);continue;}
    for(const [editIndex,edit]of edits.entries()){
      const field=`${path}[${editIndex}]`;
      if(!edit||typeof edit!=='object'||Array.isArray(edit)){editErrors.push(`${field}须为只含oldText/newText的对象`);continue;}
      const extra=Object.keys(edit).filter(key=>!['oldText','newText'].includes(key));
      for(const key of extra)editErrors.push(`${field}.${key}不支持；概要每项edits只允许oldText/newText${key==='sourceIds'?`；将这些原文来源编号保留并合并到views[${viewIndex}].sourceIds，保留原修订文字，不改documents`:''}`);
      if(typeof edit.oldText!=='string'||!edit.oldText)editErrors.push(`${field}.oldText须为previousId原基版中的非空文字`);
      if(typeof edit.newText!=='string')editErrors.push(`${field}.newText须为文字；明确删除时填写空字符串`);
    }
  }
  if(editErrors.length)throw new ReadingDocumentError(editErrors);
  const keys=new Set<string>();return value.map((v:ViewProposal)=>{
    if(!v||typeof v!=='object'||Object.keys(v).some(k=>!['operation','kind','key','text','edits','sourceMemoryIds','reviewedMemoryIds','reviewChanges','replaceSources','reviewReason','dropSourceMemoryIds','sourceViewIds','previousId','mergePreviousIds','sourceIds','chatIds'].includes(k))||!['overview','current','topic','arc'].includes(v.kind)||typeof v.key!=='string'||!v.key.trim()||v.key.length>100||v.operation!==undefined&&!['publish','keep','revise'].includes(v.operation))throw Error('派生视图类型或作用域无效');
    if(v.reviewChanges!==undefined&&v.reviewChanges!==true||v.replaceSources!==undefined&&v.replaceSources!==true)throw Error('reviewChanges/replaceSources仅接受明确的true');
    if(v.previousId!==undefined&&(typeof v.previousId!=='string'||!v.previousId))throw Error('视图基版身份无效');
    if(v.operation==='keep'||v.operation==='revise'){
      if(!v.previousId||v.text!==undefined||!v.sourceViewIds?.includes(v.previousId))throw Error('keep/revise须previousId及sourceViewIds继承基版，且不重输text');
      if(v.operation==='keep'&&v.edits!==undefined)throw Error('keep不能同时修改正文');
    }else if(typeof v.text!=='string'||!v.text.trim()||v.edits!==undefined)throw Error('publish须有完整简明text且不同时提交edits');
    if(v.mergePreviousIds!==undefined&&(!['overview','current'].includes(v.kind)||!v.previousId||!Array.isArray(v.mergePreviousIds)||!v.mergePreviousIds.length||v.mergePreviousIds.some(id=>typeof id!=='string'||!id||id===v.previousId||!v.sourceViewIds?.includes(id))))throw Error('核心概要归并须主previousId及额外mergePreviousIds，额外前继须同时明确列入sourceViewIds');
    if(!Array.isArray(v.sourceMemoryIds)||v.sourceMemoryIds.some(x=>typeof x!=='string'||!x)||v.sourceViewIds!==undefined&&(!Array.isArray(v.sourceViewIds)||v.sourceViewIds.some(x=>typeof x!=='string'||!x)))throw Error('视图须绑定实际来源，旧视图仅为派生输入');
    for(const name of ['reviewedMemoryIds','dropSourceMemoryIds'] as const)if(v[name]!==undefined&&(!Array.isArray(v[name])||v[name]!.some(id=>typeof id!=='string'||!id)))throw Error('视图审阅或移除采用的版本身份无效');
    if(v.reviewReason!==undefined&&(typeof v.reviewReason!=='string'||!v.reviewReason.trim()||v.reviewReason.length>500))throw Error('reviewReason须为非空文字且不超过500字');
    if(v.dropSourceMemoryIds?.some(id=>v.sourceMemoryIds.includes(id)))throw Error('同一版本不能同时采用与移除采用');
    if(v.sourceIds!==undefined&&(!Array.isArray(v.sourceIds)||v.sourceIds.some(id=>typeof id!=='string'||!/^p[1-9]\d*$/.test(id)))||v.chatIds!==undefined&&(!Array.isArray(v.chatIds)||v.chatIds.some(id=>typeof id!=='string'||!id)))throw Error('视图原文或真实交流来源无效');
    if(!v.sourceMemoryIds.length&&!v.sourceViewIds?.length&&!v.sourceIds?.length&&!v.chatIds?.length)throw Error('派生视图须采用本次实际取得的来源');
    // Different bases can belong to shared and private documents with the same
    // key. Their actual ownership is checked together in planPublishedViews.
    const key=JSON.stringify([v.previousId??null,v.kind,v.key]);if(keys.has(key))throw Error('同一次发布不能重复同类视图作用域');keys.add(key);
    return{...structuredClone(v),sourceMemoryIds:[...new Set(v.sourceMemoryIds)],...(v.reviewedMemoryIds?{reviewedMemoryIds:[...new Set(v.reviewedMemoryIds)]}:{}),...(v.dropSourceMemoryIds?{dropSourceMemoryIds:[...new Set(v.dropSourceMemoryIds)]}:{}),...(v.sourceIds?{sourceIds:[...new Set(v.sourceIds)]}:{}),...(v.chatIds?{chatIds:[...new Set(v.chatIds)]}:{}),...(v.sourceViewIds?{sourceViewIds:[...new Set(v.sourceViewIds)]}:{}),...(v.mergePreviousIds?{mergePreviousIds:[...new Set(v.mergePreviousIds)]}:{})};
  });
}
/** Resolve all spans against the supplied base, never against earlier edits. */
export function revisedViewText(base:string,edits:NonNullable<ViewProposal['edits']>,field:string,viewId?:string):string{
  const errors:string[]=[],issues:import('./document-revision.ts').ReadingIssue[]=[],spans:{start:number;end:number;text:string;index:number}[]=[];
  for(const [index,edit]of edits.entries()){
    const start=base.indexOf(edit.oldText);
    if(!edit.oldText||start<0){errors.push(`${field}[${index}].oldText在previousId原基版中不存在；替换此项，不能引用其他edits的newText`);issues.push({code:'EDIT_NOT_FOUND',path:`${field}[${index}]`,target:viewId});}
    else if(base.indexOf(edit.oldText,start+1)>=0){errors.push(`${field}[${index}].oldText在原基版中出现多次；补充原文上下文以唯一定位`);issues.push({code:'EDIT_AMBIGUOUS',path:`${field}[${index}]`,target:viewId});}
    else spans.push({start,end:start+edit.oldText.length,text:edit.newText,index});
  }
  spans.sort((a,b)=>a.start-b.start);
  for(let i=0;i<spans.length;i++)for(let j=i+1;j<spans.length&&spans[j].start<spans[i].end;j++){errors.push(`${field}[${spans[i].index}]与[${spans[j].index}]在原基版中重叠；合成一次明确替换`);issues.push({code:'EDIT_OVERLAP',path:`${field}[${spans[i].index}]`,target:viewId});}
  if(errors.length)throw new ReadingDocumentError(errors,undefined,viewId?[viewId]:undefined,issues);
  let result=base;for(const span of [...spans].reverse())result=result.slice(0,span.start)+span.text+result.slice(span.end);
  if(!result.trim())throw new ReadingDocumentError([`${field}修改后的概要不能为空`],undefined,viewId?[viewId]:undefined);return result;
}
export function validatePublishedViews(state:State):void{
  for(const name of ['publishedViews','viewPublications','maintenanceJobs'] as const)if(state[name]!==undefined&&!Array.isArray(state[name]))throw Error('派生视图或维护集合无效');
  const ids=new Set<string>();
  for(const v of state.publishedViews??[]){
    if(v.formationSources)validateFormationSources(v.formationSources,state);
    const book=state.books.find(b=>b.id===v.bookId);
    if(v.scope!==undefined&&!['book','partner'].includes(v.scope)||!book||bookVersionPrefixLength(book,v.version)===undefined||!state.partners.some(p=>p.id===v.partnerId)||typeof v.id!=='string'||!v.id||ids.has(v.id)||!['overview','current','topic','arc'].includes(v.kind)||typeof v.key!=='string'||!v.key||typeof v.text!=='string'||!v.text.trim()||!Array.isArray(v.memorySources)||!Array.isArray(v.originalSources)||!Array.isArray(v.viewSources)||!Array.isArray(v.ranges)||!Array.isArray(v.chatIds)||!Array.isArray(v.evidence)||!Array.isArray(v.contextChatIds))throw Error('已发布派生视图的版本、范围或来源无效');
    ids.add(v.id);
    const validRange=(r:Range)=>r&&Number.isSafeInteger(r.start)&&Number.isSafeInteger(r.end)&&r.start>=0&&r.end>r.start&&r.end<=bookVersionPrefixLength(book,v.version)!;
    if(v.ranges.some(r=>!validRange(r)||!covers(v.evidence,r))||v.evidence.some(e=>!validRange(e)||e.bookId!==book.id||!editionAllowsSource(book,v.version,e.version,[e]))||v.chatIds.some(id=>!v.contextChatIds.includes(id))||v.contextChatIds.some(id=>!state.chats.some(c=>c.id===id&&c.bookId===book.id)))throw Error('视图覆盖或交流范围不属于形成来源');
    for(const s of v.memorySources)if(!state.memories.some(m=>m.id===s.id&&m.bookId===v.bookId&&(documentScope(v)==='book'||memoryReadableByPartner(state,m,v.partnerId)))||!/^[a-f0-9]{64}$/.test(s.hash))throw Error('派生视图认识来源身份无效');
    if(v.adoptedMemorySources!==undefined){
      if(!Array.isArray(v.adoptedMemorySources)||new Set(v.adoptedMemorySources.map(source=>source?.id)).size!==v.adoptedMemorySources.length)throw Error('视图明确采用的完整认识版本无效');
      for(const source of v.adoptedMemorySources){
        if(!source||typeof source.id!=='string'||!/^[a-f0-9]{64}$/.test(source.hash))throw Error('视图明确采用的完整认识版本无效');
        const directlyProvided=v.memorySources.some(provided=>provided.id===source.id&&provided.hash===source.hash);
        const inherited=v.viewSources.some(id=>state.publishedViews?.some(parent=>parent.id===id&&parent.adoptedMemorySources?.some(adopted=>adopted.id===source.id&&adopted.hash===source.hash)));
        if(!directlyProvided&&!inherited)throw Error('视图明确采用的完整认识版本不属于实际来源');
      }
    }
    if(v.reviewReason!==undefined&&(typeof v.reviewReason!=='string'||!v.reviewReason.trim()||v.reviewReason.length>500))throw Error('视图审阅理由无效');
    if(v.reviewedMemorySources!==undefined){
      if(!Array.isArray(v.reviewedMemorySources)||new Set(v.reviewedMemorySources.map(source=>source?.id)).size!==v.reviewedMemorySources.length)throw Error('视图明确审阅的认识版本无效');
      for(const source of v.reviewedMemorySources){
        if(!source||typeof source.id!=='string'||!/^[a-f0-9]{64}$/.test(source.hash)||!state.memories.some(memory=>memory.id===source.id&&memory.bookId===v.bookId&&(documentScope(v)==='book'||memoryReadableByPartner(state,memory,v.partnerId))))throw Error('视图明确审阅的认识版本无效');
        const directlyProvided=v.memorySources.some(provided=>provided.id===source.id&&provided.hash===source.hash);
        const inherited=[...v.viewSources,...(v.previousId?[v.previousId]:[]),...(v.mergePreviousIds??[])].some(id=>state.publishedViews?.some(parent=>parent.id===id&&parent.bookId===v.bookId&&editionAllowsSource(book,v.version,parent.version,parent.evidence)&&(documentScope(v)==='book'||viewReadableByPartner(state,parent,v.partnerId))&&parent.reviewedMemorySources?.some(reviewed=>reviewed.id===source.id&&reviewed.hash===source.hash)));
        if(!directlyProvided&&!inherited)throw Error('视图明确审阅的认识版本不属于实际供材或历史审阅记录');
      }
    }
    for(const s of v.originalSources)if(s.evidence.bookId!==book.id||!editionAllowsSource(book,v.version,s.evidence.version,[s.evidence])||!/^[a-f0-9]{64}$/.test(s.hash)||s.evidence.start<0||s.evidence.end<=s.evidence.start||s.evidence.end>(book.textLength??book.text.length))throw Error('派生视图原文来源无效');
  }
  for(const v of state.publishedViews??[]){
    if(v.viewSources.some(id=>!ids.has(id))||v.previousId&&!ids.has(v.previousId))throw Error('派生视图历史身份缺失');
    if(v.mergePreviousIds!==undefined&&(!Array.isArray(v.mergePreviousIds)||!v.mergePreviousIds.length||new Set(v.mergePreviousIds).size!==v.mergePreviousIds.length||!v.mergePreviousIds.every(id=>typeof id==='string'&&ids.has(id))||!viewLineage(state,v)))throw Error('核心概要明确归并前继或祖先链无效');
  }
  for(const p of state.viewPublications??[])if(!state.books.some(b=>b.id===p.bookId&&bookVersionPrefixLength(b,p.version)!==undefined)||p.scope!==undefined&&!['book','partner'].includes(p.scope)||p.id!==publicationId({id:p.bookId,version:p.version},p.partnerId,p.scope??'partner')||!Number.isSafeInteger(p.revision)||p.revision<1||!Array.isArray(p.viewIds)||p.viewIds.some(id=>!state.publishedViews?.some(v=>v.id===id&&v.bookId===p.bookId&&editionAllowsSource(state.books.find(book=>book.id===p.bookId)!,p.version,v.version,v.evidence)&&(p.scope==='book'?documentScope(v)==='book':documentScope(v)==='partner'&&v.partnerId===p.partnerId))))throw Error('视图发布清单无效');
  const jobs=new Set<string>();for(const j of state.maintenanceJobs??[]){if(j.dismissed!==undefined&&(!j.dismissed||typeof j.dismissed!=='object'||Array.isArray(j.dismissed)||Object.keys(j.dismissed).some(key=>key!=='at')||!Number.isFinite(j.dismissed.at)||j.dismissed.at<0||j.status!=='blocked'))throw Error('维护待办退出记录无效');if(j.viewReviewRanges!==undefined&&(!Array.isArray(j.viewReviewRanges)||JSON.stringify(j.viewReviewRanges)!==JSON.stringify(mergeRanges(j.viewReviewRanges))||j.viewReviewRanges.some(r=>!Number.isSafeInteger(r.start)||!Number.isSafeInteger(r.end)||r.start<0||r.end<=r.start)))throw Error('维护概要补核范围无效');if(j.sceneRecordIds!==undefined&&(!Array.isArray(j.sceneRecordIds)||new Set(j.sceneRecordIds).size!==j.sceneRecordIds.length||j.sceneRecordIds.some(id=>typeof id!=='string'||!id)))throw Error('维护现场成果引用无效');if(!state.books.some(b=>b.id===j.bookId&&bookVersionPrefixLength(b,j.version)!==undefined&&j.ranges.every(range=>bookVersionAllowsRange(b,j.version,range)))||typeof j.id!=='string'||!j.id||jobs.has(j.id)||!['pending','running','paused','blocked'].includes(j.status)||!Array.isArray(j.ranges)||!Array.isArray(j.chatIds)||j.viewTargets!==undefined&&(!Array.isArray(j.viewTargets)||JSON.stringify(j.viewTargets)!==JSON.stringify(canonicalMaintenanceViewTargets(j.viewTargets))||j.viewTargets.some(target=>!isMaintenanceViewTarget(target)||target.startsWith('view:')&&!state.publishedViews?.some(view=>view.id===target.slice(5)&&view.bookId===j.bookId&&editionAllowsSource(state.books.find(book=>book.id===j.bookId)!,j.version,view.version,view.evidence)&&viewReadableByPartner(state,view,j.partnerId)))))throw Error('持续认识维护记录无效');jobs.add(j.id);}
}
export function publicationId(book:Pick<Book,'id'|'version'>,partnerId:string,scope:'book'|'partner'='book'):string{return JSON.stringify(scope==='book'?[book.id,book.version,'scope','book']:[book.id,book.version,partnerId]);}
function currentViewPublication(state:State,book:Book,partnerId:string,scope:'book'|'partner'='book'){
  for(const version of [book.version,...(book.sourceLineage?.prefixes??[]).map(prefix=>prefix.version).reverse()]){const publication=state.viewPublications?.find(p=>p.id===publicationId({id:book.id,version},partnerId,scope));if(publication)return publication;}
}
/** Combine proven book-scoped publication heads without inferring any content
 * merge. Separate roots stay visible until a real author adopts/merges them. */
export function buildBookViewPublication(state:State,book:Book,partnerId=state.partnerId,viewIds?:readonly string[]):ViewPublication|undefined{
  const prior=currentViewPublication(state,book,partnerId),versions=[book.version,...(book.sourceLineage?.prefixes??[]).map(prefix=>prefix.version).reverse()],seenOwners=new Set<string>();
  const ids:string[]=[];
  if(viewIds)ids.push(...viewIds);else for(const version of versions)for(const publication of state.viewPublications??[]){
    if(publication.bookId!==book.id||publication.version!==version)continue;
    const owner=publication.scope==='book'?'book':'partner:'+publication.partnerId;if(seenOwners.has(owner))continue;seenOwners.add(owner);ids.push(...publication.viewIds);
  }
  const candidates=[...new Set(ids)].flatMap(id=>{const view=state.publishedViews?.find(v=>v.id===id&&v.bookId===book.id&&documentScope(v)==='book'&&bookVersionAllowsRanges(book,v.version,v.evidence));return view?[view]:[];});
  const heads=candidates.filter(view=>!candidates.some(next=>viewDescendsFrom(state,next,view.id))).map(view=>view.id);
  if(!heads.length)return;
  return{scope:'book',id:publicationId(book,partnerId),bookId:book.id,version:book.version,partnerId,revision:(prior?.revision??0)+1,viewIds:heads};
}
export type PublishedViewCheck={memories:Map<string,Memory>;chats:Map<string,State['chats'][number]>;views:Map<string,PublishedView>;memo:Map<string,boolean>;passedSources:Set<string>;evidence:ReturnType<typeof createEvidenceChecker>;chat:ReturnType<typeof createChatMemoryChecker>;source:(kind:'memory'|'chat',id:string)=>boolean;auditAllowed:(audit:import('./types.ts').FormationSources)=>boolean;descends:(view:PublishedView,ancestorId:string)=>boolean;reviewedSource:(view:PublishedView,sourceId:string)=>boolean;current?:PublishedView[];checkedRanges?:{overview:Range[];current:Range[];both:Range[]};updates:Map<string,{previousId:string;currentId:string}[]>};
/** This object belongs to one synchronous check/projection, never an await or a later edit. */
export function createPublishedViewCheck(state:State,book:Book,memo=new Map<string,boolean>(),expandedCommitted?:PublishedViewCheck):PublishedViewCheck{
  const memories=new Map<string,Memory>(),chats=new Map<string,State['chats'][number]>(),views=new Map<string,PublishedView>();
  for(const memory of state.memories)if(memory.bookId===book.id)memories.set(memory.id,memory);
  for(const chat of state.chats)if(chat.bookId===book.id)chats.set(chat.id,chat);
  for(const view of state.publishedViews??[])if(view.bookId===book.id&&bookVersionAllowsRanges(book,view.version,view.evidence))views.set(view.id,view);
  // Only the committed projection supplies expandedCommitted, after checking
  // unchanged source records/editions and monotonic grants in every book.
  // Negative verdicts and version updates must see the new permission boundary.
  if(expandedCommitted)for(const [id,allowed]of expandedCommitted.memo)if(allowed)memo.set(id,true);
  const evidence=createEvidenceChecker(book),chat=createChatMemoryChecker(state),passed=new Set(expandedCommitted?.passedSources),failed=new Set<string>();
  const auditAllowed=formationSourceChecker(state,evidence);
  const source=(kind:'memory'|'chat',id:string):boolean=>{
    const root=kind+':'+id;if(passed.has(root))return true;if(failed.has(root))return false;
    const reject=(key:string)=>{failed.add(key);failed.add(root);return false;};
    const seen=new Set<string>(),scheduled=new Set([root]),pending=[{kind,id}];
    while(pending.length){const next=pending.pop()!,key=next.kind+':'+next.id;if(seen.has(key)||passed.has(key))continue;seen.add(key);
      if(failed.has(key))return reject(root);
      const enqueue=(kind:'memory'|'chat',id:string)=>{const dependency=kind+':'+id;if(!passed.has(dependency)&&!scheduled.has(dependency)){scheduled.add(dependency);pending.push({kind,id});}};
      if(next.kind==='memory'){const memory=memories.get(next.id);if(!memory||!state.partners.some(p=>p.id===memory.partnerId)||!isUsableSourceVersion(state,memory)||memoryIsForgotten(state,memory)||!evidence(memory.evidence))return reject(key);
        if(memory.formationSources){if(!auditAllowed(memory.formationSources))return reject(key);continue;}
        for(const id of [...memory.parents,...(memory.basis?.memoryIds??[])])enqueue('memory',id);for(const id of [...memory.chatIds,...(memory.basis?.chatIds??[])])enqueue('chat',id);
      }else{const item=chats.get(next.id),owner=item?.partnerId??state.partners.find(p=>p.legacyUnlabelled)?.id??(state.partners.length===1?state.partners[0].id:undefined);if(!item||!owner||!chatBelongsToPartner({...state,partnerId:owner},item)||!chat(item)||item.excluded||item.outdatedBy||item.replacedBy||item.futureGrant||!evidence(item.evidence))return reject(key);
        for(const id of [...(item.memoryIds??[]),...(item.basis?.memoryIds??[])])enqueue('memory',id);for(const id of [...(item.contextChatIds??[]),...(item.basis?.chatIds??[]),...(item.replyTo?[item.replyTo]:[]),...(item.paragraphCommentId?[item.paragraphCommentId]:[])])enqueue('chat',id);
      }
    }for(const key of seen)passed.add(key);return true;
  };
  // Lineage is structural, but its validity still uses this exact edition. Keep
  // the index and verdicts inside this synchronous check, including on mutable State.
  const lineageViews=new Map((state.publishedViews??[]).map(view=>[view.id,view])),books=new Map(state.books.map(book=>[book.id,book])),lineages=new Map<PublishedView,Set<string>|undefined>();
  const lineage=(view:PublishedView)=>{if(!lineages.has(view))lineages.set(view,viewLineage(state,view,lineageViews,books));return lineages.get(view);};
  const descends=(view:PublishedView,ancestorId:string)=>{
    if(view.id===ancestorId)return false;
    return !!lineage(view)?.has(ancestorId);
  };
  const versions=new Map(state.memories.map(memory=>[memory.id,memory])),development=new Map<Memory,Set<string>>(),reviewed=new Map<PublishedView,Set<string>>();
  const developmentAncestors=(memory:Memory)=>{
    let ids=development.get(memory);if(ids)return ids;
    ids=new Set<string>();const pending=[memory.id];
    while(pending.length){const id=pending.pop()!;if(ids.has(id))continue;ids.add(id);const current=versions.get(id);if(current?.revisionKind==='development')pending.push(...[current.correctionOf,...(current.mergePreviousIds??[])].filter((id):id is string=>!!id));}
    development.set(memory,ids);return ids;
  };
  // One view's actual review/adoption history is indexed once for this check.
  // Development ancestry expands only a verified source version; ownership and
  // permission retain the same per-source requirements as the direct lookup.
  const reviewedSource=(view:PublishedView,sourceId:string)=>{
    if(!versions.has(sourceId))return false;
    let ids=reviewed.get(view);
    if(!ids){
      ids=new Set<string>();const seen=new Set<string>();
      for(const ancestorId of lineage(view)??[]){const prior=lineageViews.get(ancestorId);if(!prior)continue;
        for(const source of [...(prior.reviewedMemorySources??[]),...(prior.adoptedMemorySources??[])]){
          const identity=source.id+':'+source.hash;if(seen.has(identity))continue;seen.add(identity);
          const memory=versions.get(source.id);if(!memory||!memoryReadableByPartner(state,memory)||!evidence(memory.evidence)||memoryContentIdentity(memory).hash!==source.hash)continue;
          for(const id of developmentAncestors(memory)){const original=versions.get(id);if(original&&sameDocumentOwner(memory,original))ids.add(id);}
        }
      }
      reviewed.set(view,ids);
    }
    return ids.has(sourceId);
  };
  return{memories,chats,views,memo,passedSources:passed,evidence,chat,source,auditAllowed,descends:expandedCommitted?.descends??descends,reviewedSource,updates:new Map()};
}
/** Only share within one synchronous check. No state or body cache survives it. */
export function publishedViewChecker(state:State,book:Book,check?:PublishedViewCheck):(view:PublishedView)=>boolean{
  return view=>{check??=createPublishedViewCheck(state,book);return viewAllowed(state,book,view,new Set(),check.memo,check);};
}
export function viewAllowed(state:State,book:Book,view:PublishedView,seen=new Set<string>(),memo=new Map<string,boolean>(),index?:PublishedViewCheck,internal=false):boolean{
  if(!internal&&!viewReadableByPartner(state,view))return false;
  if(memo.has(view.id))return memo.get(view.id)!;
  index??=createPublishedViewCheck(state,book,memo);
  if(view.bookId!==book.id||!bookVersionAllowsRanges(book,view.version,view.evidence)||!state.partners.some(p=>p.id===view.partnerId)||seen.has(view.id)||!index.evidence(view.evidence))return false;
  seen.add(view.id);
  const valid=view.formationSources?index.auditAllowed(view.formationSources):view.memorySources.every(s=>{const m=index!.memories.get(s.id);if(!m||m.forgotten||m.invalidatedBy||m.bookId!==book.id||!index!.source('memory',m.id)||!index!.evidence(m.evidence))return false;try{return memoryContentIdentity(m).hash===s.hash;}catch{return false;}})&&view.contextChatIds.every(id=>{const c=index!.chats.get(id);return!!c&&index!.source('chat',c.id);})&&view.viewSources.every(id=>{const source=index!.views.get(id);return!!source&&viewAllowed(state,book,source,seen,memo,index,true);});
  seen.delete(view.id);memo.set(view.id,valid);return valid;
}
export function currentPublishedViews(state:State,book:Book,input:Map<string,boolean>|PublishedViewCheck=new Map()):PublishedView[]{
  const check=input instanceof Map?createPublishedViewCheck(state,book,input):input;
  if(check.current)return check.current;
  const shared=currentViewPublication(state,book,state.partnerId),personal=currentViewPublication(state,book,state.partnerId,'partner');
  const candidates=[...new Set([...(shared?.viewIds??[]),...(personal?.viewIds??[])])].map(id=>check.views.get(id)).filter((v):v is PublishedView=>!!v&&viewAllowed(state,book,v,new Set(),check.memo,check));
  return check.current=candidates.filter(view=>!candidates.some(next=>check.descends(next,view.id)));
}
/** Core projections are book-wide responsibilities. Multiple live roots are
 * unresolved legacy branches, never separate topics selected by recency. */
export function coreViewHeads(state:State,book:Book,check:Map<string,boolean>|PublishedViewCheck=new Map()):PublishedView[]{return currentPublishedViews(state,book,check).filter(view=>view.kind==='overview'||view.kind==='current');}
/** Only explicit succession/merge edges carry responsibility. General supplied
 * viewSources are exposure, never proof that another projection was merged. */
function viewLineage(state:State,view:PublishedView,views=new Map((state.publishedViews??[]).map(view=>[view.id,view])),books=new Map(state.books.map(book=>[book.id,book]))):Set<string>|undefined{
 const ancestors=new Set<string>(),active=new Set<string>();
 const visit=(node:PublishedView):boolean=>{
  if(active.has(node.id))return false;if(ancestors.has(node.id))return true;
  active.add(node.id);
  for(const [parentId,merge] of [...(node.previousId?[[node.previousId,false] as const]:[]),...(node.mergePreviousIds??[]).map(id=>[id,true] as const)]){
   const parent=views.get(parentId),book=books.get(node.bookId);
   if(!parent||!book||parent.bookId!==node.bookId||!editionAllowsSource(book,node.version,parent.version,parent.evidence)||!sameDocumentOwner(parent,node)||parent.kind!==node.kind||(!merge&&parent.key!==node.key)||(merge&&(!['overview','current'].includes(node.kind)||!node.previousId||parentId===node.previousId||!node.viewSources.includes(parentId)))||!visit(parent))return false;
  }
  active.delete(node.id);ancestors.add(node.id);return true;
 };
 return visit(view)?ancestors:undefined;
}
export function viewDescendsFrom(state:State,view:PublishedView,ancestorId:string):boolean{return view.id!==ancestorId&&!!viewLineage(state,view)?.has(ancestorId);}
/** Recovery may merge confirmed repeated initialization of the same core
 * responsibility, not arbitrary similarly named projections. */
export function coreViewMergeGroups(state:State,book:Book){
 const heads=coreViewHeads(state,book);
 return(['overview','current'] as const).flatMap(kind=>heads.filter(view=>view.kind===kind).flatMap((head,index,peers)=>{
  if(peers.slice(0,index).some(previous=>sameDocumentOwner(previous,head)))return[];
  const group=peers.filter(view=>sameDocumentOwner(view,head));if(group.length<2)return[];
  const roots=state.usage.flatMap(usage=>{const dispatch=usage.maintenanceDispatch;return usage.status==='complete'&&!usage.modelOutcome&&dispatch?maintenanceProgressFacts(dispatch).flatMap(fact=>fact.processed.viewTargets.includes(kind)?fact.viewIds.flatMap(id=>{const view=state.publishedViews?.find(v=>v.id===id&&v.bookId===book.id&&bookVersionAllowsRanges(book,v.version,v.evidence)&&viewReadableByPartner(state,v)&&v.kind===kind&&!v.previousId);return view?[view]:[];}):[]):[];});
  const proven=group.filter(head=>roots.some(root=>root.id===head.id||viewDescendsFrom(state,head,root.id)));return proven.length>1?[{kind,heads:proven}]:[];
 }));
}
export function resolveMaintenanceViewTargets(state:State,book:Book,targets:readonly import('./types.ts').MaintenanceViewTarget[],check?:PublishedViewCheck):import('./types.ts').MaintenanceViewTarget[]{
 const published=currentPublishedViews(state,book,check);
 return canonicalMaintenanceViewTargets(targets.flatMap(target=>{
  const successors=target.startsWith('view:')?published.filter(view=>view.id===target.slice(5)||(check?check.descends(view,target.slice(5)):viewDescendsFrom(state,view,target.slice(5)))):published.filter(view=>view.kind===target);
  return successors.length?successors.map(view=>('view:'+view.id) as import('./types.ts').MaintenanceViewTarget):[target];
 }));
}
/** Old normal archives did not record author adoption separately. Keep their
 * former conservative version-check responsibility until a real successor
 * declares adoption; this fallback never orders those bodies into a prompt. */
const viewVersionDependencies=(view:PublishedView)=>view.adoptedMemorySources??view.memorySources;
/** A retired current document makes its development lineage unavailable for
 * new adoption. Existing adoption must be removed by an explicit model action. */
function retiredLineageIds(state:State,provided:Memory[]):Set<string>{
 const versions=new Map([...state.memories,...provided].map(m=>[m.id,m])),ids=new Set<string>();
 const pending=provided.filter(m=>m.documentState==='retired'&&!m.replacedBy&&!state.memories.find(old=>old.id===m.id)?.replacedBy).map(m=>m.id);
 while(pending.length){const id=pending.pop()!;if(ids.has(id))continue;ids.add(id);const memory=versions.get(id);if(memory?.revisionKind==='development')pending.push(...[memory.correctionOf,...(memory.mergePreviousIds??[])].filter((id):id is string=>!!id));}
 return ids;
}
function memoryDevelopmentIncludes(state:State,provided:Memory[],memory:Memory,ancestorId:string,index?:ReadonlyMap<string,Memory>):boolean{
  const versions=index??new Map([...state.memories,...provided].map(item=>[item.id,item])),pending=[memory.id],seen=new Set<string>();
  while(pending.length){const id=pending.pop()!;if(id===ancestorId)return true;if(seen.has(id))continue;seen.add(id);const current=versions.get(id);if(current?.revisionKind==='development')pending.push(...[current.correctionOf,...(current.mergePreviousIds??[])].filter((id):id is string=>!!id));}
  return false;
}
/** Exact immutable review/adoption versions, including a legitimate reviewed
 * development successor, settle that source. A merely newer overview does not. */
export function viewReviewedMemorySource(state:State,book:Book,view:PublishedView,sourceId:string,check=createPublishedViewCheck(state,book)):boolean{
 return check.reviewedSource(view,sourceId);
}
function sameMemoryMeaning(previous:Memory,next:Memory):boolean{
  let sameBody:boolean;try{sameBody=memoryContentIdentity(previous).hash===memoryContentIdentity(next).hash;}catch{sameBody=typeof previous.text==='string'&&previous.text===next.text;}
  const meaning=(memory:Memory)=>[memory.documentState,memory.temporal,memory.clue,memory.stateProjection,memory.arcProjection,memory.stageNarrative,memory.narrative,memory.about,memory.identityClaim,memory.attribution,memory.ruleLinks,memory.worldChangeOf,memory.entityBindings,memory.sourceEvidence,memory.sourceQuote];
  return sameBody&&JSON.stringify(meaning(previous))===JSON.stringify(meaning(next));
}
/** Adoption follows its real permitted development chain even when its present
 * head was reviewed without adoption. Review acknowledgement is a later filter. */
function adoptedMemoryHeads(state:State,book:Book,view:PublishedView,check:PublishedViewCheck):{previousId:string;currentId:string}[]{
  if(!viewAllowed(state,book,view,new Set(),check.memo,check))return [];
  const heads:{previousId:string;currentId:string}[]=[];
  for(const source of viewVersionDependencies(view)){
    let memory=check.memories.get(source.id),seen=new Set<string>();if(!memory||!memoryReadableByPartner(state,memory)||memoryContentIdentity(memory).hash!==source.hash)continue;
    while(memory.replacedBy){
      if(seen.has(memory.id))break;seen.add(memory.id);
      const next:Memory|undefined=check.memories.get(memory.replacedBy);
      if(!next||next.revisionKind!=='development'||next.forgotten||next.invalidatedBy||next.reviewDisposition==='unsupported'||next.bookId!==view.bookId||!sameDocumentOwner(memory,next)||!memoryReadableByPartner(state,next)||!check.evidence(next.evidence))break;
      memory=next;
    }
    heads.push({previousId:source.id,currentId:memory.id});
  }
  return heads;
}
/** Review settles only the exact version inspected. Its future successor is
 * still a responsibility, and review never implies adoption as story evidence. */
export function viewVersionUpdates(state:State,book:Book,view:PublishedView,input:Map<string,boolean>|PublishedViewCheck=new Map()):{previousId:string;currentId:string}[]{
  const check=input instanceof Map?createPublishedViewCheck(state,book,input):input;
  const previous=check.updates.get(view.id);if(previous)return previous;
  const acknowledged=new Map([...viewVersionDependencies(view),...(view.reviewedMemorySources??[])].map(source=>[source.id,source.hash])),updates=new Map<string,{previousId:string;currentId:string}>();
  for(const head of adoptedMemoryHeads(state,book,view,check)){
    const memory=check.memories.get(head.currentId)!;
    // A reviewed successor settles that version even when it was not adopted.
    // It is an acknowledgement, not an additional source to subscribe to.
    const unchanged=[...acknowledged].some(([id,hash])=>{const previous=check.memories.get(id);return !!previous&&memoryContentIdentity(previous).hash===hash&&sameMemoryMeaning(previous,memory)&&memoryDevelopmentIncludes(state,[],memory,id,check.memories);});
    if(head.currentId!==head.previousId&&!unchanged&&acknowledged.get(head.currentId)!==memoryContentIdentity(memory).hash)updates.set(head.currentId,head);
  }
  const result=[...updates.values()];check.updates.set(view.id,result);return result;
}
/** The model reads the published body and its actual adoption status. The
 * conservative memory/view/chat closure remains local for withdrawal checks;
 * it is neither an instruction nor an implicit full-body retrieval list. */
/** A legal published snapshot may still precede scheduled, understood work.
 * Show that lag separately from permissions and from original understanding. */
function viewHasPendingReview(state:State,book:Book,view:PublishedView,check=createPublishedViewCheck(state,book)):boolean{
 if(viewVersionUpdates(state,book,view,check).length)return true;
 const jobs=(state.maintenanceJobs??[]).filter(job=>!job.dismissed&&job.bookId===book.id&&bookVersionPrefixLength(book,job.version)!==undefined&&(job.scope==='book'||job.partnerId===state.partnerId));
 for(const job of jobs){
  const targets=resolveMaintenanceViewTargets(state,book,job.viewTargets??[],check);
  if(!targets.some(target=>target===view.kind||target==='view:'+view.id))continue;
  const ranges=intersectRanges(book.known,[...job.ranges,...(job.viewReviewRanges??[])]);
  if((view.kind==='overview'||view.kind==='current')&&ranges.length){const pending=maintenancePendingViewReview(state,book,ranges,[`view:${view.id}`],check);if(pending.sourceRanges.length||pending.originalRanges.length)return true;}
  else if(!maintenanceViewTargetComplete(state,book,`view:${view.id}`,currentPublishedViews(state,book,check)))return true;
 }
 return false;
}
export function publishedViewMaterial(state:State,book:Book,view:PublishedView,id=view.id,includeSources=false){
  return{id,version:view.id,scope:documentScope(view),generatedByPartnerId:view.partnerId,history:!currentPublishedViews(state,book).some(head=>head.id===view.id),...(documentScope(view)==='book'?{documentAttribution:'书籍共享概要；伙伴称谓和个人看法属于记录的生成者，不代表当前伙伴经历；私人来源不自动展开。'}:{}),kind:view.kind,key:view.key,text:view.text,textChars:view.text.length,targetChars:1800,...(includeSources?{checkedRanges:view.ranges}:{checkedRangeCount:view.ranges.length,checkedChars:view.ranges.reduce((sum,range)=>sum+range.end-range.start,0)}),...(view.adoptedMemorySources?{adoptedMemoryCount:view.adoptedMemorySources.length,...(includeSources?{adoptedMemoryIds:view.adoptedMemorySources.filter(source=>{const memory=state.memories.find(m=>m.id===source.id);return !!memory&&memoryReadableByPartner(state,memory);}).map(source=>source.id)}:{})}:{legacyVersionDependencies:true}),...(view.reviewedMemorySources?{reviewedMemoryCount:view.reviewedMemorySources.length,...(includeSources?{reviewedMemoryIds:view.reviewedMemorySources.filter(source=>{const memory=state.memories.find(m=>m.id===source.id);return !!memory&&memoryReadableByPartner(state,memory);}).map(source=>source.id)}:{})}:{}),includesChatCount:view.chatIds.length,lagging:viewHasPendingReview(state,book,view)};
}
export function maintenanceViewTargetStatus(state:State,book:Book,target:import('./types.ts').MaintenanceViewTarget,added:PublishedView[]){
  if(!target.startsWith('view:')){const complete=added.some(view=>view.kind===target);return{complete,scopeMatched:complete,previousIdMatched:complete,missingMemoryIds:[] as string[]};}
  const old=state.publishedViews?.find(view=>view.id===target.slice(5));if(!old)return{complete:false,scopeMatched:false,previousIdMatched:false,missingMemoryIds:[] as string[]};
  const updates=viewVersionUpdates(state,book,old);
  const candidates=added.filter(view=>maintenanceViewProposalMatch(state,target,view).scopeMatched).map(view=>{
    const missingMemoryIds=updates.filter(update=>{const memory=state.memories.find(m=>m.id===update.currentId)!,hash=memoryContentIdentity(memory).hash;
      // Old saved proposals can explicitly adopt an updated version. New review
      // records also settle a version the author inspected and chose not to use.
      return ![...(view.reviewedMemorySources??[]),...(view.adoptedMemorySources??[])].some(source=>source.id===memory.id&&source.hash===hash);
    }).map(update=>update.currentId);
    const previousIdMatched=viewDescendsFrom(state,view,old.id);return{complete:previousIdMatched&&!missingMemoryIds.length,scopeMatched:true,previousIdMatched,missingMemoryIds};
  });
  return candidates.find(candidate=>candidate.complete)??candidates.sort((a,b)=>(Number(!a.previousIdMatched)+a.missingMemoryIds.length)-(Number(!b.previousIdMatched)+b.missingMemoryIds.length))[0]??{complete:false,scopeMatched:false,previousIdMatched:false,missingMemoryIds:updates.map(update=>update.currentId)};
}
export function maintenanceViewTargetComplete(state:State,book:Book,target:import('./types.ts').MaintenanceViewTarget,added:PublishedView[]):boolean{return maintenanceViewTargetStatus(state,book,target,added).complete;}
/** A bounded execution must actually review every selected source for each
 * target. It may publish an honest still-lagging successor; full completion is
 * computed independently with maintenanceViewTargetComplete. */
export function maintenanceViewBatchComplete(state:State,book:Book,target:import('./types.ts').MaintenanceViewTarget,added:PublishedView[],memoryIds:readonly string[]):boolean{
 return added.some(view=>{
  const match=maintenanceViewTargetStatus(state,book,target,[view]);
  if(!match.scopeMatched||!match.previousIdMatched)return false;
  return memoryIds.every(id=>{const memory=state.memories.find(memory=>memory.id===id);return !!memory&&[...(view.reviewedMemorySources??[]),...(view.adoptedMemorySources??[])].some(source=>source.id===id&&source.hash===memoryContentIdentity(memory).hash);});
 });
}
export function viewMaintenanceTargets(state:State,book:Book,check=createPublishedViewCheck(state,book)):import('./types.ts').MaintenanceViewTarget[]{return canonicalMaintenanceViewTargets(currentPublishedViews(state,book,check).filter(view=>viewVersionUpdates(state,book,view,check).length).map(view=>`view:${view.id}` as const));}
/** Views newly affected by this plan, including a view that was already behind
 * and whose current successor is being revised again. Historical unrelated debt
 * stays with its own future claim. */
export function affectedMaintenanceViewTargets(state:State,book:Book,developments:readonly {previousId:string;nextId:string}[],added:readonly Memory[]=[]){
  const versions=new Map([...state.memories,...added].map(memory=>[memory.id,memory]));
  const changed=new Set(developments.filter(development=>{
    const previous=versions.get(development.previousId),next=versions.get(development.nextId);if(!previous||!next)return true;
    return !sameMemoryMeaning(previous,next);
  }).map(d=>d.previousId));
  // A conversation may produce a new book understanding without changing an
  // already adopted source. Review the existing overview in that case; user
  // requirements and uncompleted questions do not themselves revise the book.
  const bookChanged=added.some(memory=>!memory.correctionOf&&memory.bookId===book.id&&documentScope(memory)==='book'&&memoryReadableByPartner(state,memory)&&!memory.historicalOnly&&!memory.forgotten&&!memory.invalidatedBy&&['story','opinion','context','stage','state','arc'].includes(memory.kind));
  const check=createPublishedViewCheck(state,book);
  return canonicalMaintenanceViewTargets(currentPublishedViews(state,book,check).filter(view=>bookChanged&&view.kind==='overview'||adoptedMemoryHeads(state,book,view,check).some(head=>changed.has(head.previousId)||changed.has(head.currentId))).map(view=>('view:'+view.id) as import('./types.ts').MaintenanceViewTarget));
}
/** Review is an explicit model assertion. Only the actual supplied full texts
 * and this proposal's new documents can expand that assertion. */
export function expandViewReviewChanges(state:State,book:Book,proposals:ViewProposal[],provided:Memory[],changedIds:string[],readMemoryIds?:readonly string[],reviewMaterials?:readonly import('./material-projection.ts').MaterialExposure[],boundedReview=false):ViewProposal[]{
  const reviewedByDelta=reviewMaterials?deltaReviewedMemoryIds(provided,reviewMaterials):new Set<string>();
  const missing=new Set<string>(),issues:import('./document-revision.ts').ReadingIssue[]=[];
  const result=proposals.map((proposal,index)=>{
    if(!proposal.reviewChanges)return proposal;
    const predecessors=[proposal.previousId,...(proposal.mergePreviousIds??[])].flatMap(id=>state.publishedViews?.filter(view=>view.id===id&&viewAllowed(state,book,view))??[]);
    const ids=[...new Set([...changedIds,...(boundedReview?[]:predecessors.flatMap(view=>viewVersionUpdates(state,book,view).map(update=>update.currentId)))])];
    const unread=ids.filter(id=>!provided.some(m=>m.id===id&&typeof m.text==='string'&&m.bookId===book.id&&memoryReadableByPartner(state,m)&&isEvidenceAllowed(book,m.evidence)&&(readMemoryIds===undefined||readMemoryIds.includes(id)||reviewedByDelta.has(id))));
    for(const id of unread){missing.add(id);issues.push({code:'MATERIAL_RANGE_MISSING',path:`views[${index}].decision`,target:id});}
    return {...proposal,reviewedMemoryIds:[...new Set([...(proposal.reviewedMemoryIds??[]),...ids])]};
  });
  if(missing.size)throw new ReadingDocumentError(['本批概要决定涉及尚未实际取得的变更；可取全文，或实际已读旧版加准确差异及局部上下文，核对后续交原候选decision'],[...missing],undefined,issues);
  return result;
}
/** Match actual immutable ids after resolving the task's handles. Both early
 * feedback and final proposal diagnosis use explicit succession/merge edges. */
export function maintenanceViewProposalMatch(state:State,target:import('./types.ts').MaintenanceViewTarget,proposal:{kind?:unknown;key?:unknown;previousId?:unknown;mergePreviousIds?:unknown}):{scopeMatched:boolean;previousIdMatched:boolean}{
  if(!target.startsWith('view:')){const matched=proposal.kind===target;return{scopeMatched:matched,previousIdMatched:matched};}
  const old=state.publishedViews?.find(view=>view.id===target.slice(5)),base=state.publishedViews?.find(view=>view.id===proposal.previousId);
  if(!old||proposal.kind!==old.kind)return{scopeMatched:false,previousIdMatched:false};
  const owner=base??{bookId:old.bookId,partnerId:state.partnerId,scope:'book' as const};
  if(!sameDocumentOwner(old,owner))return{scopeMatched:false,previousIdMatched:false};
  const parents=[proposal.previousId,...(Array.isArray(proposal.mergePreviousIds)?proposal.mergePreviousIds:[])];
  const descends=parents.some(id=>typeof id==='string'&&state.publishedViews?.some(view=>view.id===id&&sameDocumentOwner(view,old)&&(id===old.id||viewDescendsFrom(state,view,old.id))));
  return{scopeMatched:proposal.key===old.key||descends,previousIdMatched:descends&&!!base&&proposal.kind===base.kind&&proposal.key===base.key};
}
/** These checks do not depend on successfully editing a body. Report them in
 * the same feedback as bad edit spans, rather than on the next model request. */
export function maintenanceViewProposalErrors(state:State,book:Book,targets:import('./types.ts').MaintenanceViewTarget[],proposals:ViewProposal[],labels:Record<string,string>={},reviewScope?:readonly string[]):{errors:string[];issues:import('./document-revision.ts').ReadingIssue[]}{
  const errors:string[]=[],issues:import('./document-revision.ts').ReadingIssue[]=[];
  for(const target of targets){
    const old=target.startsWith('view:')?state.publishedViews?.find(v=>v.id===target.slice(5)):undefined;
    const index=proposals.findIndex(proposal=>maintenanceViewProposalMatch(state,target,proposal).previousIdMatched);
    const matchedIndex=index>=0?index:proposals.findIndex(proposal=>maintenanceViewProposalMatch(state,target,proposal).scopeMatched);
    const proposal=proposals[matchedIndex];
    if(!proposal){errors.push(`views尚未提交必需概要：${old?.kind??target}`);issues.push({code:'VIEW_MISSING',path:'views',target});continue;}
    if(!old)continue;
    // A resumed claim can name an ancestor whose current head has since moved.
    // Check the same lineage as final acceptance; never demand a stale direct
    // parent while publication requires the supplied current head.
    const base=state.publishedViews?.find(view=>view.id===proposal.previousId);
    if(!maintenanceViewProposalMatch(state,target,proposal).previousIdMatched){errors.push(`views[${matchedIndex}].target须选择已提供且承接${old.kind}目标的当前概要编号，并用decision表达本批保留或修改决定`);issues.push({code:'VIEW_BASE_MISMATCH',path:`views[${matchedIndex}].target`,target:old.id});}
    const parents=(proposal.sourceViewIds??[]).flatMap(id=>state.publishedViews?.filter(view=>view.id===id&&viewAllowed(state,book,view))??[]);
    const inherited=[...parents.flatMap(view=>[...(view.reviewedMemorySources??[]),...(view.adoptedMemorySources??[]).filter(source=>!proposal.dropSourceMemoryIds?.includes(source.id))]),...(base?.reviewedMemorySources??[])];
    const reviewed=new Set([...(proposal.reviewedMemoryIds??[]),...proposal.sourceMemoryIds,...inherited.filter(source=>state.memories.some(memory=>memory.id===source.id&&memoryContentIdentity(memory).hash===source.hash)).map(source=>source.id)]);
    const missing=viewVersionUpdates(state,book,old).map(u=>u.currentId).filter(id=>(reviewScope===undefined||reviewScope.includes(id))&&!reviewed.has(id));
    if(missing.length){errors.push(`views[${matchedIndex}]尚未核对本批后继：${missing.map(id=>labels[id]??id).join('、')}；选择已提供的当前target，核对材料后以decision明确保留、局部修改或重写。程序记录该决定的审阅版本；sourceMemoryIds只填写确实采用的依据，不添加额外审阅确认字段`);issues.push({code:'VIEW_REVIEW_MISSING',path:`views[${matchedIndex}].decision`,target:old.id});}
  }
  return {errors,issues};
}
export function maintenanceProgress(state:State,book:Book,check=createPublishedViewCheck(state,book)):import('./types.ts').MaintenanceProgress{
  const size=(ranges:Range[])=>mergeRanges(ranges).reduce((n,r)=>n+r.end-r.start,0),jobs=(state.maintenanceJobs??[]).filter(j=>!j.dismissed&&j.bookId===book.id&&bookVersionPrefixLength(book,j.version)!==undefined&&j.ranges.every(range=>bookVersionAllowsRange(book,j.version,range))&&(j.scope==='book'||j.partnerId===state.partnerId)),missing=subtractRanges(book.known,book.prepared);
  const committedChats=state.usage.flatMap(usage=>{const dispatch=usage.maintenanceDispatch,task=usage.requestKey&&ordinaryReadingTask(usage.requestKey);return dispatch&&task&&task.bookId===book.id?[{version:task.version,partnerId:task.partnerId,ids:new Set(maintenanceProcessed(dispatch).chatIds)}]:[];});
  const pendingChatIds=new Set(jobs.flatMap(job=>{const owner=job.partnerId===state.partnerId?state:{...state,partnerId:job.partnerId};return job.chatIds.filter(id=>!committedChats.some(commit=>commit.version===job.version&&(job.scope==='book'||commit.partnerId===job.partnerId)&&commit.ids.has(id))&&state.chats.some(chat=>chat.id===id&&chatAllowsMemory(owner,chat)));}));
  // Permission and understanding coverage do not enqueue work. Only a saved
  // maintenance obligation contributes to the current background pressure.
  const pending=intersectRanges(missing,jobs.flatMap(j=>j.ranges)),working=intersectRanges(pending,jobs.filter(j=>j.status==='running').flatMap(j=>state.usage.find(u=>u.id===j.pendingDispatch?.usageId)?.maintenanceDispatch?.claim.ranges??[])),blocked=subtractRanges(intersectRanges(pending,jobs.filter(j=>j.status==='blocked').flatMap(j=>j.ranges)),working),queued=subtractRanges(pending,[...working,...blocked]);
  const reviewRanges=intersectRanges(book.known,jobs.flatMap(j=>j.viewReviewRanges??[])),checked=reviewRanges.length?checkedMaintenanceRanges(state,book,check):{overview:[],current:[]};
  // Recovery records can outlive the text review completed by a later task.
  // Count the remaining work, without changing those records or their fees.
  // Pending conversations and scene records still require their own decision;
  // text coverage alone cannot prove that they have been incorporated.
  const targets=canonicalMaintenanceViewTargets(jobs.flatMap(job=>{
    const review=intersectRanges(book.known,[...job.ranges,...(job.viewReviewRanges??[])]);
    return resolveMaintenanceViewTargets(state,book,job.viewTargets??[],check).filter(target=>{
      const view=target.startsWith('view:')?check.views.get(target.slice(5)):undefined;
      return !view||!review.length||job.chatIds.length>0||!!job.sceneRecordIds?.length||
        view.kind!=='overview'&&view.kind!=='current'||subtractRanges(review,checked[view.kind]).length>0||viewVersionUpdates(state,book,view,check).length>0;
    });
  }));
  // A current view can have no stale dependencies while still missing a whole
  // chapter's review. Count committed coverage gaps only inside scheduled work;
  // unrelated old overview gaps keep their actual state without becoming debt.
  const missingKinds=(['overview','current'] as const).filter(kind=>subtractRanges(reviewRanges,checked[kind]).length&&!targets.some(target=>(target.startsWith('view:')?check.views.get(target.slice(5))?.kind:target)===kind));
  const directory=book.directory?.entries??book.chapters,oldest=pending[0],oldestChapter=oldest&&directory.find(chapter=>chapter.start<=oldest.start&&oldest.start<chapter.end);
  // Count actual source chapters touched by scheduled unfinished text.
  const pendingChapterCount=directory.filter(chapter=>(chapter.kind?chapter.kind==='chapter':/^(?:第[^\n]{1,24}[章回节]|chapter\s+\d+)/iu.test(chapter.title))&&pending.some(range=>range.start<chapter.end&&chapter.start<range.end)).length;
  return{...(oldest?{oldestPending:{start:oldest.start,chapterTitle:oldestChapter?.title}}:{}),pendingChapterCount,bookId:book.id,knownChars:size(book.known),preparedChars:size(subtractRanges(book.known,missing)),missingChars:size(missing),workingChars:size(working),queuedChars:size(queued),blockedChars:size(blocked),overviewPending:targets.length+missingKinds.length,pendingChatCount:pendingChatIds.size,blockedJobs:jobs.filter(j=>j.status==='blocked').length,queuedJobs:jobs.filter(j=>j.status==='pending').length,workingJobs:jobs.filter(j=>j.status==='running').length};
}
export function viewProgress(state:State,book:Book,check=createPublishedViewCheck(state,book)){
  const views=currentPublishedViews(state,book,check),coverage=mergeRanges(views.flatMap(v=>v.ranges));
  return{views:views.map(v=>({id:v.id,kind:v.kind,key:v.key,text:v.text,ranges:v.ranges,chatIds:v.chatIds,createdAt:v.createdAt,lagging:viewHasPendingReview(state,book,v,check),adoptedMemories:v.adoptedMemorySources?.filter(source=>{const memory=check.memories.get(source.id);return !!memory&&memoryReadableByPartner(state,memory);}).map(source=>{const memory=check.memories.get(source.id)!;return{id:source.id,hash:source.hash,title:memory.documentTitle,formationRanges:memory.readingStage??[]};})})),coveredRanges:coverage,uncheckedRanges:subtractRanges(book.known,coverage),unabsorbedChatIds:state.chats.filter(c=>c.bookId===book.id&&chatBelongsToPartner(state,c)&&check.chat(c)&&!c.excluded&&!c.outdatedBy&&!c.replacedBy&&check.evidence(c.evidence)&&!views.some(v=>v.chatIds.includes(c.id))).map(c=>c.id),maintenance:(state.maintenanceJobs??[]).filter(j=>!j.dismissed&&j.bookId===book.id&&bookVersionPrefixLength(book,j.version)!==undefined&&j.ranges.every(range=>bookVersionAllowsRange(book,j.version,range))&&(j.scope==='book'||j.partnerId===state.partnerId)).map(j=>({id:j.id,status:j.status,ranges:j.ranges,chatIds:j.chatIds,viewTargets:j.viewTargets,targetLabels:j.viewTargets?.map(target=>{const view=target.startsWith('view:')?check.views.get(target.slice(5)):undefined;return{kind:view?.kind??target as 'overview'|'current',key:view?.key};}),reason:j.reason}))};
}
export async function planPublishedViews(state:State,book:Book,proposals:ViewProposal[]|undefined,memories:Memory[],viewIds:string[],chatIds:string[],passages:Map<string,NonNullable<Memory['sourceQuote']>>,exposure:import('./types.ts').Evidence[],lineage?:{memoryIds:string[];chatIds:string[];evidence:import('./types.ts').Evidence[];reviewMemoryIds?:string[];boundedReview?:true;submittedMemoryIds?:string[];readMemoryIds?:readonly string[];formationSources?:import('./types.ts').FormationSources;reviewMaterials?:readonly import('./material-projection.ts').MaterialExposure[]},checks?:{state:State;targets:import('./types.ts').MaintenanceViewTarget[];labels?:Record<string,string>;decisionTargets?:readonly ({index:number;target:string}|undefined)[]}):Promise<{added:PublishedView[];publication?:ViewPublication;publications?:ViewPublication[]}>{
  // Missing view proposals still need diagnostics against newly formed bodies.
  await prepareMemoryIdentities(memories);
  if(!proposals?.length)return{added:[]};
  if([...chatIds,...(lineage?.chatIds??[])].some(id=>{const chat=state.chats.find(c=>c.id===id);return !chat||!chatAllowsMemory(state,chat);}))throw Error('视图形成的交流来源未允许后续采用');
  const newMemories=memories.filter(m=>!state.memories.some(old=>old.id===m.id));
  const reviewState=checks?.state??{...state,memories:[...state.memories.map(old=>{const next=newMemories.find(m=>m.revisionKind==='development'&&m.correctionOf===old.id);return next?{...old,replacedBy:next.id}:old;}),...newMemories]};
  const allMemories=[...new Map([...state.memories,...memories].map(m=>[m.id,m])).values()];
  const formationAudit=formationSources({...state,memories:allMemories},{memoryIds:[...new Set([...memories.map(m=>m.id),...(lineage?.memoryIds??[]),...(lineage?.formationSources?.memoryIds??[])])],chatIds:[...new Set([...chatIds,...(lineage?.chatIds??[]),...(lineage?.formationSources?.chatIds??[])])],viewIds:[...new Set([...viewIds,...(lineage?.formationSources?.viewIds??[])])],evidence:[...exposure,...(lineage?.evidence??[]),...(lineage?.formationSources?.evidence??[])],habitIds:lineage?.formationSources?.habitIds,materialRef:lineage?.formationSources?.materialRef});
  let readingError:ReadingDocumentError|undefined;
  // New storage identity alone is not full knowledge: a partial edit may have
  // copied unseen old bytes. The caller supplies exact authored/derived proofs.
  const readMemoryIds=lineage?.readMemoryIds===undefined?undefined:[...lineage.readMemoryIds,...deltaReviewedMemoryIds(memories,lineage.reviewMaterials??[])];
  try{proposals=expandViewReviewChanges(reviewState,book,proposals,memories,[...(lineage?.reviewMemoryIds??[]),...(lineage?.submittedMemoryIds??[])],readMemoryIds,lineage?.reviewMaterials,lineage?.boundedReview);}catch(error){if(!(error instanceof ReadingDocumentError))throw error;readingError=error;}
  // Report every bad edit in this batch before asking for a correction. Only
  // legally supplied bases are eligible for the feedback material.
  const diagnosis=checks?maintenanceViewProposalErrors(checks.state,book,checks.targets,proposals,checks.labels,lineage?.boundedReview?lineage.reviewMemoryIds??[]:undefined):{errors:[],issues:[]};
  const revised=new Map<ViewProposal,string>(),editErrors:string[]=[...(readingError?.errors??[]),...diagnosis.errors],issues:import('./document-revision.ts').ReadingIssue[]=[...(readingError?.issues??[]),...diagnosis.issues],editBases=new Set<string>();
  for(const [index,proposal]of proposals.entries())if(proposal.operation==='revise'){
    const base=state.publishedViews?.find(v=>v.id===proposal.previousId&&viewIds.includes(v.id)&&viewAllowed(state,book,v));
    if(!base)continue;
    try{revised.set(proposal,revisedViewText(base.text,proposal.edits!,`views[${index}].edits`,base.id));}
    catch(error){if(!(error instanceof ReadingDocumentError))throw error;editErrors.push(...error.errors);issues.push(...(error.issues??[]));editBases.add(base.id);}
  }
  const added:PublishedView[]=[],prior=currentViewPublication(state,book,state.partnerId),privatePrior=currentViewPublication(state,book,state.partnerId,'partner'),ids=[...(prior?.viewIds??[]),...(privatePrior?.viewIds??[])];
  for(const [proposalIndex,proposal]of proposals.entries()){try{
    const old=proposal.previousId?state.publishedViews?.find(v=>v.id===proposal.previousId&&viewIds.includes(v.id)&&viewAllowed(state,book,v)):undefined;
    if(proposal.previousId&&!old||(proposal.operation==='keep'||proposal.operation==='revise')&&!old||old&&(old.kind!==proposal.kind||old.key!==proposal.key))throw Error('视图previousId不属于本次实际提供的同一作用域');
    const owner=old??{bookId:book.id,partnerId:state.partnerId,scope:'book' as const};
    if(added.some(view=>sameDocumentOwner(view,owner)&&view.kind===proposal.kind&&view.key===proposal.key))throw Error('同一次发布不能重复同归属的同类视图作用域');
    const merging=(proposal.mergePreviousIds??[]).map(id=>state.publishedViews?.find(v=>v.id===id&&viewIds.includes(id)&&viewAllowed(state,book,v)));
    if(merging.length&&(!old||!['overview','current'].includes(proposal.kind)||merging.some(v=>!v||!sameDocumentOwner(old,v)||v.kind!==proposal.kind||v.id===old.id||!proposal.sourceViewIds?.includes(v.id))))throw Error('mergePreviousIds须逐一绑定本包实际取得全文、同归属且明确sourceViewIds采用的同类额外概要');
    const heads=currentPublishedViews(state,book).filter(v=>v.kind===proposal.kind&&sameDocumentOwner(v,owner)),core=proposal.kind==='overview'||proposal.kind==='current';
    if(core&&heads.length&&(!old||!heads.some(v=>v.id===old.id))){
      const decision=checks?.decisionTargets?.[proposalIndex];
      if(decision){
        // Only this maintenance exit has target/decision handles. Keep the
        // direct publication contract below unchanged; never invent a supplied
        // label, silently rebind an old target, or weaken the current-head gate.
        const available=heads.filter(head=>viewIds.includes(head.id)&&viewAllowed(state,book,head)&&head.key===proposal.key&&(!old||viewDescendsFrom(state,head,old.id))).map(head=>'v'+(viewIds.indexOf(head.id)+1));
        const path='views['+decision.index+'].target';
        const correction=available.length?'本包已提供的同职责当前后继target为 '+available.join('、')+'；核对其正文后，用这些当前target作decision决定。原候选已含对应当前target时，保留其有效决定并删除过时项，也可整体替换/views。':'本包尚未提供对应的当前后继target；先沿现有概要读取入口取得当前同职责基版，再对其target作decision决定。';
        throw new ReadingDocumentError([path+'='+decision.target+'不能承接当前'+proposal.kind+'概要：所选基版不是当前头。'+correction+'不要填写previousId/key；它们由target自动绑定。原documents、原答及未改内容保持。'],undefined,undefined,[{code:'VIEW_TARGET_OBSOLETE',path,target:decision.target}]);
      }
      throw Error('已有核心概要，须以本轮实际提供的当前头填写previousId并保持其key；不得重新初始化或承接过时头');
    }
    const mergeGroup=core?coreViewMergeGroups(state,book).find(group=>group.kind===proposal.kind&&group.heads.some(head=>head.id===old?.id)):undefined;
    if(merging.length&&(!mergeGroup||merging.some(view=>!mergeGroup.heads.some(head=>head.id===view!.id))))throw Error('只能明确归并已核同职责初始化来源的分叉组；其它作用域保持原发布头');
    if(mergeGroup&&mergeGroup.heads.some(head=>head.id!==old?.id&&!merging.some(v=>v!.id===head.id)))throw Error('核心概要存在多个待归并头；须实际取得该初始化分叉组全部头，以previousId承接主头，其余填mergePreviousIds并同时列入sourceViewIds，不能分别更新后继续保留分叉');
    if(mergeGroup&&added.some(view=>mergeGroup.heads.some(head=>viewDescendsFrom(state,view,head.id))))throw Error('同次初始化分叉组只提交一份有据归并后继');
    if(!core&&heads.some(v=>v.key===proposal.key&&v.id!==old?.id))throw Error('同一概要作用域已有发布头，须取得其全文并以previousId承接，不能无前继断链覆盖');
    const retiredAdoptions=retiredLineageIds(state,memories);
    const sources=proposal.sourceMemoryIds.map(id=>memories.find(m=>m.id===id));if(sources.some(m=>!m||m.bookId!==book.id||!memoryReadableByPartner(state,m)||m.forgotten||m.invalidatedBy||retiredAdoptions.has(m.id)||m.documentState==='retired'||!isEvidenceAllowed(book,m.evidence)))throw Error('视图引用的认识版本未实际取得或不合法');
    const reviewed=(proposal.reviewedMemoryIds??[]).map(id=>memories.find(m=>m.id===id));
    if(reviewed.some(memory=>!memory||typeof memory.text!=='string'||memory.bookId!==book.id||!memoryReadableByPartner(state,memory)||memory.forgotten||memory.invalidatedBy||memory.reviewDisposition==='unsupported'||!isEvidenceAllowed(book,memory.evidence)))throw Error('视图审阅的认识版本须为本轮实际供入全文或同包新结果');
    const unread=readMemoryIds===undefined?[]:reviewed.filter(memory=>!readMemoryIds.includes(memory!.id)).map(memory=>memory!.id);
    if(unread.length)throw new ReadingDocumentError(['概要明确审阅的认识尚未在本任务实际供入全文'],unread,undefined,unread.map(id=>({code:'MATERIAL_RANGE_MISSING',path:'views.reviewedMemoryIds',target:id})));
    const inherited=(proposal.sourceViewIds??[]).map(id=>state.publishedViews?.find(v=>v.id===id&&viewIds.includes(id)&&viewAllowed(state,book,v)));if(inherited.some(v=>!v))throw Error('视图只能继承本次实际提供的有效派生视图');
    if((proposal.operation==='keep'||proposal.operation==='revise')&&!proposal.sourceViewIds?.includes(old!.id))throw Error('keep/revise须明确继承已核对的原视图，previousId本身不授来源资格');
    const parents=inherited as PublishedView[];
    const dropped=new Set(proposal.dropSourceMemoryIds??[]),inheritedAdoptions=parents.flatMap(view=>view.adoptedMemorySources??[]);
    for(const sourceId of dropped)if(proposal.sourceMemoryIds.includes(sourceId)||!inheritedAdoptions.some(source=>source.id===sourceId)||!reviewed.some(memory=>memoryDevelopmentIncludes(state,memories,memory!,sourceId)))throw Error('移除采用须明确指向继承的旧依据，并实际审阅该版本或其发展后继');
    const originals=(proposal.sourceIds??[]).map(id=>passages.get(id));if(originals.some(p=>!p))throw Error('视图原文p编号未实际提供');
    const predecessors=[...(old?[old]:[]),...merging.filter((view):view is PublishedView=>!!view)],updates=predecessors.flatMap(view=>viewVersionUpdates(state,book,view));
    const checkedMemories=[...sources,...reviewed],checkedVersion=checkedMemories.some(memory=>updates.some(update=>update.currentId===memory!.id)||memory!.revisionKind==='development'&&[...predecessors.flatMap(view=>(view.adoptedMemorySources??[]).map(source=>source.id)),...updates.map(update=>update.currentId)].includes(memory!.correctionOf??''));
    if(proposal.operation==='keep'&&!originals.length&&!proposal.chatIds?.length&&!checkedVersion&&!checkedMemories.some(memory=>lineage?.reviewMemoryIds?.includes(memory!.id)||lineage?.submittedMemoryIds?.includes(memory!.id)))throw Error('keep须实际核对新原文、真实交流或旧视图待核对的新完整认识版本');
    const checkedChats=(proposal.chatIds??[]);if(checkedChats.some(id=>!chatIds.includes(id)))throw Error('视图交流编号未实际提供');
    const dependencies=[...new Map([...memories,...state.memories.filter(m=>lineage?.memoryIds.includes(m.id))].map(m=>[m.id,m])).values()];await prepareMemoryIdentities(dependencies);
    const adoptedMemorySources=[...new Map([...inheritedAdoptions.filter(source=>!dropped.has(source.id)&&!(proposal.replaceSources&&sources.some(memory=>memory!.id!==source.id&&memoryDevelopmentIncludes(state,memories,memory!,source.id)))),...sources.map(m=>({id:m!.id,hash:memoryContentIdentity(m!).hash}))].map(source=>[source.id,source])).values()];
    if(adoptedMemorySources.some(source=>retiredAdoptions.has(source.id)))throw Error('本包退出的文档仍被概要采用；须明确review退出版本并dropSourceMemoryIds移除旧采用关系');
    const reviewHistory=[...new Map([...parents.flatMap(view=>view.reviewedMemorySources??[]),...(old?.reviewedMemorySources??[]),...merging.flatMap(view=>view!.reviewedMemorySources??[]),...reviewed.map(memory=>({id:memory!.id,hash:memoryContentIdentity(memory!).hash}))].map(source=>[source.id,source])).values()];
    // Prior review receipts remain on immutable parent views. The current
    // review frontier only needs the explicitly reviewed successor version.
    const reviewedMemorySources=reviewHistory.filter(source=>!reviewed.some(memory=>memory!.id!==source.id&&memoryDevelopmentIncludes(state,memories,memory!,source.id)));
    if(proposal.operation==='revise'&&!revised.has(proposal))continue;
    const text=proposal.operation==='keep'?old!.text:proposal.operation==='revise'?revised.get(proposal)!:proposal.text!;
    const view:PublishedView={id:id(),bookId:book.id,version:book.version,partnerId:state.partnerId,scope:old?documentScope(old):'book',kind:proposal.kind,key:proposal.key,text,createdAt:Date.now(),...(old?{previousId:old.id}:{}),...(merging.length?{mergePreviousIds:merging.map(v=>v!.id)}:{}),memorySources:dependencies.map(m=>({id:m.id,hash:memoryContentIdentity(m).hash})),originalSources:await Promise.all(originals.map(async p=>({evidence:{...p!.evidence},hash:await hashText(p!.text)}))),viewSources:[...new Set(viewIds)],evidence:mergeRanges([...exposure,...(lineage?.evidence??[]),...dependencies.flatMap(m=>m.evidence),...parents.flatMap(v=>v.evidence)]).map(r=>({...r,bookId:book.id,version:book.version})),contextChatIds:[...new Set([...chatIds,...(lineage?.chatIds??[]),...parents.flatMap(v=>v.contextChatIds)])],ranges:mergeRanges([...originals.map(p=>p!.evidence),...parents.flatMap(v=>v.ranges)]),chatIds:[...new Set([...checkedChats,...parents.flatMap(v=>v.chatIds)])]};
    view.formationSources=formationAudit;
    view.writeBaseIds=[...(old?[old.id]:[]),...merging.map(v=>v!.id)];
    view.adoptedMemorySources=adoptedMemorySources;
    view.reviewedMemorySources=reviewedMemorySources;
    if(proposal.reviewReason!==undefined)view.reviewReason=proposal.reviewReason;
    // Updating one projection does not claim other topics were revisited.
    for(let i=ids.length-1;i>=0;i--){const existing=state.publishedViews?.find(v=>v.id===ids[i]);if(existing&&viewDescendsFrom(state,view,existing.id))ids.splice(i,1);}ids.push(view.id);added.push(view);
  }catch(error){editErrors.push(...(error instanceof ReadingDocumentError?error.errors:[(error as Error).message]));if(error instanceof ReadingDocumentError){issues.push(...(error.issues??[]));for(const id of error.requiredViewIds??[])editBases.add(id);if(error.requiredMemoryIds?.length)readingError=new ReadingDocumentError(readingError?.errors??[],[...new Set([...(readingError?.requiredMemoryIds??[]),...error.requiredMemoryIds])]);}}}
  if(editErrors.length)throw new ReadingDocumentError([...new Set(editErrors)],readingError?.requiredMemoryIds,[...editBases],issues);
  const nextState={...state,publishedViews:[...(state.publishedViews??[]),...added]},publications:ViewPublication[]=[];
  const shared=buildBookViewPublication(nextState,book,state.partnerId,ids);if(shared)publications.push(shared);
  const privateIds=ids.filter(id=>{const view=nextState.publishedViews.find(v=>v.id===id);return !!view&&documentScope(view)==='partner'&&view.partnerId===state.partnerId;});
  if(privateIds.length)publications.push({scope:'partner',id:publicationId(book,state.partnerId,'partner'),bookId:book.id,version:book.version,partnerId:state.partnerId,revision:(privatePrior?.revision??0)+1,viewIds:privateIds});
  return{added,publication:publications[0],publications};
}
