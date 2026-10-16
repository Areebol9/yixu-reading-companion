import test from 'node:test';
import assert from 'node:assert/strict';
import { importBook, covers } from '../src/core/books.ts';
import { initialState } from '../src/core/state.ts';
import { ReadingEngine } from '../src/core/engine.ts';
import { ChatModel } from '../src/core/model.ts';
import { ModelRequestError } from '../src/core/errors.ts';
import { HarnessRuntime } from '../src/agent/runtime.ts';
import type { ModelToolCall, State, Store } from '../src/core/types.ts';

const body='  工程完整记录：校准已完成，复测仍在进行，移交条件待核对。\r\n'.repeat(45)+'末行保留。  \n';
let sequence=0;
const rawCall=(name:string,args:string):ModelToolCall=>({id:'empty-reading-'+(++sequence),type:'function',function:{name,arguments:args}});
const call=(name:string,args:unknown)=>rawCall(name,JSON.stringify(args));
const finish=(text=body)=>call('finish_reading',{text});
const natural=(content='',reason='stop')=>({status:200,body:{choices:[{finish_reason:reason,message:{content,reasoning_content:'PRIVATE EMPTY READING REASONING'}}],usage:{prompt_tokens:13,completion_tokens:8}}});
const packet=(...tool_calls:ModelToolCall[])=>({status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:'ENGINE META CANNOT REPLACE MISSING READING',tool_calls}}],usage:{prompt_tokens:13,completion_tokens:8}}});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return{promise,resolve};}
async function fixture(respond:(request:any,turn:number)=>Promise<any>|any){
  const state=initialState(),book=await importBook('缺正文续交工程资料','第一章 登记\n设备已登记，原登记编号为检修甲。\n第二章 复测\n校准已完成，复测仍在进行。\n第三章 未读\nUNREAD-EMPTY-READING');
  state.books=[book];book.readingStrategy='companion';book.known=[{start:0,end:book.chapters[0].end}];book.position=book.chapters[0].end;book.prepared=structuredClone(book.known);
  state.settings.services[0].enabled=true;state.settings.tokenLimit=3000000;state.settings.minReadChars=1;state.settings.defaultQuiet=true;
  let disk=structuredClone(state),saveHook:(s:State)=>Promise<void>=async()=>{};const requests:any[]=[],saves:State[]=[];
  const store:Store={async load(){return structuredClone(disk);},async save(s){await saveHook(s);disk=structuredClone(s);saves.push(structuredClone(s));}};
  const model=new ChatModel(async request=>{requests.push(request);assert.equal(JSON.stringify(request.body).includes('UNREAD-EMPTY-READING'),false);return respond(request,requests.length);});
  const engine=new ReadingEngine(state,store,model),runtime=new HarnessRuntime();engine.agent=runtime;await engine.startReading(book.id);
  return{state,book,requests,saves,engine,runtime,setSaveHook(hook:(s:State)=>Promise<void>){saveHook=hook;},get disk(){return structuredClone(disk);},async close(){engine.stop();await runtime.dispose();}};
}
async function readNext(f:Awaited<ReturnType<typeof fixture>>){f.engine.observing(true);const page=f.book.chapters[1];await f.engine.observe(f.book.id,f.book.text.slice(page.start,page.end),'body','continuous-page');return page;}
function checkBody(f:Awaited<ReturnType<typeof fixture>>){assert.equal(f.state.memories.length,1);assert.ok(Buffer.from(f.state.memories[0].text).equals(Buffer.from(body)));assert.equal(f.state.memories[0].kind,'opinion');assert.equal(f.state.chats.length,0);assert.equal(JSON.stringify(f.state).includes('PRIVATE EMPTY READING REASONING'),false);}
function checkUsage(f:Awaited<ReturnType<typeof fixture>>,count:number){assert.equal(f.state.usage.length,count);assert.ok(f.state.usage.every(u=>u.status==='complete'&&u.dispatchState==='response-received'&&u.input===13&&u.output===8&&!u.estimated));assert.equal(new Set(f.state.usage.map(u=>u.id)).size,count);assert.equal(new Set(f.state.usage.map(u=>u.requestKey)).size,1);}

test('明确空stop和唯一空finish在同一阅读任务续交正文，两笔实际用量分别保存',async()=>{
  for(const empty of [natural('  \r\n'),packet(call('finish_reading',{})),packet(call('finish_reading',{text:' \r\n '}))]){
    const f=await fixture((_request,turn)=>turn===1?empty:packet(finish()));
    try{const page=await readNext(f);checkBody(f);checkUsage(f,2);assert.equal(f.requests.length,2);assert.ok(covers(f.book.prepared,page));assert.ok(f.saves.some(s=>s.usage.length===1&&s.usage[0].status==='complete'),'原空答须先结算再续交');assert.equal(f.state.readings?.at(-1)?.draftId,f.state.usage[1].id);assert.ok(f.requests[1].body.messages.filter((m:any)=>m.role==='user').length>f.requests[0].body.messages.filter((m:any)=>m.role==='user').length,'同一任务增加完成反馈');}
    finally{await f.close();}
  }
});

