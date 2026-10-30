import {parseDocumentOrganization,documentOrganizationSchema} from './document-organization.ts';
import {parseViewProposals,viewProposalSchema,maintenanceViewDecisionSchema,bindViewTargets} from './published-views.ts';
import {paragraphCommentsSchema,readingExpressionSchema,parseParagraphComments,parseReadingExpression} from './paragraph-comments.ts';
import type { Memory,ModelTool, ReadingReply, ReadingStrategy,Understanding } from './types.ts';
import {parseReadingReply,parseDocumentScope} from './model.ts';
import {knowledgeDistributionSchema,parseKnowledgeDistribution} from './knowledge-distribution.ts';
import {companionWorkspaceSchema} from './companion-schema.ts';
import {materializeDocumentRevisions,parseDocumentEdits,parseDocumentSourceIds,ReadingDocumentError,documentLocationSchema} from './document-revision.ts';
import {parseStructuralBasis,structuralBasisSchema} from './basis.ts';
import {candidateFields,validateCandidateAmendment,readingDocumentFactFields,normalizeReadingDocumentPlacement,parseReadingSubmissionPayload} from './reading-candidate.ts';
import {partnerMaintenanceSchema,partnerMaintenancePolicy} from './partner-persona-tools.ts';
export {parseReadingSubmissionPayload} from './reading-candidate.ts';

export type ReadingSubmission={kind:'reaction'|'finish'|'text';raw:string;usageId?:string;reactionRaw?:string;proposalRaw?:string};
export type ReadingAcceptance<T>={candidate?:string;issues?:import('./document-revision.ts').ReadingIssue[];materials?:{affectedViews:{id:string;kind:string;key:string;text:string}[];memoryResults?:{source:string;text:string}[];memorySuccessors?:{previousId:string;currentId:string}[];coreViewMergeGroups?:{kind:string;viewIds:string[];reason:string}[];instruction?:string};accepted:boolean;result?:T;errors:string[];expressionDelivery:import('./paragraph-comments.ts').ExpressionDeliveryReport};
/** One domain feedback body; errors are complete and occur only once. */
export function readingFeedback(reading:Pick<ReadingAcceptance<unknown>,'accepted'|'errors'|'materials'|'issues'>&{candidate?:string;expressionDelivery?:ReadingAcceptance<unknown>['expressionDelivery']}){return JSON.parse(JSON.stringify({accepted:reading.accepted,errors:reading.errors,...(reading.issues?.length?{issues:reading.issues}:{}),...(reading.candidate?{candidate:reading.candidate,continuation:'用finish_reading引用candidate，直接给出要改的字段或用changes局部修改；未改内容保留，确认原候选用changes:[]。'}:{}),...(reading.expressionDelivery?{expressionDelivery:reading.expressionDelivery}:{}),...(reading.materials?{materials:reading.materials}:{}),originalReplyRetained:true}));}
/** Locate the parser's actual UTF-16 offset without editing the settled reply. */
export function readingJsonErrorLocation(raw:string,parseError:string){
 const match=/\bat position (\d+)\b/.exec(parseError),offset=match?Number(match[1]):undefined;
 if(offset===undefined||!Number.isSafeInteger(offset)||offset<0||offset>raw.length)return;
 const start=Math.max(0,offset-48),end=Math.min(raw.length,offset+49);
 const display=(text:string)=>text.replace(/\r/g,'\\r').replace(/\n/g,'\\n').replace(/\t/g,'\\t');
 return{offset,offsetUnit:'zero-based UTF-16',start,end,context:display(raw.slice(start,end)),caret:' '.repeat(display(raw.slice(start,offset)).length)+'^',found:offset===raw.length?'end of input':raw[offset],instruction:'caret指向原始回答的解析失败位置；context仅是原串短邻域（换行和制表符以转义显示），不是修正后的答案。请核对该处及相邻括号、逗号，仅修正JSON语法，原提交内容和完整原答仍保留。'};
}
/** Actual terminal shape only; missing legacy carriers remain unclassified. */
export function isReasoningOnlyLengthResponse(response:import('./types.ts').ModelReply|undefined):boolean{
 const terminal=response?.rawTerminal,message=terminal?.message;
 return terminal?.finishReason==='length'&&!!message&&typeof message.reasoning_content==='string'&&!!message.reasoning_content.trim()&&(message.content===null||message.content===undefined||message.content==='')&&(message.tool_calls===undefined||message.tool_calls===null||Array.isArray(message.tool_calls)&&message.tool_calls.length===0);
}
/** Transport classification only; raw settled carriers and request identities remain intact. */
export function normalizeReadingSubmission(response:import('./types.ts').AgentModelReply):ReadingSubmission|undefined{
  const calls=response.toolCalls;
  if(response.finish==='tool_calls'){
    const exits=calls.filter(c=>c.function.name==='finish_reading'),reactions=calls.filter(c=>c.function.name==='react_to_reading'),proposals=calls.filter(c=>c.function.name==='submit_reading');
    if(exits.length===1&&proposals.length<=1&&reactions.length<=1&&calls.length===exits.length+reactions.length+proposals.length)return{kind:'finish',raw:exits[0].function.arguments,usageId:response.requestId,reactionRaw:reactions[0]?.function.arguments,proposalRaw:proposals[0]?.function.arguments};
    if(!exits.length&&reactions.length===1)return{kind:'reaction',raw:reactions[0].function.arguments,usageId:response.requestId};
    return;
  }
  if(response.finish==='stop'){
    try{parseReadingSubmissionPayload(response.content);return{kind:'finish',raw:response.content,usageId:response.requestId};}catch{}
    return{kind:'text',raw:response.content,usageId:response.requestId};
  }
}
export function restoreReadingSubmission(candidate:import('./types.ts').CompanionReadingReceipt['candidate'],usageId:string):ReadingSubmission{
  let kind:ReadingSubmission['kind']=candidate.format==='reading-text'?'finish':'text';
  if(candidate.format==='content')try{parseReadingSubmissionPayload(candidate.text);kind='finish';}catch{}
  return{kind,raw:candidate.text,usageId,reactionRaw:candidate.reaction,proposalRaw:candidate.proposal};
}

