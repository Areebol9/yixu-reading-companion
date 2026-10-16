import test from 'node:test';
import assert from 'node:assert/strict';
import {AnalysisCore} from '../src/core/analysis-core.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import {ChatModel} from '../src/core/model.ts';
import {HarnessRuntime} from '../src/agent/runtime.ts';
import {initialState} from '../src/core/state.ts';
import {forgetMemory,evidence} from '../src/core/context.ts';
import {projectStructureRelations} from '../src/core/structure-relations.ts';
import {searchMemories} from '../src/core/recall.ts';
import {selectAnalysisMaterials} from '../src/core/analysis-materials.ts';
import {bindWorldPlan,MissingWorldIdentityBindingsError} from '../src/core/world-identity.ts';
import {planMemories} from '../src/core/memory-plan.ts';
import type {Store,Memory} from '../src/core/types.ts';

const empty={memoryIds:[],chatIds:[]};
const response=(name:string,args:unknown)=>({status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:'engine-relation-mock',type:'function',function:{name,arguments:JSON.stringify(args)}}]}}],usage:{prompt_tokens:0,completion_tokens:0}}});
const packet=(body:any)=>JSON.parse(body.messages.find((m:any)=>m.role==='user'&&m.content.startsWith('{')).content.split('\n\n')[0]);
const pages=(body:any)=>body.messages.filter((m:any)=>m.role==='tool').flatMap((m:any)=>{try{return(JSON.parse(m.content).results??[]).flatMap((r:any)=>{try{return[JSON.parse(r.text)];}catch{return[];}});}catch{return[];}}).filter((p:any)=>Array.isArray(p.items));
const entries=(body:any)=>[...(packet(body).analysisMaterials??[]),...pages(body).filter((p:any)=>p.request?.relations?p.request.view==='full':p.request?.view!=='index').flatMap((p:any)=>p.items)];

