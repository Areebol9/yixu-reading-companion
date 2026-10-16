import {parseViewProposals,viewProposalSchema} from './published-views.ts';
import {paragraphCommentsSchema,readingExpressionSchema,parseParagraphComments,parseReadingExpression} from './paragraph-comments.ts';
import type { Memory,ModelTool, ReadingReply, ReadingStrategy } from './types.ts';
import {READING_DOCUMENT_MAX_CHARS} from './types.ts';
import {parseReadingReply} from './model.ts';
import {knowledgeDistributionSchema,parseKnowledgeDistribution} from './knowledge-distribution.ts';
import {companionWorkspaceSchema} from './companion-schema.ts';
import {materializeDocumentRevisions,parseDocumentEdits,parseDocumentSourceIds,ReadingDocumentError} from './document-revision.ts';
import {parseStructuralBasis,structuralBasisSchema} from './basis.ts';

export type ReadingSubmission={kind:'reaction'|'finish'|'text';raw:string;usageId?:string;reactionRaw?:string;proposalRaw?:string};
export type ReadingAcceptance<T>={materials?:{affectedViews:{id:string;kind:string;key:string;text:string}[];memoryResults?:{source:string;text:string}[];memorySuccessors?:{previousId:string;currentId:string}[];coreViewMergeGroups?:{kind:string;viewIds:string[];reason:string}[];instruction?:string};accepted:boolean;result?:T;errors:string[];expressionDelivery:import('./paragraph-comments.ts').ExpressionDeliveryReport};
/** One domain feedback body; errors are complete and occur only once. */
export function readingFeedback(reading:Pick<ReadingAcceptance<unknown>,'accepted'|'errors'|'materials'>&{expressionDelivery?:ReadingAcceptance<unknown>['expressionDelivery']}){return JSON.parse(JSON.stringify({accepted:reading.accepted,errors:reading.errors,...(reading.expressionDelivery?{expressionDelivery:reading.expressionDelivery}:{}),...(reading.materials?{materials:reading.materials}:{}),originalReplyRetained:true}));}
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
    try{const value=JSON.parse(response.content.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));if(value&&typeof value==='object'&&!Array.isArray(value))return{kind:'finish',raw:response.content,usageId:response.requestId};}catch{}
    return{kind:'text',raw:response.content,usageId:response.requestId};
  }
}
export function restoreReadingSubmission(candidate:import('./types.ts').CompanionReadingReceipt['candidate'],usageId:string):ReadingSubmission{
  let kind:ReadingSubmission['kind']=candidate.format==='reading-text'?'finish':'text';
  if(candidate.format==='content')try{const value=JSON.parse(candidate.text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));if(value&&typeof value==='object'&&!Array.isArray(value))kind='finish';}catch{}
  return{kind,raw:candidate.text,usageId,reactionRaw:candidate.reaction,proposalRaw:candidate.proposal};
}

export const readingDocumentsOutputPolicy='本次采用多篇完整阅读文档。用finish_reading提交documents，每篇明确operation=create、develop或revise；create新建完整text，develop填本轮已取得全文的updates编号、updateReason及完整新text。局部变化优先revise：填updates、updateReason和edits[{oldText,newText,sourceIds?}]，可用appendText明确追加；不填text。oldText在同一具体旧版全文中须唯一逐字匹配、各处不重叠，程序保存完整新版本，未触正文逐字保留，追加包含所需换行。新主张提供本轮实际原文p编号sourceIds，引用可选quoteSource，纯文字整理在updateReason说明；出处仅用于追溯，不自动证明理解正确。basis可声明实际完整m/c/h来源，省略保守继承全部依赖；接续始终保留旧版依赖。每篇围绕能独立理解的人物关系、事件经历、世界条件或整体印象展开，篇内保留理由、条件和未知，不按固定人物/事件字段拆成卡片。不要求每批重写全书印象。每篇最多12000字符（UTF-16）；实际全文capacity给出chars/max/remaining，最多8篇、总计48000字符；长篇历史留在长期文档，不塞入一篇。documentTitle和navigationCues只是查找线索，由本次正文同时形成，不能添加后来知识。working选出下一轮仍需要的具体m或本次tN，省略沿用；同包唯一updates接续的旧m选择自动继承到对应新t，显式[]退出工作集并保留长期正文，basis和updates仍引用旧版本。已有文档可留存而退出工作集；当前首包目录仅导航，使用或续写前用read_memory_documents取得全文。自然正文结束则仅新存一篇独立看法；不能借自然正文隐含替换旧稿。';
const documentSourceSchema={type:'array',items:{type:'string',pattern:'^p[1-9][0-9]{0,5}$'},description:'精选关键且去重的本轮实际原文p编号，避免无关出处拖慢处理；合法完整出处不按数量拒绝，出处用于追溯，不自动证明理解正确。'};
/** Exact compatibility for the view/source capacity corrections only. The
 * original carrier stays immutable; a continued HTTP request records new tools. */