export const readingDocumentsOutputPolicy='用finish_reading提交本批documents和必要概要。书籍分析可供同书伙伴使用，后台新建默认scope:book；私人共同经历、用户认识和相处记忆单独保存为scope:partner。前台新建默认partner。修订继承原文档scope，书籍与私人文档分别维护，不以修订或归并改变私有归属。create新建完整正文；develop完整接续；revise只提交局部edits或appendText；edits须读到被改范围，可用唯一逐字oldText或直接用读取结果location提交newText；location.version为具体文档ID，hash为完整基版正文hash，不能替换成书籍版本或m显示编号。appendText须读到该版本末行，未改正文由程序保留。changes读取返回documentChange.previousId/previousHash与currentId/currentHash，changes各项before为前驱范围及原文、after为当前版范围及新文、context为当前版局部上下文；其外层version为currentHash，编辑当前版须取writeBase.version/hash及当前版坐标。旧版已实际读全后可据准确差异审阅概要，差异读取不自动授予整篇重写资格；merge在读全多个前驱后提交归并正文。organize仅改元数据，retire退出当前使用，restore重新启用合法退出头，历史保持。拆分用同包create承接篇和retire原篇。sourceIds为本次真实p出处，basis为实际使用资料；目录与related仅导航。organization.subject由你明确维护对象归属和主稿，不让标签替代正文职责。working/focus是后续工作入口，understanding仅选整体主稿。tN始终指本包documents第N篇。错误反馈含candidate时引用它并直接给出要替换的字段，或用changes按JSON Pointer局部修正；新增documents用/documents/-尾部追加，已有tN位置保留，无需重交未改正文。确认补给材料后原候选仍成立可changes:[]。完整合法提交一次完成，不额外生成规划或检查报告。';

const documentSourceSchema={type:'array',items:{type:'string',pattern:'^p[1-9][0-9]{0,5}$'},description:'精选关键且去重的本轮实际原文p编号，避免无关出处拖慢处理；合法完整出处不按数量拒绝，出处用于追溯，不自动证明理解正确。'};
const documentScopeSchema={type:'string',enum:['book','partner'],description:'book为本书可共享的分析；partner为当前伙伴的私人共同经历、用户认识与相处记忆。新文档按本任务默认归属，修订继承旧文档scope。'};
/** Exact compatibility for capacity corrections and optional document scope. The
 * original carrier stays immutable; a continued HTTP request records new tools. */
