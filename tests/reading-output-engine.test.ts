import test from 'node:test';
import assert from 'node:assert/strict';
import { importBook, covers } from '../src/core/books.ts';
import { initialState } from '../src/core/state.ts';
import { ReadingEngine } from '../src/core/engine.ts';
import { ChatModel } from '../src/core/model.ts';
import { HarnessRuntime } from '../src/agent/runtime.ts';
import { recoverInterruptedState } from '../src/core/startup.ts';
import { workspaceFor } from '../src/core/companion-workspace.ts';
import { correctMemory, evidence } from '../src/core/context.ts';
import type { ReadingStrategy, State, Store } from '../src/core/types.ts';

const packets=(body:any)=>body.messages.filter((m:any)=>m.role==='user').flatMap((m:any)=>m.content.split('\n\n')).flatMap((s:string)=>{try{return[JSON.parse(s)];}catch{return[];}});
const natural=(content:string)=>({status:200,body:{choices:[{finish_reason:'stop',message:{content,reasoning_content:'PRIVATE OUTPUT CONTRACT REASONING'}}],usage:{prompt_tokens:17,completion_tokens:9}}});
const toolPacket=(content:string|null,...entries:[string,unknown][])=>({status:200,body:{choices:[{finish_reason:'tool_calls',message:{content,reasoning_content:'PRIVATE OUTPUT CONTRACT REASONING',tool_calls:entries.map(([name,args],i)=>({id:'output-tool-'+i,type:'function',function:{name,arguments:JSON.stringify(args)}}))}}],usage:{prompt_tokens:17,completion_tokens:9}}});
const opinion='  工程核对：校准已经完成，复测仍需接续；检修登记与移交条件分别保留。\r\n'.repeat(65)+'末行保留空格。  \n';
const displayed='  当前工程答复：校准已经完成，复测仍在进行。\r\n移交条件须另行核对。  \n';
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return{promise,resolve};}
async function fixture(respond:(body:any)=>Promise<any>|any,strategy:ReadingStrategy='companion'){
  const state=initialState(),book=await importBook('终态输出工程资料','第一章 登记\n设备已登记，校准尚待完成。\n第二章 复测\n校准已完成，复测仍在进行。\n第三章 未读\nUNREAD-OUTPUT-CONTRACT');
  state.books=[book];book.readingStrategy=strategy;book.known=[{start:0,end:book.chapters[0].end}];book.position=book.chapters[0].end;book.prepared=structuredClone(book.known);
  state.settings.services[0].enabled=true;state.settings.tokenLimit=3000000;state.settings.minReadChars=1;state.settings.defaultQuiet=true;
  let disk=structuredClone(state);const requests:any[]=[];
  const store:Store={async load(){return structuredClone(disk);},async save(s){disk=structuredClone(s);}};
  const model=new ChatModel(async request=>{requests.push(request);assert.equal(JSON.stringify(request.body).includes('UNREAD-OUTPUT-CONTRACT'),false);return respond(request.body);});
  const attach=(saved:State)=>{const engine=new ReadingEngine(saved,store,model),runtime=new HarnessRuntime();engine.agent=runtime;return{engine,runtime,async close(){engine.stop();await runtime.dispose();}};};
  const first=attach(state);await first.engine.startReading(book.id);
  return{state,book,requests,store,attach,first,get disk(){return structuredClone(disk);}};
}
async function readNext(f:Awaited<ReturnType<typeof fixture>>){f.first.engine.observing(true);const page=f.book.chapters[1];await f.first.engine.observe(f.book.id,f.book.text.slice(page.start,page.end),'body','continuous-page');return page;}

