import test from 'node:test';
import assert from 'node:assert/strict';
import {ReadingEngine} from '../src/core/engine.ts';
import {HarnessRuntime} from '../src/agent/runtime.ts';
import {importBook,covers} from '../src/core/books.ts';
import {initialState} from '../src/core/state.ts';
import {ChatModel,BudgetError} from '../src/core/model.ts';
import {ModelRequestError} from '../src/core/errors.ts';
import type {State,Store} from '../src/core/types.ts';

const good={documents:[{operation:'create',text:'ENGINE MOCK 工程设备已登记，条件待核对。'}],working:['t1'],views:[{kind:'overview',key:'工程',text:'工程设备已登记。',sourceMemoryIds:['t1']},{kind:'current',key:'工程',text:'登记条件待核对。',sourceMemoryIds:['t1']}]};
const bad={...good,reply:''};
const natural=(text:string)=>({status:200,body:{choices:[{finish_reason:'stop',message:{content:text,reasoning_content:'ENGINE MOCK REASONING'}}],usage:{prompt_tokens:17,completion_tokens:9}}});
const tool=(turn:number)=>({status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:'lookup-'+turn,type:'function',function:{name:'search_original',arguments:JSON.stringify({query:'设备'})}}]}}],usage:{prompt_tokens:17,completion_tokens:9}}});
async function fixture(respond:(body:any,turn:number)=>any){
  const state=initialState(),book=await importBook('ENGINE MOCK 宿主预算','第一章 登记\n设备已登记，条件待核对。');
  state.books=[book];book.readingStrategy='companion';book.known=[{start:0,end:book.text.length}];book.position=book.text.length;
  state.settings.services[0].enabled=true;state.settings.tokenLimit=3_000_000;state.settings.defaultQuiet=true;
  let calls=0,onSave:((s:State)=>void|Promise<void>)|undefined;
  const store:Store={async load(){return undefined;},async save(s){await onSave?.(s);}};
  const bodies:any[]=[],runtime=new HarnessRuntime(),model=new ChatModel(async request=>{bodies.push(structuredClone(request.body));return respond(request.body,++calls);});
  const engine=new ReadingEngine(state,store,model);engine.agent=runtime;await engine.startReading(book.id);
  return{state,book,engine,runtime,bodies,get calls(){return calls;},set onSave(value:typeof onSave){onSave=value;},async close(){engine.stop();await runtime.dispose();}};
}

test('宿主预算prepare在第六份已结算坏参数后保留真实历史，第七份合法正文完成并记账',async()=>{
  const f=await fixture((_body,turn)=>natural(JSON.stringify(turn<=6?bad:good)));
  try{
    await f.engine.withHostAdmittedReadingTasks(()=>f.engine.prepare(f.book.id));
    assert.equal(f.calls,7);assert.equal(f.state.usage.length,7);assert.ok(f.state.usage.every(u=>u.status==='complete'));
    assert.ok(f.state.usage.every(u=>JSON.parse(u.requestKey!)[3]==='reading'&&JSON.parse(u.requestKey!)[5]==='maintenance'));
    const final=f.bodies[6].messages;
    assert.equal(final.filter((m:any)=>m.role==='assistant'&&m.content===JSON.stringify(bad)).length,6);
    assert.ok(final.some((m:any)=>m.content.includes('顶层字段不允许：reply')));
    assert.deepEqual(f.state.memories.map(m=>m.text),[good.documents[0].text]);assert.ok(covers(f.book.prepared,f.book.known[0]));
  }finally{await f.close();}
});

test('宿主预算问答第六次之后仍能取材，最终自然答复保存；不注入虚假的最后调用机会',async()=>{
  const answer='ENGINE MOCK 设备已登记，工程条件待核对。';
  const f=await fixture((_body,turn)=>turn<=7?tool(turn):natural(answer));
  try{
    f.book.prepared=structuredClone(f.book.known);
    await f.engine.withHostAdmittedReadingTasks(()=>f.engine.ask(f.book.id,'设备登记与工程条件是什么？'));
    assert.equal(f.calls,8);assert.equal(f.state.usage.length,8);assert.ok(f.state.usage.every(u=>u.status==='complete'&&u.questionId));
    assert.equal(f.state.chats.find(c=>c.role==='assistant')?.text,answer);
    assert.ok(f.bodies.every(b=>b.tools.some((t:any)=>t.function.name==='search_original')));
    assert.ok(f.bodies.every(b=>!b.messages.some((m:any)=>m.content.includes('这是最后一次'))));
    assert.equal(f.bodies[7].messages.filter((m:any)=>m.role==='tool').length,7);
  }finally{await f.close();}
});

test('宿主真实准入拒绝与核心token预算仍停止，没有用新数字上限代替预算',async()=>{
  const f=await fixture((_body,turn)=>{if(turn===8)throw new ModelRequestError('ENGINE MOCK HOST BATCH EXHAUSTED','not-dispatched');return natural(JSON.stringify(bad));});
  try{
    await assert.rejects(f.engine.withHostAdmittedReadingTasks(()=>f.engine.prepare(f.book.id)),/HOST BATCH EXHAUSTED/);
    assert.equal(f.calls,8);assert.equal(f.state.usage.filter(u=>u.status==='complete').length,7);
    assert.equal(f.state.usage[7].dispatchState,'not-dispatched');assert.equal(f.state.usage[7].input,0);assert.equal(f.state.memories.length,0);
  }finally{await f.close();}
  const limited=await fixture(()=>natural(JSON.stringify(good)));try{
    limited.state.settings.tokenLimit=0;
    await assert.rejects(limited.engine.withHostAdmittedReadingTasks(()=>limited.engine.prepare(limited.book.id)),BudgetError);
    assert.equal(limited.calls,0);assert.equal(limited.state.usage.length,0);
  }finally{await limited.close();}
});

test('宿主模式不会解除unknown保护；许可或session变更仍在派发前阻断',async()=>{
  const unknown=await fixture(()=>{throw new ModelRequestError('ENGINE MOCK UNKNOWN','unknown');});try{
    await assert.rejects(unknown.engine.withHostAdmittedReadingTasks(()=>unknown.engine.prepare(unknown.book.id)),ModelRequestError);
    const record=structuredClone(unknown.state.usage[0]);
    await unknown.engine.withHostAdmittedReadingTasks(()=>unknown.engine.prepare(unknown.book.id));
    assert.equal(unknown.state.maintenanceJobs?.[0].status,'blocked');
    assert.equal(unknown.calls,1);assert.deepEqual(unknown.state.usage[0],record);
  }finally{await unknown.close();}
  for(const change of ['permission','session'] as const){
    const f=await fixture(()=>natural(JSON.stringify(good)));try{
      f.onSave=s=>{if(s.usage.some(u=>u.status==='reserved')){if(change==='permission')f.book.known=[];else f.engine.stop();}};
      await assert.rejects(f.engine.withHostAdmittedReadingTasks(()=>f.engine.prepare(f.book.id)));
      assert.equal(f.calls,0);assert.equal(f.state.usage[0].dispatchState,'not-dispatched');
    }finally{await f.close();}
  }
});