export function isReadingViewCapacityUpgrade(previous:ModelTool,current:ModelTool):boolean{
  if(previous.name!=='finish_reading'||current.name!==previous.name)return false;
  const prior=structuredClone(previous),p=(prior.parameters.properties as any),c=(current.parameters.properties as any);
  if(p?.documents?.items?.properties&&p.documents.items.properties.scope===undefined&&JSON.stringify(c?.documents?.items?.properties?.scope)===JSON.stringify(documentScopeSchema)&&!c.documents.items.required?.includes('scope')){
    const old=p.documents.items.properties,now=c.documents.items.properties;
    p.documents.items.properties=Object.fromEntries([...Object.keys(now).map(key=>[key,key==='scope'?structuredClone(now[key]):old[key]]),...Object.keys(old).filter(key=>!Object.hasOwn(now,key)).map(key=>[key,old[key]])]);
  }
  if(p?.views?.items?.properties&&c?.views?.items?.properties?.mergePreviousIds&&p.views.items.properties.mergePreviousIds===undefined&&JSON.stringify(c.views.items.properties.mergePreviousIds)===JSON.stringify(viewProposalSchema.items.properties.mergePreviousIds)){
    const oldProperties=p.views.items.properties,currentProperties=c.views.items.properties;p.views.items.properties=Object.fromEntries([...Object.keys(currentProperties).map(key=>[key,key==='mergePreviousIds'?structuredClone(currentProperties[key]):oldProperties[key]]),...Object.keys(oldProperties).filter(key=>!Object.hasOwn(currentProperties,key)).map(key=>[key,oldProperties[key]])]);
  }
  const relax=(old:any,now:any,limit=8)=>{if(old?.maxItems===limit&&now?.maxItems===undefined)delete old.maxItems;};
  relax(p?.views,c?.views);relax(p?.views?.items?.properties?.sourceViewIds,c?.views?.items?.properties?.sourceViewIds);
  for(const [key,limit] of [['sourceMemoryIds',16],['sourceIds',256],['chatIds',32]] as const)relax(p?.views?.items?.properties?.[key],c?.views?.items?.properties?.[key],limit);
  const oldPrevious=p?.views?.items?.properties?.previousId,newPrevious=c?.views?.items?.properties?.previousId;
  if(oldPrevious&&newPrevious&&oldPrevious.description===undefined&&newPrevious.description===viewProposalSchema.items.properties.previousId.description)oldPrevious.description=newPrevious.description;
  for(const [old,now] of [[p?.documents?.items?.properties?.sourceIds,c?.documents?.items?.properties?.sourceIds],[p?.documents?.items?.properties?.edits?.items?.properties?.sourceIds,c?.documents?.items?.properties?.edits?.items?.properties?.sourceIds]]){
    relax(old,now);if(old?.description==='仅填本轮实际提供的原文p编号；出处用于追溯，不自动证明理解正确。'&&now?.description===documentSourceSchema.description)old.description=now.description;
  }
  relax(p?.sceneInsight?.properties?.sourceIds,c?.sceneInsight?.properties?.sourceIds);
  return JSON.stringify(prior)===JSON.stringify(current);
}
export const readingDocumentsTool:ModelTool & {validate(args:unknown):void}={name:'finish_reading',description:'维护本批文档与概要：create新建、develop完整接续、merge合并写text；revise用edits/appendText；edits用oldText或读取结果location准确定位，newText为空删除。organize调整名称/组织，retire退出，restore重启已退出的最新版本；三项只填updates、updateReason及元数据。拆分同包create各篇并retire原篇，由replacementIds承接。tN为documents第N篇，新增放末尾；候选续交见candidate/changes。',parameters:{type:'object',properties:{...candidateFields,reinforce:{type:'array',uniqueItems:true,items:{type:'string',pattern:'^m[1-9][0-9]*$'},description:'核对本批原文后，明确保留仍成立且已读全文的m；保持正文和版本。'},views:maintenanceViewDecisionSchema,paragraphComments:paragraphCommentsSchema,reaction:readingExpressionSchema,documents:{type:'array',minItems:0,items:{type:'object',properties:{operation:{type:'string',enum:['create','develop','revise','merge','organize','retire','restore']},scope:documentScopeSchema,text:{type:'string',minLength:1,description:'create/develop/merge完整正文，逐字保存；revise不填。'},documentTitle:{type:'string',maxLength:160},navigationCues:{type:'array',maxItems:16,items:{type:'string',minLength:1,pattern:'\\S',maxLength:160}},organization:documentOrganizationSchema,knowledgeDistribution:knowledgeDistributionSchema,updates:{type:'string',minLength:1,maxLength:128,description:'有效opinion旧版m编号；develop须读全，revise须读到修改范围，appendText须读到末行。'},updateReason:{type:'string',minLength:1,pattern:'\\S',maxLength:240},replacementIds:{type:'array',minItems:1,uniqueItems:true,items:{type:'string'},description:'仅retire：承接职责的新tN或已读全文的当前m；拆分同包新建并退出原篇。'},mergePreviousIds:{type:'array',minItems:1,uniqueItems:true,items:{type:'string',minLength:1,maxLength:128},description:'仅merge：updates之外的当前opinion前驱m，均须读全。'},edits:{type:'array',description:'每项用oldText唯一逐字匹配，或直接提交读取工具返回的location。location.version是写入基版的具体文档ID（writeBase.version），location.hash是该版完整正文hash；start/end为UTF-16半开区间，startLine/endLine为从1开始的含首末行范围。全部编辑均针对同一旧基版，newText为空明确删除。',items:{type:'object',properties:{oldText:{type:'string',minLength:1},location:documentLocationSchema,newText:{type:'string'},sourceIds:documentSourceSchema},required:['newText'],anyOf:[{required:['oldText']},{required:['location']}],additionalProperties:false}},appendText:{type:'string',minLength:1,description:'revise追加正文及所需换行，沿本篇sourceIds关联出处；须实际读到目标末行，outline不算。'},sourceIds:documentSourceSchema,quoteSource:{type:'string',pattern:'^p[1-9][0-9]{0,5}$'},basis:structuralBasisSchema},required:['operation'],oneOf:[{properties:{operation:{enum:['organize','retire','restore']}},required:['updates','updateReason'],not:{anyOf:[{required:['text']},{required:['edits']},{required:['appendText']},{required:['mergePreviousIds']}]}},{properties:{operation:{const:'create'},organization:{required:['subject']}},required:['text','organization'],not:{anyOf:[{required:['updates']},{required:['updateReason']},{required:['edits']},{required:['appendText']}]}},{properties:{operation:{const:'develop'}},required:['text','updates','updateReason'],not:{anyOf:[{required:['edits']},{required:['appendText']}]}},{properties:{operation:{const:'merge'}},required:['text','updates','updateReason','mergePreviousIds'],not:{anyOf:[{required:['edits']},{required:['appendText']}]}},{properties:{operation:{const:'revise'}},required:['updates','updateReason'],anyOf:[{required:['edits']},{required:['appendText']}],not:{required:['text']}}],additionalProperties:false}},working:companionWorkspaceSchema.properties.working,understanding:companionWorkspaceSchema.properties.understanding,focus:companionWorkspaceSchema.properties.focus},anyOf:[{required:['documents']},{required:['candidate']}],additionalProperties:false},validate:validateReadingDocumentsPayloadShape};
/** Only the host's existing background maintenance task opens this optional scope. */
export function readingDocumentsToolFor(options:{partnerMaintenance?:boolean}={}):typeof readingDocumentsTool{
  if(!options.partnerMaintenance)return readingDocumentsTool;
  return{...readingDocumentsTool,description:readingDocumentsTool.description+' '+partnerMaintenancePolicy,parameters:{...readingDocumentsTool.parameters,properties:{...(readingDocumentsTool.parameters.properties as Record<string,unknown>),partnerMaintenance:partnerMaintenanceSchema}},validate:args=>validateReadingDocumentsPayloadShape(args,options)};
}
/** Diagnose the actual submitted type without decoding or rewriting model data. */
export function readingDocumentsArrayError(value:unknown):string|undefined{
  if(Array.isArray(value))return;
  const actual=value===undefined?'missing':value===null?'null':typeof value;
  return `finish_reading.documents须为JSON数组（array），实际类型为${actual}；直接提交documents:[{operation:"create",text:"完整正文",organization:{subject:null}}]，无新增或修改时提交documents:[]。${typeof value==='string'?'当前字符串中的JSON不会自动解码；请保留文档内容，只修正字段类型。':''}`;
}
export function readingDocumentsShape(args:unknown,diagnostics?:string[],options:{partnerMaintenance?:boolean}={}):ReadingReply{
  if(!args||typeof args!=='object'||Array.isArray(args))throw Error('阅读文档出口须包含明确documents，原答保持');
  const {readingStage:_readingStage,...value}=args as Record<string,unknown>;
  const unexpected=Object.keys(value).filter(k=>!['documents','reinforce','working','understanding','focus','paragraphComments','reaction','views',...(options.partnerMaintenance?['partnerMaintenance']:[])].includes(k));
  const errors:string[]=[];
  if(unexpected.length)errors.push(Object.hasOwn(value,'sourceIds')?'finish_reading.sourceIds不能位于顶层；请放入documents[i].sourceIds或documents[i].edits[j].sourceIds，原答保持':`finish_reading顶层字段不允许：${unexpected.join('、')}；每份概要用views[i].decision表达保留或修改，不另填审阅确认字段；原答保持`);
  const documentsError=readingDocumentsArrayError(value.documents);if(documentsError)errors.push(documentsError);
  let paragraphComments,reaction;
  try{paragraphComments=parseParagraphComments(value.paragraphComments);reaction=parseReadingExpression(value.reaction,paragraphComments);}catch(error){errors.push((error as Error).message);}
  const thoughts=(Array.isArray(value.documents)?value.documents:[]).flatMap((rawDocument,index)=>{try{
    if(!rawDocument||typeof rawDocument!=='object'||Array.isArray(rawDocument))throw Error('须提供文档操作对象，原答保持');
    // Formation ranges are host facts. Extra copies neither grant coverage nor
    // invalidate an otherwise explicit content operation.
    const placement=normalizeReadingDocumentPlacement(Object.fromEntries(Object.entries(rawDocument).filter(([key])=>!readingDocumentFactFields.has(key))),index);
    const document=placement.document as typeof rawDocument;
    if(placement.errors.length)throw Error(placement.errors.join('；'));
    const fields=Object.keys(document).filter(k=>!['operation','scope','text','documentTitle','navigationCues','organization','knowledgeDistribution','updates','updateReason','mergePreviousIds','replacementIds','edits','appendText','sourceIds','quoteSource','basis'].includes(k));
    const shapeErrors:string[]=[];
    if(fields.length)shapeErrors.push(`不支持字段：${fields.map(field=>`documents[${index}].${field}`).join('、')}；只移除这些多余字段，保留其余有效内容`);
    if(!['create','develop','revise','merge','organize','retire','restore'].includes(document.operation))shapeErrors.push('operation须为create/develop/revise/merge/organize/retire/restore之一');
    if(shapeErrors.length)throw Error(shapeErrors.join('；'));
    parseDocumentOrganization(document.organization);
    parseDocumentScope(document.scope,`documents[${index}].scope`);
    if(document.operation==='create'&&document.organization?.subject===undefined)throw Error(`documents[${index}].organization.subject须明确维护对象；独立记录可为null，程序不代判断归属`);
    parseKnowledgeDistribution(document.knowledgeDistribution,`documents[${index}].knowledgeDistribution`);
    if(['organize','retire','restore'].includes(document.operation)){
      if(document.text!==undefined||document.edits!==undefined||document.appendText!==undefined)throw Error('文档整理/退出/恢复不填正文，由实际旧全文保留');
    }else if(document.operation==='revise'){
      if(document.text!==undefined)throw Error('局部修订revise只填edits/appendText，完整text由旧全文形成，原答保持');
      parseDocumentEdits(document,`documents[${index}].edits`);
      if(document.edits===undefined&&document.appendText===undefined)throw Error('局部修订revise须有edits或appendText，原答保持');
    }else{
      if(document.edits!==undefined||document.appendText!==undefined||typeof document.text!=='string')throw Error('create/develop须给完整text，不混用局部修订，原答保持');
      natural(document.text,undefined);
    }
    if(document.operation==='create'&&(document.updates!==undefined||document.updateReason!==undefined)||document.operation!=='create'&&(!document.updates||!document.updateReason))throw Error('阅读接续须带实际全文目标及变化原因，原答保持');
    parseDocumentSourceIds(document.sourceIds,`documents[${index}].sourceIds`);parseStructuralBasis(document.basis);
    const {operation,...body}=document;return[{kind:'opinion',...body,text:document.text??'',documentOperation:operation}];
  }catch(error){
    errors.push(`documents[${index}]：${(error as Error).message}`);
    // A malformed metadata field must not hide independently valid source
    // claims. These placeholders exist only in a rejected diagnostic result;
    // they can never reach parsing, planning or a partial publication.
    if(!diagnostics||!rawDocument||typeof rawDocument!=='object'||Array.isArray(rawDocument))return[];
    const raw=rawDocument as Record<string,unknown>,thought:Understanding={kind:'opinion',text:''};
    try{const basis=parseStructuralBasis(raw.basis);if(basis)thought.basis=basis;}catch{/* An invalid claim grants no source identity. */}
    if(typeof raw.updates==='string'&&raw.updates.trim()&&raw.updates.length<=128){
      if(['develop','merge','organize','retire','restore'].includes(raw.operation as string)){
        thought.updates=raw.updates;thought.documentOperation=raw.operation as Understanding['documentOperation'];
      }else if(raw.operation==='revise')try{
        const revision=parseDocumentEdits(raw);if(revision.edits?.length||revision.appendText!==undefined){thought.updates=raw.updates;thought.documentOperation='revise';Object.assign(thought,revision);}
      }catch{/* Invalid edit coordinates cannot imply a request for the whole body. */}
    }
    if(raw.operation==='merge'&&Array.isArray(raw.mergePreviousIds)&&raw.mergePreviousIds.every(id=>typeof id==='string'&&id.trim()&&id.length<=128))thought.mergePreviousIds=[...new Set(raw.mergePreviousIds as string[])];
    return thought.updates||thought.basis||thought.mergePreviousIds?.length?[thought]:[];
  }});
  let views;try{views=parseViewProposals(Array.isArray(value.views)&&value.views.some(v=>v&&typeof v==='object'&&'decision'in v)?bindViewTargets(value.views,[]):value.views);}catch(error){errors.push(...(error instanceof ReadingDocumentError?error.errors:[(error as Error).message]));}
  if(errors.length){
    if(!diagnostics)throw new ReadingDocumentError(errors);
    // Only the domain's read-only diagnostic pass may inspect valid pieces.
    // Never apply this partial shape: omitted invalid entries keep the whole
    // candidate rejected, so their original tN positions cannot be rewritten.
    diagnostics.push(...errors);return{reply:'',thoughts,wantsLong:false,views,reinforce:Array.isArray(value.reinforce)?value.reinforce:undefined};
  }
  return parseReadingReply(JSON.stringify({...(value.partnerMaintenance!==undefined?{partnerMaintenance:value.partnerMaintenance}:{}),reply:'',thoughts,reinforce:value.reinforce,wantsLong:false,views,paragraphComments,reaction,workspace:{...(value.working!==undefined?{working:value.working}:{}),...(value.understanding!==undefined?{understanding:value.understanding}:{}),...(value.focus!==undefined?{focus:value.focus}:{})}}),1,'companion',options);
}
/** Shape validation has no body resolver and publishes nothing. */
export function validateReadingDocumentsPayloadShape(args:unknown,options:{partnerMaintenance?:boolean}={}):void{
  if(args&&typeof args==='object'&&!Array.isArray(args)&&Object.hasOwn(args,'candidate')){validateCandidateAmendment(args as Record<string,unknown>);return;}
  const value=args as {views?:unknown[]}|undefined;
  // Target identity is checked by the domain against actually supplied views.
  // This shape-only entry must not invent a version or canonical kind for it.
  if(Array.isArray(value?.views)&&value.views.some(v=>v&&typeof v==='object'&&'target'in v)){
    for(const [index,v]of value.views.entries())if(v&&typeof v==='object'&&'target'in v){if(typeof v.target!=='string'||!/^v[1-9]\d*$/.test(v.target))throw Error(`views[${index}].target须为v编号`);}
    readingDocumentsShape({...value,views:undefined},undefined,options);return;
  }
  readingDocumentsShape(args,undefined,options);
}
export function readingDocumentsPayload(args:unknown,context?:{resolveProvidedDocument:(label:string)=>Memory|undefined}):ReadingReply{
  let reply=readingDocumentsShape(args);
  if(reply.thoughts.some(t=>['revise','organize','retire','restore'].includes(t.documentOperation??''))){if(!context)throw Error('文档删改与生命周期操作需要实际完整文档上下文');reply=materializeDocumentRevisions(reply,context.resolveProvidedDocument);}
  reply.thoughts.forEach(t=>{if(!['revise','organize','retire','restore'].includes(t.documentOperation??'')||context)natural(t.text,undefined);});
  return reply;
}

