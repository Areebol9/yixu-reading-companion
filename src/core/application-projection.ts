import {bookLength,covers} from './books.ts';
import {currentPublishedViews,viewProgress,maintenanceProgress,createPublishedViewCheck,viewAllowed,type PublishedViewCheck} from './published-views.ts';
import {freezeData} from './application-contract.ts';
import type {ApplicationSnapshot,PublishedReplyView} from './application-contract.ts';
import type {State,StateChangeSet} from './types.ts';
import {recordIndex,inheritRecordIndexes} from './record-arrays.ts';
import {IncrementalConversationProjection} from './incremental-conversation-projection.ts';
import {memorySummary} from './ui-records.ts';
import {resolveMessageEmojiReactionTarget,hasUnreadPresentation} from './message-reactions.ts';
import {chatBelongsToPartner,conversationBelongsToPartner} from './discussion-recall.ts';
import {ordinaryReadingTask} from './terminated-reading-continuation.ts';

type Projected = Pick<ApplicationSnapshot,'state'|'questionProgress'|'readingViews'|'conversationMessages'|'conversationStatistics'|'maintenanceProgress'>;
const sameRanges=(before:State['books'][number]['known'],after:State['books'][number]['known'])=>before===after||before.length===after.length&&before.every((range,index)=>range.start===after[index].start&&range.end===after[index].end);
const sameEdition=(before:State['books'][number],after:State['books'][number])=>before.id===after.id&&before.version===after.version&&(before.sourceLineage===after.sourceLineage||JSON.stringify(before.sourceLineage)===JSON.stringify(after.sourceLineage))&&before.frontMatterEnd===after.frontMatterEnd&&before.frontMatterIncluded===after.frontMatterIncluded&&bookLength(before)===bookLength(after);
const sameReadingBoundary=(before:State['books'][number],after:State['books'][number])=>sameEdition(before,after)&&sameRanges(before.known,after.known);
const sameMaintenanceBook=(before:State['books'][number],after:State['books'][number])=>{
  if(!sameReadingBoundary(before,after)||!sameRanges(before.prepared,after.prepared))return false;
  const old=before.directory?.entries??before.chapters,next=after.directory?.entries??after.chapters;
  return old===next||old.length===next.length&&old.every((chapter,index)=>{const replacement=next[index];return chapter.start===replacement.start&&chapter.end===replacement.end&&chapter.title===replacement.title&&('kind'in chapter?chapter.kind:undefined)===('kind'in replacement?replacement.kind:undefined);});
};
const usageBook=(usage:State['usage'][number])=>usage.requestKey?ordinaryReadingTask(usage.requestKey)?.bookId:undefined;
const chatSources=new WeakMap<object,string>();
const chatSource=(chat:State['chats'][number])=>{let identity=chatSources.get(chat);if(identity===undefined){const {presentationReceipt,emojiReactions,...source}=chat;identity=JSON.stringify(source);chatSources.set(chat,identity);}return identity;};
const sameChatSource=(before:State['chats'][number],after:State['chats'][number])=>before===after||chatSource(before)===chatSource(after);


/** Input records are detached committed values: a new commit replaces records,
 * never mutates a prior one. The engine's mutable State must not use this cache. */
