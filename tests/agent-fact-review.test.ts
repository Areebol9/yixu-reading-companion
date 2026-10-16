import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HarnessFactReviewer } from '../src/agent/fact-reviewer.ts';
import { ReadingEngine } from '../src/core/engine.ts';
import { importBook } from '../src/core/books.ts';
import { correctMemory, evidence, forgetMemory, usableMemories } from '../src/core/context.ts';
import {restoreBackup} from '../src/core/backup.ts';
import {planReadingBrief,selectReadingBrief} from '../src/core/reading-brief.ts';
import { initialState } from '../src/core/state.ts';
import { ChatModel } from '../src/core/model.ts';

function call(name: string, args: unknown, count: number) { return { status: 200, body: { choices: [{ finish_reason: 'tool_calls', message: { content: null, reasoning_content: `step-${count}`, tool_calls: [{ id: `call-${count}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 100, completion_tokens: 20 } } }; }
async function fixture(respond?: (request: any, count: number, signal: AbortSignal) => any, text = '第一章\n设备AX登记为3件。\n第二章\nUNREAD-FUTURE。') {
  const state = initialState(), book = await importBook('工程资料', text);
  book.known = [{ start: 0, end: book.chapters[0].end }]; book.position = book.chapters[0].end; state.books = [book]; state.settings.services[0].enabled = true;
  state.memories.push({ id: 'original', bookId: book.id, partnerId: state.partnerId, kind: 'story', text: '设备AX登记为5件。', evidence: [evidence(book, book.known[0])], source: 'preparation', createdAt: 1, forgotten: false, parents: [], chatIds: [] });
  const saves: any[] = [], requests: any[] = []; let failSave = false;
  const store = { async load() { return state; }, async save(next: typeof state) { if (failSave && next.memories.length > 1) throw new Error('Disk fixture failure'); saves.push(structuredClone(next)); } };
  const model = new ChatModel(async (request, signal) => {
    requests.push(request); assert.ok(saves.at(-1).usage.some((u: any) => u.status === 'reserved')); assert.ok(!JSON.stringify(request.body).includes('UNREAD-FUTURE'));
    if (respond) return respond(request, requests.length, signal);
    const input = (request.body.messages as any[]).filter(m => m.role === 'user').map(m => { try { return JSON.parse(m.content); } catch { return {}; } }).find(m => m.candidates);
    return call('submit_review', { items: [{ id: 'm0', text: '设备AX登记为3件。', sourceIds: [input.sources.find((s: any) => s.text.includes('设备AX')).id], reason: '按原文修订数量' }] }, requests.length);
  });
  const engine = new ReadingEngine(state, store, model), reviewer = new HarnessFactReviewer(); engine.factReviewer = reviewer;
  return { state, book, engine, reviewer, requests, saves, failSaving: () => { failSave = true; } };
}

test('正常核对命令通过上游循环提交结果，账本先落盘，只在提交保存后替换记忆', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.engine.reviewFacts(f.book.id), { reviewed: 1, unsupported: 0 });
    assert.equal(f.requests.length, 1); assert.equal(f.state.usage[0].input, 100); assert.equal(f.state.usage[0].status, 'complete');
    assert.equal(f.state.memories.length, 2); assert.equal(usableMemories(f.state, f.book)[0].text, '设备AX登记为3件。');
    assert.equal(f.saves.at(-1).memories[0].replacedBy, f.state.memories[1].id);
    assert.ok(f.requests[0].body.tools.some((t: any) => t.function.name === 'read_evidence'));
  } finally { f.engine.stop(); await f.reviewer.dispose(); }
});

test('停用的后续事实按原文重新建立版本，旧原因及独立看法保留，原问题不自动关闭',async()=>{
 const f=await fixture(request=>{
  const input=request.body.messages.filter((m:any)=>m.role==='user').map((m:any)=>{try{return JSON.parse(m.content);}catch{return {};}}).find((p:any)=>p.candidates);
  assert.equal(input.candidates[0].kind,'story');
  assert.equal(input.candidates[0].partialQuestion.text,'设备AX数量与停用原因分别是什么？');
  return call('submit_review',{items:[{id:'m0',text:'设备AX登记为3件。',sourceIds:[input.sources.find((s:any)=>s.text.includes('设备AX')).id],reason:'重新以原文核对数量。',answerRelation:'keep'}]},1);
 });
 try{
  const original=f.state.memories[0],refs=original.evidence;
  const root={...original,id:'root',text:'早期数量判断',createdAt:0};
  const question={...original,id:'question',kind:'question' as const,text:'设备AX数量与停用原因分别是什么？',createdAt:0};
  const opinion={...original,id:'opinion',kind:'opinion' as const,text:'登记步骤应优先确认来源。',createdAt:0};
  f.state.memories.push(root,question,opinion);original.parents=[root.id,question.id];original.answersPartOf=question.id;original.readingStage=[f.book.known[0]];
  const revision=correctMemory(f.state,root.id,'早期数量应按原文核实');assert.equal(original.invalidatedBy,revision.id);
  await f.engine.reviewFacts(f.book.id,original.id);
  const checked=f.state.memories.at(-1)!;
  assert.equal(checked.source,'review');assert.equal(checked.invalidatedBy,undefined);assert.deepEqual(checked.basis,{memoryIds:[],chatIds:[]});
  assert.equal(root.replacedBy,revision.id);assert.equal(original.replacedBy,checked.id);assert.equal(checked.answersPartOf,question.id);
  assert.equal(question.replacedBy,undefined);assert.deepEqual(checked.readingStage,original.readingStage);assert.equal(opinion.text,'登记步骤应优先确认来源。');
  assert.ok(usableMemories(f.state,f.book).some(m=>m.id===checked.id));assert.deepEqual(f.book.known,refs.map(({start,end})=>({start,end})));
  const restored=await restoreBackup(JSON.stringify(f.state),initialState());assert.ok(usableMemories(restored,restored.books[0]).some(m=>m.id===checked.id));
  forgetMemory(restored,original.id);assert.equal(restored.memories.find(m=>m.id===checked.id)!.forgotten,true);
 }finally{f.engine.stop();await f.reviewer.dispose();}
});

test('单条简报核对从实际形成段开始，保持简报类型、阶段与全部未解条件，不改独立看法',async()=>{
 const f=await fixture(request=>{
  const input=request.body.messages.filter((m:any)=>m.role==='user').map((m:any)=>{try{return JSON.parse(m.content);}catch{return {};}}).find((p:any)=>p.candidates);
  assert.equal(input.candidates[0].kind,'context');assert.match(request.body.messages[0].content,/保留其余未知/);
  return call('submit_review',{items:[{id:'m0',text:'本阶段设备AX登记3件；停用原因与恢复日期仍待核实。',sourceIds:[input.sources.find((s:any)=>s.text.includes('设备AX')).id],reason:'核对数量，保留两项待解条件。'}]},1);
 });
 try{
  const original=f.state.memories[0];original.kind='context';original.text='本阶段设备AX登记5件；停用原因与恢复日期仍待核实。';original.readingStage=[f.book.known[0]];
  f.state.memories.push({...original,id:'independent-view',kind:'opinion',text:'登记流程值得继续观察。'});
  await assert.rejects(f.engine.reviewFacts(f.book.id),/没有尚待核对/);
  await f.engine.reviewFacts(f.book.id,original.id);
  const checked=f.state.memories.at(-1)!;assert.equal(checked.kind,'context');assert.equal(selectReadingBrief(f.state,f.book)?.id,checked.id);
  assert.deepEqual(checked.readingStage,original.readingStage);assert.equal(f.state.memories.find(m=>m.id==='independent-view')!.text,'登记流程值得继续观察。');
  const restored=await restoreBackup(JSON.stringify(f.state),initialState());assert.equal(selectReadingBrief(restored,restored.books[0])?.text,checked.text);
  const next=planReadingBrief(restored,restored.books[0],'登记设备AX为3件；停用原因与恢复日期仍待核实。',checked.evidence,[checked.id],[],'reading',checked.readingStage!,[],[])!;
  restored.memories.find(m=>m.id===checked.id)!.replacedBy=next.memory.id;restored.memories.push(next.memory);
  const continued=await restoreBackup(JSON.stringify(restored),initialState());assert.equal(selectReadingBrief(continued,continued.books[0])?.id,next.memory.id);
  assert.equal(f.state.chats.length,0);assert.equal(f.book.position,f.book.chapters[0].end);
 }finally{f.engine.stop();await f.reviewer.dispose();}
});

test('伪造来源先被工具拒绝，模型可看到失败后修正；每一轮都有独立用量', async () => {
  const f = await fixture((request, count) => {
    const messages = request.body.messages;
    const initial = messages.filter((m: any) => m.role === 'user').map((m: any) => { try { return JSON.parse(m.content); } catch { return {}; } }).find((m: any) => m.candidates);
    if (count === 2) { assert.ok(messages.some((m: any) => m.role === 'tool' && m.tool_call_id === 'call-1')); assert.ok(messages.some((m: any) => m.reasoning_content === 'step-1')); }
    return call('submit_review', { items: [{ id: 'm0', text: '设备AX登记为3件。', sourceIds: count === 1 ? ['fabricated'] : [initial.sources.find((s: any) => s.text.includes('设备AX')).id], reason: '数量核对' }] }, count);
  });
  try { await f.engine.reviewFacts(f.book.id); assert.equal(f.requests.length, 2); assert.equal(f.state.usage.length, 2); assert.equal(f.state.memories.length, 2); }
  finally { f.engine.stop(); await f.reviewer.dispose(); }
});

test('已返回的完整字段只缺最外层右括号时一次提交，错误出处或缺失字段仍拒绝',async()=>{
 for(const invalid of ['none','source','text']){
  const f=await fixture((request,count)=>{
   const input=request.body.messages.filter((m:any)=>m.role==='user').map((m:any)=>{try{return JSON.parse(m.content);}catch{return {};}}).find((p:any)=>p.candidates);
   const item:any={id:'m0',text:'设备AX登记为3件。',sourceIds:[input.sources.find((s:any)=>s.text.includes('设备AX')).id],reason:'按原文核对'};
   if(count===1&&invalid==='source')item.sourceIds=['not-supplied'];if(count===1&&invalid==='text')delete item.text;
   const response=call('submit_review',{items:[item]},count);
   response.body.choices[0].message.tool_calls[0].function.arguments=JSON.stringify({items:[item]}).slice(0,-1);
   return response;
  });
  try{await f.engine.reviewFacts(f.book.id);assert.equal(f.requests.length,invalid==='none'?1:2);assert.equal(f.state.memories.length,2);assert.equal(f.state.memories.at(-1)!.text,'设备AX登记为3件。');}
  finally{f.engine.stop();await f.reviewer.dispose();}
 }
});

test('Agent提交结果后磁盘失败不发布新记忆，已发生的模型用量保留', async () => {
  const f = await fixture(); f.failSaving();
  try {
    await assert.rejects(f.engine.reviewFacts(f.book.id), /Disk fixture failure/);
    assert.equal(f.state.memories.length, 1); assert.equal(f.state.memories[0].replacedBy, undefined); assert.equal(f.state.usage[0].status, 'complete');
  } finally { f.engine.stop(); await f.reviewer.dispose(); }
});

test('读者问题中断Agent核对，原请求未知时停住核对但新问题仍可回答', async () => {
  let entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; }); const order: string[] = [];
  const f = await fixture(async (request, count, signal) => {
    if (request.body.tools) {
      order.push('review');
      if (count === 1) { entered(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
      const input = request.body.messages.filter((m: any) => m.role === 'user').map((m: any) => { try { return JSON.parse(m.content); } catch { return {}; } }).find((m: any) => m.candidates);
      return call('submit_review', { items: [{ id: 'm0', text: '设备AX登记为3件。', sourceIds: [input.sources.find((s: any) => s.text.includes('设备AX')).id], reason: '按原文核对' }] }, count);
    }
    order.push('question'); return { status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ reply: '登记为3件。', thoughts: [], wantsLong: false }) } }], usage: { prompt_tokens: 12, completion_tokens: 5 } } };
  });
  try {
    const work = f.engine.reviewFacts(f.book.id),stopped=assert.rejects(work); await waiting; await f.engine.ask(f.book.id, '数量是多少？');await stopped;await assert.rejects(f.engine.resumeFactReview(f.state.tasks![0].id));
    assert.deepEqual(order, ['review', 'question']); assert.equal(f.state.usage[0].status, 'unknown');
    assert.equal(f.state.memories.filter(m => m.source === 'review').length, 0); assert.equal(f.state.chats.find(c => c.role === 'user')?.delivery, 'answered');
  } finally { f.engine.stop(); await f.reviewer.dispose(); }
});

test('事实核对的完整JSON终态也走同一段落验证与原子修订，错误来源仍拒绝',async()=>{
  for(const valid of [true,false]){
    const f=await fixture(request=>{
      const input=request.body.messages.filter((m:any)=>m.role==='user').map((m:any)=>{try{return JSON.parse(m.content);}catch{return {};}}).find((m:any)=>m.candidates);
      return {status:200,body:{choices:[{finish_reason:'stop',message:{content:JSON.stringify({items:[{id:'m0',text:'设备AX登记为3件。',sourceIds:valid?[input.sources.find((s:any)=>s.text.includes('设备AX')).id]:['unseen-p999'],reason:'数量核对'}]})}}],usage:{prompt_tokens:100,completion_tokens:20}}};
    });
    try{if(valid){await f.engine.reviewFacts(f.book.id);assert.equal(f.state.memories.length,2);}else{await assert.rejects(f.engine.reviewFacts(f.book.id));assert.equal(f.state.memories.length,1);}assert.equal(f.state.usage[0].status,'complete');}finally{f.engine.stop();await f.reviewer.dispose();}
  }
});

test('旧引用遗漏事实时可回查同书其他已读原文，未读仍不可见，新引用与修订一并保存',async()=>{
  const f=await fixture((request,count)=>{
    if(count===1){
      const packet=request.body.messages.filter((m:any)=>m.role==='user').map((m:any)=>{try{return JSON.parse(m.content);}catch{return {};}}).find((p:any)=>p.candidates);
      assert.equal(packet.sourceCoverage.canSearchReadBook,true);
      assert.ok(packet.sources.every((s:any)=>!s.text.includes('登记为3件')));
      return call('read_evidence',{query:'设备AX'},count);
    }
    const returned=request.body.messages.filter((m:any)=>m.role==='tool').flatMap((m:any)=>JSON.parse(m.content).sources);
    const source=returned.find((s:any)=>s.text.includes('设备AX登记为3件'));
    assert.ok(source);assert.equal(JSON.stringify(returned).includes('UNREAD-FUTURE'),false);
    return call('submit_review',{items:[{id:'m0',text:'设备AX登记为3件。',sourceIds:[source.id],reason:'在其他已读原文中补齐依据。'}]},count);
  },'第一章\n'+'一般登记记录。'.repeat(100)+'\n设备AX登记为3件。\n第二章\nUNREAD-FUTURE。');
  try{
    const beforeKnown=structuredClone(f.book.known);
    f.state.memories[0].evidence=[evidence(f.book,{start:0,end:f.book.text.indexOf('\n')})];
    await f.engine.reviewFacts(f.book.id,'original');
    assert.equal(f.requests.length,2);assert.deepEqual(f.book.known,beforeKnown);
    const revised=f.state.memories.at(-1)!;
    assert.equal(revised.text,'设备AX登记为3件。');assert.ok(revised.evidence.some(e=>e.end>f.book.text.indexOf('登记为3件')));
    assert.equal(f.saves.at(-1).memories[0].replacedBy,revised.id);
  }finally{f.engine.stop();await f.reviewer.dispose();}
});
