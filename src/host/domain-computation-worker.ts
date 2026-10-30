import {parentPort} from 'node:worker_threads';
import {planMemories} from '../core/memory-plan.ts';
import {validatePlannedDocumentSubjects} from '../core/document-subjects.ts';
import {prepareMemoryIdentities,memoryContentIdentity} from '../core/memory-identity.ts';
import {ReadingDocumentError} from '../core/document-revision.ts';
import {MissingWorldIdentityBindingsError} from '../core/world-identity.ts';
import {ComputationScopeError} from '../core/computation-port.ts';
import type {MemoryComputationInput,MemoryComputationScope,DocumentSubjectsComputationInput} from '../core/computation-port.ts';
import type {State} from '../core/types.ts';

function scopedState(scope:MemoryComputationScope):State{
  const book=scope.book,bookId=book.id;
  if(typeof book.text==='string'&&book.text.length)throw new ComputationScopeError('纯计算只接收本任务residentRanges原文租约，不能传入整书text');
  if(!Number.isSafeInteger(book.textLength)||book.textLength<0)throw new ComputationScopeError('纯计算缺少书籍实际textLength');
  for(const name of ['memories','chats','forgotten','readings','entityRoots','publishedViews'] as const)for(const row of scope[name]??[])if(row.bookId!==bookId)throw new ComputationScopeError('纯计算范围包含其它书籍记录：'+name);
  for(const chat of scope.chats)if('text'in chat||'readingReaction'in chat)throw new ComputationScopeError('纯计算聊天来源须经computationChat投影，不能传入历史原话或原答');
  for(const piece of book.residentRanges??[])if(piece.text.length!==piece.end-piece.start||piece.start<0||piece.end>book.textLength)throw new ComputationScopeError('纯计算原文租约的实际正文与绝对坐标不符');
  // These are precisely the fields read by memory planning and its structural
  // validators. No ledger, settings, sessions or other-book originals exist in
  // this ephemeral value, and no state survives the request in the worker.
  return {schema:1,books:[{...book,text:''}],partnerId:scope.partnerId,partners:scope.partners,
    memories:scope.memories,chats:scope.chats,forgotten:scope.forgotten,habits:scope.habits??[],
    readings:scope.readings??[],entityRoots:scope.entityRoots??[],publishedViews:scope.publishedViews??[]} as State;
}
function requireSourceClosure(input:MemoryComputationInput){
  const memories=new Map(input.scope.memories.map(memory=>[memory.id,memory])),chats=new Map(input.scope.chats.map(chat=>[chat.id,chat]));
  const pending=[...input.parents.map(id=>({kind:'memory' as const,id})),...input.chatIds.map(id=>({kind:'chat' as const,id}))],seen=new Set<string>();
  while(pending.length){const item=pending.pop()!,key=item.kind+':'+item.id;if(seen.has(key))continue;seen.add(key);
    if(item.kind==='memory'){
      const memory=memories.get(item.id);if(!memory)throw new ComputationScopeError('纯规划缺少本任务实际认识来源：'+item.id,[item.id]);
      if(input.scope.formationSources)continue;
      if(memory.formationSources)continue;
      pending.push(...[...memory.parents,...(memory.basis?.memoryIds??[])].map(id=>({kind:'memory' as const,id})),...[...memory.chatIds,...(memory.basis?.chatIds??[])].map(id=>({kind:'chat' as const,id})));
    }else{
      const chat=chats.get(item.id);if(!chat)throw new ComputationScopeError('纯规划缺少实际交流来源或父消息权限：'+item.id,undefined,[item.id]);
      if(input.scope.formationSources){pending.push(...[...(chat.replyTo?[chat.replyTo]:[]),...(chat.paragraphCommentId?[chat.paragraphCommentId]:[])].map(id=>({kind:'chat' as const,id})));}
      else pending.push(...[...(chat.memoryIds??[]),...(chat.basis?.memoryIds??[])].map(id=>({kind:'memory' as const,id})),...[...(chat.contextChatIds??[]),...(chat.basis?.chatIds??[]),...(chat.replyTo?[chat.replyTo]:[]),...(chat.paragraphCommentId?[chat.paragraphCommentId]:[])].map(id=>({kind:'chat' as const,id})));
    }
  }
}
function encodeError(value:unknown){
  const error=value instanceof Error?value:Error(String(value)),common={name:error.name,message:error.message,stack:error.stack};
  if(error instanceof ReadingDocumentError)return{...common,kind:'reading-document',errors:error.errors,requiredMemoryIds:error.requiredMemoryIds,requiredViewIds:error.requiredViewIds,issues:error.issues,requiredMemoryRanges:error.requiredMemoryRanges};
  if(error instanceof MissingWorldIdentityBindingsError)return{...common,kind:'world-bindings',bindings:error.bindings};
  if(error instanceof ComputationScopeError)return{...common,kind:'scope',requiredMemoryIds:error.requiredMemoryIds,requiredChatIds:error.requiredChatIds};
  return{...common,kind:'standard'};
}
parentPort!.on('message',async({id,method,input}:{id:number;method:'memories'|'subjects';input:MemoryComputationInput|DocumentSubjectsComputationInput})=>{
  try{
    if(method==='subjects'){const value=input as DocumentSubjectsComputationInput;validatePlannedDocumentSubjects({memories:value.memories},value.plan);parentPort!.postMessage({id,result:undefined});return;}
    const value=input as MemoryComputationInput,state=scopedState(value.scope),book=state.books[0];requireSourceClosure(value);
    await prepareMemoryIdentities(state.memories);
    for(const memory of state.memories)if(typeof memory.text==='string'&&memory.bodyRef){const identity=memoryContentIdentity(memory);if(identity.hash!==memory.bodyRef.hash||identity.chars!==memory.bodyRef.chars)throw new ComputationScopeError('实际载入的文档正文与具体版本引用不一致：'+memory.id,[memory.id]);}
    const audit=value.scope.formationSources,evidence=new Map<string,import('../core/types.ts').Evidence>();
    if(audit)for(const ref of [...value.refs,...audit.evidence])evidence.set(JSON.stringify([ref.bookId,ref.version,ref.start,ref.end]),ref);
    const options=audit&&!value.options?.formationSources?{...value.options,formationSources:{...audit,evidence:[...evidence.values()]}}:value.options;
    const plan=planMemories(state,book,value.result,value.refs,value.parents,value.chatIds,value.source,value.webSources,value.habitIds,value.originalRanges,new Map(value.passages??[]),value.readingStage,options);
    if(value.validateSubjects!==false)validatePlannedDocumentSubjects(state,plan);
    parentPort!.postMessage({id,result:plan});
  }catch(error){parentPort!.postMessage({id,error:encodeError(error)});}
});