test('多文档content原答冷恢复按原JSON或自然正文分类，非法reply保持拒绝且零重发',async()=>{
  const document='  工程理解：校准已完成，复测条件继续保留。\r\n末行空格。  ';
  for(const kind of ['json','invalid-reply','prose'] as const){
    const payload={documents:[{operation:'create',text:document}],working:['t1'],...(kind==='invalid-reply'?{reply:'不允许的自动阅读字段'}:{})};
    const raw=kind==='prose'?document:'  ```json\n'+JSON.stringify(payload)+'\n```  ';
    const started=deferred<void>(),release=deferred<void>();
    const f=await fixture(async()=>{started.resolve();await release.promise;return natural(raw);});let next:ReturnType<typeof f.attach>|undefined;
    try{
      f.first.engine.observing(true);const page=f.book.chapters[1],pending=f.first.engine.observe(f.book.id,f.book.text.slice(page.start,page.end),'body','continuous-page').then(()=>undefined,e=>e);
      await started.promise;f.first.engine.stop();release.resolve();assert.ok(await pending);
      const saved=f.disk,receipt=saved.companionReadingReceipts?.[0];assert.ok(receipt);assert.equal(receipt.material.outputProtocol,'reading-documents-v1');assert.equal(receipt.candidate.format,'content');
      const candidate=JSON.stringify(receipt.candidate),usage=JSON.stringify(saved.usage);assert.ok(Buffer.from(receipt.candidate.text).equals(Buffer.from(raw)));assert.equal(saved.memories.length,0);
      await f.first.runtime.dispose();recoverInterruptedState(saved);next=f.attach(saved);await next.engine.startReading(f.book.id);
      if(kind==='invalid-reply'){
        await assert.rejects(next.engine.prepare(f.book.id),/reply.*原答保持/);assert.equal(saved.memories.length,0);assert.equal(saved.chats.length,0);assert.equal(saved.companionReadingReceipts?.[0].status,'blocked');assert.equal(JSON.stringify(saved.companionReadingReceipts?.[0].candidate),candidate);assert.equal(covers(saved.books[0].prepared,page),false);
      }else{
        await next.engine.prepare(f.book.id);assert.equal(saved.memories.length,1);assert.ok(Buffer.from(saved.memories[0].text).equals(Buffer.from(document)));assert.equal(saved.memories[0].kind,'opinion');assert.equal(saved.chats.length,0);assert.ok(covers(saved.books[0].prepared,page));assert.deepEqual(saved.companionReadingReceipts,[]);assert.equal(saved.readings?.filter(r=>r.draftId===receipt.id).length,1);
        await next.engine.prepare(f.book.id);assert.equal(saved.memories.length,1,'已保存原答不得重复形成');
      }
      assert.equal(f.requests.length,1,'冷恢复不能追加模型请求');assert.equal(JSON.stringify(saved.usage),usage);
    }finally{release.resolve();await(next??f.first).close();}
  }
});

const envelopeParts=['  工程简报：校准已完成，复测正在进行。\r\n  ','\r\n复测记录与移交条件分别保留。  ','  检修记录仍须逐项核对。\r\n','\r\n完整工程看法：复测阶段尚未结束。  ','  后续移交条件仍需跟踪。\r\n','\r\n移交之前还需要核对哪些条件？  '];
const envelopeText=envelopeParts.join('\n\n');
const invalidEnvelope=JSON.stringify({readingBrief:envelopeParts[0],reply:envelopeParts[1],thoughts:[{kind:'story',text:envelopeParts[2],updates:'m1',updateReason:'原条件已经完全回答'},{kind:'opinion',text:envelopeParts[3]},{kind:'thread',text:envelopeParts[4]},{kind:'question',text:envelopeParts[5]}],reasoning_content:'PRIVATE-ENVELOPE-REASONING'});

test('正式阅读自然终态逐字形成完整观点，安静时不制造聊天与共同经历',async()=>{
  for(const strategy of ['companion','full-original','structured'] as const){
    const f=await fixture(()=>natural(opinion),strategy);
    try{
      const page=await readNext(f),made=f.state.memories.find(m=>m.text===opinion);
      assert.ok(made,strategy);assert.equal(made.kind,'opinion');assert.equal(made.source,'reading');assert.deepEqual(Buffer.from(made.text),Buffer.from(opinion));
      assert.ok(covers(f.book.prepared,page));assert.equal(f.state.chats.length,0);assert.equal(f.state.memories.some(m=>m.kind==='shared'),false);assert.equal(f.requests.length,1);
      if(strategy==='companion')assert.equal(workspaceFor(f.state,f.book).understandingId,made.id);
      assert.equal(JSON.stringify(f.state).includes('PRIVATE OUTPUT CONTRACT REASONING'),false);
    }finally{await f.first.close();}
  }
});

