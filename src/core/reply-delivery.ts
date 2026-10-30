import {chatBelongsToPartner} from './discussion-recall.ts';
import {isEvidenceAllowed} from './context.ts';
import type {Book,Chat,ReadingReply,State} from './types.ts';

// Reuse the existing product notice; no model text is cut mid-claim or sentence.
export const expansionNotice='这部分值得展开讨论。可以进入详细讨论继续。';
export type ReplyStyle={targetChars:number;visibleLimit:number;expanded:boolean;quiet:boolean};

export function explicitExpansion(text:string):boolean{
  const line=text.trim().split('\n')[0];
  if(/^(?:请)?(?:不用|不要|别|不必|无需)|(?:简短|简洁|一句话|一两句|不要太长)/u.test(line))return false;
  return /^(?:(?:请|麻烦你?|能否|能不能|可以|能|帮我|我想听你)\s*)?(?:(?:详细|完整|深入)(?:地)?(?:讲|说|解释|展开|分析|梳理|比较|论证)|展开(?:一下|说说|讲讲|讨论|刚才|之前|这|吧|$))/u.test(line)||/^(?:please\s+)?(?:expand\b|explain\b.*\bin detail\b)/iu.test(line);
}

export function latestExpansionOffer(state:State,book:Book,sessionId:string):Chat|undefined{
  const eligible=state.chats.filter(c=>c.bookId===book.id&&c.sessionId===sessionId&&!c.excluded&&!c.outdatedBy&&!c.futureGrant&&chatBelongsToPartner(state,c)&&isEvidenceAllowed(book,c.evidence));
  for(let i=eligible.length-1;i>=0;i--){
    const chat=eligible[i];
    if(chat.role==='user')return;
    if(chat.expansionOffered)return chat;
  }
}

export function acceptsExpansion(text:string):boolean{return /^(?:好(?:的|啊)?|可以|行|是的|展开(?:吧)?|继续(?:吧)?)[。！!\s]*$/u.test(text.trim());}

export function replyStyle(_state:State,_source:'reading'|'conversation'|'closing',_text:string,expanded:boolean,quiet:boolean):ReplyStyle{
  return{targetChars:quiet?0:20000,visibleLimit:quiet?0:20000,expanded,quiet};
}

export function presentReply(result:Pick<ReadingReply,'reply'|'wantsLong'>,style:ReplyStyle,pendingOffer=false):{text:string;offer:boolean;replaced:boolean}|undefined{
  if(style.quiet)return;
  const text=result.reply.trim();
  if(!text)return;
  return{text,offer:!style.expanded&&!pendingOffer&&!!result.wantsLong,replaced:false};
}