export function isReadingViewCapacityUpgrade(previous:ModelTool,current:ModelTool):boolean{
  if(previous.name!=='finish_reading'||current.name!==previous.name)return false;
  const prior=structuredClone(previous),p=(prior.parameters.properties as any),c=(current.parameters.properties as any);
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
export const readingDocumentsTool:ModelTool & {validate(args:unknown):void}={name:'finish_reading',description:'保存一篇或多篇完整阅读文档，新建create、完整接续develop或局部修订revise。create/develop写documents.text，revise写edits及可选appendText，不填text。working、understanding、focus只填引用编号，tN为本次documents第N篇，mN须本轮已完整展开。',parameters:{type:'object',properties:{views:viewProposalSchema,paragraphComments:paragraphCommentsSchema,reaction:readingExpressionSchema,documents:{type:'array',minItems:0,maxItems:8,items:{type:'object',properties:{operation:{type:'string',enum:['create','develop','revise']},text:{type:'string',minLength:1,maxLength:READING_DOCUMENT_MAX_CHARS,description:'create/develop的完整理解正文，逐字保存；revise不填。'},documentTitle:{type:'string',maxLength:160},navigationCues:{type:'array',maxItems:16,items:{type:'string',minLength:1,pattern:'\\S',maxLength:160}},knowledgeDistribution:knowledgeDistributionSchema,updates:{type:'string',minLength:1,maxLength:128,description:'develop/revise须填本轮真正取得全文的有效opinion具体旧版m编号。'},updateReason:{type:'string',minLength:1,pattern:'\\S',maxLength:240},edits:{type:'array',maxItems:32,items:{type:'object',properties:{oldText:{type:'string',minLength:1,maxLength:READING_DOCUMENT_MAX_CHARS},newText:{type:'string',maxLength:READING_DOCUMENT_MAX_CHARS},sourceIds:documentSourceSchema},required:['oldText','newText'],additionalProperties:false}},appendText:{type:'string',minLength:1,maxLength:READING_DOCUMENT_MAX_CHARS,description:'revise明确追加的正文，包含所需换行，沿本篇sourceIds关联实际出处。'},sourceIds:documentSourceSchema,quoteSource:{type:'string',pattern:'^p[1-9][0-9]{0,5}$'},basis:structuralBasisSchema},required:['operation'],oneOf:[{properties:{operation:{const:'create'}},required:['text'],not:{anyOf:[{required:['updates']},{required:['updateReason']},{required:['edits']},{required:['appendText']}]}},{properties:{operation:{const:'develop'}},required:['text','updates','updateReason'],not:{anyOf:[{required:['edits']},{required:['appendText']}]}},{properties:{operation:{const:'revise'}},required:['updates','updateReason'],anyOf:[{required:['edits']},{required:['appendText']}],not:{required:['text']}}],additionalProperties:false}},working:companionWorkspaceSchema.properties.working,understanding:companionWorkspaceSchema.properties.understanding,focus:companionWorkspaceSchema.properties.focus},required:['documents'],additionalProperties:false},validate:validateReadingDocumentsPayloadShape};
function readingDocumentsShape(args:unknown):ReadingReply{
  if(!args||typeof args!=='object'||Array.isArray(args))throw Error('阅读文档出口须包含明确documents，原答保持');
  const value=args as Record<string,unknown>;
  const unexpected=Object.keys(value).filter(k=>!['documents','working','understanding','focus','paragraphComments','reaction','views'].includes(k));
  if(unexpected.length||!Array.isArray(value.documents)||value.documents.length>8)throw Error(Object.hasOwn(value,'sourceIds')?'finish_reading.sourceIds不能位于顶层；请放入documents[i].sourceIds或documents[i].edits[j].sourceIds，原答保持':unexpected.length?`finish_reading顶层字段不允许：${unexpected.join('、')}；只允许documents、working、understanding、focus，原答保持`:'阅读文档集合无效，原答保持');
  const paragraphComments=parseParagraphComments(value.paragraphComments),reaction=parseReadingExpression(value.reaction,paragraphComments);
  let chars=0;const errors:string[]=[];
  const thoughts=value.documents.flatMap((document,index)=>{try{
    if(!document||typeof document!=='object'||Array.isArray(document)||Object.keys(document).some(k=>!['operation','text','documentTitle','navigationCues','knowledgeDistribution','updates','updateReason','edits','appendText','sourceIds','quoteSource','basis'].includes(k))||!['create','develop','revise'].includes(document.operation))throw Error('阅读文档须明确新建、接续或局部修订，原答保持');
    parseKnowledgeDistribution(document.knowledgeDistribution,`documents[${index}].knowledgeDistribution`);
    if(document.operation==='revise'){
      if(document.text!==undefined)throw Error('局部修订revise只填edits/appendText，完整text由旧全文形成，原答保持');
      parseDocumentEdits(document,`documents[${index}].edits`);
      if(document.edits===undefined&&document.appendText===undefined)throw Error('局部修订revise须有edits或appendText，原答保持');
    }else{
      if(document.edits!==undefined||document.appendText!==undefined||typeof document.text!=='string')throw Error('create/develop须给完整text，不混用局部修订，原答保持');
      natural(document.text,READING_DOCUMENT_MAX_CHARS);chars+=document.text.length;
    }
    if(document.operation==='create'&&(document.updates!==undefined||document.updateReason!==undefined)||document.operation!=='create'&&(!document.updates||!document.updateReason))throw Error('阅读接续须带实际全文目标及变化原因，原答保持');
    parseDocumentSourceIds(document.sourceIds,`documents[${index}].sourceIds`);parseStructuralBasis(document.basis);
    const {operation,...body}=document;return[{kind:'opinion',...body,text:document.text??'',documentOperation:operation}];
  }catch(error){errors.push(`documents[${index}]：${(error as Error).message}`);return[];}});
  if(chars>READING_DOCUMENT_MAX_CHARS*4)errors.push(`本次阅读文档实际${chars}字符，超过${READING_DOCUMENT_MAX_CHARS*4}字符，原答保持`);
  if(errors.length)throw new ReadingDocumentError(errors);
  return parseReadingReply(JSON.stringify({reply:'',thoughts,wantsLong:false,views:parseViewProposals(value.views),paragraphComments,reaction,workspace:{...(value.working!==undefined?{working:value.working}:{}),...(value.understanding!==undefined?{understanding:value.understanding}:{}),...(value.focus!==undefined?{focus:value.focus}:{})}}),1,'companion');
}
/** Shape validation has no body resolver and publishes nothing. */
export function validateReadingDocumentsPayloadShape(args:unknown):void{readingDocumentsShape(args);}
export function readingDocumentsPayload(args:unknown,context?:{resolveProvidedDocument:(label:string)=>Memory|undefined}):ReadingReply{
  let reply=readingDocumentsShape(args);
  if(context&&reply.thoughts.some(t=>t.documentOperation==='revise'))reply=materializeDocumentRevisions(reply,context.resolveProvidedDocument);
  if(reply.thoughts.reduce((n,t)=>n+t.text.length,0)>48000)throw Error('本次阅读文档超过48000字符，原答保持');
  reply.thoughts.forEach(t=>{if(t.documentOperation!=='revise'||context)natural(t.text,READING_DOCUMENT_MAX_CHARS);});
  return reply;
}

export const readingTextOutputPolicy='本次自动阅读的完整理解和独立看法直接以自然正文结束，或调用finish_reading，只提交{text:"完整阅读正文"}。正文应连贯接续人物愿望、情绪、选择、世界条件和相互影响的故事线，保留变化、已有依据和未知；不要为了填结构字段拆碎理解。正文最多12000字符，程序逐字安静保存为opinion，不虚构用户发言。finish_reading与取材工具不要混在同一包；先取得必要资料再完成。旧资料模式如有明确资料修改，可在同一最终响应另外调用submit_reading，程序独立核验，坏提议整体丢弃仍保存完整阅读正文；不要求为格式再次调用。companion自动阅读仅开放读取工具和正文出口，资料修改与关注调整在实际交流入口保留。普通交流沿真实终态正文回应读者。';
export const readingTextTool:ModelTool & {validate(args:unknown):void}={name:'finish_reading',description:'完成当前阅读。只提交完整阅读理解和独立看法；自动阅读安静保存。',parameters:{type:'object',properties:{text:{type:'string',minLength:1,maxLength:READING_DOCUMENT_MAX_CHARS}},required:['text'],additionalProperties:false},validate:readingTextPayload};
export const readingReactionOutputPolicy='本次非安静阅读允许独立分享简短自然反应。有值得当下分享的反应时，可在同一最终响应将react_to_reading与finish_reading一起提交；react_to_reading仅使用{text:"短反应"}，最多1800字符，可省略。完整阅读理解继续由finish_reading承担，附加资料提议继续独立核验；反应无效时保留完整阅读正文。';
export const readingReactionTool:ModelTool={name:'react_to_reading',description:'非安静阅读的独立可选短反应；仅与finish_reading同一最终响应时应用。',parameters:{type:'object',properties:{text:{type:'string',minLength:1,maxLength:1800}},required:['text'],additionalProperties:false}};
export const earlyReadingReactionPolicy='本轮显式启用可选提前短反应。有当前值得分享的一点时可先单独调用react_to_reading；只表达具体、简短的反应，可自然引出话题或疑问，不催促读者回复，不概括尚未完成的阅读。该调用不会完成读入；随后沿同一任务取材并用finish_reading交付完整看法。也可以保持安静，直接完成完整看法。短反应须受当前quiet、实际相关观察和前台优先约束；saved/suppressed可在同一活跃原任务重新判断，已实际交付原话不重复，冷恢复不补播。';
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
  return natural((value as {text:string}).text,READING_DOCUMENT_MAX_CHARS);
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
  return natural(text,READING_DOCUMENT_MAX_CHARS);
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
  const thoughts=[...proposal.thoughts,...view.thoughts];if(thoughts.length>16)throw Error('附加提议超过本轮认识容量，阅读正文独立保留');
  return{...proposal,reply:'',replyBasis:undefined,thoughts,...(strategy==='companion'?{workspace:{...proposal.workspace,understanding:`t${thoughts.length}`}}:{})};
}

