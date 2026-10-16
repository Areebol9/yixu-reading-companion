import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState} from '../src/core/state.ts';
import {importBook,covers} from '../src/core/books.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import {ChatModel,ModelOutputError} from '../src/core/model.ts';
import {HarnessRuntime} from '../src/agent/runtime.ts';
import {remainingMaintenanceJob} from '../src/core/maintenance-recovery.ts';
import {ModelRequestError} from '../src/core/errors.ts';
import {readingRequestPayloadHash} from '../src/core/terminated-reading-continuation.ts';
import {readingAgentTools,isCompanionRecallDescriptionUpgrade} from '../src/core/reading-agent.ts';
import type {State,AgentModelReply} from '../src/core/types.ts';

async function until(check:()=>boolean){const deadline=Date.now()+3000;while(!check()){assert.ok(Date.now()<deadline,'controlled owner did not finish');await new Promise(r=>setTimeout(r,2));}}
async function setup(){const state=initialState(),book=await importBook('工程链路','第一章 登记\n工程登记完成。');book.readingStrategy='companion';book.known=[{start:book.text.indexOf('\n')+1,end:book.text.length}];book.position=book.text.length;state.books=[book];state.settings.services[0].enabled=true;state.settings.services[0].maxOutput=4096;return{state,book};}
const response=():AgentModelReply=>({content:'',reasoning:'',finish:'tool_calls',input:20,output:10,estimated:false,elapsedMs:1,toolCalls:[{id:'valid',type:'function',function:{name:'finish_reading',arguments:JSON.stringify({documents:[],views:['overview','current'].map(kind=>({kind,key:kind,text:'登记已完成。',sourceMemoryIds:[],sourceIds:['p1']}))})}}]});

test('真实length载体和usage分项原样保留，不解析或执行截断工具；同Harness精确反馈后完成',async()=>{
 const {state,book}=await setup();let calls=0;const raw={role:'assistant',content:'',reasoning_content:'尚在核对',tool_calls:[{id:'truncated',type:'function',function:{name:'finish_reading',arguments:'{"documents":['}}]};
 const model=new ChatModel(async request=>{calls++;if(calls===1)return{status:200,body:{choices:[{finish_reason:'length',message:raw}],usage:{prompt_tokens:20,completion_tokens:4096,completion_tokens_details:{reasoning_tokens:4070}}}};
 const messages=request.body.messages as any[];assert.ok(messages.some(m=>m.content.includes('reading-output-length-repair:v1:')));assert.ok(messages.some(m=>m.content.includes('"reasoning_tokens":4070')));assert.ok(!messages.some(m=>m.role==='tool'&&m.tool_call_id==='truncated'));
 const r=response();return{status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:'',tool_calls:r.toolCalls}}],usage:{prompt_tokens:25,completion_tokens:10}}};});
 const h=new HarnessRuntime(),e=new ReadingEngine(state,{async load(){return state;},async save(){}},model);e.agent=h;await e.startReading(book.id);await(e as any).queueMaintenance(book.id,book.known);(e as any).scheduleMaintenance();try{await until(()=>!e.busy);assert.equal(calls,2);assert.equal(state.maintenanceJobs?.length,0);assert.ok(covers(book.prepared,book.known[0]));const failed=state.usage.find(u=>u.modelOutcome)!;assert.equal(failed.status,'complete');assert.equal(failed.output,4096);assert.deepEqual(failed.maintenanceDispatch!.material!.terminalResponse!.rawTerminal!.message,raw);assert.ok(state.usage.some(u=>u.maintenanceDispatch?.committed));}finally{e.stop();await h.dispose();}
});

test('同配置容量反馈后再次length保留阻断；自动与手动入口都不会无变化再发',async()=>{
 const {state,book}=await setup();let calls=0;const model=new ChatModel(async()=>{calls++;return{status:200,body:{choices:[{finish_reason:'length',message:{content:'',reasoning_content:'核对',tool_calls:[{id:'truncated',type:'function',function:{name:'finish_reading',arguments:'{'}}]}}],usage:{prompt_tokens:20,completion_tokens:4096}}};});
 const h=new HarnessRuntime(),e=new ReadingEngine(state,{async load(){return state;},async save(){}},model);e.agent=h;await e.startReading(book.id);await(e as any).queueMaintenance(book.id,book.known);(e as any).scheduleMaintenance();try{await until(()=>!e.busy&&!(e as any).maintenanceRecoveryFlight);assert.equal(calls,2);const job=state.maintenanceJobs![0];assert.equal(job.status,'blocked');await assert.rejects(e.resumeMaintenance(job.id),/实际容量故障/);(e as any).scheduleMaintenance();await until(()=>!(e as any).maintenanceRecoveryFlight);assert.equal(calls,2);assert.equal(state.books[0].prepared.length,0);assert.ok(state.usage.every(u=>u.status==='complete'));}finally{e.stop();await h.dispose();}
});