test('唯一终态submit同包正文替换占位回复且保留有效认识，展示正文保留全部形成依赖',async()=>{
  const f=await fixture(()=>toolPacket(displayed,['submit_reading',{reply:'占位：正文见上方。',replyBasis:{memoryIds:[],chatIds:[]},thoughts:[{kind:'opinion',text:'工程认识：复测与移交条件须分别核对。'}]}]));
  try{
    f.state.memories.push({id:'formation-record',kind:'opinion',text:'检修登记条件需要完整接续。',bookId:f.book.id,partnerId:f.state.partnerId,source:'reading',evidence:[evidence(f.book,f.book.known[0])],parents:[],chatIds:[],createdAt:1,forgotten:false});
    f.state.companionWorkspaces=[{bookId:f.book.id,version:f.book.version,partnerId:f.state.partnerId,source:'reading',revision:0,understandingId:'formation-record',focusIds:[],updatedAt:1}];
    await f.first.engine.ask(f.book.id,'核对当前校准与复测进展。');
    const chat=f.state.chats.find(c=>c.role==='assistant')!;
    assert.equal(chat.text,displayed.trim());assert.ok(chat.memoryIds?.includes('formation-record'));assert.equal(f.state.memories.some(m=>m.source==='conversation'&&m.text==='工程认识：复测与移交条件须分别核对。'),true);assert.equal(f.requests.length,1);
    correctMemory(f.state,'formation-record','原检修登记已更正，须重新核对。');assert.ok(chat.outdatedBy,'正文不能继承占位reply的空归因以绕过原资料更正');
  }finally{await f.first.close();}
});

test('自动阅读显式看法完整保存，同包工程说明不冒充当前理解',async()=>{
  const structuredOpinion='结构提交的工程理解：复测仍需接续，原检修条件继续保留。'.repeat(90);
  for(const strategy of ['companion','full-original','structured'] as const){
    const f=await fixture(()=>toolPacket('工作台引用已改正后重交。',['submit_reading',{reply:'',thoughts:[{kind:'opinion',text:structuredOpinion}],...(strategy==='companion'?{workspace:{understanding:'t1'}}:{})}]),strategy);
    try{await readNext(f);assert.equal(f.requests.length,1);assert.deepEqual(f.state.memories.map(m=>m.text),[structuredOpinion]);assert.equal(f.state.chats.length,0);if(strategy==='companion')assert.equal(workspaceFor(f.state,f.book).understandingId,f.state.memories[0].id);}finally{await f.first.close();}
  }
});

test('自动阅读坏类型提交恢复参数原文，工程重交说明只在原回执',async()=>{
 for(const strategy of ['companion','full-original','structured'] as const){
  const f=await fixture(()=>toolPacket('工作台引用已改正后重交。',['submit_reading',JSON.parse(invalidEnvelope)]),strategy);
  try{await readNext(f);assert.equal(f.requests.length,1);assert.deepEqual(f.state.memories.map(m=>m.text),[envelopeText]);assert.equal(f.state.memories[0].kind,'opinion');assert.equal(f.state.chats.length,0);if(strategy==='companion')assert.equal(workspaceFor(f.state,f.book).understandingId,f.state.memories[0].id);}finally{await f.first.close();}
 }
});

test('自动阅读空或损坏提交不把重交说明存成看法，原付费用量保持',async()=>{
 for(const args of ['{}','{"thoughts":']){
  const f=await fixture(()=>{const packet=toolPacket('改正后重交。',['submit_reading',{}]);packet.body.choices[0].message.tool_calls[0].function.arguments=args;return packet;});
  try{if(args==='{}')await readNext(f);else await assert.rejects(readNext(f));assert.equal(f.requests.length,1);assert.equal(f.state.memories.length,0);assert.equal(f.state.usage.at(-1)?.status,'complete');}finally{await f.first.close();}
 }
});

test('坏类型工具提交冷接续沿原参数保存阅读全文，工程说明不接入理解且零重发',async()=>{
 const started=deferred<void>(),release=deferred<void>();
 const f=await fixture(async()=>{started.resolve();await release.promise;return toolPacket('工作台引用已改正后重交。',['submit_reading',JSON.parse(invalidEnvelope)]);});let next:ReturnType<typeof f.attach>|undefined;
 try{
  f.first.engine.observing(true);const page=f.book.chapters[1],pending=f.first.engine.observe(f.book.id,f.book.text.slice(page.start,page.end),'body','continuous-page').then(()=>undefined,e=>e);
  await started.promise;f.first.engine.stop();release.resolve();assert.ok(await pending);const saved=f.disk,receipt=saved.companionReadingReceipts?.[0];assert.ok(receipt);assert.equal(receipt.candidate.format,'submit');assert.equal(receipt.candidate.finalText,'工作台引用已改正后重交。');assert.equal(receipt.candidate.text,invalidEnvelope);const usage=JSON.stringify(saved.usage);await f.first.runtime.dispose();
  recoverInterruptedState(saved);next=f.attach(saved);await next.engine.startReading(f.book.id);await next.engine.prepare(f.book.id);
  assert.deepEqual(saved.memories.map(m=>m.text),[envelopeText]);assert.equal(workspaceFor(saved,saved.books[0]).understandingId,saved.memories[0].id);assert.equal(f.requests.length,1);assert.equal(JSON.stringify(saved.usage),usage);
 }finally{release.resolve();await (next??f.first).close();}
});

