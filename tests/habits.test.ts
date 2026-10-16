import {test} from 'node:test';
import assert from 'node:assert/strict';
import {importBook} from '../src/core/books.ts';
import {correctMemory,deleteChat,evidence,forgetMemory} from '../src/core/context.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import {currentHabits,forgetHabit,habitContext,planHabit,planInputHabit,reconcileHabits,stagedHabits} from '../src/core/habits.ts';
import {restoreBackup} from '../src/core/backup.ts';
import {initialState} from '../src/core/state.ts';
import {reviseTranscript} from '../src/core/transcripts.ts';
import type {ModelPort,Store} from '../src/core/types.ts';

async function fixture(){
 const state=initialState();
 for(const [title,text] of [['甲资料','第一章 登记\nFIRST-BOOK-PRIVATE-SENTINEL'],['乙资料','第一章 核对\n项目编号BX，本页仅说明编号。']]){const b=await importBook(title,text);b.known=[{start:0,end:b.text.length}];b.prepared=[...b.known];b.position=b.text.length;state.books.push(b);}
 state.settings.services[0].enabled=true;return state;
}
const store:Store={async load(){return undefined;},async save(){}};

test('仅独立明确的日常要求进入固定习惯，临时请求、书内引用和具体人物评价不提升到跨书',async()=>{
 const state=await fixture(),source={bookId:state.books[0].id,chatId:'user'};
 assert.equal(planInputHabit(state,'请记住：以后回复简短些。',source).added[0]?.value,'brief');
 assert.equal(planInputHabit(state,'我希望解释详细一些',source).added[0]?.value,'expanded');
 assert.equal(planInputHabit(state,'以后不要一直追问我',source).added[0]?.value,'sparse');
 for(const text of ['这次回复简短些','这本书我喜欢简短回复','作者说“以后回复简短些”','以后回复简短些？','我喜欢这个人物','请记住：以后回复简短些。甲书角色代号ABC','本次不要记住：以后回复简短些'])assert.deepEqual(planInputHabit(state,text,source).ids,[]);
});

test('切换作品只传固定习惯值，不携带原书文字、来源聊天或人物内容',async()=>{
 const state=await fixture(),[a,b]=state.books;let calls=0;
 const model:ModelPort={async complete(service,messages){calls++;
  if(calls===2){const sent=JSON.stringify(messages);assert.ok(sent.includes('简短为主'));assert.equal(sent.includes('FIRST-BOOK-PRIVATE-SENTINEL'),false);assert.equal(sent.includes('sourceBookId'),false);}
  return {content:JSON.stringify({reply:calls===1?'已保存相处要求。':'项目编号为BX。',thoughts:[],replyBasis:{memoryIds:[],chatIds:[],habitIds:[]}}),input:10,output:10,estimated:false,elapsedMs:1};
 }};
 const engine=new ReadingEngine(state,store,model);await engine.start(a.id);await engine.ask(a.id,'请记住：以后回复简短些。');
 assert.equal(currentHabits(state).length,1);assert.equal(state.chats.at(-1)?.memoryResult?.status,'saved');
 await engine.start(b.id);await engine.ask(b.id,'记录中的编号是什么？');assert.equal(calls,2);engine.stop();
});

test('当前习惯更新时保留无关书中判断，忘记仍沿完整接触关系退出派生记忆',async()=>{
 let state=await fixture();state=stagedHabits(state,planHabit(state,'replyLength','brief'));const old=currentHabits(state)[0],b=state.books[1];
 state.memories.push({id:'fact',bookId:b.id,partnerId:state.partnerId,kind:'story',text:'编号为BX',evidence:[evidence(b,b.known[0])],parents:[],chatIds:[],createdAt:1,forgotten:false,source:'reading',habitIds:[old.id],basis:{memoryIds:[],chatIds:[],habitIds:[]}});
 state.memories.push({...state.memories[0],id:'personal',kind:'user',text:'读者倾向短回复',basis:{memoryIds:[],chatIds:[],habitIds:[old.id]}});
 state=stagedHabits(state,planHabit(state,'replyLength','expanded'));
 assert.equal(state.memories[0].invalidatedBy,undefined);assert.equal(state.memories[1].invalidatedBy,old.id);
 assert.deepEqual(currentHabits(state).map(h=>h.value),['expanded']);
 forgetHabit(state,currentHabits(state)[0].id);assert.equal(currentHabits(state).length,0);assert.ok(state.memories.every(m=>m.forgotten));
});

