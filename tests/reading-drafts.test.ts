import {ModelRequestError} from '../src/core/errors.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { importBook } from '../src/core/books.ts';
import { evidence, correctMemory, forgetMemory } from '../src/core/context.ts';
import { initialState } from '../src/core/state.ts';
import { ReadingEngine } from '../src/core/engine.ts';
import { ChatModel } from '../src/core/model.ts';
import { HarnessRuntime } from '../src/agent/runtime.ts';
import { restoreBackup } from '../src/core/backup.ts';
import { recoverInterruptedState } from '../src/core/startup.ts';
import { createReadingDraft, pendingReadingDrafts, pruneReadingDrafts, validateReadingDrafts } from '../src/core/reading-drafts.ts';
import { ReadingSources } from '../src/core/reading-sources.ts';
import type { State, Store } from '../src/core/types.ts';

async function fixture(){
  const state=initialState(),book=await importBook('草稿接续工程','第一章 登记\nAX设备用途与损坏原因待查。\n第二章 用途\nAX设备用于温度测量。\n第三章 后续\nNEXT-DRAFT-CHAPTER维修记录完成。');
  state.books=[book];book.known=[{start:0,end:book.chapters[1].end}];book.position=book.chapters[1].end;book.prepared=[{start:0,end:book.chapters[0].end}];state.settings.services[0].enabled=true;state.settings.defaultQuiet=true;state.settings.minReadChars=1;
  state.memories=[{id:'q-original',bookId:book.id,partnerId:state.partnerId,kind:'question',text:'AX设备用途是什么，损坏原因是什么？',evidence:[evidence(book,book.prepared[0])],parents:[],chatIds:[],createdAt:1,forgotten:false,source:'reading'}];
  let saved:State=structuredClone(state),failLink=false,failCommit=false,generated=0,linked=0;
  const store:Store={async load(){return structuredClone(saved);},async save(s){if(failCommit&&s.memories.length>1)throw Error('final write failed');saved=structuredClone(s);}};
  const model=new ChatModel(async request=>{
    const linking=request.body.tools.some((t:any)=>t.function.name==='submit_thread_links');
    if(linking){linked++;if(failLink)throw new ModelRequestError('association unavailable before dispatch','not-dispatched');}else generated++;
    const response=linking?{actions:[{thought:'n1',question:'q1',action:'partial',reason:'只确认用途，损坏原因未解。'}]}:
      {reply:'',readingBrief:'AX用于温度测量，原因待查。',thoughts:[{kind:'story',text:'AX设备用于温度测量。',sourceIds:['p1'],quoteSource:'p1'},{kind:'question',text:'AX设备用途与损坏原因是否都已明确？'}]};
    return{status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:'draft-'+(generated+linked),type:'function',function:{name:linking?'submit_thread_links':'submit_reading',arguments:JSON.stringify(response)}}]}}],usage:{prompt_tokens:10,completion_tokens:10}}};
  });
  const attach=(s:State)=>{const engine=new ReadingEngine(s,store,model),harness=new HarnessRuntime();engine.agent=harness;return{engine,harness};};
  return{state,book,store,model,attach,get saved(){return structuredClone(saved);},get counts(){return{generated,linked};},set failLink(value:boolean){failLink=value;},set failCommit(value:boolean){failCommit=value;}};
}

