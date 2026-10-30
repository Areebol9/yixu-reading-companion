import type {Book,Chat,MessageEmojiReaction,State} from './types.ts';
import {isEvidenceAllowed,memoryIsForgotten} from './context.ts';
import {chatBelongsToPartner} from './discussion-recall.ts';
import {paragraphCommentAllowed} from './paragraph-comments.ts';

export const localReaderActorId='local-reader';
export type MessageReactionActor=Pick<MessageEmojiReaction,'actor'|'actorId'>;

const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});
const emojiAtom='(?:\\p{Emoji_Modifier_Base}\\uFE0F?\\p{Emoji_Modifier}?|\\p{Extended_Pictographic}\\uFE0F?)';
const emojiSequence=new RegExp(`^(?:${emojiAtom}(?:\\u200D${emojiAtom})*|\\p{Regional_Indicator}{2}|[0-9#*]\\uFE0F?\\u20E3|\\u{1F3F4}[\\u{E0020}-\\u{E007E}]+\\u{E007F})$`,'u');

/** Preserve the exact grapheme, including skin tone and joined sequences. */
export function isSingleEmoji(value:unknown):value is string{
  return typeof value==='string'&&value.length>0&&value.length<=64&&[...segmenter.segment(value)].length===1&&emojiSequence.test(value);
}
export function isEmojiOnlyText(value:string):boolean{
  const parts=[...segmenter.segment(value.trim())].map(item=>item.segment).filter(item=>item.trim());
  return parts.length>0&&parts.every(isSingleEmoji);
}
function messageAllowed(state:State,book:Book,chat:Chat):boolean{
  if(chat.bookId!==book.id||!chatBelongsToPartner(state,chat)||!['user','assistant'].includes(chat.role)||!chat.text.trim()||chat.excluded||chat.futureGrant||chat.role==='assistant'&&chat.delivery==='pending'||chat.publication&&chat.publication.status!=='published')return false;
  if(chat.presentation==='paragraph')return paragraphCommentAllowed(state,book,chat);
  return isEvidenceAllowed(book,chat.evidence)&&!(chat.memoryIds??[]).some(id=>{const memory=state.memories.find(item=>item.id===id);return!memory||memoryIsForgotten(state,memory);})&&![...(chat.contextChatIds??[]),...(chat.historicalCommentIds??[])].some(id=>{const source=state.chats.find(item=>item.id===id);return!source||source.excluded;});
}
/** Only an explicit, reciprocal publication link aliases an original comment.
 * A reply's paragraphCommentId is context and must remain its own target. */
export function resolveMessageEmojiReactionTarget(state:State,bookId:string,targetId:string):Chat{
  const book=state.books.find(item=>item.id===bookId),message=state.chats.find(item=>item.id===targetId);
  if(!book||!message||!messageAllowed(state,book,message))throw Error('这条消息已不在当前作品、伙伴或阅读许可内');
  if(message.presentation!=='paragraph'&&message.paragraphCommentId){
    const source=state.chats.find(item=>item.id===message.paragraphCommentId);
    if(source?.presentation==='paragraph'&&source.sharedChatId===message.id){
      if(source.role!==message.role||source.partnerId!==message.partnerId||source.text!==message.text||!messageAllowed(state,book,source))throw Error('这条分享与原段评已不一致');
      return source;
    }
  }
  return message;
}
export function messageEmojiReactionTargetIds(state:State,bookId:string,targetId:string):string[]{return[resolveMessageEmojiReactionTarget(state,bookId,targetId).id];}

/** Trusted core helper. Public application commands always supply the local reader. */
export function applyMessageEmojiReaction(state:State,bookId:string,targetId:string,actor:MessageReactionActor,emoji:string,active:boolean,now=Date.now()):boolean{
  if(!actor||Object.keys(actor).some(key=>!['actor','actorId'].includes(key))||actor.actor==='user'&&actor.actorId!==localReaderActorId||actor.actor==='partner'&&(actor.actorId!==state.partnerId||!state.partners.some(partner=>partner.id===actor.actorId))||!['user','partner'].includes(actor.actor))throw Error('表情回应的作者无效');
  if(!isSingleEmoji(emoji)||typeof active!=='boolean'||!Number.isSafeInteger(now)||now<0)throw Error('请选择一个有效表情和回应状态');
  const target=resolveMessageEmojiReactionTarget(state,bookId,targetId),reactions=target.emojiReactions??[];
  const matches=(reaction:MessageEmojiReaction)=>reaction.actor===actor.actor&&reaction.actorId===actor.actorId&&reaction.emoji===emoji;
  if(reactions.some(matches)===active)return false;
  const next=reactions.filter(reaction=>!matches(reaction));
  if(active)next.push({...actor,emoji,createdAt:now});
  if(next.length)target.emojiReactions=next;else delete target.emojiReactions;
  return true;
}
export function validateMessageEmojiReactions(state:State):void{
  for(const chat of state.chats){
    if(chat.presentationReceipt!==undefined){
      const receipt=chat.presentationReceipt;
      if(!receipt||typeof receipt!=='object'||Array.isArray(receipt)||chat.role!=='assistant'||Object.keys(receipt).some(key=>!['notifiedAt','seenAt','clearedAt'].includes(key))||Object.values(receipt).some(value=>!Number.isSafeInteger(value)||value<0))throw Error('伙伴消息呈现记录无效');
    }
    if(chat.emojiReactions===undefined)continue;
    if(!Array.isArray(chat.emojiReactions))throw Error('消息表情回应无效');
    const seen=new Set<string>();
    for(const reaction of chat.emojiReactions){
      if(!reaction||Object.keys(reaction).some(key=>!['actor','actorId','emoji','createdAt'].includes(key))||!['user','partner'].includes(reaction.actor)||reaction.actor==='user'&&reaction.actorId!==localReaderActorId||reaction.actor==='partner'&&(!state.partners.some(partner=>partner.id===reaction.actorId)||!!chat.partnerId&&reaction.actorId!==chat.partnerId)||!isSingleEmoji(reaction.emoji)||!Number.isSafeInteger(reaction.createdAt)||reaction.createdAt<0)throw Error('消息表情回应的作者、表情或时间无效');
      const key=JSON.stringify([reaction.actor,reaction.actorId,reaction.emoji]);if(seen.has(key))throw Error('消息表情回应重复');seen.add(key);
    }
  }
}

/** Explicit clearing changes the unread badge, not the evidence of actual viewing. */
export function hasUnreadPresentation(message:Pick<Chat,'presentationReceipt'>):boolean{return message.presentationReceipt?.seenAt===undefined&&message.presentationReceipt?.clearedAt===undefined;}
