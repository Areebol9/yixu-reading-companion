import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState} from '../src/core/state.ts';
import {importBook} from '../src/core/books.ts';
import {correctMemory,forgetMemory} from '../src/core/context.ts';
import {planMemories} from '../src/core/memory-plan.ts';
import {restoreBackup} from '../src/core/backup.ts';
import {recoverInterruptedState} from '../src/core/startup.ts';
import {CompanionWorkspaceConflict,planWorkspace,pruneCompanionWorkspaces,workspaceFor,workspaceMaterial} from '../src/core/companion-workspace.ts';
import type {Memory,ReadingReply} from '../src/core/types.ts';

async function fixture(){
  const state=initialState(),book=await importBook('工作台工程资料','第一章 记录\n设备已移入检修室，检修员希望恢复正常运行。\n第二章 复测\n校准已完成，设备正在进行复测。');
  state.books=[book];book.known=[{start:0,end:book.text.length}];book.position=book.text.length;
  const memory=(id:string,kind:Memory['kind'],text:string):Memory=>({id,kind,text,bookId:book.id,partnerId:state.partnerId,
    evidence:[{start:0,end:book.text.length,bookId:book.id,version:book.version}],parents:[],chatIds:[],createdAt:1,forgotten:false,source:'reading'});
  const opinion=memory('understanding','opinion','检修员希望恢复正常运行。'+ '复测仍在进行。'.repeat(60)),wish=memory('wish','question','检修员希望恢复正常运行，复测能否完成？');
  state.memories=[opinion,wish];return{state,book,opinion,wish,memory};
}

test('旧状态懒建空台；成功取得的完整认识保存引用并可重启接续',async()=>{
  const {state,book,opinion,wish}=await fixture();
  assert.equal(workspaceFor(state,book).revision,0);assert.equal(state.companionWorkspaces,undefined);
  planWorkspace(state,book,{understanding:opinion.id,focus:[wish.id]},{memoryIds:[opinion.id,wish.id]},{expectedRevision:0});
  const disk=JSON.parse(JSON.stringify(state));recoverInterruptedState(disk);
  const material=workspaceMaterial(disk,disk.books[0]);
  assert.equal(material.understanding?.text,opinion.text);assert.equal(material.focus[0].text,wish.text);
  const before=JSON.stringify(state.companionWorkspaces);
  planWorkspace(state,book,undefined,{memoryIds:[]},{expectedRevision:1});assert.equal(JSON.stringify(state.companionWorkspaces),before);
  planWorkspace(state,book,{focus:[]},{memoryIds:[]},{expectedRevision:1});assert.deepEqual(workspaceFor(state,book).focusIds,[]);assert.equal(workspaceFor(state,book).understandingId,opinion.id);
});

test('目录引用不给写权限；失败新条目、错来源与旧CAS不能覆盖工作台',async()=>{
  const {state,book,opinion,wish,memory}=await fixture();
  assert.throws(()=>planWorkspace(state,book,{focus:[wish.id]},{memoryIds:[]},{expectedRevision:0}),/完整取得/);
  assert.throws(()=>planWorkspace(state,book,{understanding:'t2'},{memoryIds:[],proposalMemoryIds:{t1:opinion.id}},{expectedRevision:0}),/完整取得/);
  const background={...memory('background','opinion','独立背景看法。'),source:'background' as const};state.memories.push(background);
  assert.throws(()=>planWorkspace(state,book,{understanding:background.id},{memoryIds:[background.id]},{expectedRevision:0}),/完整取得/);
  assert.throws(()=>planWorkspace(state,book,{understanding:wish.id},{memoryIds:[wish.id]},{expectedRevision:0}),/完整取得/);
  planWorkspace(state,book,{understanding:opinion.id},{memoryIds:[opinion.id]},{expectedRevision:0});
  assert.throws(()=>planWorkspace(state,book,{focus:[wish.id]},{memoryIds:[wish.id]},{expectedRevision:0}),CompanionWorkspaceConflict);
  assert.equal(workspaceFor(state,book).understandingId,opinion.id);assert.deepEqual(workspaceFor(state,book).focusIds,[]);
});

