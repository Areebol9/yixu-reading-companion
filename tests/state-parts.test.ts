import test from 'node:test';
import assert from 'node:assert/strict';
import {importBook} from '../src/core/books.ts';
import {initialState} from '../src/core/state.ts';
import {correctMemory,evidence,forgetMemory,reconcileCorrections} from '../src/core/context.ts';
import {planNarrativeMemories,currentStates,validateStageStateMemories} from '../src/core/stage-state.ts';
import {applyFactReview,createFactReview,parseFactReview} from '../src/core/fact-review.ts';
import {restoreBackup} from '../src/core/backup.ts';
import {createReadingDraft,pendingReadingDrafts,validateReadingDrafts} from '../src/core/reading-drafts.ts';
import type {Memory,ReadingReply,StateUpdate} from '../src/core/types.ts';

async function fixture(){
  const state=initialState(),book=await importBook('增量条件工程','第一章 条件\n每月交材料；项目完成后才解除约束；次日到场。\n第二章 间隔\nGAP-UNREAD。\n第三章 到场\n次日到场已完成，开始整理记录，其他约束仍有效。');
  state.books=[book];book.known=[book.chapters[0],book.chapters[2]];book.position=book.text.length;
  const first=book.chapters[0],later=book.chapters[2],refs=[first,later].map(r=>evidence(book,r));
  const passages=new Map([['p1',{text:book.text.slice(first.start,first.end),evidence:evidence(book,first)}],['p2',{text:book.text.slice(later.start,later.end),evidence:evidence(book,later)}]]);
  const ctx=(parents:string[]=[])=>({refs,parents,chatIds:[],source:'reading' as const,habitIds:[],originalRanges:[first,later],passages,readingStage:[later],newMemoryIds:[],stateWriteVersion:2 as const});
  const plan=(updates:StateUpdate[],parents:string[]=[])=>planNarrativeMemories(state,book,{reply:'',thoughts:[],wantsLong:false,stateUpdates:updates},ctx(parents));
  const source=(kind:Memory['kind'],text:string):Memory=>({id:kind+'-source',bookId:book.id,partnerId:state.partnerId,kind,text,evidence:[evidence(book,first)],sourceEvidence:[evidence(book,first)],parents:[],chatIds:[],createdAt:1,forgotten:false,source:'reading'});
  return{state,book,first,later,refs,ctx,plan,source};
}

test('完整稳定出处只绑定实际提供的唯一逐字片段，完整原问不能剪断',async()=>{
  const f=await fixture(),story=f.source('story','每月交材料；项目完成后才解除约束；次日到场。'),question=f.source('question','是否能解除约束，以及承诺是否兑现？');f.state.memories.push(story,question);
  assert.throws(()=>f.plan([{topic:'保管',operations:[{op:'add',text:'每月交材料',memoryId:story.id}]}]),/完整提供/);
  const [base]=f.plan([{topic:'保管',operations:[{op:'add',text:'每月交材料',memoryId:story.id},{op:'add',text:question.text,memoryId:question.id}]}],[story.id,question.id]);
  assert.deepEqual(base.stateProjection!.parts![0].memoryRef,{memoryId:story.id,start:0,end:5});f.state.memories.push(base);validateStageStateMemories(f.state);
  assert.throws(()=>f.plan([{topic:'剪问',operations:[{op:'add',text:'是否能解除约束',memoryId:question.id}]}],[question.id]),/不能剪断/);
  story.text='重复重复';assert.throws(()=>f.plan([{topic:'重复',operations:[{op:'add',text:'重复',memoryId:story.id}]}],[story.id]),/唯一/);
});

test('未触条件保持身份与全文，重复目标/未知目标/超限使 detached 计划整体拒绝',async()=>{
  const f=await fixture(),[base]=f.plan([{topic:'保管',operations:[{op:'add',text:'每月交材料。',sourceIds:['p1']},{op:'add',text:'项目完成后才解除约束。',sourceIds:['p1']},{op:'add',text:'次日到场。',sourceIds:['p1']}]}]);f.state.memories.push(base);const before=structuredClone(base),parts=base.stateProjection!.parts!;
  const [next]=f.plan([{topic:'保管',stateChangeOf:base.id,operations:[{op:'retire',partId:parts[2].id,sourceIds:['p2'],reason:'原文到场已完成。'},{op:'add',text:'开始整理记录。',sourceIds:['p2']}]}],[base.id]);
  assert.deepEqual(next.stateProjection!.parts!.slice(0,2),parts.slice(0,2));assert.deepEqual(base,before);assert.equal(next.stateChangeOf,base.id);assert.equal(base.replacedBy,undefined);
  const reject=(operations:any[])=>assert.throws(()=>f.plan([{topic:'保管',stateChangeOf:base.id,operations}],[base.id]));
  reject([{op:'retire',partId:'unknown',sourceIds:['p2'],reason:'未知目标。'}]);reject([1,2].map(()=>({op:'retire',partId:parts[0].id,sourceIds:['p2'],reason:'重复目标。'})));
  reject([{op:'add',text:'长'.repeat(1790),sourceIds:['p2']}]);assert.deepEqual(base,before);assert.equal(f.state.memories.length,1);
  f.state.memories.push(next);validateStageStateMemories(f.state);assert.equal((await restoreBackup(JSON.stringify(f.state),initialState())).memories.length,2);
});

