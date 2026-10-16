import test from 'node:test';
import assert from 'node:assert/strict';
import {importBook,covers} from '../src/core/books.ts';
import {initialState} from '../src/core/state.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import {ChatModel} from '../src/core/model.ts';
import {HarnessRuntime} from '../src/agent/runtime.ts';
import {workspaceFor} from '../src/core/companion-workspace.ts';
import {prepareMemoryBodySnapshot} from '../src/core/memory-bodies.ts';
import {recoverInterruptedState} from '../src/core/startup.ts';
import type {Memory,MemoryBody,State,Store} from '../src/core/types.ts';

let sequence=0;
const tool=(name:string,args:unknown)=>({status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:'',tool_calls:[{id:'long-memory-engine-'+(++sequence),type:'function',function:{name,arguments:JSON.stringify(args)}}]}}],usage:{prompt_tokens:17,completion_tokens:9}}});
const natural=(content:string)=>({status:200,body:{choices:[{finish_reason:'stop',message:{content}}],usage:{prompt_tokens:17,completion_tokens:9}}});
const packets=(body:any)=>body.messages.filter((m:any)=>m.role==='user').flatMap((m:any)=>m.content.split('\n\n')).flatMap((text:string)=>{try{return [JSON.parse(text)];}catch{return [];}});
const main=(body:any)=>packets(body).find((p:any)=>p.currentRange);
const pages=(body:any)=>body.messages.filter((m:any)=>m.role==='tool').flatMap((m:any)=>{try{return JSON.parse(m.content).results??[];}catch{return [];}}).flatMap((result:any)=>{try{return [JSON.parse(result.text)];}catch{return [];}});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
async function within<T>(promise:Promise<T>,stage:string):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('ENGINE MOCK 并发等待超时：'+stage)),5000);})]);}finally{if(timer)clearTimeout(timer);}}

/** Exercise the ordinary Engine/Harness transport with metadata-only cold state. */
async function fixture(respond:(body:any,state:State)=>unknown|Promise<unknown>){
  const state=initialState(),book=await importBook('ENGINE MOCK 长期阅读文档','第一章 检修\n工厂登记维修与调班条件。\n第二章 校准\n校准完成，复测仍在进行。\n第三章 尚未读\nUNREAD-LONG-MEMORY-SECRET。');
  state.books=[book];book.readingStrategy='companion';book.known=[{start:0,end:book.chapters[0].end}];book.position=book.chapters[0].end;
  state.settings.services[0].enabled=true;Object.assign(state.settings,{tokenLimit:3000000,minReadChars:1,defaultQuiet:true});
  const bodies=new Map<string,MemoryBody>(),bodyReads:string[]=[],requests:any[]=[];
  let disk=structuredClone(state),index:unknown,failWhen:(value:State)=>boolean=()=>false;
  const store:Store={
    async load(){return structuredClone(disk);},
    async save(value){
      if(failWhen(value))throw Error('long-memory-engine disk failure');
      const snapshot=await prepareMemoryBodySnapshot(value);
      for(const body of snapshot.bodies)bodies.set(body.key,structuredClone(body));
      disk=structuredClone(snapshot.state);snapshot.commit();
    },
    async readMemoryBodies(refs){return refs.map(ref=>{bodyReads.push(ref.key);const body=bodies.get(ref.key);assert.ok(body,'A requested persisted body must exist');return structuredClone(body);});},
    async readMemoryIndex(){return structuredClone(index);},
    async writeMemoryIndex(value){index=structuredClone(value);}
  };
  const attach=async(value:State)=>{
    const model=new ChatModel(async request=>{
      requests.push(structuredClone(request.body));
      try{assert.equal(JSON.stringify(request.body).includes('UNREAD-LONG-MEMORY-SECRET'),false);return await respond(request.body,value) as any;}
      catch(error){console.error('ENGINE MOCK transport assertion:',(error as Error).stack);throw error;}
    });
    const runtime=new HarnessRuntime(),engine=new ReadingEngine(value,store,model);engine.agent=runtime;await engine.startReading(value.books[0].id);
    return {engine,state:value,book:value.books[0],async close(){engine.stop();await runtime.dispose();}};
  };
  const text=(memory:Memory)=>{if(typeof memory.text==='string')return memory.text;const body=memory.bodyRef&&bodies.get(memory.bodyRef.key);assert.ok(body,'Persisted document must retain its complete body');return body.text;};
  const active=await attach(state);
  return {state,book,store,bodies,bodyReads,requests,attach,text,active,get disk(){return structuredClone(disk);},set failWhen(value:(state:State)=>boolean){failWhen=value;}};
}

