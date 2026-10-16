import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importBook, covers } from '../src/core/books.ts';
import { evidence } from '../src/core/context.ts';
import { completeOriginal,discussionOriginal, supportingReadings } from '../src/core/grounding.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import {ChatModel} from '../src/core/model.ts';
import {HarnessRuntime} from '../src/agent/runtime.ts';
import { ReadingSources } from '../src/core/reading-sources.ts';
import { selectMemories, searchMemories } from '../src/core/recall.ts';
import { initialState } from '../src/core/state.ts';
import type { Memory } from '../src/core/types.ts';

test('近期原文按正文计章，卷标题保留在窗口内，部分章与授权缺口保持',async()=>{
 const state=initialState(),book=await importBook('跨卷窗口','第一章 登记\n设备甲已登记。\n第二章 移交\n设备乙已移交。\n第二卷 复核记录\n第三章 复核\n设备丙复核完成。\n第四章 未读\nFUTURE-CHAPTER');
 const first=book.chapters.find(c=>c.title.startsWith('第一章'))!,second=book.chapters.find(c=>c.title.startsWith('第二章'))!,third=book.chapters.find(c=>c.title.startsWith('第三章'))!,heading=book.chapters.find(c=>c.title.startsWith('第二卷'))!;
 assert.equal(book.text.slice(heading.start,heading.end).trim(),heading.title);book.known=[{start:first.start,end:third.end}];
 const selected=discussionOriginal(book,state.settings.services[0],third,{original:2,memories:'stage'})!;
 assert.deepEqual(selected,[{start:second.start,end:third.end}]);assert.ok(book.text.slice(selected[0].start,selected[0].end).includes(heading.title));
 const partial={start:third.start,end:third.start+third.title.length};book.known=[{start:first.start,end:second.end-1},{start:heading.start,end:partial.end}];
 const bounded=discussionOriginal(book,state.settings.services[0],partial,{original:2,memories:'stage'})!;
 assert.deepEqual(bounded,[{start:second.start,end:second.end-1},{start:heading.start,end:partial.end}]);assert.ok(!bounded.some(r=>r.end>partial.end));
});

test('同一正式Harness按全量或近期窗口提供获准原文，模型、工具和先前交流保持一致',async()=>{
 const state=initialState(),book=await importBook('窗口资料','第一章 登记\nEARLY-ORIGINAL：设备登记完毕。\n第二章 复核\n中期复核已经完成。\n第三章 交接\n设备移交给负责人，等待签收。\n第四章 未读\nFUTURE-WINDOW-SECRET');
 book.known=[{start:0,end:book.chapters[2].end}];book.prepared=[...book.known];book.position=book.chapters[2].end;state.books=[book];state.settings.services[0].enabled=true;
 state.memories=[{id:'old-view',bookId:book.id,partnerId:state.partnerId,kind:'opinion',text:'EARLIER-MEMORY：交接还需关注签收条件。',evidence:[evidence(book,book.known[0])],parents:[],chatIds:[],forgotten:false,source:'reading',createdAt:1}];
 const requests:any[]=[];
 for(const preference of [{original:'all' as const,memories:'none' as const},{original:2,memories:'selected' as const}]){
  const copy=structuredClone(state),engine=new ReadingEngine(copy,{async load(){return copy;},async save(){}},new ChatModel(async request=>{requests.push(request.body);return{status:200,body:{choices:[{finish_reason:'stop',message:{content:'还需要关注签收结果。'}}],usage:{prompt_tokens:1,completion_tokens:1}}};}),preference);
  const harness=new HarnessRuntime();engine.agent=harness;
  try{await engine.startReading(book.id);await engine.ask(book.id,'接着当前记录继续讨论。');}finally{engine.stop();await harness.dispose();}
 }
 assert.equal(requests.length,2);assert.deepEqual(requests[0].tools,requests[1].tools);assert.equal(requests[0].messages[0].content,requests[1].messages[0].content);
 const packets=requests.map(r=>r.messages.filter((m:any)=>m.role==='user').flatMap((m:any)=>m.content.split('\n\n')).flatMap((s:string)=>{try{return[JSON.parse(s)];}catch{return[];}}).find((p:any)=>p.currentRange));
 assert.equal(packets[0].originalMode,'complete-permitted-text');assert.equal(packets[0].memories.length,0);assert.ok(packets[0].current.includes('EARLY-ORIGINAL'));
 assert.equal(packets[1].originalMode,'recent-permitted-chapters');assert.equal(packets[1].current.includes('EARLY-ORIGINAL'),false);assert.ok(packets[1].memories.some((m:any)=>m.text.includes('EARLIER-MEMORY')));
 assert.equal(JSON.stringify(requests).includes('FUTURE-WINDOW-SECRET'),false);
 const c=book.chapters[2];
 assert.deepEqual(discussionOriginal(book,state.settings.services[0],c,{original:1,memories:'selected'}),[{start:c.start,end:c.end}]);
 book.known=[{start:0,end:10},{start:20,end:c.end}];
 assert.deepEqual(discussionOriginal(book,state.settings.services[0],c,{original:'all',memories:'none'}),book.known);
 assert.throws(()=>discussionOriginal(book,{...state.settings.services[0],contextLimit:1000},c,{original:'all',memories:'none'}),/完整提供/);
 const long=await importBook('长单章','第一章\n'+ '记录内容。'.repeat(4000));long.known=[{start:0,end:long.text.length}];long.position=long.text.length;
 assert.equal(discussionOriginal(long,state.settings.services[0],long.known[0],{original:3,memories:'stage'},false),undefined);
 assert.deepEqual(discussionOriginal(long,state.settings.services[0],long.known[0],{original:3,memories:'stage'}),long.known);
});

