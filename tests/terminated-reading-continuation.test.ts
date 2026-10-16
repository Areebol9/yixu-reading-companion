import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState} from '../src/core/state.ts';
import {importBook} from '../src/core/books.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import {ModelRequestError} from '../src/core/errors.ts';
import {readingRequestPayloadHash} from '../src/core/terminated-reading-continuation.ts';
import type {TerminatedReadingContinuation} from '../src/core/terminated-reading-continuation.ts';
import type {ModelMessage,ModelReply,State,Store} from '../src/core/types.ts';

const original:ModelMessage[]=[{role:'user',content:'ENGINE MOCK 原工具历史'}];
const next=(n=1):ModelMessage[]=>[...original,{role:'tool',content:'ENGINE MOCK 新工具结果 '+n,tool_call_id:'result-'+n}];
const reply:ModelReply={content:'ENGINE MOCK RETURN',input:10,output:10,estimated:false,elapsedMs:0};
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}

async function fixture(source:'reading'|'preparation'='reading'){
  const state=initialState(),book=await importBook('ENGINE MOCK','第一章 测试\n工程材料已给。');
  state.books=[book];book.known=[{start:0,end:book.text.length}];book.position=book.text.length;
  state.settings.services[0].enabled=true;
  const requestKey=JSON.stringify([book.id,book.version,state.partnerId,source,book.known]);
  for(let n=1;n<=4;n++)state.usage.push({id:'old-'+n,time:n,serviceId:state.settings.serviceId,purpose:'ENGINE MOCK',input:10,output:10,estimated:n===4,status:n===4?'unknown':'complete',dispatchState:n===4?'dispatch-started':'response-received',requestKey});
  const old=structuredClone(state.usage[3]);let saved:State=structuredClone(state),onSave:((s:State)=>Promise<void>)|undefined;
  const store:Store={async load(){return saved;},async save(s){await onSave?.(s);saved=structuredClone(s);}};
  const engine=new ReadingEngine(state,store,{async complete(){return reply;},async completeTools(){return{...reply,toolCalls:[],finish:'stop'};}});
  // The test drives requestModel's real reservation and dispatch path, without a supplier.
  engine.agent={run:async()=>{throw Error('UNEXPECTED AGENT RUN');}} as any;
  await engine.startReading(book.id);
  const input:TerminatedReadingContinuation={unknownUsageId:'old-4',requestKey,maxCalls:6,originalPayload:{messages:original,tools:[]},terminationEvidence:'ENGINE MOCK process terminal proof',payloadEvidence:'ENGINE MOCK original input attested'};
  const scope=(key=requestKey,extra:any={})=>({...((engine as any).sessionScope(engine.session!.generation,book.id)),requestKey:key,...extra});
  let calls=0;
  const request=(messages=next(),options:{key?:string;extra?:any;invoke?:()=>Promise<ModelReply>}={})=>(engine as any).requestModel(messages,'ENGINE MOCK',new AbortController(),scope(options.key,options.extra),async()=>{calls++;return options.invoke?options.invoke():reply;},false,[]);
  return{state,book,engine,input,old,request,requestKey,store,get calls(){return calls;},get saved(){return saved;},set onSave(value:((s:State)=>Promise<void>)|undefined){onSave=value;}};
}

test('默认未知保护保持；显式接续沿原任务只余两次，保留原未知并留下审计，重启不恢复授权',async()=>{
  const f=await fixture();
  try{
    await assert.rejects(f.request(),e=>e instanceof ModelRequestError&&e.usageId==='old-4');
    await f.engine.withTerminatedReadingContinuation(f.input,async()=>{
      await f.request();await f.request(next(2));await assert.rejects(f.request(next(3)),/模型调用上限/);
    });
    assert.equal(f.calls,2);assert.equal(f.state.usage.length,6);assert.deepEqual(f.state.usage[3],f.old);
    const added=f.state.usage.slice(4);assert.ok(added.every(u=>u.id!=='old-4'&&u.requestKey===f.requestKey&&u.status==='complete'));
    assert.ok(added.every(u=>u.terminatedReadingContinuation?.unknownUsageId==='old-4'&&u.terminatedReadingContinuation.maxCalls===6));
    assert.equal(added[0].terminatedReadingContinuation!.originalPayloadHash,await readingRequestPayloadHash(original,[]));
    assert.notEqual(added[0].coreReadingPayload!.hash,added[0].terminatedReadingContinuation!.originalPayloadHash);
    await assert.rejects(f.request(),ModelRequestError);
    const restarted=new ReadingEngine(structuredClone(f.saved),f.store,{async complete(){throw Error('NETWORK MUST NOT RUN');}});
    await restarted.startReading(f.book.id);
    await assert.rejects((restarted as any).requestModel(next(),'ENGINE MOCK',new AbortController(),{...(restarted as any).sessionScope(restarted.session!.generation,f.book.id),requestKey:f.requestKey},async()=>{throw Error('NETWORK MUST NOT RUN');}),ModelRequestError);
    restarted.stop();
  }finally{f.engine.stop();}
});

