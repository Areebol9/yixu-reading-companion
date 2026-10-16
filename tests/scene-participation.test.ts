import test from 'node:test';
import assert from 'node:assert/strict';
import {importBook} from '../src/core/books.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import {initialState} from '../src/core/state.ts';
import {HarnessRuntime} from '../src/agent/runtime.ts';
import {restoreBackup} from '../src/core/backup.ts';
import {deleteChat,chatAllowsMemory} from '../src/core/context.ts';
import type {AgentModelReply,ModelPort,State,Store} from '../src/core/types.ts';

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return{promise,resolve};}
async function until(check:()=>boolean){const end=Date.now()+3000;while(!check()){if(Date.now()>end)throw Error('技术任务未到达预期交接点');await new Promise(done=>setTimeout(done,5));}}
const reaction='工程登记已完成，复测正在进行。';
const response=(scene:boolean):AgentModelReply=>({content:scene?'':'本段登记已完成。',reasoning:'',finish:scene?'tool_calls':'stop',input:17,output:9,estimated:false,elapsedMs:0,toolCalls:scene?[{id:'scene-finish',type:'function',function:{name:'finish_reading',arguments:JSON.stringify({reaction:{text:reaction,sourceId:'p1',quote:'工程登记已完成'}})}}]:[]});

async function fixture(handler:(scene:boolean)=>Promise<AgentModelReply>,body='工程登记已完成，复测正在进行。\n'){
  const state=initialState(),book=await importBook('现场任务角色工程资料','第一章 工程登记\n'+body);
  const range={start:book.text.indexOf('\n')+1,end:book.text.length};
  book.readingStrategy='companion';book.known=[range];book.prepared=[range];book.position=range.end;state.books=[book];
  state.settings.services[0].enabled=true;state.settings.tokenLimit=1000000;state.settings.minReadChars=1;state.settings.minReactionMs=0;
  let saved=structuredClone(state),calls=0;
  const store:Store={async load(){return structuredClone(saved);},async save(value){saved=structuredClone(value);}};
  const model:ModelPort={async complete(){throw Error('技术用例没有外部模型入口');},async completeTools(_service,_messages,tools){calls++;return handler(tools.some(tool=>tool.name==='finish_reading'));}};
  const engine=new ReadingEngine(state,store,model),harness=new HarnessRuntime(),shown:string[]=[];
  // These cases isolate publication and result recovery; maintenance is covered
  // by integrated-scene-scheduling.test.ts using the real scheduler.
  (engine as unknown as {scheduleMaintenance():void}).scheduleMaintenance=()=>{};
  engine.agent=harness;engine.onReaction=text=>shown.push(text);
  await engine.startReading(book.id);engine.observing(true);engine.sourceActive(true);
  return{state,book,range,engine,shown,calls:()=>calls,disk:()=>saved,observe:()=>engine.observe(book.id,book.text.slice(range.start,range.end),'body','continuous-page',{version:book.version,...range}),async close(){engine.stop();await harness.dispose();}};
}

test('自动observe现场不会把自身当成未答提问，保存并送达一次',async()=>{
  const entered=deferred(),release=deferred();const f=await fixture(async scene=>{assert(scene);entered.resolve();await release.promise;return response(true);});
  try{
    const reading=f.observe();await entered.promise;
    assert.equal(f.engine.readingFlow.foregroundPending,0);
    assert.equal(f.engine.busy,true);
    release.resolve();await reading;
    assert.deepEqual(f.shown,[reaction]);
    const chat=f.state.chats.find(c=>c.readingReaction);
    assert.equal(chat?.readingReaction?.status,'delivered');assert.equal(chat?.excluded,false);
    assert.equal(f.disk().chats.find(c=>c.id===chat?.id)?.text,reaction);
    assert.ok(f.disk().maintenanceJobs?.some(j=>j.chatIds.includes(chat!.id)));
    assert.equal((f.engine as unknown as {foregroundCompleted:number}).foregroundCompleted,1);
    await f.observe();assert.equal(f.calls(),1);assert.deepEqual(f.shown,[reaction]);
  }finally{release.resolve();await f.close();}
});

