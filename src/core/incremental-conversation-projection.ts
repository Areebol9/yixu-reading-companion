import type {Chat,State,StateChangeSet} from './types.ts';
import {ConversationMessageProjection,conversationMessageRecentSize,type ConversationMessageView,type ConversationMessageWindow,type ConversationMessageStatistics} from './conversation-messages.ts';
import {chatBelongsToPartner,conversationBelongsToPartner} from './discussion-recall.ts';
import {chatSummary} from './ui-records.ts';
import {recordIndex} from './record-arrays.ts';

/** Read model only: committed chat identities, positions and conversation windows.
 * It never accepts writes or decides business completion. */
export class IncrementalConversationProjection{
  private source?:State;
  private value?:ReturnType<ConversationMessageProjection['read']>;
  private index=new Map<string,Chat>();
  private positions=new Map<string,number>();
  private groups=new Map<string,Map<string,Chat>>();
  private windows=new Map<string,ConversationMessageWindow>();
  private visible=new Map<string,ConversationMessageView[]>();
  private counts=new Map<string,ConversationMessageStatistics['byBookPartner'][number]>();
  private chatCount=0;
  private count(chat:Chat,direction:number){
    if(chat.presentation==='paragraph')return;this.chatCount+=direction;
    if(chat.partnerId&&chat.role==='assistant'&&!chat.excluded&&(!chat.readingReaction||chat.readingReaction.status==='delivered')){const key=JSON.stringify([chat.bookId,chat.partnerId]),value=this.counts.get(key)??{bookId:chat.bookId,partnerId:chat.partnerId,assistantCount:0};this.counts.set(key,{...value,assistantCount:value.assistantCount+direction});}
  }
  read(state:State,changes?:StateChangeSet):ReturnType<ConversationMessageProjection['read']>{
    const before=this.source;
    const reset=!before||!changes&&before.chats!==state.chats||before.partnerId!==state.partnerId||before.partners!==state.partners||before.books.length!==state.books.length||before.books.some((book,index)=>book.id!==state.books[index]?.id)||before.conversations!==state.conversations;
    if(!reset&&before.chats===state.chats&&before.queryCheckpoints===state.queryCheckpoints)return this.value!;
    const affected=new Set<string>(),historyChanges=new Map<string,Set<string>>();
    if(reset){this.index.clear();this.positions.clear();this.groups.clear();this.windows.clear();this.visible.clear();this.counts.clear();this.chatCount=0;for(const [position,chat]of state.chats.entries()){this.index.set(chat.id,chat);this.positions.set(chat.id,position);this.count(chat,1);let group=this.groups.get(chat.sessionId);if(!group)this.groups.set(chat.sessionId,group=new Map());group.set(chat.id,chat);}for(const conversation of state.conversations)affected.add(conversation.id);}
    else{
      const change=changes?.collections.chats;
      if(change?.remove?.length)this.positions=new Map(state.chats.map((chat,position)=>[chat.id,position]));
      const committedPositions=recordIndex(state.chats,'chats',chat=>chat.id),put=(change?.put??[]).flatMap(chat=>{const position=committedPositions.get(chat.id);return position===undefined?[]:[state.chats[position]];});
      const replacements=new Map(put.map(chat=>[chat.id,chat]));
      for(const id of new Set([...(change?.remove??[]),...(change?.put??[]).map(chat=>chat.id)])){const prior=this.index.get(id);if(!prior)continue;const next=replacements.get(id);if(!next||['text','bookId','partnerId','sessionId','excluded','presentation','delivery','futureGrant','emojiReactions','sharedChatId'].some(key=>prior[key as keyof Chat]!==next[key as keyof Chat])||prior.publication?.status!==next.publication?.status||prior.readingReaction?.status!==next.readingReaction?.status){let ids=historyChanges.get(prior.sessionId);if(!ids)historyChanges.set(prior.sessionId,ids=new Set());ids.add(id);}affected.add(prior.sessionId);this.count(prior,-1);this.groups.get(prior.sessionId)?.delete(id);this.index.delete(id);if(prior.sharedChatId){const shared=this.index.get(prior.sharedChatId);if(shared)affected.add(shared.sessionId);}}
      for(const chat of put){this.index.set(chat.id,chat);if(!this.positions.has(chat.id))this.positions.set(chat.id,committedPositions.get(chat.id)!);this.count(chat,1);affected.add(chat.sessionId);let group=this.groups.get(chat.sessionId);if(!group)this.groups.set(chat.sessionId,group=new Map());group.set(chat.id,chat);if(chat.sharedChatId){const shared=this.index.get(chat.sharedChatId);if(shared)affected.add(shared.sessionId);}}
      if(before.queryCheckpoints!==state.queryCheckpoints)for(const query of [...before.queryCheckpoints??[],...state.queryCheckpoints??[]]){const chat=this.index.get(query.questionId);if(chat)affected.add(chat.sessionId);}
    }
    const pending=new Set((state.queryCheckpoints??[]).filter(query=>query.status!=='consumed').map(query=>query.questionId));
    for(const id of affected){
      const conversation=state.conversations.find(item=>item.id===id);if(!conversation||!conversationBelongsToPartner(state,conversation)){this.windows.delete(id);this.visible.delete(id);continue;}
      const group=[...(this.groups.get(id)?.values()??[])].filter(chat=>state.books.some(book=>book.id===chat.bookId)&&chatBelongsToPartner(state,chat)&&chat.presentation!=='paragraph'&&!chat.excluded&&(!chat.publication||chat.publication.status==='published')&&(!chat.readingReaction||chat.readingReaction.status==='delivered')).sort((a,b)=>this.positions.get(a.id)!-this.positions.get(b.id)!);
      const recent=group.slice(-conversationMessageRecentSize),selected=new Set(recent.map(chat=>chat.id)),prior=this.windows.get(id);
      for(const chat of group)if(chat.delivery==='pending'||pending.has(chat.id))selected.add(chat.id);
      const changedHistory=!reset&&[...historyChanges.get(id)??[]].some(chatId=>!selected.has(chatId));
      this.windows.set(id,{bookId:conversation.bookId,conversationId:id,...(recent[0]?{beforeId:recent[0].id}:{}),hasEarlier:group.length>recent.length,historyRevision:(prior?.historyRevision??0)+(changedHistory?1:0),messageCount:group.length,assistantCount:group.filter(chat=>chat.role==='assistant').length});
      this.visible.set(id,group.filter(chat=>selected.has(chat.id)).map(chat=>{const original=chat.paragraphCommentId?this.index.get(chat.paragraphCommentId):undefined;return{...chatSummary(chat),displayOrder:this.positions.get(chat.id)!,...(original?.presentation==='paragraph'&&original.sharedChatId===chat.id&&original.role===chat.role&&original.partnerId===chat.partnerId&&original.text===chat.text?{emojiReactions:original.emojiReactions,presentationReceipt:original.presentationReceipt}:{})};}));
    }
    this.source=state;
    return this.value={chats:[...this.visible.values()].flat().sort((a,b)=>a.displayOrder-b.displayOrder),conversationMessages:[...this.windows.values()],conversationStatistics:{chatCount:this.chatCount,byBookPartner:[...this.counts.values()].filter(value=>value.assistantCount>0)}};
  }
}
