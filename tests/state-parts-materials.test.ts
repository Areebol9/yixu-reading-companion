import test from 'node:test';
import assert from 'node:assert/strict';
import {importBook} from '../src/core/books.ts';
import {evidence} from '../src/core/context.ts';
import {initialState} from '../src/core/state.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import {ChatModel} from '../src/core/model.ts';
import {HarnessRuntime} from '../src/agent/runtime.ts';
import {HarnessFactReviewer} from '../src/agent/fact-reviewer.ts';
import {ReadingReferences} from '../src/core/reading-references.ts';
import {readingSubmit} from '../src/core/reading-agent.ts';
import {stateProjectionMaterial,narrativeMaterial} from '../src/core/stage-materials.ts';
import {createReadingDraft} from '../src/core/reading-drafts.ts';
import {searchMemories} from '../src/core/recall.ts';
import type {Memory,ReadingReply} from '../src/core/types.ts';

function toolReply(...entries:[string,unknown][]){return{status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:entries.map(([name,args],i)=>({id:'operation-'+i,type:'function',function:{name,arguments:JSON.stringify(args)}}))}}],usage:{prompt_tokens:1,completion_tokens:1}}};}
function packet(request:any){return request.body.messages.filter((m:any)=>m.role==='user').flatMap((m:any)=>m.content.split('\n\n')).flatMap((s:string)=>{try{return[JSON.parse(s)];}catch{return[];}}).find((p:any)=>p.currentRange);}
function sourceText(state:any){return state.currentStates[0].stateProjection.parts.map((p:any)=>({id:p.id,text:state.currentStates[0].text.slice(p.textStart,p.textEnd)}));}

test('完整状态正文只供一次，部件UTF16偏移与s编号可解码，未知编号不进入写入',()=>{
  const state=initialState(),text='每月核对一次。\n完成全部事务后才解除约束。';
  const memory:Memory={id:'state-base',bookId:'book',partnerId:state.partnerId,kind:'state',text,evidence:[],parents:[],chatIds:[],createdAt:1,forgotten:false,source:'reading',stateProjection:{topic:'约束',asOf:[],status:'active',writeVersion:2,parts:[{id:'monthly',text:'每月核对一次。',sourceEvidence:[]},{id:'release',text:'完成全部事务后才解除约束。',memoryRef:{memoryId:'stable-story',start:5,end:20}}]}};
  memory.evidence=[{bookId:'book',version:'fixture-version',start:0,end:10}];
  const data=narrativeMaterial(memory),meta=stateProjectionMaterial(text,memory.stateProjection)!;
  assert.equal('text' in meta.parts![0],false);assert.equal(text.slice(meta.parts![1].textStart,meta.parts![1].textEnd),'完成全部事务后才解除约束。');
  const refs=new ReadingReferences(),encoded=JSON.parse(refs.messages([{role:'user',content:JSON.stringify({currentStates:[data]})}])[0].content),part=encoded.currentStates[0].stateProjection.parts[0];
  assert.match(part.id,/^s\d+$/);assert.match(encoded.currentStates[0].stateProjection.parts[1].memoryRef.memoryId,/^m\d+$/);
  const reply:ReadingReply={reply:'',thoughts:[],wantsLong:false,stateUpdates:[{topic:'约束',stateChangeOf:encoded.currentStates[0].id,operations:[{op:'retire',partId:part.id,sourceIds:['p1'],reason:'原文明确结束。'}]}]};
  assert.equal(refs.decode(reply).stateUpdates![0].operations![0].partId,'monthly');
  assert.throws(()=>refs.decode({...reply,stateUpdates:[{topic:'约束',operations:[{op:'retire',partId:'s999',sourceIds:['p1'],reason:'未知。'}]}]}),/完整基态/);
  const schema=readingSubmit(()=>{},undefined,{narrativeMode:'stages',narrativeWrites:true,stateWriteVersion:2});
  const update=(schema.parameters.properties as any).stateUpdates.items;
  assert.equal('text' in update.properties,false);assert.equal('operations' in update.properties,true);
  assert.throws(()=>schema.parse({stageNarrative:{text:'处理本轮。'},stateUpdates:[{topic:'约束',text:'整段覆盖。'}]}),/v2|操作|operations|状态字段/);
});

