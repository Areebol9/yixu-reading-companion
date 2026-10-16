import {test} from 'node:test';
import assert from 'node:assert/strict';
import {importBook} from '../src/core/books.ts';
import {evidence} from '../src/core/context.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import {initialState} from '../src/core/state.ts';
import {planMemories} from '../src/core/memory-plan.ts';
import {restoreBackup} from '../src/core/backup.ts';
import type {ModelPort,ReadingReply,State,Store} from '../src/core/types.ts';

const quietStore:Store={async load(){return undefined;},async save(){}};
const response=(reply:string,thoughts:ReadingReply['thoughts']=[],reinforce:string[]=[])=>({content:JSON.stringify({reply,thoughts,reinforce,wantsLong:false}),input:10,output:10,estimated:false,elapsedMs:1});
async function fixture(){
 const state=initialState(),book=await importBook('保存核查','第一章 当前\n本页登记甲有六件物品，已取出两件。\n第二章 未读\nFUTURE-SAVE-928');
 book.position=book.chapters[1].start;book.known=[{start:0,end:book.position}];book.prepared=[...book.known];state.books=[book];state.settings.services[0].enabled=true;
 return {state,book};
}

test('明确要求记住而模型仅口头答应时补一次处理，再次确认复用已有记忆',async()=>{
 const {state,book}=await fixture();let calls=0;
 const model:ModelPort={async complete(){calls++;if(calls===1)return response('记住了。');if(calls===2)return response('记下了这个结果。',[{kind:'story',text:'甲现有四件物品。'}]);return response('这个结果已有记录。',[],[state.memories[0].id]);}};
 const engine=new ReadingEngine(state,quietStore,model);await engine.start(book.id);await engine.ask(book.id,'请记住这个结果：甲现有四件。');
 assert.equal(calls,2);assert.equal(state.memories.length,1);assert.equal(state.chats.at(-1)?.memoryResult?.status,'saved');assert.equal(state.chats.filter(c=>c.role==='assistant').length,1);
 const memoryId=state.memories[0].id;await engine.ask(book.id,'请记住刚才的甲现有四件，不用重复新增。');
 assert.equal(state.memories.length,1);assert.equal(state.memories[0].id,memoryId);assert.equal(state.chats.at(-1)?.memoryResult?.status,'reused');engine.stop();
 const restored=await restoreBackup(JSON.stringify(state),initialState());assert.deepEqual(restored.chats.at(-1)?.memoryResult,{status:'reused',memoryIds:[memoryId]});
 restored.chats.at(-1)!.memoryResult!.memoryIds=['missing'];await assert.rejects(restoreBackup(JSON.stringify(restored),initialState()),/实际记录/);
});

test('反复空口声称记住只修复一次，未发布的承诺不进入聊天和记忆',async()=>{
 const {state,book}=await fixture();let calls=0;
 const model:ModelPort={async complete(){calls++;return response('已经记住了。');}};
 const engine=new ReadingEngine(state,quietStore,model);await engine.start(book.id);
 await assert.rejects(engine.ask(book.id,'请记住甲的结果'),/有效记忆/);
 assert.equal(calls,2);assert.equal(state.memories.length,0);assert.equal(state.chats.filter(c=>c.role==='assistant').length,0);assert.equal(state.chats[0].delivery,'failed');engine.stop();
});

test('沿用只接受本轮获准的记忆，不能引用未来或未知记录，新事实独立保留',async()=>{
 const {state,book}=await fixture(),refs=[evidence(book,book.known[0])];
 state.memories.push({id:'known',bookId:book.id,partnerId:'default',kind:'story',text:'甲入库六件。',evidence:refs,parents:[],chatIds:[],createdAt:1,forgotten:false,source:'reading'});
 state.memories.push({...state.memories[0],id:'future',text:'未来结果',evidence:[evidence(book,{start:book.position,end:book.text.length})]});
 const result:ReadingReply={reply:'',thoughts:[{kind:'story',text:'已取出两件。'},{kind:'story',text:'已取出两件。'}],reinforce:['known','future','unknown'],wantsLong:false};
 const plan=planMemories(state,book,result,refs,['known','future'],[],'reading');
 assert.deepEqual(plan.reused,['known']);assert.equal(plan.added.length,1);assert.equal(state.memories.length,2);assert.equal(state.memories[0].text,'甲入库六件。');
});

test('本地结果写入失败不显示已保存，重试保持单条问题并真正写入',async()=>{
 const {state,book}=await fixture();let fail=true,snapshot:State|undefined;
 const store:Store={async load(){return snapshot;},async save(s){if(fail&&s.chats.some(c=>c.role==='assistant'))throw new Error('模拟磁盘写入失败');snapshot=structuredClone(s);}};
 const model:ModelPort={async complete(){return response('记下了结果。',[{kind:'story',text:'甲现有四件。'}]);}};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id);await assert.rejects(engine.ask(book.id,'请记住甲现有四件。'),/磁盘/);
 assert.equal(state.memories.length,0);assert.equal(state.chats.filter(c=>c.role==='assistant').length,0);assert.equal(snapshot?.memories.length,0);
 fail=false;await engine.retryQuestion(state.chats[0].id);
 assert.equal(state.chats.filter(c=>c.role==='user').length,1);assert.equal(snapshot?.memories.length,1);assert.equal(snapshot?.chats.at(-1)?.memoryResult?.status,'saved');engine.stop();
});