export class CommittedApplicationProjection {
  withdrawalsPending=false;
  private source?:State;
  private projected?:Projected;
  private visible?:Record<string,unknown>;
  private viewInputs?:unknown[];
  private views?:State['publishedViews'];
  private readingViews?:ApplicationSnapshot['readingViews'];
  private maintenance?:ApplicationSnapshot['maintenanceProgress'];
  private bookViews=new Map<string,{views:NonNullable<State['publishedViews']>;reading:NonNullable<ApplicationSnapshot['readingViews']>[number];maintenance:ApplicationSnapshot['maintenanceProgress'][number];check:PublishedViewCheck}>();
  private readonly copies=new WeakMap<object,unknown>();
  private readonly records=new WeakMap<object,unknown>();
  private readonly immediateConversation=new IncrementalConversationProjection();
  private copy<T>(value:T):T {
    if(!value||typeof value!=='object')return value;
    const prior=this.copies.get(value);if(prior!==undefined)return prior as T;
    const result=Array.isArray(value)?value.map(item=>this.copy(item)):Object.fromEntries(Object.entries(value).map(([key,item])=>[key,this.copy(item)]));
    if(Array.isArray(value))inheritRecordIndexes(value,result as unknown[]);
    Object.freeze(result);this.copies.set(value,result);return result as T;
  }
  private record<T extends object,R>(value:T,project:(value:T)=>R):R {
    const previous=this.records.get(value);if(previous!==undefined)return previous as R;
    const result=this.copy(project(value));this.records.set(value,result);return result;
  }
  private collection<T,R>(value:T[],project:(value:T)=>R):R[]{
    return this.record(value,items=>{const result=items.map(project);inheritRecordIndexes(items,result);return result;});
  }
  read(source:State):Projected {
    const steps=this.readSteps(source);let step=steps.next();while(!step.done)step=steps.next();return step.value;
  }
  /** Message delivery has no dependency on book coverage, view provenance or
   * historical activity aggregation. The changed conversations are read here. */
  readImmediate(source:State,changes?:StateChangeSet):Projected {
    const {readingDrafts,queryCheckpoints,companionReadingReceipts,companionCorrectionRepairs,agentSessions,...visible}=source;
    const conversation=this.immediateConversation.read(source,changes);
    const before=this.source;
    this.withdrawalsPending=!!before&&(before.partnerId!==source.partnerId||before.partners!==source.partners||before.forgotten!==source.forgotten||before.viewPublications!==source.viewPublications||before.books.some(book=>{const next=source.books.find(next=>next.id===book.id);return !next||!sameEdition(book,next)||!book.known.every(range=>covers(next.known,range));})||before.memories.some(memory=>{const position=recordIndex(source.memories,'memories',record=>record.id).get(memory.id);return position===undefined||source.memories[position]!==memory;}));
    return freezeData({state:this.copy({...visible,
      usage:this.collection(source.usage,item=>this.record(item,({maintenanceDispatch,agentResponse,...value})=>value)),
      publishedViews:this.withdrawalsPending?[]:this.views??[],chats:conversation.chats,
      memories:this.collection(source.memories,item=>this.record(item,memorySummary)),
      books:this.collection(source.books,item=>this.record(item,({text,residentRanges,...value})=>({...value,textLength:bookLength({text,...value})}))),
    }),conversationMessages:conversation.conversationMessages,conversationStatistics:conversation.conversationStatistics,
      questionProgress:(queryCheckpoints??[]).filter(q=>q.status!=='consumed').map(q=>({questionId:q.questionId,status:q.status,receiptPending:!!q.pendingReceipt,pendingRequestId:q.pendingReceipt?.usageId,blockedReason:q.blockedReason})),readingViews:this.readingViews??[],maintenanceProgress:this.maintenance??[]});
  }
  /** Each yield ends one book's derived work. Hosts can interleave delivery and
   * new commands instead of scheduling the old whole projection in one timer. */
  *readSteps(source:State):Generator<void,Projected> {
    if(this.source===source)return this.projected!;
    const {readingDrafts,queryCheckpoints,companionReadingReceipts,companionCorrectionRepairs,agentSessions,...visible}=source;
    if(this.visible&&this.source?.queryCheckpoints===queryCheckpoints&&Object.keys(visible).length===Object.keys(this.visible).length&&Object.entries(visible).every(([key,value])=>this.visible![key]===value)){
      this.source=source;return this.projected!;
    }
    const viewInputs=[source.books,source.memories,source.chats,source.publishedViews,source.viewPublications,source.maintenanceJobs,source.usage,source.forgotten,source.partners,source.partnerId];
    if(!this.viewInputs||viewInputs.some((value,index)=>value!==this.viewInputs![index])){
      const affected=new Set<string>();
      let boundariesChanged=false;
      if(!this.source||this.source.partnerId!==source.partnerId||this.source.partners!==source.partners||this.source.forgotten!==source.forgotten)for(const book of source.books)affected.add(book.id);
      else for(const name of ['books','memories','chats','publishedViews','viewPublications','maintenanceJobs','usage'] as const){
        const before:readonly {id:string;bookId?:string}[]=this.source[name]??[],after:readonly {id:string;bookId?:string}[]=source[name]??[];if(before===after)continue;
        const key=(record:{id:string})=>record.id,old=recordIndex(before,name,key),next=recordIndex(after,name,key);
        for(const [id,index]of old){const record=before[index]!,position=next.get(id),replacement=position===undefined?undefined:after[position];
          if(replacement===record||name==='books'&&replacement&&sameMaintenanceBook(record as State['books'][number],replacement as State['books'][number])||name==='chats'&&replacement&&sameChatSource(record as State['chats'][number],replacement as State['chats'][number]))continue;
          if(name==='usage'){const previous=record as State['usage'][number],current=replacement as State['usage'][number]|undefined;if(!previous.maintenanceDispatch&&!current?.maintenanceDispatch)continue;if(previous.maintenanceDispatch===current?.maintenanceDispatch&&previous.status===current?.status&&previous.modelOutcome===current?.modelOutcome&&previous.requestKey===current?.requestKey)continue;const oldBook=usageBook(previous),newBook=current&&usageBook(current);if(oldBook)affected.add(oldBook);if(newBook)affected.add(newBook);continue;}
          affected.add(name==='books'?record.id:record.bookId!);if(replacement)affected.add(name==='books'?replacement.id:replacement.bookId!);if(name==='books'&&(!replacement||!sameReadingBoundary(record as State['books'][number],replacement as State['books'][number])))boundariesChanged=true;
        }
        for(const [id,index]of next)if(!old.has(id)){const record=after[index]!;if(name==='usage'){const usage=record as State['usage'][number],bookId=usage.maintenanceDispatch&&usageBook(usage);if(bookId)affected.add(bookId);continue;}affected.add(name==='books'?record.id:record.bookId!);if(name==='books')boundariesChanged=true;}
      }
      // Paragraph replies can refer to a parent in another book. A permission or
      // parent change must invalidate that dependent book as well, transitively.
      if(this.source&&(this.source.chats!==source.chats||boundariesChanged)){
        const edges=new Map<string,Set<string>>();
        for(const state of [this.source,source]){
          const positions=recordIndex(state.chats,'chats',chat=>chat.id);
          for(const chat of state.chats)for(const id of [chat.replyTo,chat.paragraphCommentId]){const position=id===undefined?undefined:positions.get(id),parent=position===undefined?undefined:state.chats[position];if(parent&&parent.bookId!==chat.bookId){let children=edges.get(parent.bookId);if(!children)edges.set(parent.bookId,children=new Set());children.add(chat.bookId);}}
        }
        for(const bookId of affected)for(const child of edges.get(bookId)??[])affected.add(child);
      }
      const before=this.source;
      const chatPositions=recordIndex(source.chats,'chats',chat=>chat.id);
      const chatSourcesExpanded=!!before&&(before.chats===source.chats||before.chats.every(chat=>{const position=chatPositions.get(chat.id);return position!==undefined&&sameChatSource(chat,source.chats[position]);}));
      const grantsExpanded=!!before&&chatSourcesExpanded&&['memories','publishedViews','forgotten','partners','partnerId'].every(name=>before[name as keyof State]===source[name as keyof State])&&before.books.length===source.books.length&&before.books.every(book=>{const next=source.books.find(next=>next.id===book.id);return !!next&&sameEdition(book,next)&&book.known.every(range=>covers(next.known,range));});
      let changed=!this.views||this.source?.books.length!==source.books.length;
      const books:(readonly [string,NonNullable<ReturnType<typeof this.bookViews.get>>])[]=[];
      for(const book of source.books){
        let cached=this.bookViews.get(book.id);
        if(!cached||affected.has(book.id)){
          const check=createPublishedViewCheck(source,book,new Map(),grantsExpanded?cached?.check:undefined);let slice=performance.now();
          // Resolve in stored creation order. Older dependencies are already in
          // the same check's memo when their successors are visited. Yield on a
          // CPU budget, never move an entire recursive graph to a later timer.
          for(const [kind,records]of [['chat',check.chats],['memory',check.memories]] as const)for(const id of records.keys()){check.source(kind,id);if(performance.now()-slice>=6){yield;slice=performance.now();}}
          for(const view of check.views.values()){viewAllowed(source,book,view,new Set(),check.memo,check,true);if(performance.now()-slice>=6){yield;slice=performance.now();}}
          cached={check,views:currentPublishedViews(source,book,check),reading:this.copy({bookId:book.id,progress:viewProgress(source,book,check)}),maintenance:this.copy(maintenanceProgress(source,book,check))};changed=true;yield;
        }
        books.push([book.id,cached]);
      }
      // Reordering books also changes the public projection order.
      if(this.source?.books.some((book,index)=>book.id!==source.books[index]?.id))changed=true;
      this.bookViews=new Map(books);
      if(changed){this.views=books.flatMap(([,book])=>book.views).map(view=>this.record(view,({formationSources,...visible})=>visible));this.readingViews=this.copy(books.map(([,book])=>book.reading));this.maintenance=this.copy(books.map(([,book])=>book.maintenance));}
      this.viewInputs=viewInputs;
    }
    const conversation=this.immediateConversation.read(source);
    const state=this.copy({...visible,
      usage:this.collection(source.usage,item=>this.record(item,({maintenanceDispatch,agentResponse,...value})=>value)),
      publishedViews:this.views,
      chats:conversation.chats,
      memories:this.collection(source.memories,item=>this.record(item,memorySummary)),
      books:this.collection(source.books,item=>this.record(item,({text,residentRanges,...value})=>({...value,textLength:bookLength({text,...value})}))),
    });
    const projected=freezeData({state,conversationMessages:this.copy(conversation.conversationMessages),conversationStatistics:this.copy(conversation.conversationStatistics),
      questionProgress:(queryCheckpoints??[]).filter(q=>q.status!=='consumed').map(q=>({questionId:q.questionId,status:q.status,receiptPending:!!q.pendingReceipt,pendingRequestId:q.pendingReceipt?.usageId,blockedReason:q.blockedReason})),
      readingViews:this.readingViews,maintenanceProgress:this.maintenance!,
    });
    this.source=source;this.visible=visible;this.projected=projected;return projected;
  }
}

