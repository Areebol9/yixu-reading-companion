import test from 'node:test';
import assert from 'node:assert/strict';
import { importBook, covers } from '../src/core/books.ts';
import { initialState } from '../src/core/state.ts';
import { ReadingEngine } from '../src/core/engine.ts';
import { ChatModel } from '../src/core/model.ts';
import { HarnessRuntime } from '../src/agent/runtime.ts';
import { recoverInterruptedState } from '../src/core/startup.ts';
import { workspaceFor } from '../src/core/companion-workspace.ts';
import { NativeChannel } from '../src/native/channel.ts';
import { ModelRequestError } from '../src/core/errors.ts';
import { forgetMemory } from '../src/core/context.ts';
import type { Memory, State, Store } from '../src/core/types.ts';

const packets=(body:any)=>body.messages.filter((m:any)=>m.role==='user').flatMap((m:any)=>m.content.split('\n\n')).flatMap((s:string)=>{try{return[JSON.parse(s)];}catch{return[];}});
const main=(body:any)=>packets(body).find((p:any)=>p.currentRange)!;
const tools=(...entries:[string,unknown][])=>({status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:null,reasoning_content:'PRIVATE COMPANION MOCK REASONING',tool_calls:entries.map(([name,args],i)=>({id:'companion-tool-'+i,type:'function',function:{name,arguments:JSON.stringify(args)}}))}}],usage:{prompt_tokens:11,completion_tokens:7}}});
const text=(content:string)=>({status:200,body:{choices:[{finish_reason:'stop',message:{content,reasoning_content:'PRIVATE COMPANION MOCK REASONING'}}],usage:{prompt_tokens:11,completion_tokens:7}}});
const fullUnderstanding='工程记录：校准已完成，复测仍在进行；此前检修登记须接续核对。'.repeat(120);
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return{promise,resolve};}
async function signalWithin(promise:Promise<void>,stage:string){let timer:ReturnType<typeof setTimeout>;try{await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('ENGINE MOCK等待阶段超时：'+stage)),5000);})]);}finally{clearTimeout(timer!);}}

async function fixture(respond:(body:any,signal:AbortSignal)=>Promise<any>|any,native=false){
  const state=initialState(),book=await importBook('伴读正式链路工程资料','第一章 登记\n设备已登记，校准尚待完成。\n第二章 复测\n设备校准已完成，正在进行复测。\n第三章 移交\n复测通过后仍需核对移交条件。\n第四章 未读\nUNREAD-COMPANION-ENGINE');
  state.books=[book];book.known=[{start:0,end:book.chapters[0].end}];book.position=book.chapters[0].end;book.prepared=[...book.known];
  state.settings.services[0].enabled=true;state.settings.tokenLimit=3000000;state.settings.minReadChars=1;state.settings.defaultQuiet=true;
  let disk=structuredClone(state),failure:(s:State)=>boolean=()=>false,saveObserver:(s:State)=>void=()=>{};const saves:State[]=[],requests:any[]=[],cancels:string[]=[],hosts=new Map<string,AbortController>();
  const store:Store={async load(){return structuredClone(disk);},async save(s){if(failure(s))throw Error('ENGINE MOCK COMPANION SAVE FAILURE');disk=structuredClone(s);saves.push(structuredClone(s));saveObserver(s);}};
  const channel=native?new NativeChannel(wire=>{
    const message=JSON.parse(wire);if(message.method==='cancel'){cancels.push(message.payload.id);hosts.get(message.payload.id)?.abort();return;}
    const host=new AbortController();hosts.set(message.id,host);
    void Promise.resolve().then(()=>respond(message.payload.body,host.signal)).then(value=>channel!.receiveValue(message.id,{value}),error=>channel!.receiveValue(message.id,{error:String(error),dispatch:error instanceof ModelRequestError?error.dispatch:'unknown'})).finally(()=>hosts.delete(message.id));
  }):undefined;
  const model=new ChatModel(async (request,signal)=>{requests.push(request);if(main(request.body).workspaceMaterial?.workspace.source!=='background')assert.equal(JSON.stringify(request.body).includes('UNREAD-COMPANION-ENGINE'),false);return channel?channel.request('model',request,signal):respond(request.body,signal);});
  const attach=(s:State)=>{const engine=new ReadingEngine(s,store,model),runtime=new HarnessRuntime();engine.agent=runtime;return{engine,runtime,async close(){engine.stop();await runtime.dispose();}};};
  const first=attach(state);await first.engine.startReading(book.id);
  return{state,book,store,model,attach,first,requests,saves,cancels,get disk(){return structuredClone(disk);},setFailure(fn:(s:State)=>boolean){failure=fn;},onSave(fn:(s:State)=>void){saveObserver=fn;}};
}