export const readingOutputPolicy='完整自然阅读正文可以直接结束，程序逐字保存为本轮独立看法；自动阅读安静保存，不虚构用户发言或共同交流。完整opinion可至12000字符，其余认识最多1800。明确修改认识、问题或资料仍通过submit_reading提出，不从散文推断结构操作。自动阅读使用唯一最终submit_reading时，其参数中的阅读正文和显式workspace选择承担理解，同包content仅保留为原答说明，不替换当前看法。结构提议无法应用但参数为完整JSON时，程序按readingBrief、reply、thoughts正文原顺序保留完整文字，整体放弃结构操作；缺失或损坏的参数不能用重交说明冒充成果。取材过程的正文保持中间资料。自然交流以实际最终正文回应读者，提交中的有效认识仍保留。';

/** A final text channel carries prose, never a damaged protocol payload. */
export function isNaturalReadingText(text:string,limit=20000):boolean {
  const visible=text.trim();
  return!!visible&&text.length<=limit&&!/^[{\[]|^```|^<(?:tool|function|think)/i.test(visible)&&!/"(?:reply|thoughts|replyBasis|tool_calls)"\s*:/.test(visible);
}
function natural(text:string,limit:number):string {
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
  const result=parts.join('\n\n');natural(result,conversation?20000:READING_DOCUMENT_MAX_CHARS);return result;
}

/** Preserve a complete final view, without inventing structural operations or
 * exact quotations. Omitted basis keeps every actually supplied dependency. */
export function readingOpinionFinal(text:string,assertComplete:()=>void,strategy:ReadingStrategy='structured'):ReadingReply {
  assertComplete();natural(text,READING_DOCUMENT_MAX_CHARS);
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
export const sceneParticipationTool:ModelTool={name:'finish_reading',description:'完成本次现场参与：可分享一点短反应、留下段评，或明确安静。私人认识维护另有任务。',parameters:{type:'object',properties:{reaction:readingDocumentsTool.parameters.properties&&(readingDocumentsTool.parameters.properties as any).reaction,paragraphComments:readingDocumentsTool.parameters.properties&&(readingDocumentsTool.parameters.properties as any).paragraphComments,sceneInsight:{type:'object',description:'可选：值得后台采用的简短判断、疑点或证据联系。不是逐轮摘要或内部推理；无新成果可省略。',properties:{text:{type:'string',minLength:1,maxLength:1600},sourceIds:{type:'array',minItems:1,items:{type:'string',pattern:'^p[1-9][0-9]*$'}}},required:['text','sourceIds'],additionalProperties:false},quiet:{type:'boolean',const:true}},anyOf:[{required:['reaction']},{required:['paragraphComments']},{required:['quiet']}],additionalProperties:false}};
export const sceneMaterialTools:ModelTool[]=[
  {name:'read_original',description:'按已授权的绝对UTF16范围取回必要原文，每次最多6000字符。',parameters:{type:'object',properties:{start:{type:'integer'},end:{type:'integer'}},required:['start','end'],additionalProperties:false}},
  {name:'read_memory_documents',description:'按目录m编号取得必要的完整历史认识；目录不授事实或修改资格。已取得的全文不重复返回。',parameters:{type:'object',properties:{ids:{type:'array',minItems:1,maxItems:8,items:{type:'string'}}},required:['ids'],additionalProperties:false}},
  {name:'discover_memory_documents',description:'根据当前话题查找旧认识目录，必要时再展开全文。',parameters:{type:'object',properties:{query:{type:'string',maxLength:1000}},required:['query'],additionalProperties:false}}
];