export function recentPublishedReplies(state:State,resolve=(bookId:string,id:string)=>resolveMessageEmojiReactionTarget(state,bookId,id)):PublishedReplyView[]{
  const conversations=new Map<string,State['conversations'][number]>();
  for(const conversation of state.conversations){
    if(!conversationBelongsToPartner(state,conversation))continue;
    conversations.set(conversation.id,conversation);
  }
  // Existing receipts establish where continuous presentation tracking began.
  // A newer conversation, even one with no replies, never advances this fence;
  // seeing one reply also cannot acknowledge its siblings. A fresh archive with
  // no receipts retains publications from its first conversation onward.
  const trackedSince=new Map<string,number>();
  for(const chat of state.chats){
    if(chat.role!=='assistant'||!chatBelongsToPartner(state,chat)||chat.presentationReceipt?.notifiedAt===undefined&&chat.presentationReceipt?.seenAt===undefined&&chat.presentationReceipt?.clearedAt===undefined)continue;
    const conversation=conversations.get(chat.sessionId),startedAt=conversation?.bookId===chat.bookId?conversation.createdAt:chat.createdAt;
    const prior=trackedSince.get(chat.bookId);
    if(prior===undefined||startedAt<prior)trackedSince.set(chat.bookId,startedAt);
  }
  const replies=new Map<string,State['chats'][number]>();
  for(const chat of state.chats){
    const startedAt=state.publicationTrackingStartedAt??trackedSince.get(chat.bookId);
    if(chat.role!=='assistant'||startedAt!==undefined&&chat.createdAt<startedAt&&chat.presentationReceipt?.notifiedAt===undefined&&chat.presentationReceipt?.seenAt===undefined&&chat.presentationReceipt?.clearedAt===undefined)continue;
    try{
      // Reuse the receipt authority for source permission, publication and
      // reciprocal paragraph-share aliases; no page query grants visibility.
      const target=resolve(chat.bookId,chat.id);
      if(target.role!=='assistant')continue;
      replies.set(target.id,target);
    }catch{/* Withdrawn, unpublished and inaccessible sources have no notice. */}
  }
  const ordered=[...replies.values()].sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id));
  const seenByBook=new Map<string,number>();
  return ordered.reverse().filter(reply=>{
    if(hasUnreadPresentation(reply))return true;
    const count=seenByBook.get(reply.bookId)??0;seenByBook.set(reply.bookId,count+1);return count<20;
  }).reverse().map(({id,bookId,sessionId,text,createdAt,presentation,anchor,presentationReceipt,replyTo})=>{let end=Math.min(text.length,240);if(end<text.length&&/[\uD800-\uDBFF]/u.test(text[end-1]))end--;return structuredClone({id,bookId,sessionId,text:text.slice(0,end),...(end<text.length?{textTruncated:true as const}:{}),createdAt,presentation,anchor,presentationReceipt,replyTo});});
}

