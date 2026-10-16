import {test} from 'node:test';
import assert from 'node:assert/strict';
import {importBook} from '../src/core/books.ts';
import {deleteChat,isCurrentMemory} from '../src/core/context.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import {restoreBackup} from '../src/core/backup.ts';
import {reviseTranscript} from '../src/core/transcripts.ts';
import {initialState} from '../src/core/state.ts';
import type {ModelPort,Store} from '../src/core/types.ts';

const store:Store={async load(){return undefined;},async save(){}};
const answer=(text:string)=>({content:JSON.stringify({reply:text,thoughts:[{kind:'shared',text}],wantsLong:false}),input:10,output:10,estimated:false,elapsedMs:1});
async function fixture(){
 const state=initialState(),book=await importBook('转写核查','第一章 当前\n甲持有物件A，乙持有物件B。\n第二章 后续已读\n本章是较后位置的记录。\n第三章 未读\nFUTURE-VOICE-928');
 book.position=book.chapters[1].start;book.known=[{start:0,end:book.position}];book.prepared=[...book.known];state.books=[book];state.settings.services[0].enabled=true;
 return {state,book};
}

test('语音更正退出错误表达及派生认识，保留历史、原话题和表达位置',async()=>{
 const {state,book}=await fixture(),seen:string[]=[];
 const model:ModelPort={async complete(_s,m){seen.push(JSON.stringify(m));return answer(seen.length===1?'错误转写衍生理解 BAD-VOICE-928':'按更正转写形成的理解');}};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id);
 const span={start:0,end:book.position},topic=engine.session!.id;
 await engine.askAt(book.id,'错误转写 BAD-VOICE-928',span,topic,engine.session!.generation);
 const original=state.chats[0],oldMemory=state.memories[0],before=JSON.stringify(book.known);
 book.known=[{start:0,end:book.chapters[2].start}];book.position=book.chapters[2].start;const position=book.position,known=JSON.stringify(book.known);
 await engine.correctTranscript(original.id,'更正后的表达 GOOD-VOICE-928');
 assert.equal(original.text,'错误转写 BAD-VOICE-928');assert.ok(original.outdatedBy);assert.ok(!original.excluded);
 assert.equal(oldMemory.forgotten,false);assert.ok(!isCurrentMemory(oldMemory));
 const revised=state.chats.find(c=>c.corrects===original.id)!;assert.equal(revised.sessionId,topic);assert.deepEqual(revised.evidence,original.evidence);assert.equal(revised.input,'voice');
 assert.equal(book.position,position);assert.equal(JSON.stringify(book.known),known);assert.notEqual(known,before);
 assert.ok(seen[1].includes('GOOD-VOICE-928'));assert.ok(!seen[1].includes('BAD-VOICE-928'));assert.ok(!seen[1].includes('FUTURE-VOICE-928'));assert.equal(engine.session!.id,topic);
 engine.stop();
});

test('在回复生成中更正转写会取消旧结果，只回应更正后的表达',async()=>{
 const {state,book}=await fixture();let calls=0,enter!:()=>void,release!:()=>void;
 const entered=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);
 const model:ModelPort={async complete(){calls++;if(calls===1){enter();await gate;return answer('迟到的错误认识');}return answer('已更正的有效认识');}};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id);
 const work=engine.askAt(book.id,'旧转写',book.known[0],engine.session!.id,engine.session!.generation);await entered;
 const oldId=state.chats[0].id,corrected=engine.correctTranscript(oldId,'新转写');release();await assert.rejects(work);await corrected;
 assert.equal(state.chats.filter(c=>c.role==='assistant').length,1);assert.ok(state.memories.every(m=>!m.text.includes('迟到')));assert.equal(state.chats[0].delivery,'stopped');engine.stop();
});

test('恢复旧备份保留转写更正，新设备仍识别错误认识已退出',async()=>{
 const {state,book}=await fixture();const model:ModelPort={async complete(){return answer('测试派生认识');}};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id);await engine.askAt(book.id,'错误转写',book.known[0],engine.session!.id,engine.session!.generation);
 const original=state.chats[0],old=JSON.stringify(state);await engine.correctTranscript(original.id,'正确转写');engine.stop();
 const restored=await restoreBackup(old,state),revised=restored.chats.find(c=>c.corrects===original.id)!;
 assert.equal(revised.text,'正确转写');assert.equal(revised.delivery,'stopped');assert.ok(restored.chats.find(c=>c.id===original.id)?.outdatedBy);assert.ok(restored.memories.every(m=>!isCurrentMemory(m)));
 const fresh=await restoreBackup(JSON.stringify(state),initialState());assert.ok(fresh.chats.find(c=>c.id===original.id)?.outdatedBy);assert.equal(fresh.transcriptRevisions?.length,1);
 const bad=structuredClone(state);bad.transcriptRevisions![0].bookId='another-book';await assert.rejects(restoreBackup(JSON.stringify(bad),initialState()),/转写更正/);
});

test('删除语音聊天不删除更正标记，旧备份中的错误转写仍不能重新使用',async()=>{
 const {state,book}=await fixture();const model:ModelPort={async complete(){return answer('由错误转写形成的理解');}};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id);await engine.askAt(book.id,'旧转写',book.known[0],engine.session!.id,engine.session!.generation);
 const original=state.chats[0],old=JSON.stringify(state),replacement=reviseTranscript(state,original.id,'更正转写');
 deleteChat(state,original.id);deleteChat(state,replacement.id);
 await restoreBackup(JSON.stringify(state),initialState());
 const restored=await restoreBackup(old,state);assert.ok(restored.chats.find(c=>c.id===original.id)?.outdatedBy);assert.ok(!restored.chats.some(c=>c.id===replacement.id));assert.ok(restored.memories.every(m=>!isCurrentMemory(m)));engine.stop();
});

test('冲突备份沿用本机转写版本，旧分支退出，文字消息不能冒充语音更正',async()=>{
 const {state,book}=await fixture();const model:ModelPort={async complete(){return answer('测试理解');}};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id);await engine.askAt(book.id,'原转写',book.known[0],engine.session!.id,engine.session!.generation);
 const original=state.chats[0],branch=structuredClone(state),other=reviseTranscript(branch,original.id,'备份分支转写'),local=reviseTranscript(state,original.id,'本机转写');
 const restored=await restoreBackup(JSON.stringify(branch),state);
 assert.ok(restored.chats.find(c=>c.id===other.id)?.outdatedBy);assert.ok(!restored.chats.find(c=>c.id===local.id)?.outdatedBy);assert.equal(restored.chats.find(c=>c.id===original.id)?.replacedBy,local.id);
 await engine.ask(book.id,'普通文字发言');const typed=state.chats.find(c=>c.text==='普通文字发言')!;
 assert.throws(()=>reviseTranscript(state,typed.id,'不能通过语音入口更改'),/有效的语音/);engine.stop();
});
