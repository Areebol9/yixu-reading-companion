import test from 'node:test';
import assert from 'node:assert/strict';
import {AnalysisCore} from '../src/core/analysis-core.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import {ReadingRuntime} from '../src/core/runtime.ts';
import {LocalApplication} from '../src/core/application.ts';
import {ApplicationServer} from '../src/core/application-wire.ts';
import {projectWorkDossier} from '../src/core/work-dossier.ts';
import {ChatModel} from '../src/core/model.ts';
import {HarnessRuntime} from '../src/agent/runtime.ts';
import {initialState} from '../src/core/state.ts';
import {forgetMemory} from '../src/core/context.ts';
import {currentStates,permittedStates} from '../src/core/stage-state.ts';
import type {Memory,Store} from '../src/core/types.ts';

const empty={memoryIds:[],chatIds:[]};
const response=(args:unknown,name='submit_reading')=>({status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:'engine-dossier-mock',type:'function',function:{name,arguments:JSON.stringify(args)}}]}}],usage:{prompt_tokens:0,completion_tokens:0}}});
test('ENGINE MOCK自动作品档案：正式分析与接续、完整原题、纠错和许可均从同一核心即时投影',async()=>{
  const state=initialState();state.settings.services[0].enabled=true;state.settings.tokenLimit=2_000_000;
  let disk=structuredClone(state),calls=0,saves=0,phase='seed',rule:Memory,question:Memory,opinion:Memory,arcA:Memory,arcB:Memory,condition:Memory;
  const store:Store={async load(){return structuredClone(disk);},async save(s){saves++;disk=structuredClone(s);}};
  const ruleText='ENGINE MOCK：开闸必须等巡检到場；双签及每月复验仍是保管条件。',exceptionText='ENGINE MOCK：紧急抢险可先开闸，但保管条件保持。',qText='ENGINE MOCK：登记员能否让巡检到場、取得双签，并保持每月复验？';
  const model=new ChatModel(async request=>{
    calls++;
    if(phase!=='seed'){
      const messages=request.body.messages as any[],packet=JSON.parse(messages.find(m=>m.role==='user'&&m.content.startsWith('{')).content.split('\n\n')[0]),records=[...(packet.analysisMaterials??[]),...messages.filter(m=>m.role==='tool').flatMap(m=>{try{return (JSON.parse(m.content).results??[]).flatMap((r:any)=>{try{return JSON.parse(r.text).items??[];}catch{return[];}});}catch{return[];}})],wanted=phase==='advance'?[question,opinion,condition,arcA,arcB]:[question],missing=wanted.filter(m=>!records.some(r=>r.kind===m.kind&&r.text===m.text&&(!m.arcProjection||r.arcProjection?.label===m.arcProjection.label))).map(m=>m.id);
      if(missing.length){const kind=wanted.find(m=>m.id===missing[0])!.kind;return response({kind,...(['state','arc'].includes(kind)?{view:'full'}:{})},'recall_memory');}
    }
    if(phase==='seed')return response({stageNarrative:{text:'ENGINE MOCK：分别形成开闸与保管条件。',sourceIds:['p1'],basis:empty},entityRoots:[{key:'new1',memoryId:'t1'}],thoughts:[
      {kind:'story',text:'ENGINE MOCK：登记员为登记姓名。',identityClaim:{entityId:'new1',type:'name',name:'登记员',cognition:'observed'},sourceIds:['p1'],basis:empty},
      {kind:'story',text:ruleText,narrative:{category:'rule',subjects:['开闸'],condition:'巡检到場；双签及每月复验',storyTime:'每月'},sourceIds:['p1'],basis:empty},
      {kind:'story',text:exceptionText,ruleLinks:[{type:'exception-to',memoryId:'t2',cognition:'observed'}],sourceIds:['p1'],basis:empty},
      {kind:'question',text:qText,about:[{entityId:'new1'}],sourceIds:['p1'],basis:empty},
      {kind:'opinion',text:'ENGINE MOCK：应分别保留开闸与保管条件。',sourceIds:['p1'],basis:empty},
      {kind:'story',text:'ENGINE MOCK：登记员接到开闸要求。',attribution:{holderId:'new1',mode:'received',grounding:'stated',contentRef:{memoryId:'t2',start:0,end:ruleText.length}},sourceIds:['p1'],basis:empty}
    ],stateUpdates:[{topic:'保管状态',basis:empty,operations:[{op:'add',memoryId:'t2'}]}],arcUpdates:[{label:'开闸线',basis:empty,operations:[{op:'add',role:'condition',memoryId:'t2'}]},{label:'保管线',basis:empty,operations:[{op:'add',role:'condition',memoryId:'t2'}]}]});
    if(phase==='advance')return response({stageNarrative:{text:'ENGINE MOCK：巡检到場，双签仍待取得。',sourceIds:['p1'],basis:empty},thoughts:[{kind:'story',text:'ENGINE MOCK：巡检已到場，双签仍未取得。',answersPartOf:question.id,sourceIds:['p1'],basis:empty},{kind:'opinion',text:'ENGINE MOCK：到場推进开闸，保管条件完整保持。',updates:opinion.id,updateReason:'ENGINE MOCK巡检到場。',sourceIds:['p1'],basis:empty}],stateUpdates:[{topic:'保管状态',stateChangeOf:condition.id,basis:empty,operations:[{op:'add',text:'ENGINE MOCK：双签未取得。',sourceIds:['p1']}]}],arcUpdates:[{arcChangeOf:arcA.id,basis:empty,operations:[{op:'add',role:'impact',text:'ENGINE MOCK：开闸延后使保管安排变化。',sourceIds:['p1'],impact:{targetId:arcB.id,type:'delayed-effect',cognition:'observed'}}]},{arcChangeOf:arcB.id,basis:empty,operations:[{op:'add',role:'progress',text:'ENGINE MOCK：保管安排变化但双签复验仍保持。',sourceIds:['p1']}]}]});
    if(phase==='close')return response({reply:'ENGINE MOCK：两项要求与复验均已确认。',thoughts:[{kind:'story',text:'ENGINE MOCK：原问完整答全。',updates:question.id,updateReason:'ENGINE MOCK完整原文回应全部条件。',sourceIds:['p1'],basis:empty}]});
    throw Error('unexpected dossier mock phase');
  });
  const engine=new ReadingEngine(state,store,model),harness=new HarnessRuntime();engine.agent=harness;const core=new AnalysisCore(engine);
  const runtime=new ReadingRuntime(engine,{available:false,async request(){throw Error('no device');}}),app=new LocalApplication(runtime,async<T>()=>({} as T));
  try{
    const id=await core.importText('ENGINE MOCK自动档案','第一章 条件\nENGINE MOCK：登记员、开闸、巡检、双签和每月复验。\n第二章 到場\nENGINE MOCK：巡检已到場，双签还未取得。\n第三章 答全\nENGINE MOCK：双签及复验也已确认。\n第四章 未许可\nUNREAD-DOSSIER');
    const book=engine.book(id),first={start:book.chapters[0].start,end:book.chapters[0].end},second={start:book.chapters[1].start,end:book.chapters[1].end},third={start:book.chapters[2].start,end:book.chapters[2].end};
    await core.grant(id,[first]);await core.configure(id,{arcCandidate:'v1',worldCandidate:'v1'});await core.analyze(id,[first]);
    rule=state.memories.find(m=>m.text===ruleText)!;question=state.memories.find(m=>m.kind==='question')!;opinion=state.memories.find(m=>m.kind==='opinion')!;condition=state.memories.find(m=>m.kind==='state')!;arcA=state.memories.find(m=>m.arcProjection?.label==='开闸线')!;arcB=state.memories.find(m=>m.arcProjection?.label==='保管线')!;
    assert.ok(rule&&question&&opinion&&condition&&arcA&&arcB,'正式分析形成档案输入');
    const before=JSON.stringify(state),priorCalls=calls,priorSaves=saves,index=await app.command('readWorkDossier',id),full=await core.dossier(id,{view:'full',limit:100}),sources=await core.dossier(id,{view:'sources',ids:[rule.id]});
    assert.equal(JSON.stringify(state),before);assert.equal(calls,priorCalls);assert.equal(saves,priorSaves);
    assert.equal(index.sections.length,9);assert.ok(index.sections.find(s=>s.id==='world-rules')!.firstItems.some(i=>i.id===rule.id));assert.equal(full.items.find(i=>i.id===rule.id)!.record!.narrative!.condition,'巡检到場；双签及每月复验');
    assert.equal(full.items.find(i=>i.id===rule.id)!.record!.narrative!.storyTime,'每月');assert.equal(full.items.find(i=>i.kind==='entity')!.entity!.type,'unknown');assert.equal(full.items.find(i=>i.record?.attribution)!.record!.attribution!.mode,'received');
    assert.equal(sources.items[0].text,book.text.slice(sources.items[0].range!.start,sources.items[0].range!.end));assert.equal(sources.items[0].range!.version,book.version);assert.equal(JSON.stringify(full).includes('UNREAD-DOSSIER'),false);
    full.items.find(i=>i.id===rule.id)!.text='detached';assert.equal(rule.text,ruleText);
    await core.grant(id,[second]);phase='advance';await core.analyze(id,[second]);
    const progressed=await core.dossier(id,{view:'full',limit:100});assert.ok(progressed.items.find(i=>i.kind==='state')!.text!.includes(ruleText));assert.ok(progressed.items.find(i=>i.record?.arcChangeOf===arcA.id)!.record!.arcProjection!.parts.some(p=>p.impact?.targetVersionId===arcB.id));assert.equal(progressed.items.find(i=>i.id===question.id)!.text,qText);
    const lateSuspended=structuredClone(state),lateState=lateSuspended.memories.find(m=>m.stateChangeOf===condition.id)!;lateState.invalidatedBy='hidden-correction-cause';const stateDossier=projectWorkDossier(lateSuspended,book,{view:'full',section:'states',history:true});assert.ok(stateDossier.items.some(i=>i.id===lateState.id&&i.availability==='needs-review'&&!i.text));assert.equal(stateDossier.items.find(i=>i.id===condition.id)!.version,'history');assert.equal(stateDossier.sections.find(s=>s.id==='states')!.currentCount,0);assert.equal(JSON.stringify(stateDossier).includes('hidden-correction-cause'),false);
    assert.equal(currentStates(lateSuspended,book).some(m=>m.id===condition.id),false);
    assert.ok(permittedStates(lateSuspended,book).some(m=>m.id===condition.id));
    assert.ok(currentStates(lateSuspended,{...book,known:[first]}).some(m=>m.id===condition.id),'未获准后继不能改变早期当前状态');
    assert.ok(progressed.items.some(i=>i.relations?.some(e=>e.type==='partial-answer')));
    await assert.rejects(core.dossier(id,{offset:1,snapshot:index.snapshot}),/已变化/);
    await core.grant(id,[third]);phase='close';await core.query(id,'ENGINE MOCK回看完整原问');
    const questions=await core.dossier(id,{section:'questions'});assert.ok(questions.items.some(i=>i.id===question.id&&i.version==='history'));assert.ok(questions.items.some(i=>i.relations?.some(e=>e.type==='complete-answer')));
    const historical=await core.dossier(id,{view:'full',ids:[question.id]});assert.equal(historical.items[0].text,qText);assert.equal(historical.items[0].version,'history');
    const conversations=await core.dossier(id,{view:'full',section:'conversations'});assert.ok(conversations.items.some(i=>i.conversation?.role==='user'&&i.conversation.answerIds.length));
    const expected=await core.dossier(id,{view:'full',history:true,limit:100}),round=await AnalysisCore.fromBackup(await core.backup(),store,model);try{assert.deepEqual(await round.dossier(id,{view:'full',history:true,limit:100}),expected);}finally{round.engine.stop();}
    const direct=await core.dossier(id,{view:'full',profile:'full-original',limit:100});assert.equal(direct.items.some(i=>['entity','stage','state','arc'].includes(i.kind)),false);assert.equal(direct.items.some(i=>i.relations?.length),false);
    const wire:unknown[]=[],server=new ApplicationServer(app,(_kind,value)=>wire.push(value));await server.receive({id:'dossier-wire-1',epoch:server.epoch,name:'readWorkDossier',args:[id,{view:'full',ids:[question.id]}]});assert.ok(wire.some((r:any)=>r.value?.items?.[0]?.text===qText));await server.receive({id:'dossier-wire-2',epoch:server.epoch,name:'readWorkDossier',args:[id,{limit:Infinity}]});assert.ok(wire.some((r:any)=>r.error?.includes('参数无效')));
    const originalCallCount=calls;await core.correctMemory(rule.id,'ENGINE MOCK：开闸来源独立更正。');assert.equal(calls,originalCallCount);
    const corrected=await core.dossier(id,{view:'full',history:true,limit:100}),replacement=corrected.items.find(i=>i.correctedPrevious)!;assert.ok(replacement);assert.ok(!JSON.stringify(corrected).includes(ruleText));assert.ok(!JSON.stringify(replacement).includes(rule.id));
    assert.ok(corrected.sections.find(s=>s.id==='arcs')!.gaps.length,'受更正影响的弧线留下待核缺口');const noSource=await core.dossier(id,{view:'sources',ids:[replacement.id]});assert.equal(noSource.items.length,0);assert.equal(noSource.missing[0].availability,'no-exact-source');
    assert.ok(corrected.sections.find(s=>s.id==='states')!.gaps.length,'受影响状态主题保留待核位置');assert.ok(corrected.items.some(i=>i.kind==='opinion'&&i.availability==='available'),'独立观点保留');
    // Existing stored shapes, including long legacy bodies and source selections,
    // must be readable without requiring another model submission.
    const legacy=structuredClone(state),longText='L'.repeat(3999)+'😀'+'R'.repeat(4500),legacyBook={...structuredClone(book),text:longText,textLength:longText.length,known:[{start:0,end:longText.length}]},legacyMemory={...structuredClone(rule),id:'legacy-visible-record',text:'ENGINE MOCK旧存档全文。'.repeat(400),forgotten:false,replacedBy:undefined,invalidatedBy:undefined,sourceEvidence:[{bookId:id,version:book.version,start:0,end:longText.length}],evidence:[{bookId:id,version:book.version,start:0,end:longText.length}],parents:['hidden-reference-sentinel'],chatIds:[],basis:{memoryIds:['hidden-reference-sentinel'],chatIds:[]},about:undefined};
    legacy.memories=[legacyMemory];legacy.entityRoots=[];legacy.chats=[{id:'stored-pending-question',bookId:id,partnerId:legacy.partnerId,sessionId:'fixture-discussion',role:'user',text:'ENGINE MOCK已保存待答联合问题。',delivery:'pending',evidence:legacyMemory.evidence,createdAt:0,excluded:false}];
    const legacyFull=projectWorkDossier(legacy,legacyBook,{view:'full'});assert.equal(legacyFull.items.find(i=>i.id===legacyMemory.id)!.text,legacyMemory.text);assert.equal(JSON.stringify(legacyFull).includes('hidden-reference-sentinel'),false);assert.equal(legacyFull.items.find(i=>i.id==='stored-pending-question')!.conversation!.answerIds.length,0);
    let sourceOffset=0,recovered='';do{const page=projectWorkDossier(legacy,legacyBook,{view:'sources',ids:[legacyMemory.id],offset:sourceOffset,limit:1});recovered+=page.items[0].text;assert.equal(page.items[0].range!.start,sourceOffset===0?0:recovered.length-page.items[0].text!.length);if(!page.page.hasMore)break;sourceOffset=page.page.nextOffset!;}while(true);assert.equal(recovered,longText);
    const background={...legacyMemory,id:'background-record',source:'background' as const};legacy.memories.push(background);assert.equal(projectWorkDossier(legacy,legacyBook).items.some(i=>i.id===background.id),false);assert.ok(projectWorkDossier(legacy,legacyBook,{source:'background'}).items.some(i=>i.id===background.id));
    await engine.editState(s=>forgetMemory(s,question.id),undefined,true);for(const view of ['index','full','sources'] as const){const result=await core.dossier(id,{view,ids:[question.id]});assert.equal(result.items.length,0);assert.equal(result.missing[0].availability,'unavailable');}
    await core.configure(id,{worldCandidate:null,arcCandidate:null});const disabled=await core.dossier(id,{view:'full',limit:100});assert.equal(disabled.sections.find(s=>s.id==='entities')!.availability,'disabled');assert.equal(disabled.items.some(i=>i.record?.identityClaim||i.record?.attribution||i.record?.ruleLinks?.length),false);
    await engine.editState(s=>{const b=s.books.find(b=>b.id===id)!;b.known=[];b.prepared=[];b.position=0;});for(const view of ['index','full','sources'] as const){assert.equal((await core.dossier(id,{view})).items.length,0);}
  }finally{engine.stop();await harness.dispose();}
});
