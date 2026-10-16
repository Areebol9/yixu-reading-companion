import test from 'node:test';
import assert from 'node:assert/strict';
import {importBook} from '../src/core/books.ts';
import {initialState} from '../src/core/state.ts';
import {evidence} from '../src/core/context.ts';
import {bindWorldPlan,MissingWorldIdentityBindingsError,worldIdentityRecovery} from '../src/core/world-identity.ts';
import {ReadingReferences} from '../src/core/reading-references.ts';
import {selectAnalysisMaterials} from '../src/core/analysis-materials.ts';
import {searchMemories} from '../src/core/recall.ts';
import {readingAgentTools} from '../src/core/reading-agent.ts';
import type {Memory} from '../src/core/types.ts';

async function fixture(){
  const state=initialState(),book=await importBook('身份恢复工程','第一章\n甲员与乙员已登记姓名。甲员继续核对资料。');book.known=[{start:0,end:book.text.length}];state.books=[book];
  const e=evidence(book,book.known[0]),base={bookId:book.id,partnerId:state.partnerId,kind:'story' as const,evidence:[e],sourceEvidence:[e],parents:[],chatIds:[],createdAt:1,forgotten:false,source:'preparation' as const};
  const names:Memory[]=['甲员','乙员'].map((name,i)=>({...structuredClone(base),id:'name-'+i,text:name+'已登记，姓名来自原始登记。',identityClaim:{entityId:'entity-'+i,type:'name',name,cognition:'observed'},entityBindings:[{entityId:'entity-'+i,memoryId:'name-'+i}]}));
  state.memories=names;state.entityRoots=names.map(m=>({id:m.identityClaim!.entityId,bookId:book.id,version:book.version,partnerId:state.partnerId,source:'reading',originMemoryId:m.id}));
  const added:Memory={...structuredClone(base),id:'new-fact',text:'甲员与乙员继续核对资料。',about:names.map(m=>({entityId:m.identityClaim!.entityId}))};
  return {state,book,e,names,added};
}
test('姓名缺失一次收齐，恢复建议仅使用已曝光编号且实际回查后可绑定原提交',async()=>{
  const {state,book,e,names,added}=await fixture(),refs=new ReadingReferences();
  refs.messages([{role:'user',content:JSON.stringify({entityIndex:{items:names.map(m=>({id:m.identityClaim!.entityId,names:[{name:m.identityClaim!.name,memoryId:m.id}],claimIds:[m.id]}))}})}]);
  let missing:MissingWorldIdentityBindingsError|undefined;
  try{bindWorldPlan(state,book,[added],new Map(),[],[],[e],'preparation');}catch(error){assert.ok(error instanceof MissingWorldIdentityBindingsError);missing=error;}
  assert.equal(missing?.bindings.length,2);assert.equal(added.entityBindings,undefined);
  const message=worldIdentityRecovery(missing!,refs).message,calls=[...message.matchAll(/\{[^{}]+\}/g)].map(m=>JSON.parse(m[0]));
  assert.deepEqual(calls,[{ids:['m1','m2']}]);assert.equal(message.includes('name-0'),false);
  const tools=readingAgentTools(async request=>{const decoded=refs.decode(request);const page=searchMemories(state,book,decoded.recall!,[],'preparation');assert.deepEqual(page.items.map(m=>m.text),names.map(m=>m.text));return [];},{},{worldCandidate:'v1'});
  await tools.find(t=>t.name==='recall_memory')!.execute(calls[0],new AbortController().signal);
  const reply=refs.decode({reply:'',thoughts:[],wantsLong:false,recall:calls[0]}),got=searchMemories(state,book,reply.recall!,[],'preparation').items;
  bindWorldPlan(state,book,[added],new Map(),[],got.map(m=>m.id),[e],'preparation');assert.deepEqual(added.entityBindings,names.map(m=>({entityId:m.identityClaim!.entityId,memoryId:m.id})));
});
test('未曝光name只给合法主体导航，未知及失效资料不会泄漏恢复编号',async()=>{
  const {state,book,e,names,added}=await fixture(),refs=new ReadingReferences();refs.messages([{role:'user',content:JSON.stringify({analysisMaterials:[{id:'exposed-fact',about:[{entityId:names[0].identityClaim!.entityId}]}]})}]);
  let missing:MissingWorldIdentityBindingsError|undefined;try{bindWorldPlan(state,book,[added],new Map(),[],[],[e],'preparation');}catch(error){assert.ok(error instanceof MissingWorldIdentityBindingsError);missing=error;}
  const message=worldIdentityRecovery(missing!,refs).message;assert.ok(message.includes('"entityIds":["e1"]'));assert.equal(message.includes('name-'),false);assert.equal(message.includes('e2'),false);assert.equal(refs.memoryLabel(names[0].id),'未提供的编号');
  for(const mutate of [(m:Memory)=>m.forgotten=true,(m:Memory)=>m.invalidatedBy='correction',(m:Memory)=>m.partnerId='other',(m:Memory)=>m.source='background',(m:Memory)=>m.bookId='other']){
    const copy=structuredClone(state);mutate(copy.memories[0]);const selected=selectAnalysisMaterials(copy,book,{query:'甲员',worldCandidate:'v1',source:'preparation',budget:1400});assert.equal(selected.records.some(m=>m.id===names[0].id),false);assert.equal(selected.entityIndex?.items.some(m=>m.id===names[0].identityClaim!.entityId),false);
  }
  const withdrawn={...book,known:[]};assert.equal(selectAnalysisMaterials(state,withdrawn,{query:'甲员',worldCandidate:'v1',source:'preparation',budget:1400}).records.length,0);
});
test('当前显式姓名的完整最短合法声明优先长资料，同池预算保持',async()=>{
  const {state,book,names}=await fixture(),name=structuredClone(names[0]);state.memories.unshift({...structuredClone(name),id:'long-name',text:'甲员登记详情。'.repeat(150),entityBindings:[{entityId:'entity-0',memoryId:'long-name'}]});
  const materials=selectAnalysisMaterials(state,book,{focusRanges:book.known,worldCandidate:'v1',source:'preparation',budget:1400});
  assert.ok(materials.records.some(m=>m.id===name.id&&m.text===name.text));assert.ok(materials.chars<=1400);assert.equal(materials.records.some(m=>m.id==='long-name'),false);
});
test('缺失主体超过单次工具上限时恢复建议分组',()=>{
  const refs=new ReadingReferences(),items=Array.from({length:12},(_,i)=>({id:'root-'+i,names:[{name:'名'+i,memoryId:'name-'+i}],claimIds:['name-'+i]}));refs.messages([{role:'user',content:JSON.stringify({entityIndex:{items}})}]);
  const error=new MissingWorldIdentityBindingsError(items.map(i=>({entityId:i.id,memoryIds:i.claimIds}))),calls=[...worldIdentityRecovery(error,refs).message.matchAll(/\{[^{}]+\}/g)].map(m=>JSON.parse(m[0]));assert.deepEqual(calls.map(c=>c.ids.length),[8,4]);
});
