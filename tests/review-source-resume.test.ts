import {ModelRequestError} from '../src/core/errors.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {importBook} from '../src/core/books.ts';
import {evidence,forgetMemory} from '../src/core/context.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import {initialState} from '../src/core/state.ts';
import {restoreBackup} from '../src/core/backup.ts';
import {recoverInterruptedState} from '../src/core/startup.ts';
import {validateReviewTasks} from '../src/core/review-tasks.ts';
import {ChatModel} from '../src/core/model.ts';
import {HarnessFactReviewer} from '../src/agent/fact-reviewer.ts';
import {createFactReview,developmentReviewEvidence,focusFactReview} from '../src/core/fact-review.ts';

function response(name:string,args:unknown){return {status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:crypto.randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]}}],usage:{prompt_tokens:10,completion_tokens:5}}};}
function payload(request:any){return request.body.messages.filter((m:any)=>m.role==='user').map((m:any)=>{try{return JSON.parse(m.content);}catch{return {};}}).find((m:any)=>m.candidates);}
async function stopped(){
 const state=initialState(),book=await importBook('接续工程','第一章\n设备QX登记3件，登记时间待查。\n第二章\n其他设备状态已有记录。\n第三章\nFUTURE-PRIVATE');
 book.known=[{start:0,end:book.chapters[1].end}];book.position=book.chapters[1].end;state.books=[book];state.settings.services[0].enabled=true;
 const ref=[evidence(book,book.known[0])];
 state.memories.push({id:'claim',bookId:book.id,partnerId:state.partnerId,kind:'story',text:'设备QX登记3件。',evidence:ref,readingStage:[{start:book.chapters[1].start+12,end:book.chapters[1].end}],source:'reading',parents:[],chatIds:[],createdAt:1,forgotten:false});
 // Keep the needed event outside the 240-character nearby context.
 book.text=book.text.replace('第二章\n','第二章\n'+'填充记录。'.repeat(70)+'\n');
 // Import again so chapter coordinates/version match the actual text.
 const updated=await importBook('接续工程',book.text);updated.id=book.id;updated.known=[{start:0,end:updated.chapters[1].end}];updated.position=updated.chapters[1].end;state.books=[updated];state.memories[0].evidence=[evidence(updated,updated.known[0])];state.memories[0].readingStage=[{start:updated.chapters[1].end-14,end:updated.chapters[1].end}];
 let saved=structuredClone(state),calls=0;
 const engine=new ReadingEngine(state,{async save(s){saved=structuredClone(s);}},new ChatModel(async()=>{
  if(++calls===1)return response('read_evidence',{query:'设备QX'});
  throw new ModelRequestError('ENGINE MOCK后续请求明确未派发中断','not-dispatched');
 }));const reviewer=new HarnessFactReviewer();engine.factReviewer=reviewer;
 await assert.rejects(engine.reviewFacts(updated.id,'claim'),ModelRequestError);const crash=structuredClone(saved);await reviewer.dispose();engine.stop();
 return {state:crash,book:updated,taskId:crash.tasks![0].id};
}

test('已提供回查原文仅存坐标，备份／重启后一次提交接续，不重查且费用保留',async()=>{
 const f=await stopped(),cache=f.state.tasks![0].items[0].reviewSources!;
 assert.ok(cache.sources.some(s=>f.book.text.slice(s.evidence.start,s.evidence.end).includes('设备QX')));assert.ok(!JSON.stringify(cache).includes('设备QX'));validateReviewTasks(f.state);
 const restored=await restoreBackup(JSON.stringify(f.state),initialState());restored.settings.services[0].enabled=true;assert.equal(restored.usage[1].status,'failed');let calls=0;
 const engine=new ReadingEngine(restored,{async save(){}},new ChatModel(async request=>{
  calls++;assert.ok(!JSON.stringify(request.body).includes('FUTURE-PRIVATE'));const input=payload(request),source=input.sources.find((s:any)=>s.text.includes('设备QX'));
  assert.ok(source,'previous lookup must be in initial materials');return response('submit_review',{items:[{id:'m0',text:input.candidates[0].text,sourceIds:[source.id],reason:'依据已保存的回查原文'}]});
 }));const reviewer=new HarnessFactReviewer();engine.factReviewer=reviewer;
 try{await engine.resumeFactReview(f.taskId);assert.equal(calls,1);assert.equal(restored.usage.length,3);assert.equal(restored.usage[1].status,'failed');assert.equal(restored.tasks![0].items[0].reviewSources,undefined);assert.equal(restored.memories.at(-1)!.reviewDisposition,'supported');}finally{engine.stop();await reviewer.dispose();}
 const forgotten=structuredClone(f.state);forgetMemory(forgotten,'claim');assert.equal(forgotten.tasks![0].items[0].reviewSources,undefined);
 const revoked=structuredClone(f.state);revoked.books[0].known=[{start:revoked.books[0].chapters[1].start,end:revoked.books[0].chapters[1].end}];recoverInterruptedState(revoked);assert.equal(revoked.tasks![0].items[0].reviewSources,undefined);
 const bad=structuredClone(f.state);bad.tasks![0].items[0].reviewSources!.sources[0].evidence.version='other';await assert.rejects(restoreBackup(JSON.stringify(bad),initialState()),/原文接续记录无效/);
});

