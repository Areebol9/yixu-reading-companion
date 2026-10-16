import test from 'node:test';
import assert from 'node:assert/strict';
import { importBook, covers } from '../src/core/books.ts';
import { initialState } from '../src/core/state.ts';
import { ReadingEngine } from '../src/core/engine.ts';
import { ChatModel } from '../src/core/model.ts';
import { HarnessRuntime } from '../src/agent/runtime.ts';
import { recoverInterruptedState } from '../src/core/startup.ts';
import type { ModelToolCall, State, Store } from '../src/core/types.ts';

const body='  工程完整看法：登记、校准、复测与移交条件分别核对。\r\n'.repeat(65)+'末行空格保持。  \n';
const closingBody='  工程收尾看法：已读范围和仍需核对的移交条件继续保留。\r\n'+body;
const reaction='复测正在进行，移交条件继续核对。';
const closingReaction='本段先停在复测阶段，移交条件继续保留。';
let sequence=0;
const call=(name:string,args:unknown):ModelToolCall=>({id:'reading-reaction-'+(++sequence),type:'function',function:{name,arguments:JSON.stringify(args)}});
const finish=(text=body)=>call('finish_reading',{text});
const react=(text:unknown=reaction)=>call('react_to_reading',{text});
const packet=(...calls:ModelToolCall[])=>({status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:'ENGINE REACTION META MUST NOT BECOME READING OR CHAT',reasoning_content:'PRIVATE REACTION REASONING',tool_calls:calls}}],usage:{prompt_tokens:17,completion_tokens:9}}});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return{promise,resolve};}

async function fixture(respond:(request:any)=>Promise<any>|any,quiet=false){
  const state=initialState(),book=await importBook('阅读主动反应工程资料','第一章 登记\n设备已登记，校准尚待完成。\n第二章 复测\n设备校准已完成，复测仍在进行。\n第三章 未读\nUNREAD-REACTION-TEST');
  state.books=[book];book.readingStrategy='companion';book.known=[{start:0,end:book.chapters[0].end}];book.position=book.chapters[0].end;book.prepared=structuredClone(book.known);
  state.settings.services[0].enabled=true;state.settings.tokenLimit=3000000;state.settings.minReadChars=1;state.settings.minReactionMs=0;state.settings.defaultQuiet=quiet;
  let disk=structuredClone(state),failure:(s:State)=>boolean=()=>false,saveHook:(s:State)=>Promise<void>=async()=>{};const requests:any[]=[],saves:State[]=[];
  const store:Store={async load(){return structuredClone(disk);},async save(s){await saveHook(s);if(failure(s))throw Error('REACTION FINAL COMMIT FAILURE');disk=structuredClone(s);saves.push(structuredClone(s));}};
  const model=new ChatModel(async request=>{requests.push(request);assert.equal(JSON.stringify(request.body).includes('UNREAD-REACTION-TEST'),false);return respond(request);});
  const attach=(saved:State)=>{const engine=new ReadingEngine(saved,store,model),runtime=new HarnessRuntime(),shown:string[]=[];engine.agent=runtime;engine.onReaction=text=>shown.push(text);return{engine,runtime,shown,async close(){engine.stop();await runtime.dispose();}};};
  const first=attach(state);await first.engine.startReading(book.id);
  return{state,book,requests,saves,first,attach,setFailure(fn:(s:State)=>boolean){failure=fn;},setSaveHook(fn:(s:State)=>Promise<void>){saveHook=fn;},get disk(){return structuredClone(disk);}};
}
async function readNext(f:Awaited<ReturnType<typeof fixture>>){f.first.engine.observing(true);const page=f.book.chapters[1];await f.first.engine.observe(f.book.id,f.book.text.slice(page.start,page.end),'body','continuous-page');return page;}
function checkBody(state:State,text=body){assert.ok(state.memories.some(m=>m.kind==='opinion'&&Buffer.from(m.text).equals(Buffer.from(text))),'完整看法须逐字独立保存');assert.equal(state.chats.some(c=>c.role==='user'),false);assert.equal(state.memories.some(m=>m.kind==='shared'||m.kind==='user'),false);}
function reactionTool(request:any){return request.body.tools.some((t:any)=>t.function.name==='react_to_reading');}