const firstBody='  ENGINE MOCK 检修线：工厂职员希望调班，检修尚待校准；条件与个人安排同时保留。\r\n'+('ENGINE MOCK 正文中的检修条件持续有效。'.repeat(24))+'FIRST-COMPLETE-DOCUMENT-TAIL  \n';
const secondBody='  ENGINE MOCK 校准线：校准记录与复测责任分别核对，复测完成前仍保留移交条件。\r\n'+('ENGINE MOCK 正文中的复测条件持续有效。'.repeat(24))+'SECOND-COMPLETE-DOCUMENT-TAIL  \n';

test('ENGINE MOCK 文档tN纯参数拒绝返回原理由，同正文补交保留两份原答费用且只提交一次',async()=>{
  const documents=[{operation:'create',text:firstBody,documentTitle:'完整检修正文'}];
  let calls=0,badCall:any,retained:any;
  const f=await fixture((body,state)=>{
    if(++calls===1){const response=tool('finish_reading',{documents,working:['t2']});badCall=response.body.choices[0].message.tool_calls[0];return response;}
    assert.equal(calls,2);assert.equal(state.memories.length,0);assert.equal(state.readings?.length??0,0);
    const history=body.messages.find((m:any)=>m.role==='assistant'&&m.tool_calls?.some((c:any)=>c.id===badCall.id));
    assert.deepEqual(history.tool_calls[0],badCall);
    assert.ok(JSON.stringify(body.messages.filter((m:any)=>m.role==='tool')).includes('工作台tN未指向本次实际提交的认识'));
    assert.ok(JSON.stringify(body.messages).includes('originalReplyRetained'));
    retained=structuredClone(state.companionReadingReceipts);
    assert.ok(retained.some((r:any)=>r.candidate.text===badCall.function.arguments));
    return tool('finish_reading',{documents,working:['t1']});
  });
  try{
    await f.active.engine.prepare(f.book.id);
    assert.equal(calls,2);assert.equal(f.state.readings?.length,1);assert.equal(f.state.memories.length,1);
    assert.equal(f.text(f.state.memories[0]),firstBody);assert.deepEqual(workspaceFor(f.state,f.book).workingIds,[f.state.memories[0].id]);
    const paid=f.state.usage.filter(u=>u.status==='complete');assert.equal(paid.length,2);assert.ok(paid.every(u=>u.input===17&&u.output===9&&!u.estimated));
  }finally{await f.active.close();}
});

