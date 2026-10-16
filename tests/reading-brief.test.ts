import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState} from '../src/core/state.ts';
import {importBook} from '../src/core/books.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import {ChatModel} from '../src/core/model.ts';
import {HarnessRuntime} from '../src/agent/runtime.ts';
import {historicalReadingBriefs,selectReadingBrief,planReadingBrief} from '../src/core/reading-brief.ts';
import {correctMemory,forgetMemory,usableMemories} from '../src/core/context.ts';
import {restoreBackup} from '../src/core/backup.ts';
import {searchMemories} from '../src/core/recall.ts';
import {readingSubmit} from '../src/core/reading-agent.ts';
import type {Memory} from '../src/core/types.ts';

const raw='第一章 登记\n设备已送入检修室，等待校准。\n第二章 复测\n校准已完成，设备移交复测室。\n第三章 等待\n复测仍在进行，目前没有新的结果。';
const empty={memoryIds:[],chatIds:[]};
const packet=(readingBrief?:string,thoughts:unknown[]=[])=>({reply:'',replyBasis:empty,thoughts,reinforce:[],wantsLong:false,readingBrief});

test('自动阅读可只提交简报，用户交流仍须给出回应',()=>{
  assert.equal(readingSubmit(()=>{}).parse({readingBrief:'设备待校准。'}).reply,'');
  assert.throws(()=>readingSubmit(()=>{},undefined,{conversation:true}).parse({readingBrief:'设备待校准。'}),/完整字段/);
  assert.throws(()=>readingSubmit(()=>{}).parse({}),/完整字段/);
});

