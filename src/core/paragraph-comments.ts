import type {Book,Chat,Evidence,Range,State} from './types.ts';
import {covers,mergeRanges} from './books.ts';
import {isEvidenceAllowed,memoryIsForgotten} from './context.ts';
import {chatBelongsToPartner} from './discussion-recall.ts';
import {hashText} from './text-hash.ts';
import {bookVersionAllowsRange} from './book-versions.ts';
import {validateMessageEmojiReactions} from './message-reactions.ts';

export type ParagraphCommentProposal={sourceId:string;quote:string;text:string};
export type ReadingExpression={text:string;sourceId?:string;quote?:string}|{comment:string};
export type ParagraphAnchor=Evidence&{quote:string;hash:string};
export type ParagraphCommentView={partnerId?:string;presentationReceipt?:Chat['presentationReceipt'];emojiReactions?:Chat['emojiReactions'];recoveredFrom?:Chat['recoveredFrom'];id:string;text:string;role:'user'|'assistant';anchor:ParagraphAnchor;createdAt:number;formationRanges:Range[];formedThrough:number;status:'current'|'outdated';outdatedBy?:string;sharedChatId?:string;replyTo?:string;paragraphCommentId?:string;liked:boolean;delivery?:Chat['delivery'];replyChatId?:string;sessionId:string;receiptPending:boolean};
export type UserParagraphComment={range:Range;version:string;quote:string;text:string;parentId?:string};
export type ParagraphCommentQuery={ranges?:Range[];cursor?:string};
export type ParagraphCommentResult={items:ParagraphCommentView[];nextCursor?:string};
export const paragraphCommentsSchema={type:'array',description:'按需发表在原文旁的伙伴段评，可省略或为空；不是用户发言或私人理解。sourceId须本轮实际p编号，quote逐字取自该段。',items:{type:'object',properties:{sourceId:{type:'string',pattern:'^p[1-9][0-9]*$'},quote:{type:'string',minLength:1},text:{type:'string',minLength:1,maxLength:20000}},required:['sourceId','quote','text'],additionalProperties:false}};
export const readingExpressionSchema={oneOf:[{type:'object',properties:{text:{type:'string',minLength:1,maxLength:1800}},required:['text'],additionalProperties:false},{type:'object',properties:{text:{type:'string',minLength:1,maxLength:1800},sourceId:{type:'string',pattern:'^p[1-9][0-9]*$',description:'本任务实际已提供的完整原段p编号；省略quote时锚定该完整原段。'},quote:{type:'string',minLength:1,description:'可选：逐字短引，将锚点缩小到该p原段内唯一匹配的子句。'}},required:['text','sourceId'],additionalProperties:false},{type:'object',properties:{comment:{type:'string',pattern:'^c[1-9][0-9]*$',description:'分享同包paragraphComments第N条，复用其原文，不重复写段评。'}},required:['comment'],additionalProperties:false}]};
export function parseParagraphComments(raw:unknown):ParagraphCommentProposal[]|undefined{
  if(raw===undefined)return;
  if(!Array.isArray(raw))throw Error('paragraphComments须为数组，可省略或为空；原答保持');
  return raw.map((value,index)=>{
    const field=`paragraphComments[${index}]`;
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['sourceId','quote','text'].includes(k))||typeof value.sourceId!=='string'||!/^p[1-9]\d*$/.test(value.sourceId)||typeof value.quote!=='string'||!value.quote.trim()||typeof value.text!=='string'||!value.text.trim()||value.text.length>20000)throw Error(`${field}须包含实际sourceId、逐字quote与完整text；原答保持`);
    return{sourceId:value.sourceId,quote:value.quote,text:value.text};
  });
}
export function parseReadingExpression(raw:unknown,comments:readonly ParagraphCommentProposal[]=[]):ReadingExpression|undefined{
  if(raw===undefined)return;
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('reaction须为{text}或{comment:"cN"}；原答保持');
  const value=raw as Record<string,unknown>,keys=Object.keys(value);
  if(keys.every(k=>['text','sourceId','quote'].includes(k))&&typeof value.text==='string'&&value.text.trim()&&value.text.length<=1800){if(value.sourceId===undefined&&value.quote===undefined)return{text:value.text};if(typeof value.sourceId==='string'&&/^p[1-9]\d*$/.test(value.sourceId)&&(value.quote===undefined||typeof value.quote==='string'&&value.quote.trim()))return{text:value.text,sourceId:value.sourceId,...(typeof value.quote==='string'?{quote:value.quote}:{})};}
  if(keys.length===1&&keys[0]==='comment'&&typeof value.comment==='string'&&/^c[1-9]\d*$/.test(value.comment)&&comments[Number(value.comment.slice(1))-1])return{comment:value.comment};
  throw Error('reaction须为完整短text，或同包paragraphComments的有效cN；原答保持');
}
export function expressionText(reaction:ReadingExpression|undefined,comments:readonly ParagraphCommentProposal[]=[]):string|undefined{return reaction&&('text'in reaction?reaction.text:comments[Number(reaction.comment.slice(1))-1]?.text);}
/** An explicit p handle anchors only its actual supplied original. An omitted
 * quote selects that complete paragraph without changing the saved answer. */
