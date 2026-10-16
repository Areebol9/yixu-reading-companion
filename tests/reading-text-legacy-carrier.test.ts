import test from 'node:test';
import assert from 'node:assert/strict';
import { importBook, covers } from '../src/core/books.ts';
import { initialState } from '../src/core/state.ts';
import { ReadingEngine } from '../src/core/engine.ts';
import { ChatModel } from '../src/core/model.ts';
import { HarnessRuntime } from '../src/agent/runtime.ts';
import { recoverInterruptedState } from '../src/core/startup.ts';
import { correctMemory, evidence } from '../src/core/context.ts';
import type { ModelToolCall, ReadingStrategy, State, Store } from '../src/core/types.ts';
const body='  工程完整阅读：设备校准完成，复测仍在进行，移交条件须继续核对。\r\n'.repeat(70)+'末行保持空格。  \n';
const story='设备校准已完成，复测仍在进行。';
let sequence=0;
const rawCall=(name:string,args:string):ModelToolCall=>({id:'legacy-carrier-'+(++sequence),type:'function',function:{name,arguments:args}});
const call=(name:string,args:unknown)=>rawCall(name,JSON.stringify(args));
const carrier=(extra:Record<string,unknown>={})=>call('submit_reading',{readingBrief:body,reply:'OLD REPLY CANNOT REPLACE BRIEF',thoughts:[],reinforce:[],wantsLong:false,...extra});
const finish=(text=body)=>call('finish_reading',{text});
const packet=(...tool_calls:ModelToolCall[])=>({status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:'ENGINE CARRIER META CANNOT REPLACE BRIEF',reasoning_content:'PRIVATE LEGACY CARRIER REASONING',tool_calls}}],usage:{prompt_tokens:19,completion_tokens:11}}});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return{promise,resolve};}
async function fixture(respond:(request:any,turn:number)=>Promise<any>|any,strategy:ReadingStrategy='structured',withSource=false){
  const state=initialState(),book=await importBook('旧正文承载工程资料','第一章 登记\n设备已登记，校准尚待完成。\n第二章 复测\n设备校准已完成，复测仍在进行。\n第三章 未读\nUNREAD-LEGACY-CARRIER');
  state.books=[book];book.readingStrategy=strategy;book.narrativeMode='legacy';book.known=[{start:0,end:book.chapters[0].end}];book.position=book.chapters[0].end;book.prepared=structuredClone(book.known);
  state.settings.services[0].enabled=true;state.settings.tokenLimit=3000000;state.settings.defaultQuiet=true;state.settings.minReadChars=1;
  if(withSource)state.memories.push({id:'legacy-old-source',bookId:book.id,partnerId:state.partnerId,kind:'opinion',text:'旧工程登记仍需复测核对。',evidence:[evidence(book,book.known[0])],parents:[],chatIds:[],source:'reading',forgotten:false,createdAt:1});
  let disk=structuredClone(state),failure:(s:State)=>boolean=()=>false;const requests:any[]=[],saves:State[]=[];
  const store:Store={async load(){return structuredClone(disk);},async save(s){if(failure(s))throw Error('LEGACY FINAL COMMIT FAILURE');disk=structuredClone(s);saves.push(structuredClone(s));}};
  const model=new ChatModel(async request=>{requests.push(request);assert.equal(JSON.stringify(request.body).includes('UNREAD-LEGACY-CARRIER'),false);return respond(request,requests.length);});
  const attach=(saved:State)=>{const engine=new ReadingEngine(saved,store,model),runtime=new HarnessRuntime();engine.agent=runtime;return{engine,runtime,async close(){engine.stop();await runtime.dispose();}};};
  const first=attach(state);await first.engine.startReading(book.id);
  return{state,book,first,attach,requests,saves,setFailure(fn:(s:State)=>boolean){failure=fn;},get disk(){return structuredClone(disk);}};
}
async function readNext(f:Awaited<ReturnType<typeof fixture>>){f.first.engine.observing(true);const page=f.book.chapters[1];await f.first.engine.observe(f.book.id,f.book.text.slice(page.start,page.end),'body','continuous-page');return page;}
function checkBody(s:State){const opinions=s.memories.filter(m=>m.kind==='opinion'&&Buffer.from(m.text).equals(Buffer.from(body)));assert.equal(opinions.length,1,'显式readingBrief正文逐字只保存一次');assert.equal(s.chats.length,0);assert.equal(s.memories.some(m=>m.kind==='shared'||m.kind==='user'||m.text.includes('ENGINE CARRIER META')),false);assert.equal(JSON.stringify(s).includes('PRIVATE LEGACY CARRIER REASONING'),false);return opinions[0];}
function checkDelivery(s:State,proposal:'accepted'|'rejected'){assert.deepEqual(s.readings?.at(-1)?.delivery,{protocol:'reading-text-v1',proposal});}

