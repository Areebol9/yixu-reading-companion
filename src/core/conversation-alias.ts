import {chatAllowsMemory,isEvidenceAllowed} from './context.ts';
import {chatBelongsToPartner} from './discussion-recall.ts';
import type {Book,Chat,State} from './types.ts';

/** Only a saved publication link can establish a shared expression. A reply,
 * equal text, or a shared paragraph anchor alone does not establish an alias. */
export function conversationAliasIndex(state:State,book:Book,ids:readonly string[]):Map<string,ReadonlySet<string>>{
  const selected=new Set(ids),allowed=new Map<string,Chat>();
  for(const chat of state.chats)if(selected.has(chat.id)&&chat.bookId===book.id&&chatBelongsToPartner(state,chat)&&chatAllowsMemory(state,chat)&&!chat.excluded&&!chat.outdatedBy&&!chat.replacedBy&&!chat.futureGrant&&chat.delivery!=='pending'&&(!chat.publication||chat.publication.status==='published')&&isEvidenceAllowed(book,chat.evidence))allowed.set(chat.id,chat);
  const groups=new Map<string,Set<string>>();
  for(const paragraph of allowed.values()){
    if(paragraph.presentation!=='paragraph'||!paragraph.sharedChatId)continue;
    const shared=allowed.get(paragraph.sharedChatId);
    if(!shared||shared.id===paragraph.id||shared.presentation==='paragraph'||shared.role!==paragraph.role||shared.partnerId!==paragraph.partnerId||!paragraph.text||shared.text!==paragraph.text||shared.paragraphCommentId!==undefined&&shared.paragraphCommentId!==paragraph.id)continue;
    const group=new Set([paragraph.id,shared.id,...(groups.get(paragraph.id)??[]),...(groups.get(shared.id)??[])]);
    for(const id of group)groups.set(id,group);
  }
  return groups;
}

/** Body references are request-local projections. They never replace either
 * saved event or claim that a reader opened, agreed with, or replied to it. */
export function conversationBodyReferences(state:State,book:Book,chats:readonly Chat[]):Map<string,string>{
  const groups=conversationAliasIndex(state,book,chats.map(chat=>chat.id)),first=new Map<string,string>(),references=new Map<string,string>();
  for(const chat of chats){
    const group=groups.get(chat.id),saved=state.chats.find(item=>item.id===chat.id);
    if(!group||saved?.text!==chat.text||saved.role!==chat.role)continue;
    const previous=[...group].map(id=>first.get(id)).find((id):id is string=>!!id);
    if(previous&&previous!==chat.id)references.set(chat.id,previous);
    else for(const id of group)first.set(id,chat.id);
  }
  return references;
}