test('ENGINE MOCK 两篇完整文档从新建到冷恢复再分别接续，退出工作集的旧版本仍保留独立全文',async()=>{
  const developed=firstBody+'ENGINE MOCK 后来校准完成；调班愿望仍需另外安排。\r\n',third='ENGINE MOCK 新增移交线：新增移交任务仍需完成复测。';
  let call=0;
  const f=await fixture(body=>{
    const packet=main(body);assert.ok(packet);assert.ok(body.tools.some((entry:any)=>entry.function?.name==='finish_reading'));
    if(++call===1)return tool('finish_reading',{documents:[{operation:'create',text:firstBody,documentTitle:'检修与调班',navigationCues:['工厂','调班愿望']},{operation:'create',text:secondBody,documentTitle:'校准与复测',navigationCues:['复测','移交']}],working:['t1','t2']});
    assert.equal(call,2);assert.equal(packet.workspaceMaterial.working.length,2);
    const a=packet.workspaceMaterial.working.find((m:any)=>m.text===firstBody),b=packet.workspaceMaterial.working.find((m:any)=>m.text===secondBody);assert.ok(a);assert.ok(b);
    return tool('finish_reading',{documents:[{operation:'develop',text:developed,updates:a.id,updateReason:'本轮校准完成，检修条件变化',documentTitle:'检修与调班的后续'},{operation:'create',text:third,documentTitle:'新增移交任务'}],working:['t1',b.id,'t2']});
  });
  let coldActive:Awaited<ReturnType<typeof f.attach>>|undefined;
  try{
    await f.active.engine.prepare(f.book.id);
    const firstIds=workspaceFor(f.state,f.book).workingIds!;assert.equal(firstIds.length,2);
    assert.deepEqual(firstIds.map(id=>f.text(f.state.memories.find(m=>m.id===id)!)),[firstBody,secondBody]);
    await f.active.close();const cold=(await f.store.load())!;
    assert.ok(cold.memories.every(m=>m.text===undefined&&m.bodyRef));recoverInterruptedState(cold);
    cold.books[0].known=[{start:0,end:cold.books[0].chapters[1].end}];cold.books[0].position=cold.books[0].chapters[1].end;
    coldActive=await f.attach(cold);await coldActive.engine.prepare(cold.books[0].id);
    assert.equal(call,2);assert.equal(cold.memories.length,4);
    const old=cold.memories.find(m=>m.id===firstIds[0])!,unchanged=cold.memories.find(m=>m.id===firstIds[1])!,newA=cold.memories.find(m=>m.correctionOf===old.id)!,newC=cold.memories.find(m=>f.text(m)===third)!;
    assert.equal(f.text(old),firstBody);assert.equal(f.text(unchanged),secondBody);assert.equal(old.replacedBy,newA.id);assert.equal(newA.revisionKind,'development');assert.equal(f.text(newA),developed);
    assert.deepEqual(workspaceFor(cold,cold.books[0]).workingIds,[newA.id,unchanged.id,newC.id]);
    assert.ok(covers(cold.books[0].prepared,cold.books[0].chapters[1]));assert.equal(cold.chats.length,0);
    assert.ok(f.disk.memories.every(m=>m.text===undefined&&m.bodyRef));
  }finally{await (coldActive??f.active).close();}
});