test('关联失败后冷启动只继续关联，草稿未冒充已理解，成功后一次消费',async()=>{
  const f=await fixture(),first=f.attach(f.state);first.engine.threadAssociations=true;f.failLink=true;
  await first.engine.startReading(f.book.id);await assert.rejects(first.engine.prepare(f.book.id),/association unavailable/);
  assert.deepEqual(f.counts,{generated:1,linked:1});assert.equal(f.state.memories.length,1);assert.equal(f.book.prepared[0].end,f.book.chapters[0].end);
  assert.equal(f.state.readingDrafts?.[0].association,'pending');const draftId=f.state.readingDrafts![0].id;
  first.engine.stop();await first.engine.persist();await first.harness.dispose();const saved=f.saved;validateReadingDrafts(saved);recoverInterruptedState(saved);
  const oldBackup=JSON.stringify(saved);f.failLink=false;const next=f.attach(saved); // default switch is off; an existing pending step is still resumed.
  try{
    await next.engine.startReading(f.book.id);await next.engine.prepare(f.book.id);assert.deepEqual(f.counts,{generated:1,linked:2});assert.deepEqual(saved.readingDrafts,[]);
    assert.equal(saved.readings?.filter(r=>r.draftId===draftId).length,1);assert.ok(saved.memories.some(m=>m.answersPartOf==='q-original'));
    const restored=await restoreBackup(oldBackup,saved);assert.equal(restored.readingDrafts?.length,0);
  }finally{next.engine.stop();await next.harness.dispose();}
});

test('最终保存失败时保留已整理草稿，重试不重复理解或关联，原文引用编号保持',async()=>{
  const f=await fixture(),run=f.attach(f.state);run.engine.threadAssociations=true;f.failCommit=true;
  try{
    await run.engine.startReading(f.book.id);await assert.rejects(run.engine.prepare(f.book.id),/final write failed/);assert.deepEqual(f.counts,{generated:1,linked:1});
    assert.equal(f.state.readingDrafts?.[0].association,'ready');assert.equal(f.state.memories.length,1);
    f.failCommit=false;await run.engine.prepare(f.book.id);assert.deepEqual(f.counts,{generated:1,linked:1});assert.equal(f.state.readingDrafts?.length,0);
    const memory=f.state.memories.find(m=>m.kind==='story')!;assert.equal(memory.answersPartOf,'q-original');assert.ok(memory.sourceEvidence?.length);assert.ok(memory.sourceQuote);await restoreBackup(JSON.stringify(f.state),initialState());
  }finally{run.engine.stop();await run.harness.dispose();}
});

test('更正或遗忘依赖后草稿失效，恢复旧备份也不能重新启用',async()=>{
  const f=await fixture(),run=f.attach(f.state);run.engine.threadAssociations=true;f.failLink=true;
  await run.engine.startReading(f.book.id);await assert.rejects(run.engine.prepare(f.book.id));const snapshot=structuredClone(f.state),backup=JSON.stringify(snapshot);
  try{
    await run.engine.correctMemory('q-original','AX设备登记已撤回。');assert.equal(f.state.readingDrafts?.length,0);assert.equal((await restoreBackup(backup,f.state)).readingDrafts?.length,0);
    forgetMemory(snapshot,'q-original');assert.equal(snapshot.readingDrafts?.length,0);
    const changed=JSON.parse(backup);changed.memories[0].text='同编号的内容已被改写。';assert.ok(pruneReadingDrafts(changed));
    const moved=JSON.parse(backup);moved.memories[0].readingStage=[{start:f.book.chapters[1].start,end:f.book.position}];assert.ok(pruneReadingDrafts(moved));
    const widened=JSON.parse(backup);widened.memories[0].evidence=[evidence(f.book,{start:0,end:f.book.text.length})];assert.ok(pruneReadingDrafts(widened));
    const bad=JSON.parse(backup);bad.readingDrafts[0].material.messages[0].role='system';assert.throws(()=>validateReadingDrafts(bad),/草稿/);
  }finally{run.engine.stop();await run.harness.dispose();}
});

test('原批次在新增许可后仍优先接续，不因合入后续章节重新生成',async()=>{
  const f=await fixture(),run=f.attach(f.state);f.failCommit=true;
  await run.engine.startReading(f.book.id);await assert.rejects(run.engine.prepare(f.book.id),/final write failed/);assert.equal(f.counts.generated,1);
  run.engine.stop();await run.engine.persist();await run.harness.dispose();f.failCommit=false;
  const state=f.saved,next=f.attach(state);
  try{
    await next.engine.startReading(f.book.id);await next.engine.setKnown(f.book.id,state.books[0].text.length);await next.engine.prepare(f.book.id);
    assert.equal(f.counts.generated,2);assert.equal(state.readingDrafts?.length,0);assert.deepEqual(state.books[0].prepared,state.books[0].known);
  }finally{next.engine.stop();await next.harness.dispose();}
});