export const readingTextOutputPolicy='本次自动阅读的完整理解和独立看法直接以自然正文结束，或调用finish_reading，只提交{text:"完整阅读正文"}。正文应连贯接续人物愿望、情绪、选择、世界条件和相互影响的故事线，保留变化、已有依据和未知；不要为了填结构字段拆碎理解。程序逐字安静保存为opinion，不虚构用户发言。finish_reading与取材工具不要混在同一包；先取得必要资料再完成。旧资料模式如有明确资料修改，可在同一最终响应另外调用submit_reading，程序独立核验，坏提议整体丢弃仍保存完整阅读正文；不要求为格式再次调用。companion自动阅读仅开放读取工具和正文出口，资料修改与关注调整在实际交流入口保留。普通交流沿真实终态正文回应读者。';
export const readingTextTool:ModelTool & {validate(args:unknown):void}={name:'finish_reading',description:'完成当前阅读。只提交完整阅读理解和独立看法；自动阅读安静保存。',parameters:{type:'object',properties:{text:{type:'string',minLength:1}},required:['text'],additionalProperties:false},validate:readingTextPayload};
export const readingReactionOutputPolicy='本次非安静阅读允许独立分享阅读反应。有值得当下分享的反应时，可在同一最终响应将react_to_reading与finish_reading一起提交；react_to_reading仅使用{text:"短反应"}，最多1800字符，可省略。完整阅读理解继续由finish_reading承担，附加资料提议继续独立核验；反应无效时保留完整阅读正文。';
export const readingReactionTool:ModelTool={name:'react_to_reading',description:'非安静阅读的独立可选短反应；仅与finish_reading同一最终响应时应用。',parameters:{type:'object',properties:{text:{type:'string',minLength:1,maxLength:1800}},required:['text'],additionalProperties:false}};
export const earlyReadingReactionPolicy='本轮显式启用可选提前短反应。有当前值得分享的一点时可先单独调用react_to_reading；表达由本次人格和实际场景决定，不催促读者回复，不概括尚未完成的阅读。该调用不会完成读入；随后沿同一任务取材并用finish_reading交付完整看法。也可以保持安静，直接完成完整看法。短反应须受当前quiet、实际相关观察和前台优先约束；saved/suppressed可在同一活跃原任务重新判断，已实际交付原话不重复，冷恢复不补播。';
export const earlyReadingReactionTool:ModelTool={...readingReactionTool,description:'当前非安静阅读的可选提前短反应；不完成阅读或推进工作台。同一任务随后仍须交付finish_reading。'};
/** A narrow expression reminder, not a second model or a new answer schema. */
export function focusedExpressionReminder(question:string,long=false):string|undefined {
  if(!/(为什么|为何|原因|导致|因果|谁|哪天|何时|什么时候|是否|是不是|有没有|确认|确定|怎么发生|梳理|分析|回顾|关系|经历|变化|规则|线索|时序)/u.test(question))return;
  if(/(感受|感觉|心情|心酸|难过|悲伤|害怕|开心|喜欢|讨厌|感动)/u.test(question)&&!/(事实|确认|实际发生|上报|控制|谁|何时|哪天|什么时候|次日|确定|因果)/u.test(question))return;
  return `本题涉及事实、关系或因果${long?'长答':''}：使用已取得的材料组织回答，关键一两项有疑问时按需对照本轮已给入的原文，可使用check_answer_support继续同一生成任务。核清谁作何判断、谁作用于谁、被动关系及当时/次日/现在的时间锚点；角色猜测、已确认事实和你的解释分别表达。材料已正确取到仍须避免在综合表达时颠倒关系；仅未展示的进展不写成确定未发生。只保留影响本问的条件，不追加泛泛谨慎套话，不强制每问调用工具或为每句再调用模型。`;
}
/** Optional reactions never repair syntax, replace the reading body or grant
 * permission to speak. The caller supplies the original task's allowance. */
