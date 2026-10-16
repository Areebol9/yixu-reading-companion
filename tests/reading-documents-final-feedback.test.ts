import test from 'node:test';
import assert from 'node:assert/strict';
import {HarnessRuntime} from '../src/agent/runtime.ts';
import {readingDocumentsPayload,readingDocumentsTool,readingTextPayload,readingTextTool} from '../src/core/reading-output.ts';
import {ModelRequestError} from '../src/core/errors.ts';
import type {AgentRunRequest} from '../src/core/agent-port.ts';
import type {AgentModelReply,ModelMessage,ReadingReply} from '../src/core/types.ts';

const valid={documents:[{operation:'create',text:'ENGINE MOCK 已授权记录保持。'}],working:['t1']},invalid={...valid,reply:''};
function stop(content:string):AgentModelReply{return {content,reasoning:'ENGINE MOCK PRIVATE STEP',toolCalls:[],finish:'stop',input:13,output:8,estimated:false,elapsedMs:0};}
function input(request:(messages:ModelMessage[],turn:number)=>Promise<AgentModelReply>|AgentModelReply,textExit=false){
  const controller=new AbortController(),calls:ModelMessage[][]=[],runtime=new HarnessRuntime();let parses=0;
  const task:AgentRunRequest<ReadingReply|string>={service:{id:'fixture',name:'工程反馈',model:'fixture',baseUrl:'https://fixture.invalid',contextLimit:32000,maxOutput:512,effort:'high',enabled:true,secretRef:'',fallback:false},messages:[{role:'user',content:'ENGINE MOCK 已完整给入材料。'}],tools:[],maxCalls:6,signal:controller.signal,assertCurrent(){},acceptJsonFinal:true,submit:{name:'submit_fixture',description:'工程提交',parameters:{type:'object'},parse(){throw Error('UNEXPECTED SUBMIT');}},readingExit:{...(textExit?readingTextTool:readingDocumentsTool),allowProposal:false,parse(args){parses++;return textExit?readingTextPayload(args):readingDocumentsPayload(args);}},parseTextFinal(){throw Error('ENGINE MOCK 非法最终正文');},async request(messages){calls.push(structuredClone(messages));return request(messages,calls.length);}};
  return {runtime,task,calls,controller,get parses(){return parses;},async close(){await runtime.dispose();}};
}

test('多文档最终JSON参数反馈沿原历史恢复，两次后合法解析且不重读',async()=>{
  const raw=JSON.stringify(invalid),f=input((messages,turn)=>{
    if(turn===1)return stop(raw);
    assert.equal(messages.filter(m=>m.role==='assistant'&&m.content===raw).length,1);
    assert.ok(messages.some(m=>m.role==='user'&&m.content.includes('顶层字段不允许：reply')));
    assert.equal(messages.filter(m=>m.content==='ENGINE MOCK 已完整给入材料。').length,1);
    return stop(JSON.stringify(valid));
  });
  try{assert.deepEqual(await f.runtime.run(f.task),readingDocumentsPayload(valid));assert.equal(f.calls.length,2);assert.equal(f.parses,1);assert.ok(f.calls[1].some(m=>m.reasoning_content==='ENGINE MOCK PRIVATE STEP'));}finally{await f.close();}
});

test('反复多文档形状拒绝仅用原六次，不派第七次也不接受旧原包',async()=>{
  const f=input(()=>stop(JSON.stringify(invalid)));
  try{await assert.rejects(f.runtime.run(f.task),/顶层字段不允许：reply/);assert.equal(f.calls.length,6);assert.equal(f.parses,1);assert.equal(f.calls[5].filter(m=>m.role==='assistant'&&m.content===JSON.stringify(invalid)).length,5);}finally{await f.close();}
});

test('旧text空对象与多文档坏JSON不进入参数续交',async()=>{
  for(const [raw,textExit] of [['{}',true],['{"documents":[',false]] as const){const f=input(()=>stop(raw),textExit);try{await assert.rejects(f.runtime.run(f.task));assert.equal(f.calls.length,1);}finally{await f.close();}}
});

test('形状合法后的领域异常、未知请求及取消保持停止路径',async()=>{
  const domain=input(()=>stop(JSON.stringify(valid)));domain.task.readingExit!.parse=()=>{throw Error('ENGINE MOCK DOMAIN STATE FAILURE');};
  try{await assert.rejects(domain.runtime.run(domain.task),/DOMAIN STATE FAILURE/);assert.equal(domain.calls.length,1);}finally{await domain.close();}
  const unknown=input(()=>{throw new ModelRequestError('ENGINE MOCK UNKNOWN','unknown');});
  try{await assert.rejects(unknown.runtime.run(unknown.task),/UNKNOWN/);assert.equal(unknown.calls.length,1);}finally{await unknown.close();}
  const cancelled=input(()=>{cancelled.controller.abort();return stop(JSON.stringify(invalid));});
  try{await assert.rejects(cancelled.runtime.run(cancelled.task));assert.equal(cancelled.calls.length,1);}finally{await cancelled.close();}
});