export function resolveReadingExpressionRange(book:Book,reaction:Extract<ReadingExpression,{text:string}>,passages:ReadonlyMap<string,{text:string;evidence:Evidence}>,extra:Range[]=[]):Omit<ParagraphAnchor,'hash'>|undefined{
  if(!reaction.sourceId)return;
  const passage=passages.get(reaction.sourceId);
  if(!passage)throw Error('reaction.sourceId未在本轮实际获准原文中提供；请使用已给p编号');
  return resolveParagraphRanges(book,[{text:reaction.text,sourceId:reaction.sourceId,quote:reaction.quote??passage.text}],passages,'reaction',extra)[0];
}
export function resolveParagraphRanges(book:Book,comments:readonly ParagraphCommentProposal[],passages:ReadonlyMap<string,{text:string;evidence:Evidence}>,fieldPrefix='paragraphComments',extra:import('./types.ts').Range[]=[]):Omit<ParagraphAnchor,'hash'>[]{
  return comments.map((comment,index)=>{
    const passage=passages.get(comment.sourceId),field=fieldPrefix==='reaction'?'reaction':`${fieldPrefix}[${index}]`;
    if(!passage||passage.evidence.bookId!==book.id||!bookVersionAllowsRange(book,passage.evidence.version,passage.evidence)||!isEvidenceAllowed(book,[passage.evidence],extra))throw Error(`${field}.sourceId未在本轮实际获准原文中提供；请使用已给p编号`);
    const offset=passage.text.indexOf(comment.quote);
    if(offset<0||passage.text.indexOf(comment.quote,offset+1)>=0){
      const matches=[...passages].filter(([,p])=>p.evidence.bookId===book.id&&bookVersionAllowsRange(book,p.evidence.version,p.evidence)&&isEvidenceAllowed(book,[p.evidence],extra)&&p.text.includes(comment.quote)&&p.text.indexOf(comment.quote,p.text.indexOf(comment.quote)+1)<0).map(([sourceId])=>sourceId);
      throw Error(`${field}.quote须在${comment.sourceId}内唯一逐字匹配；保留表达正文。`+(matches.length?`原quote在这些已供原文编号中唯一匹配：${matches.join('、')}；请核对sourceId后提交，不必重写表达。`:`该编号的实际原文如下，请从中选唯一逐字短引：${JSON.stringify(passage.text)}`));
    }
    return{bookId:book.id,version:book.version,start:passage.evidence.start+offset,end:passage.evidence.start+offset+comment.quote.length,quote:comment.quote};
  });
}
export function paragraphCommentAllowed(state:State,book:Book,chat:Chat,seen=new Set<string>()):boolean{
  if(!chat||seen.has(chat.id))return false;seen.add(chat.id);
  if(chat.publication&&chat.publication.status!=='published')return false;
  const allowed=chat.presentation==='paragraph'&&chat.bookId===book.id&&chatBelongsToPartner(state,chat)&&!chat.excluded&&!chat.futureGrant&&!!chat.anchor&&bookVersionAllowsRange(book,chat.anchor.version,chat.anchor)&&isEvidenceAllowed(book,[chat.anchor,...chat.evidence])&&
    !(chat.memoryIds??[]).some(id=>{const m=state.memories.find(m=>m.id===id);return!m||memoryIsForgotten(state,m);})&&![...(chat.contextChatIds??[]),...(chat.historicalCommentIds??[])].some(id=>{const c=state.chats.find(c=>c.id===id);return!c||c.excluded;});
  if(!allowed)return false;
  const ancestors=[...new Set([chat.paragraphCommentId,chat.replyTo].filter((id):id is string=>!!id))];
  return ancestors.every(id=>{const parent=state.chats.find(c=>c.id===id);return !!parent&&parent.presentation==='paragraph'&&parent.anchor?.start===chat.anchor!.start&&parent.anchor.end===chat.anchor!.end&&paragraphCommentAllowed(state,book,parent,new Set(seen));});
}
export async function listParagraphComments(state:State,book:Book,query:ParagraphCommentQuery={}):Promise<ParagraphCommentResult>{
  if(!query||typeof query!=='object'||Array.isArray(query)||Object.keys(query).some(k=>!['ranges','cursor'].includes(k)))throw Error('段评查询仅接受ranges和cursor');
  if(query.ranges!==undefined&&(!Array.isArray(query.ranges)||query.ranges.some(r=>!r||!Number.isSafeInteger(r.start)||!Number.isSafeInteger(r.end)||r.start<0||r.end<=r.start)))throw Error('段评查询范围无效');
  const ranges=query.ranges?mergeRanges(query.ranges):undefined;
  const allowed=state.chats.filter(c=>paragraphCommentAllowed(state,book,c)&&(!ranges||ranges.some(r=>r.start<c.anchor!.end&&c.anchor!.start<r.end))).sort((a,b)=>a.anchor!.start-b.anchor!.start||a.createdAt-b.createdAt||a.id.localeCompare(b.id));
  const fence=await hashText(JSON.stringify([book.id,book.version,state.partnerId,book.known,ranges,allowed.map(c=>[c.id,c.partnerId,c.role,c.text,c.outdatedBy,c.sharedChatId,c.replyTo,c.paragraphCommentId,c.readerInteraction,c.emojiReactions,c.delivery,state.queryCheckpoints?.find(q=>q.questionId===c.id)?.status])]));
  let offset=0;if(query.cursor!==undefined){try{const cursor=JSON.parse(query.cursor);if(cursor.fence!==fence||!Number.isSafeInteger(cursor.offset)||cursor.offset<0)throw Error();offset=cursor.offset;}catch{throw Error('段评目录或许可已变化，请从当前范围重新查询');}}
  if(allowed.some(c=>!paragraphCommentAllowed(state,book,c)))throw Error('段评查询期间资料或许可已变化，请重新查询');
  const items=allowed.slice(offset,offset+32).map(c=>{const outdatedBy=c.outdatedBy??c.replacedBy,replyChatId=state.chats.find(reply=>reply.replyTo===c.id&&reply.role==='assistant'&&!reply.excluded)?.id;return{id:c.id,partnerId:c.partnerId,text:c.text,role:c.role,...(c.presentationReceipt?{presentationReceipt:{...c.presentationReceipt}}:{}),...(c.emojiReactions?{emojiReactions:structuredClone(c.emojiReactions)}:{}),anchor:structuredClone(c.anchor!),createdAt:c.createdAt,...(c.recoveredFrom?{recoveredFrom:{...c.recoveredFrom}}:{}),formationRanges:structuredClone(c.formationRanges??[]),formedThrough:c.formedThrough??Math.max(0,...c.evidence.map(r=>r.end)),status:c.outdatedBy||c.replacedBy?'outdated' as const:'current' as const,...(outdatedBy!==undefined?{outdatedBy}:{}),...(c.sharedChatId!==undefined?{sharedChatId:c.sharedChatId}:{}),...(c.replyTo!==undefined?{replyTo:c.replyTo}:{}),...(c.paragraphCommentId!==undefined?{paragraphCommentId:c.paragraphCommentId}:{}),liked:c.readerInteraction?.liked===true,...(c.delivery!==undefined?{delivery:c.delivery}:{}),sessionId:c.sessionId,...(replyChatId!==undefined?{replyChatId}:{}),receiptPending:!!state.queryCheckpoints?.find(q=>q.questionId===c.id&&q.status!=='consumed'&&(q.pendingReceipt||q.candidate||q.result))};});
  return{items,...(offset+items.length<allowed.length?{nextCursor:JSON.stringify({fence,offset:offset+items.length})}:{})};
}
export async function validateParagraphChats(state:State):Promise<void>{
  validateMessageEmojiReactions(state);
  for(const item of [...state.memories,...state.chats])if(item.historicalCommentIds!==undefined&&(!Array.isArray(item.historicalCommentIds)||item.historicalCommentIds.some(id=>typeof id!=='string'||!id)))throw Error('历史段评引用编号无效');
  for(const c of state.chats){
    if(c.readerInteraction!==undefined&&(!c.readerInteraction||Object.keys(c.readerInteraction).some(k=>!['liked','updatedAt'].includes(k))||typeof c.readerInteraction.liked!=='boolean'||!Number.isSafeInteger(c.readerInteraction.updatedAt)||c.readerInteraction.updatedAt<0||c.presentation!=='paragraph'))throw Error('读者段评反馈无效');
    if(c.expressionContract!==undefined&&(c.expressionContract!=='paragraph-expressions-v1'||c.role!=='assistant'))throw Error('伙伴表达合同标记无效');
    if(c.publication!==undefined){
      const p=c.publication,o=p?.scene;
      if(c.role!=='assistant'||!p||Object.keys(p).some(k=>!['status','reason','dueAt','scene','destination'].includes(k))||!['published','deferred','obsolete','save-failed'].includes(p.status)||p.destination!==undefined&&p.destination!=='paragraph'||p.reason!==undefined&&typeof p.reason!=='string'||p.dueAt!==undefined&&(!Number.isFinite(p.dueAt)||p.dueAt<0)||o&&(!o.instanceId||!o.sessionId||!Number.isSafeInteger(o.generation)||!Number.isSafeInteger(o.dialogueRevision)||!o.usageId||!o.requestKey||!/^[a-f0-9]{64}$/.test(o.stampHash)))throw Error('表达保存或交付状态无效');
    }
    if(c.paragraphCommentId!==undefined&&(typeof c.paragraphCommentId!=='string'||!c.paragraphCommentId))throw Error('引用段评编号无效');
    if(c.presentation!==undefined&&c.presentation!=='paragraph')throw Error('伙伴表达展示类型无效');
    if(c.expressionAnchor){const a=c.expressionAnchor,b=state.books.find(b=>b.id===c.bookId);if(!b||a.bookId!==b.id||!bookVersionAllowsRange(b,a.version,a)||!Number.isSafeInteger(a.start)||!Number.isSafeInteger(a.end)||a.end<=a.start||a.start<0||a.quote!==b.text?.slice(a.start,a.end)||await hashText(a.quote)!==a.hash||!covers(c.evidence,a))throw Error('即时表达原段锚点无效');}
    if(c.presentation!=='paragraph'){if(c.anchor!==undefined)throw Error('段落锚点须属于伙伴段评');continue;}
    const a=c.anchor,b=state.books.find(b=>b.id===c.bookId);
    if(c.futureGrant||!a||!b||a.bookId!==b.id||!bookVersionAllowsRange(b,a.version,a)||!Number.isSafeInteger(a.start)||!Number.isSafeInteger(a.end)||a.start<0||a.end<=a.start||typeof a.quote!=='string'||a.quote.length!==a.end-a.start||b.text?.slice(a.start,a.end)!==a.quote||await hashText(a.quote)!==a.hash||!covers(c.evidence,a)||!Array.isArray(c.formationRanges)||c.formationRanges.some(r=>!r||!Number.isSafeInteger(r.start)||!Number.isSafeInteger(r.end)||r.start<0||r.end<=r.start||!covers(c.evidence,r))||!Number.isSafeInteger(c.formedThrough)||c.formedThrough!<0||c.formedThrough!>b.text!.length)throw Error('伙伴段评锚点或形成来源与原文不符');
    // Deleted parents remain unavailable; surviving thread links cannot change
    // author, book or original paragraph. A removed parent need not be recreated.
    for(const id of new Set([c.replyTo,c.paragraphCommentId].filter((v):v is string=>!!v))){
      const parent=state.chats.find(p=>p.id===id);
      if(id===c.id||parent&&(parent.presentation!=='paragraph'||parent.bookId!==c.bookId||parent.partnerId!==c.partnerId||!parent.anchor||!bookVersionAllowsRange(b,parent.anchor.version,parent.anchor)||parent.anchor.start!==a.start||parent.anchor.end!==a.end))throw Error('段评回复串与原段落不一致');
      const seen=new Set([c.id]);let next=parent;while(next){if(seen.has(next.id))throw Error('段评回复串存在循环');seen.add(next.id);next=state.chats.find(p=>p.id===next!.replyTo);}
    }
  }
}
export const paragraphExpressionPolicy='私人完整认识由documents/thoughts保存，不自动对读者播报；即时表达用reaction:{text}；需要引用时附sourceId与逐字quote绑定实际原段，或reaction:{comment:"cN"}分享同包段评；原文旁注用paragraphComments[{sourceId,quote,text}]。三种去向分别按需选择，可全无表达且documents=[]安静完成。同次判断可发表独立即时发言和段评，内容可以不同；两处分享同一条段评时用reaction:{comment:"cN"}明确引用并复用原话，不另写一份text。段落可从本次实际供入的任意p中选择，不要求选最后一段；预读依赖全部实际读到后才可发表。段评是伙伴留下的表达，不代表用户看过、说过或同意；只有实际点击或提问才是交流。锚点只引用本轮实际p原文，逐字quote须唯一。安静时仍可留非弹出段评，但不即时说话。主动表达可自然引出具体话题或疑问，不催促或要求用户立即回应。同包自然content不作为即时表达，表达须走明确字段；不将私人分析改成发言。';

export type ExpressionPublicationReceipt={saved:boolean;status?:NonNullable<Chat['publication']>['status'];destination?:'chat'|'paragraph';reason?:string;retainedOriginal?:boolean};
export type ExpressionDeliveryReport={paragraphComments:({index:number;id?:string}&ExpressionPublicationReceipt)[];reaction?:{delivered:boolean;chatId?:string}&Partial<ExpressionPublicationReceipt>};
/** This projection validates private understanding independently; the untouched
 * complete original remains in its paid receipt and expression delivery audit. */
export function understandingCarrier(value:unknown):unknown{if(!value||typeof value!=='object'||Array.isArray(value))return value;const copy={...(value as Record<string,unknown>)};delete copy.paragraphComments;delete copy.reaction;return copy;}