test('默认伴读在真实阅读/问答/安静/冷启动中接同一完整理解，未表达私人看法不写共同交流',async()=>{
  let phase='reading';const f=await fixture(body=>{
    if(phase==='reading')return text(fullUnderstanding);
    assert.equal(main(body).workspaceMaterial.understanding.text,fullUnderstanding);
    if(phase==='cold')assert.ok(packets(body).some((p:any)=>p.conversation?.some((c:any)=>c.text==='设备复测仍在进行。')));
    return text(phase==='cold'?'可以继续核对移交条件。':'设备复测仍在进行。');
  });
  let next:ReturnType<typeof f.attach>|undefined;
  try{
    assert.equal(f.first.engine.session?.readingStrategy,'companion');f.first.engine.observing(true);
    const page=f.book.chapters[1];await f.first.engine.observe(f.book.id,f.book.text.slice(page.start,page.end),'body','continuous-page');
    const w=workspaceFor(f.state,f.book),understanding=f.state.memories.find(m=>m.id===w.understandingId)!;
    assert.equal(understanding.text,fullUnderstanding);assert.ok(understanding.text.length>1800);assert.equal(f.state.chats.length,0);assert.equal(f.state.memories.some(m=>m.kind==='shared'),false);
    assert.equal(f.state.readings?.filter(r=>r.processing==='model').length,1);
    phase='ask';await f.first.engine.ask(f.book.id,'现在核对复测进展。');
    assert.equal(f.state.chats.filter(c=>c.role==='user').length,1);assert.equal(f.state.chats.filter(c=>c.role==='assistant').length,1);assert.equal(workspaceFor(f.state,f.book).lastChatId,f.state.chats.at(-1)?.id);
    assert.equal(workspaceFor(f.state,f.book).understandingId,understanding.id);assert.equal(f.state.memories.some(m=>m.kind==='shared'),false);
    const saved=f.disk;await f.first.close();recoverInterruptedState(saved);next=f.attach(saved);phase='cold';await next.engine.startReading(f.book.id);await next.engine.ask(f.book.id,'继续核对同一现场。');
    assert.equal(workspaceFor(saved,saved.books[0]).understandingId,understanding.id);assert.equal(f.requests.length,3);assert.equal(JSON.stringify(saved).includes('PRIVATE COMPANION MOCK REASONING'),false);
  }finally{await (next??f.first).close();}
});