test('无关明确问答完成不作废原段书评，问答与现场原话各自保存',async()=>{
  const entered=deferred(),release=deferred();const f=await fixture(async scene=>{if(scene){entered.resolve();await release.promise;}return response(scene);});
  try{
    const reading=f.observe();await entered.promise;
    const question=f.engine.ask(f.book.id,'核对本段登记进度。');
    await until(()=>f.engine.readingFlow.foregroundPending===1);
    release.resolve();await Promise.all([reading,question]);
    assert.deepEqual(f.shown,[reaction]);
    const held=f.state.chats.find(c=>c.readingReaction);
    assert.equal(held?.readingReaction?.status,'delivered');assert.equal(held?.publication?.status,'published');
    assert.ok(f.state.chats.some(c=>c.role==='assistant'&&!c.excluded&&c.text==='本段登记已完成。'));
    assert.equal(f.engine.readingFlow.foregroundPending,0);
    assert.equal((f.engine as unknown as {foregroundCompleted:number}).foregroundCompleted,2);
    assert.equal(f.calls(),2);
  }finally{release.resolve();await f.close();}
});

test('整包仍重叠时实际表达锚点离屏，原话保存为原段段评',async()=>{
  const entered=deferred(),release=deferred();let first=true;
  const f=await fixture(async()=>{if(first){first=false;entered.resolve();await release.promise;return response(true);}return{...response(true),toolCalls:[{id:'quiet',type:'function',function:{name:'finish_reading',arguments:'{"quiet":true}'}}]};},'工程登记已完成，复测正在进行。\n第二段正在检查新的设备。\n');
  try{
    const reading=f.observe();await entered.promise;
    const start=f.book.text.indexOf('第二段'),end=f.book.text.length;
    const moved=f.engine.observe(f.book.id,f.book.text.slice(start,end),'body','continuous-page',{version:f.book.version,start,end});
    release.resolve();await Promise.all([reading,moved]);
    assert.deepEqual(f.shown,[]);
    const held=f.state.chats.find(c=>c.readingReaction);
    assert.equal(held?.publication?.status,'published');assert.equal(held?.publication?.destination,'paragraph');
    assert.equal(held?.anchor?.start,f.range.start);
  }finally{release.resolve();await f.close();}
});

test('提问期间形成的原段书评在答复提交后仍按实际现场发表',async()=>{
  const questionEntered=deferred(),sceneEntered=deferred(),questionRelease=deferred(),sceneRelease=deferred();
  const f=await fixture(async scene=>{if(scene){sceneEntered.resolve();await sceneRelease.promise;}else{questionEntered.resolve();await questionRelease.promise;}return response(scene);});
  try{
    const question=f.engine.ask(f.book.id,'核对本段登记进度。');await questionEntered.promise;
    const reading=f.observe();await sceneEntered.promise;
    questionRelease.resolve();await question;
    sceneRelease.resolve();await reading;
    assert.deepEqual(f.shown,[reaction]);
    assert.equal(f.state.chats.find(c=>c.readingReaction)?.publication?.status,'published');
    assert.ok(f.state.chats.some(c=>c.replyTo&&c.text==='本段登记已完成。'&&!c.excluded));
  }finally{questionRelease.resolve();sceneRelease.resolve();await f.close();}
});

test('已判断正文仍接受新用户段评一次，点赞不调用模型，明确回应沿原帖ID',async()=>{
  const f=await fixture(async scene=>scene?{...response(true),toolCalls:[{id:'quiet',type:'function',function:{name:'finish_reading',arguments:'{"quiet":true}'}}]}:response(false));
  try{
    await f.observe();assert.equal(f.calls(),1);
    const commentId=await f.engine.postParagraphComment(f.book.id,{range:f.range,version:f.book.version,quote:f.book.text.slice(f.range.start,f.range.end),text:'核对本段登记。'});
    await until(()=>f.engine.state.readings?.some(r=>r.sceneCommentIds?.includes(commentId))===true);
    assert.equal(f.calls(),2);
    await f.observe();assert.equal(f.calls(),2);
    await f.engine.setParagraphCommentLiked(f.book.id,commentId,true);await f.engine.setParagraphCommentLiked(f.book.id,commentId,true);
    assert.equal(f.calls(),2);assert.equal(f.engine.state.chats.find(c=>c.id===commentId)?.readerInteraction?.liked,true);
    await f.engine.setParagraphCommentLiked(f.book.id,commentId,false);assert.equal(f.calls(),2);
    await f.engine.requestParagraphReply(f.book.id,commentId);
    const comments=await f.engine.listParagraphComments(f.book.id,{ranges:[f.range]});
    assert.equal(comments.items.filter(c=>c.role==='user').length,1);
    assert.ok(comments.items.some(c=>c.role==='assistant'&&c.replyTo===commentId));
    assert.equal(f.engine.state.queryCheckpoints?.find(q=>q.questionId===commentId)?.status,'consumed');
    const calls=f.calls();await f.engine.requestParagraphReply(f.book.id,commentId);assert.equal(f.calls(),calls);
  }finally{await f.close();}
});