test('ended须逐项retire全部活动片段与实际结束收据，重启active不抹旧收据',async()=>{
  const f=await fixture(),[base]=f.plan([{topic:'保管',operations:[{op:'add',text:'每月交材料。',sourceIds:['p1']},{op:'add',text:'完成后解除。',sourceIds:['p1']}]}]);f.state.memories.push(base);
  const end={text:'保管事项已结束。',sourceIds:['p2']};assert.throws(()=>f.plan([{topic:'保管',stateChangeOf:base.id,status:'ended',operations:[],end}],[base.id]),/全部片段/);
  const [ended]=f.plan([{topic:'保管',stateChangeOf:base.id,status:'ended',operations:base.stateProjection!.parts!.map(p=>({op:'retire',partId:p.id,sourceIds:['p2'],reason:'事项明确结束。'})),end}],[base.id]);f.state.memories.push(ended);
  const [active]=f.plan([{topic:'保管',stateChangeOf:ended.id,operations:[{op:'add',text:'新保管事项开始。',sourceIds:['p2']}]}],[ended.id]);f.state.memories.push(active);
  assert.deepEqual(ended.stateProjection!.parts,[]);assert.equal(ended.text,end.text);assert.equal(active.stateProjection!.end,undefined);assert.equal(currentStates(f.state,f.book)[0].id,active.id);validateStageStateMemories(f.state);
});

test('v1不自动包装缺项全文；明确原文建立，v2修复未触成员不被顶层text删去',async()=>{
  const f=await fixture(),legacy:Memory={...f.source('state','到场已完成。'),id:'legacy',evidence:f.refs,readingStage:[f.later],stateProjection:{topic:'保管',status:'active',asOf:[f.first,f.later].map(({start,end})=>({start,end}))}};f.state.memories.push(legacy);
  assert.throws(()=>f.plan([{topic:'保管',stateChangeOf:legacy.id,operations:[{op:'add',text:'开始记录。',sourceIds:['p2']}]}],[legacy.id]),/v1/);
  const review=createFactReview(f.book,[legacy]),p=review.sources[0].id;
  assert.throws(()=>parseFactReview(review,JSON.stringify({items:[{id:'m0',text:legacy.text,sourceIds:[p],reason:'支持。'}]})),/完整片段/);
  const result=parseFactReview(review,JSON.stringify({items:[{id:'m0',text:'这不是完整覆盖权限。',sourceIds:[p],reason:'按原文恢复条件。',stateParts:[{text:'每月交材料。',sourceIds:[p]},{text:'项目完成后才解除约束。',sourceIds:[p]}]}]}));
  const [key]=applyFactReview(f.state,review,result),base=f.state.memories.find(m=>m.id===key)!,untouched=structuredClone(base.stateProjection!.parts![1]);assert.equal(base.stateProjection!.writeVersion,2);
  const repair=createFactReview(f.book,[base]),p2=repair.sources[0].id,part=base.stateProjection!.parts![0];
  const r=parseFactReview(repair,JSON.stringify({items:[{id:'m0',text:'整段试图只剩一个条件。',sourceIds:[p2],reason:'核对一项条件。',stateOperations:[{op:'replace',partId:part.id,text:'每月仍须交材料。',sourceIds:[p2],reason:'原文保留周期要求。'}]}]}));
  const [nextId]=applyFactReview(f.state,repair,r),next=f.state.memories.find(m=>m.id===nextId)!;assert.deepEqual(next.stateProjection!.parts![1],untouched);assert.equal(next.stateProjection!.parts![0].id,part.id);assert.ok(next.text.includes(untouched.text));validateStageStateMemories(f.state);
});

test('来源版本失效不能supported洗白，明确p重建后恢复；遗忘不能由review恢复',async()=>{
  const f=await fixture(),story=f.source('story','每月交材料；项目完成后解除。');f.state.memories.push(story);
  const [base]=f.plan([{topic:'保管',operations:[{op:'add',text:'每月交材料',memoryId:story.id},{op:'add',text:'项目完成后解除。',sourceIds:['p1']}]}],[story.id]);f.state.memories.push(base);correctMemory(f.state,story.id,'每月交材料的说法需更正。');assert.ok(base.invalidatedBy);assert.equal(currentStates(f.state,f.book).length,0);
  const review=createFactReview(f.book,[base]),p=review.sources[0].id,packet=(operations:any[])=>parseFactReview(review,JSON.stringify({items:[{id:'m0',text:base.text,sourceIds:[p],reason:'按实际原文独立重建。',stateOperations:operations}]}));
  assert.throws(()=>applyFactReview(f.state,review,packet([])),/来源版本失效/);
  const [nextId]=applyFactReview(f.state,review,packet([{op:'replace',partId:base.stateProjection!.parts![0].id,text:'原文要求每月交材料。',sourceIds:[p],reason:'旧出处版本失效，依据本次原文重建。'}]));
  const next=f.state.memories.find(m=>m.id===nextId)!;assert.equal(next.invalidatedBy,undefined);assert.equal(next.stateProjection!.parts![0].memoryRef,undefined);assert.equal(currentStates(f.state,f.book)[0].id,nextId);validateStageStateMemories(f.state);
  const frozen=createFactReview(f.book,[next]);forgetMemory(f.state,nextId);assert.throws(()=>applyFactReview(f.state,frozen,parseFactReview(frozen,JSON.stringify({items:[{id:'m0',text:next.text,sourceIds:[frozen.sources[0].id],reason:'支持。',stateOperations:[]}]}))),/已更新/);
});

