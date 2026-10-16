import {test} from 'node:test';
import assert from 'node:assert/strict';
import {importBook} from '../src/core/books.ts';
import {correctMemory,evidence,forgetMemory,isCurrentMemory,usableMemories} from '../src/core/context.ts';
import {restoreBackup} from '../src/core/backup.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import {initialState} from '../src/core/state.ts';
import type {ModelPort,Store} from '../src/core/types.ts';

const store:Store={async load(){return undefined;},async save(){}};

test('长看法仅更正指定文字时保留其余全文、空白和历史依赖',async()=>{
 const {state}=await fixture(),original=state.memories[0];original.kind='opinion';
 original.text='  \r\n'+('待核对条件继续保留。'.repeat(240))+'物件A\r\n  ';
 const before=original.text,after=before.replace('物件A','物件B');
 const revision=correctMemory(state,original.id,after);
 assert.equal(revision.text,after);assert.equal(original.text,before);assert.equal(original.replacedBy,revision.id);
 assert.equal(state.memories.find(m=>m.id==='derived')!.invalidatedBy,revision.id);
 assert.throws(()=>correctMemory(state,revision.id,'检'.repeat(12001)),/12000/);
});
async function fixture(){
 const state=initialState(),book=await importBook('更正核查','第一章 记录\n甲持有物件A。\n第二章 后续\nFUTURE-REVISION-SECRET');
 book.known=[{start:0,end:book.chapters[1].start}];book.prepared=[...book.known];book.position=book.known[0].end;state.books=[book];state.settings.services[0].enabled=true;
 const refs=[evidence(book,book.known[0])];
 state.conversations.push({id:'topic',bookId:book.id,title:'物件记录',manualTitle:false,start:0,end:book.position,createdAt:0,kind:'discussion'});
 state.memories.push({id:'root',bookId:book.id,partnerId:'default',kind:'story',text:'旧的物件记录',evidence:refs,parents:[],chatIds:[],createdAt:1,forgotten:false,source:'reading'});
 state.memories.push({...state.memories[0],id:'derived',text:'由旧记录推出的判断',parents:['root']});
 state.chats.push({id:'reply',bookId:book.id,sessionId:'topic',role:'assistant',text:'当时基于旧记录的回答',evidence:refs,createdAt:2,excluded:false,memoryIds:['derived'],contextChatIds:[]});
 state.memories.push({...state.memories[0],id:'via-chat',text:'从旧回答形成的另一判断',parents:[],chatIds:['reply']});
 return {state,book,refs};
}

test('更正递归停用旧判断和旧回答上下文，保留历史、原文、权限及无关记录',async()=>{
 const {state,book}=await fixture(),raw=book.text,known=JSON.stringify(book.known);
 state.memories.push({...state.memories[0],id:'unrelated',text:'无关的独立理解',parents:[]});
 const revision=correctMemory(state,'root','用户对物件记录的更正');
 assert.deepEqual(usableMemories(state,book).map(m=>m.id),['unrelated',revision.id]);
 assert.equal(state.chats[0].text,'当时基于旧记录的回答');assert.equal(state.chats[0].excluded,false);assert.equal(state.chats[0].outdatedBy,revision.id);
 assert.equal(state.memories[0].text,'旧的物件记录');assert.equal(state.memories[0].forgotten,false);
 assert.equal(revision.source,'correction');assert.deepEqual(revision.parents,[]);assert.deepEqual(revision.chatIds,[]);
 assert.equal(book.text,raw);assert.equal(JSON.stringify(book.known),known);
 const future={...state.memories[0],id:'future',text:'未来记录',replacedBy:undefined,evidence:[evidence(book,{start:book.position,end:book.text.length})]};state.memories.push(future);
 const futureRevision=correctMemory(state,'future','未来更正内容');assert.ok(!usableMemories(state,book).some(m=>m.id===futureRevision.id));
});

