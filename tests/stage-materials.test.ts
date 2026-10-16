import test from 'node:test';
import assert from 'node:assert/strict';
import { importBook } from '../src/core/books.ts';
import { evidence } from '../src/core/context.ts';
import { initialState } from '../src/core/state.ts';
import { ReadingEngine } from '../src/core/engine.ts';
import { ChatModel } from '../src/core/model.ts';
import { HarnessRuntime } from '../src/agent/runtime.ts';
import { HarnessFactReviewer } from '../src/agent/fact-reviewer.ts';
import { searchMemories } from '../src/core/recall.ts';
import { ReadingReferences } from '../src/core/reading-references.ts';
import { readingAgentTools, readingSubmit } from '../src/core/reading-agent.ts';
import { selectStageMaterials, stageCoveredByOriginal } from '../src/core/stage-materials.ts';
import type { Memory, NarrativeMode, ReadingReply, State } from '../src/core/types.ts';

function toolReply(...entries:[string,unknown][]) {
  return {status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:entries.map(([name,args],i)=>({id:'tool-'+i,type:'function',function:{name,arguments:JSON.stringify(args)}}))}}],usage:{prompt_tokens:1,completion_tokens:1}}};
}
function inputPacket(request:any) {
  return request.body.messages.filter((m:any)=>m.role==='user').flatMap((m:any)=>m.content.split('\n\n')).flatMap((s:string)=>{try{return[JSON.parse(s)];}catch{return[];}}).find((p:any)=>p.currentRange);
}
function pages(request:any) {
  return request.body.messages.filter((m:any)=>m.role==='tool').flatMap((m:any)=>{try{return JSON.parse(m.content).results??[];}catch{return[];}}).flatMap((r:any)=>{try{return[JSON.parse(r.text)];}catch{return[];}});
}

test('阶段只在完整正文覆盖时替换，原文顺序、许可计数和当前状态主题保持',async()=>{
  const state=initialState(),book=await importBook('阶段选择工程','第一章\n设备登记。\n第二章\n设备移交。\n第三章\nFUTURE-NARRATIVE');
  state.books=[book];book.known=[{start:0,end:book.chapters[1].end}];
  const make=(id:string,kind:Memory['kind'],index:number):Memory=>({id,kind,text:id,bookId:book.id,partnerId:state.partnerId,evidence:[evidence(book,book.chapters[index])],readingStage:[book.chapters[index]],parents:[],chatIds:[],forgotten:false,source:'reading',createdAt:100-index});
  const first={...make('STAGE-FIRST','stage',0),stageNarrative:{ranges:[book.chapters[0]],continues:true}},second={...make('STAGE-SECOND','stage',1),stageNarrative:{ranges:[book.chapters[1]],previousStageId:first.id,continues:false}};
  const old={...make('STATE-OLD','state',0),stateProjection:{topic:'设备位置',asOf:[book.chapters[0]],status:'active' as const}};
  const next={...make('STATE-NEXT','state',1),stateProjection:{topic:'设备位置',asOf:[book.chapters[1]],status:'ended' as const},stateChangeOf:old.id};
  state.memories=[second,first,old,next,{...make('FUTURE-NARRATIVE','stage',2),stageNarrative:{ranges:[book.chapters[2]],continues:false}}, {...first,id:'OTHER-PARTNER',partnerId:'other'}, {...first,id:'BACKGROUND',source:'background'}];
  assert.equal(stageCoveredByOriginal(first,[{start:book.chapters[0].start,end:book.chapters[0].start+5}]),false);
  assert.equal(stageCoveredByOriginal(first,[{start:book.chapters[0].start,end:7},{start:7,end:book.chapters[0].end}]),true);
  const picked=selectStageMaterials(state,book,[],{charBudget:7000});
  assert.deepEqual(picked.stages.map(m=>m.id),[first.id,second.id]);assert.deepEqual(picked.states.map(m=>m.id),[next.id]);
  assert.equal(selectStageMaterials(state,book,[book.chapters[0]],{charBudget:7000}).stages.some(m=>m.id===first.id),false);
  const early={...book,known:[book.chapters[0]]};
  assert.equal(searchMemories(state,early,{kind:'stage'}).total,1);assert.deepEqual(searchMemories(state,early,{kind:'state'}).items.map(m=>m.id),[old.id]);
  assert.equal(JSON.stringify(searchMemories(state,early,{kind:'state'})).includes(next.id),false);
  assert.equal(searchMemories(state,book,{}).total,0);assert.equal(searchMemories(state,book,{kind:'state',stateView:'history'}).total,2);
});