test('ENGINE MOCK关联驱动连续阅读：新事件带旧条件与知情，经正式全文回查接续、查询、更正遗忘及备份',async()=>{
  const state=initialState();state.settings.services[0].enabled=true;state.settings.tokenLimit=2_000_000;
  let disk=structuredClone(state),phase='seed',calls=0,step=0,failReady=false,entity:string,oldA:Memory,oldB:Memory,oldQuestion:Memory,oldOpinion:Memory,oldReceived:Memory,sourceA:Memory,sourceB:Memory;
  const store:Store={async load(){return structuredClone(disk);},async save(s){if(failReady&&s.queryCheckpoints?.some(c=>c.status==='ready'&&c.material?.historicalSourceIds?.includes(oldQuestion.id)))throw Error('ENGINE MOCK历史全文结果保存中断');disk=structuredClone(s);}};
  const firstFact='ENGINE MOCK：保险匣必须双签并每月复验，承运许可并不解除保管。';
  const secondFact='ENGINE MOCK：水闸必须等巡检完才开启；通行延后会影响巡检到场。';
  const question='ENGINE MOCK：甲员能否让巡检到场，是否取得保险匣双签？';
  const model=new ChatModel(async request=>{
    calls++;const body=request.body,p=packet(body);assert.equal(JSON.stringify(body).includes('UNREAD-RELATIONS'),false);
    if(phase==='seed')return response('submit_reading',{
      stageNarrative:{text:'ENGINE MOCK：两条独立条件与信息差形成。',sourceIds:['p1'],basis:empty},entityRoots:[{key:'new1',memoryId:'t1'},{key:'new2',memoryId:'t2'}],thoughts:[
        {kind:'story',text:'ENGINE MOCK：甲员是登记姓名。',identityClaim:{type:'name',entityId:'new1',name:'甲员',cognition:'observed'},sourceIds:['p1'],basis:empty},
        {kind:'story',text:'ENGINE MOCK：乙员是登记姓名。',identityClaim:{type:'name',entityId:'new2',name:'乙员',cognition:'observed'},sourceIds:['p1'],basis:empty},
        {kind:'story',text:firstFact,about:[{entityId:'new1'}],sourceIds:['p1'],basis:empty},
        {kind:'story',text:secondFact,about:[{entityId:'new2'}],sourceIds:['p1'],basis:empty},
        {kind:'question',text:question,about:[{entityId:'new1'}],sourceIds:['p1'],basis:empty},
        {kind:'opinion',text:'ENGINE MOCK：两项许可须分别判断。',about:[{entityId:'new1'}],sourceIds:['p1'],basis:empty},
        {kind:'story',text:'ENGINE MOCK：甲员收到巡检等待的信息。',attribution:{holderId:'new1',mode:'received',grounding:'stated',contentRef:{memoryId:'t4',start:0,end:secondFact.length}},sourceIds:['p1'],basis:empty},
        {kind:'story',text:'ENGINE MOCK：乙员明确尚不知双签要求。',attribution:{holderId:'new2',mode:'explicitly-unaware',grounding:'stated',contentRef:{memoryId:'t3',start:0,end:firstFact.length}},sourceIds:['p1'],basis:empty}
      ],stateUpdates:[{topic:'保管约束',basis:empty,operations:[{op:'add',memoryId:'t3'}]},{topic:'巡检约束',basis:empty,operations:[{op:'add',memoryId:'t4'}]}],arcUpdates:[{label:'保险匣线',basis:empty,operations:[{op:'add',role:'condition',memoryId:'t3'}]},{label:'水闸线',basis:empty,operations:[{op:'add',role:'condition',memoryId:'t4'}]}]
    });
    const got=entries(body),toolPages=pages(body),byText=(text:string)=>got.find((m:any)=>!['state','stage','arc'].includes(m.kind)&&m.text===text),navigations=[...(p.analysisIndex?.items??[]),...(p.analysisMaterials??[]),...toolPages.flatMap((page:any)=>[...page.items,...(page.relations?.nodes??[])])];
    if(phase==='advance'){
      const firstNavigation=[...(p.analysisIndex?.items??[]),...(p.analysisMaterials??[])];
      assert.ok(firstNavigation.some((m:any)=>m.kind==='state'));
      assert.ok(firstNavigation.some((m:any)=>m.kind==='arc'));
      // The new scene names a person but none of the old condition words.
      assert.equal(p.current.includes('双签'),false);assert.equal(p.current.includes('水闸'),false);
      if(step++===0)return response('recall_memory',{relations:true,entityIds:[(p.entityIndex.items.find((e:any)=>e.names.some((n:any)=>n.name==='甲员'))?.id??got.find((m:any)=>m.identityClaim?.name==='甲员')?.identityClaim.entityId??got.find((m:any)=>m.text===firstFact)?.about?.[0]?.entityId??got.find((m:any)=>m.attribution)?.attribution.holderId)],view:'full'});
      if(!toolPages.some((page:any)=>page.request?.relations&&page.request.ids)){
        const a=byText(firstFact),b=byText(secondFact);
        if(!a||!b){const need=navigations.filter((m:any)=>m.kind==='story').slice(0,8).map((m:any)=>m.id);return response('recall_memory',{ids:[...new Set(need)]});}
        return response('recall_memory',{relations:true,ids:[a.id,b.id],view:'full'});
      }
      const a=got.find((m:any)=>m.arcProjection?.label==='保险匣线'),b=got.find((m:any)=>m.arcProjection?.label==='水闸线'),sa=got.find((m:any)=>m.stateProjection?.topic==='保管约束'),sb=got.find((m:any)=>m.stateProjection?.topic==='巡检约束'),q=byText(question),op=byText(oldOpinion.text),received=byText(oldReceived.text),name=got.find((m:any)=>m.identityClaim?.name==='甲员');
      if(!a||!b||!sa||!sb||!q||!op||!received||!name){const want=['arc','state','question','opinion','story'],fullIds=new Set(got.map((m:any)=>m.id)),ids=[...new Set(navigations.filter((m:any)=>want.includes(m.kind)&&!fullIds.has(m.id)).map((m:any)=>m.id))].slice(0,8);assert.ok(ids.length,'完整更新来源必须实际可取得');return response('recall_memory',{ids});}
      const relationBodies=toolPages.filter((page:any)=>page.request?.relations&&page.request.ids);
      if(!toolPages.some((page:any)=>page.request?.ids&&!page.request.relations&&page.items.some((m:any)=>m.kind==='state'||m.kind==='arc'))&&relationBodies.some((page:any)=>page.relations.missingBodyIds?.length))return response('recall_memory',{ids:relationBodies.at(-1).relations.missingBodyIds.slice(0,8)});
      assert.ok(toolPages.some((page:any)=>page.items.some((m:any)=>m.kind==='state'||m.kind==='arc')),'关系入口正式取回旧结构全文');
      assert.ok(received.attribution.contentRef.memoryId===byText(secondFact).id);
      return response('submit_reading',{stageNarrative:{text:'ENGINE MOCK：甲员换路使巡检到场；双签未取得。',sourceIds:['p1'],basis:empty},thoughts:[
        {kind:'story',text:'ENGINE MOCK：甲员通知巡检已到场。',attribution:{holderId:name.identityClaim.entityId,mode:'claims',grounding:'stated',contentRef:{memoryId:byText(secondFact).id,start:0,end:secondFact.length}},worldChangeOf:received.id,sourceIds:['p1'],basis:empty},
        {kind:'story',text:'ENGINE MOCK：巡检已到场，但双签仍未取得。',answersPartOf:q.id,sourceIds:['p1'],basis:empty},
        {kind:'opinion',text:'ENGINE MOCK：到场仅推进水闸线，双签保管条件独立保持。',updates:op.id,updateReason:'ENGINE MOCK新原文到场明确。',sourceIds:['p1'],basis:{memoryIds:[sa.id,sb.id],chatIds:[]}}
      ],stateUpdates:[{topic:'保管约束',stateChangeOf:sa.id,basis:empty,operations:[{op:'add',text:'ENGINE MOCK：双签尚未取得。',sourceIds:['p1']}]},{topic:'巡检约束',stateChangeOf:sb.id,basis:empty,operations:[{op:'add',text:'ENGINE MOCK：巡检已经到场。',sourceIds:['p1']}]}],arcUpdates:[{arcChangeOf:a.id,basis:empty,operations:[{op:'add',role:'impact',text:'ENGINE MOCK：换路使巡检到场，推进水闸条件。',sourceIds:['p1'],impact:{targetId:b.id,type:'enables',cognition:'observed'}}]},{arcChangeOf:b.id,basis:empty,operations:[{op:'add',role:'progress',text:'ENGINE MOCK：巡检到场。',sourceIds:['p1']}]}]});
    }
    if(phase==='query'){
      if(step++===0)return response('recall_memory',{relations:true,entityIds:[(p.entityIndex.items.find((e:any)=>e.names.some((n:any)=>n.name==='甲员'))?.id??got.find((m:any)=>m.identityClaim?.name==='甲员')?.identityClaim.entityId??got.find((m:any)=>m.text===firstFact)?.about?.[0]?.entityId??got.find((m:any)=>m.attribution)?.attribution.holderId)]});
      if(!toolPages.some((page:any)=>page.request?.relations&&page.request.ids)){const seed=byText(firstFact);if(!seed)return response('recall_memory',{ids:toolPages.find((page:any)=>page.request?.relations).items.map((m:any)=>m.id).slice(0,8)});return response('recall_memory',{relations:true,ids:[seed.id],view:'full'});}
      const a=got.find((m:any)=>m.arcProjection?.label==='保险匣线'&&m.text.includes('换路')),b=got.find((m:any)=>m.arcProjection?.label==='水闸线');
      if(a&&!b)return response('recall_memory',{ids:[a.arcProjection.parts.find((part:any)=>part.impact).impact.targetVersionId]});
      if(!a){const ids=[...new Set(navigations.filter((m:any)=>m.kind==='arc').map((m:any)=>m.id))];return response('recall_memory',{ids});}
      assert.ok(a.arcProjection.parts.some((part:any)=>part.impact?.targetVersionId));
      return response('submit_reading',{reply:'ENGINE MOCK：甲员的到场消息推进巡检，但双签与复验条件仍保持。',replyBasis:{memoryIds:[a.id,b.id],chatIds:[]}});
    }
    if(phase==='close-question'){
      const q=byText(question);assert.ok(q);return response('submit_reading',{reply:'ENGINE MOCK：完整答复存档。',thoughts:[{kind:'story',text:'ENGINE MOCK：原问两条件正式答全。',updates:q.id,updateReason:'ENGINE MOCK两条件原文均已明确。',sourceIds:['p1'],basis:empty}]});
    }
    if(phase==='history-query'){
      const answer=got.find((m:any)=>m.text==='ENGINE MOCK：原问两条件正式答全。');
      if(!answer)return response('recall_memory',{query:'原问 两条件 正式 答全'});
      if(!toolPages.some((page:any)=>page.request?.relations))return response('recall_memory',{relations:true,ids:[answer.id]});
      const history=toolPages.find((page:any)=>page.relations?.items.some((e:any)=>e.type==='complete-answer'));
      const qId=history.relations.items.find((e:any)=>e.type==='complete-answer').from.id;
      if(!toolPages.some((page:any)=>page.request?.ids?.includes(qId)&&page.items.some((m:any)=>m.id===qId&&m.text===question)))return response('recall_memory',{ids:[qId]});
      const q=got.find((m:any)=>m.id===qId&&m.text===question);assert.equal(q.history,true);assert.equal(q.canUpdate,false);
      return response('submit_reading',{reply:'ENGINE MOCK：原题两项条件均有全文记录。',thoughts:[{kind:'opinion',text:'ENGINE MOCK：回看原题应保留两个独立条件。',basis:{memoryIds:[qId,answer.id],chatIds:[]},sourceIds:['p1']}]});
    }
    throw Error('unexpected mock phase');
  });
  const harness=new HarnessRuntime(),engine=new ReadingEngine(state,store,model);engine.agent=harness;const core=new AnalysisCore(engine);
  try{
    const id=await core.importText('ENGINE MOCK关联接续工程','第一章 约束\nENGINE MOCK：甲员、乙员登记两项约束及信息差。\n'+'隔段登记无关材料。'.repeat(1200)+'\n第二章 新事\n甲员换路来到会合处，新的通知刚发出。\n第三章 未许可\nUNREAD-RELATIONS'),book=engine.book(id),first={start:book.chapters[0].start,end:book.chapters[0].start+60},second={start:book.chapters[1].start,end:book.chapters[1].end};
    await core.grant(id,[first]);await core.configure(id,{arcCandidate:'v1',worldCandidate:'v1'});await core.analyze(id,[first]);
    entity=state.entityRoots![0].id;oldA=state.memories.find(m=>m.arcProjection?.label==='保险匣线')!;oldB=state.memories.find(m=>m.arcProjection?.label==='水闸线')!;oldQuestion=state.memories.find(m=>m.kind==='question')!;oldOpinion=state.memories.find(m=>m.kind==='opinion')!;oldReceived=state.memories.find(m=>m.attribution?.mode==='received')!;sourceA=state.memories.find(m=>m.text===firstFact)!;sourceB=state.memories.find(m=>m.text===secondFact)!;
    await core.grant(id,[second]);phase='advance';step=0;await core.analyze(id,[second]);
    const a=state.memories.find(m=>m.arcChangeOf===oldA.id)!,b=state.memories.find(m=>m.arcChangeOf===oldB.id)!;
    assert.ok(a&&b);assert.ok(a.text.includes(firstFact));assert.ok(b.text.includes(secondFact));assert.ok(state.memories.some(m=>m.stateChangeOf&&m.text.includes(firstFact)&&m.text.includes('尚未取得')));assert.ok(state.memories.some(m=>m.worldChangeOf===oldReceived.id));assert.ok(state.memories.some(m=>m.answersPartOf===oldQuestion.id));assert.ok(state.memories.some(m=>m.correctionOf===oldOpinion.id&&m.revisionKind==='development'));
    const impact=a.arcProjection!.parts.find(part=>part.impact)!.impact!;assert.equal(impact.targetVersionId,oldB.id);assert.equal(impact.sourceVersionId,a.id);
    const graph=projectStructureRelations(state,book,{source:'conversation',worldCandidate:'v1',arcCandidate:'v1'});assert.ok(graph.edges.some(e=>e.type==='impact'&&e.from.id===a.id&&e.to.id===oldB.id));assert.ok(graph.edges.some(e=>e.type==='development'&&e.from.id===oldReceived.id));assert.ok(graph.edges.some(e=>e.type==='partial-answer'));
    phase='query';step=0;const before=state.memories.length;await core.query(id,'甲员消息如何牵动两条线？',{memoryAllowed:false,long:true});assert.equal(state.memories.length,before);assert.ok(state.chats.some(c=>c.role==='assistant'&&c.text.includes('复验条件')));
    phase='close-question';await core.query(id,'甲员原题完整回答');assert.ok(oldQuestion.replacedBy);phase='history-query';step=0;await core.query(id,'回看甲员原题条件');
    const oldEntry=state.memories.find(m=>m.text==='ENGINE MOCK：回看原题应保留两个独立条件。')!;assert.ok(oldEntry?.basis?.memoryIds.includes(oldQuestion.id));
    const scope=structuredClone(state),future=evidence(book,{start:book.chapters[2].start,end:book.chapters[2].end});
    scope.memories.push(...[{...structuredClone(sourceA),id:'engine-foreign-partner',partnerId:'other-partner'},{...structuredClone(sourceA),id:'engine-foreign-book',bookId:'other-book'},{...structuredClone(sourceA),id:'engine-background',source:'background' as const},{...structuredClone(sourceA),id:'engine-future',evidence:[future],sourceEvidence:[future]}]);
    assert.deepEqual(projectStructureRelations(scope,book,{source:'conversation',worldCandidate:'v1',arcCandidate:'v1'}).edges,projectStructureRelations(state,book,{source:'conversation',worldCandidate:'v1',arcCandidate:'v1'}).edges,'外书、伙伴、背景lane和未来正文不能进入关系计数或页');
    const qCheckpoint=state.queryCheckpoints!.at(-1)!;assert.equal(qCheckpoint.status,'consumed');
    const frozen=selectAnalysisMaterials(state,book,{source:'conversation',query:'甲员',worldCandidate:'v1',arcCandidate:'v1',queryMode:true,budget:3000,chats:[]});assert.ok(frozen.chars<=3000);
    const historical=searchMemories(state,book,{ids:[oldQuestion.id]},[],'conversation','structured',{analysis:true,arcCandidate:'v1',worldCandidate:'v1',relationHistoryIds:[oldQuestion.id]});assert.equal(historical.items[0].text,question);
    const support=evidence(book,second),reply={reply:'',thoughts:[{kind:'opinion' as const,text:'ENGINE MOCK：目录不能授予旧题来源。',basis:{memoryIds:[oldQuestion.id],chatIds:[]}}],wantsLong:false};
    assert.equal(planMemories(state,book,reply,[support,...oldQuestion.evidence],[oldQuestion.id],[],'conversation').added.length,0,'没有形成时历史全文标记，旧当前输入不能追认为合法历史');
    assert.throws(()=>planMemories(state,book,{...reply,thoughts:[{kind:'story',text:'ENGINE MOCK非法改旧题',updates:oldQuestion.id,updateReason:'非法'}]},[support,...oldQuestion.evidence],[oldQuestion.id],[],'conversation',undefined,[],[],new Map(),undefined,{historicalSourceIds:[oldQuestion.id]}));
    const name=state.memories.find(m=>m.identityClaim?.entityId===entity)!;const proposed:Memory={...structuredClone(sourceA),id:'engine-mock-directory-write',text:'ENGINE MOCK：甲员新声明。',about:[{entityId:entity}]};delete proposed.entityBindings;
    assert.throws(()=>bindWorldPlan(state,book,[proposed],new Map(),[],[],[support,...sourceA.evidence], 'conversation'),MissingWorldIdentityBindingsError);bindWorldPlan(state,book,[proposed],new Map(),[],[name.id],[support,...name.evidence],'conversation');assert.ok(proposed.entityBindings?.length);
    // A completed candidate preserves supplied-as-history through storage failure and backup.
    failReady=true;step=0;await assert.rejects(core.query(id,'再次回看甲员原题条件'),/ENGINE MOCK历史全文结果保存中断/);
    const pending=state.chats.filter(c=>c.role==='user').at(-1)!,ready=state.queryCheckpoints!.find(c=>c.questionId===pending.id)!;
    assert.ok(ready.material!.historicalSourceIds?.includes(oldQuestion.id));assert.equal(ready.status,'ready');
    failReady=false;const restored=await AnalysisCore.fromBackup(await core.backup(),store,model,{agent:harness});
    try{
      const beforeResume=calls;await restored.engine.retryQuestion(pending.id);assert.equal(calls,beforeResume,'形成时历史全文和已返回结果接续不重发模型');
      const s=restored.engine.state,rb=restored.engine.book(id),rgraph=projectStructureRelations(s,rb,{source:'conversation',worldCandidate:'v1',arcCandidate:'v1'});assert.deepEqual(rgraph.edges,graphAfter());
      const callCount=calls;await restored.correctMemory(sourceA.id,'ENGINE MOCK：双签来源需更正。');assert.equal(calls,callCount);assert.equal(projectStructureRelations(s,rb,{source:'conversation',worldCandidate:'v1',arcCandidate:'v1'}).edges.some(e=>e.from.id===sourceA.id||e.to.id===sourceA.id),false);
      await restored.engine.editState(d=>forgetMemory(d,sourceB.id),undefined,true);assert.equal(projectStructureRelations(s,rb,{source:'conversation',worldCandidate:'v1',arcCandidate:'v1'}).edges.some(e=>e.from.id===sourceB.id||e.to.id===sourceB.id),false);
      const round=await AnalysisCore.fromBackup(await restored.backup(),store,model);try{assert.equal(projectStructureRelations(round.engine.state,round.engine.book(id),{source:'conversation',worldCandidate:'v1',arcCandidate:'v1'}).edges.some(e=>[sourceA.id,sourceB.id].includes(e.from.id)||[sourceA.id,sourceB.id].includes(e.to.id)),false);}finally{round.engine.stop();}
    }finally{restored.engine.stop();}
    function graphAfter(){return projectStructureRelations(state,book,{source:'conversation',worldCandidate:'v1',arcCandidate:'v1'}).edges;}
  }finally{engine.stop();await engine.persist();await harness.dispose();}
});
