import test from 'node:test';
import assert from 'node:assert/strict';
import {AnalysisCore} from '../src/core/analysis-core.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import {ChatModel} from '../src/core/model.ts';
import {ModelRequestError} from '../src/core/errors.ts';
import {HarnessRuntime} from '../src/agent/runtime.ts';
import {initialState} from '../src/core/state.ts';
import {correctMemory,deleteChat,forgetMemory} from '../src/core/context.ts';
import {queryResultUsable,validateQueryCheckpoints,questionStamp} from '../src/core/query-checkpoints.ts';
import type {State,Store,Memory} from '../src/core/types.ts';

const response=(...entries:[string,unknown][])=>({status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:null,reasoning_content:'ENGINE MOCK REASONING NOT A RESULT',tool_calls:entries.map(([name,args],i)=>({id:'checkpoint-call-'+i,type:'function',function:{name,arguments:JSON.stringify(args)}}))}}],usage:{prompt_tokens:11,completion_tokens:7}}});
const packets=(body:any)=>body.messages.filter((m:any)=>m.role==='user').flatMap((m:any)=>m.content.split('\n\n')).flatMap((s:string)=>{try{return[JSON.parse(s)];}catch{return[];}});
const decodedPages=(body:any)=>[
  ...packets(body).flatMap(p=>(p.toolResults??[]).flatMap((r:any)=>{try{return[JSON.parse(r.text)];}catch{return[];}})),
  ...body.messages.filter((m:any)=>m.role==='tool').flatMap((m:any)=>{try{return(JSON.parse(m.content).results??[]).flatMap((r:any)=>{try{return[JSON.parse(r.text)];}catch{return[];}});}catch{return[];}})
];
async function fixture(invoke:(body:any)=>any,agent=true){
  const state=initialState();state.settings.services[0].enabled=true;state.settings.tokenLimit=3_000_000;let disk=structuredClone(state),calls=0,fail:(s:State)=>boolean=()=>false;
  const store:Store={async load(){return structuredClone(disk);},async save(s){if(fail(s))throw Error('ENGINE MOCK STORAGE FAILURE');disk=structuredClone(s);}};
  const model=new ChatModel(async request=>{calls++;if(!packets(request.body).some(p=>p.temporaryPermission))assert.equal(JSON.stringify(request.body).includes('UNREAD-QUERY-CHECKPOINT'),false);return invoke(request.body);});
  const runtime=new HarnessRuntime(),engine=new ReadingEngine(state,store,model);if(agent)engine.agent=runtime;const core=new AnalysisCore(engine);
  const id=await core.importText('ENGINE MOCK问题接续工程','第一章 登记\nENGINE MOCK原问证据明文：保管须每月检查，延期并不解除验收条件。\n'+'登记背景资料。'.repeat(2300)+'\n第二章 当前\nENGINE MOCK运输延期，回查登记与保管条件。\n第三章 未读\nUNREAD-QUERY-CHECKPOINT'),book=engine.book(id),first={start:book.chapters[0].start,end:book.chapters[0].start+100};
  await core.grant(id,[{start:book.chapters[0].start,end:book.chapters[0].end}]);
  return{state,store,model,runtime,engine,core,id,book,first,calls:()=>calls,setFailure(fn:(s:State)=>boolean){fail=fn;},async close(){engine.stop();await engine.persist();await runtime.dispose();}};
}
test('companion导航冷恢复保存原indexQuery及stamp，重投影新首包marker且不升全文来源权',async()=>{
  let phase='capture',step=0,resumeStep=0,oldAlias='';const oldText='检修愿望：恢复完整条件。'+'原工程条件。'.repeat(750)+'校准目标：先完成登记，再复测。'+'条件余文。'.repeat(700),queries=['检修愿望','校准目标'];
  const f=await fixture(body=>{
    const initial=packets(body).find(p=>p.currentRange)!;
    if(phase==='capture'){
      assert.equal(initial.workspaceMaterial.understanding.text,oldText);if(step<2)return response(['recall_memory',{query:queries[step++],kind:'opinion',view:'index'}]);throw new ModelRequestError('ENGINE MOCK导航目录取得后中断','not-dispatched');
    }
    assert.equal(initial.workspaceMaterial.understanding.text,'当前新的工程理解。');const restored=decodedPages(body).filter(p=>p.request?.view==='index'&&queries.includes(p.request.query));assert.equal(restored.length,2);for(const page of restored){const item=page.items[0];oldAlias=item.id;assert.equal(item.currentAlreadyProvided,undefined);assert.equal(item.text,undefined);assert(item.match);assert.equal(item.match.text,oldText.slice(item.match.textStart,item.match.textEnd));assert(item.match.text.includes(page.request.query));assert(page.notice.includes('不授来源'));}
    if(resumeStep++===0)return response(['submit_reading',{reply:'ENGINE MOCK目录不能接管全文。',workspace:{understanding:oldAlias}}]);assert(body.messages.some((m:any)=>m.role==='tool'&&m.content.includes('完整')));throw new ModelRequestError('ENGINE MOCK确认目录仍无全文权限','not-dispatched');
  });let resumed:AnalysisCore|undefined;
  try{
    f.book.readingStrategy='companion';f.book.narrativeMode='legacy';const old:Memory={id:'nav-checkpoint-old',bookId:f.id,partnerId:f.state.partnerId,kind:'opinion',text:oldText,source:'reading',evidence:[{bookId:f.id,version:f.book.version,...f.book.known[0]}],parents:[],chatIds:[],createdAt:1,forgotten:false};f.state.memories.push(old);f.state.companionWorkspaces=[{bookId:f.id,version:f.book.version,partnerId:f.state.partnerId,source:'reading',revision:1,understandingId:old.id,focusIds:[],updatedAt:1}];await f.engine.startReading(f.id);await assert.rejects(f.engine.ask(f.id,'请接着谈刚才那件事。'),/导航目录取得后中断/);
    const q=f.state.chats.find(c=>c.role==='user')!,acquired=f.state.queryCheckpoints![0].acquired.filter(a=>a.kind==='memory'&&a.id===old.id);assert.equal(acquired.length,2);assert.deepEqual(acquired.map(a=>a.kind==='memory'?a.indexQuery:undefined),queries);assert.equal(acquired[0].kind==='memory'&&acquired[0].stamp,acquired[1].kind==='memory'&&acquired[1].stamp);assert(acquired.every(a=>!Object.hasOwn(a,'match')&&!Object.hasOwn(a,'text')));delete q.answerScope;f.state.queryCheckpoints![0].questionStamp=questionStamp(q);validateQueryCheckpoints(f.state);const backup=await f.core.backup();await f.close();phase='resume';
    resumed=await AnalysisCore.fromBackup(backup,f.store,f.model,{agent:f.runtime});await resumed.engine.editState(s=>{s.settings.services[0].enabled=true;const current={...s.memories.find(m=>m.id===old.id)!,id:'nav-checkpoint-current',text:'当前新的工程理解。',createdAt:2};s.memories.push(current);const w=s.companionWorkspaces![0];w.understandingId=current.id;w.revision++;});await assert.rejects(resumed.engine.retryQuestion(q.id),/目录仍无全文权限/);assert.equal(resumed.engine.state.memories.length,2);assert.equal(resumed.engine.state.chats.find(c=>c.id===q.id)?.answerScope,undefined,'旧原问范围不在重试时改写');const checkpoint=resumed.engine.state.queryCheckpoints![0];assert(!checkpoint.material?.memoryIds.includes(old.id));assert.equal(checkpoint.acquired.filter(a=>a.kind==='memory'&&a.view==='full').length,0);assert.equal(f.calls(),5);
    const legacy=structuredClone(resumed.engine.state);for(const a of legacy.queryCheckpoints![0].acquired)if(a.kind==='memory')delete a.indexQuery;validateQueryCheckpoints(legacy);
  }finally{resumed?.engine.stop();await f.close();}
});