test('唯一终态submit字段无效时同包完整自然正文仍独立保存，空提交无正文仍拒绝',async()=>{
  for(const damaged of [false,true]){
    const f=await fixture(()=>{const packet=toolPacket(displayed,['submit_reading',{}]);if(damaged)packet.body.choices[0].message.tool_calls[0].function.arguments='{"reply":"占位","thoughts":';return packet;});
    try{await f.first.engine.ask(f.book.id,'核对当前工程进展。');assert.equal(f.state.chats.at(-1)?.text,displayed.trim());assert.equal(f.state.memories.length,0);assert.equal(f.requests.length,1);}finally{await f.first.close();}
  }
  const empty=await fixture(()=>toolPacket(null,['submit_reading',{}]));
  try{await assert.rejects(empty.first.engine.ask(empty.book.id,'核对当前工程进展。'));assert.equal(empty.state.chats.filter(c=>c.role==='assistant').length,0);assert.equal(empty.state.memories.length,0);}finally{await empty.first.close();}
});

test('取材工具同包文字仅为中间内容，必须等实际终态才保存',async()=>{
  let step=0;const f=await fixture(body=>{
    if(step++===0)return toolPacket('INTERMEDIATE-MATERIAL-NOT-FINAL',['read_original',{start:0,end:f.book.chapters[0].end}]);
    assert.ok(body.messages.some((m:any)=>m.role==='tool'));assert.equal(f.state.memories.length,0);assert.equal(f.state.chats.filter(c=>c.role==='assistant').length,0);
    return natural(opinion);
  });
  try{await readNext(f);assert.equal(f.requests.length,2);assert.deepEqual(f.state.memories.map(m=>m.text),[opinion]);assert.equal(JSON.stringify(f.state).includes('INTERMEDIATE-MATERIAL-NOT-FINAL'),false);}finally{await f.first.close();}
});

test('损坏JSON不能被当作自然阅读成果，空对象也不能生成交流正文',async()=>{
  for(const content of ['{"reply":"未完整","thoughts":']){
    const f=await fixture(()=>natural(content));
    try{const before=structuredClone(f.book.prepared);await assert.rejects(readNext(f));assert.equal(f.state.memories.length,0);assert.equal(f.state.chats.length,0);assert.deepEqual(f.book.prepared,before);assert.ok(f.state.usage.every(u=>u.status==='complete'));}finally{await f.first.close();}
  }
  const empty=await fixture(()=>natural('{}'));
  try{await assert.rejects(empty.first.engine.ask(empty.book.id,'核对当前工程进展。'));assert.equal(empty.state.memories.length,0);assert.equal(empty.state.chats.filter(c=>c.role==='assistant').length,0);}finally{await empty.first.close();}
});

test('真实后台自然原答落盘后冷接续沿原模式零追加调用，逐字理解只保存一次',async()=>{
  for(const strategy of ['companion','full-original'] as const){
    const started=deferred<void>(),release=deferred<void>();const f=await fixture(async()=>{started.resolve();await release.promise;return natural(opinion);},strategy);let next:ReturnType<typeof f.attach>|undefined;
    try{
      f.first.engine.observing(true);const page=f.book.chapters[1],pending=f.first.engine.observe(f.book.id,f.book.text.slice(page.start,page.end),'body','continuous-page').then(()=>undefined,e=>e);
      await started.promise;f.first.engine.stop();release.resolve();assert.ok(await pending);
      const saved=f.disk,receipt=saved.companionReadingReceipts?.[0];assert.ok(receipt,strategy);assert.equal(receipt.material.readingStrategy,strategy);assert.equal(receipt.candidate.text,opinion);assert.equal(receipt.status,'received');assert.equal(saved.memories.length,0);assert.equal(saved.usage.at(-1)?.status,'complete');
      await f.first.runtime.dispose();recoverInterruptedState(saved);next=f.attach(saved);await next.engine.startReading(f.book.id);await next.engine.setReadingMode(f.book.id,'legacy');await next.engine.prepare(f.book.id);
      assert.equal(f.requests.length,1);assert.deepEqual(saved.memories.filter(m=>m.text===opinion).map(m=>m.text),[opinion]);assert.equal(saved.readings?.filter(r=>r.draftId===receipt.id).length,1);assert.ok(covers(saved.books[0].prepared,page));assert.deepEqual(saved.companionReadingReceipts,[]);
    }finally{release.resolve();await (next??f.first).close();}
  }
});