test('ENGINE MOCK 首包与发现工具只授导航，实际全文展开才登记查询来源并进入保存回答，未读档案不能取得',async()=>{
  let phase=0,oldId='',oldLabel='',forbiddenKey='';
  const answer='ENGINE MOCK 已核对旧检修档案：调班愿望和检修条件同时保留。';
  const f=await fixture((body,state)=>{
    const packet=main(body);assert.ok(packet);
    if(++phase===1)return tool('finish_reading',{documents:[{operation:'create',text:firstBody,documentTitle:'工厂调班愿望旧稿'},{operation:'create',text:secondBody,documentTitle:'当前复测工作'}],working:['t2']});
    const checkpoint=state.queryCheckpoints?.at(-1);assert.ok(checkpoint);
    if(phase===2){
      const entry=packet.memoryDiscovery.items.find((m:any)=>m.title==='工厂调班愿望旧稿');assert.ok(entry);assert.equal(entry.navigationOnly,true);assert.equal(entry.text,undefined);
      assert.equal(JSON.stringify(body.messages).includes('FIRST-COMPLETE-DOCUMENT-TAIL'),false);
      assert.equal(checkpoint.acquired.some(a=>a.kind==='memory'&&a.id===oldId&&a.view==='full'),false);
      return tool('read_memory_documents',{ids:['unread-long-memory-document']});
    }
    if(phase===3){assert.ok(body.messages.some((m:any)=>m.role==='tool'&&/编号|未提供/.test(m.content)));assert.equal(f.bodyReads.includes(forbiddenKey),false);return tool('discover_memory_documents',{query:'工厂调班愿望',mode:'focused'});}
    if(phase===4){
      const directory=pages(body).find((p:any)=>p.request?.view==='index');assert.ok(directory);const entry=directory.items.find((m:any)=>m.title==='工厂调班愿望旧稿');assert.ok(entry);oldLabel=entry.id;
      assert.equal(checkpoint.acquired.some(a=>a.kind==='memory'&&a.id===oldId),false,'Discovery remains reproducible navigation outside acquired sources');
      assert.equal(checkpoint.acquired.some(a=>a.kind==='memory'&&a.id===oldId&&a.view==='full'),false);
      return tool('read_memory_documents',{ids:[oldLabel]});
    }
    assert.equal(phase,5);const full=pages(body).find((p:any)=>p.request?.view==='full');assert.ok(full);assert.equal(full.items.find((m:any)=>m.id===oldLabel)?.text,firstBody);
    assert.ok(checkpoint.acquired.some(a=>a.kind==='memory'&&a.id===oldId&&a.view==='full'));
    return tool('submit_reading',{reply:answer,replyBasis:{memoryIds:[oldLabel],chatIds:[]},thoughts:[{kind:'opinion',text:'ENGINE MOCK 本轮沿旧调班愿望核对检修条件。',basis:{memoryIds:[oldLabel],chatIds:[]}}]});
  });
  let coldActive:Awaited<ReturnType<typeof f.attach>>|undefined;
  try{
    await f.active.engine.prepare(f.book.id);oldId=f.state.memories.find(m=>f.text(m)===firstBody)!.id;
    const template=f.state.memories.find(m=>m.id===oldId)!;
    f.state.memories.push({...template,id:'unread-long-memory-document',text:'UNREAD-LONG-MEMORY-SECRET',bodyRef:undefined,evidence:[{bookId:f.book.id,version:f.book.version,start:f.book.chapters[2].start,end:f.book.chapters[2].end}],readingStage:[f.book.chapters[2]]});
    await f.active.engine.persist();forbiddenKey=f.state.memories.find(m=>m.id==='unread-long-memory-document')!.bodyRef!.key;
    await f.active.close();const cold=(await f.store.load())!;recoverInterruptedState(cold);coldActive=await f.attach(cold);
    f.bodyReads.length=0;await coldActive.engine.ask(cold.books[0].id,'工厂职员早先的调班愿望与检修条件是什么？');
    assert.equal(phase,5);assert.equal(f.bodyReads.includes(forbiddenKey),false);
    const reply=cold.chats.find(c=>c.role==='assistant')!;assert.equal(reply.text,answer);assert.ok(reply.basis?.memoryIds.includes(oldId));
    const formed=cold.memories.find(m=>f.text(m)==='ENGINE MOCK 本轮沿旧调班愿望核对检修条件。')!;assert.ok(formed.parents.includes(oldId));
    const checkpoint=cold.queryCheckpoints!.at(-1)!;assert.equal(checkpoint.status,'consumed');assert.equal(checkpoint.replyId,reply.id);assert.ok(checkpoint.committedMemoryIds?.includes(formed.id));assert.deepEqual(checkpoint.acquired,[],'Consumed query material is released after its reply and actual lineage are committed');
  }finally{await (coldActive??f.active).close();}
});

test('ENGINE MOCK 多篇documents原回执在首次落草稿失败后冷恢复零重派，逐字正文与工作集共同保存',async()=>{
  const payload={documents:[{operation:'create',text:firstBody,documentTitle:'收到的检修完整稿',navigationCues:['调班','条件']},{operation:'create',text:secondBody,documentTitle:'收到的复测完整稿'}],working:['t2','t1']};
  let calls=0,failed=false;
  const f=await fixture(()=>{assert.equal(++calls,1,'The received complete documents must never be dispatched again');return tool('finish_reading',payload);});
  let coldActive:Awaited<ReturnType<typeof f.attach>>|undefined;
  try{
    f.failWhen=value=>{if(!failed&&value.readingDrafts?.some(d=>d.material.outputProtocol==='reading-documents-v1')){failed=true;return true;}return false;};
    await assert.rejects(f.active.engine.prepare(f.book.id),/long-memory-engine disk failure/);
    assert.equal(calls,1);const disk=f.disk,receipt=disk.companionReadingReceipts?.[0];assert.ok(receipt,'An accepted response must remain durable before a failed draft save');
    assert.equal(receipt.material.outputProtocol,'reading-documents-v1');assert.equal(receipt.candidate.text,JSON.stringify(payload));assert.equal(disk.memories.length,0);assert.equal(disk.readingDrafts?.length??0,0);assert.equal(disk.usage.at(-1)?.status,'complete');
    await f.active.close();const cold=(await f.store.load())!;recoverInterruptedState(cold);coldActive=await f.attach(cold);await coldActive.engine.prepare(cold.books[0].id);
    assert.equal(calls,1);assert.equal(cold.usage.length,1);assert.equal(cold.memories.length,2);
    const ids=workspaceFor(cold,cold.books[0]).workingIds!;assert.deepEqual(ids.map(id=>f.text(cold.memories.find(m=>m.id===id)!)),[secondBody,firstBody]);
    assert.deepEqual(cold.companionReadingReceipts,[]);assert.deepEqual(cold.readingDrafts,[]);assert.equal(cold.readings?.filter(r=>r.draftId===receipt.id).length,1);assert.equal(cold.chats.length,0);
    assert.ok(f.disk.memories.every(m=>m.text===undefined&&m.bodyRef));
  }finally{await (coldActive??f.active).close();}
});

