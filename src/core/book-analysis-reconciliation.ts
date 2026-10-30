import {mergeRanges,subtractRanges} from './books.ts';
import {bookVersionAllowsRanges,bookVersionPrefixLength} from './book-versions.ts';
import {intersectRanges} from './reading-continuity.ts';
import {ordinaryReadingTask} from './terminated-reading-continuation.ts';
import {buildBookViewPublication,publicationId} from './published-views.ts';
import type {AgentResponseMaterial,Book,Memory,Range,ReadingRecord,State,TaskMaterialRef,Usage} from './types.ts';
import {maintenanceProcessed,maintenanceProgressFacts} from './maintenance-progress.ts';

type OperationCarrier={usage:Usage;owner:{material?:AgentResponseMaterial;materialRef?:TaskMaterialRef}};
const successfulReading=(book:Book,record:ReadingRecord)=>record.bookId===book.id&&record.processing==='model'&&!record.expressionOnly&&record.delivery?.proposal!=='rejected'&&bookVersionAllowsRanges(book,record.version,record.ranges);
const rangeKey=(ranges:readonly Range[])=>JSON.stringify(mergeRanges(ranges));
const count=(ranges:readonly Range[])=>ranges.reduce((sum,range)=>sum+range.end-range.start,0);

/** Detached carriers load only responses tied to this book's successful reading records. */
export function bookAnalysisOperationCarriers(state:State,bookId:string):OperationCarrier[]{
  const book=state.books.find(book=>book.id===bookId);if(!book)throw Error('书籍不存在');
  const readings=(state.readings??[]).filter(record=>successfulReading(book,record));
  return state.usage.flatMap(usage=>{
    if(usage.status!=='complete'||usage.modelOutcome||usage.questionId||usage.taskId||!usage.agentResponse)return[];
    const task=usage.requestKey&&ordinaryReadingTask(usage.requestKey);
    if(task&&task.kind==='scene')return[];
    const facts=usage.maintenanceDispatch?maintenanceProgressFacts(usage.maintenanceDispatch):[];
    if(facts.length)return task&&task.bookId===bookId&&task.kind==='maintenance'&&facts.some(fact=>fact.memoryIds.some(id=>state.memories.some(memory=>memory.id===id&&memory.scope==='partner'&&memory.kind==='opinion'&&memory.source==='reading')))?[{usage,owner:{...usage.agentResponse}}]:[];
    const matches=readings.some(record=>record.draftId===usage.id||!!task&&task.bookId===bookId&&task.version===record.version&&task.partnerId===record.partnerId&&rangeKey(task.ranges)===rangeKey(record.ranges));
    return matches?[{usage,owner:{...usage.agentResponse}}]:[];
  });
}

