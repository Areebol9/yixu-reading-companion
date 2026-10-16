import test from 'node:test';
import assert from 'node:assert/strict';
import { importBook, covers } from '../src/core/books.ts';
import { initialState } from '../src/core/state.ts';
import { ReadingEngine } from '../src/core/engine.ts';
import { ChatModel } from '../src/core/model.ts';
import { HarnessRuntime } from '../src/agent/runtime.ts';
import { recoverInterruptedState } from '../src/core/startup.ts';
import { workspaceFor } from '../src/core/companion-workspace.ts';
import { evidence } from '../src/core/context.ts';
import type { ModelToolCall, ReadingStrategy, State, Store } from '../src/core/types.ts';

const body='  工程阅读正文：校准已经完成，复测仍在进行；移交条件继续核对。\r\n'.repeat(60)+'末行保留空格。  \n';
const meta='ENGINE EXIT METADATA: tool-call说明不能成为阅读正文。';
const story='设备校准已完成，复测仍在进行。';
let sequence=0;
const rawCall=(name:string,args:string):ModelToolCall=>({id:'reading-exit-tool-'+(++sequence),type:'function',function:{name,arguments:args}});
const call=(name:string,args:unknown)=>rawCall(name,JSON.stringify(args));
const finish=(text=body)=>call('finish_reading',{text});
const packet=(...calls:ModelToolCall[])=>({status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:meta,reasoning_content:'PRIVATE READING EXIT REASONING',tool_calls:calls}}],usage:{prompt_tokens:17,completion_tokens:9}}});
const natural=(content=body)=>({status:200,body:{choices:[{finish_reason:'stop',message:{content,reasoning_content:'PRIVATE READING EXIT REASONING'}}],usage:{prompt_tokens:17,completion_tokens:9}}});
const validProposal=()=>({reply:'OLD STRUCTURED REPLY MUST NOT BECOME PRIMARY',thoughts:[{kind:'story',text:story,quoteSource:'p1'}],reinforce:[],wantsLong:false});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return{promise,resolve};}

async function fixture(respond:(request:any)=>Promise<any>|any,strategy:ReadingStrategy='companion'){
  const state=initialState(),book=await importBook('独立阅读出口工程资料','第一章 登记\n设备已登记，校准尚待完成。\n第二章 复测\n设备校准已完成，复测仍在进行。\n第三章 未读\nUNREAD-READING-EXIT');
  state.books=[book];book.readingStrategy=strategy;book.narrativeMode='legacy';book.known=[{start:0,end:book.chapters[0].end}];book.position=book.chapters[0].end;book.prepared=structuredClone(book.known);
  state.settings.services[0].enabled=true;state.settings.tokenLimit=3000000;state.settings.minReadChars=1;state.settings.defaultQuiet=true;
  let disk=structuredClone(state);const requests:any[]=[],saves:State[]=[];
  const store:Store={async load(){return structuredClone(disk);},async save(s){disk=structuredClone(s);saves.push(structuredClone(s));}};
  const model=new ChatModel(async request=>{requests.push(request);assert.equal(JSON.stringify(request.body).includes('UNREAD-READING-EXIT'),false);return respond(request);});
  const attach=(saved:State)=>{const engine=new ReadingEngine(saved,store,model),runtime=new HarnessRuntime();engine.agent=runtime;return{engine,runtime,async close(){engine.stop();await runtime.dispose();}};};
  const first=attach(state);await first.engine.startReading(book.id);
  return{state,book,requests,saves,first,attach,get disk(){return structuredClone(disk);}};
}
async function readNext(f:Awaited<ReturnType<typeof fixture>>){f.first.engine.observing(true);const page=f.book.chapters[1];await f.first.engine.observe(f.book.id,f.book.text.slice(page.start,page.end),'body','continuous-page');return page;}
function checkBody(state:State){const made=state.memories.find(m=>m.kind==='opinion'&&m.text===body);assert.ok(made,'独立阅读正文须逐字保存');assert.ok(Buffer.from(made.text).equals(Buffer.from(body)));assert.equal(state.chats.length,0);assert.equal(state.memories.some(m=>m.kind==='shared'),false);assert.equal(JSON.stringify(state).includes('PRIVATE READING EXIT REASONING'),false);return made;}
function checkDelivery(state:State,proposal:'none'|'accepted'|'rejected'){assert.deepEqual(state.readings?.at(-1)?.delivery,{protocol:'reading-text-v1',proposal});}

