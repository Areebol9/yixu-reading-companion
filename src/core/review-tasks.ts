import type { FactReviewTask, State } from './types.ts';
import { bookLength,covers } from './books.ts';
import { isEvidenceAllowed } from './context.ts';
import {resolveBookVersion,bookVersionPrefixLength,bookVersionAllowsRange} from './book-versions.ts';

export function pruneReviewSources(state: State): boolean {
  let changed=false;
  for(const task of state.tasks??[]){
    const book=resolveBookVersion(state.books.find(b=>b.id===task.bookId),task.version);
    for(const item of task.items){
    const memory=state.memories.find(m=>m.id===item.memoryId);
    const unavailable=item.status!=='pending'||!['running','interrupted'].includes(task.status)||!book||!memory||memory.forgotten||memory.replacedBy||!isEvidenceAllowed(book,memory.evidence);
    if(item.reviewSources&&(unavailable||!isEvidenceAllowed(book!,item.reviewSources.sources.map(s=>s.evidence))||['stage','state','arc'].includes(memory!.kind)&&item.reviewSources.sources.some(s=>!covers(memory!.evidence,s.evidence)))){delete item.reviewSources;changed=true;}
    if(item.reviewReady&&(unavailable||!isEvidenceAllowed(book!,[...item.reviewReady.sources.map(s=>s.evidence),...item.reviewReady.exposure]))){delete item.reviewReady;if(item.status==='pending')item.reviewReadyInvalidated=true;changed=true;}
    }
  }
  return changed;
}

export function reviewTaskCounts(task: FactReviewTask) {
  return { reviewed: task.items.filter(i => i.status === 'reviewed').length,
    unsupported: task.items.filter(i => i.status === 'reviewed' && i.disposition === 'unsupported').length };
}

export type ReviewAvailability = 'reviewable' | 'call-limit' | 'unknown' | 'attribution-unknown' | 'contract-unknown';
export class ReviewBlockedError extends Error {
  availability: Exclude<ReviewAvailability, 'reviewable'>;
  constructor(availability: Exclude<ReviewAvailability, 'reviewable'>) {
    super(availability==='call-limit'?'原核对条目的模型调用机会已用完，记录和来源保留，未重新派发':availability==='unknown'?'原核对请求的结果或结算尚未确定，已停止重问，记录和来源保留':availability==='contract-unknown'?'原条目首次调用方式和预算未保存，无法确定剩余机会，未重新派发':'原多条核对任务的历史调用无法明确归属，未猜测剩余机会或重新派发');
    this.name='ReviewBlockedError';this.availability=availability;
  }
}
export function reviewItemAllowance(state: State, task: FactReviewTask, item: FactReviewTask['items'][number], transport: 'agent' | 'json' = 'agent') {
  const taskUsage=state.usage.filter(u=>u.taskId===task.id),unmapped=taskUsage.filter(u=>u.reviewMemoryId===undefined);
  const attributed=taskUsage.filter(u=>u.reviewMemoryId===item.memoryId||u.reviewMemoryId===undefined&&task.items.length===1);
  const attempted=attributed.filter(u=>u.dispatchState!=='not-dispatched'),used=attempted.length;
  const mode=item.reviewBudget?.transport??(attempted.some(u=>u.modelTools!==undefined)||item.reviewSources?'agent':attempted.length?undefined:transport),limit=item.reviewBudget?.limit??(mode==='agent'?4:mode==='json'?1:undefined);
  const availability:ReviewAvailability=task.items.length>1&&unmapped.some(u=>u.dispatchState!=='not-dispatched')?'attribution-unknown':attempted.some(u=>u.status==='unknown'||u.status==='reserved')?'unknown':used>=4||limit!==undefined&&used>=limit?'call-limit':limit===undefined?'contract-unknown':'reviewable';
  return{availability,transport:mode,limit,used,remaining:limit===undefined?undefined:Math.max(0,limit-used),usageIds:attributed.map(u=>u.id)};
}