test('分享同包段评沿实际锚点，期间交流和过页只保留原条目',async()=>{
  const entered=deferred(),release=deferred();let first=true;
  const f=await fixture(async scene=>{if(!scene)return response(false);if(first){first=false;entered.resolve();await release.promise;return{...response(true),toolCalls:[{id:'comment-share',type:'function',function:{name:'finish_reading',arguments:JSON.stringify({paragraphComments:[{sourceId:'p1',quote:'工程登记已完成',text:reaction}],reaction:{comment:'c1'}})}}]};}return{...response(true),toolCalls:[{id:'quiet',type:'function',function:{name:'finish_reading',arguments:'{"quiet":true}'}}]};},'工程登记已完成，复测正在进行。\n第二段正在检查新的设备。\n');
  try{
    const reading=f.observe();await entered.promise;
    const start=f.book.text.indexOf('第二段'),end=f.book.text.length;
    const moved=f.engine.observe(f.book.id,f.book.text.slice(start,end),'body','continuous-page',{version:f.book.version,start,end});
    await f.engine.ask(f.book.id,'核对当前设备登记。');release.resolve();await Promise.all([reading,moved]);
    assert.deepEqual(f.shown,[]);const notes=(await f.engine.listParagraphComments(f.book.id)).items;
    assert.equal(notes.length,1);assert.equal(notes[0].text,reaction);
    const share=f.state.chats.find(c=>c.readingReaction)!;assert.equal(share.expressionAnchor?.hash,notes[0].anchor.hash);assert.equal(share.paragraphCommentId,notes[0].id);
    assert.ok(f.disk().maintenanceJobs?.some(j=>j.chatIds.includes(notes[0].id)));assert.ok(!f.disk().maintenanceJobs?.some(j=>j.chatIds.includes(share.id)));
    const restored=await restoreBackup(JSON.stringify(f.disk()),initialState());assert.equal(restored.chats.find(c=>c.id===notes[0].id)?.anchor?.hash,notes[0].anchor.hash);
  }finally{release.resolve();await f.close();}
});

test('原sceneInsight已交同一后台责任时不重复登记伙伴表达',async()=>{
  const f=await fixture(async()=>({...response(true),toolCalls:[{id:'insight',type:'function',function:{name:'finish_reading',arguments:JSON.stringify({reaction:{text:reaction,sourceId:'p1',quote:'工程登记已完成'},sceneInsight:{text:'工程登记需继续复核。',sourceIds:['p1']}})}}]}));
  try{await f.observe();const record=f.state.readings!.find(r=>r.sceneInsight)!,chat=f.state.chats.find(c=>c.readingReaction)!;assert.ok(f.disk().maintenanceJobs?.some(j=>j.sceneRecordIds?.includes(record.id)));assert.ok(!f.disk().maintenanceJobs?.some(j=>j.chatIds.includes(chat.id)));}finally{await f.close();}
});

test('明确答复与其后台责任同次保存，写失败后原候选接续不新增模型调用',async()=>{
  const f=await fixture(async()=>response(false));const save=f.engine.store.save.bind(f.engine.store);let fail=true;
  f.engine.store.save=async state=>{const q=state.queryCheckpoints?.find(q=>q.status==='consumed');if(q){const reply=state.chats.find(c=>c.id===q.replyId)!;assert.ok(reply);assert.ok(state.maintenanceJobs?.some(j=>j.chatIds.includes(q.questionId)&&j.chatIds.includes(reply.id)));if(fail){fail=false;throw Error('技术答复事务保存失败');}}await save(state);};
  try{
    await assert.rejects(f.engine.ask(f.book.id,'核对当前登记。'),/保存/);const question=f.state.chats.find(c=>c.role==='user')!;
    assert.equal(f.disk().queryCheckpoints?.some(q=>q.status==='consumed')??false,false);assert.equal(f.disk().chats.some(c=>c.replyTo===question.id),false);
    const calls=f.calls();await f.engine.retryQuestion(question.id);assert.equal(f.calls(),calls);
    const saved=f.disk(),q=saved.queryCheckpoints!.find(q=>q.questionId===question.id)!;assert.equal(q.status,'consumed');assert.ok(saved.maintenanceJobs?.some(j=>j.chatIds.includes(question.id)&&j.chatIds.includes(q.replyId!)));
  }finally{await f.close();}
});

