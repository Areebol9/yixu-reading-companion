import {readingRecoveryTarget} from './recovery-capabilities.ts';
import type {ReadingActivity,ReadingRecoveryDecision,ReadingRecoveryTarget,State} from './types.ts';

const running=new Set<ReadingActivity['stage']>(['preparing','waiting-model','tools','validating','saving']);
const terminal=new Set<ReadingActivity['stage']>(['complete','quiet','obsolete']);

/** Live progress overlays a cached recovery inventory; streaming does not
 * rediscover every historical carrier just to redraw the current owner. */
export function readingActivityOwners(state:State,inventory:ReadingActivity[],live:ReadingActivity[],recent:ReadingActivity[],decision:(target:ReadingRecoveryTarget)=>ReadingRecoveryDecision):ReadingActivity[]{
  const visibleOwner=(activity:ReadingActivity)=>activity.partnerId===state.partnerId||activity.kind==='maintenance'&&state.maintenanceJobs?.some(job=>job.id===activity.jobId&&job.bookId===activity.bookId&&job.scope==='book');
  const owners=new Map<string,ReadingActivity>();
  for(const activity of live)if(visibleOwner(activity))owners.set(activity.id,{...structuredClone(activity),responsibility:running.has(activity.stage)?'running':terminal.has(activity.stage)?'history':'unfinished'});
  for(const activity of inventory){
    const owner=owners.get(activity.id);
    if(!owner)owners.set(activity.id,activity);
    else{if(!owner.sessionId&&activity.sessionId)owner.sessionId=activity.sessionId;if(activity.recovery)owner.recovery=activity.recovery;if(activity.progress)owner.progress={...activity.progress,...owner.progress};}
  }
  for(const activity of recent)if(visibleOwner(activity)&&state.books.some(book=>book.id===activity.bookId)&&!owners.has(activity.id))owners.set(activity.id,{...structuredClone(activity),responsibility:'history'});
  return [...owners.values()].map(activity=>{
    const target=readingRecoveryTarget(activity),recovery=activity.recovery??(target?decision(target):undefined);
    if(!recovery)return activity;
    const waiting=activity.stage==='paused'&&!['history','settlement'].includes(recovery.responsibility);
    const stage=waiting?'paused':recovery.automaticState==='queued'?'queued':recovery.automaticState==='running'&&!running.has(activity.stage)?'saving':recovery.automaticState==='stopped'?'failed':activity.stage;
    return{...activity,stage,recovery,responsibility:waiting?'unfinished':recovery.responsibility,...(waiting?{reason:activity.reason??'伴读已暂停，已有原答和进度保留，等待继续原任务'}:recovery.automaticState?{reason:recovery.reason}:{})};
  });
}
