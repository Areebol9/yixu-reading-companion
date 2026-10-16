import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../src/core/state.ts';
import { importBook } from '../src/core/books.ts';
import { ReadingEngine } from '../src/core/engine.ts';
import { ChatModel } from '../src/core/model.ts';
import { HarnessRuntime } from '../src/agent/runtime.ts';
import { correctMemory, forgetMemory, usableMemories } from '../src/core/context.ts';
import { searchMemories, selectMemories } from '../src/core/recall.ts';
import { restoreBackup } from '../src/core/backup.ts';
import { readingSubmit } from '../src/core/reading-agent.ts';
import { normalizeDevelopments,validateDevelopments } from '../src/core/memory-plan.ts';

const empty = { memoryIds:[],chatIds:[] };
const packet = (thoughts:unknown[]) => ({reply:'',replyBasis:empty,thoughts,reinforce:[],wantsLong:false});
const raw = '第一章 起始\n装置的用途与损坏原因尚未登记。\n第二章 用途\n补充登记确认装置用于温度测量。原因还在调查。\n第三章 原因\n检修确认损坏原因是进水，密封已修复。';

test('正式Harness保存部分答案，原疑问保持开放，后续完整解答才关闭；旧阶段和备份保持真实',async()=>{
  const state=initialState(),book=await importBook('接续工程资料',raw);state.books=[book];
  book.known=[{start:0,end:raw.length}];book.position=raw.length;state.settings.services[0].enabled=true;
  let calls=0;
  const engine=new ReadingEngine(state,{async load(){return state;},async save(){}},new ChatModel(async request=>{
    const input=request.body.messages.flatMap((m:any)=>m.content.split('\n\n')).flatMap((s:string)=>{try{return[JSON.parse(s)];}catch{return[];}}).find((x:any)=>x.currentRange);
    const supplied=[...input.memories,...(input.questionIndex??[])];
    const question=supplied.find((m:any)=>m.kind==='question');calls++;
    if(calls===3){
      assert.ok(question);
      const partial=supplied.find((m:any)=>m.answersPartOf);
      assert.equal(partial.answersPartOf,question.id);assert.match(partial.answersPartOf,/^m\d+$/);
      assert.match(partial.text,/温度测量/);
    }
    const thoughts=calls===1?[{kind:'question',text:'装置的用途与损坏原因是什么？',basis:empty,quoteSource:'p1'}]:
      calls===2?[{kind:'story',text:'装置用于温度测量。',basis:{memoryIds:[question.id],chatIds:[]},answersPartOf:question.id,quoteSource:'p1'}]:
      [{kind:'story',text:'装置用于温度测量；检修已确认损坏原因是进水。',basis:{memoryIds:[question.id],chatIds:[]},updates:question.id,updateReason:'已读登记分别给出用途和损坏原因。',quoteSource:'p1'}];
    return {status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:'save-'+calls,type:'function',function:{name:'submit_reading',arguments:JSON.stringify(packet(thoughts))}}]}}],usage:{prompt_tokens:10,completion_tokens:10}}};
  }));
  const harness=new HarnessRuntime();engine.agent=harness;
  try{
    await engine.startReading(book.id);await engine.prepare(book.id);
    assert.equal(calls,3);
    const [question,partial,complete]=state.memories;
    assert.equal(partial.answersPartOf,question.id);assert.equal(partial.correctionOf,undefined);
    assert.equal(question.replacedBy,complete.id);assert.equal(partial.invalidatedBy,undefined);
    const middle={...book,known:[{start:0,end:book.chapters[1].end}]};
    assert.deepEqual(usableMemories(state,middle).map(m=>m.id),[question.id,partial.id]);
    // The query words occur in the original question, not in the partial answer.
    assert.ok(searchMemories(state,middle,{query:'损坏原因'}).items.some(m=>m.id===partial.id));
    assert.ok(searchMemories(state,middle,{chapterIndex:0}).items.some(m=>m.id===partial.id));
    assert.ok(selectMemories(state,middle,middle.known[0],'损坏原因',[],1000,{focusQuestion:true,maxItems:2}).some(m=>m.id===partial.id));
    const early={...book,known:[{start:0,end:book.chapters[0].end}]};
    assert.equal(searchMemories(state,early,{query:'损坏原因'}).total,1);
    assert.equal(searchMemories(state,early,{chapterIndex:0}).total,1);
    const restored=await restoreBackup(JSON.stringify(state),initialState());
    assert.equal(restored.memories[1].answersPartOf,question.id);
    const invalid=structuredClone(state);invalid.memories[1].answersPartOf=complete.id;
    await assert.rejects(restoreBackup(JSON.stringify(invalid),initialState()),/部分答案/);
    const corrected=correctMemory(restored,partial.id,'温度用途登记已撤回，需重新核实。');
    assert.equal(corrected.answersPartOf,undefined);
    forgetMemory(state,question.id);
    assert.equal(usableMemories(state,book).some(m=>m.id===partial.id),false);
    const conflicting=readingSubmit(()=>{}).parse(packet([{kind:'story',text:'补充事实',basis:empty,answersPartOf:question.id}]));
    assert.throws(()=>validateDevelopments(state,book,conflicting,[question.id]),/部分答案/);
  }finally{engine.stop();await harness.dispose();}
});

