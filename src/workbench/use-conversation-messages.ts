import {useEffect,useMemo,useRef,useState} from 'react';
import type {WorkbenchClient,WorkbenchSnapshot} from './contract.ts';
import type {ConversationMessageQuery,ConversationMessageView} from '../core/conversation-messages.ts';

type History={scope:string;revision:number;messages:ConversationMessageView[];retained:boolean;hasEarlier:boolean;loading:boolean;error:string};
const ordered=(rows:ConversationMessageView[])=>[...new Map(rows.map(row=>[row.id,row])).values()].sort((a,b)=>a.displayOrder-b.displayOrder||a.id.localeCompare(b.id));
const empty=(scope:string,revision:number):History=>({scope,revision,messages:[],retained:false,hasEarlier:false,loading:false,error:''});

/** Recent messages stay live; browsing history fixes one contiguous window until returning to latest. */
export function useConversationMessages(client:WorkbenchClient,snapshot:WorkbenchSnapshot,conversationId:string|undefined,aroundId:string|undefined,visible:boolean){
  const bookId=snapshot.book?.id,scope=JSON.stringify([snapshot.sessionId,bookId,snapshot.app.state.partnerId,conversationId]);
  const window=snapshot.app.conversationMessages?.find(item=>item.conversationId===conversationId&&item.bookId===bookId),revision=window?.historyRevision??0;
  const live=useMemo(()=>{
    const rows=snapshot.app.state.chats.filter(chat=>chat.bookId===bookId&&chat.sessionId===conversationId&&chat.presentation!=='paragraph'&&!chat.excluded) as ConversationMessageView[];
    const first=rows.find(chat=>chat.id===window?.beforeId);
    return first?rows.filter(chat=>chat.displayOrder>=first.displayOrder):rows;
  },[snapshot.app.state.chats,bookId,conversationId,window?.beforeId]);
  const [history,setHistory]=useState<History>(()=>empty('',0));
  const retained=history.scope===scope&&history.retained;
  const messages=useMemo(()=>{
    if(!retained)return live;
    const updates=new Map(snapshot.app.state.chats.map(chat=>[chat.id,chat as ConversationMessageView]));
    const previous=history.messages.map(message=>updates.get(message.id)??message),tail=previous.at(-1)?.id;
    // A shared boundary proves continuity. Keep the streamed answer when it becomes
    // a saved message; never join across a missing page or grow hidden history.
    return visible&&tail&&live.some(message=>message.id===tail)?ordered([...previous,...live]):previous;
  },[retained,history.messages,live,snapshot.app.state.chats,visible]);
  const latestId=live.at(-1)?.id,detached=retained&&!!latestId&&!messages.some(message=>message.id===latestId);
  useEffect(()=>{
    if(visible&&retained&&messages.length>history.messages.length)setHistory(previous=>previous.scope===scope?{...previous,messages}:previous);
  },[visible,retained,messages,scope]);
  const current=useRef({scope,revision,bookId,conversationId,messages,history});current.current={scope,revision,bookId,conversationId,messages,history};
  const sequence=useRef(0),loading=useRef<{scope:string;id:number}|undefined>(undefined),lastQuery=useRef<ConversationMessageQuery|undefined>(undefined);
  const read=async(query:ConversationMessageQuery)=>{
    const captured=current.current;if(!captured.bookId||!captured.conversationId)return;
    // Repeated scroll events share one read. Explicit old-target navigation may supersede it.
    if(loading.current?.scope===captured.scope&&!query.aroundId)return;
    const request={scope:captured.scope,id:++sequence.current};loading.current=request;lastQuery.current=query;
    setHistory(previous=>({...((previous.scope===captured.scope)?previous:empty(captured.scope,captured.revision)),retained:true,messages:captured.messages,hasEarlier:previous.scope===captured.scope&&previous.retained?previous.hasEarlier:window?.hasEarlier??false,loading:true,error:''}));
    try{
      const page=await client.listConversationMessages(captured.bookId,query);
      if(current.current.scope!==captured.scope||loading.current!==request)return;
      const latest=current.current;
      const rows=query.aroundId||query.ids?page.messages:ordered([...page.messages,...latest.messages]);
      setHistory({scope:captured.scope,revision:captured.revision,messages:rows,retained:true,hasEarlier:page.hasEarlier,loading:false,error:''});
    }catch(error){
      if(current.current.scope===captured.scope&&loading.current===request)setHistory(previous=>({...previous,loading:false,error:error instanceof Error?error.message:'历史交流暂时未能读取'}));
    }finally{if(loading.current===request)loading.current=undefined;}
  };
  useEffect(()=>{
    if(current.current.history.scope!==scope){lastQuery.current=undefined;setHistory(empty(scope,revision));}
  },[scope]);
  useEffect(()=>{
    const captured=current.current;
    if(visible&&bookId&&conversationId&&captured.history.scope===scope&&captured.history.messages.length&&captured.history.revision!==revision&&!captured.history.loading&&!captured.history.error)
      void read({conversationId,ids:captured.messages.map(message=>message.id)});
  },[client,scope,revision,history.revision,history.loading,visible]);
  useEffect(()=>{if(visible&&aroundId&&conversationId&&!messages.some(message=>message.id===aroundId))void read({conversationId,aroundId});},[aroundId,scope,visible]);
  const retain=()=>{const captured=current.current;if(captured.messages.length&&!retained)setHistory(previous=>({...empty(scope,revision),...(previous.scope===scope?previous:{}),retained:true,messages:captured.messages,hasEarlier:window?.hasEarlier??false}));};
  return{messages,retained,detached,retain,hasNewer:detached,hasEarlier:retained?history.hasEarlier:window?.hasEarlier??false,loading:history.scope===scope&&history.loading,error:history.scope===scope?history.error:'',loadEarlier:()=>read({conversationId,beforeId:messages[0]?.id}),retry:()=>read(lastQuery.current??{conversationId,beforeId:messages[0]?.id}),showLatest:()=>{loading.current=undefined;lastQuery.current=undefined;setHistory(empty(scope,revision));}};
}