test('用户段评和其后台责任同次保存，失败不留下已发表但未交后台的记录',async()=>{
  const f=await fixture(async()=>response(false));f.engine.observing(false);const save=f.engine.store.save.bind(f.engine.store);let fail=true;
  f.engine.store.save=async state=>{const comment=state.chats.find(c=>c.role==='user'&&c.presentation==='paragraph');if(comment){assert.ok(state.maintenanceJobs?.some(j=>j.chatIds.includes(comment.id)));if(fail){fail=false;throw Error('技术段评事务保存失败');}}await save(state);};
  const input={range:f.range,version:f.book.version,quote:f.book.text.slice(f.range.start,f.range.end),text:'核对本段登记。'};
  try{await assert.rejects(f.engine.postParagraphComment(f.book.id,input),/事务保存失败/);assert.equal(f.disk().chats.length,0);const id=await f.engine.postParagraphComment(f.book.id,input);assert.ok(f.disk().maintenanceJobs?.some(j=>j.chatIds.includes(id)));}finally{await f.close();}
});

test('用户安静模式仍保存合法段评；model quiet完成不伪造表达',async()=>{
  const f=await fixture(async()=>({...response(true),toolCalls:[{id:'note',type:'function',function:{name:'finish_reading',arguments:JSON.stringify({paragraphComments:[{sourceId:'p1',quote:'工程登记已完成',text:'登记结果已留档。'}]})}}]}));
  try{
    f.engine.quiet(true);await f.observe();
    const comments=await f.engine.listParagraphComments(f.book.id,{ranges:[f.range]});
    assert.equal(comments.items.length,1);assert.deepEqual(f.shown,[]);
    assert.equal(f.engine.state.readings?.at(-1)?.sceneJudgment,'expressions');
    const count=f.calls();await f.observe();assert.equal(f.calls(),count);
  }finally{await f.close();}
});

test('安静模式有可靠原段的原话仅留段评，恢复自然交流不补播',async()=>{
  const f=await fixture(async()=>response(true));
  try{
    f.engine.quiet(true);await f.observe();
    assert.deepEqual(f.shown,[]);assert.equal(f.engine.state.chats.find(c=>c.readingReaction)?.presentation,'paragraph');
    f.engine.quiet(false);await f.observe();
    assert.equal(f.calls(),1);assert.deepEqual(f.shown,[]);
    assert.equal((await f.engine.listParagraphComments(f.book.id)).items.length,1);
  }finally{await f.close();}
});

test('段评串与点赞备份保留真实作者，删除根后回复不供入或显示',async()=>{
  const f=await fixture(async()=>response(false));
  try{
    f.engine.observing(false);
    const root=await f.engine.postParagraphComment(f.book.id,{range:f.range,version:f.book.version,quote:f.book.text.slice(f.range.start,f.range.end),text:'本段工程记录。'});
    const reply=await f.engine.postParagraphComment(f.book.id,{range:f.range,version:f.book.version,quote:f.book.text.slice(f.range.start,f.range.end),text:'补充记录。',parentId:root});
    await f.engine.setParagraphCommentLiked(f.book.id,reply,true);
    const restored=await restoreBackup(JSON.stringify(f.engine.state),initialState());
    assert.equal(restored.chats.find(c=>c.id===reply)?.readerInteraction?.liked,true);
    assert.equal(restored.chats.find(c=>c.id===reply)?.role,'user');assert.equal(f.calls(),0);
    await f.engine.editState(state=>deleteChat(state,root));
    assert.equal((await f.engine.listParagraphComments(f.book.id,{ranges:[f.range]})).items.length,0);
    assert.equal(chatAllowsMemory(f.engine.state,f.engine.state.chats.find(c=>c.id===reply)!),false);
    await assert.rejects(f.engine.requestParagraphReply(f.book.id,reply),/有效段评/);assert.equal(f.calls(),0);
  }finally{await f.close();}
});

