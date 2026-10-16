import test from 'node:test';
import assert from 'node:assert/strict';
import { importBook } from '../src/core/books.ts';
import { initialState } from '../src/core/state.ts';
import { evidence } from '../src/core/context.ts';
import { threadAssociationTask } from '../src/core/thread-associations.ts';
import { ReadingEngine } from '../src/core/engine.ts';
import { ChatModel } from '../src/core/model.ts';
import { HarnessRuntime } from '../src/agent/runtime.ts';
import { restoreBackup } from '../src/core/backup.ts';
import type { Memory, ReadingReply } from '../src/core/types.ts';

async function fixture() {
  const state=initialState(),book=await importBook('关联工程资料','第一章 登记\nAX设备用途与损坏原因待查。\n第二章 补充\nAX设备用于温度测量。\n第三章 尚未查阅\nFUTURE-ASSOCIATION-SECRET');
  state.books=[book];book.known=[{start:0,end:book.chapters[1].end}];book.position=book.chapters[1].end;book.prepared=[{start:0,end:book.chapters[0].end}];state.settings.services[0].enabled=true;
  const question:Memory={id:'original',bookId:book.id,partnerId:state.partnerId,kind:'question',text:'AX设备的用途是什么，损坏原因是什么？',evidence:[evidence(book,book.prepared[0])],parents:[],chatIds:[],createdAt:1,forgotten:false,source:'reading'};state.memories=[question];
  const draft:ReadingReply={reply:'',readingBrief:'AX设备用于温度测量，损坏原因待查。',thoughts:[{kind:'story',text:'AX设备用于温度测量。',basis:{memoryIds:[],chatIds:[]}},{kind:'question',text:'AX设备用途是什么，损坏原因有何说明？'}],reinforce:[],wantsLong:false};
  return {state,book,question,draft};
}
const actions=[{thought:'n1',question:'q1',action:'partial',reason:'新登记只说明用途，损坏原因未明。'}];

test('关联整理只连接新事实，全部问题条件、正文、简报和已存状态不被重写',async()=>{
  const {state,book,question,draft}=await fixture(),before=structuredClone(draft),task=threadAssociationTask(state,book,draft,'preparation')!;
  assert.ok(task);const result=task.submit.parse({actions});assert.deepEqual(draft,before);assert.equal(question.replacedBy,undefined);
  assert.equal(result.thoughts.length,2);assert.equal(result.thoughts[0].text,draft.thoughts[0].text);assert.deepEqual(result.thoughts[1],draft.thoughts[1]);assert.equal(result.readingBrief,draft.readingBrief);assert.equal(result.thoughts[0].answersPartOf,question.id);assert.deepEqual(result.thoughts[0].basis?.memoryIds,[question.id]);
  assert.deepEqual(task.submit.parse({actions:[]}),draft);
  assert.throws(()=>task.submit.parse({actions:[{...actions[0],text:'越权改正文'}]}),/编号或原因/);
  assert.throws(()=>task.submit.parse({actions:[{...actions[0],action:'covered'}]}),/动作无效/);
  assert.throws(()=>task.submit.parse({actions:[{...actions[0],thought:'n2'}]}),/事实或看法/);
  assert.throws(()=>task.submit.parse({actions:[actions[0],actions[0]]}),/未接续/);
});

test('关联候选不跨书、伙伴、后文或独立背景，旧内容失效时不会触发维护',async()=>{
  const {state,book,question,draft}=await fixture();
  for(const patch of [{bookId:'other'},{partnerId:'other'},{source:'background' as const},{forgotten:true},{evidence:[evidence(book,{start:book.position,end:book.text.length})]}]) {
    state.memories=[{...question,...patch}];assert.equal(threadAssociationTask(state,book,draft,'preparation'),undefined);
  }
});

test('正式核心一次理解后只提交关联，结果与范围原子保存，备份保留旧问题',async()=>{
  const {state,book,question,draft}=await fixture();let calls=0,fail=true;
  state.settings.services[0].effort='high';state.settings.readingEffort='high';
  const engine=new ReadingEngine(state,{async save(s){if(fail&&s.books[0].prepared.some(r=>r.end===book.position))throw Error('write failure');}},new ChatModel(async request=>{
    calls++;const linking=request.body.tools.some((t:any)=>t.function.name==='submit_thread_links');
    assert.equal(request.body.reasoning_effort,linking?'medium':'high');
    assert.equal(JSON.stringify(request.body).includes('FUTURE-ASSOCIATION-SECRET'),false);
    if(linking){assert.equal(JSON.stringify(request.body).includes('submit_reading'),false);assert.match(JSON.stringify(request.body),/原问|旧疑问/);}
    return {status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:'result-'+calls,type:'function',function:{name:linking?'submit_thread_links':'submit_reading',arguments:JSON.stringify(linking?{actions}:draft)}}]}}],usage:{prompt_tokens:10,completion_tokens:10}}};
  }));const harness=new HarnessRuntime();engine.agent=harness;engine.threadAssociations=true;engine.threadAssociationEffort='medium';
  try{
    await engine.startReading(book.id);await assert.rejects(engine.prepare(book.id),/write failure/);assert.equal(state.memories.length,1);assert.equal(book.prepared[0].end,book.chapters[0].end);
    fail=false;await engine.prepare(book.id);assert.equal(state.memories.filter(m=>m.kind==='question').length,2);assert.equal(question.replacedBy,undefined);
    assert.equal(state.memories.find(m=>m.kind==='story')?.answersPartOf,question.id);assert.deepEqual(book.prepared,book.known);
    const restored=await restoreBackup(JSON.stringify(state),initialState());assert.equal(restored.memories.find(m=>m.kind==='story')?.answersPartOf,question.id);
  }finally{engine.stop();await harness.dispose();}
});