test('工作台关注目录沿正式资料工具完整展开才可写，预览不能授完整认识权限',async()=>{
  let step=0,focusId='';const f=await fixture(body=>{
    const p=main(body),focus=p.workspaceMaterial.focus.find((x:any)=>x.id===focusId)||p.workspaceMaterial.focus[0];focusId=focus.id;
    if(step++===0){assert.ok(focus.text.length<=180);assert.equal((p.memories??[]).some((m:any)=>m.id===focusId),false);return tools(['submit_reading',{reply:'先核对当前现场。',workspace:{focus:[focusId]}}]);}
    if(step===2){assert.ok(body.messages.some((m:any)=>m.role==='tool'&&m.content.includes('完整')));return tools(['recall_memory',{ids:[focusId],view:'full'}]);}
    assert.ok(body.messages.some((m:any)=>m.role==='tool'&&m.content.includes('ARCHIVE-COMPLETE-END')));
    return tools(['submit_reading',{reply:'完整旧记录已经取回。',workspace:{focus:[focusId]}}]);
  });
  try{
    const memory:Memory={id:'archived-full-opinion',kind:'opinion',text:'ARCHIVE-ONLY。'.repeat(650)+'ARCHIVE-COMPLETE-END',bookId:f.book.id,partnerId:f.state.partnerId,source:'reading',evidence:[{bookId:f.book.id,version:f.book.version,...f.book.known[0]}],parents:[],chatIds:[],createdAt:1,forgotten:false};f.state.memories.push(memory);
    f.state.companionWorkspaces=[{bookId:f.book.id,version:f.book.version,partnerId:f.state.partnerId,source:'reading',revision:1,focusIds:[memory.id],updatedAt:1}];
    await f.first.engine.ask(f.book.id,'核对当前现场。');assert.equal(f.requests.length,3);assert.deepEqual(workspaceFor(f.state,f.book).focusIds,[memory.id]);assert.equal(f.state.chats.filter(c=>c.role==='assistant').length,1);
  }finally{await f.first.close();}
});
test('前台opinion导航片段只导航，当前marker仅首包同全文，旧条目必须full才授工作台权限',async()=>{
  let step=0,oldAlias='';const oldText='检修愿望：恢复正常运行。'+'旧工程条件。'.repeat(1300)+'ARCHIVE-NAV-FULL-END';
  const pages=(body:any)=>body.messages.filter((m:any)=>m.role==='tool').flatMap((m:any)=>{try{return(JSON.parse(m.content).results??[]).flatMap((r:any)=>{try{return[JSON.parse(r.text)];}catch{return[];}});}catch{return[];}});
  const f=await fixture(body=>{
    const initial=main(body);assert.equal(initial.workspaceMaterial.understanding.text,'当前检修愿望：校准正在进行。');
    if(step++===0){assert(body.tools.find((t:any)=>t.function.name==='recall_memory').function.description.includes('memory.text'));return tools(['recall_memory',{query:'检修愿望',kind:'opinion',view:'index'}]);}
    const index=pages(body).find((p:any)=>p.request?.view==='index');assert(index);const old=index.items.find((m:any)=>m.match&&!m.currentAlreadyProvided)!,current=index.items.find((m:any)=>m.currentAlreadyProvided)!;assert(old);assert(current);oldAlias=old.id;assert.equal(old.text,undefined);assert(old.match.text.includes('检修愿望'));assert(index.notice.includes('UTF16'));assert.equal(old.match.text,oldText.slice(old.match.textStart,old.match.textEnd));
    if(step===2)return tools(['submit_reading',{reply:'目录不应接管全文。',workspace:{understanding:oldAlias}}]);
    if(step===3){assert(body.messages.some((m:any)=>m.role==='tool'&&m.content.includes('完整')));return tools(['recall_memory',{ids:[oldAlias],view:'full'}]);}
    if(step===4){const full=pages(body).find((p:any)=>p.request?.view==='full');assert.equal(full.items[0].text,oldText);return tools(['recall_memory',{query:'检修愿望',kind:'opinion',view:'index'}]);}
    const latest=pages(body).filter((p:any)=>p.request?.view==='index').at(-1)!;assert.equal(latest.items.find((m:any)=>m.id===oldAlias).currentAlreadyProvided,undefined);return tools(['submit_reading',{reply:'已取得旧完整看法，可据此继续。',workspace:{understanding:oldAlias}}]);
  });
  try{
    const base:Memory={id:'nav-old',bookId:f.book.id,partnerId:f.state.partnerId,kind:'opinion',text:oldText,source:'reading',evidence:[{bookId:f.book.id,version:f.book.version,...f.book.known[0]}],parents:[],chatIds:[],createdAt:1,forgotten:false},current={...base,id:'nav-current',text:'当前检修愿望：校准正在进行。',createdAt:2};f.state.memories.push(base,current);f.state.companionWorkspaces=[{bookId:f.book.id,version:f.book.version,partnerId:f.state.partnerId,source:'reading',revision:1,understandingId:current.id,focusIds:[],updatedAt:1}];
    await f.first.engine.ask(f.book.id,'核对检修愿望。');assert.equal(f.requests.length,5);assert.equal(workspaceFor(f.state,f.book).understandingId,base.id);assert.equal(f.state.chats.filter(c=>c.role==='assistant').length,1);assert.equal(f.state.memories.length,2);
  }finally{await f.first.close();}
});