test('自然原答冷接续前撤回阅读权限时阻断保存与自动重问，原答和实际用量保留',async()=>{
  for(const strategy of ['companion','full-original'] as const){
    const started=deferred<void>(),release=deferred<void>();const f=await fixture(async()=>{started.resolve();await release.promise;return natural(opinion);},strategy);let next:ReturnType<typeof f.attach>|undefined;
    try{
      f.first.engine.observing(true);const page=f.book.chapters[1],pending=f.first.engine.observe(f.book.id,f.book.text.slice(page.start,page.end),'body','continuous-page').then(()=>undefined,e=>e);
      await started.promise;f.first.engine.stop();release.resolve();assert.ok(await pending);const saved=f.disk;assert.equal(saved.companionReadingReceipts?.length,1);await f.first.runtime.dispose();
      saved.books[0].known=[{start:0,end:saved.books[0].chapters[0].end}];recoverInterruptedState(saved);next=f.attach(saved);await next.engine.startReading(f.book.id);await assert.rejects(next.engine.prepare(f.book.id));
      assert.equal(f.requests.length,1);assert.equal(saved.memories.length,0);assert.equal(covers(saved.books[0].prepared,page),false);assert.equal(saved.companionReadingReceipts?.[0].status,'blocked');assert.equal(saved.companionReadingReceipts?.[0].candidate.text,opinion);assert.equal(saved.usage.at(-1)?.status,'complete');
    }finally{release.resolve();await (next??f.first).close();}
  }
});

test('JSON终态坏类型仍保存完整原文本，安静阅读不执行更新或关闭原问',async()=>{
  for(const strategy of ['structured','full-original','companion'] as const){
    const f=await fixture(()=>natural(invalidEnvelope),strategy);
    try{
      const original={id:'open-condition',kind:'question' as const,text:'移交之前还需满足哪些条件？',bookId:f.book.id,partnerId:f.state.partnerId,source:'reading' as const,evidence:[evidence(f.book,f.book.known[0])],parents:[],chatIds:[],createdAt:1,forgotten:false};f.state.memories.push(original);const before=structuredClone(original),roots=structuredClone(f.state.entityRoots);
      const page=await readNext(f);assert.equal(f.requests.length,1);assert.ok(covers(f.book.prepared,page));assert.deepEqual(f.state.memories[0],before);assert.equal(f.state.memories.length,2);
      const made=f.state.memories[1];assert.equal(made.kind,'opinion');assert.ok(Buffer.from(made.text).equals(Buffer.from(envelopeText)),strategy+'原文本顺序及字句应保持');assert.equal(made.correctionOf,undefined);assert.equal(made.answersPartOf,undefined);assert.deepEqual(f.state.entityRoots,roots);assert.equal(f.state.chats.length,0);assert.equal(JSON.stringify(f.state).includes('PRIVATE-ENVELOPE-REASONING'),false);
      if(strategy==='companion')assert.equal(workspaceFor(f.state,f.book).understandingId,made.id);
    }finally{await f.first.close();}
  }
});