test('相同原未知正文拒绝，核心已存身份必须与宿主核验一致',async()=>{
  const f=await fixture();
  try{
    await f.engine.withTerminatedReadingContinuation(f.input,async()=>{await assert.rejects(f.request(original),/不重发原未知请求(?:正文|或其祖先正文)/);});
    assert.equal(f.calls,0);assert.equal(f.state.usage.length,4);
    f.state.usage[3].coreReadingPayload={scheme:'core-reading-messages-tools-v1',hash:await readingRequestPayloadHash(next(),[])};
    await assert.rejects(f.engine.withTerminatedReadingContinuation(f.input,async()=>{}),/身份不符/);
  }finally{f.engine.stop();}
});

test('授权只排除一条未知；后面的未知或reserved以及重叠任务均阻断',async()=>{
  for(const status of ['unknown','reserved'] as const){const f=await fixture();try{
    await f.engine.withTerminatedReadingContinuation(f.input,async()=>{
      const overlap=JSON.stringify([f.book.id,f.book.version,f.state.partnerId,'preparation',f.book.known]);
      f.state.usage.push({...f.old,id:'other-unresolved',requestKey:overlap,status});
      await assert.rejects(f.request(),e=>e instanceof ModelRequestError&&e.usageId==='other-unresolved');
    });assert.equal(f.calls,0);
  }finally{f.engine.stop();}}
});

test('接续中发生第二次未知后停止，旧预留和新未知均保留',async()=>{
  const f=await fixture();try{
    await f.engine.withTerminatedReadingContinuation(f.input,async()=>{
      await assert.rejects(f.request(next(),{invoke:async()=>{throw new ModelRequestError('ENGINE MOCK NEW UNKNOWN','unknown');}}),ModelRequestError);
      const added=f.state.usage[4];assert.equal(added.status,'unknown');assert.ok(added.input>0);
      await assert.rejects(f.request(next(2)),e=>e instanceof ModelRequestError&&e.usageId===added.id);
    });assert.equal(f.calls,1);assert.deepEqual(f.state.usage[3],f.old);
  }finally{f.engine.stop();}
});

test('相同任务并发拒绝；保留请求异步保存后重新检查许可和六次总额',async()=>{
  const f=await fixture(),entered=deferred(),release=deferred();try{
    f.onSave=async s=>{if(s.usage.length>4){entered.resolve();await release.promise;}};
    await f.engine.withTerminatedReadingContinuation(f.input,async()=>{
      const first=f.request();await entered.promise;
      await assert.rejects(f.request(next(2)),/不并发派发/);
      f.state.usage.push({...f.old,id:'late-complete-1',status:'complete'},{...f.old,id:'late-complete-2',status:'complete'});
      release.resolve();await assert.rejects(first,/模型调用上限/);
    });assert.equal(f.calls,0);assert.equal(f.state.usage[4].dispatchState,'not-dispatched');
  }finally{release.resolve();f.engine.stop();}
  const p=await fixture();try{
    p.onSave=async s=>{if(s.usage.length>4)p.book.known=[];};
    await p.engine.withTerminatedReadingContinuation(p.input,async()=>{await assert.rejects(p.request(),/阅读许可已变化/);});assert.equal(p.calls,0);
  }finally{p.engine.stop();}
});

