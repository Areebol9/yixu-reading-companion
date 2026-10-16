import {test} from 'node:test';
import assert from 'node:assert/strict';
import {importBook,covers} from '../src/core/books.ts';
import {initialState} from '../src/core/state.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import {ChatModel} from '../src/core/model.ts';
import {HarnessRuntime} from '../src/agent/runtime.ts';

async function fixture(){
 const state=initialState(),book=await importBook('共读合批工程','第一章 起\n基础已登记。\n第二章 甲\nORDER-ONE设备登记。\n第三章 乙\nORDER-TWO设备移交。\n第四章 丙\nORDER-THREE设备复核。\n第五章 未读\nFUTURE-BATCH-SECRET');
 book.known=[{start:0,end:book.chapters[0].end}];book.prepared=[...book.known];book.position=book.chapters[0].end;state.books=[book];state.settings.services[0].enabled=true;state.settings.minReadChars=1;return{state,book};
}

test('已观察相邻章节可选合批，默认逐章保持；原文次序与未读边界保持',async()=>{
 for(const packed of [false,true]){
  const f=await fixture();let calls=0;
  const engine=new ReadingEngine(f.state,{async save(){}},new ChatModel(async request=>{
   calls++;const input=request.body.messages.filter(m=>m.role==='user').flatMap(m=>m.content.split('\n\n')).map(s=>{try{return JSON.parse(s);}catch{return {};}}).find(p=>p.currentRange);
   assert.ok(!JSON.stringify(request.body).includes('FUTURE-BATCH-SECRET'));
   if(packed){assert.ok(input.current.indexOf('ORDER-ONE')<input.current.indexOf('ORDER-TWO'));assert.ok(input.current.indexOf('ORDER-TWO')<input.current.indexOf('ORDER-THREE'));}
   return{status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:'submit-'+calls,type:'function',function:{name:'submit_reading',arguments:JSON.stringify({reply:'',thoughts:[],readingBrief:'当轮工程记录已处理。'})}}]}}],usage:{prompt_tokens:10,completion_tokens:10}}};
  })),harness=new HarnessRuntime();engine.agent=harness;if(packed)engine.readingBatchChars=12000;
  try{await engine.startReading(f.book.id);engine.quiet(true);engine.observing(true);await engine.observe(f.book.id,f.book.text.slice(f.book.chapters[1].start,f.book.chapters[3].end),'body','engineering');assert.equal(calls,packed?1:3);assert.ok(covers(f.book.prepared,{start:0,end:f.book.chapters[3].end}));assert.equal(f.state.chats.length,0);if(packed)assert.deepEqual(f.state.memories.at(-1)!.readingStage,[{start:f.book.chapters[1].start,end:f.book.chapters[3].end}]);}finally{engine.stop();await harness.dispose();}
 }
});

test('合批理解在发布失败后保留完整草稿，改回逐章仍复用整批且不重新请求',async()=>{
 const f=await fixture();let calls=0,fail=true;
 const engine=new ReadingEngine(f.state,{async save(s){if(fail&&s.books[0].prepared.some(r=>r.end>f.book.chapters[0].end))throw Error('batch commit unavailable');}},{async complete(_s,m){calls++;assert.ok(!JSON.stringify(m).includes('FUTURE-BATCH-SECRET'));return{content:JSON.stringify({reply:'',thoughts:[],readingBrief:'当轮工程记录已处理。'}),input:10,output:10,estimated:false,elapsedMs:1};}});engine.readingBatchChars=12000;
 try{await engine.startReading(f.book.id);engine.quiet(true);engine.observing(true);await assert.rejects(engine.observe(f.book.id,f.book.text.slice(f.book.chapters[1].start,f.book.chapters[3].end),'body','engineering'),/batch commit unavailable/);assert.equal(calls,1);assert.equal(f.state.memories.length,0);assert.equal(f.book.prepared[0].end,f.book.chapters[0].end);assert.deepEqual(f.state.readingDrafts![0].ranges,[{start:f.book.chapters[1].start,end:f.book.chapters[3].end}]);fail=false;engine.readingBatchChars=undefined;await engine.prepare(f.book.id);assert.equal(calls,1);assert.equal(f.state.readingDrafts!.length,0);assert.ok(covers(f.book.prepared,{start:0,end:f.book.chapters[3].end}));assert.equal(f.state.chats.length,0);}finally{engine.stop();}
});