test('旧已结算length无partial仍沿原payload/claim接续，明示原截断未保存，不造assistant',async()=>{
 const {state,book}=await setup();let calls=0,original:any;
 const h=new HarnessRuntime(),e=new ReadingEngine(state,{async load(){return state;},async save(){}},{async complete(){throw Error('No external model');},async completeTools(_s,messages,tools){calls++;if(calls===1){original={messages:structuredClone(messages),tools:structuredClone(tools)};throw new ModelOutputError('模型输出达到长度上限，未执行不完整工具请求',{content:'',input:20,output:4096,estimated:false,elapsedMs:1});}assert.deepEqual(messages.slice(0,original.messages.length),original.messages);assert.ok(messages.some(m=>m.role==='user'&&m.content.includes('旧版本未保存截断响应')));assert.ok(!messages.slice(original.messages.length).some(m=>m.role==='assistant'));return response();}});e.agent=h;await e.startReading(book.id);await(e as any).queueMaintenance(book.id,book.known);(e as any).scheduleMaintenance();try{await until(()=>!e.busy&&!(e as any).maintenanceRecoveryFlight);assert.equal(calls,2);const usages=state.usage.filter(u=>u.maintenanceDispatch);assert.equal(usages.length,2);assert.equal(usages[0].maintenanceDispatch!.claim.hash,usages[1].maintenanceDispatch!.claim.hash);assert.ok(usages[1].maintenanceDispatch!.committed);}finally{e.stop();await h.dispose();}
});

test('只有同job真实提交消费责任，范围相交或prepared本身不会抹掉unknown工作',async()=>{
 const {state,book}=await setup();const job:any={id:'original-job',bookId:book.id,version:book.version,partnerId:state.partnerId,status:'blocked',createdAt:1,ranges:[...book.known],chatIds:[],viewTargets:[],pendingDispatch:{usageId:'unknown'}};
 const d:any={claim:{hash:'a'.repeat(64),ranges:[...book.known],chatIds:[],viewTargets:[]},request:{maintenanceJobId:job.id}};
 const unknown:any={id:'unknown',status:'unknown',requestKey:JSON.stringify([book.id,book.version,state.partnerId,'reading',book.known,'maintenance',job.id,'a'.repeat(64)]),maintenanceDispatch:d};state.usage=[unknown];book.prepared=[...book.known];const bytes=JSON.stringify(unknown);assert.equal(remainingMaintenanceJob(state,job),job);
 state.usage.push({...unknown,id:'other-owner',maintenanceDispatch:{...d,request:{maintenanceJobId:'other-job'},committed:{}}});assert.equal(remainingMaintenanceJob(state,job),job);
 state.usage.push({...unknown,id:'real-successor',status:'complete',maintenanceDispatch:{...d,committed:{}}});assert.equal(remainingMaintenanceJob(state,job),undefined);assert.equal(JSON.stringify(unknown),bytes);
});

test('原恢复按钮收到宿主退出审计后转原Harness；unknown结算字节不变，真实后继提交退出工作',async()=>{
 const {state,book}=await setup();let calls=0,payload:any;const h=new HarnessRuntime(),e=new ReadingEngine(state,{async load(){return state;},async save(){}},{async complete(){throw Error('No external model');},async completeTools(_s,messages,tools){calls++;if(calls===1){payload={messages:structuredClone(messages),tools:structuredClone(tools)};throw new ModelRequestError('Controlled local fetch exited','unknown');}assert.deepEqual(messages.slice(0,payload.messages.length),payload.messages);return response();},async readQueryReceipt(requestId){return{requestId,inputHash:await readingRequestPayloadHash(payload.messages,payload.tools),termination:{serviceId:state.settings.serviceId,hostPayloadHash:'f'.repeat(64),terminationEvidence:'Controlled original local fetch finally exited after dispatch; fees unknown',payloadEvidence:'Controlled original host wire hash and core hash verified'}};}});e.agent=h;await e.startReading(book.id);await(e as any).queueMaintenance(book.id,book.known);(e as any).scheduleMaintenance();try{await until(()=>!e.busy);const old=state.usage[0],original=JSON.stringify(old),job=state.maintenanceJobs![0];await e.resumeMaintenance(job.id);assert.equal(calls,2);assert.equal(old.status,'unknown');assert.equal(JSON.stringify(old),original);assert.equal(state.maintenanceJobs?.length,0);assert.ok(state.usage.some(u=>u.maintenanceDispatch?.committed&&u.terminatedReadingContinuation?.unknownUsageId===old.id));assert.ok(!e.activities.some(a=>a.requestId===old.id));}finally{e.stop();await h.dispose();}
});

test('旧recall_memory仅确切说明变更可续交，参数/权限/其它说明变化均拒绝',()=>{
 const tool=readingAgentTools(async()=>({}),{search:false,page:false},{readingStrategy:'companion'}).find(t=>t.name==='recall_memory')!,current={name:tool.name,description:tool.description,parameters:tool.parameters};
 const oldPrefix='伴读的阶段性完整看法以普通opinion保存；先用kind=opinion或不指定kind查询，view=index取得导航，再按返回ids配view=full读取完整正文。index不授来源、身份绑定或更新权。stage/state/arc仍可查询已真实保存的对应旧结构资料，不能把stage当作opinion的别名。';
 const suffix='普通现场已有依据便直接完成表达、段评或安静终态；有具体缺口才继续必要取材，不为走目录流程增加往返。',start=current.description.indexOf('回想当前作品、当前伙伴的获准资料。');assert.ok(start>0);const previous={...structuredClone(current),description:oldPrefix+current.description.slice(start,-suffix.length)},original=JSON.stringify(previous);
 assert.ok(isCompanionRecallDescriptionUpgrade(previous,current));assert.equal(JSON.stringify(previous),original);
 assert.equal(isCompanionRecallDescriptionUpgrade({...previous,description:previous.description+'其它许可'},current),false);
 assert.equal(isCompanionRecallDescriptionUpgrade(previous,{...current,description:current.description+'其它说明'}),false);
 assert.equal(isCompanionRecallDescriptionUpgrade({...previous,parameters:{...previous.parameters,additionalProperties:true}},current),false);
 assert.equal(isCompanionRecallDescriptionUpgrade({...previous,name:'read_original'},current),false);
});