test('正式Harness更新有范围和版本的简报，未变化可省略；更正及遗忘沿实际来源停用派生简报',async()=>{
  const state=initialState(),book=await importBook('简报工程资料',raw);state.books=[book];book.known=[{start:0,end:raw.length}];book.position=raw.length;state.settings.services[0].enabled=true;
  let calls=0;
  const engine=new ReadingEngine(state,{async load(){return state;},async save(){}},new ChatModel(async request=>{
    const input=request.body.messages.flatMap((m:any)=>m.content.split('\n\n')).flatMap((s:string)=>{try{return[JSON.parse(s)];}catch{return[];}}).find((x:any)=>x.currentRange);
    calls++;
    if(calls>1){assert.match(input.readingBrief.id,/^m\d+$/);assert.equal(input.memories.some((m:any)=>m.kind==='context'),false);}
    if(calls===4)return{status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:'archive',type:'function',function:{name:'recall_memory',arguments:JSON.stringify({kind:'context',chapterIndex:0})}}]}}],usage:{prompt_tokens:10,completion_tokens:10}}};
    const archived=calls===5?request.body.messages.filter((m:any)=>m.role==='tool').flatMap((m:any)=>JSON.parse(m.content).results??[]).flatMap((r:any)=>JSON.parse(r.text).items??[]).find((m:any)=>m.text==='设备在检修室等待校准。关注校准结果。'):undefined;
    if(calls===5)assert.match(archived?.id,/^m\d+$/);
    const response=calls===5?packet(undefined,[{kind:'opinion',text:'此前等待校准与目前复测属于不同阶段。',basis:{memoryIds:[archived.id],chatIds:[]}}]):calls===1?{readingBrief:'设备在检修室等待校准。关注校准结果。'}:
      calls===2?{reply:'',readingBrief:'设备已转入复测室，校准完成；继续留意复测结果。',thoughts:[{kind:'story',text:'设备已完成校准并移交复测室。',quoteSource:'p1'}]}:{reply:''};
    return{status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:'brief-'+calls,type:'function',function:{name:'submit_reading',arguments:JSON.stringify(response)}}]}}],usage:{prompt_tokens:10,completion_tokens:10}}};
  }));
  const harness=new HarnessRuntime();engine.agent=harness;
  try{
    await engine.startReading(book.id);await engine.prepare(book.id);
    const all=state.memories.filter(m=>m.kind==='context'),first=all[0],last=all[1];
    assert.equal(all.length,2);assert.equal(first.replacedBy,last.id);assert.equal(selectReadingBrief(state,book)?.id,last.id);
    assert.ok(last.parents.includes(first.id));
    const fact=state.memories.find(m=>m.kind==='story')!;assert.ok(last.parents.includes(fact.id));
    assert.equal(fact.basis,undefined);assert.ok(fact.parents.includes(first.id));
    assert.equal(state.readings?.[0].memoryIds.includes(first.id),true);
    assert.equal(searchMemories(state,book,{}).items.some(m=>m.kind==='context'),false);
    assert.equal(searchMemories(state,book,{kind:'context',chapterIndex:0}).items[0].id,first.id);
    assert.equal(selectReadingBrief(state,book,'background'),undefined);
    const early={...book,known:[{start:0,end:book.chapters[0].end}]};
    assert.equal(selectReadingBrief(state,early)?.id,first.id);
    assert.deepEqual(historicalReadingBriefs(state,early).map(m=>m.id),[first.id]);
    assert.equal(planReadingBrief(state,book,'不能以回看倒退当前阶段。',last.evidence,[last.id],[],'reading',[{start:0,end:book.chapters[0].end}],[],[]),undefined);
    await engine.ask(book.id,'回顾第一阶段的设备状态。');
    assert.ok(state.memories.some(m=>m.source==='conversation'&&m.basis?.memoryIds.includes(first.id)));
    const restored=await restoreBackup(JSON.stringify(state),initialState());
    assert.equal(selectReadingBrief(restored,restored.books[0])?.id,last.id);
    const newer:Memory={...last,id:'later-brief',text:'复测仍未结束，继续留意结果。',parents:[last.id],correctionOf:last.id,revisionKind:'development'};
    restored.memories.find(m=>m.id===last.id)!.replacedBy=newer.id;restored.memories.push(newer);
    const corrected=correctMemory(restored,fact.id,'校准记录存在错误，目前尚未确认完成。');
    assert.ok(corrected);assert.equal(selectReadingBrief(restored,restored.books[0]),undefined);
    assert.deepEqual(historicalReadingBriefs(restored,restored.books[0]).map(m=>m.id),[first.id]);
    // A derived ordinary memory must also be forgotten through the brief chain.
    const derived:Memory={...fact,id:'derived',text:'根据复测阶段继续观察。',parents:[last.id],basis:undefined};state.memories.push(derived);
    forgetMemory(state,first.id);
    assert.equal(fact.forgotten,true);
    assert.equal(selectReadingBrief(state,book),undefined);assert.equal(usableMemories(state,book).some(m=>m.id==='derived'),false);
  }finally{engine.stop();await harness.dispose();}
});

test('简报不能代替用户明确要求的长期保存，保存失败不发布简报',async()=>{
  const state=initialState(),book=await importBook('简报事务资料',raw);state.books=[book];book.known=[{start:0,end:raw.length}];book.prepared=[...book.known];book.position=raw.length;state.settings.services[0].enabled=true;
  let calls=0;
  const engine=new ReadingEngine(state,{async load(){return state;},async save(s){if(s.memories.some(m=>m.kind==='context'))throw new Error('brief disk failure');}},{async complete(){calls++;return{content:JSON.stringify({...packet('设备仍在复测，下一步留意结果。'),reply:calls===1?'记住了。':'本次没有形成长期记忆。'}),input:1,output:1,elapsedMs:1,estimated:false};}});
  try{
    await engine.startReading(book.id);await assert.rejects(engine.ask(book.id,'请记住这次的用途说明。'),/brief disk failure/);
    assert.equal(calls,2);assert.equal(state.memories.length,0);assert.equal(state.chats.some(c=>c.role==='assistant'),false);
  }finally{engine.stop();}
});