test('候选文字改变时不复用旧回查，稀疏编号后的新检索不重复编号',async()=>{
 const f=await stopped(),restored=await restoreBackup(JSON.stringify(f.state),initialState());restored.settings.services[0].enabled=true;restored.memories[0].text='第二章的设备状态是什么？';let calls=0;
 const engine=new ReadingEngine(restored,{async save(){}},new ChatModel(async request=>{
  const input=payload(request);calls++;assert.ok(!input.sources.some((s:any)=>s.text.includes('设备QX')),'changed candidate must invalidate old lookup');return response('submit_review',{items:[{id:'m0',text:null,sourceIds:[],reason:'本轮材料不足'}]});
 }));const reviewer=new HarnessFactReviewer();engine.factReviewer=reviewer;
 try{await engine.resumeFactReview(f.taskId);assert.equal(calls,1);}finally{engine.stop();await reviewer.dispose();}
 const review=createFactReview(f.book,[f.state.memories[0]]);review.sources=review.sources.map((s,i)=>({...s,id:`p${i+100}`}));let requestCount=0;const direct=new HarnessFactReviewer(),controller=new AbortController();
 try{await direct.review({review,service:f.state.settings.services[0],signal:controller.signal,assertCurrent(){},async lookupEvidence(){return [{text:f.book.text.slice(4,14),evidence:evidence(f.book,{start:4,end:14})}];},async request(messages){
  if(++requestCount===1)return {content:'',reasoning:'',toolCalls:[{id:'lookup',type:'function',function:{name:'read_evidence',arguments:JSON.stringify({query:'设备QX'})}}],finish:'tool_calls',input:1,output:1,estimated:false,elapsedMs:1};
  const sources=JSON.parse(messages.findLast(m=>m.role==='tool')!.content).sources;assert.ok(Number(sources[0].id.slice(1))>=100+review.sources.length-1);return {content:JSON.stringify({items:[{id:'m0',text:null,sourceIds:[],reason:'不支持'}]}),reasoning:'',toolCalls:[],finish:'stop',input:1,output:1,estimated:false,elapsedMs:1};
 }});}finally{await direct.dispose();}
});

test('观点发展补入直接前一阶段的原文，不把旧观点当证据或越过获准范围',async()=>{
 const state=initialState(),book=await importBook('观点依据','第一章\n设备QX留下药方后离开。\n'+'无关记录。'.repeat(80)+'\n第二章\n设备QX再次见到朋友。\n第三章\nFUTURE');book.known=[{start:0,end:book.chapters[1].end}];state.books=[book];
 const prior={id:'prior',bookId:book.id,partnerId:state.partnerId,kind:'opinion' as const,text:'PREVIOUS-VIEW-PRIVATE',evidence:[evidence(book,book.known[0])],readingStage:[book.chapters[0]],source:'reading' as const,parents:[],chatIds:[],createdAt:1,forgotten:false};
 const current={...prior,id:'current',text:'这次再次见面延续了先前留下药方的关切。',correctionOf:'prior',revisionKind:'development' as const,readingStage:[book.chapters[1]]};state.memories=[prior,current];
 const extra=developmentReviewEvidence(state,book,current),review=focusFactReview(createFactReview(book,[current],extra));assert.ok(review.sources.some(s=>s.text.includes('留下药方')));assert.ok(!JSON.stringify(review.sources).includes('PREVIOUS-VIEW-PRIVATE'));assert.ok(!JSON.stringify(review.sources).includes('FUTURE'));
 prior.forgotten=true;assert.deepEqual(developmentReviewEvidence(state,book,current),[]);
});

test('回查材料写盘失败后停止后续模型请求，未保存修订与接续进度',async()=>{
 const f=await stopped(),state=await restoreBackup(JSON.stringify(f.state),initialState());state.settings.services[0].enabled=true;delete state.tasks![0].items[0].reviewSources;let calls=0;
 const engine=new ReadingEngine(state,{async save(next){if(next.tasks![0].items[0].reviewSources?.sources.some(s=>f.book.text.slice(s.evidence.start,s.evidence.end).includes('设备QX')))throw Error('source disk unavailable');}},new ChatModel(async()=>{calls++;return response('read_evidence',{query:'设备QX'});}));const reviewer=new HarnessFactReviewer();engine.factReviewer=reviewer;
 try{await assert.rejects(engine.resumeFactReview(f.taskId),/source disk unavailable/);assert.equal(calls,1);assert.equal(state.tasks![0].items[0].status,'pending');assert.equal(state.tasks![0].status,'interrupted');assert.equal(state.memories.length,1);}finally{engine.stop();await reviewer.dispose();}
});