test('原生通道式插话先回应且不取消后台HTTP，原Harness续存历史原答而不覆盖前台工作台',async()=>{
 for(const natural of [false,true]){
  const started=deferred<void>(),release=deferred<void>();let phase='seed',backgroundCalls=0,foregroundCalls=0,backgroundSignal:AbortSignal|undefined;
  const f=await fixture(async (body,signal)=>{
    const p=main(body),old=p.workspaceMaterial.understanding?.id;
    if(phase==='seed')return tools(['submit_reading',{reply:'',thoughts:[{kind:'opinion',text:'设备仍待校准，原登记条件须保留。'}],workspace:{understanding:'t1'}}]);
    const task=packets(body).find((x:any)=>x.task)?.task;
    if(task==='conversation'){foregroundCalls++;return natural?text('前台自然答复：设备复测仍在进行。'):tools(['submit_reading',{reply:'先接当前提问。',thoughts:[{kind:'opinion',text:'前台已核对校准完成，复测仍在进行。',updates:old,updateReason:'按新原文与读者提问接续'}],workspace:{understanding:'t1',focus:[]}}]);}
    backgroundCalls++;backgroundSignal=signal;started.resolve();await release.promise;
    return tools(['submit_reading',{reply:'',thoughts:[{kind:'opinion',text:'原后台阶段已看到校准完成。',updates:old,updateReason:'后台新段揭示'},{kind:'opinion',text:'后台阶段独立完整理解。'+fullUnderstanding}],workspace:{understanding:'t2'}}]);
  },true);
  try{
    f.book.prepared=[];await f.first.engine.prepare(f.book.id);const originalId=workspaceFor(f.state,f.book).understandingId!;
    phase='background';f.first.engine.observing(true);const page=f.book.chapters[1],reading=f.first.engine.observe(f.book.id,f.book.text.slice(page.start,page.end),'body','continuous-page');
    await signalWithin(started.promise,'后台请求');const question=f.first.engine.ask(f.book.id,'现在开口核对校准与复测。');await signalWithin(question,'前台应在后台答复前完成');assert.equal(backgroundSignal?.aborted,false);assert.deepEqual(f.cancels,[]);assert.equal(f.state.chats.filter(c=>c.role==='assistant').length,1);release.resolve();await reading;
    const raw=f.saves.find(s=>s.companionReadingReceipts?.length)!.companionReadingReceipts![0];assert.ok(raw);assert.equal(raw.status,'received');
    const w=workspaceFor(f.state,f.book),current=f.state.memories.find(m=>m.id===w.understandingId)!;assert.equal(current.text,natural?'设备仍待校准，原登记条件须保留。':'前台已核对校准完成，复测仍在进行。');assert.equal(f.state.memories.find(m=>m.id===originalId)?.replacedBy,natural?undefined:current.id);
    const historical=f.state.memories.filter(m=>m.text.includes('后台阶段独立完整理解。')||m.text==='原后台阶段已看到校准完成。');
    assert.equal(historical.length,2);assert.ok(historical.every(m=>m.historicalOnly===true));assert.equal(current.historicalOnly,undefined);assert.equal(f.state.chats.filter(c=>c.role==='assistant').length,1);
    assert.equal(backgroundCalls,1);assert.equal(foregroundCalls,1);assert.equal(f.requests.length,3);assert.equal(f.state.readings?.filter(r=>r.draftId===raw.id).length,1);assert.deepEqual(f.state.companionReadingReceipts,[]);assert.deepEqual(f.state.readingDrafts,[]);
    await f.first.engine.prepare(f.book.id);assert.equal(f.requests.length,3);assert.equal(workspaceFor(f.state,f.book).understandingId,current.id);
  }finally{release.resolve();await f.first.close();}
 }
});

