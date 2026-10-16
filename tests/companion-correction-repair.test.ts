import test from 'node:test';
import assert from 'node:assert/strict';
import {importBook} from '../src/core/books.ts';
import {initialState} from '../src/core/state.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import {ChatModel} from '../src/core/model.ts';
import {HarnessRuntime} from '../src/agent/runtime.ts';
import {workspaceMaterial,workspaceFor,planWorkspace} from '../src/core/companion-workspace.ts';
import {correctionRepairUsable,pruneCorrectionRepairs} from '../src/core/companion-correction-repair.ts';
import {restoreBackup} from '../src/core/backup.ts';
import {deleteChat,forgetMemory} from '../src/core/context.ts';
import {forgetHabit} from '../src/core/habits.ts';
import type {State} from '../src/core/types.ts';

const bodies=['工程看法一：旧设备A及早期条件。','工程看法二：接续早期条件；中段独有认识MIDDLE。','工程看法三：接续前两轮；独有认识LATEST；保留中段MIDDLE。'];
async function fixture(){
  const s=initialState(),book=await importBook('工程更正恢复',Array.from({length:4},(_,i)=>`第${['一','二','三','四'][i]}章 工程\n${('工程记录'+i+'。').repeat(750)}\n`).join(''));
  s.books=[book];book.readingStrategy='companion';book.narrativeMode='legacy';Object.assign(s.settings,{tokenLimit:3000000,defaultQuiet:true,minReadChars:1});s.settings.services[0].enabled=true;
  let disk=structuredClone(s),count=0,fail:(v:State)=>boolean=()=>false;
  let waitForReply:((index:number)=>Promise<void>)|undefined;
  const overrides:any[]=[],packets:any[]=[],replies=[...bodies,'工程恢复：设备B，早期条件保留；MIDDLE与LATEST均保持。','工程第四轮：承接完整恢复看法，加入新段进展。','工程第五答：完整恢复加上第四段。'];
  const model=new ChatModel(async request=>{packets.push(request.body);const index=count++,content=replies[index];assert(content,'unexpected fixture dispatch');await waitForReply?.(index);return{status:200,body:{choices:[overrides[index]??{finish_reason:'stop',message:{content}}],usage:{prompt_tokens:10,completion_tokens:10}}};});
  const attach=(state:State)=>{const runtime=new HarnessRuntime(),engine=new ReadingEngine(state,{async load(){return structuredClone(disk);},async save(v){if(fail(v))throw Error('fixture save failed');disk=structuredClone(v);}},model,undefined,24000);engine.agent=runtime;return{engine,async close(){engine.stop();await runtime.dispose();}};};
  let active=attach(s);book.known=[{start:0,end:book.chapters[0].end}];book.position=book.chapters[0].end;await active.engine.startReading(book.id);
  const opinions:string[]=[];for(let i=0;i<3;i++){book.known=[{start:0,end:book.chapters[i].end}];book.position=book.chapters[i].end;await active.engine.prepare(book.id);opinions.push(workspaceFor(s,book).understandingId!);}
  return{s,book,opinions,packets,replies,overrides,attach,get active(){return active;},set active(v){active=v;},get count(){return count;},get disk(){return structuredClone(disk);},set fail(v:(s:State)=>boolean){fail=v;},set waitForReply(v:((index:number)=>Promise<void>)|undefined){waitForReply=v;}};
}
test('三轮完整理解更正后先恢复全范围，再接新段；备份保留pending',async()=>{
  const f=await fixture();try{
    const prepared=JSON.stringify(f.book.prepared);await f.active.engine.correctMemory(f.opinions[0],'工程更正：设备改为B，早期条件保留。');
    assert.equal(workspaceMaterial(f.s,f.book).understanding,undefined);assert.equal(JSON.stringify(f.book.prepared),prepared);const p=f.s.companionCorrectionRepairs![0];assert(correctionRepairUsable(f.s,p));assert.equal(p.oldDraft!.text,bodies[2]);
    await f.active.close();const cold=await restoreBackup(JSON.stringify(f.s),initialState());cold.settings.services[0].enabled=true;f.active=f.attach(cold);const book=cold.books[0];await f.active.engine.startReading(book.id);book.known=[{start:0,end:book.chapters[3].end}];book.position=book.chapters[3].end;await f.active.engine.prepare(book.id);
    assert.equal(f.count,5);const repair=JSON.stringify(f.packets[3]);assert(repair.includes('LATEST'));assert(repair.includes('MIDDLE'));assert(repair.includes('待修订旧稿'));assert(repair.includes('设备改为B'));assert(JSON.stringify(f.packets[4]).includes(f.replies[3]));assert.equal(workspaceMaterial(cold,book).understanding!.text,f.replies[4]);assert.equal(cold.companionCorrectionRepairs![0].status,'complete');assert.equal(cold.memories.find(m=>m.id===f.opinions[2])!.invalidatedBy,p.correctionIds[0]);
    const restored=await restoreBackup(JSON.stringify(f.s),cold);assert.equal(restored.companionCorrectionRepairs![0].status,'complete');assert.equal(workspaceMaterial(restored,restored.books[0]).understanding!.text,f.replies[4]);
    forgetMemory(cold,f.opinions[2]);assert.equal(workspaceMaterial(cold,book).understanding,undefined);
  }finally{await f.active.close();}
});
test('收到原答后最终保存失败，冷恢复沿原draft零重派发；未知原请求不重问',async()=>{
  const f=await fixture();try{
    await f.active.engine.correctMemory(f.opinions[0],'工程更正：设备B。');let failed=false;f.fail=v=>{if(!failed&&v.companionCorrectionRepairs?.some(p=>p.status==='complete')){failed=true;return true;}return false;};
    await assert.rejects(f.active.engine.prepare(f.book.id),/fixture save failed/);assert.equal(f.count,4);assert.equal(f.disk.companionCorrectionRepairs![0].status,'pending');assert.equal(f.disk.readingDrafts!.length,1);await f.active.close();
    const cold=await restoreBackup(JSON.stringify(f.disk),initialState());cold.settings.services[0].enabled=true;f.active=f.attach(cold);await f.active.engine.startReading(cold.books[0].id);await f.active.engine.prepare(cold.books[0].id);assert.equal(f.count,4);assert.equal(workspaceMaterial(cold,cold.books[0]).understanding!.text,f.replies[3]);assert.equal(cold.usage.length,4);
    const unknown=structuredClone(f.s),p=unknown.companionCorrectionRepairs![0];unknown.readingDrafts=[];unknown.companionReadingReceipts=[];unknown.usage.at(-1)!.status='unknown';await f.active.close();f.active=f.attach(unknown);await f.active.engine.startReading(unknown.books[0].id);await assert.rejects(f.active.engine.prepare(unknown.books[0].id),/尚未确定/);assert.equal(f.count,4);assert.equal(p.status,'pending');
  }finally{await f.active.close();}
});
test('撤回旧稿、撤权、删原交流及伙伴切换均禁供旧稿；普通遗忘不创建修复',async()=>{
  const f=await fixture();try{
    const before=structuredClone(f.s);forgetMemory(before,f.opinions[0]);assert.equal(before.companionCorrectionRepairs,undefined);
    // Add an actual old input conversation dependency before correction.
    const chat={id:'engineering-user',bookId:f.book.id,partnerId:f.s.partnerId,sessionId:f.active.engine.session!.id,role:'user' as const,text:'工程用户条件',evidence:[{bookId:f.book.id,version:f.book.version,start:0,end:f.book.chapters[0].end}],createdAt:Date.now(),excluded:false};f.s.chats.push(chat);f.s.memories.find(m=>m.id===f.opinions[2])!.chatIds.push(chat.id);
    await f.active.engine.correctMemory(f.opinions[0],'工程更正：设备B。');const pending=structuredClone(f.s);
    for(const change of [(s:State)=>forgetMemory(s,f.opinions[2]),(s:State)=>{s.books[0].known=[];},(s:State)=>deleteChat(s,chat.id),(s:State)=>{s.partners.push({...s.partners[0],id:'other-partner'});s.partnerId='other-partner';},(s:State)=>{s.books[0].version='changed';}]){const s=structuredClone(pending);change(s);pruneCorrectionRepairs(s);assert.equal(s.companionCorrectionRepairs![0].status,'blocked');assert.equal(s.companionCorrectionRepairs![0].oldDraft,undefined);}
    await f.active.engine.prepare(f.book.id);const recovered=workspaceMaterial(f.s,f.book).understanding!;assert(recovered.correctionRepairSources?.chatIds.includes(chat.id));deleteChat(f.s,chat.id);assert.equal(workspaceMaterial(f.s,f.book).understanding,undefined);assert(f.s.memories.find(m=>m.id===recovered.id)!.forgotten);
  }finally{await f.active.close();}
});
test('连续相关更正沿原任务；无关更正保留pending；新工作台禁止旧稿覆盖',async()=>{
  const f=await fixture();try{
    await f.active.engine.correctMemory(f.opinions[0],'工程更正：设备B。');const p=f.s.companionCorrectionRepairs![0],identity=p.id;const current=p.correctionIds[0];await f.active.engine.correctMemory(current,'工程更正：设备C。');assert.equal(p.id,identity);assert.equal(p.oldDraft!.text,bodies[2]);assert.equal(p.correctionIds.length,2);assert(correctionRepairUsable(f.s,p));
    const independent={...structuredClone(f.s.memories.find(m=>m.id===p.correctionIds.at(-1))!),id:'unrelated',text:'无关独立记录',source:'reading' as const,correctionOf:undefined};f.s.memories.push(independent);await f.active.engine.correctMemory(independent.id,'无关独立记录已改');assert.equal(p.correctionIds.length,2);assert(correctionRepairUsable(f.s,p));
    const w=workspaceFor(f.s,f.book);planWorkspace(f.s,f.book,{}, {memoryIds:[]},{expectedRevision:w.revision});await assert.rejects(f.active.engine.prepare(f.book.id),/工作台或来源已改变/);assert.equal(f.count,3);assert.equal(workspaceMaterial(f.s,f.book).understanding,undefined);
  }finally{await f.active.close();}
});
test('后台更正恢复在途时前台明确关注持久保存；完整修复保留新focus并继续新段',async()=>{
  const f=await fixture();let release!:()=>void;try{
    await f.active.engine.correctMemory(f.opinions[0],'工程更正：设备B。');
    let started!:()=>void;const entered=new Promise<void>(done=>{started=done;}),held=new Promise<void>(done=>{release=done;});f.waitForReply=async index=>{if(index===3){started();await held;}};
    const recovering=f.active.engine.prepare(f.book.id);const outcome=recovering.then(()=>undefined,e=>e);await entered;
    const focusText='工程关注：后续设备条件如何接续？',frontReply='已保留设备条件的关注。';f.overrides[4]={finish_reason:'tool_calls',message:{content:'',tool_calls:[{id:'focus-submit',type:'function',function:{name:'submit_reading',arguments:JSON.stringify({reply:frontReply,thoughts:[{kind:'question',text:focusText}],workspace:{focus:['t1']},wantsLong:false})}}]}};await f.active.engine.ask(f.book.id,'当前设备条件是什么？');assert.equal(f.count,5);assert(f.s.chats.some(c=>c.role==='assistant'&&c.text===frontReply));const focused=f.s.memories.find(m=>m.text===focusText)!;assert(focused);assert.deepEqual(workspaceFor(f.s,f.book).focusIds,[focused.id]);assert.deepEqual(workspaceFor(f.disk,f.disk.books[0]).focusIds,[focused.id]);assert.equal(f.disk.companionCorrectionRepairs![0].focusHandoffs!.length,1);assert.equal(workspaceMaterial(f.s,f.book).understanding,undefined);assert(!JSON.stringify(f.packets[4]).includes('LATEST'));
    const revision=workspaceFor(f.s,f.book).revision;release();const error=await outcome;assert.equal(error,undefined);assert.equal(workspaceFor(f.s,f.book).revision,revision+1);assert.equal(workspaceMaterial(f.s,f.book).understanding!.text,f.replies[3]);assert.equal(f.s.companionCorrectionRepairs![0].status,'complete');assert.equal(f.s.usage.length,5);assert.deepEqual(workspaceFor(f.s,f.book).focusIds,[focused.id]);f.book.known=[{start:0,end:f.book.chapters[3].end}];f.book.position=f.book.chapters[3].end;await f.active.engine.prepare(f.book.id);assert.equal(f.count,6);assert(JSON.stringify(f.packets[5]).includes(f.replies[3]));assert(JSON.stringify(f.packets[5]).includes('当前设备条件是什么'));assert(JSON.stringify(f.packets[5]).includes(focusText));assert.deepEqual(workspaceFor(f.s,f.book).focusIds,[focused.id]);assert.equal(workspaceMaterial(f.s,f.book).understanding!.text,f.replies[5]);
  }finally{release?.();await f.active.close();}
});
test('原答转草稿保存失败后冷恢复沿原raw，旧稿的实际习惯撤回传播到修复正文',async()=>{
  const f=await fixture();try{
    const habit={id:'engineering-habit',partnerId:f.s.partnerId,key:'replyLength' as const,value:'brief',createdAt:Date.now(),forgotten:false};f.s.habits=[habit];f.s.memories.find(m=>m.id===f.opinions[2])!.habitIds=[habit.id];
    await f.active.engine.correctMemory(f.opinions[0],'工程更正：设备B。');let failed=false;f.fail=v=>{if(!failed&&v.readingDrafts?.some(d=>d.correctionRepairId)){failed=true;return true;}return false;};await assert.rejects(f.active.engine.prepare(f.book.id),/fixture save failed/);assert.equal(f.count,4);assert.equal(f.disk.readingDrafts?.length??0,0);assert.equal(f.disk.companionReadingReceipts!.length,1);await f.active.close();
    const cold=await restoreBackup(JSON.stringify(f.disk),initialState());cold.settings.services[0].enabled=true;f.active=f.attach(cold);await f.active.engine.startReading(cold.books[0].id);await f.active.engine.prepare(cold.books[0].id);assert.equal(f.count,4);const repaired=workspaceMaterial(cold,cold.books[0]).understanding!;assert(repaired.habitIds?.includes(habit.id));assert(JSON.stringify(f.packets[3]).includes('commonHabits'));
    forgetHabit(cold,habit.id);assert.equal(workspaceMaterial(cold,cold.books[0]).understanding,undefined);assert(cold.memories.find(m=>m.id===repaired.id)!.forgotten);
  }finally{await f.active.close();}
});
test('恢复原请求在途时撤权保留原回执，权限恢复也不复活撤回旧稿',async()=>{
  const f=await fixture();let release!:()=>void;try{
    await f.active.engine.correctMemory(f.opinions[0],'工程更正：设备B。');const pending=JSON.stringify(f.s);let started!:()=>void;const entered=new Promise<void>(done=>{started=done;}),held=new Promise<void>(done=>{release=done;});f.waitForReply=async index=>{if(index===3){started();await held;}};
    const recovery=f.active.engine.prepare(f.book.id).then(()=>undefined,e=>e);await entered;f.book.known=[];f.active.engine.invalidateKnowledge();release();assert(await recovery);assert.equal(f.count,4);assert.equal(workspaceMaterial(f.s,f.book).understanding,undefined);assert.equal(f.s.companionCorrectionRepairs![0].status,'blocked');assert.equal(f.s.companionCorrectionRepairs![0].oldDraft,undefined);
    f.book.known=[{start:0,end:f.book.chapters[2].end}];const restored=await restoreBackup(pending,f.s);assert.equal(restored.companionCorrectionRepairs![0].status,'blocked');assert.equal(restored.companionCorrectionRepairs![0].oldDraft,undefined);assert.equal(workspaceMaterial(restored,restored.books[0]).understanding,undefined);assert.equal(restored.usage.length,4);
  }finally{release?.();await f.active.close();}
});
test('修复完整正文恰好等于既有有效opinion仍创建新稿；范围扩大后的当前更正进入真实依赖',async()=>{
  const f=await fixture();try{
    const independent={id:'existing-valid-opinion',bookId:f.book.id,partnerId:f.s.partnerId,kind:'opinion' as const,text:f.replies[3],evidence:[{bookId:f.book.id,version:f.book.version,start:0,end:f.book.chapters[0].end}],parents:[],chatIds:[],createdAt:Date.now(),forgotten:false,source:'preparation' as const};f.s.memories.push(independent);const prior=JSON.stringify(independent),oldCoverage=structuredClone(f.s.memories.find(m=>m.id===f.opinions[2])!.evidence);
    f.book.known=[{start:0,end:f.book.chapters[3].end}];f.book.position=f.book.chapters[3].end;await f.active.engine.correctMemory(f.opinions[0],'工程更正：设备B，最新许可含第四段。');const correctionId=f.s.companionCorrectionRepairs![0].correctionIds[0];await f.active.engine.prepare(f.book.id);
    assert.equal(f.count,5);const repaired=f.s.memories.find(m=>m.correctionRepairSources&&m.text===independent.text)!;assert(repaired);assert.notEqual(repaired.id,independent.id);assert.equal(repaired.source,'preparation');assert(repaired.parents.includes(correctionId));assert((repaired.basis?.memoryIds??repaired.parents).includes(correctionId));assert.equal(JSON.stringify(independent),prior);assert.equal(f.s.companionCorrectionRepairs![0].status,'complete');assert.equal(JSON.stringify(f.s.companionCorrectionRepairs![0].ranges.map(({start,end})=>({start,end}))),JSON.stringify(oldCoverage.map(({start,end})=>({start,end}))));assert.equal(repaired.readingStage!.at(-1)!.end,f.book.chapters[2].end);assert(JSON.stringify(f.packets[3]).includes('最新许可含第四段'));assert(JSON.stringify(f.packets[4]).includes(repaired.text));
    await f.active.engine.correctMemory(correctionId,'工程更正：设备C。');const nextCorrection=f.s.memories.find(m=>m.correctionOf===correctionId)!;assert.equal(repaired.invalidatedBy,nextCorrection.id);assert.equal(workspaceMaterial(f.s,f.book).understanding,undefined);assert.equal(f.count,5);
  }finally{await f.active.close();}
});
test('pending尚未开修复时首问直接答并保存focus，随后prepare只派发一次修复',async()=>{
  const f=await fixture();try{
    await f.active.engine.correctMemory(f.opinions[0],'工程更正：设备B。');const p=f.s.companionCorrectionRepairs![0],focusText='工程首问关注：设备条件何时补齐？',frontReply='已记录设备条件的关注。';f.replies[4]=f.replies[3];
    f.overrides[3]={finish_reason:'tool_calls',message:{content:'',tool_calls:[{id:'first-question-focus',type:'function',function:{name:'submit_reading',arguments:JSON.stringify({reply:frontReply,thoughts:[{kind:'question',text:focusText}],workspace:{focus:['t1']},wantsLong:false})}}]}};
    await f.active.engine.ask(f.book.id,'设备目前改成什么条件？');assert.equal(f.count,4);assert(!JSON.stringify(f.packets[3]).includes('repairMaterial'));assert(!JSON.stringify(f.packets[3]).includes('LATEST'));assert(JSON.stringify(f.packets[3]).includes('设备B'));assert(f.s.chats.some(c=>c.role==='assistant'&&c.text===frontReply));assert.equal(p.status,'pending');assert.equal(workspaceMaterial(f.s,f.book).understanding,undefined);const focused=f.s.memories.find(m=>m.text===focusText)!;assert(focused);assert.deepEqual(workspaceFor(f.disk,f.disk.books[0]).focusIds,[focused.id]);assert.equal(f.s.companionCorrectionRepairs![0].focusHandoffs!.length,1);
    await f.active.engine.prepare(f.book.id);assert.equal(f.count,5);assert.equal(f.s.companionCorrectionRepairs![0].status,'complete');assert.equal(workspaceMaterial(f.s,f.book).understanding!.text,f.replies[4]);assert.deepEqual(workspaceFor(f.s,f.book).focusIds,[focused.id]);assert(JSON.stringify(f.packets[4]).includes('repairMaterial'));assert(JSON.stringify(f.packets[4]).includes('LATEST'));assert.equal(f.s.usage.filter(u=>u.requestKey&&JSON.parse(u.requestKey).length===6).length,1);
    await f.active.engine.prepare(f.book.id);assert.equal(f.count,5);assert.equal(f.s.chats.filter(c=>c.role==='assistant'&&c.text===frontReply).length,1);
  }finally{await f.active.close();}
});
test('修复不批量消费旧祖先或原交流，未首供的完整暴露仍沿撤回关系传播',async()=>{
  const f=await fixture();try{
    const leaf={id:'unprovided-leaf',bookId:f.book.id,partnerId:f.s.partnerId,kind:'opinion' as const,text:'UNSUPPLIED-LEAF'+('工程旧源。').repeat(2100),evidence:[{bookId:f.book.id,version:f.book.version,start:0,end:f.book.chapters[0].end}],parents:[],chatIds:[],createdAt:Date.now(),forgotten:false,source:'preparation' as const};f.s.memories.push(leaf);const latest=f.s.memories.find(m=>m.id===f.opinions[2])!;latest.parents.push(leaf.id);
    for(let i=0;i<11;i++)f.s.chats.push({id:'old-input-'+i,bookId:f.book.id,partnerId:f.s.partnerId,sessionId:f.active.engine.session!.id,role:'user',text:i===0?'UNSUPPLIED-CHAT工程旧交流':'工程近期交流'+i,evidence:leaf.evidence,createdAt:Date.now()+i,excluded:false});latest.chatIds.push('old-input-0');
    await f.active.engine.correctMemory(f.opinions[0],'工程更正：设备B，仅当前有效更正需完整首供。');const p=f.s.companionCorrectionRepairs![0];assert(p.memoryIds.includes(leaf.id));assert(p.chatIds.includes('old-input-0'));await f.active.engine.prepare(f.book.id);assert.equal(f.count,4);
    const packet=JSON.stringify(f.packets[3]),repaired=workspaceMaterial(f.s,f.book).understanding!;assert(!packet.includes('UNSUPPLIED-LEAF'));assert(!packet.includes('UNSUPPLIED-CHAT'));assert(packet.includes(bodies[2]));assert.equal(packet.split('工程更正：设备B，仅当前有效更正需完整首供。').length-1,1);assert(!repaired.parents.includes(leaf.id));assert(!(repaired.basis?.memoryIds??repaired.parents).includes(leaf.id));assert(!repaired.chatIds.includes('old-input-0'));assert(repaired.correctionRepairSources!.memoryIds.includes(leaf.id));assert(repaired.correctionRepairSources!.chatIds.includes('old-input-0'));
    const forgotten=structuredClone(f.s);forgetMemory(forgotten,leaf.id);assert.equal(workspaceMaterial(forgotten,forgotten.books[0]).understanding,undefined);deleteChat(f.s,'old-input-0');assert.equal(workspaceMaterial(f.s,f.book).understanding,undefined);
  }finally{await f.active.close();}
});
function sixRoundRepair(f:Awaited<ReturnType<typeof fixture>>,final:'finish'|'natural'|'recall'){
  // A custom fixed-response fixture can carry the production capacity through backup.
  Object.assign(f.s.settings.services[0],{id:'custom-repair-fixture',baseUrl:'https://fixture.invalid/v1',model:'gpt-6.1-sol',effort:'high',maxOutput:32768,contextLimit:872000});f.s.settings.serviceId='custom-repair-fixture';
  while(f.replies.length<9)f.replies.push('工程修复末轮正文：设备B，早期条件、中段MIDDLE及LATEST全部接续。');
  for(let i=0;i<5;i++)f.overrides[3+i]={finish_reason:'tool_calls',message:{content:'',tool_calls:[{id:'repair-material-'+i,type:'function',function:{name:'recall_memory',arguments:JSON.stringify({kind:'opinion',view:'index',offset:i})}}]}};
  if(final==='finish')f.overrides[8]={finish_reason:'tool_calls',message:{content:'',tool_calls:[{id:'repair-final',type:'function',function:{name:'finish_reading',arguments:JSON.stringify({text:f.replies[8]})}}]}};
  if(final==='recall')f.overrides[8]={finish_reason:'tool_calls',message:{content:'',tool_calls:[{id:'repair-illegal-last-material',type:'function',function:{name:'recall_memory',arguments:JSON.stringify({kind:'opinion',view:'index',offset:5})}}]}};
}
test('修复前五轮实际取材，第六轮finish或自然正文保存；末轮仅开放正文出口',async t=>{
  for(const final of ['finish','natural'] as const)await t.test(final,async()=>{
    const f=await fixture();try{
      sixRoundRepair(f,final);await f.active.engine.correctMemory(f.opinions[0],'工程更正：设备B。');await f.active.engine.prepare(f.book.id);assert.equal(f.count,9);assert.equal(f.s.usage.filter(u=>u.requestKey&&JSON.parse(u.requestKey).length===6).length,6);assert.equal(workspaceMaterial(f.s,f.book).understanding!.text,f.replies[8]);assert.equal(f.s.companionCorrectionRepairs![0].status,'complete');
      for(let n=3;n<8;n++)assert(f.packets[n].tools.some((tool:any)=>tool.function.name==='recall_memory'));assert.deepEqual(f.packets[8].tools.map((tool:any)=>tool.function.name),['finish_reading']);assert(f.packets[8].messages.some((m:any)=>m.content.includes('第6/6次调用')));assert(f.packets[8].messages.some((m:any)=>m.content.includes('最长12000字符')));assert.equal(f.packets[8].max_tokens,32768);await f.active.engine.prepare(f.book.id);assert.equal(f.count,9);
    }finally{await f.active.close();}
  });
});
test('修复第六轮继续取材在SDK执行前拒绝，再次prepare剩余零且不开新Harness',async()=>{
  const f=await fixture();try{
    sixRoundRepair(f,'recall');await f.active.engine.correctMemory(f.opinions[0],'工程更正：设备B。');let runs=0,materialExecutions=0;const original=f.active.engine.agent!.run.bind(f.active.engine.agent);f.active.engine.agent!.run=async(input:any)=>{runs++;return original(input);};
    const engine:any=f.active.engine,originalTools=engine.readingTools.bind(engine);engine.readingTools=(...args:any[])=>{const tools=originalTools(...args),execute=tools.execute;tools.execute=async(...request:any[])=>{materialExecutions++;return execute(...request);};return tools;};
    await assert.rejects(f.active.engine.prepare(f.book.id),/最后一次回答机会仍请求取材/);assert.equal(f.count,9);assert.equal(runs,1);assert.equal(materialExecutions,5);assert.equal(f.s.companionCorrectionRepairs![0].status,'pending');assert.equal(f.s.readingDrafts?.length??0,0);assert.equal(f.s.companionReadingReceipts?.length??0,0);assert.equal(workspaceMaterial(f.s,f.book).understanding,undefined);assert.deepEqual(f.packets[8].tools.map((tool:any)=>tool.function.name),['finish_reading']);
    await assert.rejects(f.active.engine.prepare(f.book.id),/剩余0次/);assert.equal(f.count,9);assert.equal(runs,1);assert.equal(f.s.usage.length,9);assert.equal(f.s.companionCorrectionRepairs![0].status,'pending');
  }finally{await f.active.close();}
});
test('第六轮完整原答仅保存失败，spent6时冷恢复仍先消费原raw零派发',async()=>{
  const f=await fixture();try{
    sixRoundRepair(f,'finish');await f.active.engine.correctMemory(f.opinions[0],'工程更正：设备B。');let failed=false;f.fail=v=>{if(!failed&&v.readingDrafts?.some(d=>d.correctionRepairId)){failed=true;return true;}return false;};await assert.rejects(f.active.engine.prepare(f.book.id),/fixture save failed/);assert.equal(f.count,9);assert.equal(f.disk.companionReadingReceipts!.length,1);assert.equal(f.disk.readingDrafts?.length??0,0);await f.active.close();
    const cold=await restoreBackup(JSON.stringify(f.disk),initialState());cold.settings.services[0].enabled=true;f.active=f.attach(cold);await f.active.engine.startReading(cold.books[0].id);await f.active.engine.prepare(cold.books[0].id);assert.equal(f.count,9);assert.equal(cold.usage.length,9);assert.equal(workspaceMaterial(cold,cold.books[0]).understanding!.text,f.replies[8]);assert.equal(cold.companionCorrectionRepairs![0].status,'complete');
  }finally{await f.active.close();}
});