test('共有出处集中提供一次，已在当前原文中的引文不重复加入；未读和过大出处不借预算截取', async () => {
  const book = await importBook('依据工程', '条件甲：校准通过后允许使用。\n记录乙：设备仍在检修。\nFUTURE-SENTINEL');
  const first = { start: 0, end: book.text.indexOf('\n') }, second = { start: first.end + 1, end: book.text.indexOf('\nFUTURE') };
  book.known = [first, second];
  const state = initialState(); state.books = [book];
  const m: Memory = { id: 'one', bookId: book.id, partnerId: state.partnerId, kind: 'story', text: '使用需通过校准。', evidence: [evidence(book, first)], sourceEvidence: [evidence(book, first)], sourceQuote: { text: book.text.slice(first.start, first.end), evidence: evidence(book, first) }, parents: [], chatIds: [], forgotten: false, source: 'reading', createdAt: 1 };
  const candidates = [m, { ...m, id: 'two' }, { ...m, id: 'future', sourceEvidence: [evidence(book, { start: second.end + 1, end: book.text.length })], sourceQuote: undefined }];
  const ranges = supportingReadings(book, candidates, [second], '校准条件');
  assert.deepEqual(ranges, [first]); assert.deepEqual(supportingReadings(book, candidates, [first, second], '校准条件'), []);
  assert.deepEqual(supportingReadings(book, [m], [], '校准条件', [], 5), []);
  const sources = new ReadingSources();
  const messages = sources.messages(book, [{ role: 'user', content: JSON.stringify({ supportingReadings: ranges.map(r => ({ ...r, text: book.text.slice(r.start, r.end) })) }) }]);
  assert.ok(messages[0].content.includes('【p1】')); assert.equal(sources.passages.size, 1);
  assert.ok([...sources.passages.values()].every(s => covers(book.known, s.evidence)));
});

test('阶段方案保留伙伴看法与更正，旧事实按需取得，不改工具和阅读权限',async()=>{
 const state=initialState(),book=await importBook('阶段资料','第一章 早期\n设备必须先校准。\n第二章 当前\n设备已经运到库房。\n第三章 未读\nFUTURE-STAGE-SECRET');
 book.known=[{start:0,end:book.chapters[1].end}];book.prepared=[...book.known];book.position=book.chapters[1].end;state.books=[book];state.settings.services[0].enabled=true;
 const base:Memory={id:'old-fact',bookId:book.id,partnerId:state.partnerId,kind:'story',text:'HISTORICAL-FACT：必须先校准。',evidence:[evidence(book,book.chapters[0])],parents:[],chatIds:[],forgotten:false,source:'reading',createdAt:1};
 state.memories=[base,{...base,id:'perspective',kind:'opinion',text:'交接后仍应留意校准。'},{...base,id:'correction',source:'correction',text:'已核对录入的设备编号。'},{...base,id:'old-question',kind:'question',text:'何时进行早期校准？'},{...base,id:'shared',kind:'shared',source:'conversation',text:'曾经实际讨论过校准的重要性。'}];
 let calls=0;
 const engine=new ReadingEngine(state,{async load(){return state;},async save(){}},new ChatModel(async request=>{
  calls++;assert.equal(JSON.stringify(request.body).includes('FUTURE-STAGE-SECRET'),false);
  if(calls===1){
   const context=request.body.messages.filter((m:any)=>m.role==='user').flatMap((m:any)=>m.content.split('\n\n')).flatMap((s:string)=>{try{return[JSON.parse(s)];}catch{return[];}}).find((p:any)=>p.currentRange);
   assert.equal(context.memories.some((m:any)=>m.text.includes('HISTORICAL-FACT')),false);assert.equal(context.memories.some((m:any)=>m.kind==='question'),false);
   assert.ok(context.memories.some((m:any)=>m.origin==='correction'));assert.ok(context.memories.some((m:any)=>m.kind==='opinion'));assert.ok(context.memories.some((m:any)=>m.kind==='shared'));
   return{status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:'recall',type:'function',function:{name:'recall_memory',arguments:JSON.stringify({query:'HISTORICAL-FACT'})}}]}}],usage:{prompt_tokens:1,completion_tokens:1}}};
  }
  assert.ok(request.body.messages.some((m:any)=>m.role==='tool'&&m.content.includes('HISTORICAL-FACT')));
  return{status:200,body:{choices:[{finish_reason:'stop',message:{content:'已回查早期的校准条件。'}}],usage:{prompt_tokens:1,completion_tokens:1}}};
 }),{original:1,memories:'stage'});
 const harness=new HarnessRuntime();engine.agent=harness;
 try{await engine.startReading(book.id);await engine.ask(book.id,'以前的校准条件是什么？');assert.equal(calls,2);assert.ok(state.chats.at(-1)?.memoryIds?.includes(base.id));}
 finally{engine.stop();await harness.dispose();}
});