test('撤权、遗忘和更正退出引用并阻止旧任务恢复；认识历史不自动重写',async()=>{
  const {state,book,opinion,wish}=await fixture();
  planWorkspace(state,book,{understanding:opinion.id,focus:[wish.id]},{memoryIds:[opinion.id,wish.id]},{expectedRevision:0});
  const revoked=structuredClone(state);revoked.books[0].known=[];
  assert.equal(workspaceMaterial(revoked,revoked.books[0]).understanding,undefined);
  assert.deepEqual(workspaceMaterial(revoked,revoked.books[0]).focus,[]);
  assert.equal(pruneCompanionWorkspaces(revoked),true);assert.equal(workspaceFor(revoked,revoked.books[0]).revision,2);
  assert.throws(()=>planWorkspace(revoked,revoked.books[0],{focus:[]},{memoryIds:[]},{expectedRevision:1}),CompanionWorkspaceConflict);
  forgetMemory(state,wish.id);correctMemory(state,opinion.id,'检修员愿望保留，复测结果需重新确认。');
  recoverInterruptedState(state);assert.equal(workspaceFor(state,book).understandingId,undefined);assert.deepEqual(workspaceFor(state,book).focusIds,[]);
  assert.equal(opinion.text.includes('检修员希望恢复正常运行'),true);
});

test('最终t绑定承接真实复用，完整opinion不依赖指针放宽，工作台仍须引用opinion',async()=>{
  const {state,book,opinion,wish}=await fixture();
  const reply:ReadingReply={reply:'',wantsLong:false,thoughts:[{kind:'question',text:' '+wish.text+' '},{kind:'opinion',text:'完整看法。'.repeat(1000)}],workspace:{understanding:'t2',focus:['t1']}};
  const refs=opinion.evidence,plan=planMemories(state,book,reply,refs,[],[],'reading',undefined,[],[],new Map(),undefined,{readingStrategy:'companion'});
  assert.equal(plan.proposalMemoryIds?.t1,wish.id);assert.equal(plan.proposalMemoryIds?.t2,plan.added[0].id);
  state.memories.push(...plan.added);
  planWorkspace(state,book,reply.workspace,{memoryIds:[],proposalMemoryIds:plan.proposalMemoryIds},{expectedRevision:0});
  assert.equal(workspaceMaterial(state,book).understanding?.text,reply.thoughts[1].text);
  assert.doesNotThrow(()=>planMemories(state,book,{...reply,workspace:undefined},refs,[],[],'reading'));
  assert.throws(()=>planWorkspace(state,book,{understanding:'t1'},{memoryIds:[wish.id],proposalMemoryIds:plan.proposalMemoryIds},{expectedRevision:workspaceFor(state,book).revision}));
});

test('旧备份保留当前工作台与完整认识，新备份恢复及遗忘接续有效',async()=>{
  const {state,book,opinion,wish,memory}=await fixture();
  planWorkspace(state,book,{understanding:opinion.id,focus:[wish.id]},{memoryIds:[opinion.id,wish.id]},{expectedRevision:0});
  const old=JSON.stringify(state),next=memory('next','opinion','检修已完成，伙伴接续当前复测认识。');state.memories.push(next);
  planWorkspace(state,book,{understanding:'t1',focus:[]},{memoryIds:[],proposalMemoryIds:{t1:next.id}},{expectedRevision:1});
  const restored=await restoreBackup(old,state),w=workspaceFor(restored,restored.books[0]);
  assert.equal(w.revision,2);assert.equal(w.understandingId,next.id);assert.deepEqual(w.focusIds,[]);assert.equal(workspaceMaterial(restored,restored.books[0]).understanding?.text,next.text);
  const fresh=await restoreBackup(JSON.stringify(state),initialState());assert.equal(workspaceFor(fresh,fresh.books[0]).understandingId,next.id);
  forgetMemory(state,next.id);pruneCompanionWorkspaces(state);
  const forgotten=await restoreBackup(old,state);assert.equal(workspaceFor(forgotten,forgotten.books[0]).understandingId,undefined);
  const malformed=JSON.parse(old);malformed.companionWorkspaces[0].reasoning='内部内容';
  await assert.rejects(restoreBackup(JSON.stringify(malformed),initialState()),/工作台记录/);
});