export type BookAnalysisReconciliationPlan={bookId:string;memoryIds:string[];viewIds:string[];publicationViewIds:string[];publicationIds:string[];maintenanceJobIds:string[];prepared:Range[];backgroundPrepared:Range[];readingIds:string[];usageIds:string[];blockedMemoryIds:string[];blockedViewIds:string[];unconfirmedCurrentViewIds:string[]};
function keepWholeChains<T extends {id:string;scope?:'book'|'partner'}>(records:readonly T[],selected:Set<string>,links:(record:T)=>readonly (string|undefined)[]):string[]{
  const index=new Map(records.map(record=>[record.id,record])),neighbors=new Map<string,Set<string>>();
  const connect=(left:string,right:string)=>{let next=neighbors.get(left);if(!next)neighbors.set(left,next=new Set());next.add(right);};
  for(const record of records)for(const target of links(record))if(target&&index.has(target)){connect(record.id,target);connect(target,record.id);}
  const blocked:string[]=[];let changed=true;
  while(changed){changed=false;for(const id of selected)if(index.get(id)?.scope!=='book'&&[...(neighbors.get(id)??[])].some(target=>index.get(target)?.scope!=='book'&&!selected.has(target))){selected.delete(id);blocked.push(id);changed=true;}}
  return blocked;
}
/** No ownership is inferred from an opinion kind, chapter position, or a persona cache. */
export function planBookAnalysisReconciliation(state:State,bookId:string,carriers:readonly OperationCarrier[]=[]):BookAnalysisReconciliationPlan{
  const book=state.books.find(book=>book.id===bookId);if(!book)throw Error('书籍不存在');
  const readings=(state.readings??[]).filter(record=>successfulReading(book,record)),records=new Map(readings.map(record=>[record.id,record]));
  const memoryProof=new Map<string,Set<string>>(),viewProof=new Map<string,Set<string>>(),usageIds=new Set<string>();
  const add=(index:Map<string,Set<string>>,ids:readonly string[],partnerId:string)=>{for(const id of ids){let authors=index.get(id);if(!authors)index.set(id,authors=new Set());authors.add(partnerId);}};
  const prepared=readings.filter(record=>record.source!=='background').flatMap(record=>record.ranges),background=readings.filter(record=>record.source==='background').flatMap(record=>record.ranges);
  for(const record of readings)add(memoryProof,record.memoryIds,record.partnerId);
  for(const usage of state.usage){
    const dispatch=usage.maintenanceDispatch,task=usage.requestKey&&ordinaryReadingTask(usage.requestKey),facts=dispatch?maintenanceProgressFacts(dispatch):[];
    if(!dispatch||!facts.length||!task||task.bookId!==bookId||task.kind!=='maintenance'||usage.status!=='complete'||usage.dispatchState!=='response-received'||usage.modelOutcome||dispatch.request.source!=='reading'||dispatch.request.maintenanceClaim!==dispatch.claim.hash||!bookVersionAllowsRanges(book,task.version,maintenanceProcessed(dispatch).ranges))continue;
    const key=JSON.parse(usage.requestKey!);if(key.length!==8||key[6]!==dispatch.request.maintenanceJobId||key[7]!==dispatch.claim.hash||rangeKey(task.ranges)!==rangeKey(dispatch.request.ranges))continue;
    usageIds.add(usage.id);for(const fact of facts){add(memoryProof,fact.memoryIds,task.partnerId);add(viewProof,fact.viewIds,task.partnerId);}prepared.push(...maintenanceProcessed(dispatch).ranges);
  }
  const defaultBookIds=new Set<string>();
  for(const carrier of carriers)for(const operation of carrier.owner.material?.operations??[]){
    const task=carrier.usage.requestKey&&ordinaryReadingTask(carrier.usage.requestKey),committed=carrier.usage.maintenanceDispatch?.committed;
    // Repair only a proved omitted-scope maintenance create. Explicit private
    // decisions and personal dialogue are never reclassified from prose or titles.
    if(committed&&task&&task.bookId===bookId&&task.kind==='maintenance'&&operation.acceptance.accepted&&operation.operation.requestId===carrier.usage.id){
      for(const thought of operation.acceptance.result?.thoughts??[]){
        if(thought.kind!=='opinion'||thought.scope!==undefined||thought.updates||thought.mergePreviousIds?.length||!thought.text?.trim())continue;
        const matches=state.memories.filter(memory=>committed.memoryIds.includes(memory.id)&&operation.memoryIds?.includes(memory.id)&&memory.bookId===bookId&&memory.partnerId===task.partnerId&&memory.scope==='partner'&&memory.kind==='opinion'&&memory.source==='reading'&&!memory.correctionOf&&memory.text===thought.text);
        if(matches.length===1)defaultBookIds.add(matches[0].id);
      }
    }
    const record=operation.readingId&&records.get(operation.readingId);
    if(!record||!operation.acceptance.accepted||operation.operation.requestId&&operation.operation.requestId!==carrier.usage.id)continue;
    usageIds.add(carrier.usage.id);add(memoryProof,operation.memoryIds??[],record.partnerId);add(viewProof,operation.viewIds??[],record.partnerId);
  }
  const eligible=(memory:Memory)=>(memory.scope!=='partner'||defaultBookIds.has(memory.id))&&memory.bookId===bookId&&memory.kind!=='user'&&memory.kind!=='shared'&&memory.source!=='conversation'&&memory.evidence.every(evidence=>evidence.bookId===bookId&&bookVersionAllowsRanges(book,evidence.version,[evidence]));
  const memories=state.memories.filter(memory=>eligible(memory)&&memoryProof.get(memory.id)?.has(memory.partnerId));
  const memoryIds=new Set(memories.filter(memory=>['preparation','reading','background'].includes(memory.source)||memory.scope==='book').map(memory=>memory.id));
  // Corrections/reviews inherit book ownership only from a proved analysis predecessor,
  // and only when this exact successor also belongs to a successful processing record.
  let changed=true;while(changed){changed=false;for(const memory of memories)if(!memoryIds.has(memory.id)&&[memory.correctionOf,...(memory.mergePreviousIds??[])].some(id=>!!id&&memoryIds.has(id))){memoryIds.add(memory.id);changed=true;}}
  // A proved book document also identifies its explicit historical versions.
  // Ownership follows only revision edges, never general source/parent references.
  const memoryVersions=state.memories.filter(eligible);
  let linked=true;while(linked){linked=false;for(const memory of memoryVersions){
    const revisionIds=[memory.correctionOf,memory.replacedBy,...(memory.mergePreviousIds??[])];
    if(!memoryIds.has(memory.id)&&revisionIds.some(id=>!!id&&memoryIds.has(id))){memoryIds.add(memory.id);linked=true;}
  }}
  const blockedMemoryIds=keepWholeChains(state.memories.filter(memory=>memory.bookId===bookId),memoryIds,memory=>[memory.correctionOf,memory.replacedBy,...(memory.mergePreviousIds??[]),...(memory.documentSuccessors??[])]);
  const allViews=(state.publishedViews??[]).filter(view=>view.bookId===bookId),views=allViews.filter(view=>bookVersionAllowsRanges(book,view.version,view.evidence)&&(view.scope==='book'||viewProof.get(view.id)?.has(view.partnerId)));
  const viewIds=new Set(views.filter(view=>view.scope!=='partner').map(view=>view.id));
  let linkedViews=true;while(linkedViews){linkedViews=false;for(const view of allViews){if(view.scope==='partner'||!bookVersionAllowsRanges(book,view.version,view.evidence))continue;const adjacent=viewIds.has(view.id)||[view.previousId,...(view.mergePreviousIds??[])].some(id=>!!id&&viewIds.has(id));if(!adjacent)continue;for(const id of [view.id,view.previousId,...(view.mergePreviousIds??[])]){const node=id&&allViews.find(item=>item.id===id);if(node&&node.scope!=='partner'&&!viewIds.has(node.id)&&bookVersionAllowsRanges(book,node.version,node.evidence)){viewIds.add(node.id);linkedViews=true;}}}}
  const blockedViewIds=keepWholeChains(allViews,viewIds,view=>[view.previousId,...(view.mergePreviousIds??[])]),versions=[book.version,...(book.sourceLineage?.prefixes??[]).map(prefix=>prefix.version).reverse()],seen=new Set<string>(),currentViewIds:string[]=[];
  for(const version of versions)for(const publication of state.viewPublications??[]){
    if(publication.bookId!==bookId||publication.version!==version)continue;
    const owner=publication.scope==='book'?'book':'partner:'+publication.partnerId;if(seen.has(owner))continue;seen.add(owner);currentViewIds.push(...publication.viewIds);
  }
  const publicationViewIds=[...new Set(currentViewIds.filter(id=>viewIds.has(id)))];
  const maintenanceJobIds=(state.maintenanceJobs??[]).filter(job=>job.bookId===bookId&&bookVersionPrefixLength(book,job.version)!==undefined&&job.origin==='reading-event'&&['pending','running'].includes(job.status)&&!state.usage.some(usage=>usage.status==='unknown'&&usage.maintenanceDispatch?.request.maintenanceJobId===job.id&&!usage.maintenanceDispatch.committed)).map(job=>job.id);
  return{bookId,memoryIds:[...memoryIds],viewIds:[...viewIds],publicationViewIds,publicationIds:[...new Set([publicationId(book,state.partnerId),...(state.viewPublications??[]).filter(publication=>publication.bookId===bookId&&publication.viewIds.some(id=>viewIds.has(id))).map(publication=>publication.id)])],maintenanceJobIds,prepared:mergeRanges([...book.prepared,...intersectRanges(prepared,book.known)]),backgroundPrepared:mergeRanges([...(book.backgroundPrepared??[]),...background]),readingIds:readings.map(record=>record.id),usageIds:[...usageIds],blockedMemoryIds,blockedViewIds,unconfirmedCurrentViewIds:[...new Set(currentViewIds.filter(id=>!viewIds.has(id)))]};
}