test('已返回后台原答先落盘，两条排队前台结束前不推进后台工具或下一模型，也不启动第二后台',async()=>{
 for(const finalCandidate of [false,true]){
  const bgStarted=deferred<void>(),bgRelease=deferred<void>(),bgRecorded=deferred<void>(),firstStarted=deferred<void>(),firstRelease=deferred<void>(),secondStarted=deferred<void>(),secondRelease=deferred<void>();
  const pending:Promise<unknown>[]=[];const track=<T>(promise:Promise<T>)=>{pending.push(promise);void promise.catch(()=>{});return promise;};
  let bgCalls=0,backgroundPreparationCalls=0,searches=0;
  const f=await fixture(async body=>{
    const task=packets(body).find((p:any)=>p.task==='conversation');
    if(task){if(task.userText.includes('第一问')){firstStarted.resolve();await firstRelease.promise;}else{secondStarted.resolve();await secondRelease.promise;}return text('按当前工程问题接话。');}
    if(main(body).workspaceMaterial.workspace.source==='background'){
      backgroundPreparationCalls++;assert.ok(f.state.readings?.some(r=>r.source==='reading'&&r.processing==='model'),'第二后台须等第一个真实阅读完成');return tools(['submit_reading',{reply:'',thoughts:[]}]);
    }
    if(bgCalls++===0){bgStarted.resolve();await bgRelease.promise;if(!finalCandidate)return tools(['search_web',{query:'test calibration conditions'}]);}
    if(bgCalls>1)assert.equal(f.state.chats.filter(c=>c.role==='user'&&c.delivery==='answered').length,2);
    return tools(['submit_reading',{reply:'',thoughts:[{kind:'opinion',text:'后台工程理解在前台结束后接续。'}],workspace:{understanding:'t1'}}]);
  },true);
  try{
    f.state.settings.searchEnabled=true;f.first.engine.search=async()=>{searches++;return{text:'工程校准参考记录',sources:[{title:'工程参考',url:'https://example.org/calibration'}]};};
    f.onSave(s=>{if(s.usage.some(u=>u.requestKey&&u.status==='complete'))bgRecorded.resolve();});
    f.first.engine.observing(true);const page=f.book.chapters[1],reading=track(f.first.engine.observe(f.book.id,f.book.text.slice(page.start,page.end),'body','continuous-page'));
    await signalWithin(bgStarted.promise,'后台派发');const first=track(f.first.engine.ask(f.book.id,'第一问：核对当前现场。'));await signalWithin(firstStarted.promise,'第一前台');const second=track(f.first.engine.ask(f.book.id,'第二问：核对移交条件。'));
    const otherBackground=track(f.first.engine.prepareBackground(f.book.id));bgRelease.resolve();await signalWithin(bgRecorded.promise,'后台原回执落盘');
    assert.equal(searches,0);assert.equal(bgCalls,1);assert.equal(backgroundPreparationCalls,0);assert.equal(f.first.engine.busy,true);assert.deepEqual(f.cancels,[]);
    if(finalCandidate)assert.equal(f.state.companionReadingReceipts?.length,1,'完整后台原答已落盘，前台仍未结束');
    firstRelease.resolve();await first;await signalWithin(secondStarted.promise,'第二前台');assert.equal(searches,0);assert.equal(bgCalls,1);assert.equal(backgroundPreparationCalls,0);
    secondRelease.resolve();await second;await reading;await otherBackground;
    assert.equal(searches,finalCandidate?0:1);assert.equal(bgCalls,finalCandidate?1:2);assert.ok(backgroundPreparationCalls>0);assert.deepEqual(f.cancels,[]);
    assert.equal(workspaceFor(f.state,f.book).understandingId,undefined,'旧后台只保存历史看法，不覆盖两个新前台');
  }finally{bgRelease.resolve();firstRelease.resolve();secondRelease.resolve();await f.first.close();await Promise.allSettled(pending);}
 }
});

test('前文准备与独立背景使用同一让位屏障，插话完成早于后台原答且不取消真实HTTP',async()=>{
 for(const background of [false,true]){
  const started=deferred<void>(),release=deferred<void>();let held=true;const f=await fixture(async body=>{
    if(packets(body).some((p:any)=>p.task==='conversation'))return text('先核对读者当前问题。');
    if(held){held=false;started.resolve();await release.promise;}
    return tools(['submit_reading',{reply:'',thoughts:[{kind:'opinion',text:'工程准备阶段的独立认识。'}],workspace:{understanding:'t1'}}]);
  },true);
  try{
    if(!background)f.book.prepared=[];const preparing=background?f.first.engine.prepareBackground(f.book.id):f.first.engine.prepare(f.book.id);
    await signalWithin(started.promise,'准备后台派发');await signalWithin(f.first.engine.ask(f.book.id,'临时核对当前问题。'),'准备期间前台接话');assert.deepEqual(f.cancels,[]);release.resolve();await preparing;
    assert.ok(f.state.readings?.some(r=>r.source===(background?'background':'preparation')));assert.equal(f.state.chats.filter(c=>c.role==='assistant').length,1);
  }finally{release.resolve();await f.first.close();}
 }
});