test('ENGINE MOCK同原问：取材中断备份重供，接住首次结算保存失败，ready零重发和原子消费防旧备份重存',async()=>{
  let phase='seed',turn=0,first:{start:number;end:number};
  const f=await fixture(body=>{
    if(phase==='seed')return response(['submit_reading',{stageNarrative:{text:'ENGINE MOCK登记阶段。',sourceIds:['p1'],basis:{memoryIds:[],chatIds:[]}},stateUpdates:[{topic:'保管条件',basis:{memoryIds:[],chatIds:[]},operations:[{op:'add',text:'ENGINE MOCK：每月检查，延期并不解除验收条件。',sourceIds:['p1']}]}]}]);
    if(phase==='intro')return response(['submit_reading',{reply:'ENGINE MOCK先前交流：保管仍需检查。',thoughts:[]}]);
    if(phase==='acquire'){
      if(turn++===0)return response(['recall_memory',{kind:'state'}],['read_original',first]);
      throw new ModelRequestError('ENGINE MOCK取得材料后中断','not-dispatched');
    }
    const restored=packets(body).flatMap(p=>p.toolResults??[]);assert.ok(restored.some((r:any)=>r.source==='获准原文'&&r.text.includes('原问证据明文')),'必须把原取材实际重供给新请求');
    const state=decodedPages(body).flatMap(p=>p.items??[]).find((m:any)=>m.kind==='state');assert.ok(state);
    const p=restored.find((r:any)=>r.source==='获准原文').text.match(/【(p\d+)】/)[1];
    return response(['submit_reading',{reply:'ENGINE MOCK：完整保管条件仍有效。',replyBasis:{memoryIds:[state.id],chatIds:[]},thoughts:[{kind:'opinion',text:'ENGINE MOCK接续观点：延期与验收条件应分别核对。',sourceIds:[p],basis:{memoryIds:[],chatIds:[]}}]}]);
  });
  let restored:AnalysisCore|undefined,readyBackup='';
  try{
    first=f.first;await f.core.analyze(f.id,[first]);await f.core.grant(f.id,[{start:f.book.chapters[1].start,end:f.book.chapters[1].end}]);
    phase='intro';await f.core.query(f.id,'ENGINE MOCK先前谈过保管资料。',{memoryAllowed:false});
    phase='acquire';await assert.rejects(f.core.query(f.id,'ENGINE MOCK回查登记与保管条件。',{long:true}),/取得材料后中断/);
    const question=f.state.chats.filter(c=>c.role==='user').at(-1)!,checkpoint=f.state.queryCheckpoints!.find(c=>c.questionId===question.id)!;assert.equal(checkpoint.status,'acquired');assert.ok(checkpoint.acquired.some(a=>a.kind==='original'));assert.ok(checkpoint.acquired.some(a=>a.kind==='memory'&&a.view==='full'));assert.equal(checkpoint.usageIds.length,2);
    const acquiredBackup=await f.core.backup();restored=await AnalysisCore.fromBackup(acquiredBackup,f.store,f.model,{agent:f.runtime});await restored.engine.editState(s=>{s.settings.services[0].enabled=true;});await restored.engine.setReadingMode(f.id,'stages');
    phase='answer';f.setFailure(s=>s.queryCheckpoints?.some(q=>q.questionId===question.id&&q.status==='received')??false);
    await assert.rejects(restored.engine.retryQuestion(question.id),/完整问题结果已接住|STORAGE FAILURE/);
    const received=restored.engine.state.queryCheckpoints!.find(c=>c.questionId===question.id)!,calls=f.calls(),usage=JSON.stringify(restored.engine.state.usage);assert.equal(received.status,'received');assert.ok(received.candidate);assert.equal(JSON.stringify(received).includes('ENGINE MOCK REASONING'),false);assert.equal(received.usageIds.length,3);assert.equal(restored.engine.state.chats.some(c=>c.role==='assistant'&&c.replyTo===question.id),false);
    f.setFailure(s=>s.chats.some(c=>c.role==='assistant'&&c.replyTo===question.id));
    await assert.rejects(restored.engine.retryQuestion(question.id),/STORAGE FAILURE/);assert.equal(f.calls(),calls);assert.equal(JSON.stringify(restored.engine.state.usage),usage);assert.equal(restored.engine.state.queryCheckpoints!.find(c=>c.questionId===question.id)!.status,'ready');readyBackup=await restored.backup();
    f.setFailure(()=>false);await restored.engine.retryQuestion(question.id);assert.equal(f.calls(),calls);assert.equal(JSON.stringify(restored.engine.state.usage),usage);
    const answered=restored.engine.state;assert.equal(answered.chats.find(c=>c.id===question.id)!.delivery,'answered');assert.equal(answered.chats.filter(c=>c.replyTo===question.id&&c.role==='assistant').length,1);assert.equal(answered.memories.filter(m=>m.text.includes('ENGINE MOCK接续观点')).length,1);assert.equal(answered.queryCheckpoints!.find(c=>c.questionId===question.id)!.status,'consumed');assert.equal(answered.queryCheckpoints!.find(c=>c.questionId===question.id)!.material,undefined);
    await restored.engine.replaceFromBackup(acquiredBackup);assert.equal(restored.engine.state.chats.find(c=>c.id===question.id)!.delivery,'answered');assert.equal(restored.engine.state.chats.filter(c=>c.replyTo===question.id).length,1);assert.equal(restored.engine.state.memories.filter(m=>m.text.includes('ENGINE MOCK接续观点')).length,1);await assert.rejects(restored.engine.retryQuestion(question.id));assert.equal(f.calls(),calls);
    const forgottenBackup=structuredClone(restored.engine.state),sourceId=forgottenBackup.memories.find(m=>m.kind==='state')!.id;forgetMemory(forgottenBackup,sourceId);await restored.engine.replaceFromBackup(JSON.stringify(forgottenBackup));assert.equal(restored.engine.state.memories.find(m=>m.id===sourceId)!.forgotten,true);assert.equal(restored.engine.state.chats.find(c=>c.replyTo===question.id)!.excluded,true);assert.equal((await restored.queryMaterials(f.id,'保管')).chats.some(c=>c.replyTo===question.id),false);
    await restored.engine.editState(s=>deleteChat(s,question.id));validateQueryCheckpoints(restored.engine.state);await restored.engine.replaceFromBackup(acquiredBackup);assert.equal(restored.engine.state.chats.find(c=>c.id===question.id)!.delivery,'answered');await assert.rejects(restored.engine.retryQuestion(question.id));assert.equal(f.calls(),calls);

    // Same unpublished answer cannot acquire new support after an actual source change.
    for(const change of ['correction','forget','permission','source-chat','question-delete'] as const){
      const copy=await AnalysisCore.fromBackup(readyBackup,f.store,f.model,{agent:f.runtime});
      try{
        const s=copy.engine.state,cp=s.queryCheckpoints!.find(c=>c.questionId===question.id)!,source=cp.material!.memoryIds.find(id=>s.memories.find(m=>m.id===id)?.kind==='state')!;
        if(change==='correction')await copy.correctMemory(source,'ENGINE MOCK：实际来源已经更正。');
        else if(change==='forget')await copy.engine.editState(s=>forgetMemory(s,source));
        else if(change==='permission')await copy.engine.editState(s=>{s.books.find(b=>b.id===f.id)!.known=[s.books.find(b=>b.id===f.id)!.chapters[1]];});
        else if(change==='question-delete')await copy.engine.editState(s=>deleteChat(s,question.id));
        else { // A real source exchange is removed without leaving a dangling backup checkpoint.
          const src=s.chats.find(c=>cp.material!.chatIds.includes(c.id));assert.ok(src);await copy.engine.editState(s=>deleteChat(s,src.id));
        }
        await assert.rejects(copy.engine.retryQuestion(question.id));assert.equal(f.calls(),calls);assert.equal(s.chats.some(c=>c.role==='assistant'&&c.replyTo===question.id),false);
        if(change==='forget')assert.equal(cp.material,undefined);if(change==='question-delete')validateQueryCheckpoints(s);
      }finally{copy.engine.stop();}
    }
  }finally{f.setFailure(()=>false);restored?.engine.stop();await f.close();}
});

