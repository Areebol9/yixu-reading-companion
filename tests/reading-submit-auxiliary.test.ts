import test from 'node:test';
import assert from 'node:assert/strict';
import {readingSubmit} from '../src/core/reading-agent.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import {importBook} from '../src/core/books.ts';
import {evidence} from '../src/core/context.ts';
import {initialState} from '../src/core/state.ts';
import type {AgentRunner} from '../src/core/agent-port.ts';

test('辅助根出处必须核验，只删副本且不分配条目、basis或quote',()=>{
  const payload={reply:'保留原回应。',thoughts:[{kind:'opinion',text:'保留完整判断及条件。',basis:{memoryIds:[],chatIds:[]},sourceIds:['p2'],quoteSource:'p2'}],sourceIds:['p1','p2','p1'],quoteSource:'p1'},before=structuredClone(payload);
  let checked:readonly string[]=[];const parse=readingSubmit(()=>{},undefined,{validateAuxiliarySources:ids=>{checked=ids;assert.ok(ids.every(id=>['p1','p2'].includes(id)));}}).parse;
  const actual=parse(payload),expected=readingSubmit(()=>{}).parse({reply:payload.reply,thoughts:payload.thoughts});
  assert.deepEqual(checked,['p1','p2']);assert.deepEqual(actual,expected);assert.deepEqual(payload,before);assert.deepEqual(actual.thoughts[0].sourceIds,['p2']);assert.equal(actual.thoughts[0].quoteSource,'p2');
  const noOwnership=parse({reply:'同文。',thoughts:[{kind:'opinion',text:'只有判断，不分配辅助出处。'}],sourceIds:['p1'],quoteSource:'p1'});
  assert.equal(noOwnership.thoughts[0].sourceIds,undefined);assert.equal(noOwnership.thoughts[0].quoteSource,undefined);assert.equal(noOwnership.thoughts[0].basis,undefined);
});

test('缺核验/伪造或坏形状不旁路；关系错位与残缺JSON继续拒绝',()=>{
  const base={reply:'',thoughts:[]};assert.throws(()=>readingSubmit(()=>{}).parse({...base,sourceIds:['p1']}),/未提供辅助出处核验/);
  const submit=readingSubmit(()=>{},undefined,{validateAuxiliarySources:ids=>{if(ids.some(id=>id!=='p1'))throw Error('未在本轮实际提供');}});
  for(const sourceIds of ['p1',null,['m1'],Array(9).fill('p1')])assert.throws(()=>submit.parse({...base,sourceIds}),/辅助原文出处/);
  assert.throws(()=>submit.parse({...base,quoteSource:'p999'}),/实际提供/);
  for(const field of ['updates','answersPartOf','updateReason'])assert.throws(()=>submit.parse({...base,[field]:'m1'}),/顶层字段位置/);
  assert.throws(()=>submit.parse('{"reply":: '),/完整JSON对象/);assert.throws(()=>submit.parse({reply:false,thoughts:[]}),/完整字段/);
});

test('正式engine核验actual p后保持完整ctx evidence/parents，不把根quote当新记忆引文',async()=>{
  const state=initialState(),book=await importBook('辅助出处核心','第一章 登记\n'+ '设备已有记录，后续仍需复核。'.repeat(20));state.books=[book];book.known=[{start:0,end:book.text.length}];book.position=book.text.length;state.settings.services[0].enabled=true;
  state.memories=[{id:'old-view',bookId:book.id,partnerId:state.partnerId,kind:'opinion',text:'原有完整判断。',evidence:[evidence(book,{start:0,end:20})],parents:[],chatIds:[],createdAt:1,forgotten:false,source:'reading'}];
  let calls=0;const engine=new ReadingEngine(state,{async save(){}},{async complete(){throw Error('不调用API');},async completeTools(){throw Error('不调用API');}});
  const agent:AgentRunner={async run(input){calls++;return input.submit.parse({reply:'',thoughts:[{kind:'opinion',text:'保留全轮证据与原判断依赖。'}],sourceIds:['p1'],quoteSource:'p1'});}};engine.agent=agent;
  try{await engine.startReading(book.id);await engine.prepare(book.id);assert.equal(calls,1);const added=state.memories.find(m=>m.id!=='old-view')!;
    assert.deepEqual(added.evidence,[evidence(book,{start:0,end:book.text.length})]);assert.ok(added.parents.includes('old-view'));assert.equal(added.basis,undefined);assert.equal(added.sourceEvidence,undefined);assert.equal(added.sourceQuote,undefined);assert.equal(state.usage.length,0);
  }finally{engine.stop();}
});

test('正式engine未提供p或提交前撤回来源权限不保存认识/处理覆盖',async()=>{
  for(const revoke of [false,true]){const state=initialState(),book=await importBook('来源失败工程','第一章 登记\n设备已经登记。');state.books=[book];book.known=[{start:0,end:book.text.length}];book.position=book.text.length;state.settings.services[0].enabled=true;
    const engine=new ReadingEngine(state,{async save(){}},{async complete(){throw Error('不调用API');},async completeTools(){throw Error('不调用API');}});
    engine.agent={async run(input){if(revoke)book.known=[];return input.submit.parse({reply:'',thoughts:[{kind:'story',text:'设备已经登记。'}],quoteSource:revoke?'p1':'p999'});}};
    try{await engine.startReading(book.id);await assert.rejects(engine.prepare(book.id),/辅助原文出处未在本轮实际提供或已不可用/);assert.deepEqual(book.prepared,[]);assert.deepEqual(state.memories,[]);assert.equal(state.readingDrafts?.length??0,0);assert.equal(state.usage.length,0);}finally{engine.stop();}
  }
});