test('作用域异常、结束、改伙伴及问答或评审任务不能继承授权',async()=>{
  const f=await fixture();try{
    await assert.rejects(f.engine.withTerminatedReadingContinuation(f.input,async()=>{throw Error('ENGINE MOCK HOST STOP');}),/HOST STOP/);
    await assert.rejects(f.request(),ModelRequestError);
    await f.engine.withTerminatedReadingContinuation(f.input,async()=>{
      f.state.usage.push({...f.old,id:'q-unknown',requestKey:undefined,questionId:'q-other'},{...f.old,id:'review-unknown',requestKey:undefined,taskId:'review-other'});
      await assert.rejects(f.request(next(),{extra:{questionId:'q-other'}}),e=>e instanceof ModelRequestError&&e.usageId==='q-unknown');
      await assert.rejects(f.request(next(),{extra:{taskId:'review-other'}}),e=>e instanceof ModelRequestError&&e.usageId==='review-unknown');
      const changed=JSON.stringify([f.book.id,f.book.version,f.state.partnerId,'reading',f.book.known,'changed-task']);
      await assert.rejects(f.request(next(),{key:changed}),e=>e instanceof ModelRequestError&&e.usageId==='old-4');
    });assert.equal(f.calls,0);
  }finally{f.engine.stop();}
  const p=await fixture();try{
    await p.engine.withTerminatedReadingContinuation(p.input,async()=>{p.state.partnerId='other-partner';await assert.rejects(p.request(),/伙伴已变化/);});assert.equal(p.calls,0);
  }finally{p.engine.stop();}
  const stopped=await fixture();try{
    await stopped.engine.withTerminatedReadingContinuation(stopped.input,async()=>{stopped.engine.stop();await assert.rejects(stopped.request());});assert.equal(stopped.calls,0);
  }finally{stopped.engine.stop();}
});

test('请求正文在异步保存中更改时不派发；回调结束后悬挂请求的授权失效',async()=>{
  const f=await fixture(),messages=next();try{
    f.onSave=async s=>{if(s.usage.length>4)messages[1].content='ENGINE MOCK CHANGED';};
    await f.engine.withTerminatedReadingContinuation(f.input,async()=>{await assert.rejects(f.request(messages),/正文在等待期间变化/);});assert.equal(f.calls,0);
  }finally{f.engine.stop();}
  const d=await fixture(),entered=deferred(),release=deferred();let pending:Promise<ModelReply>|undefined;
  try{
    d.onSave=async s=>{if(s.usage.length>4){entered.resolve();await release.promise;}};
    await d.engine.withTerminatedReadingContinuation(d.input,async()=>{pending=d.request();await entered.promise;});
    release.resolve();await assert.rejects(pending!,/显式伴读接续已结束/);assert.equal(d.calls,0);
  }finally{release.resolve();d.engine.stop();}
});

test('prepare原preparation任务可显式接续，来源键保持且不能借reading互换绕过保护',async()=>{
  const f=await fixture('preparation');try{
    await f.engine.withTerminatedReadingContinuation(f.input,async()=>{
      const swapped=JSON.stringify([f.book.id,f.book.version,f.state.partnerId,'reading',f.book.known]);
      await assert.rejects(f.request(next(),{key:swapped}),e=>e instanceof ModelRequestError&&e.usageId==='old-4');
      await f.request();await f.request(next(2));
      await assert.rejects(f.request(next(3)),/模型调用上限/);
    });
    assert.equal(f.calls,2);assert.deepEqual(f.state.usage[3],f.old);
    assert.ok(f.state.usage.slice(4).every(u=>u.requestKey===f.requestKey&&u.terminatedReadingContinuation?.requestKey===f.requestKey));
  }finally{f.engine.stop();}
});

test('宿主预算模式下显式unknown接续只排除旧unknown，不再以六次挡住任务且审计标明准入模式',async()=>{
  const f=await fixture('preparation');try{
    await f.engine.withHostAdmittedReadingTasks(()=>f.engine.withTerminatedReadingContinuation({...f.input,maxCalls:'host-admitted'},async()=>{
      for(let turn=1;turn<=4;turn++)await f.request(next(turn));
      assert.equal(f.state.usage.length,8);assert.deepEqual(f.state.usage[3],f.old);
      assert.ok(f.state.usage.slice(4).every(u=>u.terminatedReadingContinuation?.maxCalls==='host-admitted'));
      await assert.rejects(f.request(original),/不重发原未知请求(?:正文|或其祖先正文)/);
      f.state.usage.push({...f.old,id:'new-unknown'});
      await assert.rejects(f.request(next(5)),e=>e instanceof ModelRequestError&&e.usageId==='new-unknown');
    }));
    await assert.rejects(f.request(),ModelRequestError);
  }finally{f.engine.stop();}
});
