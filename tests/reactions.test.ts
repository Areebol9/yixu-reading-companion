import {test} from 'node:test';
import assert from 'node:assert/strict';
import {importBook} from '../src/core/books.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import {initialState} from '../src/core/state.ts';
import type {ModelMessage,ModelPort,Store} from '../src/core/types.ts';

const pages=[
 '工程记录甲：设备AX登记数量为3，当前尚未移交。这一段仅用于核对增量处理及回应时机。',
 '工程记录乙：设备AX随后转交1件，结余数量变为2。继续核对更新后的登记，不把上一段状态当成当前状态。',
 '工程记录丙：复核已经结束，设备BY另有5件。这一段用于检查上一轮未表达的候选是否已经处理。'
];
const oldReply='原位置的待表达意见，尚未发送给读者。';
const store:Store={async load(){return undefined;},async save(){}};
async function fixture(){
 const state=initialState(),book=await importBook('反应调度工程资料','第一章 工程材料\n'+pages.join('\n')+'\n第二章 未读\nFUTURE-REACTION-UNREAD');
 const end=book.text.indexOf(pages[0]);book.position=end;book.known=[{start:0,end}];book.prepared=[...book.known];state.books=[book];state.settings.services[0].enabled=true;state.settings.minReadChars=1;state.settings.minReactionMs=0;
 return {state,book};
}
function packet(reply:string,thoughts:unknown[]=[]){return {content:JSON.stringify({reply,thoughts}),input:10,output:10,estimated:false,elapsedMs:1};}
function carried(messages:ModelMessage[]){return messages.map(m=>{try{return JSON.parse(m.content).undeliveredReadingReaction;}catch{return undefined;}}).find(Boolean);}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}

test('迟到反应不直接展示，下一次正常理解可依据新事实接续，完整来源仍被记录且不增加请求',async()=>{
 const {state,book}=await fixture(),entered=deferred(),release=deferred();let calls=0;const shown:string[]=[];
 const model:ModelPort={async complete(service,messages){
  calls++;assert.equal(JSON.stringify(messages).includes('FUTURE-REACTION-UNREAD'),false);
  if(calls===1){entered.resolve();await release.promise;return packet(oldReply,[{kind:'opinion',text:'初始登记有3件。'}]);}
  const candidate=carried(messages);assert.equal(candidate?.text,oldReply);assert.ok(candidate.memoryIds.length);
  return packet('按新记录更新为2件。',[{kind:'shared',text:'不应虚构双方已经讨论过旧候选。'},{kind:'opinion',text:'新记录与初始登记之间发生一次转交。'}]);
 }};
 const engine=new ReadingEngine(state,store,model);engine.onReaction=t=>shown.push(t);await engine.start(book.id);engine.observing(true);
 const first=engine.observe(book.id,pages[0]);await entered.promise;const second=engine.observe(book.id,pages[1]);release.resolve();await Promise.all([first,second]);
 assert.equal(calls,2);assert.deepEqual(shown,['按新记录更新为2件。']);assert.equal(state.chats.some(c=>c.text===oldReply),false);
 assert.equal(state.memories.some(m=>m.kind==='shared'),false);assert.ok(state.memories[1].parents.includes(state.memories[0].id));engine.stop();
});

test('新内容判断不值得表达时清空候选，之后不补发旧反应',async()=>{
 const {state,book}=await fixture(),entered=deferred(),release=deferred();let calls=0;
 const model:ModelPort={async complete(service,messages){calls++;
  if(calls===1){entered.resolve();await release.promise;return packet(oldReply);}
  if(calls===2)assert.ok(carried(messages));else assert.equal(carried(messages),undefined);
  return packet('');
 }};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id);engine.observing(true);
 const first=engine.observe(book.id,pages[0]);await entered.promise;const second=engine.observe(book.id,pages[1]);release.resolve();await Promise.all([first,second]);
 await engine.observe(book.id,pages[2]);assert.equal(calls,3);assert.equal(state.chats.length,0);engine.stop();
});

test('安静模式不积累待补发评论，恢复后只处理当前内容',async()=>{
 const {state,book}=await fixture(),entered=deferred(),release=deferred();let calls=0;
 const model:ModelPort={async complete(service,messages){calls++;assert.equal(carried(messages),undefined);if(calls===1){entered.resolve();await release.promise;}return packet(oldReply);}};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id);engine.observing(true);
 const first=engine.observe(book.id,pages[0]);await entered.promise;const second=engine.observe(book.id,pages[1]);engine.quiet(true);release.resolve();await Promise.all([first,second]);
 assert.equal(state.chats.length,0);engine.quiet(false);await engine.observe(book.id,pages[2]);assert.equal(calls,3);engine.stop();
});

test('读者明确插话后，未完成的主动反应不再抢先展示',async()=>{
 const {state,book}=await fixture(),entered=deferred(),release=deferred();let calls=0;const shown:string[]=[];
 const model:ModelPort={async complete(service,messages){calls++;if(calls===1){entered.resolve();await release.promise;return packet(oldReply);}assert.equal(carried(messages),undefined);return packet(calls===2?'回应读者的新问题。':calls===3?oldReply:'新页面登记数量已更新。');}};
 const engine=new ReadingEngine(state,store,model);engine.onReaction=t=>shown.push(t);await engine.start(book.id);engine.observing(true);
 const reading=engine.observe(book.id,pages[0]);await entered.promise;const question=engine.ask(book.id,'先核对登记编号。');release.resolve();await Promise.all([reading,question]);
 assert.equal(calls,3);assert.deepEqual(shown,[]);assert.deepEqual(state.chats.map(c=>c.text),['先核对登记编号。','回应读者的新问题。']);
 await engine.observe(book.id,pages[1]);assert.equal(calls,4);assert.deepEqual(shown,['新页面登记数量已更新。']);engine.stop();
});

test('当天收尾可重新判断尚未表达的发现，不把原草稿伪装成已发生对话',async()=>{
 const {state,book}=await fixture(),entered=deferred(),release=deferred();let calls=0;
 const model:ModelPort={async complete(service,messages){calls++;if(calls===1){entered.resolve();await release.promise;return packet(oldReply,[{kind:'opinion',text:'工程登记留待核对。'}]);}assert.ok(carried(messages));return packet('收尾时提出当前仍有价值的核对。');}};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id);engine.observing(true);
 const reading=engine.observe(book.id,pages[0]);await entered.promise;const closing=engine.finishReading(book.id);release.resolve();await Promise.all([reading,closing]);
 assert.equal(calls,2);assert.deepEqual(state.chats.map(c=>c.text),['收尾时提出当前仍有价值的核对。']);engine.stop();
});
