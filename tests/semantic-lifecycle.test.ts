import test from 'node:test';
import assert from 'node:assert/strict';
import {AnalysisCore} from '../src/core/analysis-core.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import {ChatModel} from '../src/core/model.ts';
import {HarnessRuntime} from '../src/agent/runtime.ts';
import {initialState} from '../src/core/state.ts';
import {forgetMemory} from '../src/core/context.ts';
import {projectWorkDossier} from '../src/core/work-dossier.ts';
import {searchMemories} from '../src/core/recall.ts';
import type {Memory,Store} from '../src/core/types.ts';

const empty={memoryIds:[],chatIds:[]};
const response=(args:unknown,name='submit_reading')=>({status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:crypto.randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]}}],usage:{prompt_tokens:0,completion_tokens:0}}});
const packets=(body:any)=>body.messages.flatMap((m:any)=>{if(m.role==='user')return m.content.split('\n\n').flatMap((s:string)=>{try{return[JSON.parse(s)];}catch{return[];}});if(m.role==='tool'){try{return JSON.parse(m.content).results.flatMap((r:any)=>{try{return[JSON.parse(r.text)];}catch{return[];}});}catch{return[];}}return[];});

test('ENGINE MOCK连续分析按有源四轴接续解释，许可、更正和遗忘退出依赖，保存失败备份接回不重发',async()=>{
  const state=initialState();state.settings.services[0].enabled=true;state.settings.tokenLimit=2_000_000;
  let disk=structuredClone(state),calls=0,phase='seed',failCommit=false,setup:Memory,candidate:Memory,unknown:Memory,confirmed:Memory,retro:Memory,holderId:string,queryRelations=false;
  const store:Store={async load(){return structuredClone(disk);},async save(s){if(failCommit&&s.memories.some(m=>m.clue?.status==='withdrawn'))throw Error('ENGINE MOCK语义提交保存失败');disk=structuredClone(s);}};
  const model=new ChatModel(async request=>{
    calls++;const p=packets(request.body),records=p.flatMap((x:any)=>[...(x.analysisMaterials??[]),...(x.items??[])]);
    if(phase==='query'){
      if(!records.some((r:any)=>r.text===confirmed.text))return response({query:confirmed.text,kind:'opinion'},'recall_memory');
      if(!queryRelations){queryRelations=true;return response({ids:[confirmed.id],relations:true,view:'full'},'recall_memory');}
      const relation=p.find((x:any)=>x.relations);assert.ok(relation?.relations.items.some((e:any)=>e.type==='clue-payoff'));assert.ok(relation?.items.some((m:any)=>m.temporal?.occurrence));
      return response({reply:'ENGINE MOCK：原文先发生、后揭示，主体再获知；解释仍是伙伴的有据判断。',thoughts:[]});
    }
    if(phase!=='seed'){
      const wanted=phase==='advance'?[setup,candidate,unknown]:[confirmed,setup],missing=wanted.filter(m=>!records.some((r:any)=>r.text===m.text));
      if(missing.length)return response({query:missing[0].text,kind:missing[0].kind},'recall_memory');
    }
    if(phase==='seed')return response({stageNarrative:{text:'ENGINE MOCK第一段接触标志，甲对乙内容明确未知。',sourceIds:['p1'],basis:empty},entityRoots:[{key:'new1',memoryId:'t1'},{key:'new2',memoryId:'t2'}],thoughts:[
      {kind:'story',text:'ENGINE MOCK甲为明确登记名。',identityClaim:{entityId:'new1',type:'name',name:'甲',cognition:'observed'},sourceIds:['p1'],basis:empty},
      {kind:'story',text:'ENGINE MOCK乙为明确登记名。',identityClaim:{entityId:'new2',type:'name',name:'乙',cognition:'observed'},sourceIds:['p1'],basis:empty},
      {kind:'story',text:'ENGINE MOCK第一段甲接触封闭标志。',temporal:{occurrence:{text:'封闭完成后',cognition:'observed',sourceIds:['p1']},revelation:{sourceIds:['p1']}},sourceIds:['p1'],basis:empty},
      {kind:'story',text:'ENGINE MOCK甲尚不知道乙此前留下内容。',attribution:{holderId:'new1',mode:'explicitly-unaware',grounding:'stated'},sourceIds:['p1'],basis:empty},
      {kind:'opinion',text:'ENGINE MOCK标志可能与乙此前行动有关。',clue:{status:'candidate',cognition:'inferred',setupRef:{memoryId:'t3',start:0,end:'ENGINE MOCK第一段甲接触封闭标志。'.length},sourceIds:['p1']},sourceIds:['p1'],basis:empty}
    ]});
    if(phase==='advance')return response({stageNarrative:{text:'ENGINE MOCK后段倒叙揭示乙此前行动，甲此时才接触内容。',sourceIds:['p1'],basis:empty},thoughts:[
      {kind:'story',text:'ENGINE MOCK倒叙明确乙在封闭之前留下内容。',temporal:{occurrence:{text:'封闭之前',cognition:'observed',relations:[{relation:'before',targetId:setup.id}],sourceIds:['p1']},revelation:{sourceIds:['p1']}},sourceIds:['p1'],basis:empty},
      {kind:'story',text:'ENGINE MOCK甲现在收到乙留下的内容。',attribution:{holderId,mode:'received',grounding:'stated',contentRef:{memoryId:'t1',start:0,end:'ENGINE MOCK倒叙明确乙在封闭之前留下内容。'.length}},temporal:{acquisition:{text:'本段收到时',cognition:'observed',relations:[{relation:'after',targetId:'t1'}],sourceIds:['p1']},revelation:{sourceIds:['p1']}},sourceIds:['p1'],basis:empty},
      {kind:'opinion',text:'ENGINE MOCK后段原文支持标志与乙行动关联的解释。',updates:candidate.id,updateReason:'ENGINE MOCK倒叙补出回扣依据。',clue:{status:'confirmed',cognition:'inferred',setupRef:{memoryId:setup.id,start:0,end:setup.text.length},payoffRefs:[{memoryId:'t1',start:0,end:'ENGINE MOCK倒叙明确乙在封闭之前留下内容。'.length}],sourceIds:['p1']},sourceIds:['p1'],basis:empty}
    ]});
    return response({stageNarrative:{text:'ENGINE MOCK独立新依据撤回伙伴的先前解释。',sourceIds:['p1'],basis:empty},thoughts:[{kind:'opinion',text:'ENGINE MOCK独立依据使伙伴撤回标志关联解释。',updates:confirmed.id,updateReason:'ENGINE MOCK新依据只撤回解释。',clue:{status:'withdrawn',cognition:'inferred',setupRef:{memoryId:setup.id,start:0,end:setup.text.length},sourceIds:['p1']},sourceIds:['p1'],basis:empty}]});
  });
  const engine=new ReadingEngine(state,store,model),harness=new HarnessRuntime();engine.agent=harness;const core=new AnalysisCore(engine);let resumed:AnalysisCore|undefined;
  try{
    const id=await core.importText('ENGINE MOCK有源四轴','第一章 接触\nENGINE MOCK甲和乙登记。封闭完成后甲接触标志，甲不知道乙此前行动。\n第二章 倒叙\nENGINE MOCK乙在封闭之前留下内容；此处才揭示，甲现在收到。\n第三章 撤回\nENGINE MOCK独立依据使伙伴撤回此前标志关联解释。\n第四章 未读\nUNREAD-SEMANTIC');
    const book=engine.book(id),ranges=book.chapters.slice(0,3).map(({start,end})=>({start,end}));await core.configure(id,{worldCandidate:'v1'});await core.grant(id,[ranges[0]]);await core.analyze(id,[ranges[0]]);
    setup=state.memories.find(m=>m.temporal?.occurrence)!;candidate=state.memories.find(m=>m.clue?.status==='candidate')!;unknown=state.memories.find(m=>m.attribution?.mode==='explicitly-unaware')!;holderId=state.entityRoots![0].id;
    assert.ok(setup&&candidate&&unknown);assert.equal(unknown.temporal?.acquisition,undefined);
    await core.grant(id,[ranges[1]]);phase='advance';await core.analyze(id,[ranges[1]]);confirmed=state.memories.find(m=>m.clue?.status==='confirmed')!;retro=state.memories.find(m=>m.temporal?.occurrence?.relations?.length)!;
    const dossier=await core.dossier(id,{view:'full',history:true,limit:100}),current=dossier.items.find(m=>m.id===confirmed.id)!,old=dossier.items.find(m=>m.id===candidate.id)!;
    assert.equal(current.version,'current');assert.equal(old.version,'history');assert.equal(old.record?.clue?.status,'candidate');assert.equal(current.record?.clue?.cognition,'inferred');assert.equal((current.record as any).partnerFormation.recordedAt,confirmed.createdAt);assert.deepEqual((current.record as any).partnerFormation.readingStage,[ranges[1]]);
    assert.equal(dossier.items.find(m=>m.id===retro.id)!.record!.temporal!.occurrence!.text,'封闭之前');assert.ok(dossier.items.some(m=>m.record?.temporal?.acquisition?.text==='本段收到时'));assert.equal(JSON.stringify(dossier).includes('UNREAD-SEMANTIC'),false);
    const graph=await core.relations(id,{ids:[confirmed.id,retro.id]});assert.ok(graph.items.some(e=>e.type==='temporal'&&e.detail?.axis==='occurrence'&&e.detail.relation==='before'));assert.ok(graph.items.some(e=>e.type==='clue-setup'&&e.evidence.every(r=>r.start>=ranges[1].start)));assert.ok(graph.items.some(e=>e.type==='clue-payoff'));
    const sources=await core.dossier(id,{view:'sources',ids:[confirmed.id]});assert.ok(sources.items.some(i=>i.range!.start>=ranges[1].start));
    const stale=structuredClone(state),hidden='hidden-semantic-target';stale.entityRoots=[];stale.memories=[{...structuredClone(retro),parents:[],basis:{memoryIds:[hidden],chatIds:['hidden-semantic-chat']},temporal:{...retro.temporal,occurrence:{...retro.temporal!.occurrence!,relations:[{relation:'before',targetId:hidden}]}}},{...structuredClone(confirmed),parents:[],correctionOf:undefined,basis:empty,clue:{...confirmed.clue!,setupRef:{memoryId:hidden,start:0,end:1}}}];
    const staleView=projectWorkDossier(stale,stale.books[0],{view:'full',limit:100});assert.equal(JSON.stringify(staleView).includes(hidden),false);assert.equal(JSON.stringify(staleView).includes('hidden-semantic-chat'),false);assert.ok(staleView.items.some(i=>i.text===retro.text&&i.semanticAvailability==='needs-review'));assert.ok(staleView.items.some(i=>i.text===confirmed.text&&i.semanticAvailability==='needs-review'&&!i.record?.clue));
    phase='query';await core.query(id,'ENGINE MOCK四轴及解释回扣',{memoryAllowed:false});assert.ok(state.chats.some(c=>c.role==='assistant'&&c.text.includes('后揭示')));
    const early=structuredClone(state);early.books[0].known=[ranges[0]];const earlyDossier=projectWorkDossier(early,early.books[0],{view:'full',history:true,limit:100});assert.equal(earlyDossier.items.some(m=>m.id===confirmed.id||m.id===retro.id),false);assert.ok(earlyDossier.items.some(m=>m.id===candidate.id&&m.version==='current'));assert.equal(searchMemories(early,early.books[0],{query:'倒叙'},[],'preparation','structured',{analysis:true,worldCandidate:'v1'}).total,0);
    const disabled=projectWorkDossier(state,book,{view:'full',profile:'full-original',history:true,limit:100});assert.equal(disabled.items.some(i=>i.record?.temporal||i.record?.clue),false);assert.ok(disabled.items.some(i=>i.text===confirmed.text));
    await core.grant(id,[ranges[2]]);phase='withdraw';failCommit=true;await assert.rejects(core.analyze(id,[ranges[2]]),/提交保存失败/);assert.equal(state.readingDrafts?.length,1);const priorCalls=calls,ledger=JSON.stringify(state.usage),backup=await core.backup();failCommit=false;
    resumed=await AnalysisCore.fromBackup(backup,store,model,{agent:harness});await resumed.analyze(id,[ranges[2]]);assert.equal(calls,priorCalls);assert.equal(JSON.stringify(resumed.engine.state.usage),ledger);assert.equal(resumed.engine.state.readingDrafts?.length,0);assert.ok(resumed.engine.state.memories.some(m=>m.clue?.status==='withdrawn'));
    const round=await resumed.dossier(id,{view:'full',history:true,limit:100});assert.equal(round.items.find(i=>i.id===confirmed.id)!.version,'history');
    const forgotten=await AnalysisCore.fromBackup(await resumed.backup(),store,model);try{await forgotten.engine.editState(s=>forgetMemory(s,retro.id));const view=await forgotten.dossier(id,{view:'full',history:true,limit:100});assert.equal(view.items.some(i=>i.id===confirmed.id&&i.availability==='available'),false);assert.equal(view.items.some(i=>i.record?.temporal?.acquisition),false);assert.ok(view.items.some(i=>i.id===unknown.id&&i.availability==='available'));}finally{forgotten.engine.stop();}
    await resumed.correctMemory(setup.id,'ENGINE MOCK局部更正标志事实。');const corrected=await resumed.dossier(id,{view:'full',history:true,limit:100});assert.equal(corrected.items.some(i=>i.record?.clue),false);assert.equal(corrected.items.some(i=>i.id===retro.id&&i.availability==='available'),false);assert.ok(corrected.items.some(i=>i.text===unknown.text));
    await resumed.engine.editState(s=>forgetMemory(s,unknown.id));assert.equal((await resumed.dossier(id,{view:'full',history:true,limit:100})).items.some(i=>i.id===unknown.id),false);assert.equal(calls,priorCalls);
  }finally{resumed?.engine.stop();engine.stop();await harness.dispose();}
});
