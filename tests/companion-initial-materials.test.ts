import {test} from 'node:test';
import assert from 'node:assert/strict';
import {importBook} from '../src/core/books.ts';
import {evidence,sceneNearbyReadings} from '../src/core/context.ts';
import {conversationMaterial,memoryMaterial,sceneRecordAllowed,selectCompanionInitialMaterials,validateMaterialProjection} from '../src/core/material-projection.ts';
import {readMemoryDocuments} from '../src/core/memory-discovery.ts';
import {hashText} from '../src/core/text-hash.ts';
import {initialState} from '../src/core/state.ts';
import type {Chat,Memory,PublishedView,ReadingDraftMaterial,ReadingRecord} from '../src/core/types.ts';

async function fixture(){
  const state=initialState(),book=await importBook('首包工程资料','第一章 登记\n'+'旧章登记。'.repeat(500)+'\n第二章 复核\n'+'本章邻近材料。'.repeat(80)+'\nAX设备进入仓库，复核保密通知。\n本段仍在复核。\n第三章 未读\nUNREAD-SECRET');
  const start=book.text.indexOf('AX设备'),end=book.chapters[1].end,range={start,end};
  book.known=[{start:0,end}];book.position=end;state.books=[book];
  const source=evidence(book,{start:0,end:30});
  const memory=(id:string):Memory=>({id,bookId:book.id,partnerId:state.partnerId,kind:'opinion',text:'这是完整工程认识，条件与例外须一起保留。',evidence:[source],sourceEvidence:[source],parents:[],chatIds:[],createdAt:1,forgotten:false,source:'reading'});
  const chat=(id:string):Chat=>({id,bookId:book.id,partnerId:state.partnerId,sessionId:'active',role:'user',text:'真实工程交流'+id,evidence:[source],createdAt:1,excluded:false});
  const view=(id:string,kind:PublishedView['kind'],key:string):PublishedView=>({id,kind,key,text:'已发布工程概要。',bookId:book.id,version:book.version,partnerId:state.partnerId,createdAt:1,memorySources:[],originalSources:[],viewSources:[],evidence:[source],contextChatIds:[],ranges:[source],chatIds:[]});
  return{state,book,range,memory,chat,view,source};
}

test('首包保留全部本次原文，只选同章连续近邻、相关概要与实际全文，不默认目录往返',async()=>{
  const f=await fixture(),{state,book,range}=f;
  const cold=f.memory('cold'),body='AX设备的完整工程看法，含通常条件、个体例外与待核部分。'.repeat(40),hash=await hashText(body);
  delete cold.text;cold.bodyRef={key:'cold-body',hash,chars:body.length};cold.knowledgeDistribution={topics:['保密通知'],subjects:['AX设备']};
  state.memories=[cold,...Array.from({length:20},(_,i)=>f.memory('unrelated-'+i))];
  const current=f.view('current','current','当前'),overview=f.view('overview','overview','全局'),topic=f.view('topic','topic','保密通知'),unrelated=f.view('unrelated','topic','其他工程');
  state.publishedViews=[current,overview,topic,unrelated];state.viewPublications=[{id:JSON.stringify([book.id,book.version,state.partnerId]),bookId:book.id,version:book.version,partnerId:state.partnerId,revision:1,viewIds:state.publishedViews.map(v=>v.id)}];
  const anchored=f.chat('paragraph');anchored.formationRanges=[range];state.chats=[...Array.from({length:8},(_,i)=>f.chat('old-'+i)),anchored];
  const selected=selectCompanionInitialMaterials(state,book,{ranges:[range],conversationId:'active'});
  assert.deepEqual(selected.originalRanges,[range]);assert(selected.nearbyRanges.every(r=>r.start>=book.chapters[1].start&&r.end===range.start));
  assert(selected.nearbyRanges.reduce((n,r)=>n+r.end-r.start,0)<=360);
  assert.deepEqual(selected.views.map(v=>v.id),['current','topic']);assert.deepEqual(selected.chats.map(c=>c.id),['paragraph']);assert.deepEqual(selected.memoryIds,['cold']);
  assert.equal(selected.omitted.relatedDocuments,0);assert(selected.omitted.chats>=8);assert.equal(Object.hasOwn(selected,'directory'),false);
  const loaded=await readMemoryDocuments(state,book,selected.memoryIds,async refs=>refs.map(ref=>({...ref,text:body})));
  assert.equal(loaded.items.length,1);assert.equal(memoryMaterial(loaded.items[0],{full:true}).text,body);assert.equal(state.memories[0].text,undefined);
  assert.equal(JSON.stringify(selected).includes('UNREAD-SECRET'),false);
});