test('大书普通讨论默认近期阶段，小范围仍全量直读，显式旧策略可重现',async()=>{
 const state=initialState(),book=await importBook('默认选择','第一章 早期\n'+ '早期填充。'.repeat(4000)+'\n第二章 中期\nMID-STAGE记录。\n第三章 复核\n复核完成。\n第四章 当前\n交接开始。\n第五章 未读\nFUTURE-DEFAULT-SECRET');
 state.books=[book];book.known=[{start:0,end:book.chapters[3].end}];book.prepared=[...book.known];book.position=book.chapters[3].end;state.settings.services[0].enabled=true;
 let captured:any;
 const engine=new ReadingEngine(state,{async load(){return state;},async save(){}},new ChatModel(async request=>{
  captured=request.body.messages.filter((m:any)=>m.role==='user').flatMap((m:any)=>m.content.split('\n\n')).flatMap((s:string)=>{try{return[JSON.parse(s)];}catch{return[];}}).find((p:any)=>p.currentRange);
  assert.equal(JSON.stringify(request.body).includes('FUTURE-DEFAULT-SECRET'),false);
  return{status:200,body:{choices:[{finish_reason:'stop',message:{content:'核对本轮交接。'}}],usage:{prompt_tokens:1,completion_tokens:1}}};
 }));const harness=new HarnessRuntime();engine.agent=harness;
 try{await engine.startReading(book.id);await engine.ask(book.id,'简短说说。');assert.equal(captured.originalMode,'recent-permitted-chapters');assert.ok(captured.current.includes('MID-STAGE'));assert.equal(captured.current.includes('早期填充'),false);}
 finally{engine.stop();await harness.dispose();}
});

test('明确问题的旧条件优先于长篇当前页，未预选的完整资料仍可通过工具查询', async () => {
  const state = initialState(), book = await importBook('检索工程', '第一章 条件\n设备AX只有校准成功才能使用。\n第二章 当前\n' + '库房中仍在搬运包装箱。'.repeat(130));
  book.known = [{ start: 0, end: book.text.length }]; state.books = [book];
  const m: Memory = { id: 'rule', bookId: book.id, partnerId: state.partnerId, kind: 'story', text: '设备AX必须校准成功才允许使用。', evidence: [evidence(book, book.known[0])], parents: [], chatIds: [], forgotten: false, source: 'reading', createdAt: 1 };
  state.memories = [m, ...Array.from({ length: 36 }, (_, i) => ({ ...m, id: 'recent-' + i, text: `库房搬运包装箱的第${i}份记录。`, createdAt: i + 2 }))];
  const selected = selectMemories(state, book, { start: book.chapters[1].start, end: book.text.length }, '设备AX的使用条件是什么？', [], 6500, { focusQuestion: true, maxItems: 12 });
  assert.ok(selected.some(m => m.id === 'rule')); assert.ok(selected.length <= 12);
  const page = searchMemories(state, book, { query: '第5份' }); assert.ok(page.items.some(m => m.id === 'recent-5'));
});

test('直读只覆盖获准区间，依据渠道余量和材料体积回退，保留观点与人为更正', async () => {
  const state = initialState(), book = await importBook('直读工程', 'A'.repeat(20000)); state.books = [book];
  book.known = [{ start: 0, end: 6000 }, { start: 7000, end: 13000 }];
  assert.deepEqual(completeOriginal(book, state.settings.services[0]), book.known);
  assert.equal(completeOriginal(book, { ...state.settings.services[0], contextLimit: 16000 }), undefined);
  book.known = [{ start: 0, end: 20000 }]; assert.equal(completeOriginal(book, state.settings.services[0]), undefined);
  const m: Memory = { id: 'base', bookId: book.id, partnerId: state.partnerId, kind: 'story', text: '原文的普通概括。', evidence: [evidence(book, book.known[0])], parents: [], chatIds: [], forgotten: false, source: 'reading', createdAt: 1 };
  state.memories = [m, { ...m, id: 'view', kind: 'opinion', text: '先前的看法。' }, { ...m, id: 'correction', source: 'correction', text: '用户更正的记录。' }, { ...m, id: 'discussion', source: 'conversation', text: '曾经讨论过的事实。' }];
  const selected = selectMemories(state, book, { start: 0, end: 5 }, '', [], 6500, { originalComplete: true });
  assert.deepEqual(selected.map(m => m.id).sort(), ['correction','discussion','view']);
});