test('JSON终态原答冷接续沿同一文本恢复规则零重发，权限撤回仍阻断保存',async()=>{
  for(const revoked of [false,true]){
    const started=deferred<void>(),release=deferred<void>();const f=await fixture(async()=>{started.resolve();await release.promise;return natural(invalidEnvelope);},'structured');let next:ReturnType<typeof f.attach>|undefined;
    try{
      f.first.engine.observing(true);const page=f.book.chapters[1],pending=f.first.engine.observe(f.book.id,f.book.text.slice(page.start,page.end),'body','continuous-page').then(()=>undefined,e=>e);
      await started.promise;f.first.engine.stop();release.resolve();assert.ok(await pending);const saved=f.disk,receipt=saved.companionReadingReceipts?.[0];assert.ok(receipt);assert.equal(receipt.candidate.text,invalidEnvelope);assert.equal(receipt.material.readingStrategy,'structured');const usage=JSON.stringify(saved.usage);await f.first.runtime.dispose();
      if(revoked)saved.books[0].known=[{start:0,end:saved.books[0].chapters[0].end}];recoverInterruptedState(saved);next=f.attach(saved);await next.engine.startReading(f.book.id);
      if(revoked){await assert.rejects(next.engine.prepare(f.book.id));assert.equal(saved.memories.length,0);assert.equal(saved.companionReadingReceipts?.[0].status,'blocked');assert.equal(saved.companionReadingReceipts?.[0].candidate.text,invalidEnvelope);}
      else{await next.engine.prepare(f.book.id);assert.equal(saved.memories.length,1);assert.equal(saved.memories[0].kind,'opinion');assert.ok(Buffer.from(saved.memories[0].text).equals(Buffer.from(envelopeText)));assert.equal(saved.readings?.filter(r=>r.draftId===receipt.id).length,1);assert.ok(covers(saved.books[0].prepared,page));assert.deepEqual(saved.companionReadingReceipts,[]);}
      assert.equal(f.requests.length,1);assert.equal(JSON.stringify(saved.usage),usage);
    }finally{release.resolve();await(next??f.first).close();}
  }
});

test('JSON交流坏类型仅接明确reply，无reply的认识不能冒充回答',async()=>{
  for(const reply of [undefined,displayed]){
    const f=await fixture(()=>natural(JSON.stringify({reply,thoughts:[{kind:'thread',text:'工程认识不能替代交流正文。',updates:'m1'}],readingBrief:'工程简报不能替代交流正文。'})));
    try{if(reply===undefined){await assert.rejects(f.first.engine.ask(f.book.id,'核对当前工程进展。'));assert.equal(f.state.chats.filter(c=>c.role==='assistant').length,0);}else{await f.first.engine.ask(f.book.id,'核对当前工程进展。');assert.equal(f.state.chats.at(-1)?.text,displayed.trim());}assert.equal(f.state.memories.length,0);assert.equal(f.requests.length,1);}finally{await f.first.close();}
  }
});

test('JSON交流恢复正文仍受必需联网取材限制，不能以坏类型JSON绕过',async()=>{
  const f=await fixture(()=>natural(JSON.stringify({reply:displayed,thoughts:[{kind:'thread',text:'工程理解。'}]})));
  try{f.state.settings.searchEnabled=true;f.first.engine.search=async()=>{throw Error('此回执没有执行搜索工具');};await assert.rejects(f.first.engine.ask(f.book.id,'请联网搜索工程参考资料并阅读来源。'));assert.equal(f.state.chats.filter(c=>c.role==='assistant').length,0);assert.equal(f.state.memories.length,0);assert.equal(f.requests.length,1);}finally{await f.first.close();}
});

const toolEncodedLeaves=['  工程登记：校准记录保留。\r\n','\r\n工程看法：复测仍在进行。  ','  移交条件仍须核对。\r\n','  移交条件仍须核对。\r\n','\r\n工程路径 C:\\检修\\记录，“] {”只作正文。  '];
const toolEncodedValid=JSON.stringify(toolEncodedLeaves.map((text,index)=>({kind:index===0?'thread':'opinion',text,...(index===0?{updates:'m1',updateReason:'原问关闭提议',answersPartOf:'m1',narrative:{subjects:['检修登记'],text:'NESTED-TEXT-NOT-READING'},reasoning:{text:'PRIVATE-NESTED-TEXT'}}:{})})));
const toolEncodedNestedBad=toolEncodedValid.replace('"subjects":["检修登记"]','"subjects":["检修登记"]]');
const toolEncodedObjectEndBad=toolEncodedValid.replace('"text":"NESTED-TEXT-NOT-READING"}','"text":"NESTED-TEXT-NOT-READING"}]');
const toolEncodedArgs=(inner:string)=>({reply:'',thoughts:inner,reinforce:[],wantsLong:false});
const toolEncodedPacket=(inner:string)=>toolPacket('ENGINE CONTAINER COMMENTARY: 参数是完整外层JSON。',['submit_reading',toolEncodedArgs(inner)]);

