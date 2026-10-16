import test from 'node:test';
import assert from 'node:assert/strict';
import {AnalysisCore} from '../src/core/analysis-core.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import {ChatModel} from '../src/core/model.ts';
import {initialState} from '../src/core/state.ts';
import {HarnessRuntime} from '../src/agent/runtime.ts';
import {HarnessFactReviewer} from '../src/agent/fact-reviewer.ts';
import {ModelRequestError} from '../src/core/errors.ts';
import {reviewItemAllowance} from '../src/core/review-tasks.ts';
import {forgetMemory} from '../src/core/context.ts';
import type {State,Store} from '../src/core/types.ts';

const packet=(body:any)=>body.messages.filter((m:any)=>m.role==='user').flatMap((m:any)=>m.content.split('\n\n')).flatMap((text:string)=>{try{return[JSON.parse(text)];}catch{return[];}});
const call=(name:string,args:any)=>({status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:crypto.randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]}}],usage:{prompt_tokens:19,completion_tokens:11}}});
const source=(p:any)=>Array.isArray(p.sources)?p.sources[0].id:p.sources.rows[0][0];
async function fixture(){
 const state=initialState();state.settings.services[0].enabled=true;state.settings.tokenLimit=1_000_000;let disk=structuredClone(state),phase='seed',seed=0,requests:any[]=[];
 const store:Store={async load(){return structuredClone(disk);},async save(s){disk=structuredClone(s);}};
 const model=new ChatModel(async request=>{requests.push(request);const entries=packet(request.body),p=entries.find(p=>p.candidates);
  if(phase==='review'){
   const c=p.candidates[0],pId=source(p);
   if(c.kind==='stage')return call('submit_review',{items:[{id:c.id,text:'ENGINE MOCK按原文重新核对的阶段。',sourceIds:[pId],reason:'ENGINE MOCK原文核对阶段，独立使用实际依据。'}]});
   if(c.kind==='state')return call('submit_review',{items:[{id:c.id,text:c.text,sourceIds:[pId],reason:'ENGINE MOCK按原文保留完整条件。',stateOperations:[]}]});
   throw Error('耗尽的历史arc不能派发');
  }
  if(phase==='query')return call('submit_reading',{reply:'ENGINE MOCK当前完整条件可通过正式材料回查。',thoughts:[]});
  const input=entries.find(p=>p.currentRange),memories=(input.analysisMaterials??input.memories??[]),m=(kind:string)=>memories.find((m:any)=>m.kind===kind)?.id,root=memories.find((m:any)=>m.kind==='story')?.id;
  ++seed;
  if(seed===1)return call('submit_reading',{stageNarrative:{text:'ENGINE MOCK初始阶段。',sourceIds:['p1'],basis:{memoryIds:[],chatIds:[]}},thoughts:[{kind:'story',text:'ENGINE MOCK初始登记数量待核。',sourceIds:['p1'],basis:{memoryIds:[],chatIds:[]}}],stateUpdates:[{topic:'工程保管',basis:{memoryIds:[],chatIds:[]},operations:[{op:'add',text:'ENGINE MOCK每月检查条件。',sourceIds:['p1']}]}],arcUpdates:[{label:'工程登记线',basis:{memoryIds:[],chatIds:[]},operations:[{op:'add',role:'condition',text:'ENGINE MOCK验收条件。',sourceIds:['p1']}]}]});
  if(seed===2){assert.ok(root);assert.ok(m('state'));assert.ok(m('arc'));return call('submit_reading',{stageNarrative:{text:'ENGINE MOCK依赖登记的后续阶段。',sourceIds:['p1'],basis:{memoryIds:[root],chatIds:[]}},stateUpdates:[{topic:'工程保管',stateChangeOf:m('state'),basis:{memoryIds:[root],chatIds:[]},operations:[{op:'add',text:'ENGINE MOCK延期仍须检查。',sourceIds:['p1']}]}],arcUpdates:[{arcChangeOf:m('arc'),basis:{memoryIds:[root],chatIds:[]},operations:[{op:'add',role:'progress',text:'ENGINE MOCK延期进展。',sourceIds:['p1']}]}]});}
  return call('submit_reading',{stageNarrative:{text:'ENGINE MOCK独立末段阶段。',sourceIds:['p1'],basis:{memoryIds:[],chatIds:[]}},stateUpdates:[{topic:'工程独立条件',basis:{memoryIds:[],chatIds:[]},operations:[{op:'add',text:'ENGINE MOCK独立包装条件。',sourceIds:['p1']}]}],arcUpdates:[{arcChangeOf:m('arc'),basis:{memoryIds:[],chatIds:[]},operations:[{op:'add',role:'progress',text:'ENGINE MOCK当前验收未完成。',sourceIds:['p1']}]}]});
 });
 const engine=new ReadingEngine(state,store,model),runtime=new HarnessRuntime(),reviewer=new HarnessFactReviewer(runtime);engine.agent=runtime;engine.factReviewer=reviewer;const core=new AnalysisCore(engine);
 const id=await core.importText('ENGINE MOCK结构恢复','第一章 登记\nENGINE MOCK登记必须检查与验收。\n第二章 延期\nENGINE MOCK延期不解除每月检查。\n第三章 包装\nENGINE MOCK包装要求独立于登记数量。\n第四章 未读\nUNREAD-RECOVERY-SECRET'),book=engine.book(id),ranges=book.chapters.slice(0,3).map(({start,end})=>({start,end}));
 return{state,store,model,engine,runtime,reviewer,core,id,book,ranges,requests,setPhase:(p:string)=>phase=p,async close(){engine.stop();await runtime.dispose();}};
}