test('非安静真实跟读送达短反应，收尾也可表达，完整看法仍逐字独立保存',async()=>{
  let closing=false;const f=await fixture(request=>{assert.equal(reactionTool(request),true);return packet(finish(closing?closingBody:body),react(closing?closingReaction:reaction));});
  try{
    await readNext(f);checkBody(f.state);assert.deepEqual(f.first.shown,[reaction]);assert.deepEqual(f.state.chats.map(c=>[c.role,c.text]),[['assistant',reaction]]);
    closing=true;await f.first.engine.finishReading(f.book.id);checkBody(f.state,closingBody);assert.equal(f.state.chats.at(-1)?.text,closingReaction);assert.equal(f.state.chats.filter(c=>c.role==='assistant').length,2);assert.equal(f.requests.length,2);
  }finally{await f.first.close();}
});

test('安静跟读和普通前文准备均不送达反应，正文仍保存',async()=>{
  const quiet=await fixture(request=>{assert.equal(reactionTool(request),false);return packet(finish(),react());},true);
  try{await readNext(quiet);checkBody(quiet.state);assert.deepEqual(quiet.first.shown,[]);assert.equal(quiet.state.chats.length,0);assert.equal(quiet.requests.length,1);}finally{await quiet.first.close();}
  const preparation=await fixture(request=>{assert.equal(reactionTool(request),false);return packet(finish());});
  try{preparation.book.prepared=[];await preparation.first.engine.prepare(preparation.book.id);checkBody(preparation.state);assert.deepEqual(preparation.first.shown,[]);assert.equal(preparation.state.chats.length,0);assert.equal(preparation.requests.length,1);}finally{await preparation.first.close();}
});

test('空、坏类型或同包重复反应整体拒绝，完整正文不丢且不格式重问',async()=>{
  for(const kind of ['empty','bad-type','duplicate'] as const){
    const f=await fixture(()=>packet(finish(),...(kind==='duplicate'?[react(),react('第二条冲突反应。')]:[react(kind==='empty'?'':{text:'错误内嵌对象'})])));
    try{await readNext(f);checkBody(f.state);assert.equal(f.state.chats.length,0);assert.deepEqual(f.first.shown,[]);assert.equal(f.requests.length,1,kind+'不能为修反应重问完整正文');}finally{await f.first.close();}
  }
});

test('原raw反应冷接续保完整正文和用量，当前安静或位置已变不补发过时反应',async()=>{
  for(const current of ['quiet','earlier-position'] as const){
    const started=deferred<void>(),release=deferred<void>(),exit=finish(),response=react(),returned=packet(exit,response);
    const f=await fixture(async()=>{started.resolve();await release.promise;return returned;});let next:ReturnType<typeof f.attach>|undefined;
    try{
      f.first.engine.observing(true);const page=f.book.chapters[1],pending=f.first.engine.observe(f.book.id,f.book.text.slice(page.start,page.end),'body','continuous-page').then(()=>undefined,e=>e);await started.promise;f.first.engine.stop();release.resolve();assert.ok(await pending);assert.deepEqual(f.first.shown,[]);
      const saved=f.disk,receipt=saved.companionReadingReceipts?.[0];assert.ok(receipt);const candidate=receipt.candidate as typeof receipt.candidate&{reaction?:string},material=receipt.material as typeof receipt.material&{outputReactionAllowed?:boolean};assert.equal(candidate.format,'reading-text');assert.equal(candidate.text,exit.function.arguments);assert.equal(candidate.reaction,response.function.arguments);assert.equal(material.outputReactionAllowed,true);const usage=JSON.stringify(saved.usage);await f.first.runtime.dispose();
      if(current==='quiet')saved.settings.defaultQuiet=true;else saved.books[0].position=saved.books[0].chapters[0].end;
      recoverInterruptedState(saved);next=f.attach(saved);await next.engine.startReading(f.book.id);await next.engine.prepare(f.book.id);checkBody(saved);assert.equal(f.requests.length,1);assert.equal(JSON.stringify(saved.usage),usage);assert.equal(saved.chats.length,0);assert.deepEqual(next.shown,[]);assert.ok(covers(saved.books[0].prepared,page));
      next.engine.observing(true);const visible=current==='quiet'?saved.books[0].chapters[1]:saved.books[0].chapters[0];await next.engine.observe(f.book.id,f.book.text.slice(visible.start,visible.end),'body','continuous-page');assert.equal(f.requests.length,1);assert.equal(saved.chats.length,0);assert.deepEqual(next.shown,[]);
    }finally{release.resolve();await(next??f.first).close();}
  }
});