test('恢复稀疏原文引用后新增引用不覆盖已有编号',async()=>{
  const {book}=await fixture(),sources=new ReadingSources(),span={start:0,end:18};sources.restore([['p40',{text:book.text.slice(0,18),evidence:evidence(book,span)}]]);
  assert.match(sources.render(book,span),/【p40】/);assert.match(sources.render(book,{start:18,end:book.position}),/【p41】/);assert.equal(sources.passages.get('p40')?.text,book.text.slice(0,18));
});

test('实时报读的草稿可在冷启动后由准备入口接回，保留reading来源而不重读',async()=>{
  const f=await fixture();f.book.known=[...f.book.prepared];f.book.position=f.book.prepared[0].end;const first=f.attach(f.state);f.failCommit=true;
  await first.engine.startReading(f.book.id);first.engine.observing(true);
  const page=f.book.chapters[1];try{await first.engine.observe(f.book.id,f.book.text.slice(page.start,page.end),'body','continuous-page');}catch(error){assert.match(String(error),/final write failed/);}
  assert.equal(f.counts.generated,1);assert.equal(f.state.readingDrafts?.[0].source,'reading');
  first.engine.stop();await first.engine.persist();await first.harness.dispose();f.failCommit=false;
  const state=f.saved,next=f.attach(state);
  try{
    await next.engine.startReading(f.book.id);await next.engine.prepare(f.book.id);assert.equal(f.counts.generated,1);assert.equal(state.readingDrafts?.length,0);
    assert.equal(state.memories.find(m=>m.kind==='story')?.source,'reading');assert.equal(state.readings?.at(-1)?.source,'reading');assert.equal(state.chats.length,0);
  }finally{next.engine.stop();await next.harness.dispose();}
});

test('兼容JSON通道的非法更新不会固化为每次恢复都失败的草稿',async()=>{
 const f=await fixture(),engine=new ReadingEngine(f.state,f.store,{async complete(){return{content:JSON.stringify({reply:'',thoughts:[{kind:'question',text:'AX设备是否应当拆除？',updates:'q-original',updateReason:'另提一个问题。'}]}),input:1,output:1,estimated:false,elapsedMs:1};}});
 try{await engine.startReading(f.book.id);await assert.rejects(engine.prepare(f.book.id),/新的疑问/);assert.equal(f.state.readingDrafts?.length??0,0);assert.equal(f.state.memories.length,1);}finally{engine.stop();}
});

test('尚未读到的独立背景草稿保留在背景通道，普通准备不会消费或放宽许可',async()=>{
 const f=await fixture(),range=f.book.chapters[2],known=structuredClone(f.book.known);f.book.prepared=[...known];
 f.state.readingDrafts=[createReadingDraft(f.state,f.book,{source:'background',ranges:[range],input:''},{reply:'',thoughts:[{kind:'story',text:'BACKGROUND-DRAFT-PRIVATE'}],wantsLong:false},[],{messages:[],refs:[evidence(f.book,range)],originalRanges:[range],memoryIds:[],chatIds:[],habitIds:[],passages:[]},'ready')];
 assert.equal(pendingReadingDrafts(f.state,f.book.id).length,0);assert.equal(pendingReadingDrafts(f.state,f.book.id,true).length,1);
 const run=f.attach(f.state);try{await run.engine.startReading(f.book.id);await run.engine.prepare(f.book.id);assert.equal(f.counts.generated,0);assert.deepEqual(f.book.known,known);assert.equal(f.state.readingDrafts.length,1);}finally{run.engine.stop();await run.harness.dispose();}
});
