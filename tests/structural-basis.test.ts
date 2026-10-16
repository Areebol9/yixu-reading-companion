import test from 'node:test';
import assert from 'node:assert/strict';
import {AnalysisCore} from '../src/core/analysis-core.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import {ChatModel} from '../src/core/model.ts';
import {HarnessRuntime} from '../src/agent/runtime.ts';
import {initialState} from '../src/core/state.ts';
import {readingDraftUsable,createReadingDraft} from '../src/core/reading-drafts.ts';
import {ReadingReferences} from '../src/core/reading-references.ts';
import {parseStructuralBasis,planStructuralBasis} from '../src/core/basis.ts';
import {parseStageNarrative,validateStageStateMemories} from '../src/core/stage-state.ts';
import {evidence} from '../src/core/context.ts';
import {planArcMemories} from '../src/core/arc-state.ts';
import {restoreBackup} from '../src/core/backup.ts';
import type {Memory,ReadingReply,Store} from '../src/core/types.ts';

const empty={memoryIds:[],chatIds:[]};
const fixtureText='第一章 工程登记\nENGINE MOCK：许可后仍保管，每月检查；运输登记是独立的原文事实。\n第二章 工程变化\nENGINE MOCK：新增次日到场，运输登记阶段结束，保管约束保持。\n第三章 工程接续\nENGINE MOCK：继续查看保管约束与新的到场安排。\n第四章 未授权\nUNREAD-STRUCTURAL-BASIS';
const entries=(body:any)=>{
  const result:any[]=[];
  for(const message of body.messages){
    if(message.role==='user')try{const p=JSON.parse(message.content.split('\n\n')[0]);for(const key of ['analysisMaterials','memories','currentStates','stageNarratives','arcs'])result.push(...(p[key]??[]));}catch{}
    if(message.role==='tool')try{const p=JSON.parse(message.content);result.push(...(p.items??[]));for(const r of p.results??[])result.push(...(JSON.parse(r.text).items??[]));}catch{}
  }
  return result;
};
async function fixture(invoke:(body:any)=>unknown){
  const state=initialState();state.settings.services[0].enabled=true;let disk=structuredClone(state),calls=0;
  const store:Store={async load(){return structuredClone(disk);},async save(s){disk=structuredClone(s);}};
  const model=new ChatModel(async request=>{calls++;return{status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:'engine-mock-basis',type:'function',function:{name:'submit_reading',arguments:JSON.stringify(invoke(request.body))}}]}}],usage:{prompt_tokens:0,completion_tokens:0}}};});
  const harness=new HarnessRuntime(),engine=new ReadingEngine(state,store,model);engine.agent=harness;
  return{state,store,model,harness,engine,core:new AnalysisCore(engine),calls:()=>calls,async close(){engine.stop();await engine.persist();await harness.dispose();}};
}