export function readingReactionPayload(raw:string|undefined,allowed=false):string|undefined {
  if(!allowed||typeof raw!=='string')return;
  try{const value:unknown=JSON.parse(raw);
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>key!=='text')||
      typeof (value as {text?:unknown}).text!=='string')return;
    const text=(value as {text:string}).text;return isNaturalReadingText(text,1800)?text:undefined;
  }catch{return;}
}
export function readingTextPayload(value:unknown):string {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>k!=='text')||typeof (value as {text?:unknown}).text!=='string')throw Error('阅读正文出口须包含完整text，原答保持');
  return natural((value as {text:string}).text,undefined);
}
/** A legacy final carrier has one explicit body. Never infer it from other
 * fields, repair JSON or turn a material request into a reading result. */
export function readingLegacySubmitBody(raw:string):string|undefined {
  const value:unknown=JSON.parse(raw);
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('旧阅读完成参数须为完整JSON对象，原答保持');
  if(['read','lookup','recall','history','search','readPage'].some(key=>Object.hasOwn(value,key)))throw Error('取材参数不能成为旧阅读完成正文，原答保持');
  if(!Object.hasOwn(value,'readingBrief'))return;
  const text=(value as {readingBrief?:unknown}).readingBrief;
  if(typeof text!=='string')throw Error('旧阅读完成参数的readingBrief须为完整自然正文，原答保持');
  return natural(text,undefined);
}
/** The explicit body is not a legacy metadata operation. Project only that
 * field away for optional validation; the original carrier remains intact. */