test('原答已落盘而后台正等前台时，真实暂停唤醒屏障并取消前台；原答仍可零重发恢复',async()=>{
  const started=deferred<void>(),bgRelease=deferred<void>(),frontStarted=deferred<void>(),frontRelease=deferred<void>(),recorded=deferred<void>();
  const pending:Promise<unknown>[]=[];const track=<T>(promise:Promise<T>)=>{pending.push(promise);void promise.catch(()=>{});return promise;};
  const f=await fixture(async body=>{if(packets(body).some((p:any)=>p.task==='conversation')){frontStarted.resolve();await frontRelease.promise;return text('已取消的前台迟到回复。');}started.resolve();await bgRelease.promise;return tools(['submit_reading',{reply:'',thoughts:[{kind:'opinion',text:'已经收到的完整工程理解。'}],workspace:{understanding:'t1'}}]);},true);
  try{
    f.onSave(s=>{if(s.companionReadingReceipts?.length)recorded.resolve();});f.first.engine.observing(true);const page=f.book.chapters[1],reading=track(f.first.engine.observe(f.book.id,f.book.text.slice(page.start,page.end),'body','continuous-page'));
    await signalWithin(started.promise,'已派发后台');const question=track(f.first.engine.ask(f.book.id,'前台仍在整理的问题。'));await signalWithin(frontStarted.promise,'前台派发');bgRelease.resolve();await signalWithin(recorded.promise,'后台完整原答持久化');
    assert.equal(f.state.memories.length,0);assert.equal(f.first.engine.busy,true);assert.deepEqual(f.cancels,[]);f.first.engine.pause();
    await assert.rejects(reading);await assert.rejects(question);assert.equal(f.first.engine.busy,false);assert.equal(f.cancels.length,1);assert.equal(f.state.usage.find(u=>u.requestKey)?.status,'complete');assert.equal(f.state.usage.find(u=>u.questionId)?.status,'unknown');
    frontRelease.resolve();await f.first.engine.startReading(f.book.id);await f.first.engine.prepare(f.book.id);assert.equal(f.requests.length,2);assert.ok(f.state.memories.some(m=>m.text==='已经收到的完整工程理解。'));assert.deepEqual(f.state.companionReadingReceipts,[]);
  }finally{bgRelease.resolve();frontRelease.resolve();await f.first.close();await Promise.allSettled(pending);}
});

test('让位后的真实暂停、更正、遗忘、撤权、切书与退出仍取消原生后台并保留unknown，不接迟到答案',async()=>{
 for(const action of ['pause','correct','forget','permission','switch','stop'] as const){
  const started=deferred<void>(),release=deferred<void>();const f=await fixture(async body=>{if(packets(body).some((p:any)=>p.task==='conversation'))return text('前台问题已接住。');started.resolve();await release.promise;return tools(['submit_reading',{reply:'',thoughts:[{kind:'opinion',text:'LATE-CANCELLED-BACKGROUND'}],workspace:{understanding:'t1'}}]);},true);
  try{
    const seed:Memory={id:'cancel-source',bookId:f.book.id,partnerId:f.state.partnerId,kind:'opinion',text:'原工程认识。',evidence:[{bookId:f.book.id,version:f.book.version,...f.book.known[0]}],parents:[],chatIds:[],createdAt:1,forgotten:false,source:'reading'};f.state.memories.push(seed);
    f.first.engine.observing(true);const page=f.book.chapters[1],reading=f.first.engine.observe(f.book.id,f.book.text.slice(page.start,page.end),'body','continuous-page').then(()=>undefined,error=>error);
    await signalWithin(started.promise,'真实失效前后台派发');await signalWithin(f.first.engine.ask(f.book.id,'先接住前台提问。'),'取消前前台接话');assert.deepEqual(f.cancels,[]);
    if(action==='pause')f.first.engine.pause();else if(action==='correct')await f.first.engine.correctMemory(seed.id,'实际更正后的工程认识。');
    else if(action==='forget')await f.first.engine.editState(s=>{forgetMemory(s,seed.id);},()=>true,true);
    else if(action==='permission')await f.first.engine.editState(s=>{s.books[0].known=[];},()=>true,true);
    else if(action==='switch'){const other=await importBook('另一工程','第一章\n另一工程当前记录。');f.state.books.push(other);await f.first.engine.startReading(other.id);}
    else f.first.engine.stop();
    assert.ok(await reading);assert.equal(f.cancels.length,1);assert.equal(f.state.usage.find(u=>u.requestKey)?.status,'unknown');
    release.resolve();await Promise.resolve();await Promise.resolve();assert.equal(f.state.memories.some(m=>m.text==='LATE-CANCELLED-BACKGROUND'),false);assert.equal(f.state.companionReadingReceipts?.length??0,0);assert.equal(f.first.engine.busy,false);
  }finally{release.resolve();await f.first.close();}
 }
});