test('ENGINE MOCK结构独立依据：实际保存、阶段更正、携条件增量与结束、真实来源停用、备份和旧稿接续',async()=>{
  let phase='seed';
  const f=await fixture(body=>{
    assert.equal(JSON.stringify(body).includes('UNREAD-STRUCTURAL-BASIS'),false);
    if(phase==='seed')return{stageNarrative:{text:'ENGINE MOCK：登记过程。',sourceIds:['p1'],basis:empty},thoughts:[{kind:'story',text:'ENGINE MOCK：运输登记是独立原文事实。',sourceIds:['p1'],basis:empty}],stateUpdates:[
      {topic:'工程保管',basis:empty,operations:[{op:'add',text:'ENGINE MOCK：每月检查、许可后仍保管。',sourceIds:['p1']}]},
      {topic:'工程运输',basis:{memoryIds:['t1'],chatIds:[]},operations:[{op:'add',memoryId:'t1'}]}
    ],arcUpdates:[{label:'工程弧线',basis:empty,operations:[{op:'add',role:'condition',memoryId:'t1'},{op:'add',role:'condition',text:'ENGINE MOCK：许可后的保管约束仍有效。',sourceIds:['p1']}]}]};
    const got=entries(body),a=got.find(m=>m.kind==='state'&&m.stateProjection?.topic==='工程保管'),b=got.find(m=>m.kind==='state'&&m.stateProjection?.topic==='工程运输'),arc=got.find(m=>m.kind==='arc'&&m.arcProjection?.label==='工程弧线');
    assert.ok(a&&b&&arc,'本轮工程增量必须实际取得三项完整结构');
    return{stageNarrative:{text:'ENGINE MOCK：次日安排和运输结束。',sourceIds:['p1'],basis:empty},thoughts:[],stateUpdates:[
      {topic:'工程保管',stateChangeOf:a.id,basis:empty,operations:[{op:'add',text:'ENGINE MOCK：新增次日到场。',sourceIds:['p1']}]},
      {topic:'工程运输',stateChangeOf:b.id,basis:empty,status:'ended',operations:[{op:'retire',partId:b.stateProjection.parts[0].id,reason:'ENGINE MOCK原文登记结束。',sourceIds:['p1']}],end:{text:'ENGINE MOCK：运输登记阶段结束。',sourceIds:['p1']}}
    ],arcUpdates:[{arcChangeOf:arc.id,basis:empty,operations:[{op:'retire',partId:arc.arcProjection.parts[0].id,reason:'ENGINE MOCK原文登记结束。',sourceIds:['p1']},{op:'add',role:'progress',text:'ENGINE MOCK：次日到场安排新增。',sourceIds:['p1']}]}]};
  });
  try{
    const id=await f.core.importText('ENGINE MOCK结构依据工程',fixtureText),book=f.engine.book(id),first={start:book.chapters[0].start,end:book.chapters[0].end},second={start:book.chapters[1].start,end:book.chapters[1].end};
    await f.core.grant(id,[first]);await f.core.configure(id,{arcCandidate:'v1'});await f.core.analyze(id,[first]);
    const stage=f.state.memories.find(m=>m.kind==='stage')!,source=f.state.memories.find(m=>m.kind==='story')!,a=f.state.memories.find(m=>m.stateProjection?.topic==='工程保管')!,b=f.state.memories.find(m=>m.stateProjection?.topic==='工程运输')!,arc=f.state.memories.find(m=>m.kind==='arc')!;
    assert.deepEqual(stage.basis,empty);assert.deepEqual(a.basis,empty);assert.ok(b.basis!.memoryIds.includes(source.id));assert.ok(arc.basis!.memoryIds.includes(source.id));assert.ok(a.parents.includes(stage.id));assert.ok(a.evidence.length);assert.equal(f.state.memories.some(m=>m.basis?.memoryIds.some(id=>/^t\d+$/.test(id))),false);
    await f.core.correctMemory(stage.id,'ENGINE MOCK：阶段原文表达需要更正。');
    const materials=await f.core.queryMaterials(id,'工程保管 工程运输');
    for(const m of [a,b,arc]){assert.equal(m.invalidatedBy,undefined);assert.ok(materials.records.some(r=>r.id===m.id));}
    phase='increment';await f.core.grant(id,[second]);
    const save=f.store.save.bind(f.store);let fail=true;
    f.store.save=async state=>{if(fail&&state.readings?.some(r=>r.ranges.some(p=>p.end===second.end)&&r.processing==='model'))throw Error('ENGINE MOCK提交保存中断');await save(state);};
    await assert.rejects(f.core.analyze(id,[second]),/ENGINE MOCK提交保存中断/);
    const draft=f.state.readingDrafts!.at(-1)!;assert.equal(draft.material.basisStampVersion,1);assert.equal(readingDraftUsable(f.state,draft),true);
    const clone=structuredClone(f.state),clonedA=clone.memories.find(m=>m.id===a.id)!;clonedA.basis={memoryIds:[],chatIds:[],habitIds:[]};assert.equal(readingDraftUsable(clone,draft),false);
    const altered=structuredClone(draft);altered.result.stageNarrative!.basis={memoryIds:[source.id],chatIds:[]};assert.equal(readingDraftUsable(f.state,altered),false);
    fail=false;const calls=f.calls(),restored=await AnalysisCore.fromBackup(await f.core.backup(),f.store,f.model);
    try{
      await restored.analyze(id,[second]);assert.equal(f.calls(),calls,'已完整保存的理解复用原稿，不能重发mock模型');
      const s=restored.engine.state,newA=s.memories.find(m=>m.stateChangeOf===a.id)!,newB=s.memories.find(m=>m.stateChangeOf===b.id)!,newArc=s.memories.find(m=>m.arcChangeOf===arc.id)!;
      assert.ok(newA.text.includes(a.text));assert.ok(newA.basis!.memoryIds.includes(a.id));assert.equal(newB.stateProjection!.status,'ended');assert.ok(newB.basis!.memoryIds.includes(b.id));assert.ok(newArc.basis!.memoryIds.includes(arc.id));assert.equal(newArc.arcProjection!.parts.some(p=>p.memoryRef),false);assert.ok(newArc.text.includes(arc.arcProjection!.parts[1].text));
      validateStageStateMemories(s);
      await restored.correctMemory(source.id,'ENGINE MOCK：实际运输来源更正。');
      assert.equal(newA.invalidatedBy,undefined);assert.ok(newB.invalidatedBy);assert.ok(newArc.invalidatedBy);assert.ok(b.invalidatedBy===undefined,'原fixture副本保持隔离');
      const round=await AnalysisCore.fromBackup(await restored.backup(),f.store,f.model);
      try{assert.equal(round.engine.state.memories.find(m=>m.id===newA.id)!.invalidatedBy,undefined);assert.ok(round.engine.state.memories.find(m=>m.id===newArc.id)!.invalidatedBy);}finally{round.engine.stop();}
    }finally{restored.engine.stop();}

    // Existing local labels still map both ways, while directories do not gain source authority.
    const refs=new ReadingReferences(),raw:ReadingReply={reply:'',thoughts:[],wantsLong:false,stageNarrative:{text:'ENGINE MOCK归因',basis:{memoryIds:[source.id],chatIds:['actual-chat'],habitIds:['actual-habit']}}};
    const message=refs.messages([{role:'user',content:JSON.stringify({memories:[{id:source.id,kind:'story',text:source.text}],conversation:[{id:'actual-chat'}],commonHabits:[{id:'actual-habit'}],draft:raw})}])[0];
    const encoded=JSON.parse(message.content).draft;assert.deepEqual(encoded.stageNarrative.basis,{memoryIds:['m1'],chatIds:['c1'],habitIds:['h1']});assert.deepEqual(refs.decode(encoded).stageNarrative!.basis,raw.stageNarrative!.basis);
    assert.throws(()=>refs.decode({...raw,stageNarrative:{...raw.stageNarrative!,basis:{memoryIds:['m999'],chatIds:[]}}}),/结构basis编号/);
    for(const bad of [null,[],{}, {memoryIds:[],chatIds:[],extra:true}])assert.throws(()=>parseStageNarrative({text:'ENGINE MOCK',basis:bad}),/结构basis/);
    const ctx={parents:[],chatIds:[],habitIds:[],source:'preparation' as const,refs:a.evidence,originalRanges:[first],passages:new Map(),proposalSources:new Map<string,Memory>()};
    assert.throws(()=>planStructuralBasis(f.state,book,structuredClone(a),{memoryIds:[source.id],chatIds:[]},ctx),/目录不授依据/);
    assert.throws(()=>planStructuralBasis(f.state,book,structuredClone(a),{memoryIds:['t99'],chatIds:[]},ctx),/t来源未成功/);
    assert.throws(()=>planStructuralBasis(f.state,book,structuredClone(a),empty,ctx),/本轮实际p/);
    const large={memoryIds:Array.from({length:65},(_,i)=>'actual-'+i),chatIds:[]};assert.throws(()=>parseStructuralBasis(large),/结构basis/);assert.equal(parseStructuralBasis(large,65)!.memoryIds.length,65);
    const orphan=structuredClone(f.state),orphanStage=orphan.memories.find(m=>m.id===stage.id)!;orphanStage.source='review';delete orphanStage.correctionOf;
    assert.throws(()=>validateStageStateMemories(orphan),/完整范围与依赖/,'孤立review不能借normal结构依据协议合法化');

    // One legal 64-part arc reaches 65 mandatory dependencies by sharing an actual target.
    const boundary=structuredClone(f.state),scopeBook=boundary.books.find(b=>b.id===id)!,support=evidence(scopeBook,first);
    const sources:Memory[]=Array.from({length:64},(_,i)=>({id:'engine-mock-source-'+i,bookId:id,partnerId:boundary.partnerId,kind:'story',text:'ENGINE MOCK条'+i,evidence:[support],sourceEvidence:[support],parents:[],chatIds:[],createdAt:1,forgotten:false,source:'preparation'}));boundary.memories.push(...sources);
    const target=boundary.memories.find(m=>m.id===arc.id)!;
    const [linked]=planArcMemories(boundary,scopeBook,{reply:'',thoughts:[],wantsLong:false,arcUpdates:[{label:'ENGINE MOCK满额影响',basis:empty,operations:sources.map((m,i)=>({op:'add' as const,role:i===0?'impact' as const:'condition' as const,memoryId:m.id,sourceIds:['p1'],...(i===0?{impact:{type:'enables' as const,targetId:target.id,cognition:'observed' as const}}:{})}))}]},{refs:[support],parents:[...sources.map(m=>m.id),target.id],chatIds:[],habitIds:[],source:'preparation',originalRanges:[first],readingStage:[first],newMemoryIds:[],stateWriteVersion:2,passages:new Map([['p1',{text:scopeBook.text.slice(first.start,first.end),evidence:support}]])});
    assert.equal(linked.basis!.memoryIds.length,65);assert.ok(linked.basis!.memoryIds.includes(target.id));assert.equal(linked.basis!.memoryIds.includes(linked.id),false);boundary.memories.push(linked);
    const rebuilt=await restoreBackup(JSON.stringify(boundary),initialState());assert.deepEqual(rebuilt.memories.find(m=>m.id===linked.id)!.basis,linked.basis);
    const boundaryEngine=new ReadingEngine(rebuilt,{async load(){return rebuilt;},async save(){}},f.model),boundaryCore=new AnalysisCore(boundaryEngine);
    try{await boundaryCore.correctMemory(target.id,'ENGINE MOCK：实际跨线目标更正。');assert.ok(rebuilt.memories.find(m=>m.id===linked.id)!.invalidatedBy);}finally{boundaryEngine.stop();}
  }finally{await f.close();}

  const legacy=await fixture(()=>({stageNarrative:{text:'ENGINE MOCK旧稿阶段记录。',sourceIds:['p1']},thoughts:[],arcUpdates:[]}));
  try{
    const id=await legacy.core.importText('ENGINE MOCK旧稿工程',fixtureText),book=legacy.engine.book(id),first={start:book.chapters[0].start,end:book.chapters[0].end};await legacy.core.grant(id,[first]);await legacy.core.configure(id,{arcCandidate:'v1'});
    const result:ReadingReply={reply:'',thoughts:[],wantsLong:false,stageNarrative:{text:'ENGINE MOCK旧稿阶段记录。',sourceIds:['p1']},arcUpdates:[]};
    const oldDraft=createReadingDraft(legacy.state,book,{source:'preparation',ranges:[first],input:''},result,[],{narrativeMode:'stages',stateWriteVersion:2,arcCandidate:'v1',analysisTask:true,refs:[evidence(book,first)],originalRanges:[first],memoryIds:[],chatIds:[],habitIds:[],messages:[{role:'user',content:'ENGINE MOCK旧任务'}],passages:[['p1',{text:book.text.slice(first.start,first.end),evidence:evidence(book,first)}]]},'ready');
    assert.equal(oldDraft.material.basisStampVersion,undefined);legacy.state.readingDrafts=[oldDraft];const stamp=oldDraft.dependencyStamp,calls=legacy.calls();
    const restored=await AnalysisCore.fromBackup(await legacy.core.backup(),legacy.store,legacy.model);
    try{assert.equal(restored.engine.state.readingDrafts![0].dependencyStamp,stamp);assert.equal(readingDraftUsable(restored.engine.state,restored.engine.state.readingDrafts![0]),true);await restored.analyze(id,[first]);assert.equal(legacy.calls(),calls);assert.equal(restored.engine.state.memories.find(m=>m.kind==='stage')!.basis,undefined);}finally{restored.engine.stop();}
  }finally{await legacy.close();}

  // JSON compatibility uses the same pre-commit authority, so bad claims cannot freeze a retry loop.
  const jsonState=initialState();jsonState.settings.services[0].enabled=true;let jsonDisk=structuredClone(jsonState),jsonCase='unknown-t',jsonCalls=0;
  const jsonStore:Store={async load(){return structuredClone(jsonDisk);},async save(s){jsonDisk=structuredClone(s);}};
  const jsonEngine=new ReadingEngine(jsonState,jsonStore,{async complete(_service,messages){
    jsonCalls++;let key='t99';
    if(jsonCase==='directory'){
      const packet=JSON.parse(messages.find(m=>m.role==='user'&&m.content.startsWith('{'))!.content),full=new Set((packet.analysisMaterials??[]).map((m:any)=>m.id));
      const entry=packet.analysisIndex.items.find((m:any)=>!full.has(m.id));assert.ok(entry,'工程JSON输入确实只有该来源的目录，没有完整正文');key=entry.id;
    }
    return{content:JSON.stringify({reply:'',thoughts:[],stageNarrative:{text:'ENGINE MOCK不可授权的JSON结构',basis:{memoryIds:[key],chatIds:[]}}}),input:0,output:0,estimated:false,elapsedMs:0};
  }}),jsonCore=new AnalysisCore(jsonEngine);
  try{
    const id=await jsonCore.importText('ENGINE MOCK JSON源权工程',fixtureText),book=jsonEngine.book(id),first={start:book.chapters[0].start,end:book.chapters[0].end};await jsonCore.grant(id,[first]);
    await assert.rejects(jsonCore.analyze(id,[first]),/t来源未成功/);assert.equal(jsonState.readingDrafts?.length??0,0);assert.equal(jsonState.memories.length,0);
    jsonCase='directory';await jsonEngine.editState(state=>{state.memories.push(...Array.from({length:20},(_,i):Memory=>({id:'engine-json-directory-'+i,bookId:id,partnerId:state.partnerId,kind:'story',text:'ENGINE MOCK目录来源'+i+'。工程独立来源材料。'.repeat(80),evidence:[evidence(book,first)],parents:[],chatIds:[],createdAt:i+1,forgotten:false,source:'preparation'})));});
    await assert.rejects(jsonCore.analyze(id,[first]),/目录不授依据/);assert.equal(jsonState.readingDrafts?.length??0,0);assert.equal(jsonState.memories.length,20);assert.equal(jsonCalls,2);
  }finally{jsonEngine.stop();await jsonEngine.persist();}
});
