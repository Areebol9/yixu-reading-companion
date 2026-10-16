import {ModelRequestError} from '../src/core/errors.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {AnalysisCore} from '../src/core/analysis-core.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import {ChatModel} from '../src/core/model.ts';
import {HarnessRuntime} from '../src/agent/runtime.ts';
import {arcWritingPolicy,worldWritingPolicy} from '../src/core/reading-policy.ts';
import {initialState} from '../src/core/state.ts';
import {readingSubmit} from '../src/core/reading-agent.ts';
import type {Store} from '../src/core/types.ts';

const submit=(args:unknown)=>({status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:'engine-query-submit',type:'function',function:{name:'submit_reading',arguments:JSON.stringify(args)}}]}}],usage:{prompt_tokens:0,completion_tokens:0}}});
const tool=(name:string,args:unknown)=>({status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:'engine-query-read',type:'function',function:{name,arguments:JSON.stringify(args)}}]}}],usage:{prompt_tokens:0,completion_tokens:0}}});
const packet=(body:any)=>JSON.parse(body.messages.find((m:any)=>m.role==='user'&&m.content.startsWith('{')).content.split('\n\n')[0]);
const task=(body:any)=>body.messages.filter((m:any)=>m.role==='user').flatMap((m:any)=>m.content.split('\n\n').map((part:string)=>{try{return JSON.parse(part);}catch{return{};}})).find((p:any)=>p.task==='conversation');
const empty={memoryIds:[],chatIds:[]};

