import test from 'node:test';
import assert from 'node:assert/strict';
import {importBook} from '../src/core/books.ts';
import {correctMemory,currentQuestion,evidence,forgetMemory,usableMemories} from '../src/core/context.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import {ChatModel} from '../src/core/model.ts';
import {HarnessFactReviewer} from '../src/agent/fact-reviewer.ts';
import {HarnessRuntime} from '../src/agent/runtime.ts';
import {initialState} from '../src/core/state.ts';
import {restoreBackup} from '../src/core/backup.ts';
import {createFactReview,parseFactReview} from '../src/core/fact-review.ts';
import {canDevelopMemory,normalizeDevelopments} from '../src/core/memory-plan.ts';
import {questionIndex,searchMemories} from '../src/core/recall.ts';
import {stageReadings} from '../src/core/narrative.ts';
import type {Memory,ModelMessage} from '../src/core/types.ts';

async function fixture(){
 const state=initialState(),book=await importBook('形成阶段工程','第一章 登记\nAX设备登记待查，用途和损坏原因都未明确。\n第二章 当前资料\nLATER-ANSWER：AX用于温度测量，损坏原因仍未明确。\n第三章 后文\nUNREAD-BASIS');
 book.known=[{start:0,end:book.chapters[1].end}];book.prepared=[...book.known];book.position=book.chapters[1].end;state.books=[book];state.settings.services[0].enabled=true;
 const make=(id:string,kind:Memory['kind'],text:string,chapter=0):Memory=>({id,kind,text,bookId:book.id,partnerId:state.partnerId,source:'reading',createdAt:chapter+1,
  forgotten:false,evidence:[evidence(book,book.chapters[chapter])],readingStage:[book.chapters[chapter]],parents:[],chatIds:[]});
 const root=make('root','story','早期数量待核对。'),question=make('old-question','question','AX用途及损坏原因分别是什么？当时两项都未明确。'),
  opinion=make('old-view','opinion','先确认AX用途有助于安排维护；我认为这一步值得优先处理。'),partial=make('partial','story','AX用于温度测量。',1);
 question.parents=[root.id];opinion.parents=[root.id];partial.evidence=[...question.evidence,...partial.evidence];partial.answersPartOf=question.id;
 const oldPartial={...partial,id:'old-partial',parents:[root.id,question.id],replacedBy:partial.id};
 partial.parents=[oldPartial.id,question.id];partial.source='review';partial.correctionOf=oldPartial.id;partial.reviewDisposition='supported';partial.reviewReason='已经按原文独立核对用途。';partial.basis={memoryIds:[],chatIds:[]};
 state.memories=[root,question,opinion,oldPartial,partial];correctMemory(state,root.id,'早期数量需按原文核对。');
 return{state,book,question,opinion,partial};
}
const packet=(request:any)=>request.body.messages.filter((m:ModelMessage)=>m.role==='user').flatMap((m:ModelMessage)=>m.content.split('\n\n')).flatMap((s:string)=>{try{return[JSON.parse(s)];}catch{return[];}}).find((p:any)=>p.candidates||p.currentRange);
const response=(name:string,args:unknown)=>({status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:name,type:'function',function:{name,arguments:JSON.stringify(args)}}]}}],usage:{prompt_tokens:10,completion_tokens:10}}});