/** Applies metadata only. Original text, author IDs, predecessor/source edges,
 * persona progress caches, tasks, model identities and accounting remain unchanged. */
export function applyBookAnalysisReconciliation(state:State,plan:BookAnalysisReconciliationPlan){
  const book=state.books.find(book=>book.id===plan.bookId);if(!book)throw Error('书籍不存在');
  const memoryIds=new Set(plan.memoryIds),viewIds=new Set(plan.viewIds),jobs=new Set(plan.maintenanceJobIds),before=count(book.prepared);
  for(const memory of state.memories)if(memoryIds.has(memory.id))memory.scope='book';
  for(const view of state.publishedViews??[])if(viewIds.has(view.id))view.scope='book';
  for(const job of state.maintenanceJobs??[])if(jobs.has(job.id))job.scope='book';
  const publication=buildBookViewPublication(state,book,state.partnerId,plan.publicationViewIds);
  for(const previous of state.viewPublications??[])if(previous.bookId===book.id&&previous.scope!=='book'){
    const kept=previous.viewIds.filter(id=>!viewIds.has(id));if(kept.length!==previous.viewIds.length){previous.viewIds=kept;previous.revision++;}
  }
  if(publication){const previous=state.viewPublications?.find(item=>item.id===publication.id);if(!previous||JSON.stringify(previous.viewIds)!==JSON.stringify(publication.viewIds))state.viewPublications=[...(state.viewPublications??[]).filter(item=>item.id!==publication.id),publication];}
  book.prepared=plan.prepared;book.backgroundPrepared=plan.backgroundPrepared;
  if(book.buffered)book.buffered=subtractRanges(book.buffered,book.prepared);
  if(book.fullOriginalPending)book.fullOriginalPending=subtractRanges(book.fullOriginalPending,book.prepared);
  return{bookId:book.id,memoryIds:plan.memoryIds,viewIds:plan.viewIds,maintenanceJobIds:plan.maintenanceJobIds,publicationId:publication?.id,readingIds:plan.readingIds,usageIds:plan.usageIds,preparedCharsBefore:before,preparedCharsAfter:count(book.prepared),addedPreparedChars:count(book.prepared)-before,blockedMemoryIds:plan.blockedMemoryIds,blockedViewIds:plan.blockedViewIds,unconfirmedCurrentViewIds:plan.unconfirmedCurrentViewIds};
}