test('ENGINE MOCK纠错后共享计划驱动正式结构复核，历史处理不重读、最新失效state不回退，耗尽arc保留任务与来源',async()=>{
 const f=await fixture();let resumed:AnalysisCore|undefined;
 try{
  await f.core.configure(f.id,{arcCandidate:'v1'});await f.core.grant(f.id,f.ranges);
  for(const r of f.ranges)await f.core.analyze(f.id,[r]);
  const root=f.state.memories.find(m=>m.kind==='story')!,stage=f.state.memories.filter(m=>m.kind==='stage'),states=f.state.memories.filter(m=>m.kind==='state'),arcs=f.state.memories.filter(m=>m.kind==='arc'),head=arcs.at(-1)!,independent=structuredClone([stage[2],states[2]]),processed=structuredClone(f.book.prepared),readings=JSON.stringify(f.state.readings);
  await f.core.correctMemory(root.id,'ENGINE MOCK登记数量须据原文核对。');
  const now=Date.now(),taskId=crypto.randomUUID();await f.engine.editState(s=>{s.tasks=[{id:taskId,kind:'fact-review',bookId:f.id,version:f.book.version,partnerId:s.partnerId,createdAt:now,updatedAt:now,status:'interrupted',items:[{memoryId:head.id,status:'pending'}]}];for(let i=0;i<4;i++)s.usage.push({id:crypto.randomUUID(),time:now,serviceId:s.settings.serviceId,purpose:'ENGINE MOCK历史arc复核',input:23,output:7,estimated:false,status:'complete',taskId,modelTools:['read_evidence']});});
  const before=f.core.status(f.id);assert.deepEqual(before.pending,[]);assert.equal(before.complete,false);assert.deepEqual(before.recoveryItems.map(i=>i.memoryId),[stage[1].id,states[1].id,head.id]);assert.equal(before.recoveryItems.at(-1)!.availability,'call-limit');assert.equal(before.recoveryItems.some(i=>i.memoryId===states[0].id),false);assert.equal(before.recoveryItems.some(i=>i.memoryId===arcs[1].id),false);assert.deepEqual(before.originalProcessed,processed);
  const calls=f.requests.length,oldTasks=JSON.stringify(f.state.tasks);await assert.rejects(f.core.resumeFactReview(taskId));assert.equal(f.requests.length,calls);assert.equal(JSON.stringify(f.state.tasks),oldTasks);
  assert.equal(f.core.recoveryPlan(f.id,[{start:f.ranges[1].start,end:f.ranges[1].end-1}]).recoveryItems.some(i=>i.kind==='state'),false,'仅局部范围不能恢复完整任务形成的状态');
  f.setPhase('review');await assert.rejects(f.core.analyze(f.id),/结构资料不可用/);assert.equal(f.requests.length,calls+2);assert.deepEqual(f.book.prepared,processed);assert.equal(JSON.stringify(f.state.readings),readings);assert.deepEqual(independent,f.state.memories.filter(m=>independent.some(x=>x.id===m.id)));assert.equal(f.core.status(f.id).recoveryItems.length,1);assert.equal(f.core.status(f.id).recoveryItems[0].memoryId,head.id);
  const materials=await f.core.queryMaterials(f.id,'ENGINE MOCK每月检查延期');assert.ok(materials.records.some(m=>m.kind==='stage'&&m.id!==stage[1].id));assert.ok(materials.records.some(m=>m.kind==='state'&&m.id!==states[1].id&&m.text.includes('延期仍须检查')));
  resumed=await AnalysisCore.fromBackup(await f.core.backup(),f.store,f.model,{agent:f.runtime,factReviewer:f.reviewer});await resumed.engine.editState(s=>{s.settings.services[0].enabled=true;});assert.deepEqual(resumed.status(f.id),f.core.status(f.id));const beforeCalls=f.requests.length;await assert.rejects(resumed.analyze(f.id));assert.equal(f.requests.length,beforeCalls);f.setPhase('query');await resumed.query(f.id,'ENGINE MOCK已复核的条件是什么？',{memoryAllowed:false});assert.ok(resumed.engine.state.chats.some(c=>c.role==='assistant'&&c.text.includes('当前完整条件')));
 }finally{resumed?.engine.stop();await f.close();}
});