test('非companion旧carrier单次完成，原readingBrief空白与CRLF逐字保存不取说明和旧reply',async()=>{
  for(const strategy of ['structured','full-original'] as const){const returned=carrier(),f=await fixture(()=>packet(returned),strategy);try{const page=await readNext(f);checkBody(f.state);checkDelivery(f.state,'accepted');assert.equal(f.state.memories.length,1);assert.equal(f.requests.length,1);assert.ok(covers(f.book.prepared,page));assert.equal(f.state.usage[0].status,'complete');assert.deepEqual(f.state.usage[0].modelTools,['submit_reading']);}finally{await f.first.close();}}
});

test('旧carrier附加坏类型或虚构引用整体拒绝，已完整正文保持一次保存',async()=>{
  for(const thought of [{kind:'thread',text:'非法附加种类'}, {kind:'story',text:story,quote:'不存在于原文的工程移交结论。'}, {kind:'story',text:story,quoteSource:'p999999'}]){
    const f=await fixture(()=>packet(carrier({thoughts:[{kind:'story',text:story,quoteSource:'p1'},thought]})));
    try{await readNext(f);checkBody(f.state);checkDelivery(f.state,'rejected');assert.equal(f.requests.length,1);assert.equal(f.state.memories.length,1,'不能部分执行合法附加项');}finally{await f.first.close();}
  }
});

test('旧carrier合法事实提议与完整正文一起保存，精确引用仍绑定实际原文',async()=>{
  const f=await fixture(()=>packet(carrier({thoughts:[{kind:'story',text:story,quoteSource:'p1'}]})),'full-original');
  try{await readNext(f);checkBody(f.state);checkDelivery(f.state,'accepted');const fact=f.state.memories.find(m=>m.kind==='story');assert.equal(fact?.text,story);assert.ok(fact?.sourceQuote?.text.includes(story));assert.equal(f.state.memories.length,2);assert.equal(f.requests.length,1);}finally{await f.first.close();}
});

test('旧carrier合法发展自己的已提供观点，版本变化和完整正文一起保存',async()=>{
  const f=await fixture(request=>{
    const packets=request.body.messages.filter((m:any)=>m.role==='user').flatMap((m:any)=>m.content.split('\n\n')).flatMap((text:string)=>{try{return[JSON.parse(text)];}catch{return[];}});
    const prior=packets.flatMap((p:any)=>p.memories??[]).find((m:any)=>m.text==='旧工程登记仍需复测核对。');assert.ok(prior);
    return packet(carrier({thoughts:[{kind:'opinion',text:'当前校准已经完成，复测阶段继续核对移交条件。',basis:{memoryIds:[prior.id],chatIds:[]},updates:prior.id,updateReason:'已读资料明确校准完成，复测仍在进行。'}]}));
  },'structured',true);
  try{await readNext(f);checkBody(f.state);checkDelivery(f.state,'accepted');const prior=f.state.memories.find(m=>m.id==='legacy-old-source')!,developed=f.state.memories.find(m=>m.correctionOf===prior.id);assert.ok(developed);assert.equal(prior.replacedBy,developed.id);assert.equal(developed.revisionKind,'development');assert.equal(f.state.memories.length,3);assert.equal(f.requests.length,1);}finally{await f.first.close();}
});