test('独立背景使用实际已处理范围，保持阅读和背景工作台隔离',async()=>{
  const {state,book,opinion}=await fixture();opinion.source='background';book.backgroundPrepared=[...book.known];book.known=[];book.position=0;
  planWorkspace(state,book,{understanding:opinion.id},{memoryIds:[opinion.id]},{expectedRevision:0,source:'background'});
  recoverInterruptedState(state);
  assert.equal(workspaceFor(state,book,'background').understandingId,opinion.id);assert.equal(workspaceFor(state,book).understandingId,undefined);
  book.backgroundPrepared=[];pruneCompanionWorkspaces(state);assert.equal(workspaceFor(state,book,'background').understandingId,undefined);
});

test('备份接续采用当前实际读点与撤权范围，保持已保存理解及任务来源',async()=>{
  const {state,book,opinion,wish,memory}=await fixture();
  const all=[...book.known],first={start:0,end:book.chapters[0].end};
  book.known=[first];book.prepared=[first];book.position=first.end;
  opinion.evidence=[{...opinion.evidence[0],end:first.end}];wish.evidence=[{...wish.evidence[0],end:first.end}];
  planWorkspace(state,book,{understanding:opinion.id},{memoryIds:[opinion.id]},{expectedRevision:0});
  const old=JSON.stringify(state);
  book.known=all;book.prepared=all;book.position=book.text.length;
  const next=memory('later','opinion','复测接上此前恢复正常运行的愿望。'),support=memory('support','story','设备正在复测。');
  const earlier=memory('earlier','story','检修员在复测前保留自己的运行目标。');
  next.parents=[support.id];state.memories.push(next,support,earlier);
  state.readings=[{id:'read-earlier',bookId:book.id,version:book.version,partnerId:state.partnerId,source:'reading',ranges:[first],memoryIds:[earlier.id],createdAt:2,draftId:'finished-earlier'},
    {id:'read-later',bookId:book.id,version:book.version,partnerId:state.partnerId,source:'reading',ranges:all,memoryIds:[next.id,support.id],createdAt:3}];
  state.conversations=[{id:'real-session',bookId:book.id,title:'复测交流',manualTitle:false,start:0,end:book.text.length,createdAt:2}];
  state.chats=[{id:'real-chat',bookId:book.id,partnerId:state.partnerId,sessionId:'real-session',role:'user',text:'继续留意检修员的运行目标。',evidence:earlier.evidence,createdAt:2,excluded:false}];
  planWorkspace(state,book,{understanding:'t1'},{memoryIds:[],proposalMemoryIds:{t1:next.id}},{expectedRevision:1,readingId:'read-later'});
  const restored=await restoreBackup(old,state);
  assert.deepEqual(restored.books[0].known,all);assert.deepEqual(restored.books[0].prepared,all);assert.equal(restored.books[0].position,book.position);
  assert.equal(workspaceFor(restored,restored.books[0]).lastReadingId,'read-later');assert.equal(restored.memories.find(m=>m.id===support.id)?.text,support.text);
  assert.equal(restored.memories.find(m=>m.id===earlier.id)?.text,earlier.text);assert.equal(restored.readings?.find(r=>r.id==='read-earlier')?.draftId,'finished-earlier');
  assert.equal(restored.chats.find(c=>c.id==='real-chat')?.text,state.chats[0].text);assert.ok(restored.conversations.some(c=>c.id==='real-session'));
  book.known=[first];book.prepared=[first];book.position=first.end;pruneCompanionWorkspaces(state);
  const revoked=await restoreBackup(JSON.stringify(restored),state);
  assert.deepEqual(revoked.books[0].known,[first]);assert.equal(workspaceFor(revoked,revoked.books[0]).understandingId,undefined);assert.equal(workspaceFor(revoked,revoked.books[0]).lastReadingId,undefined);
});