test('独立finish正文逐字保存并接当前理解，companion工具清单不要求附加提交',async()=>{
  for(const strategy of ['companion','structured','full-original'] as const){
    const f=await fixture(request=>{
      const tools=request.body.tools.map((t:any)=>t.function.name);assert.ok(tools.includes('finish_reading'));assert.equal(tools.includes('submit_reading'),strategy!=='companion');
      const schema=request.body.tools.find((t:any)=>t.function.name==='finish_reading').function.parameters;assert.deepEqual(Object.keys(schema.properties),['text']);assert.deepEqual(schema.required,['text']);assert.equal(schema.additionalProperties,false);
      return packet(finish());
    },strategy);
    try{
      const page=await readNext(f),made=checkBody(f.state);assert.ok(covers(f.book.prepared,page));assert.equal(f.state.memories.length,1);assert.equal(f.requests.length,1);checkDelivery(f.state,'none');
      if(strategy==='companion')assert.equal(workspaceFor(f.state,f.book).understandingId,made.id);
      const snapshot=f.saves.find(s=>s.readingDrafts?.some(d=>d.association==='ready'));assert.ok(snapshot);assert.deepEqual(snapshot.readingDrafts![0].delivery,{protocol:'reading-text-v1',proposal:'none'});assert.equal(snapshot.readingDrafts![0].material.outputProtocol,'reading-text-v1');
    }finally{await f.first.close();}
  }
});

test('自然stop与完整text对象沿同一独立出口，不把JSON变成旧填表任务',async()=>{
  for(const content of [body,JSON.stringify({text:body})]){
    const f=await fixture(()=>natural(content));
    try{await readNext(f);checkBody(f.state);assert.equal(f.requests.length,1);checkDelivery(f.state,'none');}finally{await f.first.close();}
  }
});

test('legacy与完整原文同包有效附加事实和独立正文都保存，正文不被旧reply替换',async()=>{
  for(const strategy of ['structured','full-original'] as const){
    const f=await fixture(()=>packet(finish(),call('submit_reading',validProposal())),strategy);
    try{await readNext(f);checkBody(f.state);const proposed=f.state.memories.find(m=>m.kind==='story'&&m.text===story);assert.ok(proposed);assert.ok(proposed.sourceQuote);assert.equal(f.state.memories.length,2);assert.equal(f.requests.length,1);checkDelivery(f.state,'accepted');assert.equal(f.state.memories.some(m=>m.text.includes('OLD STRUCTURED REPLY')),false);}finally{await f.first.close();}
  }
});

test('附加坏类型、虚构引文、未知出处与非法发展整体拒绝，主正文不受格式重问影响',async()=>{
  const invalid=[
    {label:'kind',thought:{kind:'thread',text:'INVALID PROPOSAL TYPE'}},
    {label:'quote',thought:{kind:'story',text:'INVALID PROPOSAL QUOTE',quote:'不存在的工程登记内容，未写入当前原文。'}},
    {label:'source',thought:{kind:'story',text:'INVALID PROPOSAL SOURCE',quoteSource:'p999999'}},
    {label:'development',thought:{kind:'opinion',text:'INVALID PROPOSAL DEVELOPMENT',updates:'m999999',updateReason:'未取得的旧认识不能发展'}}
  ];
  for(const item of invalid){
    const proposal={...validProposal(),thoughts:[validProposal().thoughts[0],item.thought]};const f=await fixture(()=>packet(call('submit_reading',proposal),finish()),'structured');
    try{await readNext(f);checkBody(f.state);assert.equal(f.state.memories.length,1,item.label+'须整体拒绝附加操作');assert.equal(f.requests.length,1,item.label+'不能重问有效主正文');checkDelivery(f.state,'rejected');}finally{await f.first.close();}
  }
  const malformed=await fixture(()=>packet(finish(),rawCall('submit_reading','{"reply":"","thoughts":')),'full-original');
  try{await readNext(malformed);checkBody(malformed.state);assert.equal(malformed.state.memories.length,1);assert.equal(malformed.requests.length,1);checkDelivery(malformed.state,'rejected');}finally{await malformed.first.close();}
});

test('超限、损坏或多字段主出口不能由同包说明和旧typed正文代替',async()=>{
  const primary=[JSON.stringify({text:'检'.repeat(12001)}),'{"text":"未完整的工程正文"',JSON.stringify({text:body,reply:'主出口不能夹带旧提交字段'})];
  for(const raw of primary){
    const f=await fixture(()=>packet(rawCall('finish_reading',raw),call('submit_reading',{reply:'旧typed正文不能代替主出口。',thoughts:[{kind:'opinion',text:'旧typed看法也不能代替主出口。'}]})),'structured');
    try{const before=structuredClone(f.book.prepared);await assert.rejects(readNext(f));assert.equal(f.state.memories.length,0);assert.equal(f.state.chats.length,0);assert.deepEqual(f.book.prepared,before);assert.equal(f.requests.length,1,'无效主出口停止，不格式重问或改取说明');}finally{await f.first.close();}
  }
});

