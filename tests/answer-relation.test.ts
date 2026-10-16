import test from 'node:test';
import assert from 'node:assert/strict';
import {importBook} from '../src/core/books.ts';
import {currentQuestion,evidence,forgetMemory,usableMemories} from '../src/core/context.ts';
import {applyFactReview,createFactReview,parseFactReview} from '../src/core/fact-review.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import {HarnessFactReviewer} from '../src/agent/fact-reviewer.ts';
import {ChatModel} from '../src/core/model.ts';
import {initialState} from '../src/core/state.ts';
import {restoreBackup} from '../src/core/backup.ts';
import type {Memory,ModelMessage} from '../src/core/types.ts';

async function fixture(answered=false){
 const state=initialState(),book=await importBook('工程记录','第一章 历史\n'+'先前工程记录。'.repeat(2100)+'\n第二章 登记\n设备AX登记3件。\n第三章\nUNREAD-ANSWER-RELATION');
 book.known=[{start:0,end:book.chapters[1].end}];book.position=book.chapters[1].end;state.books=[book];state.settings.services[0].enabled=true;
 const refs=[evidence(book,book.known[0])];
 const question:Memory={id:'question',bookId:book.id,partnerId:state.partnerId,kind:'question',text:answered?'设备AX数量及停用原因分别是什么？':'设备AX由谁登记、何时恢复？',evidence:refs,parents:[],chatIds:[],createdAt:1,forgotten:false,source:'reading',readingStage:[book.chapters[0]]};
 const partial:Memory={...question,id:'partial',kind:'story',text:'设备AX登记3件。',parents:[question.id],createdAt:2,readingStage:[book.chapters[1]],answersPartOf:question.id};
 state.memories=[question,partial];return{state,book,question,partial};
}

test('正式核对分别保留真实部分解答与移除同主题错误关联，正文和完整原问保持，备份及遗忘沿历史关系执行',async()=>{
 for(const answered of [false,true]){
  const f=await fixture(answered),requests:any[]=[];
  const model=new ChatModel(async request=>{
   requests.push(request);assert.ok(!JSON.stringify(request.body).includes('UNREAD-ANSWER-RELATION'));
   const input=(request.body.messages as ModelMessage[]).filter(m=>m.role==='user').flatMap(m=>{try{return[JSON.parse(m.content)];}catch{return[];}}).find(p=>p.candidates);
   assert.equal(input.candidates[0].partialQuestion.text,f.question.text);
   assert.ok(input.sources.reduce((n:number,s:any)=>n+s.text.length,0)<1000,'Initial source should use actual creation stage, not whole exposure');
   if(requests.length===2)assert.ok(request.body.messages.some(m=>m.role==='tool'&&m.content.includes('关联核对无效')));
   const item={id:'m0',text:f.partial.text,sourceIds:[input.sources.find((s:any)=>s.text.includes('设备AX登记')).id],reason:answered?'数量回应原问；停用原因仍未知。':'数量未回答登记人和恢复时间，事实独立保留。',...(requests.length===2?{answerRelation:answered?'keep':'remove'}:{})};
   return{status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:'review-'+requests.length,type:'function',function:{name:'submit_review',arguments:JSON.stringify({items:[item]})}}]}}],usage:{prompt_tokens:20,completion_tokens:10}}};
  });
  const reviewer=new HarnessFactReviewer(),engine=new ReadingEngine(f.state,{async save(){}},model);engine.factReviewer=reviewer;
  try{
   await engine.reviewFacts(f.book.id,f.partial.id);assert.equal(requests.length,2);
   const next=f.state.memories.find(m=>m.id===f.partial.replacedBy)!;
   assert.equal(next.text,f.partial.text);assert.equal(next.kind,'story');assert.equal(next.answersPartOf,answered?f.question.id:undefined);
   assert.equal(f.partial.answersPartOf,f.question.id);assert.equal(currentQuestion(f.state,f.book,f.question.id)?.text,f.question.text);
   assert.deepEqual(next.readingStage,f.partial.readingStage);assert.ok(next.parents.includes(f.question.id));assert.deepEqual(next.basis,{memoryIds:[],chatIds:[]});
   const restored=await restoreBackup(JSON.stringify(f.state),initialState());assert.equal(restored.memories.find(m=>m.id===next.id)?.answersPartOf,next.answersPartOf);
   assert.ok(usableMemories(restored,restored.books[0]).some(m=>m.id===next.id));
   if(!answered){
    const forged=structuredClone(restored),fakeQ={...f.question,id:'other-question'};forged.memories.push(fakeQ);
    const rewritten=forged.memories.find(m=>m.id===next.id)!;rewritten.answersPartOf=fakeQ.id;rewritten.parents.push(fakeQ.id);
    await assert.rejects(restoreBackup(JSON.stringify(forged),initialState()),/事实核对记录无效/);
   }
   forgetMemory(restored,f.question.id);assert.equal(restored.memories.find(m=>m.id===next.id)?.forgotten,true);
   assert.deepEqual(f.book.known,[{start:0,end:f.book.chapters[1].end}]);assert.equal(f.state.chats.length,0);
  }finally{engine.stop();await reviewer.dispose();}
 }
});

test('核对进行中完整原问或旧关联改变时拒绝发布；未提供原问不能伪造关联移除',async()=>{
 const f=await fixture(),make=()=>createFactReview(f.book,[f.partial],[],new Map([[f.question.id,f.question]]));
 const review=make(),source=review.sources.find(s=>s.text.includes('设备AX登记'))!;
 const raw=JSON.stringify({items:[{id:'m0',text:f.partial.text,sourceIds:[source.id],reason:'独立保留数量事实。',answerRelation:'remove'}]});
 const result=parseFactReview(review,raw);f.question.text+='新增未解条件';
 assert.throws(()=>applyFactReview(f.state,review,result),/记录已更新/);assert.equal(f.partial.replacedBy,undefined);
 const fresh=make();f.partial.answersPartOf=undefined;assert.throws(()=>applyFactReview(f.state,fresh,parseFactReview(fresh,raw)),/记录已更新/);
 f.partial.answersPartOf=f.question.id;const noQuestion=createFactReview(f.book,[f.partial]);assert.throws(()=>parseFactReview(noQuestion,raw),/关联核对无效/);
 assert.equal(f.state.memories.length,2);
});