test('人工片段仅沿实际parents未触继承，后续更正仍停用，不能借例外新增无来源',async()=>{
  const f=await fixture(),[base]=f.plan([{topic:'保管',operations:[{op:'add',text:'等待确认。',sourceIds:['p1']}]}]);f.state.memories.push(base);const manual=correctMemory(f.state,base.id,'用户指定的保管约束。');
  const [next]=f.plan([{topic:'保管',stateChangeOf:manual.id,operations:[{op:'add',text:'开始记录。',sourceIds:['p2']}]}],[manual.id]);f.state.memories.push(next);assert.deepEqual(next.stateProjection!.parts![0],manual.stateProjection!.parts![0]);validateStageStateMemories(f.state);
  assert.throws(()=>f.plan([{topic:'无来源',operations:[{op:'add',text:manual.text}]}],[manual.id]),/实际原文/);
  const review=createFactReview(f.book,[next]),[reviewedId]=applyFactReview(f.state,review,parseFactReview(review,JSON.stringify({items:[{id:'m0',text:next.text,sourceIds:[review.sources[0].id],reason:'未触人工声明，其余据原文核实。',stateOperations:[]}]})));
  const reviewed=f.state.memories.find(m=>m.id===reviewedId)!;assert.deepEqual(reviewed.stateProjection!.parts![0],manual.stateProjection!.parts![0]);
  await restoreBackup(JSON.stringify(f.state),initialState());correctMemory(f.state,manual.id,'用户再次更正保管约束。');reconcileCorrections(f.state);assert.ok(reviewed.invalidatedBy);assert.ok(!currentStates(f.state,f.book).some(m=>m.id===reviewed.id));
});

test('草稿协议版本冻结，缺省1兼容旧stamp，v2绝不接受旧整段更新',async()=>{
  const f=await fixture(),result:ReadingReply={reply:'',thoughts:[],wantsLong:false,stateUpdates:[{topic:'保管',operations:[{op:'add',text:'等待到场。',sourceIds:['p1']}]}]},material={messages:[],refs:f.refs,originalRanges:[f.first,f.later],memoryIds:[],chatIds:[],habitIds:[],passages:[['p1',{text:f.book.text.slice(f.first.start,f.first.end),evidence:evidence(f.book,f.first)}]] as [string,NonNullable<Memory['sourceQuote']>][],narrativeMode:'stages' as const,stateWriteVersion:2 as const};
  const draft=createReadingDraft(f.state,f.book,{source:'reading',ranges:[f.later],input:''},result,[],material,'ready');f.state.readingDrafts=[draft];validateReadingDrafts(f.state);assert.equal(pendingReadingDrafts(f.state,f.book.id).length,1);
  draft.material.stateWriteVersion=1;assert.equal(pendingReadingDrafts(f.state,f.book.id).length,0);assert.throws(()=>validateReadingDrafts(f.state),/字段/);
  draft.material.stateWriteVersion=2;draft.result.stateUpdates=[{topic:'保管',text:'旧整段。'}];assert.throws(()=>validateReadingDrafts(f.state),/字段/);
});

test('背景状态原文review保留合法background绑定，实际通道仍可读且不串入共读',async()=>{
  const f=await fixture(),story={...f.source('story','每月交材料。'),source:'background' as const};f.state.memories.push(story);
  const [base]=planNarrativeMemories(f.state,f.book,{reply:'',thoughts:[],wantsLong:false,stateUpdates:[{topic:'保管',operations:[{op:'add',text:story.text,memoryId:story.id}]}]},{...f.ctx([story.id]),source:'background'});f.state.memories.push(base);
  const review=createFactReview(f.book,[base]),[key]=applyFactReview(f.state,review,parseFactReview(review,JSON.stringify({items:[{id:'m0',text:base.text,sourceIds:[review.sources[0].id],reason:'保留合法背景出处。',stateOperations:[]}]})));
  const revised=f.state.memories.find(m=>m.id===key)!;assert.equal(revised.backgroundOrigin,true);assert.equal(revised.source,'review');assert.deepEqual(revised.stateProjection!.parts,base.stateProjection!.parts);
  assert.equal(currentStates(f.state,f.book,{source:'background'})[0].id,key);assert.deepEqual(currentStates(f.state,f.book),[]);validateStageStateMemories(f.state);
});