test('ENGINE MOCK目录缓存不授更新权，派发前来源变化和未知结果停住，skip/grant不持久缓存',async()=>{
  let phase='seed',indexStep=0,illegalStep=0;
  const directory=await fixture(body=>{
    if(phase==='seed')return response(['submit_reading',{stageNarrative:{text:'ENGINE MOCK目录工程。',sourceIds:['p1']},arcUpdates:Array.from({length:6},(_,i)=>({label:'ENGINE MOCK目录线'+i,operations:[{op:'add',role:'condition',text:'ENGINE MOCK完整目录条件。'+'条件正文完整保留。'.repeat(120),sourceIds:['p1']}]}))}]);
    if(phase==='index'){if(indexStep++===0)return response(['recall_memory',{kind:'arc',view:'index'}]);throw new ModelRequestError('ENGINE MOCK目录取得后中断','not-dispatched');}
    const p=packets(body).find(p=>p.analysisIndex),entry=p.analysisIndex.items.find((m:any)=>m.kind==='arc');assert.ok(entry);
    if(illegalStep++===0)return response(['submit_reading',{reply:'ENGINE MOCK尝试未获全文的更新。',arcUpdates:[{arcChangeOf:entry.id,operations:[{op:'add',role:'progress',text:'ENGINE MOCK不应保存的目录更新。',sourceIds:['p1']}]}]}]);
    assert.ok(body.messages.some((m:any)=>m.role==='tool'&&m.content.includes('完整')));throw Error('ENGINE MOCK目录未授更新权');
  });
  let resumed:AnalysisCore|undefined;
  try{
    await directory.core.configure(directory.id,{arcCandidate:'v1'});await directory.core.analyze(directory.id,[directory.first]);phase='index';await assert.rejects(directory.core.query(directory.id,'ENGINE MOCK目录条件。'),/目录取得后中断/);const question=directory.state.chats.find(c=>c.role==='user')!,count=directory.state.memories.length,backup=await directory.core.backup();assert.ok(directory.state.queryCheckpoints![0].acquired.some(a=>a.kind==='memory'&&a.view==='index'));
    resumed=await AnalysisCore.fromBackup(backup,directory.store,directory.model,{agent:directory.runtime});await resumed.engine.editState(s=>{s.settings.services[0].enabled=true;});await resumed.engine.setReadingMode(directory.id,'stages');phase='illegal';await assert.rejects(resumed.engine.retryQuestion(question.id),ModelRequestError);assert.equal(resumed.engine.state.memories.length,count);assert.equal(resumed.engine.state.memories.some(m=>m.text.includes('不应保存的目录更新')),false);
  }finally{resumed?.engine.stop();await directory.close();}

  let seed=true,armed=false;
  const dispatch=await fixture(()=>seed?response(['submit_reading',{stageNarrative:{text:'ENGINE MOCK派发窗口来源。',sourceIds:['p1']}}]):response(['submit_reading',{reply:'ENGINE MOCK不应派发。'}]));
  try{
    await dispatch.core.analyze(dispatch.id,[dispatch.first]);seed=false;const source=dispatch.state.memories.find(m=>m.kind==='stage')!,calls=dispatch.calls();armed=true;dispatch.setFailure(s=>{if(armed&&s.usage.at(-1)?.questionId&&s.usage.at(-1)?.status==='reserved'){armed=false;correctMemory(dispatch.state,source.id,'ENGINE MOCK保存预留期间来源改变。');}return false;});await assert.rejects(dispatch.core.query(dispatch.id,'ENGINE MOCK派发前核对。',{memoryAllowed:false}),/来源已变化/);assert.equal(dispatch.calls(),calls);assert.equal(dispatch.state.queryCheckpoints![0].status,'acquired');
  }finally{dispatch.setFailure(()=>false);await dispatch.close();}

  const unknown=await fixture(()=>{throw Error('ENGINE MOCK渠道结果未知');},false);
  try{
    await assert.rejects(unknown.core.query(unknown.id,'ENGINE MOCK渠道结果未知的原问。',{memoryAllowed:false}),/结果或结算尚未确定/);const q=unknown.state.chats.find(c=>c.role==='user')!;
    const ledger=JSON.stringify(unknown.state.usage),calls=unknown.calls();await assert.rejects(unknown.engine.retryQuestion(q.id),/结果或结算尚未确定/);assert.equal(unknown.calls(),calls);assert.equal(JSON.stringify(unknown.state.usage),ledger);assert.ok(unknown.state.usage.every(u=>u.status==='unknown'));
  }finally{await unknown.close();}

  let mode='skip',grantStep=0,future:{start:number;end:number};
  const temporary=await fixture(()=>mode==='grant'&&grantStep++===0?response(['read_original',future]):response(['submit_reading',{reply:'ENGINE MOCK仅在本次问答使用。',thoughts:[]}]));
  try{
    await temporary.core.query(temporary.id,'本次不要保存新的理解。');assert.equal(temporary.state.queryCheckpoints?.length??0,0);mode='grant';future={start:temporary.book.chapters[2].start,end:temporary.book.chapters[2].end};await temporary.engine.askWithFuture(temporary.id,'ENGINE MOCK临时查看这一段。',future);assert.equal(temporary.state.queryCheckpoints?.length??0,0);const raw=await temporary.core.backup(),copy=await AnalysisCore.fromBackup(raw,temporary.store,temporary.model,{agent:temporary.runtime});
    try{assert.equal(copy.engine.book(temporary.id).known.some(r=>r.start<=future.start&&r.end>=future.end),false);assert.equal((await copy.queryMaterials(temporary.id,'保管')).chats.some(c=>c.futureGrant),false);}finally{copy.engine.stop();}
  }finally{await temporary.close();}
});

