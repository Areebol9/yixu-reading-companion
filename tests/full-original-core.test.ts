import test from 'node:test';
import assert from 'node:assert/strict';
import {importBook} from '../src/core/books.ts';
import {initialState} from '../src/core/state.ts';
import {evidence} from '../src/core/context.ts';
import {canFollowReading,readyToRead} from '../src/core/reading-units.ts';
import {fullOriginalRanges,discussionOriginal} from '../src/core/grounding.ts';
import {searchMemories,selectMemories,strategyMemoryAllowed} from '../src/core/recall.ts';
import {createReadingDraft,pendingReadingDrafts,validateReadingDrafts} from '../src/core/reading-drafts.ts';
import {restoreBackup} from '../src/core/backup.ts';
import type {Memory} from '../src/core/types.ts';

test('完整策略就绪只表示获准可跟读，不伪填prepared；全文保留17间隔与临时许可',async()=>{
  const book=await importBook('许可工程','正文许可片段。'.repeat(50)),known=Array.from({length:17},(_,i)=>({start:i*9,end:i*9+5}));book.known=known;book.position=known.at(-1)!.end;const prepared=structuredClone(book.prepared);
  assert.equal(readyToRead(book),false);assert.equal(canFollowReading(book,'structured'),false);assert.equal(canFollowReading(book,'full-original'),true);assert.deepEqual(book.prepared,prepared);
  assert.deepEqual(fullOriginalRanges(book),known);assert.equal(fullOriginalRanges(book).length,17);
  const extra={start:200,end:210};assert.ok(fullOriginalRanges(book,[extra]).some(r=>r.start===extra.start&&r.end===extra.end));assert.deepEqual(book.known,known);
  assert.throws(()=>discussionOriginal(book,initialState().settings.services[0],known[0],{original:0,memories:'none'}),/配置无效/);
  assert.equal(canFollowReading({...book,known:[]},'full-original'),false);
});

test('全文角色筛选保留观点/完整原问/发展与部分答案/人工断言，不让旧摘要ID绕回',async()=>{
  const state=initialState(),book=await importBook('角色工程','设备需校准；是否签收仍待查。\nFUTURE-ONLY。');state.books=[book];book.known=[{start:0,end:18}];book.position=18;
  const make=(id:string,kind:Memory['kind'],fields:Partial<Memory>={}):Memory=>({id,bookId:book.id,partnerId:state.partnerId,kind,text:id+'设备校准',evidence:[evidence(book,book.known[0])],parents:[],chatIds:[],createdAt:1,forgotten:false,source:'reading',...fields});
  const memories=[make('summary','story'),make('view','opinion'),make('question','question'),make('partial','story',{answersPartOf:'question',parents:['question']}),make('complete','story',{correctionOf:'question',revisionKind:'development',parents:['question']}),make('manual-stage','stage',{source:'correction',correctionOf:'summary'}),make('manual-review','stage',{source:'review',correctionOf:'manual-stage'}),make('exchange','story',{source:'conversation'}),make('future','opinion',{evidence:[evidence(book,{start:19,end:book.text.length})]})];state.memories=memories;
  const brief=make('conversation-brief','context',{source:'conversation'}),reviewedBrief=make('reviewed-brief','context',{source:'review',correctionOf:brief.id});state.memories.push(brief,reviewedBrief);
  assert.equal(strategyMemoryAllowed(state,brief,'full-original'),false);assert.equal(strategyMemoryAllowed(state,reviewedBrief,'full-original'),false);
  assert.equal(strategyMemoryAllowed(state,memories[0],'structured'),true);assert.equal(strategyMemoryAllowed(state,memories[0],'full-original'),false);for(const memory of memories.slice(1,8))assert.equal(strategyMemoryAllowed(state,memory,'full-original'),true);
  const page=searchMemories(state,book,{ids:['summary','view','partial','future']},[],'reading','full-original');assert.deepEqual(new Set(page.items.map(m=>m.id)),new Set(['view','partial']));assert.equal(page.total,2);
  const selected=selectMemories(state,book,book.known[0],'',[],6500,{readingStrategy:'full-original',originalComplete:true});assert.ok(selected.some(m=>m.id==='partial'));assert.ok(selected.some(m=>m.id==='manual-stage'));assert.ok(!selected.some(m=>m.id==='summary'||m.id==='future'));
});

test('草稿形成策略独立冻结，旧missing structured不因Book切换丢失，full不能夹带结构写入',async()=>{
  const state=initialState(),book=await importBook('冻结策略工程','第一章 登记\n设备已经登记。');state.books=[book];book.known=[{start:0,end:book.text.length}];book.position=book.text.length;
  const material={messages:[],refs:[evidence(book,book.known[0])],originalRanges:book.known,memoryIds:[],chatIds:[],habitIds:[],passages:[]};
  const old=createReadingDraft(state,book,{source:'preparation',ranges:book.known,input:''},{reply:'',thoughts:[],wantsLong:false,readingBrief:'登记已完成。'},[],material,'ready');delete old.material.readingStrategy;state.readingDrafts=[old];book.readingStrategy='full-original';validateReadingDrafts(state);assert.equal(pendingReadingDrafts(state,book.id).length,1);
  const direct=createReadingDraft(state,book,{source:'reading',ranges:book.known,input:''},{reply:'',thoughts:[],wantsLong:false},[],{...material,readingStrategy:'full-original'},'ready');state.readingDrafts=[direct];book.readingStrategy='structured';validateReadingDrafts(state);assert.equal(pendingReadingDrafts(state,book.id).length,1);
  direct.material.readingStrategy='structured';assert.equal(pendingReadingDrafts(state,book.id).length,0);direct.material.readingStrategy='full-original';direct.result.readingBrief='不得写的结构。';assert.throws(()=>validateReadingDrafts(state),/专门结构/);
});

test('完整任务17间隔备份恢复，明确待办受known约束且prepared不替它增长',async()=>{
  const state=initialState(),book=await importBook('完整任务备份','获准片段。'.repeat(60)),ranges=Array.from({length:17},(_,i)=>({start:i*8,end:i*8+5}));state.books=[book];book.known=ranges;book.position=ranges.at(-1)!.end;book.readingStrategy='full-original';book.fullOriginalPending=[ranges.at(-1)!];
  const memory:Memory={id:'view',bookId:book.id,partnerId:state.partnerId,kind:'opinion',text:'片段中的登记方式仍值得讨论。',source:'preparation',evidence:ranges.map(r=>evidence(book,r)),readingStage:ranges,parents:[],chatIds:[],createdAt:1,forgotten:false};state.memories=[memory];book.prepared=ranges.slice(0,1);state.readings=[{id:'record',bookId:book.id,version:book.version,partnerId:state.partnerId,source:'preparation',ranges:book.prepared,memoryIds:['view'],createdAt:1}];
  const restored=await restoreBackup(JSON.stringify(state),initialState());assert.equal(restored.books[0].readingStrategy,'full-original');assert.deepEqual(restored.books[0].fullOriginalPending,book.fullOriginalPending);assert.deepEqual(restored.books[0].prepared,book.prepared);assert.equal(restored.memories[0].readingStage!.length,17);
  const bad=structuredClone(state);bad.books[0].fullOriginalPending=[{start:200,end:205}];await assert.rejects(restoreBackup(JSON.stringify(bad),initialState()),/待办超出/);
});