test('按当时阶段恢复完整原问和独立看法，补查不混入后来答案；旧指针接到完整有效原问后继续部分解答',async()=>{
 const f=await fixture();let calls=0,reviewStep=0,disk=structuredClone(f.state);
 const model=new ChatModel(async request=>{
  calls++;const input=packet(request);
  if(input.candidates){
   assert.equal(JSON.stringify(request.body).includes('LATER-ANSWER'),false);assert.equal(JSON.stringify(request.body).includes('UNREAD-BASIS'),false);
   assert.match(request.body.messages[0].content,/不判定主观看法是否正确/);
   if(reviewStep++%2===0)return response('read_evidence',{query:'AX'});
   const results=request.body.messages.filter((m:ModelMessage)=>m.role==='tool').flatMap((m:ModelMessage)=>{try{return JSON.parse(m.content).sources??[];}catch{return[];}});
   assert.ok(results.length);assert.equal(JSON.stringify(results).includes('LATER-ANSWER'),false);
   return response('submit_review',{items:[{id:'m0',text:input.candidates[0].text,sourceIds:[input.sources.find((s:any)=>s.text.includes('AX')).id],reason:'核对当时事实基础，保留全文及看法。'}]});
  }
  const original=input.memories.find((m:any)=>m.kind==='question');assert.equal(original.text,f.question.text);assert.equal(original.canUpdate,true);
  assert.ok(input.memories.some((m:any)=>m.answersPartOf===original.id));
  return response('submit_reading',{reply:'用途已明确，损坏原因仍待查。',thoughts:[{kind:'story',text:'本次资料确认AX用于温度测量；损坏原因仍未明确。',answersPartOf:original.id}]});
 });
 const engine=new ReadingEngine(f.state,{async save(s){disk=structuredClone(s);}},model),reviewer=new HarnessFactReviewer(),harness=new HarnessRuntime();engine.factReviewer=reviewer;engine.agent=harness;
 try{
  f.state.tasks=[{id:'paused-other',kind:'fact-review',bookId:f.book.id,version:f.book.version,partnerId:f.state.partnerId,createdAt:1,updatedAt:1,status:'interrupted',items:[{memoryId:f.question.id,status:'pending'}]}];
  await assert.rejects(engine.reviewFacts(f.book.id,f.question.id),/未完成任务/);assert.equal(calls,0);
  f.state.tasks[0].items[0].memoryId=f.partial.id;
  assert.ok(f.question.invalidatedBy);assert.ok(f.opinion.invalidatedBy);
  await engine.reviewFacts(f.book.id,f.question.id);await engine.reviewFacts(f.book.id,f.opinion.id);
  assert.equal(f.state.tasks.find(t=>t.id==='paused-other')!.status,'interrupted');
  const restored=f.state.memories.find(m=>m.id===f.question.replacedBy)!,view=f.state.memories.find(m=>m.id===f.opinion.replacedBy)!;
  assert.equal(restored.text,f.question.text);assert.equal(view.text,f.opinion.text);assert.deepEqual(restored.readingStage,f.question.readingStage);
  assert.equal(canDevelopMemory(restored),true);assert.equal(currentQuestion(f.state,f.book,f.question.id)?.id,restored.id);
  assert.equal(usableMemories(f.state,f.book).find(m=>m.id===f.partial.id)?.answersPartOf,restored.id);assert.equal(f.partial.answersPartOf,f.question.id);
  assert.deepEqual(searchMemories(f.state,f.book,{ids:[f.question.id]}).items.map(m=>m.id),[restored.id]);
  const index=questionIndex(f.state,f.book,[f.book.chapters[1]],[],[],2000);assert.ok(index.items.some(m=>m.id===restored.id&&m.text===f.question.text));
  assert.ok(index.items.some(m=>m.id===f.partial.id&&m.answersPartOf===restored.id));
  const normalized=normalizeDevelopments(f.state,f.book,{reply:'',thoughts:[{kind:'story',text:'维护条件仍待查。',answersPartOf:f.partial.id}],wantsLong:false},[f.partial.id,restored.id]);
  assert.equal(normalized.thoughts[0].answersPartOf,restored.id);
  await engine.startReading(f.book.id);await engine.ask(f.book.id,'接续AX的全部条件。');assert.equal(calls,5);assert.equal(restored.replacedBy,undefined);
  assert.equal(f.state.memories.at(-1)!.answersPartOf,restored.id);
  const imported=await restoreBackup(JSON.stringify(disk),initialState());assert.equal(currentQuestion(imported,imported.books[0],f.question.id)?.id,restored.id);
  const restricted={...f.book,known:[]};assert.equal(currentQuestion(f.state,restricted,f.question.id),undefined);assert.equal(searchMemories(f.state,restricted,{ids:[f.question.id]}).total,0);
  forgetMemory(imported,restored.id);assert.equal(searchMemories(imported,imported.books[0],{ids:[f.question.id]}).total,0);assert.equal(imported.memories.find(m=>m.id===f.partial.id)!.forgotten,true);
 }finally{engine.stop();await reviewer.dispose();await harness.dispose();}
});