test('ENGINE MOCK 同一来源更正影响两篇工作文档，冷恢复逐篇修订后保留两路完整接续而不丢先完成文档',async()=>{
  const source='ENGINE MOCK 共同早期来源：登记设备型号为A，检修与校准条件分别保留。';
  const correction='ENGINE MOCK 实际更正：登记设备型号为B，检修与校准条件分别保留。';
  const a='ENGINE MOCK 检修工作文档：型号A参与检修；独有检修条件REPAIR-LINE-ONE继续保留。';
  const b='ENGINE MOCK 校准工作文档：型号A参与校准；独有复测条件REPAIR-LINE-TWO继续保留。';
  const repairedA='ENGINE MOCK 检修工作文档：按实际更正型号B参与检修；独有检修条件REPAIR-LINE-ONE继续保留。';
  const repairedB='ENGINE MOCK 校准工作文档：按实际更正型号B参与校准；独有复测条件REPAIR-LINE-TWO继续保留。';
  let calls=0,sourceId='',completedRepairText='';
  const repairTargets:string[]=[];
  const f=await fixture(body=>{
    const packet=main(body);assert.ok(packet);calls++;
    if(calls===1)return tool('finish_reading',{documents:[{operation:'create',text:source,documentTitle:'早期共同登记'}],working:['t1']});
    if(calls===2){assert.equal(packet.workspaceMaterial.working[0].text,source);return tool('finish_reading',{documents:[{operation:'create',text:a,documentTitle:'检修工作文档'},{operation:'create',text:b,documentTitle:'校准工作文档'}],working:['t1','t2']});}
    assert.ok(calls<=4,'Repair must be one successful request per affected complete document');
    const repair=packets(body).find((p:any)=>p.repairMaterial)?.repairMaterial;assert.ok(repair,'Each request must identify its concrete withdrawn document');
    assert.ok(JSON.stringify(body.messages).includes(correction));assert.ok(!packet.workspaceMaterial.working.some((m:any)=>m.text===a||m.text===b));
    if(completedRepairText)assert.ok(packet.workspaceMaterial.working.some((m:any)=>m.text===completedRepairText),'The second repair must preserve the first completed working document');
    repairTargets.push(repair.oldDraft.id);assert.ok([a,b].includes(repair.oldDraft.text));
    completedRepairText=repair.oldDraft.text===a?repairedA:repairedB;
    return natural(completedRepairText);
  });
  let coldActive:Awaited<ReturnType<typeof f.attach>>|undefined;
  try{
    await f.active.engine.prepare(f.book.id);sourceId=f.state.memories.find(m=>f.text(m)===source)!.id;
    f.book.known=[{start:0,end:f.book.chapters[1].end}];f.book.position=f.book.chapters[1].end;
    await f.active.engine.prepare(f.book.id);const oldWorking=workspaceFor(f.state,f.book).workingIds!;
    assert.equal(oldWorking.length,2);assert.ok(oldWorking.every(id=>f.state.memories.find(m=>m.id===id)!.parents.includes(sourceId)));
    const prepared=structuredClone(f.book.prepared);await f.active.engine.correctMemory(sourceId,correction);
    const pending=f.state.companionCorrectionRepairs!.filter(p=>p.status==='pending');assert.equal(pending.length,2);assert.deepEqual(new Set(pending.map(p=>p.oldMemoryId)),new Set(oldWorking));assert.ok(pending.every(p=>p.workingDocument));
    assert.deepEqual(workspaceFor(f.state,f.book).workingIds,[]);assert.deepEqual(f.book.prepared,prepared);
    await f.active.close();const cold=(await f.store.load())!;recoverInterruptedState(cold);coldActive=await f.attach(cold);await coldActive.engine.prepare(cold.books[0].id);
    assert.equal(calls,4);assert.deepEqual(new Set(repairTargets),new Set(oldWorking));assert.equal(cold.companionCorrectionRepairs!.filter(p=>p.status==='complete').length,2);
    const working=workspaceFor(cold,cold.books[0]).workingIds!.map(id=>cold.memories.find(m=>m.id===id)!);
    assert.equal(working.length,2);assert.deepEqual(new Set(working.map(f.text)),new Set([repairedA,repairedB]));
    const correctionId=cold.memories.find(m=>m.correctionOf===sourceId&&m.source==='correction')!.id;
    assert.ok(working.every(m=>m.parents.includes(correctionId)&&m.correctionRepairSources?.memoryIds.includes(sourceId)));
    assert.ok(oldWorking.every(id=>cold.memories.find(m=>m.id===id)!.invalidatedBy===correctionId));
    assert.deepEqual(cold.books[0].prepared,prepared);assert.equal(cold.chats.length,0);
    await coldActive.engine.prepare(cold.books[0].id);assert.equal(calls,4,'Completed repairs must not repeat on another preparation');
  }finally{await (coldActive??f.active).close();}
});