test('新叙事与状态使用短编号，历史前身可回查，默认工具与提交不开放候选字段',()=>{
  const refs=new ReadingReferences(),encoded=JSON.parse(refs.messages([{role:'user',content:JSON.stringify({stageNarratives:[{id:'stage-2',stageNarrative:{ranges:[{start:10,end:20}],continues:false,previousStageId:'stage-1'}}],currentStates:[{id:'state-2',stateChangeOf:'state-1',stateProjection:{topic:'设备',asOf:[{start:0,end:20}],status:'active'}}]})}])[0].content);
  const reply:ReadingReply={reply:'',thoughts:[],wantsLong:false,stateUpdates:[{topic:'设备',text:'设备已签收。',stateChangeOf:encoded.currentStates[0].id}]};
  assert.equal(refs.decode(reply).stateUpdates![0].stateChangeOf,'state-2');
  assert.throws(()=>refs.decode({...reply,stateUpdates:[{topic:'设备',text:'结束。',stateChangeOf:'m999'}]}),/完整当前状态/);
  assert.equal(refs.decode({...reply,recall:{ids:[encoded.stageNarratives[0].stageNarrative.previousStageId]}}).recall!.ids![0],'stage-1');
  const legacy=readingAgentTools(async()=>[],{search:false,page:false}).find(t=>t.name==='recall_memory')!;
  assert.equal(JSON.stringify(legacy.parameters).includes('stateView'),false);
  assert.equal((legacy.parameters.properties as any).kind.enum.includes('stage'),false);
  assert.equal('stageNarrative' in (readingSubmit(()=>{}).parameters.properties as object),false);
  assert.throws(()=>readingSubmit(()=>{},undefined,{narrativeMode:'stages',conversation:true}).parse({...reply,stageNarrative:{text:'讨论冒充处理。'}}),/顶层字段/);
});

