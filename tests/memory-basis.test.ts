import {test} from 'node:test';
import assert from 'node:assert/strict';
import {importBook} from '../src/core/books.ts';
import {correctMemory,evidence,forgetMemory,isCurrentMemory,usableMemories} from '../src/core/context.ts';
import {restoreBackup} from '../src/core/backup.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import {parseReadingReply} from '../src/core/model.ts';
import {initialState} from '../src/core/state.ts';
import type {ModelPort,Store} from '../src/core/types.ts';

const store:Store={async load(){return undefined;},async save(){}};
async function fixture(){
 const state=initialState(),book=await importBook('来源关联核查','第一章 当前\n物件A登记给甲。物件B登记给乙。\n第二章 未读\nFUTURE-BASIS-928');
 book.position=book.chapters[1].start;book.known=[{start:0,end:book.position}];book.prepared=[...book.known];state.books=[book];state.settings.services[0].enabled=true;
 for(const [id,text] of [['a','已有记忆甲'],['b','已有记忆乙']]) state.memories.push({id,bookId:book.id,partnerId:'default',kind:'opinion',text,evidence:[evidence(book,book.known[0])],parents:[],chatIds:[],createdAt:1,forgotten:false,source:'reading'});
 return {state,book};
}
const basis=(...memoryIds:string[])=>({memoryIds,chatIds:[]});

test('同轮提供两条旧记忆，更正只沿声明的关联停用，遗忘仍覆盖完整接触路径',async()=>{
 const {state,book}=await fixture(),seen:string[]=[];
 const model:ModelPort={async complete(_s,m){seen.push(JSON.stringify(m));return {content:JSON.stringify({reply:'本轮汇总',replyBasis:basis('a','b'),thoughts:[
  {kind:'opinion',text:'沿甲形成的判断',basis:basis('a')},
  {kind:'opinion',text:'沿乙形成的判断',basis:basis('b')},
  {kind:'story',text:'直接阅读形成的新记录',basis:basis()}
 ],wantsLong:false}),input:10,output:10,estimated:false,elapsedMs:1};}};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id);await engine.ask(book.id,'检查两项记录');engine.stop();
 assert.ok(seen[0].includes('已有记忆甲')&&seen[0].includes('已有记忆乙'));assert.ok(!seen[0].includes('FUTURE-BASIS-928'));
 const byText=(text:string)=>state.memories.find(m=>m.text===text)!;
 assert.deepEqual(new Set(byText('沿乙形成的判断').parents),new Set(['a','b']));assert.deepEqual(byText('沿乙形成的判断').basis,basis('b'));
 const corrected=correctMemory(state,'a','用户更正甲的记录');
 assert.ok(!isCurrentMemory(byText('沿甲形成的判断')));assert.ok(isCurrentMemory(byText('沿乙形成的判断')));assert.ok(isCurrentMemory(byText('直接阅读形成的新记录')));
 assert.ok(state.chats.find(c=>c.role==='assistant')!.outdatedBy);
 const restored=await restoreBackup(JSON.stringify(state),initialState());assert.ok(restored.memories.find(m=>m.text==='沿乙形成的判断'&&isCurrentMemory(m)));
 forgetMemory(state,corrected.id);
 assert.ok(byText('沿乙形成的判断').forgotten&&byText('直接阅读形成的新记录').forgotten);
 assert.ok(isCurrentMemory(state.memories.find(m=>m.id==='b')!));
});

test('伪造、缺失或不完整的关联回退到完整依赖，不能通过错ID躲过更正',async()=>{
 const {state,book}=await fixture();
 const model:ModelPort={async complete(){return {content:JSON.stringify({reply:'回应',replyBasis:basis('不存在的跨书ID'),thoughts:[
  {kind:'opinion',text:'无效关联',basis:basis('不存在的跨书ID')},
  {kind:'opinion',text:'缺少聊天数组',basis:{memoryIds:[]}},
  {kind:'opinion',text:'未声明关联'}
 ],wantsLong:false}),input:10,output:10,estimated:false,elapsedMs:1};}};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id);await engine.ask(book.id,'检查');engine.stop();
 assert.ok(state.memories.slice(2).every(m=>m.basis===undefined));assert.equal(state.chats.at(-1)?.basis,undefined);
 correctMemory(state,'a','更正甲');assert.ok(state.memories.filter(m=>m.source==='conversation').every(m=>!!m.invalidatedBy));
 const parsed=parseReadingReply(JSON.stringify({reply:'',thoughts:[{kind:'story',text:'重复引用',basis:basis('a','a')}],wantsLong:false}));
 assert.deepEqual(parsed.thoughts[0].basis,basis('a'));
});

test('模型声明的空关联不缩小资料权限，备份中的非接触范围ID会拒绝',async()=>{
 const {state,book}=await fixture();
 state.memories.push({...state.memories[0],id:'isolated',text:'带完整资料范围的判断',parents:['a','b'],basis:basis()});
 book.known=[{start:0,end:12}];book.position=12;book.prepared=[...book.known];
 assert.ok(!usableMemories(state,book).some(m=>m.id==='isolated'));
 const bad=structuredClone(state);bad.memories.find(m=>m.id==='isolated')!.basis=basis('not-in-input');
 await assert.rejects(restoreBackup(JSON.stringify(bad),initialState()),/来源关联/);
});

test('遗忘可穿过记忆到聊天再到记忆的多层路径，即使声明为空也停用',async()=>{
 const {state,book}=await fixture(),refs=state.memories[0].evidence;
 state.chats.push({id:'c1',bookId:book.id,sessionId:'s',role:'assistant',text:'第一层回复',evidence:refs,excluded:false,createdAt:2,memoryIds:['a'],contextChatIds:[],basis:basis()});
 state.memories.push({...state.memories[0],id:'m2',text:'第二层记忆',parents:[],chatIds:['c1'],basis:basis()});
 state.chats.push({...state.chats[0],id:'c2',text:'第二层回复',memoryIds:['m2']});
 state.memories.push({...state.memories[0],id:'m3',text:'第三层记忆',parents:[],chatIds:['c2'],basis:basis()});
 forgetMemory(state,'a');
 assert.ok(state.memories.filter(m=>m.id!=='b').every(m=>m.forgotten));assert.ok(state.chats.every(c=>c.excluded));assert.ok(isCurrentMemory(state.memories[1]));
});