test('ENGINE MOCK独立只答：完整回查、真实聊天保存、原题权限接续、违规拒绝及默认观点路径',async()=>{
  const state=initialState();state.settings.services[0].enabled=true;state.settings.tokenLimit=2_000_000;let disk=structuredClone(state),phase='seed',readStep=0,autoCalls=0,calls=0,first:{start:number;end:number},illegal:any,illegalStep=0;
  const store:Store={async load(){return structuredClone(disk);},async save(s){disk=structuredClone(s);}};
  const bodies:any[]=[],model=new ChatModel(async request=>{
    calls++;const body=request.body;bodies.push(structuredClone(body));assert.equal(JSON.stringify(body).includes('UNREAD-QUERY-OPTIONS'),false);
    const system=body.messages.find((m:any)=>m.role==='system')!.content,p=packet(body),schema=body.tools.find((t:any)=>t.function.name==='submit_reading').function.parameters.properties;
    if(phase==='seed'){
      assert.equal(system.split(arcWritingPolicy).length-1,1);assert.equal(system.split(worldWritingPolicy).length-1,1);
      return submit({stageNarrative:{text:'ENGINE MOCK：早期登记过程。',sourceIds:['p1'],basis:empty},entityRoots:[{key:'new1',memoryId:'t1'}],thoughts:[{kind:'story',text:'ENGINE MOCK：登记人名为林甲。',identityClaim:{type:'name',entityId:'new1',name:'林甲',cognition:'observed'},sourceIds:['p1'],basis:empty}],stateUpdates:[{topic:'工程验收',basis:empty,operations:[{op:'add',text:'ENGINE MOCK：完整验收后才能解除保管，每月交材料。',sourceIds:['p1']}]}],arcUpdates:[{label:'工程保管线',basis:empty,operations:[{op:'add',role:'condition',text:'ENGINE MOCK：验收和每月交材料保持。',sourceIds:['p1']}]}]});
    }
    if(phase==='default'||phase==='old-skip'){
      assert.ok(schema.thoughts.items);assert.equal(system.split(arcWritingPolicy).length-1,1);assert.equal(system.split(worldWritingPolicy).length-1,1);
      return submit({reply:'ENGINE MOCK普通观点回应。',thoughts:[{kind:'opinion',text:'ENGINE MOCK默认观点：条件需要完整保留。',sourceIds:['p1'],basis:empty}]});
    }
    assert.equal(schema.thoughts.maxItems,0);assert.equal(schema.reinforce.maxItems,0);
    for(const key of ['readingBrief','stageNarrative','stateUpdates','arcUpdates','entityRoots'])assert.equal(key in schema,false);
    assert.equal(system.includes(arcWritingPolicy),false);assert.equal(system.includes(worldWritingPolicy),false);assert.ok(system.includes('伙伴特点：'));
    const t=task(body);assert.equal(t.memoryAllowed,false);
    if(phase==='illegal'){
      if(illegalStep++===0)return submit({reply:'ENGINE MOCK违规写入',...illegal});
      assert.ok(body.messages.some((m:any)=>m.role==='tool'&&m.content.includes('只保存问答')));throw Error('ENGINE MOCK违规已拒绝，停止该模拟');
    }
    if(phase==='read'){
      assert.equal(t.longReplyAuthorized,true);assert.ok(schema.reply.maxLength>180);
      const recall=body.tools.find((t:any)=>t.function.name==='recall_memory').function.parameters.properties;
      assert.ok(recall.kind.enum.includes('arc'));assert.ok(recall.entityIds);assert.ok(p.entityIndex.items.length);assert.ok(p.analysisMaterials.some((m:any)=>m.kind==='arc'));
      if(readStep++===0){assert.equal(p.current.includes('早期警告'),false);return tool('read_original',{start:first.start,end:Math.min(first.end,first.start+180)});}
      assert.ok(body.messages.some((m:any)=>m.role==='tool'&&m.content.includes('早期警告')));
      const arc=p.analysisMaterials.find((m:any)=>m.kind==='arc');
      return submit({reply:'ENGINE MOCK多条件完整回应。'.repeat(20),replyBasis:{memoryIds:[arc.id],chatIds:[]},sourceIds:['p1'],thoughts:[],reinforce:[]});
    }
    if(phase==='interrupted')throw new ModelRequestError('ENGINE MOCK问题中断，尚未派发','not-dispatched');
    if(phase==='auto'){
      assert.equal(p.narrativeMode,'stages','自动恢复沿原资料方式');
      if(autoCalls++===0)throw new ModelRequestError('服务暂不可达，尚未派发','not-dispatched',{retryable:true});
      return submit({reply:'ENGINE MOCK自动接续。'});
    }
    if(phase==='retry'||phase==='expand')return submit({reply:'ENGINE MOCK原题/展开只答接续。'});
    throw Error('ENGINE MOCK未知阶段');
  });
  const harness=new HarnessRuntime(),engine=new ReadingEngine(state,store,model);engine.agent=harness;const core=new AnalysisCore(engine);
  try{
    const text='第一章 早期登记\nENGINE MOCK：登记人林甲。早期警告：完整验收后才解除保管，每月交材料。\n'+'工程背景登记记录。'.repeat(2500)+'\n第二章 当前\nENGINE MOCK：目前运输延期，验收条件尚未解除。\n第三章 未读\nUNREAD-QUERY-OPTIONS';
    const id=await core.importText('ENGINE MOCK只答工程',text),book=engine.book(id);first={start:book.chapters[0].start,end:book.chapters[0].end};
    await core.grant(id,[first]);await core.configure(id,{arcCandidate:'v1',worldCandidate:'v1'});await core.analyze(id,[{start:first.start,end:first.start+200}]);await core.grant(id,[{start:book.chapters[1].start,end:book.chapters[1].end}]);
    const memories=JSON.stringify(state.memories),habits=JSON.stringify(state.habits??[]);
    phase='read';await core.query(id,'以后不要一直追问我。请完整说明早期保管条件和运输延期的关系。',{memoryAllowed:false,long:true});
    const question=state.chats.find(c=>c.role==='user')!,answer=state.chats.find(c=>c.replyTo===question.id)!;
    assert.equal(question.memoryAllowed,false);assert.equal(question.longReply,true);assert.equal(question.excluded,false);assert.equal(question.delivery,'answered');assert.equal(answer.excluded,false);assert.ok(answer.text.length>180);assert.ok(answer.basis?.memoryIds.length);assert.ok(answer.evidence.some(e=>e.start<=first.start&&e.end>=first.start+100));
    assert.equal(JSON.stringify(state.memories),memories);assert.equal(JSON.stringify(state.habits??[]),habits);
    const history=await core.queryMaterials(id,'早期保管');assert.ok(history.chats.some(c=>c.id===question.id));assert.ok(history.chats.some(c=>c.id===answer.id));
    phase='interrupted';await assert.rejects(core.query(id,'ENGINE MOCK等待接续的同一问题。',{memoryAllowed:false,long:true}),/问题中断/);
    const pending=state.chats.filter(c=>c.role==='user').at(-1)!;assert.equal(pending.memoryAllowed,false);
    const restored=await AnalysisCore.fromBackup(await core.backup(),store,model,{agent:harness});
    try{
      await restored.engine.editState(s=>{s.settings.services[0].enabled=true;});await restored.engine.setReadingMode(id,'full-original');phase='retry';await restored.engine.retryQuestion(pending.id);
      const same=restored.engine.state.chats.find(c=>c.id===pending.id)!;assert.equal(same.memoryAllowed,false);assert.equal(same.longReply,true);assert.equal(same.responseProfile!.readingStrategy,'full-original','只冻结写权限，手动重答仍用当前资料方式');
      const reply=restored.engine.state.chats.find(c=>c.replyTo===pending.id)!;phase='expand';await restored.engine.expandReply(reply.id);const expanded=restored.engine.state.chats.filter(c=>c.role==='user').at(-1)!;assert.equal(expanded.memoryAllowed,false);assert.equal(expanded.longReply,true);
      assert.equal(JSON.stringify(restored.engine.state.memories),memories);assert.equal(JSON.stringify(restored.engine.state.habits??[]),habits);
    }finally{restored.engine.stop();}
    phase='auto';await assert.rejects(core.query(id,'ENGINE MOCK自动恢复的原问题。',{memoryAllowed:false}),/服务暂不可达/);await engine.setReadingMode(id,'full-original');await engine.retryPending();
    const auto=state.chats.filter(c=>c.role==='user').at(-1)!;assert.equal(auto.delivery,'answered');assert.equal(auto.memoryAllowed,false);assert.equal(auto.responseProfile!.readingStrategy,'structured');
    phase='default';await core.query(id,'ENGINE MOCK普通观点问题。');assert.ok(state.memories.some(m=>m.kind==='opinion'&&m.text.includes('默认观点')));
    const count=state.memories.length;phase='old-skip';await core.query(id,'本次不要保存新的理解。');assert.equal(state.memories.length,count,'旧skip仍强制不存，不因模型返回thoughts变新错误');
    phase='illegal';const assistants=state.chats.filter(c=>c.role==='assistant').length;
    for(const value of [{thoughts:[{kind:'opinion',text:'ENGINE MOCK非法新理解'}]},{arcUpdates:[]},{entityRoots:[]}]){illegal=value;illegalStep=0;await assert.rejects(core.query(id,'ENGINE MOCK违规只答。',{memoryAllowed:false}),ModelRequestError);assert.equal(state.memories.length,count);assert.equal(state.chats.filter(c=>c.role==='assistant').length,assistants);assert.equal(JSON.stringify(state.habits??[]),habits);}
    assert.ok(calls>0);

    const noWrite=readingSubmit(()=>{},undefined,{conversation:true,readOnly:true,arcCandidate:'v1',worldCandidate:'v1',narrativeMode:'stages'});
    for(const forbidden of [{thoughts:[{kind:'opinion',text:'ENGINE MOCK不允许'}]},{reinforce:['m1']},{arcUpdates:[]},{entityRoots:[]},{stageNarrative:{text:'ENGINE MOCK不允许'}},{stateUpdates:[]},{readingBrief:''}])assert.throws(()=>noWrite.parse({reply:'ENGINE MOCK',...forbidden}),/只保存问答/);
  }finally{engine.stop();await engine.persist();await harness.dispose();}

  // The actual JSON transport enforces the same rule before any commit.
  const jsonState=initialState();jsonState.settings.services[0].enabled=true;let forbidden:any={thoughts:[{kind:'opinion',text:'ENGINE MOCK非法写入'}]},diskState=structuredClone(jsonState);
  const jsonStore:Store={async load(){return structuredClone(diskState);},async save(s){diskState=structuredClone(s);}};
  const jsonEngine=new ReadingEngine(jsonState,jsonStore,{async complete(){return{content:JSON.stringify({reply:'ENGINE MOCK JSON',...forbidden}),input:0,output:0,estimated:false,elapsedMs:0};}}),jsonCore=new AnalysisCore(jsonEngine);
  try{
    const id=await jsonCore.importText('ENGINE MOCK JSON只答','第一章 工程\nENGINE MOCK获准材料。\n第二章 未读\nUNREAD-QUERY-OPTIONS'),book=jsonEngine.book(id);await jsonCore.grant(id,[{start:book.chapters[0].start,end:book.chapters[0].end}]);
    for(const value of [{thoughts:[{kind:'opinion',text:'ENGINE MOCK非法写入'}]},{arcUpdates:[]},{entityRoots:[]}]){
      forbidden=value;await assert.rejects(jsonCore.query(id,'ENGINE MOCK只答。',{memoryAllowed:false}),/只保存问答/);assert.equal(jsonState.memories.length,0);assert.equal(jsonState.chats.some(c=>c.role==='assistant'),false);assert.equal(jsonState.chats.filter(c=>c.role==='user').at(-1)!.delivery,'failed');
    }
    forbidden={sourceIds:['p999']};await assert.rejects(jsonCore.query(id,'ENGINE MOCK只答出处不能伪造。',{memoryAllowed:false}),/辅助原文出处/);assert.equal(jsonState.chats.some(c=>c.role==='assistant'),false);
  }finally{jsonEngine.stop();await jsonEngine.persist();}
});