export function readingLegacySubmitProposal(raw:string):string {
  const value:unknown=JSON.parse(raw);
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('旧阅读完成参数须为完整JSON对象，原答保持');
  const proposal={...value} as Record<string,unknown>;delete proposal.readingBrief;
  return JSON.stringify(proposal);
}
export function readingTextResult(text:string,assertComplete:()=>void,strategy:ReadingStrategy,proposal?:ReadingReply):ReadingReply {
  const view=readingOpinionFinal(text,assertComplete,strategy);if(!proposal)return view;
  const thoughts=[...proposal.thoughts,...view.thoughts];
  return{...proposal,reply:'',replyBasis:undefined,thoughts,...(strategy==='companion'?{workspace:{...proposal.workspace,understanding:`t${thoughts.length}`}}:{})};
}

export const readingOutputPolicy='完整自然阅读正文可以直接结束，程序逐字保存为本轮独立看法；自动阅读安静保存，不虚构用户发言或共同交流。完整opinion逐字保存，其余认识最多1800。明确修改认识、问题或资料仍通过submit_reading提出，不从散文推断结构操作。自动阅读使用唯一最终submit_reading时，其参数中的阅读正文和显式workspace选择承担理解，同包content仅保留为原答说明，不替换当前看法。结构提议无法应用但参数为完整JSON时，程序按readingBrief、reply、thoughts正文原顺序保留完整文字，整体放弃结构操作；缺失或损坏的参数不能用重交说明冒充成果。取材过程的正文保持中间资料。自然交流以实际最终正文回应读者，提交中的有效认识仍保留。';