test('保存期间的新问题不会被旧快照覆盖，也不提前显示待保存的结果',async()=>{
 const {state,book}=await fixture();let release!:()=>void,enter!:()=>void,snapshot:State|undefined,held=false,n=0;
 const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>enter=r);
 const store:Store={async load(){return snapshot;},async save(s){const copy=structuredClone(s);if(!held&&copy.chats.some(c=>c.role==='assistant')){held=true;enter();await gate;}snapshot=copy;}};
 const model:ModelPort={async complete(){n++;return response(`回应${n}`,[{kind:'story',text:`保存条目${n}`}]);}};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id);
 const first=engine.ask(book.id,'第一条问题');await entered;
 assert.equal(state.memories.length,0);assert.equal(state.chats.filter(c=>c.role==='assistant').length,0);
 const second=engine.ask(book.id,'保存期间发出的第二条问题');await new Promise(r=>setImmediate(r));release();await Promise.all([first,second]);await engine.persist();
 assert.equal(snapshot?.memories.length,2);assert.equal(snapshot?.chats.filter(c=>c.role==='user').length,2);assert.equal(snapshot?.chats.filter(c=>c.role==='assistant').length,2);engine.stop();
});

test('结果落盘期间结束会话，最终磁盘和运行状态均不留下待展示结果',async()=>{
 const {state,book}=await fixture();let release!:()=>void,enter!:()=>void,snapshot:State|undefined,held=false;
 const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>enter=r);
 const store:Store={async load(){return snapshot;},async save(s){const copy=structuredClone(s);if(!held&&copy.chats.some(c=>c.role==='assistant')){held=true;enter();await gate;}snapshot=copy;}};
 const model:ModelPort={async complete(){return response('已完成',[{kind:'story',text:'待保存判断'}]);}};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id);const work=engine.ask(book.id,'核对记录');await entered;
 engine.stop();release();await assert.rejects(work);await engine.persist();
 assert.equal(state.memories.length,0);assert.equal(snapshot?.memories.length,0);assert.equal(snapshot?.chats.filter(c=>c.role==='assistant').length,0);
});

test('本次不记住与临时后文均不产生长期记忆，普通下轮不重新带入这段聊天',async()=>{
 const {state,book}=await fixture(),seen:string[]=[];
 const model:ModelPort={async complete(_s,m){seen.push(JSON.stringify(m));return response('本次范围内讨论。',[{kind:'user',text:'不应保存的临时信息'}]);}};
 const engine=new ReadingEngine(state,quietStore,model);await engine.start(book.id);await engine.ask(book.id,'不要记住这件事，临时信息 SKIP-MEMORY-928。');
 assert.equal(state.memories.length,0);assert.ok(state.chats.every(c=>c.excluded));assert.equal(state.chats.at(-1)?.memoryResult?.status,'not_saved');
 await engine.ask(book.id,'继续核对原文');assert.ok(!seen.at(-1)?.includes('SKIP-MEMORY-928'));
 const before=state.memories.length;await engine.askWithFuture(book.id,'请记住本次后文内容',{start:book.position,end:book.text.length});
 assert.equal(state.memories.length,before);assert.equal(state.chats.at(-1)?.memoryResult?.status,'temporary');engine.stop();
});

test('前文准备的结果保存失败时不把片段标为已完成',async()=>{
 const {state,book}=await fixture();book.prepared=[];
 const store:Store={async load(){return undefined;},async save(s){if(s.books[0].prepared.length)throw new Error('准备结果保存失败');}};
 const model:ModelPort={async complete(){return response('',[{kind:'story',text:'阶段准备结果'}]);}};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id);await assert.rejects(engine.prepare(book.id),/保存失败/);
 assert.deepEqual(book.prepared,[]);assert.equal(state.memories.length,0);engine.stop();
});

test('含密钥的备份恢复后不把密钥包带入普通状态和默认再导出',async()=>{
 const {state}=await fixture();
 const raw=JSON.stringify({...state,secrets:{wechat:'TEST-TRANSFER-ONLY-KEY-928'},exportedAt:'2026-09-28'});
 const restored=await restoreBackup(raw,initialState());
 assert.ok(!('secrets' in restored));assert.ok(!JSON.stringify(restored).includes('TEST-TRANSFER-ONLY-KEY-928'));
 assert.equal(JSON.parse(raw).secrets.wechat,'TEST-TRANSFER-ONLY-KEY-928');assert.equal(restored.settings.services[0].enabled,false);
});