test('正式Harness连续准备形成叙事与多主题状态，回查原文后普通交流只接续问题与观点，关闭候选保持legacy',async()=>{
  const state=initialState(),book=await importBook('完整阶段工程','第一章 登记\nAX用途和损坏原因待查，设备放在登记处。\n第二章 移交\nAX用于温度测量，损坏原因未明确，设备移交给负责人。\n第三章 未读\nFUTURE-READING-SECRET');
  state.books=[book];book.known=[{start:0,end:book.chapters[1].end}];book.position=book.chapters[1].end;state.settings.services[0].enabled=true;
  let turn=0,questionId='',stored:State=structuredClone(state);const requests:any[]=[];
  const engine=new ReadingEngine(state,{async save(s){stored=structuredClone(s);}},new ChatModel(async request=>{
    turn++;requests.push(request);assert.equal(JSON.stringify(request.body).includes('FUTURE-READING-SECRET'),false);
    const p=inputPacket(request);
    if(turn===1)return toolReply(['submit_reading',{stageNarrative:{text:'STAGE-FIRST：设备登记，用途与损坏原因仍需核实。',continues:true,sourceIds:['p1']},stateUpdates:[{topic:'设备位置',operations:[{op:'add',text:'AX目前放在登记处。',sourceIds:['p1']}]},{topic:'损坏原因',operations:[{op:'add',text:'AX损坏原因仍未明确。',sourceIds:['p1']}]}],thoughts:[{kind:'question',text:'AX用途和损坏原因分别是什么？'}]}]);
    if(turn===2){assert.equal(p.currentStates.length,2);const prior=p.currentStates.find((m:any)=>m.stateProjection.topic==='设备位置');return toolReply(['submit_reading',{stageNarrative:{text:'STAGE-SECOND：设备用途已经明确，随后交给负责人；损坏原因仍待查。'},stateUpdates:[{topic:'设备位置',stateChangeOf:prior.id,operations:[{op:'replace',partId:prior.stateProjection.parts[0].id,text:'AX已移交给负责人。',sourceIds:['p1'],reason:'实际移交更新位置。'}]}]}]);}
    if(turn===3){assert.ok(p.stageNarratives.some((m:any)=>m.text.includes('STAGE-FIRST')));assert.ok(p.currentStates.some((m:any)=>m.text.includes('负责人')));return toolReply(['recall_memory',{kind:'stage'}],['recall_memory',{kind:'question'}]);}
    if(turn===4){const all=pages(request),stages=all.flatMap(p=>p.items??[]).filter((m:any)=>m.kind==='stage');assert.equal(stages[0].text.includes('STAGE-FIRST'),true);assert.equal(stages[1].text.includes('STAGE-SECOND'),true);questionId=all.flatMap(p=>p.items??[]).find((m:any)=>m.kind==='question').id;return toolReply(['read_original',stages[0].stageNarrative.ranges[0]]);}
    if(turn===5){assert.ok(request.body.messages.some((m:any)=>m.role==='tool'&&m.content.includes('AX用途和损坏原因待查')));return toolReply(['submit_reading',{reply:'用途已经明确，原因仍待核实。',thoughts:[{kind:'story',text:'AX用于温度测量。',answersPartOf:questionId},{kind:'opinion',text:'还需留意损坏原因，避免把用途明确当作所有条件已解决。'}]}]);}
    assert.equal(p.stageNarratives,undefined);assert.equal(p.currentStates,undefined);assert.equal(p.memories.some((m:any)=>['stage','state'].includes(m.kind)),false);
    assert.equal(JSON.stringify(request.body.tools).includes('stateView'),false);
    return{status:200,body:{choices:[{finish_reason:'stop',message:{content:'继续留意损坏原因。'}}],usage:{prompt_tokens:1,completion_tokens:1}}};
  }),{original:1,memories:'stage'});
  const harness=new HarnessRuntime();engine.agent=harness;engine.narrativeMode='stages';
  try{
    await engine.startReading(book.id);await engine.prepare(book.id);assert.equal(turn,2);
    const stages=state.memories.filter(m=>m.kind==='stage'),states=state.memories.filter(m=>m.kind==='state');
    assert.equal(stages.length,2);assert.equal(states.length,3);assert.equal(state.memories.some(m=>m.kind==='context'),false);
    assert.equal(stages[1].stageNarrative!.previousStageId,stages[0].id);assert.equal(states[0].replacedBy,undefined);assert.equal(states[0].invalidatedBy,undefined);
    const unchanged=states.find(m=>m.stateProjection!.topic==='损坏原因')!;assert.deepEqual(unchanged.stateProjection!.asOf,stages[0].evidence.map(({start,end})=>({start,end})));
    assert.deepEqual(stored.memories,state.memories);assert.equal(state.chats.length,0);
    await engine.ask(book.id,'回查登记过程并接续原问。');assert.equal(turn,5);assert.equal(state.memories.filter(m=>m.kind==='stage').length,2);
    const question=state.memories.find(m=>m.kind==='question')!;assert.equal(question.text,'AX用途和损坏原因分别是什么？');assert.equal(question.replacedBy,undefined);assert.ok(state.memories.some(m=>m.answersPartOf===question.id));
    await engine.setReadingMode(book.id,'legacy');await engine.ask(book.id,'继续核对。');assert.equal(turn,6);assert.equal(state.memories.filter(m=>m.kind==='stage').length,2);
  }finally{engine.stop();await harness.dispose();}
});