test('部分答案不能同时关闭疑问，不能用新问题充当部分答案',()=>{
  for(const thought of [
    {kind:'story',text:'答案',basis:empty,answersPartOf:'m1',updates:'m1',updateReason:'关闭'},
    {kind:'question',text:'另一个问题？',basis:empty,answersPartOf:'m1'},
  ]) assert.throws(()=>readingSubmit(()=>{}).parse(packet([thought])),/部分答案/);
});

test('接续已有部分答案只沿真实关系回到已提供原问，原问不被关闭或跨范围取回',async()=>{
 const state=initialState(),book=await importBook('部分答案接续',raw);state.books=[book];book.known=[{start:0,end:book.chapters[1].end}];
 const base={bookId:book.id,partnerId:state.partnerId,evidence:[{bookId:book.id,version:book.version,...book.known[0]}],parents:[],chatIds:[],createdAt:1,forgotten:false,source:'reading' as const};
 const q={...base,id:'q',kind:'question' as const,text:'装置用途和损坏原因是什么？'},a={...base,id:'a',kind:'story' as const,text:'已确认用于测温。',answersPartOf:q.id};state.memories=[q,a];
 const reply=readingSubmit(()=>{}).parse(packet([{kind:'story',text:'新增的原文依据。',answersPartOf:a.id}]));
 const linked=normalizeDevelopments(state,book,reply,['q','a']);assert.equal(linked.thoughts[0].answersPartOf,'q');assert.equal(linked.thoughts[0].updates,undefined);assert.equal(reply.thoughts[0].answersPartOf,'a');
 validateDevelopments(state,book,linked,['q','a']);
 assert.equal(normalizeDevelopments(state,book,reply,['a']).thoughts[0].answersPartOf,'a');
 q.forgotten=true;assert.equal(normalizeDevelopments(state,book,reply,['q','a']).thoughts[0].answersPartOf,'a');q.forgotten=false;
 state.memories[1]={...a,source:'background'};assert.equal(normalizeDevelopments(state,book,reply,['q','a']).thoughts[0].answersPartOf,'a');state.memories[1]=a;
 const bad=readingSubmit(()=>{}).parse(packet([{kind:'story',text:'新事实。',updates:'a',updateReason:'更多依据'}]));
 assert.throws(()=>validateDevelopments(state,book,bad,['q','a'],'reading',id=>id==='a'?'m2':'m1'),/m2.*m1.*保留其他合法条目/);
});