test('ENGINE MOCK原任务中断后复用已取原文和剩余机会，冻结协议、未知与历史归属不明均不能绕过',async()=>{
 const f=await fixture(),copies:AnalysisCore[]=[];let calls=0;
 try{
  await f.core.configure(f.id,{arcCandidate:'v1'});await f.core.grant(f.id,f.ranges.slice(0,2));for(const r of f.ranges.slice(0,2))await f.core.analyze(f.id,[r]);
  const root=f.state.memories.find(m=>m.kind==='story')!,target=f.state.memories.filter(m=>m.kind==='stage')[1];await f.core.correctMemory(root.id,'ENGINE MOCK更正登记。');
  f.model.invoke=async request=>{calls++;if(calls===1)return call('read_evidence',{query:''});throw new ModelRequestError('ENGINE MOCK取材后明确未派发中断','not-dispatched');};
  await assert.rejects(f.core.reviewFacts(f.id,target.id),ModelRequestError);const task=f.state.tasks![0],item=task.items[0],cache=JSON.stringify(item.reviewSources),backup=await f.core.backup();assert.ok(item.reviewSources);assert.equal(reviewItemAllowance(f.state,task,item).remaining,3);
  for(const change of ['missing-agent','contract','multi','unknown','reserved'] as const){
   const raw=JSON.parse(backup),t=raw.tasks[0],i=t.items[0],attempt=raw.usage.find((u:any)=>u.taskId===t.id&&u.dispatchState!=='not-dispatched');
   if(change==='contract'){delete i.reviewBudget;delete i.reviewSources;delete attempt.modelTools;for(const u of raw.usage.filter((u:any)=>u.taskId===t.id))delete u.reviewMemoryId;}
   if(change==='multi'){delete i.reviewBudget;t.items.push({memoryId:raw.memories.find((m:any)=>m.kind==='stage'&&m.id!==target.id).id,status:'pending'});for(const u of raw.usage.filter((u:any)=>u.taskId===t.id))delete u.reviewMemoryId;}
   if(change==='unknown'||change==='reserved')attempt.status=change;
   const copy=await AnalysisCore.fromBackup(JSON.stringify(raw),f.store,f.model,change==='missing-agent'?{}:{agent:f.runtime,factReviewer:f.reviewer});copies.push(copy);await copy.engine.editState(s=>{s.settings.services[0].enabled=true;});const before=calls;
   await assert.rejects(copy.resumeFactReview(t.id));assert.equal(calls,before);assert.equal(copy.engine.state.tasks!.length,1);if(change!=='contract')assert.equal(JSON.stringify(copy.engine.state.tasks![0].items[0].reviewSources),cache);
  }
  const seen:number[]=[];const resumed=await AnalysisCore.fromBackup(backup,f.store,f.model,{agent:f.runtime,factReviewer:{review(input){seen.push(input.remainingCalls!);return f.reviewer.review(input);}}});copies.push(resumed);await resumed.engine.editState(s=>{s.settings.services[0].enabled=true;});
  f.model.invoke=async request=>{calls++;const p=packet(request.body).find(p=>p.candidates);return call('submit_review',{items:[{id:p.candidates[0].id,text:'ENGINE MOCK原任务按已获原文接续阶段。',sourceIds:[source(p)],reason:'ENGINE MOCK复用实际原文依据。'}]});};
  await resumed.reviewFacts(f.id,target.id);assert.deepEqual(seen,[3]);assert.equal(resumed.engine.state.tasks!.length,1);assert.equal(resumed.engine.state.tasks![0].id,task.id);assert.equal(resumed.engine.state.tasks![0].status,'complete');assert.equal(reviewItemAllowance(resumed.engine.state,resumed.engine.state.tasks![0],resumed.engine.state.tasks![0].items[0]).used,2);assert.ok(resumed.engine.state.memories.some(m=>m.correctionOf===target.id&&m.reviewDisposition==='supported'));
 }finally{copies.forEach(c=>c.engine.stop());await f.close();}
});