test('ENGINE MOCK派发/返回窗口源状态冻结，JSON实际新p、补充阶段和待提交习惯保持原语义',async()=>{
  let phase='seed',f:Awaited<ReturnType<typeof fixture>>,mutate=false;
  f=await fixture(async body=>{
    if(phase==='seed')return response(['submit_reading',{stageNarrative:{text:'ENGINE MOCK窗口来源。',sourceIds:['p1']}}]);
    if(mutate){mutate=false;await f.core.correctMemory(f.state.memories.find(m=>m.kind==='stage')!.id,'ENGINE MOCK窗口来源已更正。');}
    return response(['submit_reading',{reply:'ENGINE MOCK旧来源答复。',thoughts:[]}]);
  });
  try{
    await f.core.analyze(f.id,[f.first]);phase='window';mutate=true;await assert.rejects(f.core.query(f.id,'ENGINE MOCK等待期间更正来源。',{memoryAllowed:false}));
    const q=f.state.chats.find(c=>c.role==='user')!,cp=f.state.queryCheckpoints![0],calls=f.calls();assert.equal(cp.status,'received');assert.equal(queryResultUsable(f.state,cp),false);await assert.rejects(f.engine.retryQuestion(q.id));assert.equal(f.calls(),calls);
  }finally{await f.close();}

  let jsonStep=0,jsonFirst:{start:number;end:number};
  const json=await fixture(body=>{
    if(jsonStep++===0)return{status:200,body:{choices:[{finish_reason:'stop',message:{content:JSON.stringify({read:jsonFirst,reply:'',thoughts:[]})}}],usage:{prompt_tokens:11,completion_tokens:7}}};
    const p=packets(body).flatMap(p=>p.toolResults??[]).find((r:any)=>r.source==='获准原文');assert.ok(p.text.includes('原问证据明文'));const id=p.text.match(/【(p\d+)】/)[1];return{status:200,body:{choices:[{finish_reason:'stop',message:{content:JSON.stringify({reply:'ENGINE MOCK JSON有据答复。',sourceIds:[id],thoughts:[]})}}],usage:{prompt_tokens:11,completion_tokens:7}}};
  },false);
  try{jsonFirst=json.first;await json.core.query(json.id,'ENGINE MOCK JSON回查原文。',{memoryAllowed:false});assert.equal(json.state.chats.find(c=>c.role==='user')!.delivery,'answered');assert.equal(json.state.queryCheckpoints![0].limits!.main,4);}finally{await json.close();}

  let repairStep=0;
  const repair=await fixture(body=>{const tools=body.tools.map((t:any)=>t.function.name);if(tools.length>1)return response(['submit_reading',{reply:'ENGINE MOCK已记住。',thoughts:[]}]);if(repairStep++===0)throw new ModelRequestError('ENGINE MOCK补充阶段未派发中断','not-dispatched');return response(['submit_reading',{reply:'ENGINE MOCK工程观点已保存。',thoughts:[{kind:'opinion',text:'ENGINE MOCK补充后的工程观点。',sourceIds:['p1'],basis:{memoryIds:[],chatIds:[]}}]}]);});
  try{
    repair.setFailure(s=>s.queryCheckpoints?.[0]?.status==='received');await assert.rejects(repair.core.query(repair.id,'请记住这条工程观点。'),/已接住|STORAGE FAILURE/);repair.setFailure(()=>false);const q=repair.state.chats.find(c=>c.role==='user')!,calls=repair.calls();await assert.rejects(repair.engine.retryQuestion(q.id),/未派发中断/);await repair.engine.retryQuestion(q.id);assert.equal(repair.calls(),calls+2);assert.equal(repair.state.memories.filter(m=>m.text==='ENGINE MOCK补充后的工程观点。').length,1);assert.equal(repair.state.usage.filter(u=>u.questionId===q.id&&u.queryPhase==='main').length,1);assert.equal(repair.state.usage.filter(u=>u.questionId===q.id&&u.queryPhase==='receipt-repair').length,2);
  }finally{repair.setFailure(()=>false);await repair.close();}

  const habit=await fixture(()=>response(['submit_reading',{reply:'ENGINE MOCK以后按约定详细回答。',thoughts:[]}])) ;
  try{
    habit.setFailure(s=>s.queryCheckpoints?.[0]?.status==='received');await assert.rejects(habit.core.query(habit.id,'以后回答详细一些。'),/已接住|STORAGE FAILURE/);const plan=habit.state.queryCheckpoints![0].material!.pendingHabits!,calls=habit.calls();assert.equal(habit.state.habits?.length??0,0);const savedId=plan.added[0].id,backup=await habit.core.backup();habit.setFailure(()=>false);const resumed=await AnalysisCore.fromBackup(backup,habit.store,habit.model,{agent:habit.runtime});
    try{await resumed.engine.retryQuestion(resumed.engine.state.chats.find(c=>c.role==='user')!.id);assert.equal(habit.calls(),calls);assert.equal(resumed.engine.state.habits!.length,1);assert.equal(resumed.engine.state.habits![0].id,savedId);}finally{resumed.engine.stop();}
  }finally{habit.setFailure(()=>false);await habit.close();}
});
