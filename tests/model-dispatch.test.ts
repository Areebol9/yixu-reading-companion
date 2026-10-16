import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState} from '../src/core/state.ts';
import {importBook} from '../src/core/books.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import {AnalysisCore} from '../src/core/analysis-core.ts';
import {ChatModel,ModelOutputError} from '../src/core/model.ts';
import {ModelRequestError} from '../src/core/errors.ts';
import {NativeChannel} from '../src/native/channel.ts';
import type {Invoke} from '../src/core/model.ts';
import type {Store} from '../src/core/types.ts';

const reply=(value:unknown,usage=true)=>({status:200,body:{choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}],...(usage?{usage:{prompt_tokens:13,completion_tokens:8}}:{})}});
test('ENGINE MOCK桥接已收完整响应的格式错误保留原回执，网络和Abort仍是未知',async()=>{
  const response={content:'ENGINE MOCK原始不完整输出',input:41,output:37,estimated:false,elapsedMs:1};
  const outputError=new ModelOutputError('ENGINE MOCK完整回执的格式错误',response);
  let calls=0;const f=await fixture(async()=>{calls++;throw outputError;});
  try{
    await assert.rejects(f.core.query(f.book.id,'ENGINE MOCK已收回执不误记未知。',{memoryAllowed:false}),error=>error===outputError);
    assert.equal(calls,1);const usage=f.state.usage[0];
    assert.equal(usage.status,'complete');assert.equal(usage.dispatchState,'response-received');
    assert.equal(usage.input,41);assert.equal(usage.output,37);assert.equal(usage.estimated,false);
    assert.equal(f.state.chats.some(c=>c.role==='assistant'),false);
    await assert.rejects(f.model.completeTools(f.state.settings.services[0],[],[],new AbortController().signal),error=>error===outputError);
  }finally{f.engine.stop();}
  for(const failure of [new TypeError('ENGINE MOCK网络断流'),new DOMException('ENGINE MOCK在途取消','AbortError')]){
    const model=new ChatModel(async()=>{throw failure;});
    await assert.rejects(model.complete(initialState().settings.services[0],[],new AbortController().signal,{requestId:'mock-request'}),error=>error instanceof ModelRequestError&&error.dispatch==='unknown'&&error.usageId==='mock-request');
  }
});
async function fixture(invoke:Invoke){
  const state=initialState(),book=await importBook('ENGINE MOCK派发边界','第一章 登记\nENGINE MOCK保管仍须检查。\n第二章 运输\nENGINE MOCK延期不取消验收。');
  state.books=[book];book.known=[{start:0,end:book.text.length}];book.prepared=[...book.known];book.position=book.text.length;
  state.settings.services[0].enabled=true;state.settings.services[1].enabled=true;state.settings.services[1].fallback=true;state.settings.tokenLimit=1_000_000;
  let disk=structuredClone(state);const store:Store={async load(){return structuredClone(disk);},async save(s){disk=structuredClone(s);}};
  const model=new ChatModel(invoke),engine=new ReadingEngine(state,store,model),core=new AnalysisCore(engine);await engine.start(book.id);
  return{state,book,store,model,engine,core};
}