test('合法状态的部件来源元数据超过分页预算时首条完整返回并推进，不产生空页死循环',async()=>{
  const state=initialState(),book=await importBook('完整回查预算工程','资料记录。'.repeat(200));state.books=[book];book.known=[{start:0,end:book.text.length}];
  const parts=Array.from({length:64},(_,i)=>({id:'stable-state-part-'+String(i).padStart(3,'0'),text:'约束'+i+'。',sourceEvidence:[evidence(book,{start:i,end:i+1})]}));
  const memory:Memory={id:'full-state',kind:'state',bookId:book.id,partnerId:state.partnerId,text:parts.map(p=>p.text).join('\n'),evidence:book.known.map(r=>evidence(book,r)),parents:[],chatIds:[],source:'reading',forgotten:false,createdAt:1,stateProjection:{topic:'约束',asOf:[...book.known],status:'active',writeVersion:2,parts}};
  state.memories=[memory];assert.ok(JSON.stringify(stateProjectionMaterial(memory.text,memory.stateProjection)).length>4000);
  const page=searchMemories(state,book,{kind:'state'});assert.equal(page.items.length,1);assert.equal(page.items[0].text,memory.text);assert.equal(page.total,1);assert.equal(page.nextOffset,undefined);
});

test('正式Harness按部件增量保存，未触条件原样保留，完整结束收据与重新active分开',async()=>{
  const state=initialState(),book=await importBook('条目工程','第一章 约束\n每月提供一次检修材料；完成全部项目后才能解除保管约束；次日到场。\n第二章 到场\n次日已经到场，负责人开始安排记录工作，其他保管约束持续。\n第三章 完成\n项目全部完成，保管约束正式解除。\n第四章 新任务\n另外开始新的保管事项。');
  state.books=[book];book.known=[{start:0,end:book.text.length}];book.position=book.text.length;state.settings.services[0].enabled=true;
  let calls=0;
  const engine=new ReadingEngine(state,{async save(){}},new ChatModel(async request=>{
    calls++;const p=packet(request),index=book.chapters.findIndex(c=>c.start===p.focusRange.start);
    if(index===0)return toolReply(['submit_reading',{stageNarrative:{text:'处理了约束来源，安排次日到场。'},stateUpdates:[{topic:'保管',operations:[{op:'add',text:'每月提供一次检修材料。',sourceIds:['p1']},{op:'add',text:'完成全部项目后才能解除保管约束。',sourceIds:['p1']},{op:'add',text:'次日到场。',sourceIds:['p1']}]}]}]);
    const current=p.currentStates.find((m:any)=>m.stateProjection.topic==='保管'),parts=sourceText({currentStates:[current]});
    if(index===1){assert.equal(parts.length,3);assert.ok(parts.some((x:any)=>x.text.startsWith('每月')));return toolReply(['submit_reading',{stageNarrative:{text:'次日到场已经发生，开始安排工作。'},stateUpdates:[{topic:'保管',stateChangeOf:current.id,operations:[{op:'retire',partId:parts.find((x:any)=>x.text==='次日到场。').id,sourceIds:['p1'],reason:'到场已实际发生，退出待办。'},{op:'add',text:'负责人开始安排记录工作。',sourceIds:['p1']}]}]}]);}
    if(index===2)return toolReply(['submit_reading',{stageNarrative:{text:'全部项目完成，原保管约束解除。'},stateUpdates:[{topic:'保管',stateChangeOf:current.id,status:'ended',operations:parts.map((x:any)=>({op:'retire',partId:x.id,sourceIds:['p1'],reason:'本次原文明确整个保管事项结束。'})),end:{text:'全部项目完成，原保管事项已经结束。',sourceIds:['p1']}}]}]);
    assert.equal(current.stateProjection.status,'ended');assert.deepEqual(current.stateProjection.parts,[]);assert.equal('text' in current.stateProjection.end,false);
    return toolReply(['submit_reading',{stageNarrative:{text:'开始另外一项新的保管任务。'},stateUpdates:[{topic:'保管',stateChangeOf:current.id,operations:[{op:'add',text:'另一项新的保管事项已经开始。',sourceIds:['p1']}]}]}]);
  }));const runtime=new HarnessRuntime();engine.agent=runtime;engine.narrativeMode='stages';
  try{await engine.startReading(book.id);await engine.prepare(book.id);assert.equal(calls,4);const states=state.memories.filter(m=>m.kind==='state');assert.equal(states.length,4);
    const first=states[0].stateProjection!.parts!,next=states[1].stateProjection!.parts!;
    assert.deepEqual(next.slice(0,2),first.slice(0,2));assert.equal(states[0].replacedBy,undefined);assert.equal(states[0].invalidatedBy,undefined);
    assert.equal(states[2].stateProjection!.status,'ended');assert.deepEqual(states[2].stateProjection!.parts,[]);assert.equal(states[3].stateProjection!.end,undefined);assert.equal(states[3].stateProjection!.status,'active');
  }finally{engine.stop();await runtime.dispose();}
});

