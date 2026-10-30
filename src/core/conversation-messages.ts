import {chatBelongsToPartner,conversationBelongsToPartner} from './discussion-recall.ts';
import type {Chat,State} from './types.ts';
import {chatSummary,type ChatSummary} from './ui-records.ts';

/** A renderer page size, independent of model capacity and native log segments. */
export const conversationMessagePageSize=80;
/** Initial UI payload only; model material and historical page capacity are unchanged. */
export const conversationMessageRecentSize=24;
export type ConversationMessageView=ChatSummary&{displayOrder:number};
export type ConversationMessageQuery={conversationId?:string;beforeId?:string;aroundId?:string;limit?:number;ids?:string[]};
export type ConversationMessagePage={conversationId:string;messages:ConversationMessageView[];beforeId?:string;hasEarlier:boolean};
export type ConversationMessageWindow={bookId:string;conversationId:string;beforeId?:string;hasEarlier:boolean;historyRevision:number;messageCount:number;assistantCount:number};
/** Counts use complete source records, independently of the live message window. */
export type ConversationMessageStatistics={chatCount:number;byBookPartner:{bookId:string;partnerId:string;assistantCount:number}[]};

export function parseConversationMessageQuery(value:unknown={}):ConversationMessageQuery{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('交流分页参数无效');
  const query=value as ConversationMessageQuery;
  if(Object.keys(query).some(key=>!['conversationId','beforeId','aroundId','limit','ids'].includes(key))||['conversationId','beforeId','aroundId'].some(key=>{const item=query[key as keyof ConversationMessageQuery];return item!==undefined&&(typeof item!=='string'||!item||item.length>256);})||query.limit!==undefined&&(!Number.isSafeInteger(query.limit)||query.limit<1||query.limit>conversationMessagePageSize)||!query.conversationId&&!query.aroundId||query.beforeId!==undefined&&query.aroundId!==undefined||query.ids!==undefined&&(!Array.isArray(query.ids)||!query.ids.length||query.ids.some(id=>typeof id!=='string'||!id||id.length>256)||new Set(query.ids).size!==query.ids.length||!query.conversationId||query.beforeId!==undefined||query.aroundId!==undefined||query.limit!==undefined))throw Error('交流分页须指定实际对话及消息游标');
  return query;
}
function displayed(state:State,chat:Chat):boolean{
  const book=state.books.find(book=>book.id===chat.bookId);
  return !!book&&chatBelongsToPartner(state,chat)&&chat.presentation!=='paragraph'&&!chat.excluded&&(!chat.publication||chat.publication.status==='published')&&(!chat.readingReaction||chat.readingReaction.status==='delivered');
}
/** Shares retain one visible chat identity and use the original comment's reactions. */
function messageView(chat:Chat,index:Map<string,Chat>,displayOrder:number):ConversationMessageView{
  const original=chat.paragraphCommentId?index.get(chat.paragraphCommentId):undefined;
  return{...chatSummary(chat),displayOrder,...(original?.presentation==='paragraph'&&original.sharedChatId===chat.id&&original.role===chat.role&&original.partnerId===chat.partnerId&&original.text===chat.text?{emojiReactions:original.emojiReactions,presentationReceipt:original.presentationReceipt}:{})};
}
export function listConversationMessages(state:State,bookId:string,raw:ConversationMessageQuery):ConversationMessagePage{
  const query=parseConversationMessageQuery(raw),target=query.aroundId?state.chats.find(chat=>chat.id===query.aroundId&&chat.bookId===bookId&&chatBelongsToPartner(state,chat)):undefined;
  const conversationId=query.conversationId??target?.sessionId,conversation=state.conversations.find(item=>item.id===conversationId&&item.bookId===bookId&&conversationBelongsToPartner(state,item));
  if(!conversation||query.aroundId&&(!target||target.sessionId!==conversation.id||!displayed(state,target)))throw Error('这段交流已不在当前作品和伙伴的可查看范围内');
  const all=state.chats.filter(chat=>chat.bookId===bookId&&chat.sessionId===conversation.id&&chatBelongsToPartner(state,chat)),cursor=query.beforeId??query.aroundId;
  const boundary=cursor===undefined?all.length:all.findIndex(chat=>chat.id===cursor);
  if(boundary<0)throw Error('原交流游标已变化，请重新打开这段交流');
  const limit=query.limit??conversationMessagePageSize,allowed=all.filter(chat=>displayed(state,chat));
  let selected:Chat[];
  if(query.ids){const ids=new Set(query.ids);selected=allowed.filter(chat=>ids.has(chat.id));}
  else if(query.aroundId){const at=allowed.findIndex(chat=>chat.id===query.aroundId),start=Math.max(0,at-Math.floor(limit/2));selected=allowed.slice(start,start+limit);}
  else{const earlier=new Set(all.slice(0,boundary).map(chat=>chat.id));selected=allowed.filter(chat=>earlier.has(chat.id)).slice(-limit);}
  const first=selected[0],hasEarlier=!!first&&allowed.findIndex(chat=>chat.id===first.id)>0,index=new Map(state.chats.map(chat=>[chat.id,chat])),positions=new Map(state.chats.map((chat,position)=>[chat.id,position]));
  return{conversationId:conversation.id,messages:selected.map(chat=>messageView(chat,index,positions.get(chat.id)!)),...(first?{beforeId:first.id}:{}),hasEarlier};
}