test('finish与取材混包仍保持中间阶段，随后独立finish才成为阅读成果',async()=>{
  let step=0;const f=await fixture(request=>{
    if(step++===0)return packet(finish('INTERMEDIATE FINISH TEXT'),call('read_original',{start:0,end:f.book.chapters[0].end}));
    assert.equal(f.state.memories.length,0);assert.equal(f.state.chats.length,0);assert.ok(request.body.messages.some((m:any)=>m.role==='tool'));return packet(finish());
  });
  try{await readNext(f);checkBody(f.state);assert.equal(f.state.memories.length,1);assert.equal(f.requests.length,2);assert.equal(f.state.memories.some(m=>m.text==='INTERMEDIATE FINISH TEXT'),false);assert.equal(f.state.readings?.at(-1)?.draftId,f.state.usage.at(-1)?.id);checkDelivery(f.state,'none');}finally{await f.first.close();}
});

test('同包两个finish不擅选任一正文，原阅读阶段保持未完成',async()=>{
  const f=await fixture(()=>packet(finish('FIRST CONFLICTING BODY'),finish('SECOND CONFLICTING BODY')));
  try{const before=structuredClone(f.book.prepared);await assert.rejects(readNext(f));assert.equal(f.state.memories.length,0);assert.equal(f.state.chats.length,0);assert.deepEqual(f.book.prepared,before);assert.equal(f.requests.length,1,'终态渠道冲突须明确停止');}finally{await f.first.close();}
});

test('原回执保存独立渠道与附加原参数，冷恢复同正文同用量且零追加派发',async()=>{
  for(const proposal of ['none','accepted','rejected'] as const){
    const started=deferred<void>(),release=deferred<void>(),exit=finish();const optional=proposal==='none'?undefined:call('submit_reading',proposal==='accepted'?validProposal():{reply:'',thoughts:[{kind:'story',text:story,quoteSource:'p999999'}]});
    const returned=packet(exit,...(optional?[optional]:[])),f=await fixture(async()=>{started.resolve();await release.promise;return returned;},'full-original');let next:ReturnType<typeof f.attach>|undefined;
    try{
      f.first.engine.observing(true);const page=f.book.chapters[1],pending=f.first.engine.observe(f.book.id,f.book.text.slice(page.start,page.end),'body','continuous-page').then(()=>undefined,e=>e);await started.promise;f.first.engine.stop();release.resolve();assert.ok(await pending);
      const saved=f.disk,receipt=saved.companionReadingReceipts?.[0];assert.ok(receipt);assert.equal(receipt.material.outputProtocol,'reading-text-v1');assert.equal(receipt.candidate.transport,'agent');assert.equal(receipt.candidate.format,'reading-text');assert.equal(receipt.candidate.text,exit.function.arguments);assert.equal(receipt.candidate.proposal,optional?.function.arguments);const usage=JSON.stringify(saved.usage);await f.first.runtime.dispose();
      recoverInterruptedState(saved);next=f.attach(saved);await next.engine.startReading(f.book.id);await next.engine.prepare(f.book.id);checkBody(saved);assert.equal(f.requests.length,1);assert.equal(JSON.stringify(saved.usage),usage);assert.equal(saved.readings?.filter(r=>r.draftId===receipt.id).length,1);assert.ok(covers(saved.books[0].prepared,page));checkDelivery(saved,proposal);assert.equal(saved.memories.length,proposal==='accepted'?2:1);assert.deepEqual(saved.companionReadingReceipts,[]);
    }finally{release.resolve();await(next??f.first).close();}
  }
});

test('独立阅读正文原回执冷接续前撤权，保留渠道原参数且不存正文或重发',async()=>{
  const started=deferred<void>(),release=deferred<void>(),exit=finish(),f=await fixture(async()=>{started.resolve();await release.promise;return packet(exit);});let next:ReturnType<typeof f.attach>|undefined;
  try{
    f.first.engine.observing(true);const page=f.book.chapters[1],pending=f.first.engine.observe(f.book.id,f.book.text.slice(page.start,page.end),'body','continuous-page').then(()=>undefined,e=>e);await started.promise;f.first.engine.stop();release.resolve();assert.ok(await pending);const saved=f.disk,receipt=saved.companionReadingReceipts?.[0];assert.ok(receipt);const usage=JSON.stringify(saved.usage);await f.first.runtime.dispose();saved.books[0].known=[{start:0,end:saved.books[0].chapters[0].end}];
    recoverInterruptedState(saved);next=f.attach(saved);await next.engine.startReading(f.book.id);await assert.rejects(next.engine.prepare(f.book.id));assert.equal(f.requests.length,1);assert.equal(saved.memories.length,0);assert.equal(covers(saved.books[0].prepared,page),false);assert.equal(saved.companionReadingReceipts?.[0].status,'blocked');assert.equal(saved.companionReadingReceipts?.[0].candidate.format,'reading-text');assert.equal(saved.companionReadingReceipts?.[0].candidate.text,exit.function.arguments);assert.equal(JSON.stringify(saved.usage),usage);
  }finally{release.resolve();await(next??f.first).close();}
});
