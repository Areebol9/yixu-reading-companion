import test from 'node:test';
import assert from 'node:assert/strict';
import {importBook} from '../src/core/books.ts';
import {evidence,correctMemory} from '../src/core/context.ts';
import {stageReadings,readingRecord} from '../src/core/narrative.ts';
import {initialState} from '../src/core/state.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import {ChatModel} from '../src/core/model.ts';
import {HarnessRuntime} from '../src/agent/runtime.ts';
import type {Memory} from '../src/core/types.ts';

async function fixture(){
 const state=initialState(),book=await importBook('阶段入口工程','第一章 登记\nAX用途和损坏原因待核对。\n第二章 复测\nAX用途为温度测量，损坏原因未明确。\n第三章 FUTURE-STAGE-SECRET\n不可提前传输。');
 state.books=[book];book.known=[{start:0,end:book.chapters[1].end}];book.prepared=[...book.known];book.position=book.chapters[1].end;
 state.settings.services[0].enabled=true;
 const memory=(id:string,kind:Memory['kind'],text:string,chapter=0):Memory=>({id,kind,text,bookId:book.id,partnerId:state.partnerId,
  evidence:[evidence(book,book.chapters[chapter])],readingStage:[book.chapters[chapter]],parents:[],chatIds:[],createdAt:chapter+1,forgotten:false,source:'reading'});
 const question=memory('original','question','AX用途和损坏原因分别是什么？');
 const partial={...memory('partial','story','AX用于温度测量。',1),answersPartOf:question.id};
 const brief=memory('brief','context','INCORRECT-FREE-BRIEF',1),old=memory('old','story','登记尚未核对。');
 state.memories=[question,partial,brief,old];
 state.readings=[readingRecord(book,state.partnerId,[book.chapters[0]],[question.id,old.id]),readingRecord(book,state.partnerId,[book.chapters[1]],[partial.id,brief.id])];
 return{state,book,question,partial,brief,old,memory};
}

test('实际阶段入口保留获准记录和当前认识指针，排除简报、布局与其他来源',async()=>{
 const f=await fixture(),corrected=correctMemory(f.state,f.old.id,'登记已完成。')!;
 const base=structuredClone(f.state.readings![0]);
 f.state.readings!.push({...base,id:'other-book',bookId:'other'}, {...base,id:'other-partner',partnerId:'other'},
  {...base,id:'wrong-version',version:'other'}, {...base,id:'background',source:'background'}, {...base,id:'layout',processing:'layout'},
  {...base,id:'future',ranges:[f.book.chapters[2]]});
 const records=stageReadings(f.state,f.book);
 assert.equal(records.length,2);assert.deepEqual(records[0].memoryIds,[f.question.id,corrected.id]);
 assert.deepEqual(records[1].memoryIds,[f.partial.id]);assert.equal(JSON.stringify(records).includes('INCORRECT-FREE-BRIEF'),false);
 assert.equal(JSON.stringify(records).includes('FUTURE-STAGE-SECRET'),false);
 assert.equal(f.question.replacedBy,undefined);assert.equal(f.partial.answersPartOf,f.question.id);
 const early={...f.book,known:[{start:0,end:f.book.chapters[0].end}]};
 assert.equal(stageReadings(f.state,early).length,1);assert.deepEqual(f.state.readings![1].memoryIds,[f.partial.id,f.brief.id]);
});

test('阶段编号不允许关闭未读的原问，正式Harness取回全部条件后继续，历史与范围保持',async()=>{
 const f=await fixture(),before=structuredClone(f.state.memories);let calls=0,questionKey='';
 const engine=new ReadingEngine(f.state,{async save(){}},new ChatModel(async request=>{
  calls++;assert.equal(JSON.stringify(request.body).includes('FUTURE-STAGE-SECRET'),false);
  assert.equal(JSON.stringify(request.body).includes('INCORRECT-FREE-BRIEF'),false);
  const input=request.body.messages.filter((m:any)=>m.role==='user').flatMap((m:any)=>m.content.split('\n\n')).flatMap((s:string)=>{try{return[JSON.parse(s)];}catch{return[];}}).find((p:any)=>p.currentRange);
  assert.equal(input.readingBrief,undefined);assert.equal(input.stageReadings.length,2);
  if(calls===1){questionKey=input.stageReadings[0].memoryIds[0];assert.match(questionKey,/^m\d+$/);
   return{status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:'unseen-close',type:'function',function:{name:'submit_reading',arguments:JSON.stringify({reply:'',thoughts:[{kind:'story',text:'AX用途与损坏原因均已明确。',updates:questionKey,updateReason:'准备关闭原问。'}]})}}]}}],usage:{prompt_tokens:10,completion_tokens:10}}};}
  if(calls===2){assert.equal(f.question.replacedBy,undefined);assert.deepEqual(f.state.memories,before);
   assert.match(JSON.stringify(request.body.messages.filter((m:any)=>m.role==='tool')),/本轮已提供/);
   return{status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:'get-parent',type:'function',function:{name:'recall_memory',arguments:JSON.stringify({ids:[questionKey]})}}]}}],usage:{prompt_tokens:10,completion_tokens:10}}};}
  const items=request.body.messages.filter((m:any)=>m.role==='tool').flatMap((m:any)=>{try{return JSON.parse(m.content).results??[];}catch{return[];}}).flatMap((r:any)=>JSON.parse(r.text).items??[]);
  assert.equal(items.find((m:any)=>m.id===questionKey).text,f.question.text);
  return{status:200,body:{choices:[{finish_reason:'stop',message:{content:'用途已有结果，损坏原因仍未明确。'}}],usage:{prompt_tokens:10,completion_tokens:10}}};
 }),{original:'all',memories:'stage'});
 engine.stageEntry='records';const harness=new HarnessRuntime();engine.agent=harness;
 try{await engine.startReading(f.book.id);await engine.ask(f.book.id,'回查阶段入口。');assert.equal(calls,3);assert.deepEqual(f.state.memories,before);}
 finally{engine.stop();await harness.dispose();}
});