test('ENGINE MOCK 前台新增与退出working不发展后台来源，后台双篇正文直接合并三方选择且零额外派发',async()=>{
  const backgroundEntered=deferred(),backgroundRelease=deferred();
  const newA=firstBody+'ENGINE MOCK 后台新增检修条件BACKGROUND-REPAIR-ONLY。\r\n';
  const newC='  ENGINE MOCK 后台独立移交文档：BACKGROUND-HANDOVER-ONLY条件保留。\r\n  ';
  const frontC='  ENGINE MOCK 前台独立选择文档：FOREGROUND-INDEPENDENT-ONLY条件保留。\r\n  ';
  const frontReply='ENGINE MOCK 已加入独立前台文档，并退出复测工作文档。';
  let calls=0,backgroundCalls=0,foregroundCalls=0;
  const f=await fixture(async body=>{
    calls++;const packet=main(body);assert.ok(packet);
    if(calls===1)return tool('finish_reading',{documents:[{operation:'create',text:firstBody,documentTitle:'检修工作文档'},{operation:'create',text:secondBody,documentTitle:'复测工作文档'}],working:['t1','t2']});
    const conversation=packets(body).find((p:any)=>p.task==='conversation');
    if(conversation){
      foregroundCalls++;const retained=packet.workspaceMaterial.working.find((m:any)=>m.text===firstBody);assert.ok(retained);
      return tool('submit_reading',{reply:frontReply,thoughts:[{kind:'opinion',text:frontC,documentTitle:'前台独立文档'}],workspace:{working:[retained.id,'t1']}});
    }
    backgroundCalls++;assert.equal(backgroundCalls,1,'Unrelated working selection must merge without another reading request');
    assert.equal(packets(body).some((p:any)=>p.unfinishedReading),false);
    const a=packet.workspaceMaterial.working.find((m:any)=>m.text===firstBody),b=packet.workspaceMaterial.working.find((m:any)=>m.text===secondBody);assert.ok(a);assert.ok(b);
    backgroundEntered.resolve();await backgroundRelease.promise;
    return tool('finish_reading',{documents:[{operation:'develop',text:newA,updates:a.id,updateReason:'后台本轮检修条件变化',documentTitle:'检修后续文档'},{operation:'create',text:newC,documentTitle:'后台移交文档'}],working:['t1',b.id,'t2']});
  });
  let reading:Promise<unknown>|undefined;
  try{
    f.active.engine.companionCandidate={workspaceHandoff:true,fairScheduling:true};
    await f.active.engine.prepare(f.book.id);const originalIds=workspaceFor(f.state,f.book).workingIds!;
    f.active.engine.observing(true);const next=f.book.chapters[1];reading=f.active.engine.observe(f.book.id,f.book.text.slice(next.start,next.end),'body','continuous-page');void reading.catch(()=>{});
    await within(backgroundEntered.promise,'后台双篇派发');
    await within(f.active.engine.ask(f.book.id,'加入独立前台文档，退出复测工作文档，保留检修来源。'),'前台工作集保存');
    const frontMemory=f.state.memories.find(m=>f.text(m)===frontC)!;assert.ok(frontMemory);
    assert.deepEqual(workspaceFor(f.state,f.book).workingIds,[originalIds[0],frontMemory.id]);assert.equal(f.state.memories.find(m=>m.id===originalIds[0])!.replacedBy,undefined);
    assert.equal(covers(f.book.prepared,next),false,'A dispatched background request has not completed reading');
    backgroundRelease.resolve();await within(reading,'后台原答直接三方合并');
    assert.equal(calls,3);assert.equal(foregroundCalls,1);assert.equal(backgroundCalls,1);
    const working=workspaceFor(f.state,f.book).workingIds!.map(id=>f.state.memories.find(m=>m.id===id)!);
    assert.deepEqual(new Set(working.map(f.text)),new Set([frontC,newA,newC]));assert.equal(working.some(m=>m.id===originalIds[1]),false);
    assert.equal(f.text(f.state.memories.find(m=>m.id===originalIds[1])!),secondBody,'The exited complete document remains in the archive');
    assert.equal(f.state.chats.find(c=>c.role==='assistant')?.text,frontReply);assert.ok(covers(f.book.prepared,next));assert.deepEqual(f.state.readingDrafts,[]);assert.deepEqual(f.state.companionReadingReceipts,[]);
    await f.active.engine.prepare(f.book.id);assert.equal(calls,3);
  }finally{backgroundRelease.resolve();await reading?.catch(()=>{});await f.active.close();}
});