test('后来的事实更正不向输入聊天倒流，早期认识与真实交流保留，实际派生回答仍停用',async()=>{
 const {state,book,refs}=await fixture();
 const early={...state.memories[0],id:'early',text:'早期独立登记认识',createdAt:0,parents:[],chatIds:['old-user']};state.memories.push(early);
 const oldUser={id:'old-user',bookId:book.id,sessionId:'topic',role:'user' as const,text:'早期登记交流',evidence:refs,createdAt:0,excluded:false};
 const oldReply={...oldUser,id:'old-reply',role:'assistant' as const,text:'基于早期登记的回答',memoryIds:['early'],contextChatIds:['old-user']};
 state.chats.unshift(oldUser,oldReply);state.memories.find(m=>m.id==='root')!.chatIds=['old-user','old-reply'];
 const texts=state.chats.map(c=>c.text),revision=correctMemory(state,'root','后来这条记录需要更正');
 assert.equal(oldUser.outdatedBy,undefined);assert.equal(oldReply.outdatedBy,undefined);
 assert.equal(early.invalidatedBy,undefined);assert.ok(isCurrentMemory(early));assert.deepEqual(state.chats.map(c=>c.text),texts);
 assert.equal(state.memories.find(m=>m.id==='derived')!.invalidatedBy,revision.id);
 assert.equal(state.chats.find(c=>c.id==='reply')!.outdatedBy,revision.id);
 assert.equal(state.memories.find(m=>m.id==='via-chat')!.invalidatedBy,revision.id);
 // Existing installations may have persisted the old reverse-edge result.
 oldUser.outdatedBy=revision.id;oldReply.outdatedBy=revision.id;early.invalidatedBy=revision.id;
 const restored=await restoreBackup(JSON.stringify(state),initialState());
 assert.equal(restored.chats.find(c=>c.id==='old-user')!.outdatedBy,undefined);assert.ok(isCurrentMemory(restored.memories.find(m=>m.id==='early')!));
 assert.equal(restored.memories.find(m=>m.id==='derived')!.invalidatedBy,revision.id);
});

test('更正取消在途回答，后续模型取得用户更正来源且不重新输入旧回答',async()=>{
 const {state,book}=await fixture(),seen:string[]=[];
 let enter!:()=>void,release!:()=>void;
 const entered=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);
 const model:ModelPort={async complete(_service,messages){seen.push(JSON.stringify(messages));if(seen.length===1){enter();await gate;}return {content:JSON.stringify({reply:'本轮回答',thoughts:[{kind:'opinion',text:'本轮判断'}],wantsLong:false}),input:10,output:10,estimated:false,elapsedMs:1};}};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id);
 const pending=engine.ask(book.id,'回顾物件记录',false,'topic');await entered;
 await engine.correctMemory('root','用户对物件记录的更正');release();await assert.rejects(pending);
 assert.equal(state.memories.some(m=>m.text==='本轮判断'),false);
 await engine.ask(book.id,'重新讨论物件',false,'topic');
 assert.ok(seen[1].includes('用户对物件记录的更正'));assert.ok(seen[1].includes('correction'));
 assert.ok(!seen[1].includes('当时基于旧记录的回答'));assert.ok(!seen[1].includes('由旧记录推出的判断'));assert.ok(!seen[1].includes('FUTURE-REVISION-SECRET'));
 const added=state.memories.find(m=>m.text==='本轮判断')!;
 assert.ok(state.chats.at(-1)?.memoryIds?.includes(added.id));
 await engine.correctMemory(added.id,'对此轮判断的更正');assert.ok(state.chats.at(-1)?.outdatedBy);
 engine.stop();
});

test('旧备份与冲突备份不能复活本机更正前记录，新设备保留更正关系',async()=>{
 const {state,book}=await fixture(),old=JSON.stringify(state),branch=structuredClone(state);
 const alternative=correctMemory(branch,'root','备份分支上的旧更正');
 const first=correctMemory(state,'root','本机第一次更正'),second=correctMemory(state,first.id,'本机第二次更正');
 for(const snapshot of [old,JSON.stringify(branch)]){
  const restored=await restoreBackup(snapshot,state);
  assert.deepEqual(usableMemories(restored,book).map(m=>m.id),[second.id]);
  assert.ok(restored.chats[0].outdatedBy);assert.equal(restored.settings.services[0].enabled,false);
  assert.equal(restored.memories.find(m=>m.id===alternative.id)?.invalidatedBy, snapshot===old ? undefined : first.id);
 }
 const fresh=await restoreBackup(JSON.stringify(state),initialState());
 assert.deepEqual(usableMemories(fresh,book).map(m=>m.id),[second.id]);
 const invalid=structuredClone(state);invalid.memories.find(m=>m.id===second.id)!.correctionOf='missing';
 await assert.rejects(restoreBackup(JSON.stringify(invalid),initialState()),/更正关联/);
});

test('忘记更正后的事情也停用其旧版本，恢复旧备份不能带回',async()=>{
 const {state,book}=await fixture(),old=JSON.stringify(state);
 const revised=correctMemory(state,'root','用户更新后的记录');forgetMemory(state,revised.id);
 assert.ok(state.memories.every(m=>!isCurrentMemory(m)));assert.ok(state.memories.find(m=>m.id==='root')!.forgotten);
 assert.ok(state.forgotten.some(f=>f.text==='旧的物件记录'));assert.ok(state.chats[0].excluded);
 const restored=await restoreBackup(old,state);assert.equal(usableMemories(restored,book).length,0);
});
