import {bookVersionPrefixLength} from './book-versions.ts';
import {bookVersionAllowsRanges,resolveBookVersion} from './book-versions.ts';
import {covers,mergeRanges,normalize,subtractRanges} from './books.ts';
import {evidence,isBackgroundMemory,isEvidenceAllowed,isCurrentMemory,memoryIsForgotten} from './context.ts';
import {analysisCoverage} from './arc-state.ts';
import {worldCoverage} from './world-identity.ts';
import {stageCoverage} from './reading-mode.ts';
import {reviewableFact} from './fact-review.ts';
import {reviewItemAllowance} from './review-tasks.ts';
import type {ReviewAvailability} from './review-tasks.ts';
import type {Book,Memory,Range,State} from './types.ts';

export type AnalysisRecoveryItem={memoryId:string;kind:'stage'|'state'|'arc';ranges:Range[];rangeSource:'formation'|'historical-fence';availability:ReviewAvailability|'unsupported'|'transport-unavailable'|'cancelled'|'ready'|'stale-result';taskId?:string;used?:number;remaining?:number};
function formedRanges(m:Memory){
  const formed=m.stageNarrative?.ranges??m.readingStage;
  return{ranges:formed??m.stateProjection?.asOf??m.evidence,rangeSource:formed?'formation' as const:'historical-fence' as const};
}

/** Historical processing, current material and recovery are separate facts. No model or writes. */
export function planAnalysisRecovery(state:State,book:Book,options:{profile?:'analysis'|'full-original';requestedRanges?:Range[];transport?:'agent'|'json'}={}){
  const profile=options.profile??'analysis',wanted=mergeRanges(options.requestedRanges??book.known);
  if(!['analysis','full-original'].includes(profile)||wanted.some(r=>!isEvidenceAllowed(book,[evidence(book,r)])))throw Error('恢复规划须使用当前明确授权的完整范围');
  const arcCoverage=analysisCoverage(state,book),worldCandidateCoverage=worldCoverage(state,book),candidateCoverage=book.arcCandidate&&book.worldCandidate?mergeRanges(arcCoverage.flatMap(a=>worldCandidateCoverage.map(b=>({start:Math.max(a.start,b.start),end:Math.min(a.end,b.end)})).filter(r=>r.end>r.start))):book.worldCandidate?worldCandidateCoverage:arcCoverage;
  const layoutHandled=mergeRanges((state.readings??[]).filter(r=>r.bookId===book.id&&bookVersionAllowsRanges(book,r.version,r.ranges)&&r.partnerId===state.partnerId&&r.source!=='background'&&r.processing==='layout'&&r.ranges.every(p=>isEvidenceAllowed(book,[evidence(book,p)]))).flatMap(r=>r.ranges));
  // Include invalid successors when finding chain ends; usable-only selection would roll back time.
  const scope=state.memories.filter(m=>['stage','state','arc'].includes(m.kind)&&m.bookId===book.id&&m.partnerId===state.partnerId&&!isBackgroundMemory(m)&&isEvidenceAllowed(book,m.evidence));
  const ids=new Map(scope.map(m=>[m.id,m])),resolve=(key:string)=>{const seen=new Set<string>();while(ids.get(key)?.replacedBy&&ids.has(ids.get(key)!.replacedBy!)&&!seen.has(key)){seen.add(key);key=ids.get(key)!.replacedBy!;}return key;};
  const superseded=new Set<string>();
  for(const m of scope){if(m.replacedBy&&ids.has(m.replacedBy))superseded.add(m.id);if(m.correctionOf&&ids.has(m.correctionOf))superseded.add(m.correctionOf);const previous=m.kind==='state'?m.stateChangeOf:m.kind==='arc'?m.arcChangeOf:undefined;if(previous){superseded.add(previous);superseded.add(resolve(previous));}}
  const historicalStageCoverage=mergeRanges(scope.filter(m=>m.kind==='stage').flatMap(m=>m.stageNarrative?.ranges??[])),currentStageCoverage=stageCoverage(state,book,'preparation');
  const processingCoverage=mergeRanges(profile==='full-original'?book.prepared:book.arcCandidate||book.worldCandidate?candidateCoverage:historicalStageCoverage);
  const unprocessedRanges=subtractRanges(wanted,[...processingCoverage,...layoutHandled]);
  const recoveryItems:AnalysisRecoveryItem[]=[];
  if(profile==='analysis')for(const m of scope){
    if(superseded.has(m.id)||m.kind==='arc'&&!book.arcCandidate||m.source==='correction'||!reviewableFact(state,book,m)||memoryIsForgotten(state,m))continue;
    const {ranges,rangeSource}=formedRanges(m);if(!ranges.length||!ranges.every(r=>covers(wanted,r)))continue;
    if(isCurrentMemory(m))continue;
    const task=(state.tasks??[]).find(t=>t.bookId===book.id&&bookVersionPrefixLength(book,t.version)!==undefined&&t.partnerId===state.partnerId&&['running','interrupted','cancelled'].includes(t.status)&&t.items.some(i=>i.memoryId===m.id&&i.status==='pending'));
    const taskItem=task?.items.find(i=>i.memoryId===m.id),allowance=task&&taskItem?reviewItemAllowance(state,task,taskItem,options.transport):undefined;
    const availability=m.reviewDisposition==='unsupported'?'unsupported':taskItem?.reviewReadyInvalidated?'stale-result':taskItem?.reviewReady?'ready':allowance&&allowance.availability!=='reviewable'?allowance.availability:task?.status==='cancelled'?'cancelled':allowance?.transport==='agent'&&options.transport==='json'?'transport-unavailable':'reviewable';
    recoveryItems.push({memoryId:m.id,kind:m.kind as AnalysisRecoveryItem['kind'],ranges:structuredClone(ranges),rangeSource,availability,...(task?{taskId:task.id}:{}),...(allowance?{used:allowance.used,remaining:allowance.remaining}:{})});
  }
  recoveryItems.sort((a,b)=>Math.max(...a.ranges.map(r=>r.end))-Math.max(...b.ranges.map(r=>r.end))||(['stage','state','arc'].indexOf(a.kind)-['stage','state','arc'].indexOf(b.kind)));
  return{profile,authorized:structuredClone(wanted),originalProcessed:structuredClone(book.prepared),processingCoverage,stageCoverage:currentStageCoverage,historicalStageCoverage,candidateCoverage,arcCoverage,worldCoverage:worldCandidateCoverage,layoutHandled,unprocessedRanges,recoveryItems,complete:!unprocessedRanges.length&&!recoveryItems.length};
}
