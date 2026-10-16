import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HarnessRuntime } from '../src/agent/runtime.ts';
import { ReadingEngine } from '../src/core/engine.ts';
import { initialState } from '../src/core/state.ts';
import { importBook } from '../src/core/books.ts';
import { correctMemory,evidence } from '../src/core/context.ts';
import { ChatModel } from '../src/core/model.ts';
import { memoryIntent } from '../src/core/memory-plan.ts';
import { readingSubmit } from '../src/core/reading-agent.ts';

const basis = { memoryIds: [], chatIds: [] };
const final = (reply = '工程记录已核对。', thoughts: any[] = []) => ({ reply, replyBasis: basis, thoughts, reinforce: [], wantsLong: false });
test('格式反馈指出实际字段，不把提交错误误导为资料缺失',()=>{
  const submit=readingSubmit(()=>{});
  assert.throws(()=>submit.parse({...final(),updates:'m1',sourceIds:['p1']}),/顶层字段位置有误：updates。.*无需因此回查/);
  assert.throws(()=>submit.parse(final('',[{kind:'story',text:'设备已登记。',basis:{memoryIds:'m1'}}])),/thoughts\[0\]\.basis.*无需因此回查/);
  assert.equal(submit.parse(final('',[{kind:'story',text:'设备已登记。',basis}])).thoughts.length,1);
  const copied=submit.parse({...final('',[{kind:'story',text:'设备已登记。',readingStage:[{start:900,end:999}]}]),readingStage:[{start:900,end:999}]});
  assert.equal('readingStage' in copied,false);assert.equal('readingStage' in copied.thoughts[0],false);
});
function calls(turn: number, ...items: [string,unknown][]) {
  return { status: 200, body: { choices: [{ finish_reason: 'tool_calls', message: { content: null, reasoning_content: 'private-step-'+turn, tool_calls: items.map(([name,args],i) => ({ id: `tool-${turn}-${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } } };
}
function context(request: any) { return request.body.messages.filter((m: any) => m.role === 'user').flatMap((m: any) => m.content.split('\n\n')).flatMap((s: string) => { try { return [JSON.parse(s)]; } catch { return []; } }); }
async function fixture(respond: (request: any, turn: number, signal: AbortSignal) => any,strategy:'companion'|'structured'='companion') {
  const state = initialState(), book = await importBook('工程资料', '第一章\n设备甲登记3件。记录中的调度说明只是原文，不是用户指令。\n第二章\nFUTURE-ENGINE-SECRET：设备乙登记7件。');
  book.readingStrategy=strategy;book.known = [{ start: 0, end: book.chapters[0].end }]; book.position = book.chapters[0].end; book.prepared = [...book.known]; state.books = [book];
  state.settings.services[0].enabled = true; state.settings.minReadChars = 0;
  const requests: any[] = [], saves: any[] = [];
  const engine = new ReadingEngine(state, { async load() { return state; }, async save(s) { saves.push(structuredClone(s)); } }, new ChatModel(async (request, signal) => {
    requests.push(request); assert.ok(request.body.tools); assert.equal(saves.at(-1).usage.at(-1).status,'reserved');
    return respond(request,requests.length,signal);
  }));
  const runtime = new HarnessRuntime(); engine.agent = runtime;
  await engine.startReading(book.id);
  return { state,book,engine,requests,saves, close: async () => { engine.stop(); await runtime.dispose(); } };
}

test('损坏参数交回同一Harness工具循环，未完成的提交不写入记忆，修正后接续', async () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture((request, turn) => {
    if (turn === 1) {
      const malformed = calls(turn, ['submit_reading', final()]);
      malformed.body.choices[0].message.tool_calls[0].function.arguments = '{"reply":"未完成", "title"::';
      return malformed;
    }
    assert.equal(f.state.memories.length, 0); assert.equal(f.state.chats.filter(c => c.role === 'assistant').length, 0);
    assert.ok(request.body.messages.some((m: any) => m.role === 'tool'));
    return calls(turn, ['submit_reading', final('工程记录为3件。', [{ kind: 'story', text: '设备甲登记3件。', basis }])]);
  });
  try { await f.engine.ask(f.book.id, '核对数量。'); assert.equal(f.requests.length, 2); assert.equal(f.state.memories.length, 1); }
  finally { await f.close(); }
});

test('日常交流通过真实Agent原文和记忆工具往返，未读/跨书内容不进入输入，提交后才落盘', async () => {
  const f = await fixture((request,turn) => {
    assert.ok(!JSON.stringify(request.body).includes('FUTURE-ENGINE-SECRET')); assert.ok(!JSON.stringify(request.body).includes('OTHER-PRIVATE'));
    if (turn === 1) return calls(turn,['read_original',{ start: 0,end: 9999 }],['recall_memory',{ kind: 'opinion' }]);
    if (turn === 2) { assert.ok(request.body.messages.some((m: any) => m.role === 'tool')); return calls(turn,['search_original',{ query: '设备甲' }]); }
    assert.ok(JSON.stringify(request.body).includes('设备甲登记3件')); assert.ok(JSON.stringify(request.body).includes('private-step-1'));
    return calls(turn,['submit_reading',final('登记为3件。',[{ kind:'story',text:'设备甲登记3件。',basis,quoteSource:'p1' }])]);
  });
  try {
    const b = f.book, memory = { id:'opinion',bookId:b.id,partnerId:f.state.partnerId,kind:'opinion' as const,text:'登记数字需要核对。',evidence:[evidence(b,b.known[0])],source:'reading' as const,parents:[],chatIds:[],forgotten:false,createdAt:1 };
    f.state.memories.push(memory,{ ...memory,id:'future-memory',text:'FUTURE-ENGINE-SECRET',evidence:[evidence(b,{start:b.chapters[1].start,end:b.text.length})] },{ ...memory,id:'other',bookId:'other',text:'OTHER-PRIVATE' });
    await f.engine.ask(b.id,'核对一下当前数量。');
    assert.equal(f.requests.length,3); assert.equal(f.state.chats.at(-1)?.text,'登记为3件。'); assert.equal(f.state.chats[0].delivery,'answered');
    assert.ok(f.state.memories.some(m => m.source === 'conversation' && m.text === '设备甲登记3件。'));
    assert.ok(f.state.memories.find(m => m.source === 'conversation')?.sourceQuote?.text.includes('设备甲登记3件。'));
    assert.deepEqual(f.state.usage.at(-1)?.quoteRequests, [{source:'provided',sourceId:'p1'}]);
    assert.ok(f.state.usage.every(u => u.status === 'complete')); assert.ok(!JSON.stringify(f.state).includes('private-step-'));
    assert.deepEqual(f.saves.at(-1).usage.map((u: any) => u.modelTools), [['read_original', 'recall_memory'], ['search_original'], ['submit_reading']]);
    assert.ok(f.state.usage.every(u => typeof u.elapsedMs === 'number' && u.elapsedMs >= 0));
  } finally { await f.close(); }
});

test('交流保留最后一次回答机会，索引不提供正文，已取材料和原用量沿同一任务保存',async()=>{
  const f=await fixture((request,turn)=>{
    const offered=request.body.tools.map((t:any)=>t.function.name);
    if(turn===1)return calls(turn,['recall_memory',{kind:'opinion',view:'index'}]);
    if(turn===2){
      const index=request.body.messages.find((m:any)=>m.role==='tool').content;
      assert.ok(index.includes('index'));assert.equal(index.includes('完整旧看法正文'),false);
    }
    if(turn<6)return calls(turn,['search_original',{query:'设备甲'}]);
    assert.equal(offered.includes('search_original'),false);assert.equal(offered.includes('recall_memory'),false);
    assert.ok(request.body.messages.some((m:any)=>m.content.includes('第6/6次调用')));
    assert.ok(JSON.stringify(request.body.messages).includes('设备甲登记3件'));
    return{status:200,body:{choices:[{finish_reason:'stop',message:{content:'设备甲登记3件；其余条件仍需核对。'}}],usage:{prompt_tokens:10,completion_tokens:5}}};
  });
  try{
    f.state.memories.push({id:'prior-opinion',bookId:f.book.id,partnerId:f.state.partnerId,kind:'opinion',text:'完整旧看法正文',evidence:[evidence(f.book,f.book.known[0])],source:'reading',parents:[],chatIds:[],forgotten:false,createdAt:1});
    await f.engine.ask(f.book.id,'核对设备数量。');
    assert.equal(f.requests.length,6);assert.equal(f.state.chats.at(-1)?.text,'设备甲登记3件；其余条件仍需核对。');
    assert.equal(f.state.chats.find(c=>c.role==='user')?.delivery,'answered');
    assert.equal(f.state.usage.length,6);assert.ok(f.state.usage.every(u=>u.status==='complete'));
    assert.equal(f.state.memories.length,1);
  }finally{await f.close();}
});

test('Agent明确联网必须真正搜索和读取本轮网址，提前提交和自拟网址均被拒绝', async () => {
  let reads = 0, searches = 0;
  const f = await fixture((request,turn) => {
    if (turn === 1) return calls(turn,['submit_reading',final()]);
    if (turn === 2) return calls(turn,['search_web',{query:'copper corrosion chemistry'}]);
    if (turn === 3) return calls(turn,['read_page',{url:'https://example.org/invented'}],['read_page',{url:'https://example.org/source'}]);
    assert.ok(JSON.stringify(request.body).includes('ACTUAL-SOURCE-BODY')); return calls(turn,['submit_reading',final('已核对所取得的资料。')]);
  });
  try {
    f.state.settings.searchEnabled=true;
    f.engine.search=async()=>{ searches++;return {text:'SOURCE-SNIPPET',sources:[{title:'机构资料',url:'https://example.org/source'}]}; };
    f.engine.readPage=async url=>{ reads++;assert.equal(url,'https://example.org/source');return 'ACTUAL-SOURCE-BODY'; };
    await f.engine.ask(f.book.id,'请联网搜索铜的腐蚀原因，并阅读一个来源正文。');
    assert.equal(f.requests.length,4);assert.equal(reads,1);assert.equal(searches,1);assert.equal(f.state.chats.at(-1)?.webSources?.[0].read,true);
  } finally {await f.close();}
});

test('临时后文必须实际查阅且不写长期记忆，下一次普通问题的工具继续拒绝该范围', async () => {
  let granted = true, start=0,end=0;
  const f=await fixture((request,turn)=>{
    if(turn===1)return calls(turn,['submit_reading',final()]);
    if(turn===2 || turn===4)return calls(turn,['read_original',{start,end}]);
    if(!granted)assert.ok(!JSON.stringify(request.body).includes('FUTURE-ENGINE-SECRET'));
    return calls(turn,['submit_reading',final(granted?'本次范围已查阅。':'已按当前范围核对。',[{kind:'story',text:granted?'设备乙登记7件。':'设备甲登记3件。',basis}])]);
  });
  try{
    start=f.book.chapters[1].start;end=f.book.text.length;
    await f.engine.askWithFuture(f.book.id,'本次查看明确指定的后续范围。',{start,end},false);
    assert.equal(f.state.memories.length,0);assert.ok(f.state.chats.at(-1)?.futureGrant);assert.equal(f.book.known[0].end,start);
    granted=false;await f.engine.ask(f.book.id,'回到当前已读位置。');
    assert.equal(f.requests.length,5);assert.equal(f.state.memories.length,1);assert.equal(f.state.memories[0].text,'设备甲登记3件。');
  }finally{await f.close();}
});

test('前文准备、安静跟读和收尾共用Agent提交，保存理解而不制造发言', async()=>{
  const tasks:string[]=[];
  const f=await fixture((request,turn)=>{
    const parts=context(request),task=parts.find((p:any)=>p.task)?.task??'prepare';tasks.push(task);
    return calls(turn,['finish_reading',{text:task==='prepare'?'登记应保留准确数字。':'新增记录也应核对。'}]);
  });
  try{
    f.book.prepared=[];await f.engine.prepare(f.book.id);assert.equal(f.state.chats.length,0);assert.equal(f.state.memories[0].source,'preparation');
    f.engine.quiet(true);f.engine.observing(true);
    await f.engine.observe(f.book.id,f.book.text.slice(f.book.chapters[1].start));
    assert.equal(f.state.chats.length,0);assert.ok(f.state.memories.some(m=>m.source==='reading'&&m.kind==='opinion'));assert.deepEqual(tasks,['prepare','reading']);
    await f.engine.finishReading(f.book.id);assert.equal(f.requests.length,2);
  }finally{await f.close();}
});

test('显式旧结构取消未知后台后仍可回答插话，保留未知且停止自动重问',async()=>{
  let entered!:()=>void;const waiting=new Promise<void>(r=>{entered=r;});const order:string[]=[];
  const f=await fixture(async(request,turn,signal)=>{
    const task=context(request).find((p:any)=>p.task)?.task;order.push(task);
    if(turn===1){entered();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}
    return calls(turn,['submit_reading',final(task==='conversation'?'问题已核对。':'阅读理解已接续。')]);
  },'structured');
  try{
    f.engine.observing(true);const reading=f.engine.observe(f.book.id,f.book.text.slice(f.book.chapters[1].start));await waiting;
    const settled=await Promise.allSettled([reading,f.engine.ask(f.book.id,'先核对当前记录。')]);
    assert.ok(settled.some(r=>r.status==='rejected'&&r.reason.dispatch==='unknown'));assert.deepEqual(order,['reading','conversation']);assert.equal(f.state.usage[0].status,'unknown');assert.equal(f.state.chats.filter(c=>c.role==='user').length,1);
    assert.equal(f.state.chats.find(c=>c.role==='user')?.delivery,'answered');
  }finally{await f.close();}
});

test('Agent输出工具没有开放写文件或改权限，本次禁止联网时不注册联网能力',async()=>{
  const f=await fixture((request,turn)=>{
    assert.deepEqual(request.body.tools.map((t:any)=>t.function.name).sort(),['read_original','recall_discussion','recall_memory','search_original','submit_reading']);
    return calls(turn,['submit_reading',final()]);
  });
  try{f.state.settings.searchEnabled=true;f.engine.search=async()=>{throw new Error('must not search');};await f.engine.ask(f.book.id,'不要联网，核对当前已读内容。');assert.equal(f.requests.length,1);}finally{await f.close();}
});

test('不要保存新记忆由核心强制执行，模型仍提交thoughts也不保存，后续输入不再带入',async()=>{
  for(const text of ['本次不要保存新记忆','这次不写入长期记忆',"Don't store this in memory."])assert.equal(memoryIntent(text),'skip');
  assert.equal(memoryIntent('不要保存文件'),undefined);
  const f=await fixture((request,turn)=>{
    if(turn===1)assert.equal(context(request).find((p:any)=>p.task)?.memoryAllowed,false);
    else assert.ok(!JSON.stringify(request.body).includes('PRIVATE-ONCE'));
    return calls(turn,['submit_reading',final('本次已核对。',turn===1?[{kind:'story',text:'PRIVATE-ONCE',basis}]:[])]);
  });
  try{await f.engine.ask(f.book.id,'本次不要保存新记忆，临时信息PRIVATE-ONCE。');assert.equal(f.state.memories.length,0);assert.ok(f.state.chats.every(c=>c.excluded));await f.engine.ask(f.book.id,'继续讨论当前记录。');}finally{await f.close();}
});

test('原文工具后以完整JSON结束的Agent也能提交，沿用同一来源和权限检查',async()=>{
  const f=await fixture((request,turn)=>turn===1?calls(turn,['search_original',{query:'设备甲'}]):{status:200,body:{choices:[{finish_reason:'stop',message:{content:JSON.stringify(final('登记为3件。',[{kind:'story',text:'设备甲登记3件。',basis}]))}}],usage:{prompt_tokens:10,completion_tokens:5}}});
  try{await f.engine.ask(f.book.id,'核对当前登记。');assert.equal(f.requests.length,2);assert.equal(f.state.chats.at(-1)?.text,'登记为3件。');assert.equal(f.state.memories.length,1);}finally{await f.close();}
});

test('文本结束不能绕过必需的联网，原问题保留且不写记忆',async()=>{
  for(const content of [JSON.stringify(final()),JSON.stringify({reply:'完成了',thoughts:[]}), '完成了']){
    const f=await fixture(()=>({status:200,body:{choices:[{finish_reason:'stop',message:{content}}],usage:{prompt_tokens:10,completion_tokens:5}}}));
    try{f.state.settings.searchEnabled=true;f.engine.search=async()=>{throw new Error('not invoked');};await assert.rejects(f.engine.ask(f.book.id,'请联网搜索并阅读一个来源。'));assert.equal(f.state.chats.length,1);assert.equal(f.state.chats[0].delivery,'failed');assert.equal(f.state.memories.length,0);assert.equal(f.state.usage[0].status,'complete');}finally{await f.close();}
  }
});

test('明确不保存记忆的交流可直接接住纯文字结果，不为补格式再调用或写记忆',async()=>{
  const f=await fixture(()=>({status:200,body:{choices:[{finish_reason:'stop',message:{content:'当前读到第一章的设备登记。'}}],usage:{prompt_tokens:10,completion_tokens:5}}}));
  try{
    const scope=structuredClone(f.book.known);
    await f.engine.ask(f.book.id,'这次不要保存新记忆，请说明读到哪里。');
    assert.equal(f.requests.length,1);assert.equal(f.state.chats.at(-1)?.text,'当前读到第一章的设备登记。');
    assert.equal(f.state.chats[0].delivery,'answered');assert.equal(f.state.memories.length,0);
    assert.ok(f.state.chats.every(c=>c.excluded));assert.deepEqual(f.book.known,scope);
  }finally{await f.close();}
});

test('纯文字结束仍须完成明确搜索，损坏结构不得展示为正文',async()=>{
  for(const [content,question] of [
    ['原文记录已确认。','本次不要保存新记忆，请联网搜索资料。'],
    ['{"reply":"记录已确认", "thoughts":','本次不要保存新记忆，核对当前记录。'],
    ['普通正文。','核对当前记录并保存理解。'],
  ]){
    const f=await fixture(()=>({status:200,body:{choices:[{finish_reason:'stop',message:{content}}],usage:{prompt_tokens:10,completion_tokens:5}}}));
    try{
      f.state.settings.searchEnabled=true;f.engine.search=async()=>{throw new Error('must not call');};
      await assert.rejects(f.engine.ask(f.book.id,question));assert.equal(f.requests.length,question.includes('保存理解')?2:1);
      assert.equal(f.state.chats.length,1);assert.equal(f.state.memories.length,0);
    }finally{await f.close();}
  }
});

test('未要求写记忆的结构化回应可省略空操作字段，完成一次正常交流',async()=>{
  const f=await fixture(()=>({status:200,body:{choices:[{finish_reason:'stop',message:{content:JSON.stringify({reply:'登记为3件。'})}}],usage:{prompt_tokens:10,completion_tokens:5}}}));
  try{await f.engine.ask(f.book.id,'登记数量是多少？');assert.equal(f.requests.length,1);assert.equal(f.state.memories.length,0);assert.equal(f.state.chats.at(-1)?.text,'登记为3件。');}finally{await f.close();}
});

test('省略模型归因的认识保留全部已取得来源，更正来源仍停用后续判断',async()=>{
  const f=await fixture((_request,turn)=>calls(turn,['submit_reading',{reply:'复测时需要继续跟踪。',thoughts:[{kind:'opinion',text:'数量记录需要在复测时继续跟踪。'}]}]));
  try{
    f.state.memories.push({id:'earlier-record',bookId:f.book.id,partnerId:f.state.partnerId,kind:'opinion',text:'设备甲登记3件，复测时应留意数量。',evidence:[evidence(f.book,f.book.known[0])],source:'reading',parents:[],chatIds:[],forgotten:false,createdAt:1});
    await f.engine.ask(f.book.id,'如何看待当前登记数量？');
    const made=f.state.memories.find(m=>m.source==='conversation')!;
    assert.equal(f.requests.length,1);assert.equal(made.basis,undefined);assert.ok(made.parents.includes('earlier-record'));
    correctMemory(f.state,'earlier-record','此前数量登记有误，等待核实。');
    assert.ok(made.invalidatedBy);assert.ok(f.state.chats.at(-1)?.outdatedBy);
  }finally{await f.close();}
});

test('原文工具跨过未读间隔时返回实际获准部分，来源只绑定返回范围且不扩大权限',async()=>{
  let end=0,gapStart=0,gapEnd=0;
  const f=await fixture((request,turn)=>{
    if(turn===1){
      const packet=context(request).find((p:any)=>p.readPermission);
      assert.ok(packet.readPermission.nearbyRanges.length===2);
      return calls(turn,['read_original',{start:0,end}]);
    }
    const results=request.body.messages.filter((m:any)=>m.role==='tool').flatMap((m:any)=>JSON.parse(m.content).results);
    const original=results.filter((r:any)=>r.source==='获准原文');
    assert.deepEqual(original.map((r:any)=>({start:r.start,end:r.end})),[{start:0,end:gapStart},{start:gapEnd,end}]);
    assert.ok(results.some((r:any)=>r.source==='阅读范围'&&r.text.includes('未读取')));
    assert.equal(JSON.stringify(request.body).includes('FUTURE-ENGINE-SECRET'),false);
    assert.equal(original.some((r:any)=>r.text.includes('记录中的调度说明')),false);
    return calls(turn,['submit_reading',final('登记为3件。',[{kind:'story',text:'设备甲登记3件。',basis}])]);
  });
  try{
    gapStart=f.book.text.indexOf('记录中的调度说明');gapEnd=gapStart+'记录中的调度说明'.length;end=f.book.chapters[0].end;
    f.book.known=[{start:0,end:gapStart},{start:gapEnd,end}];f.book.prepared=[...f.book.known];
    const known=structuredClone(f.book.known);
    await f.engine.ask(f.book.id,'核对已读记录。');
    assert.deepEqual(f.book.known,known);assert.equal(f.requests.length,2);
    assert.ok(f.state.memories.at(-1)!.evidence.every(e=>e.end<=gapStart||e.start>=gapEnd&&e.end<=end));
  }finally{await f.close();}
});

test('Agent只能发展自己的已提供观点，误选用户偏好后可在同一轮改正，版本和回复一起保存',async()=>{
  const f=await fixture((request,turn)=>{
    const packet=context(request).find((p:any)=>p.memories);
    const opinion=packet.memories.find((m:any)=>m.kind==='opinion'),preference=packet.memories.find((m:any)=>m.kind==='user');
    assert.equal(opinion.canUpdate,true);assert.equal(preference.canUpdate,false);
    assert.match(opinion.id,/^m\d+$/);assert.equal(JSON.stringify(request.body.messages).includes('prior-opinion'),false);
    if(turn===2)assert.ok(JSON.stringify(request.body.messages.filter((m:any)=>m.role==='tool')).includes('只能更新'));
    return calls(turn,['submit_reading',final('新资料明确了登记数量。',[{kind:'opinion',text:'数量已经明确，不需要继续猜测。',basis:{memoryIds:[opinion.id],chatIds:[]},updates:turn===1?preference.id:opinion.id,updateReason:'已读登记说明数量为3件。',origin:'correction'}])]);
  });
  try{
    const original={id:'prior-opinion',bookId:f.book.id,partnerId:f.state.partnerId,kind:'opinion' as const,text:'登记数量仍值得核对。',evidence:[evidence(f.book,f.book.known[0])],source:'reading' as const,parents:[],chatIds:[],forgotten:false,createdAt:1};
    f.state.memories.push(original,{...original,id:'preference',kind:'user',source:'conversation',text:'用户喜欢简短交流。'});
    await f.engine.ask(f.book.id,'接着核对新的数量登记。');
    const updated=f.state.memories.find(m=>m.revisionKind==='development')!;
    assert.ok(updated);assert.equal(updated.correctionOf,original.id);assert.equal(original.replacedBy,updated.id);assert.equal(updated.source,'conversation');
    assert.equal(f.state.memories.find(m=>m.id==='preference')?.replacedBy,undefined);
    assert.equal(f.requests.length,2);assert.equal(f.state.chats.at(-1)?.outdatedBy,undefined);
    assert.equal(f.saves.at(-1).memories.find((m:any)=>m.id===original.id).replacedBy,updated.id);
  }finally{await f.close();}
});
