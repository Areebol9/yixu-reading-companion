import {bookLength,bookTextSlice,mergeRanges} from './books.ts';
import {isCurrentMemory,isEvidenceAllowed} from './context.ts';
import {formationSources,formationSourceChecker} from './formation-sources.ts';
import {semanticReferenceIds} from './semantic-notes.ts';
import {computationChat,computationReading,ComputationScopeError} from './computation-port.ts';
import type {MemoryComputationScope} from './computation-port.ts';
import type {planMemories} from './memory-plan.ts';
import type {Book,Evidence,FormationSources,Memory,Range,ReadingReply,State} from './types.ts';

export type MemoryScopeRequest={parents:readonly string[];chatIds:readonly string[];habitIds?:readonly string[];originalRanges:readonly Range[];result:ReadingReply;refs?:readonly Evidence[];formationSources?:FormationSources;planningOptions?:Parameters<typeof planMemories>[12]};

/** A task-local planning read model, not a rewritten historical record. Prose
 * exists only on actual supplied parents. Broad old exposure graphs are carried
 * once as their verified, complete withdrawal index; unrelated history is not
 * copied just to validate one candidate. */
export function buildMemoryComputationScope(state:State,book:Book,request:MemoryScopeRequest):MemoryComputationScope{
  const memories=new Map(state.memories.map(memory=>[memory.id,memory])),chats=new Map(state.chats.map(chat=>[chat.id,chat]));
  const provided=new Set(request.parents),selected=new Set<string>(request.parents),selectedChats=new Set<string>(request.chatIds);
  for(const id of request.parents){const memory=memories.get(id);if(!memory||memory.bookId!==book.id)throw new ComputationScopeError('纯规划的实际文档来源不在本书范围：'+id,[id]);}
  for(const id of request.chatIds){const chat=chats.get(id);if(!chat||chat.bookId!==book.id)throw new ComputationScopeError('纯规划的实际交流来源不在本书范围：'+id,undefined,[id]);}

  // This uses the real immutable source edges, not model declarations. Check
  // current withdrawal/permission facts before using the flattened index. The
  // engine must check its original request versions again after awaiting work.
  const audit=request.formationSources??formationSources(state,{memoryIds:request.parents,chatIds:request.chatIds,habitIds:request.habitIds,evidence:request.refs??[]});
  if(request.parents.some(id=>!audit.memoryIds.includes(id))||request.chatIds.some(id=>!audit.chatIds.includes(id))||(request.habitIds??[]).some(id=>!audit.habitIds?.includes(id)))throw new ComputationScopeError('本任务完整撤回索引没有覆盖实际提供的来源');
  if(!formationSourceChecker(state,refs=>!refs.length||isEvidenceAllowed(book,refs))(audit))throw new ComputationScopeError('纯规划的完整形成来源已有撤权、遗忘或不可用版本，未裁剪成可用来源');

  // Every concrete reference in the candidate must remain discoverable. A t/p
  // label is not a stored version ID and is left for the existing planner.
  const referenced=(value:unknown):void=>{
    if(typeof value==='string'){if(memories.get(value)?.bookId===book.id)selected.add(value);return;}
    if(Array.isArray(value)){for(const item of value)referenced(item);return;}
    if(value&&typeof value==='object')for(const item of Object.values(value))referenced(item);
  };
  referenced(request.result);
  const subjectKeys=new Set<string>();
  for(const thought of request.result.thoughts){
    if(thought.organization?.subject)subjectKeys.add(thought.organization.subject.key);
    for(const id of [thought.updates,...thought.mergePreviousIds??[]]){const subject=id&&memories.get(id)?.organization?.subject;if(subject)subjectKeys.add(subject.key);}
  }
  const narrative=(request.planningOptions?.narrativeMode??book.narrativeMode)==='stages'||!!request.result.stageNarrative||!!request.result.stateUpdates?.length||!!request.result.arcUpdates?.length;
  const semantic=request.result.thoughts.some(thought=>thought.temporal!==undefined||thought.clue!==undefined);
  const world=!!request.result.entityRoots?.length||request.result.thoughts.some(thought=>thought.about!==undefined||thought.identityClaim!==undefined||thought.attribution!==undefined||thought.ruleLinks!==undefined||thought.worldChangeOf!==undefined||thought.entityBindings!==undefined);
  for(const memory of state.memories){
    if(memory.bookId!==book.id)continue;
    if(memory.organization?.subject?.primary&&subjectKeys.has(memory.organization.subject.key)&&isCurrentMemory(memory)||
      request.result.readingBrief!==undefined&&memory.kind==='context'||
      narrative&&['stage','state','arc'].includes(memory.kind)||
      semantic&&(memory.temporal!==undefined||memory.clue!==undefined)||
      world&&(memory.identityClaim!==undefined||memory.attribution!==undefined||memory.ruleLinks!==undefined||memory.entityBindings!==undefined||memory.worldChangeOf!==undefined))selected.add(memory.id);
  }
  const structural=(memory:Memory)=>['stage','state','arc'].includes(memory.kind)||memory.temporal!==undefined||memory.clue!==undefined;
  const visited=new Set<string>(),pending=[...selected];
  while(pending.length){
    const id=pending.pop()!;if(visited.has(id))continue;visited.add(id);const memory=memories.get(id);if(!memory||memory.bookId!==book.id)continue;
    const related=[memory.replacedBy,memory.invalidatedBy,memory.correctionOf,memory.answersPartOf,memory.stateChangeOf,memory.arcChangeOf,memory.worldChangeOf,memory.identityClaim?.changeOf,memory.stageNarrative?.previousStageId,
      ...semanticReferenceIds(memory),...(memory.entityBindings??[]).map(binding=>binding.memoryId),memory.attribution?.contentRef?.memoryId,...(memory.ruleLinks??[]).map(link=>link.memoryId),
      ...(memory.stateProjection?.parts??[]).flatMap(part=>part.memoryRef?[part.memoryRef.memoryId]:[]),...(memory.arcProjection?.parts??[]).flatMap(part=>[part.memoryRef?.memoryId,part.impact?.targetVersionId]),
      ...(provided.has(id)?memory.organization?.related?.map(link=>link.id)??[]:[]),
      ...(structural(memory)?[...memory.parents,...memory.basis?.memoryIds??[]]:[])];
    for(const next of related)if(next&&memories.get(next)?.bookId===book.id&&!selected.has(next)){selected.add(next);pending.push(next);}
  }
  // Only direct chat sources and the actual permission parent chain need Chat
  // records in the planner. Historical source membership is in audit above.
  const chatPending=[...selectedChats];
  while(chatPending.length){const id=chatPending.pop()!,chat=chats.get(id);if(!chat||chat.bookId!==book.id)throw new ComputationScopeError('纯规划缺少实际父消息权限：'+id,undefined,[id]);for(const parent of [chat.replyTo,chat.paragraphCommentId])if(parent&&!selectedChats.has(parent)){selectedChats.add(parent);chatPending.push(parent);}}

  const projected=state.memories.filter(memory=>selected.has(memory.id)).map(memory=>{
    const {text,...metadata}=memory;
    if(provided.has(memory.id))return{...metadata,...(typeof text==='string'?{text}:{})};
    if(structural(memory))return metadata;
    // These exposure fields are not read on an unsupplied ordinary document by
    // the pure planner. Omit them rather than inventing empty source arrays.
    const {parents,chatIds,basis,formationSources,documentRevision,knowledgeDistribution,navigationCues,webSources,...planning}=metadata;
    return planning as Memory;
  });
  const roots=world?(state.entityRoots??[]).filter(root=>root.bookId===book.id):[];
  // bookTextSlice preserves absolute offsets and refuses a missing lease. No
  // padding, prefix expansion or invented text is used to construct this book.
  if(request.originalRanges.some(range=>!isEvidenceAllowed(book,[{...range,bookId:book.id,version:book.version}])))throw new ComputationScopeError('纯规划原文租约包含未获准或无效的实际范围');
  const residentRanges=mergeRanges(request.originalRanges).map(range=>({...range,text:bookTextSlice(book,range.start,range.end)}));
  const {id,version,known,sourceLineage,frontMatterEnd,frontMatterIncluded,readingStrategy,narrativeMode,arcCandidate,worldCandidate}=book;
  return {book:{id,version,known,sourceLineage,frontMatterEnd,frontMatterIncluded,readingStrategy,narrativeMode,arcCandidate,worldCandidate,textLength:bookLength(book),...(residentRanges.length?{residentRanges}:{})},
    partnerId:state.partnerId,partners:state.partners.map(({id,legacyUnlabelled})=>({id,legacyUnlabelled})),memories:projected,
    chats:state.chats.filter(chat=>selectedChats.has(chat.id)).map(computationChat),forgotten:state.forgotten.filter(item=>item.bookId===book.id),
    habits:(state.habits??[]).filter(habit=>habit.partnerId===state.partnerId||audit.habitIds?.includes(habit.id)),
    ...(narrative||world?{readings:(state.readings??[]).filter(record=>record.bookId===book.id).map(computationReading)}:{}),
    ...(roots.length?{entityRoots:roots}:{}),formationSources:audit};
}