/** A final text channel carries prose, never a damaged protocol payload. */
export function isNaturalReadingText(text:string,limit?:number):boolean {
  const visible=text.trim();
  return!!visible&&(limit===undefined||text.length<=limit)&&!/^[{\[]|^```|^<(?:tool|function|think)/i.test(visible)&&!/"(?:reply|thoughts|replyBasis|tool_calls)"\s*:/.test(visible);
}
function natural(text:string,limit?:number):string {
  if(!isNaturalReadingText(text,limit))throw Error('自然阅读正文不完整，原答保持');
  return text;
}

/** Some channels return an array as a JSON string. Read only complete direct
 * text fields; opaque metadata is never repaired into a structural proposal. */
function encodedThoughtTexts(text:string):string[] {
  type Token={raw:string;kind:'string'|'value'|'punct';value?:string};
  const tokens:Token[]=[],fail=()=>{throw Error('编码认识的正文或对象边界不完整，原答保持');};
  for(let i=0;i<text.length;){
    const c=text[i];if(/[ \t\r\n]/.test(c)){i++;continue;}
    if(c==='"'){
      const start=i++;let closed=false;
      while(i<text.length){if(text[i]==='\\'){i+=2;continue;}if(text[i++]==='"'){closed=true;break;}}
      if(!closed)fail();const raw=text.slice(start,i),value:unknown=JSON.parse(raw);
      if(typeof value!=='string')fail();tokens.push({raw,kind:'string',value:value as string});continue;
    }
    if('{}[]:,'.includes(c)){tokens.push({raw:c,kind:'punct'});i++;continue;}
    const primitive=/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
    if(!primitive)fail();const raw=primitive![0];tokens.push({raw,kind:'value'});i+=raw.length;
  }
  let index=0;const at=(c:string)=>tokens[index]?.kind==='punct'&&tokens[index].raw===c;
  const take=(c:string)=>{if(!at(c))fail();index++;};
  const skipValue=():void=>{
    if(at('{')){
      // Curly braces establish the opaque object's boundary. A bad metadata
      // array does not make its nested text a direct thought text field.
      let depth=0;do{const token=tokens[index++];if(!token)fail();if(token.kind==='punct'){if(token.raw==='{')depth++;else if(token.raw==='}')depth--;}}while(depth>0);return;
    }
    if(at('[')){index++;if(at(']')){index++;return;}while(true){skipValue();if(at(']')){index++;return;}take(',');}}
    if(tokens[index]?.kind==='string'||tokens[index]?.kind==='value'){index++;return;}fail();
  };
  const parts:string[]=[];
  const thought=()=>{
    take('{');let seenText=false;if(at('}')){index++;return;}
    while(true){
      const key=tokens[index++];if(key?.kind!=='string')fail();take(':');
      const direct=key.value==='text',opaqueObject=at('{');
      if(direct){if(seenText)fail();seenText=true;}
      if(direct&&tokens[index]?.kind==='string'){parts.push(tokens[index++].value!);}
      else skipValue();
      // Only non-text metadata may contain surplus array punctuation, while
      // the enclosing thought object and the next field remain unambiguous.
      if(!direct&&opaqueObject)while(at(']'))index++;
      if(at('}')){index++;return;}take(',');
    }
  };
  take('[');if(!at(']'))while(true){if(at('{'))thought();else skipValue();if(at(']'))break;take(',');}
  take(']');if(index!==tokens.length)fail();return parts;
}

/** Recover readable leaves from a complete final envelope, never operations,
 * tool requests, hidden reasoning or invented text. */
export function readingEnvelopeText(text:string,conversation=false):string {
  const value=JSON.parse(text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));
  if(!value||typeof value!=='object'||Array.isArray(value)||['read','lookup','recall','history','search','readPage'].some(key=>Object.hasOwn(value,key)))throw Error('取材或不完整协议不能成为阅读成果');
  const parts:string[]=[];
  if(!conversation&&typeof value.readingBrief==='string'&&value.readingBrief.trim())parts.push(value.readingBrief);
  if(typeof value.reply==='string'&&value.reply.trim())parts.push(value.reply);
  if(!conversation&&Array.isArray(value.thoughts))for(const thought of value.thoughts)if(thought&&typeof thought==='object'&&typeof thought.text==='string'&&thought.text.trim())parts.push(thought.text);
  if(!conversation&&typeof value.thoughts==='string')for(const text of encodedThoughtTexts(value.thoughts))if(text.trim())parts.push(text);
  const result=parts.join('\n\n');natural(result,conversation?20000:undefined);return result;
}

/** Preserve a complete final view, without inventing structural operations or
 * exact quotations. Omitted basis keeps every actually supplied dependency. */
export function readingOpinionFinal(text:string,assertComplete:()=>void,strategy:ReadingStrategy='structured'):ReadingReply {
  assertComplete();natural(text,undefined);
  return{reply:'',thoughts:[{kind:'opinion',text}],reinforce:[],wantsLong:false,...(strategy==='companion'?{workspace:{understanding:'t1'}}:{})};
}

/** The final prose is the conversation the reader receives. Explicit valid
 * memory operations survive, while prose does not inherit a narrower basis
 * that was attached to a different submit.reply. */
export function conversationFinalContent(text:string,assertComplete:()=>void,submission?:ReadingReply):ReadingReply {
  if(submission&&!text.trim())return submission;
  if(submission&&!isNaturalReadingText(text))return submission;
  if(!submission&&!isNaturalReadingText(text))text=readingEnvelopeText(text,true);
  assertComplete();natural(text,20000);
  const result=submission??{reply:'',thoughts:[],reinforce:[],wantsLong:false};
  return{...result,reply:text,replyBasis:undefined};
}

/** Automatic reading has a declared payload. Companion tool commentary never
 * overrides the reading text or its explicit workspace selection. */
export function readingSubmissionContent(text:string,assertComplete:()=>void,strategy:ReadingStrategy='structured',submission?:ReadingReply,rawSubmission?:string):ReadingReply {
  if(submission){assertComplete();return submission;}
  if(rawSubmission!==undefined){
    return readingOpinionFinal(readingEnvelopeText(rawSubmission),assertComplete,strategy);
  }
  if(!isNaturalReadingText(text))text=readingEnvelopeText(text);
  return readingOpinionFinal(text,assertComplete,strategy);
}

/** Shared schema used for both complete initial-packet sizing and actual dispatch. */
export const sceneParticipationTool:ModelTool={name:'finish_reading',description:'结束这次阅读事件：可选择本次实际供入的任意p原段，不要求末段。reaction.text用于独立侧栏发言，可选sourceId与quote；paragraphComments用于独立段评。两个出口可按需分别提供不同观点；分享同条段评用reaction:{comment:"cN"}复用原话。完整预读依赖实际读完后才可发表。quiet:true表示本轮完全不发表文字，不能与表达并用；用户的安静模式仍允许单独提交段评。已发表原话直接交后台接续。',parameters:{type:'object',properties:{reaction:readingDocumentsTool.parameters.properties&&(readingDocumentsTool.parameters.properties as any).reaction,paragraphComments:readingDocumentsTool.parameters.properties&&(readingDocumentsTool.parameters.properties as any).paragraphComments,sceneInsight:{type:'object',description:'可选：尚未在本次原话中表达、且需要后台接续的独立认识。已表达内容直接沿原话交接，不重复摘要；无需逐轮填写。',properties:{text:{type:'string',minLength:1,maxLength:1600},sourceIds:{type:'array',minItems:1,items:{type:'string',pattern:'^p[1-9][0-9]*$'}}},required:['text','sourceIds'],additionalProperties:false},quiet:{type:'boolean',const:true}},anyOf:[{required:['reaction']},{required:['paragraphComments']},{required:['quiet']}],additionalProperties:false}};
export const sceneMaterialTools:ModelTool[]=[
  {name:'read_original',description:'按已授权的绝对UTF16范围取回必要原文。',parameters:{type:'object',properties:{start:{type:'integer'},end:{type:'integer'}},required:['start','end'],additionalProperties:false}},
  {name:'read_memory_documents',description:'按目录m编号取得必要的完整历史认识；目录不授事实或修改资格。已取得的全文不重复返回。',parameters:{type:'object',properties:{ids:{type:'array',minItems:1,items:{type:'string'}}},required:['ids'],additionalProperties:false}},
  {name:'discover_memory_documents',description:'根据当前话题查找旧认识目录，必要时再展开全文。',parameters:{type:'object',properties:{query:{type:'string',maxLength:1000}},required:['query'],additionalProperties:false}}
];