/** Cache only committed source values. A larger permission range preserves a
 * previously valid target; failed targets are checked again against the new grant. */
export class CommittedPublishedRepliesProjection{
  private source?:State;
  private value?:readonly PublishedReplyView[];
  private targets=new Map<string,State['chats'][number]>();
  read(source:State):readonly PublishedReplyView[]{
    const before=this.source;if(before===source)return this.value!;
    const positions=recordIndex(source.chats,'chats',chat=>chat.id);
    const chatSourcesExpanded=!!before&&(before.chats===source.chats||before.chats.every(chat=>{const position=positions.get(chat.id);return position!==undefined&&sameChatSource(chat,source.chats[position]);}));
    const sourcesUnchanged=chatSourcesExpanded&&!!before&&before.memories===source.memories&&before.forgotten===source.forgotten&&before.partners===source.partners&&before.partnerId===source.partnerId;
    const booksUnchanged=!!before&&before.books.length===source.books.length&&before.books.every((book,index)=>sameReadingBoundary(book,source.books[index]));
    const trackingUnchanged=!!before&&before.publicationTrackingStartedAt===source.publicationTrackingStartedAt&&(before.conversations===source.conversations||before.conversations.length===source.conversations.length&&before.conversations.every((conversation,index)=>{const next=source.conversations[index];return conversation.id===next.id&&conversation.bookId===next.bookId&&conversation.partnerId===next.partnerId&&conversation.createdAt===next.createdAt;}));
    if(this.value&&sourcesUnchanged&&before!.chats===source.chats&&booksUnchanged&&trackingUnchanged){this.source=source;return this.value;}
    const permissionOnlyExpanded=sourcesUnchanged&&!!before&&before.books.length===source.books.length&&before.books.every((book,index)=>{const next=source.books[index];return sameEdition(book,next)&&book.known.every(range=>covers(next.known,range));});
    if(!permissionOnlyExpanded)this.targets.clear();
    else if(before!.chats!==source.chats){
      const changed=new Set<string>();for(const chat of before!.chats){const position=positions.get(chat.id);if(position===undefined||source.chats[position]!==chat)changed.add(chat.id);}
      for(const [id,target]of this.targets)if(changed.has(id)||changed.has(target.id)||target.paragraphCommentId&&changed.has(target.paragraphCommentId))this.targets.delete(id);
    }
    const resolve=(bookId:string,id:string)=>{let target=this.targets.get(id);if(!target){target=resolveMessageEmojiReactionTarget(source,bookId,id);this.targets.set(id,target);}return target;};
    const value=freezeData(recentPublishedReplies(source,resolve));this.source=source;return this.value=value;
  }
}
