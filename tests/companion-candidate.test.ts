import test from 'node:test';
import assert from 'node:assert/strict';
import {importBook,covers} from '../src/core/books.ts';
import {initialState} from '../src/core/state.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import {ChatModel} from '../src/core/model.ts';
import {HarnessRuntime} from '../src/agent/runtime.ts';
import {searchOriginalHistory,searchText} from '../src/core/context.ts';
import {readingAgentTools} from '../src/core/reading-agent.ts';
import {focusedExpressionReminder} from '../src/core/reading-output.ts';
import {restoreBackup} from '../src/core/backup.ts';
import {recoverInterruptedState} from '../src/core/startup.ts';
import type {State,Store} from '../src/core/types.ts';

const body='ENGINE MOCK complete understanding; initial registration and later validation are separate.';
const reaction='ENGINE MOCK validation pending.';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return{promise,resolve};};
let toolId=0;
const packet=(...pairs:[string,unknown][])=>({status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:'',tool_calls:pairs.map(([name,args])=>({id:'candidate-tool-'+(++toolId),type:'function',function:{name,arguments:JSON.stringify(args)}}))}}],usage:{prompt_tokens:17,completion_tokens:9}}});
const finish=()=>packet(['finish_reading',{text:body}]);
async function fixture(respond:(request:any)=>any|Promise<any>,quiet=false){
  const state=initialState(),book=await importBook('ENGINE MOCK candidate','第一章 登记\nENGINE MOCK registration.\n第二章 校准\nENGINE MOCK validation remains pending.\n第三章 未读\nUNREAD-CANDIDATE-SECRET');
  state.books=[book];book.readingStrategy='companion';book.known=[{start:0,end:book.chapters[0].end}];book.prepared=structuredClone(book.known);book.position=book.chapters[0].end;
  state.settings.services[0].enabled=true;state.settings.tokenLimit=3000000;state.settings.minReadChars=1;state.settings.minReactionMs=0;state.settings.defaultQuiet=quiet;
  let disk=structuredClone(state),saveHook:(s:State)=>Promise<void>=async()=>{};
  const requests:any[]=[],store:Store={async load(){return structuredClone(disk);},async save(s){await saveHook(s);disk=structuredClone(s);}};
  const model=new ChatModel(async request=>{requests.push(request);assert.ok(!JSON.stringify(request.body).includes('UNREAD-CANDIDATE-SECRET'));return respond(request);});
  const attach=(saved:State)=>{const engine=new ReadingEngine(saved,store,model),runtime=new HarnessRuntime(),shown:string[]=[];engine.agent=runtime;engine.companionCandidate={earlyReaction:true,historicalSearch:true,focusedExpression:true};engine.onReaction=text=>shown.push(text);return{engine,runtime,shown,async close(){engine.stop();await runtime.dispose();}};};
  const first=attach(state);await first.engine.startReading(book.id);
  return{state,book,first,attach,requests,setSaveHook(fn:typeof saveHook){saveHook=fn;},get disk(){return structuredClone(disk);},async readNext(){first.engine.observing(true);const c=book.chapters[1];await first.engine.observe(book.id,book.text.slice(c.start,c.end),'body','continuous-page');return c;}};
}
test('候选提前反应持久交付后同任务继续finish；自身Chat不提前prepared或使工作台失效',async()=>{
  const second=deferred(),release=deferred();let turn=0;const f=await fixture(async request=>{if(++turn===1)return packet(['react_to_reading',{text:reaction}]);assert.ok(request.body.messages.some((m:any)=>m.tool_calls?.some((c:any)=>c.function.name==='react_to_reading'&&JSON.parse(c.function.arguments).text===reaction)));second.resolve();await release.promise;return finish();});
  const pending=f.readNext();void pending.catch(()=>{});
  try{await second.promise;assert.deepEqual(f.first.shown,[reaction]);assert.equal(f.state.chats[0].readingReaction?.status,'delivered');assert.equal(f.disk.chats[0].readingReaction?.status,'delivered');assert.equal(covers(f.book.prepared,f.book.chapters[1]),false);assert.equal(f.state.memories.length,0);assert.equal(f.state.companionWorkspaces?.[0].understandingId,undefined);release.resolve();await pending;
    assert.equal(f.requests.length,2);assert.equal(f.state.chats.length,1);assert.equal(f.state.memories.filter(m=>m.kind==='opinion'&&m.text===body&&!m.historicalOnly).length,1);assert.ok(covers(f.book.prepared,f.book.chapters[1]));assert.ok(f.state.companionWorkspaces?.[0].understandingId);
  }finally{release.resolve();await Promise.allSettled([pending]);await f.first.close();}
});
test('同包反应与finish只说一次；重复反应、quiet候选不将反应变成交付',async()=>{
  for(const mode of ['single','duplicate','quiet']as const){const f=await fixture(()=>packet(['finish_reading',{text:body}],['react_to_reading',{text:reaction}],...(mode==='duplicate'?[['react_to_reading',{text:reaction}]as[string,unknown]]:[])),mode==='quiet');
    try{await f.readNext();assert.equal(f.state.memories.filter(m=>m.text===body).length,1);assert.equal(f.first.shown.length,mode==='single'?1:0);assert.equal(f.state.chats.filter(c=>!c.excluded).length,mode==='single'?1:0);assert.equal(f.requests.length,1);}finally{await f.first.close();}
  }
});
test('早反应已交付而finish保存失败，冷恢复保原答和费用且不重播反应',async()=>{
  let turn=0;const f=await fixture(()=>++turn===1?packet(['react_to_reading',{text:reaction}]):finish());let next:ReturnType<typeof f.attach>|undefined;
  try{const end=f.book.chapters[0].end;f.setSaveHook(async s=>{if(s.books[0].prepared.some(r=>r.end>end))throw Error('ENGINE MOCK finish save failure');});await assert.rejects(f.readNext(),/finish save failure/);assert.deepEqual(f.first.shown,[reaction]);const saved=f.disk,usage=JSON.stringify(saved.usage);assert.equal(saved.chats.length,1);await f.first.close();f.setSaveHook(async()=>{});recoverInterruptedState(saved);next=f.attach(saved);await next.engine.startReading(f.book.id);await next.engine.prepare(f.book.id);assert.equal(f.requests.length,2);assert.equal(JSON.stringify(saved.usage),usage);assert.deepEqual(next.shown,[]);assert.equal(saved.chats.filter(c=>c.readingReaction?.status==='delivered').length,1);assert.equal(saved.memories.filter(m=>m.text===body).length,1);
  }finally{await(next??f.first).close();}
});
test('磁盘放行期间quiet或翻页改变，只保被抑制记录，完整理解继续',async()=>{
  for(const change of ['quiet','position']as const){const entering=deferred(),release=deferred();let held=false,turn=0;const f=await fixture(()=>++turn===1?packet(['react_to_reading',{text:reaction}]):finish());
    f.setSaveHook(async s=>{if(!held&&s.chats.some(c=>c.readingReaction?.status==='delivered')){held=true;entering.resolve();await release.promise;}});const pending=f.readNext();void pending.catch(()=>{});
    try{await entering.promise;if(change==='quiet')f.first.engine.quiet(true);else f.book.position=f.book.chapters[0].end;release.resolve();await pending;assert.deepEqual(f.first.shown,[]);assert.equal(f.state.chats[0].readingReaction?.status,'suppressed');assert.equal(f.state.chats[0].excluded,true);assert.equal(f.state.memories.filter(m=>m.text===body).length,1);}finally{release.resolve();await Promise.allSettled([pending]);await f.first.close();}
  }
});
test('前台插话优先于在途早反应，后台同任务保活但不绕过新对话版本发言',async()=>{
  const firstRead=deferred(),releaseRead=deferred();let reads=0;const f=await fixture(async request=>{
    if(request.body.messages.some((m:any)=>m.content.includes('"task":"conversation"')))return{status:200,body:{choices:[{finish_reason:'stop',message:{content:'ENGINE MOCK foreground answer.'}}],usage:{prompt_tokens:13,completion_tokens:7}}};
    if(++reads===1){firstRead.resolve();await releaseRead.promise;return packet(['react_to_reading',{text:reaction}]);}return finish();
  });const pending=f.readNext();void pending.catch(()=>{});
  try{await firstRead.promise;const foreground=f.first.engine.ask(f.book.id,'核对当前登记状态。');await foreground;releaseRead.resolve();await pending;assert.deepEqual(f.first.shown,[]);assert.equal(f.state.chats.find(c=>c.readingReaction)?.readingReaction?.status,'suppressed');assert.ok(f.state.chats.some(c=>c.role==='assistant'&&c.text==='ENGINE MOCK foreground answer.'));assert.equal(f.state.memories.filter(m=>m.text===body).length,1);assert.equal(f.requests.length,3);}finally{releaseRead.resolve();await Promise.allSettled([pending]);await f.first.close();}
});
test('备份核早反应原raw、状态和任务身份；已保存未放行不作正常历史',async()=>{
  const f=await fixture(()=>packet(['finish_reading',{text:body}],['react_to_reading',{text:reaction}]));try{await f.readNext();const raw=JSON.stringify(f.disk);const restored=await restoreBackup(raw,initialState());assert.equal(restored.chats[0].readingReaction?.status,'delivered');const corrupt=JSON.parse(raw);corrupt.chats[0].readingReaction.raw=JSON.stringify({text:'WRONG'});await assert.rejects(restoreBackup(JSON.stringify(corrupt),initialState()),/反应/);corrupt.chats[0]=JSON.parse(raw).chats[0];corrupt.chats[0].readingReaction.status='saved';await assert.rejects(restoreBackup(JSON.stringify(corrupt),initialState()),/状态/);}finally{await f.first.close();}
});
test('早反应已保存而放行保存失败，保持excluded/saved并继续完整看法',async()=>{
  let turn=0;const f=await fixture(()=>++turn===1?packet(['react_to_reading',{text:reaction}]):finish());
  try{f.setSaveHook(async s=>{if(s.chats.some(c=>c.readingReaction?.status==='delivered'))throw Error('ENGINE MOCK release save failure');});await f.readNext();assert.deepEqual(f.first.shown,[]);assert.equal(f.state.chats[0].readingReaction?.status,'saved');assert.equal(f.state.chats[0].excluded,true);assert.equal(f.state.memories.filter(m=>m.text===body).length,1);assert.equal(f.requests.length,2);f.first.engine.stop();await f.first.engine.persist();assert.equal(f.disk.chats[0].readingReaction?.status,'suppressed');assert.equal(f.disk.chats[0].delivery,'stopped');const restored=await restoreBackup(JSON.stringify(f.disk),initialState());assert.equal(restored.chats[0].excluded,true);assert.equal(restored.chats[0].readingReaction?.status,'suppressed');}finally{await f.first.close();}
});
test('已有早反应但下一次模型结果未知，原unknown保留且冷启动准备不自动重问',async()=>{
  let turn=0;const f=await fixture(()=>{if(++turn===1)return packet(['react_to_reading',{text:reaction}]);throw Error('ENGINE MOCK dispatch outcome unknown');});let next:ReturnType<typeof f.attach>|undefined;
  try{await assert.rejects(f.readNext());assert.deepEqual(f.first.shown,[reaction]);assert.equal(f.state.memories.length,0);const saved=f.disk,unknown=JSON.stringify(saved.usage.filter(u=>u.status==='unknown'));assert.ok(saved.usage.some(u=>u.status==='unknown'));await f.first.close();recoverInterruptedState(saved);next=f.attach(saved);await next.engine.startReading(f.book.id);await assert.rejects(next.engine.prepare(f.book.id),/结果或结算尚未确定/);assert.equal(f.requests.length,2);assert.equal(JSON.stringify(saved.usage.filter(u=>u.status==='unknown')),unknown);assert.deepEqual(next.shown,[]);}finally{await(next??f.first).close();}
});
test('反应回执到达前撤回新段许可，不向实际聊天或通知放行',async()=>{
  const started=deferred(),release=deferred();let turn=0;const f=await fixture(async()=>{if(++turn===1){started.resolve();await release.promise;return packet(['react_to_reading',{text:reaction}]);}return finish();});const pending=f.readNext();void pending.catch(()=>{});
  try{await started.promise;f.book.known=[{start:0,end:f.book.chapters[0].end}];release.resolve();await assert.rejects(pending);assert.deepEqual(f.first.shown,[]);assert.equal(f.state.chats.filter(c=>!c.excluded).length,0);assert.ok(!covers(f.book.prepared,f.book.chapters[1]));}finally{release.resolve();await Promise.allSettled([pending]);await f.first.close();}
});
test('历史原文按事件来源顺序有界续页，范围/许可空洞保持，旧query-only不变',async()=>{
  const paragraphs=Array.from({length:14},(_,i)=>`历史事件记录${i}。${'x'.repeat(440)}\n`).join('');const book=await importBook('ENGINE MOCK history',paragraphs+'未读秘密历史事件');book.frontMatterIncluded=true;book.known=[{start:0,end:paragraphs.length}];
  const first=searchOriginalHistory(book,{query:'历史事件'});assert.equal(first.items.length,5);assert.ok(first.nextCursor);assert.ok(first.items[0].text.includes('记录0'));const next=searchOriginalHistory(book,{query:'历史事件',cursor:first.nextCursor});assert.ok(!next.items.some(h=>first.items.some(a=>a.evidence.start===h.evidence.start)));assert.ok(first.items.every(h=>h.evidence.end<=paragraphs.length));assert.ok(searchText(book,'历史事件')[0].evidence.start>first.items[0].evidence.start);
  assert.throws(()=>searchOriginalHistory(book,{query:'记录',cursor:first.nextCursor}),/条件/);assert.throws(()=>searchOriginalHistory(book,{query:'历史事件',order:'source-desc',cursor:first.nextCursor}),/条件/);
  const gapStart=500,gapEnd=1000;book.known=[{start:0,end:gapStart},{start:gapEnd,end:paragraphs.length}];assert.throws(()=>searchOriginalHistory(book,{query:'历史事件',cursor:first.nextCursor}),/权限/);
  const range={start:490,end:1020},scoped=searchOriginalHistory(book,{query:'历史事件',range});assert.ok(scoped.items.every(h=>h.evidence.end<=gapStart||h.evidence.start>=gapEnd));assert.ok(scoped.items.every(h=>h.evidence.start>=range.start&&h.evidence.end<=range.end));
  const oldTools=readingAgentTools(async()=>[],{search:false,page:false},{readingStrategy:'companion'});assert.ok(!oldTools.some(t=>t.name==='search_original_history'));const candidate=readingAgentTools(async request=>{assert.ok(request.lookupHistory);return[];},{search:false,page:false},{readingStrategy:'companion',historicalSearch:true});await candidate.find(t=>t.name==='search_original_history')!.execute({query:'历史事件',order:'source-asc'},new AbortController().signal);
});
test('事实长短问可按需校对；纯感受不强制关系协议',()=>{
  assert.ok(focusedExpressionReminder('为什么当晚没有立即上报？'));assert.equal(focusedExpressionReminder('这里给你什么感受？'),undefined);assert.equal(focusedExpressionReminder('是不是很心酸？'),undefined);assert.ok(focusedExpressionReminder('为什么当晚没有立即上报？',true));
});
