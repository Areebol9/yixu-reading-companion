import { test } from 'node:test';
import assert from 'node:assert/strict';
import { covers, importBook, rangeBatches } from '../src/core/books.ts';
import { ReadingEngine } from '../src/core/engine.ts';
import { initialState } from '../src/core/state.ts';
import {packPreparation} from '../src/core/reading-units.ts';

test('准备批次按总字符数拆分，保留分段边界并限制单批碎片数量',()=>{
  const groups=rangeBatches([{start:0,end:4000},{start:5000,end:9500}]);
  assert.deepEqual(groups,[[{start:0,end:4000},{start:5000,end:7000}],[{start:7000,end:9500}]]);
  const many=rangeBatches(Array.from({length:30},(_,i)=>({start:i*2,end:i*2+1})));
  assert.equal(many.length,2);assert.ok(many.every(batch=>batch.length<=16));assert.equal(many.flat().reduce((n,r)=>n+r.end-r.start,0),30);
});

test('合并准备的碎片与记忆同时落盘，失败时整批保持待处理，重试不扩大阅读权限',async()=>{
  const state=initialState(),book=await importBook('批次工程','已读甲。\nUNSEEN-GAP\n已读乙。\nUNSEEN-END');
  book.known=[{start:0,end:4},{start:book.text.indexOf('已读乙'),end:book.text.indexOf('已读乙')+4}];book.position=book.known[1].end;
  state.books=[book];state.settings.services[0].enabled=true;
  let fail=true,calls=0;
  const engine=new ReadingEngine(state,{async load(){return state;},async save(s){if(fail&&s.books[0].prepared.length)throw new Error('save failed');}}, {async complete(_s,m){
    calls++;const payload=JSON.parse(m[1].content);assert.equal(payload.current,'已读乙。');assert.equal(payload.additionalReadings[0].text,'已读甲。');assert.ok(!JSON.stringify(m).includes('UNSEEN'));
    return {content:JSON.stringify({reply:'',thoughts:[{kind:'story',text:'甲乙两份记录已登记。'}],wantsLong:false}),input:10,output:10,estimated:false,elapsedMs:1};
  }});
  await engine.startReading(book.id);await assert.rejects(engine.prepare(book.id),/save failed/);
  assert.equal(calls,1);assert.equal(state.memories.length,0);assert.deepEqual(book.prepared,[]);
  fail=false;await engine.prepare(book.id);assert.equal(calls,1);assert.ok(book.known.every(r=>covers(book.prepared,r)));assert.deepEqual(book.prepared,book.known);assert.equal(state.memories.length,1);engine.stop();
});

test('较大准备批次只合并相邻完整片段，缺口与碎片不拼接、不改原计划',()=>{
 const source=[[{start:0,end:3000}],[{start:3000,end:6000}],[{start:6000,end:9000}],[{start:10000,end:11000}],[{start:11000,end:11100},{start:11200,end:11300}],[{start:11300,end:11400}]];
 const before=structuredClone(source),packed=packPreparation(source,6000);
 assert.deepEqual(packed,[[{start:0,end:6000}],[{start:6000,end:9000}],[{start:10000,end:11000}],[{start:11000,end:11100},{start:11200,end:11300}],[{start:11300,end:11400}]]);
 assert.deepEqual(source,before);assert.equal(packPreparation(source,12000)[0][0].end,9000);
});

test('跨章前文按原顺序一次理解并原子保存，独立背景继续按阶段处理',async()=>{
 const raw='第一章 登记\nORDER-ONE设备登记。\n第二章 转交\nORDER-TWO设备转交。\n第三章 完成\nORDER-THREE复核完毕。\n第四章 未读\nFUTURE-PREP-SECRET';
 const state=initialState(),book=await importBook('合批准备',raw);state.books=[book];book.known=[{start:0,end:book.chapters[2].end}];book.position=book.chapters[2].end;state.settings.services[0].enabled=true;
 let fail=true,calls=0;
 const engine=new ReadingEngine(state,{async load(){return state;},async save(s){if(fail&&s.books[0].prepared.length)throw new Error('batch save failure');}},{async complete(_s,m){
  calls++;const input=JSON.parse(m[1].content);assert.ok(input.current.indexOf('ORDER-ONE')<input.current.indexOf('ORDER-TWO'));assert.ok(input.current.indexOf('ORDER-TWO')<input.current.indexOf('ORDER-THREE'));assert.equal(JSON.stringify(m).includes('FUTURE-PREP-SECRET'),false);
  return{content:JSON.stringify({reply:'',readingBrief:'登记、转交、复核按顺序完成。',thoughts:[]}),input:10,output:10,estimated:false,elapsedMs:1};
 }},undefined,12000);
 await engine.startReading(book.id);await assert.rejects(engine.prepare(book.id),/batch save failure/);assert.deepEqual(book.prepared,[]);assert.equal(state.memories.length,0);
 fail=false;await engine.prepare(book.id);assert.equal(calls,1);assert.deepEqual(book.prepared,book.known);assert.deepEqual(state.memories[0].readingStage,book.known);engine.stop();
 const independent=initialState(),other=await importBook('背景合批边界',raw);independent.books=[other];other.known=[{start:0,end:other.chapters[0].end}];other.position=other.chapters[0].end;independent.settings.services[0].enabled=true;let count=0;
 const background=new ReadingEngine(independent,{async load(){return independent;},async save(){}},{async complete(){count++;return{content:'{"reply":"","thoughts":[]}',input:10,output:10,estimated:false,elapsedMs:1};}},undefined,12000);
 await background.startReading(other.id);await background.prepareBackground(other.id);assert.equal(count,4);assert.deepEqual(other.known,[{start:0,end:other.chapters[0].end}]);background.stop();
});