test('旧stages冻结草稿缺省版本1按原全文协议消费，不因新任务版本2重新调用',async()=>{
  const state=initialState(),book=await importBook('旧稿版本工程','第一章 登记\n设备已经登记，等待签收。');state.books=[book];book.known=[{start:0,end:book.text.length}];book.position=book.text.length;state.settings.services[0].enabled=true;
  const range={start:0,end:book.text.length},draft=createReadingDraft(state,book,{source:'preparation',ranges:[range],input:''},{reply:'',thoughts:[],wantsLong:false,stageNarrative:{text:'设备登记，签收仍在延续。'},stateUpdates:[{topic:'签收',text:'设备已登记，签收未完成。'}]},[],{narrativeMode:'stages',messages:[],refs:[evidence(book,range)],originalRanges:[range],memoryIds:[],chatIds:[],habitIds:[],passages:[]},'ready');
  delete draft.material.stateWriteVersion;state.readingDrafts=[draft];let calls=0;
  const engine=new ReadingEngine(state,{async save(){}},new ChatModel(async()=>{calls++;throw Error('冻结稿不可重生成');}));const runtime=new HarnessRuntime();engine.agent=runtime;engine.narrativeMode='stages';
  try{await engine.startReading(book.id);await engine.prepare(book.id);assert.equal(calls,0);assert.equal(state.readingDrafts!.length,0);const saved=state.memories.find(m=>m.kind==='state')!;assert.equal(saved.text,'设备已登记，签收未完成。');assert.equal(saved.stateProjection!.writeVersion,undefined);}finally{engine.stop();await runtime.dispose();}
});

test('正式原文核对明确建立旧状态条目，再修复一条时其余条目逐字保留',async()=>{
  const state=initialState(),book=await importBook('状态复核工程','第一章 条件\n每月核对；项目完成后解除约束；次日到场。\n第二章 新段\n次日已经到场，其他条件继续有效。');state.books=[book];book.known=[{start:0,end:book.text.length}];book.position=book.text.length;book.prepared=[...book.known];state.settings.services[0].enabled=true;
  const memory:Memory={id:'old-full-state',kind:'state',text:'次日到场，其他事项待查。',bookId:book.id,partnerId:state.partnerId,evidence:book.known.map(r=>evidence(book,r)),sourceEvidence:[evidence(book,book.chapters[1])],readingStage:[book.chapters[1]],stateProjection:{topic:'事项',asOf:[...book.known],status:'active'},parents:[],chatIds:[],source:'reading',forgotten:false,createdAt:1};state.memories=[memory];
  let mode='establish',calls=0;
  const engine=new ReadingEngine(state,{async save(){}},new ChatModel(async request=>{
    calls++;const input=request.body.messages.filter((m:any)=>m.role==='user').flatMap((m:any)=>m.content.split('\n\n')).flatMap((s:string)=>{try{return[JSON.parse(s)];}catch{return[];}}).find((p:any)=>p.candidates);
    assert.equal(input.statePartsMode,mode);const candidate=input.candidates[0];
    if(mode==='establish'&&input.sources.every((s:any)=>!s.text.includes('每月'))){return toolReply(['read_evidence',{query:'每月'}]);}
    const supplied=request.body.messages.filter((m:any)=>m.role==='tool').flatMap((m:any)=>{try{return JSON.parse(m.content).sources??[];}catch{return[];}}),sources=[...input.sources,...supplied],id=sources.find((s:any)=>s.text.includes('每月'))?.id??sources[0].id;
    if(mode==='establish')return toolReply(['submit_review',{items:[{id:candidate.id,text:'当前条件按原文重新建立。',sourceIds:[id],reason:'按原文建立持续条件，原叙述不完整。',stateParts:[{text:'每月核对。',sourceIds:[id]},{text:'项目完成后才解除约束。',sourceIds:[id]},{text:'次日已经到场。',sourceIds:[id]}]}]}]);
    const part=candidate.stateProjection.parts.find((p:any)=>candidate.text.slice(p.textStart,p.textEnd).startsWith('次日'));
    assert.equal('text' in part,false);assert.match(part.id,/^s\d+$/);
    return toolReply(['submit_review',{items:[{id:candidate.id,text:'按原文保留条件。',sourceIds:[id],reason:'只核对到场条目。',stateOperations:[{op:'replace',partId:part.id,text:'次日到场已经发生。',sourceIds:[id],reason:'保持已发生身份。'}]}]}]);
  }));const reviewer=new HarnessFactReviewer();engine.factReviewer=reviewer;
  try{await engine.reviewFacts(book.id,memory.id);const established=state.memories.find(m=>m.correctionOf===memory.id)!;assert.equal(established.stateProjection!.writeVersion,2);const first=structuredClone(established.stateProjection!.parts!.slice(0,2));mode='repair';await engine.reviewFacts(book.id,established.id);const repaired=state.memories.find(m=>m.correctionOf===established.id)!;assert.deepEqual(repaired.stateProjection!.parts!.slice(0,2),first);assert.equal(repaired.stateProjection!.parts![2].id,established.stateProjection!.parts![2].id);assert.ok(calls>=2);}
  finally{engine.stop();await reviewer.dispose();}
});
