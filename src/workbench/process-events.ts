import type { WorkbenchEvent, WorkbenchSnapshot } from './contract.ts';
export type ProcessEventGroup={event:WorkbenchEvent;count:number;firstAt:number};

/** Display grouping only; the original persisted events are never changed. */
export function groupProcessEvents(events:readonly WorkbenchEvent[]):ProcessEventGroup[]{
  const groups:ProcessEventGroup[]=[];
  const key=(event:WorkbenchEvent)=>JSON.stringify([event.kind,event.title,event.detail,event.mode,event.requestId,event.chatId,event.elapsedMs,event.readingFlow]);
  let lastKey='';
  for(let index=events.length-1;index>=0;index--){const event=events[index],nextKey=key(event),last=groups.at(-1);if(last&&nextKey===lastKey){last.count++;last.firstAt=event.at;}else groups.push({event,count:1,firstAt:event.at});lastKey=nextKey;}
  return groups;
}

export function currentProcessEvents(snapshot:WorkbenchSnapshot):WorkbenchEvent[]{
  const session=snapshot.app.session,bookId=snapshot.book?.id;
  const currentActivities=snapshot.app.activities.filter(item=>item.bookId===bookId&&!['complete','quiet','obsolete'].includes(item.stage));
  const requests=new Set(currentActivities.flatMap(item=>item.requestId?[item.requestId]:[]));
  const chats=new Set(snapshot.app.state.chats.filter(chat=>chat.bookId===bookId&&chat.sessionId===session?.id).map(chat=>chat.id));
  const conversation=snapshot.app.state.conversations.find(item=>item.id===session?.id&&item.bookId===bookId);
  const domain=snapshot.events.at(-1)?.clockDomain;
  return snapshot.events.filter(event=>!!event.requestId&&requests.has(event.requestId)||!!event.chatId&&chats.has(event.chatId)||!event.requestId&&!event.chatId&&!!conversation&&event.at>=conversation.createdAt&&event.clockDomain===domain);
}
