import {chatBelongsToPartner} from './discussion-recall.ts';
import {paragraphCommentAllowed} from './paragraph-comments.ts';
import type {Book,Chat,PartnerPersonaSnapshot,State} from './types.ts';

/** Only the original invitation can adopt an automatic reply to that target.
 * A separate question about a comment retains its own wording and answer. */
export function automaticParagraphReplyTarget(state:State,book:Book,candidate:Chat,targetIds:readonly string[]=[]):Chat|undefined{
  if(targetIds.length!==1||candidate.presentation!=='paragraph'||!candidate.anchor)return;
  const target=state.chats.find(chat=>chat.id===targetIds[0]);
  if(!target||target.role!=='user'||target.presentation!=='paragraph'||!paragraphCommentAllowed(state,book,target)||!chatBelongsToPartner(state,candidate)||target.memoryAllowed===false)return;
  if(candidate.anchor.start<target.anchor!.start||candidate.anchor.end>target.anchor!.end||candidate.anchor.version!==target.anchor!.version||!candidate.contextChatIds?.includes(target.id))return;
  return target;
}

/** Compare the frozen execution conditions, not the mutable service name. */
export function sameReplyPersona(a:PartnerPersonaSnapshot|undefined,b:PartnerPersonaSnapshot):boolean{
  return !!a&&a.partnerId===b.partnerId&&a.personaVersionId===b.personaVersionId&&a.language===b.language&&JSON.stringify(a.modelService)===JSON.stringify(b.modelService);
}