test('冷态继续保存只消费原稿：不新建共读、不补播即时话，恢复合法段评',async()=>{
  const f=await fixture(async()=>({...response(true),toolCalls:[{id:'note-and-reaction',type:'function',function:{name:'finish_reading',arguments:JSON.stringify({paragraphComments:[{sourceId:'p1',quote:'工程登记已完成',text:'结果留档。'}],reaction:{text:reaction,sourceId:'p1',quote:'工程登记已完成'}})}}]}));
  const original=f.engine.store.save.bind(f.engine.store);let failed=false;
  f.engine.store.save=async state=>{if(!failed&&state.chats.some(c=>c.publication?.status==='published')){failed=true;throw Error('技术发表保存失败');}await original(state);};
  try{
    const before=JSON.stringify(f.engine.state);
    await assert.rejects(f.observe(),/本地保存尚未完成/);
    const merged=await restoreBackup(before,f.engine.state);
    assert.equal(merged.readingDrafts?.length,1);assert.equal(merged.readings?.filter(r=>r.sceneJudgment).length,1);
    const cold=structuredClone(f.disk()),shown:string[]=[],forbidden:ModelPort={async complete(){throw Error('冷保存禁止模型调用');}};
    const engine=new ReadingEngine(cold,f.engine.store,forbidden);engine.onReaction=text=>shown.push(text);
    assert.equal(engine.session,undefined);assert.ok(engine.readingFlow.sceneRestoreBookIds.includes(f.book.id));
    const conversationIds=cold.conversations.map(c=>c.id),position=cold.books[0].position,resume=structuredClone(cold.resume);
    await engine.resumeSceneParticipation(f.book.id);
    assert.equal(engine.session,undefined);assert.deepEqual(cold.conversations.map(c=>c.id),conversationIds);assert.equal(cold.books[0].position,position);assert.deepEqual(cold.resume,resume);assert.deepEqual(shown,[]);
    assert.equal(cold.chats.find(c=>c.readingReaction)?.publication?.status,'obsolete');
    assert.equal((await engine.listParagraphComments(f.book.id,{ranges:[f.range]})).items.length,1);
    assert.equal(cold.readings?.filter(r=>r.sceneJudgment).length,1);assert.equal(f.calls(),1);
  }finally{await f.close();}
});

test('场景候选首次事务保存失败不消费原文，原合法稿零模型接续保存',async()=>{
  const f=await fixture(async()=>response(true));
  const original=f.engine.store.save.bind(f.engine.store);let failed=false;
  f.engine.store.save=async state=>{if(!failed&&state.readings?.some(r=>r.sceneJudgment)&&state.chats.some(c=>c.publication)){failed=true;throw Error('技术磁盘写入失败');}await original(state);};
  try{
    await assert.rejects(f.observe(),/本地保存尚未完成/);
    assert.equal(f.calls(),1);assert.deepEqual(f.shown,[]);
    assert.equal(f.engine.state.readings?.some(r=>r.sceneJudgment)??false,false);
    assert.ok(f.engine.state.readingDrafts?.some(d=>d.input==='现场参与'));
    await f.engine.resumeSceneParticipation(f.book.id);
    assert.equal(f.calls(),1);assert.deepEqual(f.shown,[reaction]);
    assert.equal(f.engine.state.readings?.filter(r=>r.sceneJudgment).length,1);
  }finally{await f.close();}
});

test('纯JSON现场沿实际调用身份接受，来源撤回后暂缓稿不补播',async()=>{
  const f=await fixture(async()=>response(true));let direct=0;
  f.engine.model.completeTools=undefined;
  f.engine.model.complete=async()=>{direct++;return{content:JSON.stringify({reaction:{text:reaction,sourceId:'p1',quote:'工程登记已完成'}}),reasoning:'',input:17,output:9,estimated:false,elapsedMs:0};};
  try{
    f.engine.quiet(true);await f.observe();
    assert.equal(direct,1);assert.equal(f.engine.state.chats.find(c=>c.readingReaction)?.publication?.status,'published');
    await f.engine.editState(state=>{state.books[0].known=[];state.books[0].position=0;});
    f.engine.quiet(false);assert.equal((await f.engine.listParagraphComments(f.book.id)).items.length,0);
    assert.deepEqual(f.shown,[]);assert.equal(direct,1);
    assert.equal(f.engine.state.readings?.filter(r=>r.sceneJudgment).length,1);
  }finally{await f.close();}
});