test('ENGINE MOCK实际取材后结果未知：不换服务、不自动重问，备份及遗留reserved均保留原问与材料',async()=>{
  const requests:any[]=[];let f:Awaited<ReturnType<typeof fixture>>;
  f=await fixture(async request=>{requests.push(request);if(requests.length===1)return reply({read:{start:f.book.chapters[0].start,end:f.book.chapters[0].end}});throw new TypeError('ENGINE MOCK上游断开');});
  let resumed:AnalysisCore|undefined;
  try{
    await assert.rejects(f.core.query(f.book.id,'ENGINE MOCK保管与延期条件。',{memoryAllowed:false}),ModelRequestError);
    assert.equal(requests.length,2);assert.equal(new Set(requests.map(r=>r.serviceId)).size,1);
    const q=f.state.chats.find(c=>c.role==='user')!,cp=f.state.queryCheckpoints![0],unknown=f.state.usage.at(-1)!;
    assert.ok(cp.acquired.some(a=>a.kind==='original'));assert.equal(unknown.status,'unknown');assert.equal(unknown.dispatchState,'dispatch-started');assert.equal(requests.at(-1).requestId,unknown.id);
    const ledger=JSON.stringify(f.state.usage);f.engine.setNetworkAvailable(false);f.engine.setNetworkAvailable(true);await f.engine.retryPending();await assert.rejects(f.engine.retryQuestion(q.id),ModelRequestError);assert.equal(requests.length,2);assert.equal(JSON.stringify(f.state.usage),ledger);
    unknown.status='reserved';delete unknown.dispatchState;const reservedLedger=JSON.stringify(f.state.usage);await assert.rejects(f.engine.retryQuestion(q.id),ModelRequestError);assert.equal(requests.length,2);assert.equal(JSON.stringify(f.state.usage),reservedLedger);
    const backup=JSON.parse(await f.core.backup());backup.usage.at(-1).status='reserved';delete backup.usage.at(-1).dispatchState;
    resumed=await AnalysisCore.fromBackup(JSON.stringify(backup),f.store,f.model);await resumed.engine.editState(s=>{s.settings.services[0].enabled=true;});
    await assert.rejects(resumed.engine.retryQuestion(q.id),ModelRequestError);assert.equal(requests.length,2);assert.ok(resumed.engine.state.queryCheckpoints![0].acquired.some(a=>a.kind==='original'));assert.equal(resumed.engine.state.usage.at(-1)!.status,'unknown');
  }finally{resumed?.engine.stop();f.engine.stop();}
});

test('ENGINE MOCK明确未派发可以换服务或接续，零上游用量不占原阶段机会，合法估算回执仍可保存',async()=>{
  const requests:any[]=[];let localBusy=0;
  const f=await fixture(async request=>{requests.push(request);if(requests.length===1)throw new ModelRequestError('ENGINE MOCK本地排队未派发','not-dispatched',{retryable:true});if(localBusy-->0)throw new ModelRequestError('ENGINE MOCK本地配置未派发','not-dispatched');return reply({reply:'ENGINE MOCK已据获准资料回应。',thoughts:[]},false);});
  let resumed:AnalysisCore|undefined;
  try{
    await f.core.query(f.book.id,'ENGINE MOCK渠道接续。',{memoryAllowed:false});assert.equal(requests.length,2);assert.notEqual(requests[0].serviceId,requests[1].serviceId);assert.equal(f.state.usage[0].dispatchState,'not-dispatched');assert.equal(f.state.usage[0].input+f.state.usage[0].output,0);assert.equal(f.state.usage[0].cost,0);assert.equal(f.state.usage[1].estimated,true);assert.equal(f.state.chats[0].delivery,'answered');
    localBusy=5;await assert.rejects(f.core.query(f.book.id,'ENGINE MOCK原阶段不被本地拒绝消耗。',{memoryAllowed:false}),ModelRequestError);const q=f.state.chats.filter(c=>c.role==='user').at(-1)!;
    for(let i=0;i<4;i++)await assert.rejects(f.engine.retryQuestion(q.id),ModelRequestError);
    await f.engine.retryQuestion(q.id);assert.equal(q.delivery,'answered');
    resumed=await AnalysisCore.fromBackup(await f.core.backup(),f.store,f.model);assert.equal(resumed.engine.state.chats.find(c=>c.id===q.id)!.delivery,'answered');
  }finally{resumed?.engine.stop();f.engine.stop();}
});

test('ENGINE MOCK完整HTTP失败保存实际用量但不重问；原生超时与未派发错误准确透传',async()=>{
  let calls=0;const f=await fixture(async()=>{calls++;return{status:503,body:{usage:{prompt_tokens:31,completion_tokens:7},error:'ENGINE MOCK上游错误'}};});
  try{await assert.rejects(f.core.query(f.book.id,'ENGINE MOCK上游失败。'),ModelRequestError);assert.equal(calls,1);const u=f.state.usage[0];assert.equal(u.status,'unknown');assert.equal(u.dispatchState,'response-received');assert.equal(u.input,31);assert.equal(u.output,7);assert.equal(u.estimated,false);await f.engine.retryPending();assert.equal(calls,1);}finally{f.engine.stop();}
  const wires:any[]=[],channel=new NativeChannel(wire=>wires.push(JSON.parse(wire)),10);
  const pending=channel.request('model');await assert.rejects(pending,e=>e instanceof ModelRequestError&&e.dispatch==='unknown');assert.equal(wires.length,2);
  channel.receiveValue(wires[0].id,{value:reply({reply:'ENGINE MOCK迟到结果。'})});assert.equal(wires.length,2);
  const local=channel.request('model');channel.receiveValue(wires.at(-1).id,{value:{error:'ENGINE MOCK缺密钥',dispatch:'not-dispatched',requestId:'known-request'}});await assert.rejects(local,e=>e instanceof ModelRequestError&&e.dispatch==='not-dispatched'&&e.usageId==='known-request');
});