test('ready草稿保留原反应但最终保存失败未先表达，冷恢复当前安静只补完整看法',async()=>{
  const f=await fixture(()=>packet(finish(),react()));let next:ReturnType<typeof f.attach>|undefined;
  try{
    const before=f.book.prepared[0].end;f.setFailure(s=>s.readings?.some(r=>r.source==='reading'&&r.ranges.some(x=>x.end>before))??false);
    await assert.rejects(readNext(f),/REACTION FINAL COMMIT FAILURE/);assert.equal(f.state.memories.length,0);assert.equal(f.state.chats.length,0);assert.deepEqual(f.first.shown,[]);
    const saved=f.disk,draft=saved.readingDrafts?.[0];assert.equal(draft?.association,'ready');assert.equal(draft?.result.reply,reaction);const draftId=draft!.id,usage=JSON.stringify(saved.usage);await f.first.close();f.setFailure(()=>false);saved.settings.defaultQuiet=true;recoverInterruptedState(saved);next=f.attach(saved);await next.engine.startReading(f.book.id);await next.engine.prepare(f.book.id);
    checkBody(saved);assert.equal(f.requests.length,1);assert.equal(JSON.stringify(saved.usage),usage);assert.equal(saved.readings?.filter(r=>r.draftId===draftId).length,1);assert.equal(saved.chats.length,0);assert.deepEqual(next.shown,[]);
  }finally{await(next??f.first).close();}
});

test('反应原回执冷恢复前来源撤回，正文和反应都不保存且原问不重发',async()=>{
  const started=deferred<void>(),release=deferred<void>(),response=react(),f=await fixture(async()=>{started.resolve();await release.promise;return packet(finish(),response);});let next:ReturnType<typeof f.attach>|undefined;
  try{
    f.first.engine.observing(true);const page=f.book.chapters[1],pending=f.first.engine.observe(f.book.id,f.book.text.slice(page.start,page.end),'body','continuous-page').then(()=>undefined,e=>e);await started.promise;f.first.engine.stop();release.resolve();assert.ok(await pending);const saved=f.disk;assert.equal(saved.companionReadingReceipts?.length,1);const usage=JSON.stringify(saved.usage);await f.first.runtime.dispose();saved.books[0].known=[{start:0,end:saved.books[0].chapters[0].end}];recoverInterruptedState(saved);next=f.attach(saved);await next.engine.startReading(f.book.id);await assert.rejects(next.engine.prepare(f.book.id));
    assert.equal(f.requests.length,1);assert.equal(saved.memories.length,0);assert.equal(saved.chats.length,0);assert.deepEqual(next.shown,[]);assert.equal(saved.companionReadingReceipts?.[0].status,'blocked');assert.equal((saved.companionReadingReceipts?.[0].candidate as {reaction?:string}).reaction,response.function.arguments);assert.equal(JSON.stringify(saved.usage),usage);
  }finally{release.resolve();await(next??f.first).close();}
});

test('最终保存期间切入安静模式仍抑制迟到onReaction，自己的提交不绕过当前quiet',async()=>{
  const entered=deferred<void>(),release=deferred<void>(),f=await fixture(()=>packet(finish(),react()));let held=false,pending:Promise<unknown>|undefined;
  try{
    const initialEnd=f.book.chapters[0].end;
    f.setSaveHook(async s=>{if(!held&&s.readings?.some(r=>r.source==='reading'&&r.ranges.some(x=>x.end>initialEnd))){held=true;entered.resolve();await release.promise;}});
    pending=readNext(f);void pending.catch(()=>{});await entered.promise;assert.deepEqual(f.first.shown,[]);f.first.engine.quiet(true);release.resolve();await pending;
    checkBody(f.state);assert.equal(f.requests.length,1);assert.deepEqual(f.first.shown,[]);assert.equal(f.first.engine.session?.quiet,true);
  }finally{release.resolve();await f.first.close();if(pending)await Promise.allSettled([pending]);}
});