test('缺正文续交保留原取材工具结果和身份，不重做已取得原文',async()=>{
  let f:Awaited<ReturnType<typeof fixture>>;
  f=await fixture((request,turn)=>{
    if(turn===1)return packet(call('read_original',{start:0,end:f.book.chapters[0].end}));
    const material=request.body.messages.filter((m:any)=>m.role==='tool');assert.ok(material.length);assert.ok(JSON.stringify(material).includes('检修甲'));
    if(turn===2)return packet(call('finish_reading',{}));
    const prior=f.requests[1].body.messages.filter((m:any)=>m.role==='tool');assert.deepEqual(material.slice(0,prior.length),prior);assert.ok(request.body.messages.some((m:any)=>m.role==='assistant'&&m.tool_calls?.some((c:any)=>c.function.name==='read_original')));assert.equal(f.state.memories.length,0);return natural(body);
  });
  try{await readNext(f);checkBody(f);checkUsage(f,3);assert.equal(f.requests.length,3);assert.deepEqual(f.state.usage[0].modelTools,['read_original']);assert.equal(f.requests[2].body.messages.filter((m:any)=>m.role==='assistant').flatMap((m:any)=>m.tool_calls??[]).filter((c:any)=>c.function.name==='read_original').length,1);}
  finally{await f.close();}
});

test('缺正文仍受原任务六次额度约束，耗尽后不发第七次且阶段未完成',async()=>{
  const f=await fixture((_request,turn)=>turn%2?natural():packet(call('finish_reading',{})));
  try{const prepared=structuredClone(f.book.prepared);await assert.rejects(readNext(f));assert.equal(f.requests.length,6);checkUsage(f,6);assert.equal(f.state.memories.length,0);assert.equal(f.state.chats.length,0);assert.deepEqual(f.book.prepared,prepared);}
  finally{await f.close();}
});

test('未知结算、length、损坏JSON、重复finish及非空非法正文停止，不自动续交',async()=>{
  const invalid=[
    {name:'unknown',respond:()=>{throw new ModelRequestError('FIXED UNKNOWN RESPONSE','unknown');},status:'unknown'},
    {name:'length',respond:()=>natural('', 'length'),status:'complete'},
    {name:'unaccounted-empty',respond:()=>({...natural(),body:{...natural().body,usage:{}}}),status:'complete'},
    {name:'malformed',respond:()=>packet(rawCall('finish_reading','{"text":"词法尚未完整')),status:'complete'},
    {name:'duplicate',respond:()=>packet(call('finish_reading',{}),finish()),status:'complete'},
    {name:'wrongtype',respond:()=>packet(call('finish_reading',{text:{record:'非空对象'}})),status:'complete'},
    {name:'extra-field',respond:()=>packet(call('finish_reading',{text:body,reply:'非法主字段'})),status:'complete'},
    {name:'overlimit',respond:()=>packet(finish('检'.repeat(12001))),status:'complete'},
    {name:'stop-malformed',respond:()=>natural('{"text":"词法尚未完整'),status:'complete'},
    {name:'stop-object-without-text',respond:()=>natural('{}'),status:'complete'},
    {name:'empty-extra-field',respond:()=>packet(call('finish_reading',{text:'',reply:'非法主字段'})),status:'complete'},
  ];
  for(const item of invalid){const f=await fixture(item.respond);try{const prepared=structuredClone(f.book.prepared);await assert.rejects(readNext(f));assert.equal(f.requests.length,1,item.name+'不得自动续交');assert.equal(f.state.usage.length,1);assert.equal(f.state.usage[0].status,item.status);assert.equal(f.state.memories.length,0);assert.equal(f.state.chats.length,0);assert.deepEqual(f.book.prepared,prepared);}finally{await f.close();}}
});

test('空答已结算但反馈前取消，保存原用量且不派发续交',async()=>{
  for(const empty of [natural(),packet(call('finish_reading',{}))]){
    const entered=deferred(),release=deferred(),f=await fixture(()=>empty);let held=false,pending:Promise<unknown>|undefined;
    try{f.setSaveHook(async s=>{if(!held&&s.usage[0]?.status==='complete'){held=true;entered.resolve();await release.promise;}});pending=readNext(f);void pending.catch(()=>{});await entered.promise;f.engine.stop();release.resolve();await assert.rejects(pending);assert.equal(f.requests.length,1);checkUsage(f,1);assert.equal(f.disk.usage[0].status,'complete');assert.equal(f.state.memories.length,0);assert.equal(f.state.chats.length,0);}
    finally{release.resolve();if(pending)await Promise.allSettled([pending]);await f.close();}
  }
});

test('真实问答不启用阅读缺正文续交，空stop停止并保留原读者问题',async()=>{
  const f=await fixture(request=>{assert.equal(request.body.tools.some((t:any)=>t.function.name==='finish_reading'),false);return natural();});
  try{await assert.rejects(f.engine.ask(f.book.id,'核对登记编号。'));assert.equal(f.requests.length,1);assert.equal(f.state.usage[0].status,'complete');assert.equal(f.state.chats.length,1);assert.equal(f.state.chats[0].role,'user');assert.equal(f.state.chats[0].delivery,'failed');assert.equal(f.state.memories.length,0);}
  finally{await f.close();}
});