/** Checkpoints contain identities and outcomes, never a second copy of forgotten text. */
export function validateReviewTasks(state: State): void {
  if (state.tasks === undefined) return;
  if (!Array.isArray(state.tasks) || state.tasks.length > 10000) throw new Error('核对任务记录无效');
  const seen = new Set<string>(); let count = 0;
  for (const task of state.tasks) {
    if (!task || typeof task.id !== 'string' || !task.id || seen.has(task.id) || task.kind !== 'fact-review' ||
      !state.books.some(b=>b.id===task.bookId&&bookVersionPrefixLength(b,task.version)!==undefined) || !state.partners.some(p => p.id === task.partnerId) ||
      !Number.isFinite(task.createdAt) || task.createdAt < 0 || !Number.isFinite(task.updatedAt) || task.updatedAt < task.createdAt ||
      !['running','interrupted','complete','cancelled'].includes(task.status) ||
      task.stopReason !== undefined && !['user','context-changed','error','restart'].includes(task.stopReason) ||
      !Array.isArray(task.items) || !task.items.length || (count += task.items.length) > 100000) throw new Error('核对任务记录无效');
    seen.add(task.id); const items = new Set<string>(),book=resolveBookVersion(state.books.find(b=>b.id===task.bookId),task.version)!;
    for (const item of task.items) {
      if (!item || typeof item.memoryId !== 'string' || !item.memoryId || items.has(item.memoryId) || !['pending','reviewed','skipped'].includes(item.status)) throw new Error('核对进度记录无效');
      items.add(item.memoryId);
      const memory = state.memories.find(m => m.id === item.memoryId);
      if(item.reviewReadyInvalidated!==undefined&&item.reviewReadyInvalidated!==true)throw Error('待保存核对失效标记无效');
      if(item.reviewReady){
        const r=item.reviewReady;
        const validEvidence=(e:any)=>e&&e.bookId===task.bookId&&e.version===task.version&&bookVersionAllowsRange(book,e.version,e);
        if(item.status!=='pending'||!['running','interrupted'].includes(task.status)||item.reviewReadyInvalidated||!item.reviewBudget||!/^[0-9a-f]{64}$/.test(r.fingerprint)||!Array.isArray(r.result)||r.result.length!==1||r.result[0]?.originalId!==item.memoryId||typeof r.result[0].before!=='string'||typeof r.result[0].reason!=='string'||!Array.isArray(r.result[0].evidence)||r.result[0].evidence.some(e=>!validEvidence(e))||!Array.isArray(r.sources)||!r.sources.length||r.sources.length>4096||new Set(r.sources.map(s=>s.id)).size!==r.sources.length||r.sources.some(s=>!/^p\d{1,6}$/.test(s.id)||!validEvidence(s.evidence)||s.evidence.end-s.evidence.start>1200)||!Array.isArray(r.exposure)||r.exposure.some(e=>!validEvidence(e)))throw Error('待保存核对的结果或实际原文来源无效');
      }
      if(item.reviewBudget){
        const b=item.reviewBudget;
        if(!['agent','json'].includes(b.transport)||b.limit!==(b.transport==='agent'?4:1)||!Array.isArray(b.usageIds)||new Set(b.usageIds).size!==b.usageIds.length||b.usageIds.some(id=>!state.usage.some(u=>u.id===id&&u.taskId===task.id&&(u.reviewMemoryId===item.memoryId||u.reviewMemoryId===undefined&&task.items.length===1))))throw Error('核对条目的调用关联或首次预算无效');
        if(reviewItemAllowance(state,task,item).used>b.limit)throw Error('核对条目超过首次调用预算');
      }
      if(item.reviewSources){
        const cache=item.reviewSources;
        if(item.status!=='pending'||!['running','interrupted'].includes(task.status)||!/^[0-9a-f]{64}$/.test(cache.fingerprint)||!Array.isArray(cache.sources)||!cache.sources.length||cache.sources.length>4096||new Set(cache.sources.map(s=>s.id)).size!==cache.sources.length||cache.sources.some(s=>!/^p\d{1,6}$/.test(s.id)||!s.evidence||s.evidence.bookId!==task.bookId||s.evidence.version!==task.version||!Number.isSafeInteger(s.evidence.start)||!Number.isSafeInteger(s.evidence.end)||s.evidence.start<0||s.evidence.end<=s.evidence.start||s.evidence.end>bookLength(book)||s.evidence.end-s.evidence.start>1200))throw new Error('核对原文接续记录无效');
      }
      if (memory && (memory.bookId !== task.bookId || memory.partnerId !== task.partnerId)) throw new Error('核对任务与记忆不属于同一本书和伙伴');
      if (item.status === 'reviewed') {
        const revision = state.memories.find(m => m.id === item.revisionId);
        if (!revision || revision.source !== 'review' || revision.correctionOf !== item.memoryId || revision.bookId !== task.bookId || revision.partnerId !== task.partnerId ||
          !['supported','unsupported'].includes(item.disposition!) || revision.reviewDisposition !== item.disposition) throw new Error('核对进度与实际修订不一致');
      } else if (item.revisionId !== undefined || item.disposition !== undefined) throw new Error('未完成条目不能声明已保存修订');
    }
    if (task.status === 'complete' && task.items.some(i => i.status === 'pending')) throw new Error('已完成任务仍含未完成条目');
  }
}