test('许可缺口、章界及未授权正文阻断邻近；明确必需材料超首包仍列出可继续项',async()=>{
  const f=await fixture(),{state,book,range}=f;
  book.known=[{start:0,end:30},{start:range.start,end:range.end}];assert.deepEqual(sceneNearbyReadings(book,[range]),[]);
  book.known=[{start:0,end:range.end}];const atChapter={start:book.chapters[1].start,end:book.chapters[1].start+30};assert.deepEqual(sceneNearbyReadings(book,[atChapter]),[]);
  assert.throws(()=>selectCompanionInitialMaterials(state,book,{ranges:[{start:range.end,end:book.text.length}]}),/许可/);
  state.memories=Array.from({length:9},(_,i)=>f.memory('needed-'+i));const revoked=f.memory('revoked');revoked.forgotten=true;state.memories.push(revoked);
  const ids=state.memories.map(m=>m.id),selected=selectCompanionInitialMaterials(state,book,{role:'maintenance',ranges:[range],requiredMemoryIds:ids});
  assert.equal(selected.memoryIds.length,6);assert.equal(selected.remainingMemoryIds.length,3);assert.deepEqual(new Set([...selected.memoryIds,...selected.remainingMemoryIds]),new Set(ids.filter(id=>id!=='revoked')));assert.deepEqual(selected.unavailableMemoryIds,['revoked']);
  const viewsOnly=selectCompanionInitialMaterials(state,book,{role:'maintenance',ranges:[],requiredMemoryIds:['needed-0']});assert.deepEqual(viewsOnly.originalRanges,[]);assert.deepEqual(viewsOnly.nearbyRanges,[]);assert.deepEqual(viewsOnly.memoryIds,['needed-0']);
  const next=f.memory('future-version');next.revisionKind='development';next.evidence=[evidence(book,{start:range.end,end:book.text.length})];state.memories[0].replacedBy=next.id;state.memories.push(next);
  assert(selectCompanionInitialMaterials(state,book,{ranges:[range],requiredMemoryIds:['needed-0']}).memoryIds.includes('needed-0'));
});

test('首包的临时许可同时约束原文、近邻与全文候选，结束后不改变持久许可',async()=>{
  const f=await fixture(),{state,book,range}=f,grant={start:range.start-80,end:range.end};
  book.known=[{start:0,end:30}];const originalKnown=structuredClone(book.known),temporary=f.memory('temporary');temporary.evidence=[evidence(book,grant)];temporary.navigationCues=['AX设备'];state.memories=[temporary];
  assert.throws(()=>selectCompanionInitialMaterials(state,book,{ranges:[range]}),/许可/);
  const selected=selectCompanionInitialMaterials(state,book,{ranges:[range],extra:[grant]});
  assert.deepEqual(selected.memoryIds,['temporary']);assert(selected.nearbyRanges.every(r=>r.start>=grant.start&&r.end<=range.start));assert.deepEqual(book.known,originalKnown);
  assert.deepEqual(selectCompanionInitialMaterials(state,book,{ranges:[],requiredMemoryIds:[temporary.id]}).unavailableMemoryIds,[temporary.id]);
});