test('后台完整原答因停止留在磁盘，冷启动prepare优先消费原reading请求，切旧模式也不重发',async()=>{
  const started=deferred<void>(),release=deferred<void>();let calls=0;const f=await fixture(async()=>{calls++;assert.equal(calls,1,'原reading回执不应按preparation键再生成');started.resolve();await release.promise;return tools(['submit_reading',{reply:'',sourceIds:['p1'],quoteSource:'p1',thoughts:[{kind:'opinion',text:fullUnderstanding}],workspace:{understanding:'t1'}}]);});
  let next:ReturnType<typeof f.attach>|undefined;
  try{
    f.first.engine.observing(true);const page=f.book.chapters[1],reading=f.first.engine.observe(f.book.id,f.book.text.slice(page.start,page.end),'body','continuous-page').then(()=>({error:undefined}),error=>({error}));
    await signalWithin(started.promise,'冷启动前后台请求');f.first.engine.stop();release.resolve();assert.ok((await reading).error);
    const saved=f.disk,raw=saved.companionReadingReceipts?.[0];assert.ok(raw);assert.equal(raw.request.source,'reading');assert.equal(raw.status,'received');await f.first.runtime.dispose();
    recoverInterruptedState(saved);next=f.attach(saved);await next.engine.startReading(f.book.id);await next.engine.setReadingMode(f.book.id,'legacy');await next.engine.prepare(f.book.id);
    assert.equal(calls,1);assert.equal(saved.readings?.filter(r=>r.draftId===raw.id).length,1);assert.equal(saved.memories.find(m=>m.text===fullUnderstanding)?.source,'reading');assert.deepEqual(saved.companionReadingReceipts,[]);
  }finally{release.resolve();await (next??f.first).close();}
});

test('最终保存失败后冷启动沿原草稿和usage接续，完整理解与原文引用零重发消费',async()=>{
  const f=await fixture(()=>tools(['submit_reading',{reply:'',thoughts:[{kind:'opinion',text:fullUnderstanding,quoteSource:'p1'}],workspace:{understanding:'t1'}}]));let next:ReturnType<typeof f.attach>|undefined;
  try{
    const initialEnd=f.book.prepared[0].end;f.setFailure(s=>s.readings?.some(r=>r.source==='reading'&&r.ranges.some(x=>x.end>initialEnd))??false);
    f.first.engine.observing(true);const page=f.book.chapters[1];await assert.rejects(f.first.engine.observe(f.book.id,f.book.text.slice(page.start,page.end),'body','continuous-page'),/COMPANION SAVE FAILURE/);
    assert.equal(f.requests.length,1);assert.equal(f.state.memories.length,0);assert.equal(f.state.readingDrafts?.[0].association,'ready');const draftId=f.state.readingDrafts![0].id;
    assert.equal(draftId,f.state.usage[0].id);assert.equal(f.state.readingDrafts![0].material.readingStrategy,'companion');
    const saved=f.disk;await f.first.close();f.setFailure(()=>false);recoverInterruptedState(saved);next=f.attach(saved);await next.engine.startReading(f.book.id);await next.engine.prepare(f.book.id);
    assert.equal(f.requests.length,1);assert.equal(saved.readingDrafts?.length,0);assert.equal(saved.readings?.filter(r=>r.draftId===draftId).length,1);assert.equal(saved.memories[0].text,fullUnderstanding);assert.ok(saved.memories[0].sourceQuote);assert.ok(covers(saved.books[0].prepared,page));assert.equal(workspaceFor(saved,saved.books[0]).understandingId,saved.memories[0].id);
  }finally{await (next??f.first).close();}
});