test('ENGINE MOCK JSON准备中途未知保持同一领域任务，回查与主阶段purpose变化不能绕过',async()=>{
  let calls=0;let f:Awaited<ReturnType<typeof fixture>>;
  f=await fixture(async()=>{if(++calls===1)return reply({read:{start:f.book.chapters[0].start,end:f.book.chapters[0].end}});throw Error('ENGINE MOCK准备回查后断开');});
  let resumed:AnalysisCore|undefined;
  try{
    f.book.known=[{start:0,end:f.book.chapters[0].end}];f.book.position=f.book.chapters[0].end;f.book.prepared=[];await assert.rejects(f.engine.prepare(f.book.id),ModelRequestError);assert.equal(calls,2);const u=f.state.usage.at(-1)!;assert.ok(u.requestKey);assert.equal(u.status,'unknown');
    resumed=await AnalysisCore.fromBackup(await f.core.backup(),f.store,f.model);await resumed.engine.editState(s=>{s.settings.services[0].enabled=true;});await resumed.engine.startReading(f.book.id);await assert.rejects(resumed.engine.prepare(f.book.id),ModelRequestError);assert.equal(calls,2);assert.equal(resumed.engine.book(f.book.id).prepared.length,0);
    await resumed.grant(f.book.id,[{start:0,end:f.book.text.length}]);await assert.rejects(resumed.engine.prepare(f.book.id),ModelRequestError);assert.equal(calls,2);
    await resumed.grant(f.book.id,[{start:f.book.chapters[1].start,end:f.book.chapters[1].end}]);await resumed.engine.editState(s=>{s.books[0].known=[{start:f.book.chapters[1].start,end:f.book.chapters[1].end}];});
    (f.model as ChatModel).invoke=async()=>{calls++;return reply({reply:'',thoughts:[]});};await resumed.engine.prepare(f.book.id);assert.equal(calls,3);assert.ok(resumed.engine.book(f.book.id).prepared.length>0);
  }finally{resumed?.engine.stop();f.engine.stop();}
});

test('ENGINE MOCK JSON非stop正文不成为完整结果，回执用量仍保存',async()=>{
  for(const finish of ['content_filter',undefined]){
    let calls=0;const f=await fixture(async()=>{calls++;return{status:200,body:{choices:[{finish_reason:finish,message:{content:JSON.stringify({reply:'ENGINE MOCK未结束片段。',thoughts:[]})}}],usage:{prompt_tokens:17,completion_tokens:9}}};});
    try{await assert.rejects(f.core.query(f.book.id,'ENGINE MOCK完整结束合同。',{memoryAllowed:false}),ModelOutputError);assert.equal(calls,1);assert.equal(f.state.usage[0].status,'complete');assert.equal(f.state.usage[0].input,17);assert.equal(f.state.usage[0].output,9);assert.equal(f.state.chats.some(c=>c.role==='assistant'),false);assert.equal(f.state.queryCheckpoints![0].candidate,undefined);}finally{f.engine.stop();}
  }
});

test('ENGINE MOCK预留保存失败尚未进入Invoke，原账本行明确未派发且不冒用量',async()=>{
  let calls=0;const f=await fixture(async()=>{calls++;return reply({reply:'ENGINE MOCK不应派发。'});}),save=f.store.save;
  try{
    f.store.save=async state=>{if(state.usage.some(u=>u.status==='reserved'))throw Error('ENGINE MOCK预留存储失败');await save(state);};
    await assert.rejects(f.core.query(f.book.id,'ENGINE MOCK预留写盘窗口。',{memoryAllowed:false}),/预留存储失败/);assert.equal(calls,0);const u=f.state.usage[0];assert.equal(u.status,'failed');assert.equal(u.dispatchState,'not-dispatched');assert.equal(u.input+u.output,0);assert.equal(u.cost,0);assert.ok(f.state.chats.some(c=>c.role==='user'));
  }finally{f.store.save=save;f.engine.stop();}
});