/** Presentation cache only. It keeps record references/IDs, never copied historical prose. */
export class ConversationMessageProjection{
  private inputs?:unknown[];
  private value?:{chats:ConversationMessageView[];conversationMessages:ConversationMessageWindow[];conversationStatistics:ConversationMessageStatistics};
  private records=new Map<string,unknown[]>();
  private views=new WeakMap<Chat,ConversationMessageView>();
  private revisions=new Map<string,number>();
  read(state:State,immutable=true){
    const inputs=[state.chats,state.books,state.conversations,state.partners,state.partnerId,state.forgotten,state.queryCheckpoints];
    if(immutable&&this.inputs&&inputs.every((value,index)=>value===this.inputs![index]))return this.value!;
    const index=new Map(state.chats.map(chat=>[chat.id,chat])),groups=new Map<string,Chat[]>(),selected=new Set<string>(),windows:ConversationMessageWindow[]=[];
    const conversations=state.conversations.filter(conversation=>conversationBelongsToPartner(state,conversation)),ids=new Set(conversations.map(conversation=>conversation.id));
    let chatCount=0;const byBookPartner=new Map<string,ConversationMessageStatistics['byBookPartner'][number]>();
    for(const chat of state.chats){
      if(chat.presentation!=='paragraph'){
        chatCount++;
        if(chat.partnerId&&chat.role==='assistant'&&!chat.excluded&&(!chat.readingReaction||chat.readingReaction.status==='delivered')){const key=JSON.stringify([chat.bookId,chat.partnerId]),count=byBookPartner.get(key)??{bookId:chat.bookId,partnerId:chat.partnerId,assistantCount:0};count.assistantCount++;byBookPartner.set(key,count);}
      }
      if(ids.has(chat.sessionId)&&displayed(state,chat)){let group=groups.get(chat.sessionId);if(!group)groups.set(chat.sessionId,group=[]);group.push(chat);}
    }
    for(const conversation of conversations){const group=groups.get(conversation.id)??[],recent=group.slice(-conversationMessageRecentSize);for(const chat of recent)selected.add(chat.id);windows.push({bookId:conversation.bookId,conversationId:conversation.id,...(recent[0]?{beforeId:recent[0].id}:{}),hasEarlier:group.length>recent.length,historyRevision:0,messageCount:group.length,assistantCount:group.filter(chat=>chat.role==='assistant').length});}
    const pending=new Set((state.queryCheckpoints??[]).filter(query=>query.status!=='consumed').map(query=>query.questionId));
    for(const chat of state.chats)if((chat.delivery==='pending'||pending.has(chat.id))&&ids.has(chat.sessionId)&&displayed(state,chat))selected.add(chat.id);
    const changed=new Set<string>();
    const next=new Map<string,unknown[]>();
    for(const chat of state.chats){
      const before=this.records.get(chat.id),value=[chat.text,chat.bookId,chat.partnerId,chat.sessionId,chat.excluded,chat.presentation,chat.delivery,chat.futureGrant,chat.publication?.status,chat.readingReaction?.status,chat.emojiReactions,chat.sharedChatId];next.set(chat.id,value);
      if(before&&!selected.has(chat.id)&&value.some((item,position)=>item!==before[position])){changed.add(chat.sessionId);const shared=chat.sharedChatId?index.get(chat.sharedChatId):undefined;if(shared)changed.add(shared.sessionId);}
    }
    for(const [id,value]of this.records)if(!next.has(id))changed.add(String(value[3]));
    for(const id of changed)this.revisions.set(id,(this.revisions.get(id)??0)+1);
    for(const window of windows)window.historyRevision=this.revisions.get(window.conversationId)??0;
    this.records=next;this.inputs=inputs;
    return this.value={chats:state.chats.flatMap((chat,position)=>{if(!selected.has(chat.id))return[];const view=messageView(chat,index,position),previous=immutable?this.views.get(chat):undefined;if(previous&&previous.displayOrder===view.displayOrder&&previous.emojiReactions===view.emojiReactions&&previous.presentationReceipt===view.presentationReceipt)return[previous];if(immutable)this.views.set(chat,view);return[view];}),conversationMessages:windows,conversationStatistics:{chatCount,byBookPartner:[...byBookPartner.values()]}};
  }
}
