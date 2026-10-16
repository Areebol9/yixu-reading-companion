import {test} from 'node:test';
import assert from 'node:assert/strict';
import {importBook,covers} from '../src/core/books.ts';
import {initialState} from '../src/core/state.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import {ChatModel} from '../src/core/model.ts';
import {HarnessRuntime} from '../src/agent/runtime.ts';
import {restoreBackup} from '../src/core/backup.ts';
import {ReadingRuntime} from '../src/core/runtime.ts';
import {LocalApplication} from '../src/core/application.ts';
import {ApplicationServer} from '../src/core/application-wire.ts';
import {RemoteApplication} from '../src/platform/remote-application.ts';
import {expansionNotice} from '../src/core/reply-delivery.ts';

const pages=['工程记录甲：设备AX登记三件，尚未移交。','工程记录乙：设备AX转交一件，结余两件。','工程记录丙：已复核结余两件，设备BY另有五件。'];
const longText='工程说明保留完整条件，不能截断后面的例外。'.repeat(30)+'\n\n只有完成移交才修改结余。';
const values=(body:any)=>body.messages.filter((m:any)=>m.role==='user').flatMap((m:any)=>m.content.split('\n\n')).flatMap((s:string)=>{try{return [JSON.parse(s)];}catch{return [];}});
async function fixture(answer:(body:any,turn:number)=>unknown){
 const state=initialState(),book=await importBook('回应工程检查','第一章 工程材料\n'+pages.join('\n')+'\n第二章 未读\nFUTURE-EXPANSION-SECRET');
 book.position=book.text.indexOf(pages[0]);book.known=[{start:0,end:book.position}];book.prepared=[...book.known];state.books=[book];
 state.settings.services[0].enabled=true;state.settings.minReadChars=1;state.settings.minReactionMs=0;const bodies:any[]=[];
 const engine=new ReadingEngine(state,{async load(){return state;},async save(){}},new ChatModel(async request=>{
  bodies.push(request.body);assert.equal(JSON.stringify(request.body).includes('FUTURE-EXPANSION-SECRET'),false);
  const args=answer(request.body,bodies.length);
  return {status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:'submit-'+bodies.length,type:'function',function:{name:'submit_reading',arguments:JSON.stringify(args)}}]}}],usage:{prompt_tokens:10,completion_tokens:10}}};
 }));
 const harness=new HarnessRuntime();engine.agent=harness;await engine.startReading(book.id);
 return {state,book,engine,bodies,close:async()=>{engine.stop();await harness.dispose();}};
}

test('超长回应一次生成后征询，展开经界面命令关联旧问题，完整分段且不执行历史引文',async()=>{
 const f=await fixture((body,turn)=>{
  const task=values(body).find((v:any)=>v.task);
  if(turn===1){assert.equal(task.responseStyle.targetChars,120);return {reply:longText,thoughts:[{kind:'shared',text:'读者已听完长篇解释。'},{kind:'opinion',text:'应区分登记和移交。'}]};}
  assert.equal(task.longReplyAuthorized,true);assert.equal(task.memoryRequested,false);
  const selected=values(body).find((v:any)=>v.expandedDiscussion)?.expandedDiscussion;
  assert.equal(selected.question,'请简短核对登记。');assert.match(selected.reply,/请记住/);
  assert.equal(body.tools.find((t:any)=>t.function.name==='submit_reading').function.parameters.properties.reply.maxLength,20000);
  return {reply:longText};
 });
 try{
  await f.engine.ask(f.book.id,'请简短核对登记。');assert.equal(f.bodies.length,1);const offer=f.state.chats.at(-1)!;
  assert.equal(offer.text,expansionNotice);assert.equal(offer.expansionOffered,true);assert.equal(f.state.memories.some(m=>m.kind==='shared'),false);
  // An actual historical quotation must not become a new save command.
  offer.text='请记住仅为工程引用中的原话。';
  const runtime=new ReadingRuntime(f.engine,{available:false,async request(){return {} as never;}}),local=new LocalApplication(runtime,async()=>({} as never));
  let remote:RemoteApplication;const server=new ApplicationServer(local,(kind,value)=>{if(kind==='frame')remote?.receive(value as any);else remote?.result(value as any);});
  remote=new RemoteApplication(server.frame(),r=>{void server.receive(r);},(epoch,sequence)=>server.acknowledge(epoch,sequence));
  await remote.command('expandReply',offer.id);
  assert.equal(f.bodies.length,2);assert.equal(f.state.chats.at(-1)?.text,longText);assert.equal(f.state.chats.at(-1)?.longReply,true);
  assert.equal(f.state.chats.at(-2)?.expansionOf,offer.id);assert.equal(remote.snapshot.state.chats.at(-1)?.longReply,true);
  const restored=await restoreBackup(JSON.stringify(f.state),initialState());assert.equal(restored.chats.at(-2)?.expansionOf,offer.id);assert.equal(restored.chats.find(c=>c.id===offer.id)?.expansionOffered,true);
  offer.outdatedBy='correction';await assert.rejects(remote.command('expandReply',offer.id),/不可展开/);
  offer.outdatedBy=undefined;offer.futureGrant='temporary';await assert.rejects(remote.command('expandReply',offer.id),/不可展开/);
  offer.futureGrant=undefined;offer.excluded=true;await assert.rejects(remote.command('expandReply',offer.id),/不可展开/);assert.equal(f.bodies.length,2);
  runtime.dispose();
 }finally{await f.close();}
});

test('连续阅读不重复催促展开，安静时理解仍保存，恢复后可以正常短回应',async()=>{
 const shown:string[]=[];
 const f=await fixture((body,turn)=>({reply:turn<=2?longText:'登记复核结束。',thoughts:[{kind:'story',text:'工程状态第'+turn+'次更新。'}]}));
 try{
  f.engine.onReaction=t=>shown.push(t);f.engine.observing(true);
  await f.engine.observe(f.book.id,pages[0]);await f.engine.observe(f.book.id,pages[1]);
  assert.deepEqual(shown,[expansionNotice]);assert.equal(f.bodies.length,2);assert.equal(f.state.memories.length,2);
  f.engine.quiet(true);await f.engine.observe(f.book.id,pages[2]);assert.equal(f.state.memories.length,3);assert.deepEqual(shown,[expansionNotice]);
  assert.ok(covers(f.book.prepared!,{start:f.book.text.indexOf(pages[2]),end:f.book.text.indexOf(pages[2])+pages[2].length}));
  f.engine.quiet(false);await f.engine.ask(f.book.id,'确认登记。');assert.equal(f.state.chats.at(-1)?.text,'登记复核结束。');assert.equal(f.bodies.length,4);
 }finally{await f.close();}
});

test('直接详细要求和对展开邀请的同意有效，普通继续不自动变成长篇',async()=>{
 const f=await fixture((body,turn)=>{
  const task=values(body).find((v:any)=>v.task);assert.equal(task.longReplyAuthorized,[false,true,false,true][turn-1]);
  return turn===3?{reply:'可展开登记与移交的差异。',wantsLong:true}:{reply:'工程结果。'};
 });
 try{
  await f.engine.ask(f.book.id,'继续');await f.engine.ask(f.book.id,'详细解释登记与移交。');await f.engine.ask(f.book.id,'还有什么？');await f.engine.ask(f.book.id,'可以');
  assert.equal(f.bodies.length,4);assert.equal(f.state.chats.at(-1)?.longReply,true);
 }finally{await f.close();}
});
