import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState} from '../src/core/state.ts';
import {importBook} from '../src/core/books.ts';
import {evidence} from '../src/core/context.ts';
import {planWorkspace} from '../src/core/companion-workspace.ts';
import {applyDocumentRevision,parseDocumentSourceIds} from '../src/core/document-revision.ts';
import {readingDocumentsPayload,validateReadingDocumentsPayloadShape} from '../src/core/reading-output.ts';
import {parseAnswerAspects} from '../src/core/answer-materials.ts';
import type {Memory} from '../src/core/types.ts';

async function fixture(){
  const state=initialState(),book=await importBook('参数反馈工程记录','第一章 已授权\n设备正常记录。');book.known=[{start:0,end:book.text.length}];state.books=[book];
  const old:Memory={id:'old-full',bookId:book.id,partnerId:state.partnerId,kind:'opinion',text:'ENGINE MOCK 已给旧全文。',evidence:[evidence(book,book.known[0])],parents:[],chatIds:[],createdAt:1,forgotten:false,source:'reading',replacedBy:'formed-new'};
  const next:Memory={...old,id:'formed-new',text:'ENGINE MOCK 本包接续后的全文。',parents:[old.id],correctionOf:old.id,revisionKind:'development',replacedBy:undefined};state.memories=[old,next];
  return {state,book,old,next};
}

test('已给旧全文被同包新稿接续时指出实际字段与tN，引用新稿无需再次取材且失败不改状态',async()=>{
  const f=await fixture(),bindings={memoryIds:[f.old.id],proposalMemoryIds:{t2:f.next.id}},before=structuredClone(f.state);
  for(const [proposal,field] of [[{focus:[f.old.id]},'focus[0]'],[{understanding:f.old.id},'understanding'],[{working:[f.old.id]},'working[0]']] as const){
    assert.throws(()=>planWorkspace(f.state,f.book,proposal,bindings,{expectedRevision:0}),error=>error instanceof Error&&error.message.includes(field)&&error.message.includes('本次t2接续'));
    assert.deepEqual(f.state,before);
  }
  const saved=planWorkspace(f.state,f.book,{understanding:'t2',working:['t2'],focus:['t2']},bindings,{expectedRevision:0});
  assert.equal(saved.understandingId,f.next.id);assert.deepEqual(saved.workingIds,[f.next.id]);assert.deepEqual(saved.focusIds,[f.next.id]);
});

test('来自另一包的后继不冒充本次tN提示，目录未取得与新稿不可用仍拒绝',async()=>{
  const f=await fixture();
  assert.throws(()=>planWorkspace(f.state,f.book,{understanding:f.old.id},{memoryIds:[f.old.id],proposalMemoryIds:{t1:'unrelated'}},{expectedRevision:0}),error=>error instanceof Error&&error.message.includes('understanding')&&!error.message.includes('本次t1接续'));
  f.next.forgotten=true;assert.throws(()=>planWorkspace(f.state,f.book,{understanding:'t2'},{memoryIds:[f.old.id],proposalMemoryIds:{t2:f.next.id}},{expectedRevision:0}),/understanding.*完整取得/);
});

test('来源数量、非法项和错位字段明确，八项检查仍在去重前且合法解析保持原内容',()=>{
  const ids=Array.from({length:13},(_,i)=>'p'+(i+1)),payload={documents:[{operation:'create',text:'ENGINE MOCK 完整正文。',sourceIds:ids}]};
  assert.throws(()=>validateReadingDocumentsPayloadShape(payload),/documents\[0\]\.sourceIds实际13项，最多8项/);
  assert.throws(()=>validateReadingDocumentsPayloadShape({documents:[{operation:'revise',updates:'m1',updateReason:'ENGINE MOCK 实际接续。',edits:[{oldText:'旧段',newText:'新段',sourceIds:ids}]}]}),/documents\[0\]\.edits\[0\]\.sourceIds实际13项/);
  assert.throws(()=>validateReadingDocumentsPayloadShape({...payload,documents:[{operation:'create',text:'ENGINE MOCK 完整正文。'}],sourceIds:['p1']}),/finish_reading\.sourceIds不能位于顶层/);
  assert.throws(()=>parseDocumentSourceIds(Array(9).fill('p1')),/实际9项，最多8项/);assert.deepEqual(parseDocumentSourceIds(Array(8).fill('p1')),['p1']);
  assert.throws(()=>validateReadingDocumentsPayloadShape({documents:[{operation:'create',text:'ENGINE MOCK 完整正文。',sourceIds:['p1','m2']}]}),/documents\[0\]\.sourceIds\[1\]/);
  const valid=readingDocumentsPayload({documents:[{operation:'create',text:'ENGINE MOCK 完整正文。',sourceIds:['p1','p1','p2']}],working:['t1']});
  assert.equal(valid.thoughts[0].text,'ENGINE MOCK 完整正文。');assert.deepEqual(valid.thoughts[0].sourceIds,['p1','p2']);assert.deepEqual(valid.workspace?.working,['t1']);
});

test('综合取材来源数组超限指出实际方面；已给合法来源仅去重、不裁剪或补项',()=>{
  const valid={need:'ENGINE MOCK 当前来源。',sourceIds:['p1','p2']};
  assert.throws(()=>parseAnswerAspects({aspects:[valid,valid,{...valid,sourceIds:Array.from({length:12},(_,i)=>'p'+(i+1))}]}),/aspects\[2\]\.sourceIds实际12项，最多8项/);
  assert.throws(()=>parseAnswerAspects({aspects:[{...valid,sourceIds:['p1','m2']}]}),/aspects\[0\]\.sourceIds\[1\]/);
  assert.throws(()=>parseAnswerAspects({aspects:[{...valid,sourceIds:'p1'}]}),/aspects\[0\]\.sourceIds须.*数组/);
  assert.deepEqual(parseAnswerAspects({aspects:[{...valid,sourceIds:['p1','p1','p2']}]}),[valid]);
});

test('重建超长报告实际旧长、净变化与追加，原12000上限及正文保持',async()=>{
  const {old}=await fixture();delete old.replacedBy;old.text='首'+ '余'.repeat(11998);
  assert.throws(()=>applyDocumentRevision(old,{edits:[{oldText:'首',newText:'新首'}],appendText:'追加'}),/实际12002字符.*旧全文11999，edits净变化1，追加2.*上限12000.*单独create不会更新旧稿判断/);
  assert.equal(old.text.length,11999);
  assert.equal(applyDocumentRevision(old,{appendText:'终'}).text,old.text+'终');
});