test('ENGINE MOCK 前台发展同一后台来源时原双篇候选先落盘，只追加一次多篇接续并逐篇保留历史字节',async()=>{
  const backgroundEntered=deferred(),backgroundRelease=deferred();
  const frontA=firstBody+'ENGINE MOCK 前台新增决定FOREGROUND-DEVELOPMENT-ONLY。\r\n';
  const originalA=firstBody+'ENGINE MOCK 后台独有检修条件BACKGROUND-ORIGINAL-ONE。\r\n';
  const originalC='  ENGINE MOCK 后台独立移交文档：BACKGROUND-ORIGINAL-TWO条件保留。\r\n  ';
  const continuedA=frontA+'ENGINE MOCK 接续保留后台检修条件BACKGROUND-ORIGINAL-ONE。\r\n';
  const continuedC=originalC+'ENGINE MOCK 接续保留独立移交条件CONTINUED-HANDOVER。\r\n';
  const frontReply='ENGINE MOCK 已按当前问题发展检修工作文档。';
  let calls=0,backgroundCalls=0,foregroundCalls=0,continuationCalls=0;
  const f=await fixture(async(body,state)=>{
    calls++;const packet=main(body);assert.ok(packet);
    if(calls===1)return tool('finish_reading',{documents:[{operation:'create',text:firstBody,documentTitle:'检修工作文档'},{operation:'create',text:secondBody,documentTitle:'复测工作文档'}],working:['t1','t2']});
    const continuation=packets(body).find((p:any)=>p.unfinishedReading),conversation=packets(body).find((p:any)=>p.task==='conversation');
    if(conversation){
      foregroundCalls++;const a=packet.workspaceMaterial.working.find((m:any)=>m.text===firstBody),b=packet.workspaceMaterial.working.find((m:any)=>m.text===secondBody);assert.ok(a);assert.ok(b);
      return tool('submit_reading',{reply:frontReply,thoughts:[{kind:'opinion',text:frontA,updates:a.id,updateReason:'前台实际发展当前检修认识',documentTitle:'前台检修新版本'}],workspace:{working:['t1',b.id]}});
    }
    if(continuation){
      assert.equal(++continuationCalls,1,'The original task has only one bounded continuation');
      assert.deepEqual(continuation.unfinishedReading.documents.map((d:any)=>d.text),[originalA,originalC]);assert.equal(continuation.unfinishedReading.text,undefined);
      const draft=state.readingDrafts?.find(d=>d.material.outputProtocol==='reading-documents-v1');assert.ok(draft);assert.deepEqual(draft.result.thoughts.map(t=>t.text),[originalA,originalC]);
      const saved=f.disk.readingDrafts?.find(d=>d.id===draft.id);assert.ok(saved,'The complete candidate collection must be durable before another request');assert.deepEqual(saved.result.thoughts.map(t=>t.text),[originalA,originalC]);
      assert.ok((body.tools??[]).every((entry:any)=>entry.function.name==='finish_reading'),'The bounded continuation cannot acquire new material or send a reaction');
      const a=packet.workspaceMaterial.working.find((m:any)=>m.text===frontA),b=packet.workspaceMaterial.working.find((m:any)=>m.text===secondBody);assert.ok(a);assert.ok(b);
      return tool('finish_reading',{documents:[{operation:'develop',text:continuedA,updates:a.id,updateReason:'接续前台发展与后台独有检修条件',documentTitle:'接续后的检修文档'},{operation:'create',text:continuedC,documentTitle:'接续后的独立移交文档'}],working:['t1',b.id,'t2']});
    }
    assert.equal(++backgroundCalls,1);const a=packet.workspaceMaterial.working.find((m:any)=>m.text===firstBody),b=packet.workspaceMaterial.working.find((m:any)=>m.text===secondBody);assert.ok(a);assert.ok(b);
    backgroundEntered.resolve();await backgroundRelease.promise;
    return tool('finish_reading',{documents:[{operation:'develop',text:originalA,updates:a.id,updateReason:'后台本轮新增检修条件',documentTitle:'尚待并发接续的检修文档'},{operation:'create',text:originalC,documentTitle:'尚待并发接续的移交文档'}],working:['t1',b.id,'t2']});
  });
  let reading:Promise<unknown>|undefined;
  try{
    f.active.engine.companionCandidate={workspaceHandoff:true,fairScheduling:true};
    await f.active.engine.prepare(f.book.id);const originalIds=workspaceFor(f.state,f.book).workingIds!;
    f.active.engine.observing(true);const next=f.book.chapters[1];reading=f.active.engine.observe(f.book.id,f.book.text.slice(next.start,next.end),'body','continuous-page');void reading.catch(()=>{});
    await within(backgroundEntered.promise,'共享来源后台派发');
    await within(f.active.engine.ask(f.book.id,'发展当前检修文档，保留独有前台决定与复测工作文档。'),'前台发展同一来源保存');
    const frontMemory=f.state.memories.find(m=>f.text(m)===frontA)!;assert.ok(frontMemory);assert.equal(f.state.memories.find(m=>m.id===originalIds[0])!.replacedBy,frontMemory.id);assert.deepEqual(workspaceFor(f.state,f.book).workingIds,[frontMemory.id,originalIds[1]]);
    backgroundRelease.resolve();await within(reading,'原双篇候选落盘并完成一次多篇接续');
    assert.equal(calls,4);assert.equal(backgroundCalls,1);assert.equal(foregroundCalls,1);assert.equal(continuationCalls,1);
    const working=workspaceFor(f.state,f.book).workingIds!.map(id=>f.state.memories.find(m=>m.id===id)!);assert.deepEqual(new Set(working.map(f.text)),new Set([continuedA,secondBody,continuedC]));
    const history=f.state.memories.filter(m=>m.historicalOnly);assert.equal(history.length,2);assert.deepEqual(new Set(history.map(f.text)),new Set([originalA,originalC]));assert.ok(history.every(m=>!working.some(current=>current.id===m.id)));
    assert.equal(f.text(f.state.memories.find(m=>m.id===originalIds[0])!),firstBody);assert.equal(f.text(frontMemory),frontA);assert.ok(working.filter(m=>m.id!==originalIds[1]).every(m=>history.every(h=>m.parents.includes(h.id))));
    assert.equal(f.state.chats.find(c=>c.role==='assistant')?.text,frontReply);assert.ok(covers(f.book.prepared,next));assert.deepEqual(f.state.readingDrafts,[]);assert.deepEqual(f.state.companionReadingReceipts,[]);
    await f.active.engine.prepare(f.book.id);assert.equal(calls,4);
  }finally{backgroundRelease.resolve();await reading?.catch(()=>{});await f.active.close();}
});