test('已完成草稿按原模式重建保存，stage/state选中的原文编号在开关变化后保持',async()=>{
  for(const initial of ['legacy','stages'] as NarrativeMode[]){
    const state=initialState(),book=await importBook('模式接续工程','第一章 登记\nAX设备已经登记，等候签收。');state.books=[book];book.known=[{start:0,end:book.text.length}];book.position=book.text.length;state.settings.services[0].enabled=true;
    let calls=0,fail=true,saved=structuredClone(state);
    const store={async save(s:State){if(fail&&s.memories.length)throw Error('FINAL-SAVE-FAILED');saved=structuredClone(s);}};
    const model=new ChatModel(async()=>{calls++;return toolReply(['submit_reading',initial==='stages'?{stageNarrative:{text:'设备已登记，签收仍在延续。',continues:true,sourceIds:['p1']},stateUpdates:[{topic:'签收',operations:[{op:'add',text:'签收尚未完成。',sourceIds:['p1']}]}]}:{reply:'',readingBrief:'设备已登记，等候签收。'}]);});
    const first=new ReadingEngine(state,store,model),runtime=new HarnessRuntime();first.agent=runtime;first.narrativeMode=initial;
    await first.startReading(book.id);await assert.rejects(first.prepare(book.id),/FINAL-SAVE-FAILED/);assert.equal(state.readingDrafts![0].material.narrativeMode,initial);
    if(initial==='stages')assert.equal(state.readingDrafts![0].material.passages[0][0],'p1');
    first.stop();await first.persist();await runtime.dispose();fail=false;
    const copy=structuredClone(saved),next=new ReadingEngine(copy,store,model),nextRuntime=new HarnessRuntime();next.agent=nextRuntime;next.narrativeMode=initial==='stages'?'legacy':'stages';
    try{await next.startReading(book.id);await next.prepare(book.id);assert.equal(calls,1);assert.equal(copy.readingDrafts?.length,0);assert.equal(copy.memories.some(m=>m.kind==='stage'),initial==='stages');if(initial==='stages')assert.ok(copy.memories.filter(m=>m.kind==='stage'||m.kind==='state').every(m=>m.sourceEvidence?.length));}
    finally{next.stop();await nextRuntime.dispose();}
  }
});

test('正式复核Harness仅查原认识的离散范围，冻结状态主题并接回标记',async()=>{
  const state=initialState(),book=await importBook('历史核对工程','第一章 登记\nAX原位置为登记处。\n第二章 间隔\nGAP-NEW-KNOWLEDGE。\n第三章 核对\nAX仍留在登记处。\n第四章 后来\nLATER-NEW-KNOWLEDGE。');
  state.books=[book];book.known=[{start:0,end:book.text.length}];book.position=book.text.length;book.prepared=[...book.known];state.settings.services[0].enabled=true;
  const ranges=[book.chapters[0],book.chapters[2]],memory:Memory={id:'historical-state',kind:'state',text:'AX已经移交。',bookId:book.id,partnerId:state.partnerId,evidence:ranges.map(r=>evidence(book,r)),sourceEvidence:[evidence(book,book.chapters[0])],readingStage:[book.chapters[2]],stateProjection:{topic:'设备位置',asOf:ranges,status:'active'},parents:[],chatIds:[],source:'reading',forgotten:false,createdAt:1};state.memories=[memory];
  let calls=0;
  const engine=new ReadingEngine(state,{async save(){}},new ChatModel(async request=>{
    calls++;assert.equal(JSON.stringify(request.body).includes('GAP-NEW-KNOWLEDGE。'),false);assert.equal(JSON.stringify(request.body).includes('LATER-NEW-KNOWLEDGE。'),false);
    if(calls===1){assert.ok(JSON.stringify(request.body).includes('设备位置'));return toolReply(['read_evidence',{query:'GAP-NEW-KNOWLEDGE'}],['read_evidence',{query:'AX'}]);}
    const src=request.body.messages.filter((m:any)=>m.role==='tool').flatMap((m:any)=>{try{return JSON.parse(m.content).sources??[];}catch{return[];}});assert.ok(src.some((s:any)=>s.text.includes('AX')));assert.equal(src.some((s:any)=>s.text.includes('GAP-NEW-KNOWLEDGE')),false);
    return toolReply(['submit_review',{items:[{id:'m0',text:'AX仍在登记处。',sourceIds:[src[0].id],reason:'核对当时位置。',stateStatus:'active',stateParts:[{text:'AX仍在登记处。',sourceIds:[src[0].id]}]}]}]);
  }));const reviewer=new HarnessFactReviewer();engine.factReviewer=reviewer;
  try{await engine.reviewFacts(book.id,memory.id);assert.equal(calls,2);const restored=state.memories.find(m=>m.correctionOf===memory.id)!;assert.equal(restored.text,'AX仍在登记处。');assert.equal(restored.stateProjection!.topic,'设备位置');assert.deepEqual(restored.stateProjection!.asOf.map(({start,end})=>({start,end})),ranges.map(({start,end})=>({start,end})));assert.equal(memory.text,'AX已经移交。');}
  finally{engine.stop();await reviewer.dispose();}
});