test('ENGINE MOCK冻结JSON继续原JSON；依据不足保持不可用且分析不循环复核',async()=>{
 const f=await fixture();let copy:AnalysisCore|undefined,calls=0;
 try{
  await f.core.configure(f.id,{arcCandidate:'v1'});await f.core.grant(f.id,f.ranges.slice(0,2));for(const r of f.ranges.slice(0,2))await f.core.analyze(f.id,[r]);
  await f.core.correctMemory(f.state.memories.find(m=>m.kind==='story')!.id,'ENGINE MOCK更正登记。');const target=f.state.memories.filter(m=>m.kind==='stage')[1],raw=JSON.parse(await f.core.backup()),now=Date.now(),taskId=crypto.randomUUID();
  raw.tasks=[{id:taskId,kind:'fact-review',bookId:f.id,version:f.book.version,partnerId:f.state.partnerId,createdAt:now,updatedAt:now,status:'interrupted',items:[{memoryId:target.id,status:'pending',reviewBudget:{transport:'json',limit:1,usageIds:[]}}]}];
  copy=await AnalysisCore.fromBackup(JSON.stringify(raw),f.store,f.model,{agent:f.runtime,factReviewer:f.reviewer});await copy.engine.editState(s=>{s.settings.services[0].enabled=true;});
  f.model.invoke=async request=>{calls++;const p=packet(request.body).find(p=>p.candidates),items={items:[{id:p.candidates[0].id,text:null,sourceIds:[],reason:'ENGINE MOCK本次无法建立充分依据。'}]};if(calls===1){assert.equal(request.body.tools,undefined);return{status:200,body:{choices:[{finish_reason:'stop',message:{content:JSON.stringify(items)}}],usage:{prompt_tokens:17,completion_tokens:9}}};}return call('submit_review',items);};
  await copy.resumeFactReview(taskId);assert.equal(calls,1);assert.ok(copy.recoveryPlan(f.id).recoveryItems.some(i=>i.kind==='stage'&&i.availability==='unsupported'));
  await copy.configure(f.id,{arcCandidate:null});await assert.rejects(copy.analyze(f.id),/结构资料不可用/);const after=calls,taskCount=copy.engine.state.tasks!.length;await assert.rejects(copy.analyze(f.id),/结构资料不可用/);assert.equal(calls,after);assert.equal(copy.engine.state.tasks!.length,taskCount);
  const material=await copy.queryMaterials(f.id,'ENGINE MOCK阶段保管');assert.equal(material.records.some(m=>m.reviewDisposition==='unsupported'),false);assert.equal(copy.status(f.id).complete,false);
 }finally{copy?.engine.stop();await f.close();}
});

