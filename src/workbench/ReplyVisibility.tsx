import {useEffect,useRef} from 'react';
import type {WorkbenchClient,WorkbenchParagraphComment} from './contract.ts';
import {observeReplyVisibility,visibleReplyRange} from './reply-visibility.ts';
import type {Chat} from '../core/types.ts';
import {bookVersionAllowsRange} from '../core/book-versions.ts';
import {MarkdownMessage} from './MarkdownMessage.tsx';

export function ReplyVisibility({chatId,client,text,visible,confirmed,recordTiming=true,paragraphComment,message}:{chatId:string;client:WorkbenchClient;text:string;visible:boolean;confirmed:boolean;recordTiming?:boolean;paragraphComment?:WorkbenchParagraphComment;message?:Pick<Chat,'id'|'bookId'|'role'|'presentationReceipt'>}){
  const content=useRef<HTMLDivElement>(null),recorded=useRef({chatId,timing:confirmed,seen:false});
  const paragraph=useRef(paragraphComment);paragraph.current=paragraphComment;
  const supplied=useRef(message);supplied.current=message;
  useEffect(()=>{
    if(recorded.current.chatId!==chatId)recorded.current={chatId,timing:confirmed,seen:false};
    if(confirmed)recorded.current.timing=true;
    const element=content.current,scroller=element?.closest<HTMLElement>('.companion-conversation,.inline-note-content,.drawer-content');
    if(!visible||!element||!scroller||!text.trim())return;
    const currentTarget=()=>{
      const snapshot=client.getSnapshot(),comment=paragraph.current;
      if(comment){
        const book=snapshot.book;
        if(comment.id!==chatId||!book||comment.anchor.bookId!==book.id||!bookVersionAllowsRange(book,comment.anchor.version,comment.anchor))return;
        // This view was validated by listParagraphComments. The write command
        // checks its current source, partner and publication again on the host.
        return {bookId:book.id,role:comment.role,presentationReceipt:comment.presentationReceipt};
      }
      const chat=snapshot.app.state.chats.find(item=>item.id===chatId)??supplied.current;
      if(!chat||chat.id!==chatId||chat.bookId!==snapshot.book?.id)return;
      // Recent and explicitly paged rows are human-visible history. The host
      // remains responsible for the write's current publication/alias authority.
      return{bookId:chat.bookId,role:chat.role,presentationReceipt:chat.presentationReceipt};
    };
    if(currentTarget()?.presentationReceipt?.seenAt!==undefined)recorded.current.seen=true;
    if(recorded.current.seen&&(!recordTiming||recorded.current.timing))return;
    let frame=0;
    const observation=observeReplyVisibility({measure:()=>visibleReplyRange(element,scroller,text),record:async range=>{
      const target=currentTarget();if(!target||target.role!=='assistant')return false;
      if(!recorded.current.seen){await client.recordMessagePresentation(target.bookId,chatId,'seen');recorded.current.seen=true;}
      if(recordTiming&&!recorded.current.timing){const accepted=await client.recordVisible(chatId,range.start,range.end);if(accepted)recorded.current.timing=true;}
      return recorded.current.seen&&(!recordTiming||recorded.current.timing);
    },schedule:callback=>setTimeout(callback,1500),cancel:handle=>clearTimeout(handle as ReturnType<typeof setTimeout>)});
    const check=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(observation.check);};
    const intersection=new IntersectionObserver(check,{root:scroller,threshold:0}),resize=new ResizeObserver(check);
    intersection.observe(element);resize.observe(element);resize.observe(scroller);
    scroller.addEventListener('scroll',check);window.addEventListener('resize',check);window.addEventListener('scroll',check,true);window.addEventListener('focus',check);document.addEventListener('visibilitychange',check);check();
    return()=>{observation.stop();cancelAnimationFrame(frame);intersection.disconnect();resize.disconnect();scroller.removeEventListener('scroll',check);window.removeEventListener('resize',check);window.removeEventListener('scroll',check,true);window.removeEventListener('focus',check);document.removeEventListener('visibilitychange',check);};
  },[chatId,client,text,visible,confirmed,recordTiming,paragraphComment?.anchor.bookId,paragraphComment?.presentationReceipt?.seenAt]);
  return <div ref={content} data-reply-text={chatId}><MarkdownMessage text={text}/></div>;
}