test('旧carrier原回执及ready草稿冷接续相同正文和用量，零追加调用',async()=>{
  for(const stage of ['raw','ready'] as const){const entered=deferred(),release=deferred(),returned=carrier({thoughts:[{kind:'thread',text:'附加结构应整体拒绝'}]}),f=await fixture(async()=>{if(stage==='raw'){entered.resolve();await release.promise;}return packet(returned);},'full-original');let next:ReturnType<typeof f.attach>|undefined;
    try{
      if(stage==='raw'){f.first.engine.observing(true);const page=f.book.chapters[1],pending=f.first.engine.observe(f.book.id,f.book.text.slice(page.start,page.end),'body','continuous-page').then(()=>undefined,e=>e);await entered.promise;f.first.engine.stop();release.resolve();assert.ok(await pending);}else{const before=f.book.prepared[0].end;f.setFailure(s=>s.readings?.some(r=>r.ranges.some(x=>x.end>before))??false);await assert.rejects(readNext(f),/LEGACY FINAL COMMIT FAILURE/);}
      const saved=f.disk,id=stage==='raw'?saved.companionReadingReceipts?.[0]?.id:saved.readingDrafts?.[0]?.id;assert.ok(id);assert.equal(saved.memories.length,0);const usage=JSON.stringify(saved.usage);
      if(stage==='raw'){const receipt=saved.companionReadingReceipts![0];assert.equal(receipt.candidate.transport,'agent');assert.equal(receipt.candidate.text,returned.function.arguments,'原参数不可修复或重写');assert.equal(receipt.material.outputProtocol,'reading-text-v1');}else{assert.equal(saved.readingDrafts![0].association,'ready');assert.equal(saved.readingDrafts![0].result.thoughts[0].text,body);}
      await f.first.close();f.setFailure(()=>false);recoverInterruptedState(saved);next=f.attach(saved);await next.engine.startReading(f.book.id);await next.engine.prepare(f.book.id);checkBody(saved);checkDelivery(saved,'rejected');assert.equal(f.requests.length,1);assert.equal(JSON.stringify(saved.usage),usage);assert.equal(saved.readings?.filter(r=>r.draftId===id).length,1);assert.equal(saved.companionReadingReceipts?.length,0);assert.equal(saved.readingDrafts?.length,0);
    }finally{release.resolve();await(next??f.first).close();}
  }
});

test('旧carrier原答冷恢复前撤权或更正旧来源，保原答用量而不存正文或重派发',async()=>{
  for(const change of ['revoke','correct'] as const){const entered=deferred(),release=deferred(),returned=carrier(),f=await fixture(async()=>{entered.resolve();await release.promise;return packet(returned);},'structured',true);let next:ReturnType<typeof f.attach>|undefined;
    try{f.first.engine.observing(true);const page=f.book.chapters[1],pending=f.first.engine.observe(f.book.id,f.book.text.slice(page.start,page.end),'body','continuous-page').then(()=>undefined,e=>e);await entered.promise;f.first.engine.stop();release.resolve();assert.ok(await pending);const saved=f.disk;assert.equal(saved.companionReadingReceipts?.length,1);const usage=JSON.stringify(saved.usage);await f.first.close();if(change==='revoke')saved.books[0].known=[{start:0,end:saved.books[0].chapters[0].end}];else correctMemory(saved,'legacy-old-source','旧工程来源已被读者更正。');recoverInterruptedState(saved);next=f.attach(saved);await next.engine.startReading(f.book.id);await assert.rejects(next.engine.prepare(f.book.id));assert.equal(saved.memories.some(m=>m.text===body),false);assert.equal(saved.chats.length,0);assert.equal(f.requests.length,1);assert.equal(JSON.stringify(saved.usage),usage);assert.equal(saved.companionReadingReceipts?.[0].status,'blocked');assert.equal(saved.companionReadingReceipts?.[0].candidate.text,returned.function.arguments);}
    finally{release.resolve();await(next??f.first).close();}
  }
});