test('编码thoughts正式工具终态保存五段原文本，嵌套错误和说明不执行更新或关闭原问',async()=>{
  for(const inner of [toolEncodedValid,toolEncodedNestedBad,toolEncodedObjectEndBad]){
    const f=await fixture(()=>toolEncodedPacket(inner),'full-original');
    try{
      const original={id:'encoded-open-condition',kind:'question' as const,text:'复测结束后的移交条件有哪些？',bookId:f.book.id,partnerId:f.state.partnerId,source:'reading' as const,evidence:[evidence(f.book,f.book.known[0])],parents:[],chatIds:[],createdAt:1,forgotten:false};f.state.memories.push(original);const before=structuredClone(original);
      const page=await readNext(f);assert.equal(f.requests.length,1);assert.ok(covers(f.book.prepared,page));assert.equal(f.state.memories.length,2);assert.deepEqual(f.state.memories[0],before);const made=f.state.memories[1];
      assert.equal(made.kind,'opinion');assert.ok(Buffer.from(made.text).equals(Buffer.from(toolEncodedLeaves.join('\n\n'))));assert.equal(made.correctionOf,undefined);assert.equal(made.answersPartOf,undefined);assert.equal(f.state.chats.length,0);assert.equal(made.text.includes('NESTED-'),false);assert.equal(made.text.includes('ENGINE CONTAINER COMMENTARY'),false);
    }finally{await f.first.close();}
  }
});

test('编码thoughts原工具参数冷接续逐字沿用且零重发，撤回来源仍保原答并阻断',async()=>{
  for(const revoked of [false,true]){
    const started=deferred<void>(),release=deferred<void>();const packet=toolEncodedPacket(toolEncodedObjectEndBad),raw=packet.body.choices[0].message.tool_calls[0].function.arguments;
    const f=await fixture(async()=>{started.resolve();await release.promise;return packet;},'full-original');let next:ReturnType<typeof f.attach>|undefined;
    try{
      f.first.engine.observing(true);const page=f.book.chapters[1],pending=f.first.engine.observe(f.book.id,f.book.text.slice(page.start,page.end),'body','continuous-page').then(()=>undefined,e=>e);
      await started.promise;f.first.engine.stop();release.resolve();assert.ok(await pending);const saved=f.disk,receipt=saved.companionReadingReceipts?.[0];assert.ok(receipt);assert.equal(receipt.candidate.format,'submit');assert.ok(Buffer.from(receipt.candidate.text).equals(Buffer.from(raw)));assert.equal(receipt.material.readingStrategy,'full-original');const usage=JSON.stringify(saved.usage);await f.first.runtime.dispose();
      if(revoked)saved.books[0].known=[{start:0,end:saved.books[0].chapters[0].end}];recoverInterruptedState(saved);next=f.attach(saved);await next.engine.startReading(f.book.id);
      if(revoked){await assert.rejects(next.engine.prepare(f.book.id));assert.equal(saved.memories.length,0);assert.equal(saved.companionReadingReceipts?.[0].status,'blocked');assert.equal(saved.companionReadingReceipts?.[0].candidate.text,raw);}
      else{await next.engine.prepare(f.book.id);assert.equal(saved.memories.length,1);assert.equal(saved.memories[0].kind,'opinion');assert.ok(Buffer.from(saved.memories[0].text).equals(Buffer.from(toolEncodedLeaves.join('\n\n'))));assert.equal(saved.readings?.filter(r=>r.draftId===receipt.id).length,1);assert.ok(covers(saved.books[0].prepared,page));assert.deepEqual(saved.companionReadingReceipts,[]);}
      assert.equal(f.requests.length,1);assert.equal(JSON.stringify(saved.usage),usage);
    }finally{release.resolve();await(next??f.first).close();}
  }
});

test('编码thoughts正式交流不能把内数组或嵌套text生成为reply',async()=>{
  for(const inner of [toolEncodedValid,toolEncodedNestedBad,toolEncodedObjectEndBad]){
    const f=await fixture(()=>natural(JSON.stringify(toolEncodedArgs(inner))),'full-original');
    try{await assert.rejects(f.first.engine.ask(f.book.id,'核对当前复测进展。'));assert.equal(f.state.chats.filter(c=>c.role==='assistant').length,0);assert.equal(f.state.memories.length,0);assert.equal(f.requests.length,1);}finally{await f.first.close();}
  }
});