test('依据重核不接受删条件或改写看法，无法保留时仍停用；伪造恢复文字不能从备份进入',async()=>{
 const f=await fixture();
 for(const original of [f.question,f.opinion]){
  const review=createFactReview(f.book,[{...original,kind:original.kind as 'question'|'opinion'}]);
  assert.ok(review.readThrough!<f.book.position);assert.equal(JSON.stringify(review.sources).includes('LATER-ANSWER'),false);
  assert.throws(()=>parseFactReview(review,JSON.stringify({items:[{id:'m0',text:'只保留一部分。',sourceIds:[review.sources[0].id],reason:'删掉条件。'}]})),/逐字保留完整/);
 }
 const reviewer=new HarnessFactReviewer(),engine=new ReadingEngine(f.state,{async save(){}},new ChatModel(async()=>response('submit_review',{items:[{id:'m0',text:null,sourceIds:[],reason:'形成依据还不能确认，需由共读理解继续考虑。'}]})));engine.factReviewer=reviewer;
 try{await engine.reviewFacts(f.book.id,f.question.id);assert.equal(currentQuestion(f.state,f.book,f.question.id),undefined);
  const restored=await restoreBackup(JSON.stringify(f.state),initialState());assert.equal(searchMemories(restored,restored.books[0],{ids:[f.question.id]}).total,0);
  restored.memories.find(m=>m.id===f.question.replacedBy)!.text='删去一个条件的原问';await assert.rejects(restoreBackup(JSON.stringify(restored),initialState()),/事实核对记录无效/);
 }finally{engine.stop();await reviewer.dispose();}
});

test('独立阅读的原问重核后仍属于背景，阶段入口与后续更新保持来源；旧记录标记可从明确来源恢复',async()=>{
 const f=await fixture();f.question.source='background';f.opinion.source='background';f.state.memories.find(m=>m.id==='root')!.source='background';
 f.state.memories.find(m=>m.id==='old-partial')!.source='background';f.partial.backgroundOrigin=true;f.book.backgroundPrepared=[...f.book.known];
 f.state.readings=[{id:'background-stage',bookId:f.book.id,version:f.book.version,partnerId:f.state.partnerId,source:'background',ranges:[f.book.chapters[0]],memoryIds:[f.question.id],createdAt:1}];
 const reviewer=new HarnessFactReviewer(),engine=new ReadingEngine(f.state,{async save(){}},new ChatModel(async request=>{
  const input=packet(request);return response('submit_review',{items:[{id:'m0',text:input.candidates[0].text,sourceIds:[input.sources.find((s:any)=>s.text.includes('AX')).id],reason:'核对独立阅读时的事实基础。'}]});
 }));engine.factReviewer=reviewer;
 try{await engine.reviewFacts(f.book.id,f.question.id);const restored=f.state.memories.find(m=>m.id===f.question.replacedBy)!;
  assert.equal(restored.backgroundOrigin,true);assert.equal(canDevelopMemory(restored,'background'),true);assert.equal(canDevelopMemory(restored,'reading'),false);
  assert.deepEqual(stageReadings(f.state,f.book,'background')[0].memoryIds,[restored.id]);assert.equal(stageReadings(f.state,f.book,'reading').length,0);
  const legacy=structuredClone(f.state);for(const m of legacy.memories)delete m.backgroundOrigin;
  const imported=await restoreBackup(JSON.stringify(legacy),initialState());assert.equal(imported.memories.find(m=>m.id===restored.id)!.backgroundOrigin,true);
  assert.equal(canDevelopMemory(imported.memories.find(m=>m.id===restored.id)!,'reading'),false);
  const forged=structuredClone(imported);forged.memories.find(m=>m.id===restored.id)!.correctionOf=f.opinion.id;
  await assert.rejects(restoreBackup(JSON.stringify(forged),initialState()),/事实核对记录无效/);
 }finally{engine.stop();await reviewer.dispose();}
});