test('companion自动不把旧carrier升级为独立阅读正文',async()=>{
  const comp=await fixture((_request,turn)=>turn===1?packet(carrier()):packet(finish()),'companion');
  try{await readNext(comp);checkBody(comp.state);assert.equal(comp.requests.length,2);assert.ok(comp.requests[1].body.messages.some((m:any)=>m.role==='tool'));assert.equal(comp.state.readings?.at(-1)?.draftId,comp.state.usage[1].id);}finally{await comp.first.close();}
});

test('真实QA不以旧carrier的brief冒充回复或完整阅读成果',async()=>{
  const qa=await fixture(()=>{const response=packet(carrier({reply:'',thoughts:[{kind:'thread',text:'QA非法结构'}]}));response.body.choices[0].message.content='';return response;});
  try{await assert.rejects(qa.first.engine.ask(qa.book.id,'核对工程登记。'));assert.equal(qa.requests.length,1);assert.equal(qa.state.memories.length,0);assert.equal(qa.state.chats.length,1);assert.equal(qa.state.chats[0].role,'user');assert.equal(qa.state.chats[0].delivery,'failed');}finally{await qa.first.close();}
});

test('旧carrier同包多个提交或混取材不提前终止，后续独立正文才完成',async()=>{
  for(const mixed of ['duplicate','material'] as const){let f:Awaited<ReturnType<typeof fixture>>;f=await fixture((request,turn)=>{if(turn===1)return mixed==='duplicate'?packet(carrier(),carrier()):packet(carrier(),call('read_original',{start:0,end:f.book.chapters[0].end}));assert.equal(f.state.memories.length,0);assert.ok(request.body.messages.some((m:any)=>m.role==='tool'));return packet(finish());});try{await readNext(f);checkBody(f.state);assert.equal(f.requests.length,2);assert.equal(f.state.readings?.at(-1)?.draftId,f.state.usage[1].id);}finally{await f.first.close();}}
});

test('旧carrier损坏JSON、错误brief类型、空白和超限正文停止且不格式重问',async()=>{
  const invalid=['{"readingBrief":"词法不完整',JSON.stringify({readingBrief:body}).slice(0,-1),JSON.stringify({readingBrief:{text:body}}),JSON.stringify({readingBrief:' \r\n '}),JSON.stringify({readingBrief:'检'.repeat(12001)})];
  for(const raw of invalid){const f=await fixture(()=>packet(rawCall('submit_reading',raw)));try{const before=structuredClone(f.book.prepared);await assert.rejects(readNext(f));assert.equal(f.requests.length,1,'非法旧carrier不得格式重问');assert.equal(f.state.memories.length,0);assert.equal(f.state.chats.length,0);assert.deepEqual(f.book.prepared,before);assert.equal(f.state.usage[0].status,'complete');}finally{await f.first.close();}}
});

test('损坏finish原参数冷接续保持原字节，不能补最后括号接受已拒绝的正文',async()=>{
  const raw=JSON.stringify({text:body}).slice(0,-1),entered=deferred(),release=deferred(),f=await fixture(async()=>{entered.resolve();await release.promise;return packet(rawCall('finish_reading',raw));});let next:ReturnType<typeof f.attach>|undefined;
  try{
    f.first.engine.observing(true);const page=f.book.chapters[1],pending=f.first.engine.observe(f.book.id,f.book.text.slice(page.start,page.end),'body','continuous-page').then(()=>undefined,e=>e);await entered.promise;f.first.engine.stop();release.resolve();assert.ok(await pending);
    const saved=f.disk,receipt=saved.companionReadingReceipts?.[0];assert.ok(receipt);assert.equal(receipt.candidate.format,'reading-text');assert.equal(receipt.candidate.text,raw);const usage=JSON.stringify(saved.usage);await f.first.close();recoverInterruptedState(saved);next=f.attach(saved);await next.engine.startReading(f.book.id);await assert.rejects(next.engine.prepare(f.book.id));
    assert.equal(saved.memories.length,0);assert.equal(saved.chats.length,0);assert.equal(f.requests.length,1);assert.equal(JSON.stringify(saved.usage),usage);assert.equal(saved.companionReadingReceipts?.[0].candidate.text,raw);assert.equal(saved.companionReadingReceipts?.[0].status,'blocked');
  }finally{release.resolve();await(next??f.first).close();}
});