test('已存现场成果继续受原文和来源闭包约束，正常发展保留形成时身份',async()=>{
  const f=await fixture(),{state,book,range}=f,parent=f.memory('parent'),child=f.memory('child');child.parents=[parent.id];state.memories=[parent,child];
  const chat=f.chat('real-chat');state.chats=[chat];
  const record:ReadingRecord={id:'scene-record',bookId:book.id,version:book.version,partnerId:state.partnerId,source:'reading',ranges:[range],memoryIds:[],createdAt:1,expressionOnly:true,sceneInsight:{text:'工程伙伴在当前片段形成的疑点。',evidence:[evidence(book,range)],memoryIds:[child.id],chatIds:[chat.id]}};
  state.readings=[record];assert(sceneRecordAllowed(state,book,record));
  const material={taskRole:'maintenance',sceneRecordIds:[record.id]} as ReadingDraftMaterial;validateMaterialProjection(state,book,material);
  parent.forgotten=true;assert.equal(sceneRecordAllowed(state,book,record),false);assert.throws(()=>validateMaterialProjection(state,book,material),/成果来源/);parent.forgotten=false;
  const next=f.memory('next');next.revisionKind='development';parent.replacedBy=next.id;state.memories.push(next);assert(sceneRecordAllowed(state,book,record));
  chat.memoryAllowed=false;assert.equal(sceneRecordAllowed(state,book,record),false);chat.memoryAllowed=true;
  const prior=f.chat('prior');state.chats.push(prior);chat.contextChatIds=[prior.id];prior.memoryAllowed=false;assert.equal(sceneRecordAllowed(state,book,record),false);prior.memoryAllowed=true;assert(sceneRecordAllowed(state,book,record));
  book.known=[{start:0,end:range.start}];assert.equal(sceneRecordAllowed(state,book,record),false);
});

test('现场优先供入最近完整问答及显式段评答复，保留作者关系而不纳入未发表候选',async()=>{
 const f=await fixture(),{state,book,range}=f;state.conversations=[{id:'active',bookId:book.id,title:'工程阅读',kind:'reading',start:range.start,end:range.end,createdAt:1}];
 const question={...f.chat('question'),delivery:'answered' as const,createdAt:10},answer={...f.chat('answer'),role:'assistant' as const,replyTo:question.id,createdAt:11};
 const required={...f.chat('required'),formationRanges:[range]},older=Array.from({length:4},(_,i)=>({...f.chat('older-'+i),formationRanges:[range]}));
 const unpublished={...answer,id:'not-published',createdAt:20,publication:{status:'deferred' as const},formationRanges:[range]};state.chats=[question,answer,required,...older,unpublished];
 const selected=selectCompanionInitialMaterials(state,book,{ranges:[range],conversationId:'active',requiredChatIds:[required.id]});assert.deepEqual(selected.chats.slice(-2).map(c=>c.id),[question.id,answer.id]);assert.ok(selected.chats.includes(required));assert.equal(selected.chats.length,4);assert.ok(!selected.chats.includes(unpublished));
 const anchor={...f.source,quote:book.text.slice(f.source.start,f.source.end),hash:await hashText(book.text.slice(f.source.start,f.source.end))};question.presentation='paragraph';Object.assign(question,{anchor});Object.assign(answer,{presentation:'paragraph',anchor,paragraphCommentId:question.id,delivery:'answered'});
 const paragraph=selectCompanionInitialMaterials(state,book,{ranges:[range],conversationId:'active'}).chats;assert.ok(paragraph.includes(question));assert.ok(paragraph.includes(answer));
 const projected=conversationMaterial(answer);assert.equal(projected.role,'assistant');assert.equal(projected.replyTo,question.id);assert.equal(projected.presentation,'paragraph');assert.equal(Object.hasOwn(projected,'seen'),false);
 question.memoryAllowed=false;assert.ok(!selectCompanionInitialMaterials(state,book,{ranges:[range],conversationId:'active'}).chats.includes(answer));
});