test('单纯删除来源聊天保留习惯，转写更正和忘记来源记忆分别使旧习惯失效',async()=>{
 const state=await fixture(),book=state.books[0],source={bookId:book.id,chatId:'voice'};
 state.conversations.push({id:'s',bookId:book.id,title:'讨论',start:0,end:book.position,createdAt:1,manualTitle:false});
 state.chats.push({id:'voice',bookId:book.id,sessionId:'s',role:'user',text:'以后回复简短些',input:'voice',createdAt:1,evidence:[evidence(book,book.known[0])],excluded:false});
 let staged=stagedHabits(state,planInputHabit(state,state.chats[0].text,source));
 const deleted=structuredClone(staged);deleteChat(deleted,'voice');reconcileHabits(deleted);assert.equal(currentHabits(deleted).length,1);
 reviseTranscript(staged,'voice','这次回复简短些');assert.equal(currentHabits(staged).length,0);
 staged=stagedHabits(state,planInputHabit(state,state.chats[0].text,source));
 staged.memories.push({id:'m',bookId:book.id,partnerId:state.partnerId,kind:'user',text:'以后回复简短些',evidence:[evidence(book,book.known[0])],parents:[],chatIds:['voice'],createdAt:2,forgotten:false,source:'conversation'});
 const corrected=structuredClone(staged);correctMemory(corrected,'m','该表达只适用于当次');assert.equal(currentHabits(corrected).length,0);
 assert.equal(corrected.chats[0].outdatedBy,undefined);
 const unrelated=structuredClone(staged);unrelated.memories[0].text='用户年龄为十八岁';correctMemory(unrelated,'m','用户年龄为十九岁');assert.equal(currentHabits(unrelated).length,1);
 forgetMemory(staged,'m');assert.equal(currentHabits(staged).length,0);
});

test('恢复旧备份不复活被改写或忘记的习惯，新设备可恢复有效习惯与引用',async()=>{
 let state=await fixture();state=stagedHabits(state,planHabit(state,'replyLength','brief'));const old=JSON.stringify(state);
 state=stagedHabits(state,planHabit(state,'replyLength','expanded'));
 const restored=await restoreBackup(old,state);assert.deepEqual(currentHabits(restored).map(h=>h.value),['expanded']);
 const migrated=await restoreBackup(JSON.stringify(restored),initialState());assert.deepEqual(habitContext(migrated),habitContext(restored));
 forgetHabit(state,currentHabits(state)[0].id);assert.equal(currentHabits(await restoreBackup(old,state)).length,0);
 const bad=JSON.parse(old);bad.habits[0].value='FIRST-BOOK-PRIVATE-SENTINEL';await assert.rejects(restoreBackup(JSON.stringify(bad),initialState()),/相处习惯记录/);
});

test('临时后文与不要记住不会写通用习惯，磁盘失败不会宣称已保存',async()=>{
 const state=await fixture(),book=state.books[0];let fail=false;
 const model:ModelPort={async complete(){return {content:'{"reply":"收到当前要求。","thoughts":[]}',input:10,output:10,estimated:false,elapsedMs:1};}};
 const engine=new ReadingEngine(state,{...store,async save(s){if(fail&&s.habits?.length)throw new Error('磁盘失败');}},model);
 await engine.start(book.id);await engine.ask(book.id,'本次不要记住：以后回复简短些');assert.equal(currentHabits(state).length,0);
 await engine.askWithFuture(book.id,'以后回复简短些',book.known[0]);assert.equal(currentHabits(state).length,0);
 fail=true;await assert.rejects(engine.ask(book.id,'以后回复简短些'),/磁盘失败/);assert.equal(currentHabits(state).length,0);assert.equal(state.chats.at(-1)?.delivery,'failed');engine.stop();
});