test('ENGINE MOCK JSON唯一调用或Agent完整结果保存失败，备份后待保存优先零重发原子消费，改变来源或遗忘拒绝旧结果',async()=>{
 for(const mode of ['json','agent'] as const){
 const f=await fixture(),copies:AnalysisCore[]=[];const save=f.store.save;let calls=0;
 try{
  await f.core.configure(f.id,{arcCandidate:'v1'});await f.core.grant(f.id,f.ranges.slice(0,2));for(const r of f.ranges.slice(0,2))await f.core.analyze(f.id,[r]);
  await f.core.correctMemory(f.state.memories.find(m=>m.kind==='story')!.id,'ENGINE MOCK更正登记。');const target=f.state.memories.filter(m=>m.kind==='stage')[1];if(mode==='json')f.engine.factReviewer=undefined;
  f.model.invoke=async request=>{calls++;const p=packet(request.body).find(p=>p.candidates);const result={items:[{id:p.candidates[0].id,text:'ENGINE MOCK按实际原文接回阶段。',sourceIds:[source(p)],reason:'ENGINE MOCK实际原文依据。'}]};return mode==='agent'?call('submit_review',result):{status:200,body:{choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}],usage:{prompt_tokens:23,completion_tokens:13}}};};
  f.store.save=async state=>{if(state.memories.some(m=>m.correctionOf===target.id&&m.source==='review'))throw Error('ENGINE MOCK提交存储失败');await save(state);};
  await assert.rejects(f.core.reviewFacts(f.id,target.id),/提交存储失败/);const task=f.state.tasks![0],item=task.items[0],ledger=JSON.stringify(f.state.usage),readyBackup=await f.core.backup();assert.equal(calls,1);assert.ok(item.reviewReady);assert.equal(reviewItemAllowance(f.state,task,item).availability,mode==='json'?'call-limit':'reviewable');assert.equal(f.core.recoveryPlan(f.id).recoveryItems.find(i=>i.memoryId===target.id)!.availability,'ready');
  f.store.save=save;
  for(const change of ['permission','candidate','forget'] as const){
   const copy=await AnalysisCore.fromBackup(readyBackup,f.store,f.model);copies.push(copy);
   if(change==='permission')await copy.engine.editState(s=>{s.books[0].known=[f.ranges[1]];});
   if(change==='candidate')await copy.engine.editState(s=>{s.memories.find(m=>m.id===target.id)!.text='ENGINE MOCK形成候选已变化。';});
   if(change==='forget')await copy.engine.editState(s=>forgetMemory(s,target.id));
   await assert.rejects(copy.resumeFactReview(task.id));assert.equal(calls,1);assert.equal(copy.engine.state.memories.some(m=>m.correctionOf===target.id&&m.source==='review'),false);assert.equal(copy.engine.state.tasks![0].items[0].reviewReady,undefined);
  }
  const resumed=await AnalysisCore.fromBackup(readyBackup,f.store,f.model);copies.push(resumed);await resumed.resumeFactReview(task.id);assert.equal(calls,1);assert.equal(JSON.stringify(resumed.engine.state.usage),ledger);assert.equal(resumed.engine.state.memories.filter(m=>m.correctionOf===target.id&&m.source==='review').length,1);assert.equal(resumed.engine.state.tasks![0].status,'complete');assert.equal(resumed.engine.state.tasks![0].items[0].reviewReady,undefined);
  await resumed.engine.replaceFromBackup(readyBackup);assert.equal(resumed.engine.state.tasks![0].status,'complete');await assert.rejects(resumed.resumeFactReview(task.id));assert.equal(calls,1);assert.equal(resumed.engine.state.memories.filter(m=>m.correctionOf===target.id&&m.source==='review').length,1);
  const older=await AnalysisCore.fromBackup(readyBackup,f.store,f.model);copies.push(older);await older.engine.replaceFromBackup(JSON.stringify(resumed.engine.state));assert.equal(older.engine.state.tasks![0].status,'complete');await assert.rejects(older.resumeFactReview(task.id));assert.equal(calls,1);
 }finally{f.store.save=save;copies.forEach(c=>c.engine.stop());await f.close();}
 }
});

test('ENGINE MOCK完整原文待办按原方式消费真实完整稿，指定范围不顺带消费其它待办',async()=>{
 const f=await fixture(),save=f.store.save;let resumed:AnalysisCore|undefined,calls=0;
 try{
  await f.core.grant(f.id,f.ranges.slice(0,2));await f.engine.editState(s=>{s.books[0].fullOriginalPending=structuredClone(f.ranges.slice(0,2));});f.model.invoke=async()=>{calls++;return call('submit_reading',{reply:'',thoughts:[]});};
  await assert.rejects(f.core.analyze(f.id,[f.ranges[0]]),/原完整原文方式/);assert.equal(calls,0);
  f.store.save=async s=>{if(s.readings?.some(r=>r.processing==='model'))throw Error('ENGINE MOCK完整原文稿提交失败');await save(s);};
  await assert.rejects(f.core.analyze(f.id,[f.ranges[0]],{profile:'full-original'}),/提交失败/);assert.equal(calls,1);assert.equal(f.state.readingDrafts!.length,1);
  f.store.save=save;resumed=await AnalysisCore.fromBackup(await f.core.backup(),f.store,f.model,{agent:f.runtime});await resumed.analyze(f.id,[f.ranges[0]],{profile:'full-original'});assert.equal(calls,1);assert.equal(resumed.engine.state.readingDrafts!.length,0);assert.deepEqual(resumed.engine.book(f.id).prepared,[f.ranges[0]]);assert.deepEqual(resumed.engine.book(f.id).fullOriginalPending,[f.ranges[1]]);
 }finally{f.store.save=save;resumed?.engine.stop();await f.close();}
});