test('同阅读任务提交错误后经全文工具修正，合法原答精确消费候选链且不留下旧错误重问',async()=>{
 let step=0,focusId='';const f=await fixture(body=>{
  const p=main(body);focusId=p.workspaceMaterial.focus[0].id;
  if(step++===0)return tools(['submit_reading',{reply:'',workspace:{focus:[focusId]}}]);
  if(step===2){assert.ok(body.messages.some((m:any)=>m.role==='tool'&&m.content.includes('完整')));return tools(['recall_memory',{ids:[focusId],view:'full'}]);}
  return tools(['submit_reading',{reply:'',thoughts:[{kind:'opinion',text:'本阶段复测尚未结束。'}],workspace:{understanding:'t1',focus:[focusId]}}]);
 });
 try{
  const memory:Memory={id:'long-focus-reading',kind:'opinion',text:'ARCHIVE-ONLY。'.repeat(650)+'ARCHIVE-END',bookId:f.book.id,partnerId:f.state.partnerId,source:'reading',evidence:[{bookId:f.book.id,version:f.book.version,...f.book.known[0]}],parents:[],chatIds:[],createdAt:1,forgotten:false};f.state.memories.push(memory);
  f.state.companionWorkspaces=[{bookId:f.book.id,version:f.book.version,partnerId:f.state.partnerId,source:'reading',revision:1,focusIds:[memory.id],updatedAt:1}];
  f.first.engine.observing(true);const page=f.book.chapters[1];await f.first.engine.observe(f.book.id,f.book.text.slice(page.start,page.end),'body','continuous-page');
  assert.equal(f.requests.length,3);assert.deepEqual(f.state.companionReadingReceipts,[]);assert.deepEqual(f.state.readingDrafts,[]);
  const finals=f.state.usage.filter(u=>u.modelTools?.includes('submit_reading'));assert.equal(finals.length,2);const record=f.state.readings!.at(-1)!;
  assert.equal(record.draftId,finals[1].id);assert.deepEqual(record.supersededReceiptIds,[finals[0].id]);
  await f.first.engine.prepare(f.book.id);assert.equal(f.requests.length,3);
 }finally{await f.first.close();}
});


test('自动阅读完整自然原答冷启动逐字保存，沿原来源接续且不重派',async()=>{
 const started=deferred<void>(),release=deferred<void>();const f=await fixture(async()=>{started.resolve();await release.promise;return text('ENGINE UNFINISHED READING');});let next:ReturnType<typeof f.attach>|undefined;
 try{
  const before=f.book.prepared[0].end;f.first.engine.observing(true);const page=f.book.chapters[1];const pending=f.first.engine.observe(f.book.id,f.book.text.slice(page.start,page.end),'body','continuous-page').then(()=>undefined,e=>e);
  await signalWithin(started.promise,'未提交的自动阅读');f.first.engine.stop();release.resolve();assert.ok(await pending);const saved=f.disk;await f.first.runtime.dispose();recoverInterruptedState(saved);next=f.attach(saved);await next.engine.startReading(f.book.id);
  await next.engine.prepare(f.book.id);assert.equal(f.requests.length,1);assert.ok(saved.books[0].prepared[0].end>before);assert.equal(saved.memories[0].text,'ENGINE UNFINISHED READING');assert.equal(saved.memories[0].kind,'opinion');assert.equal(saved.chats.length,0);assert.equal(saved.companionReadingReceipts?.length,0);
 }finally{release.resolve();await (next??f.first).close();}
});
