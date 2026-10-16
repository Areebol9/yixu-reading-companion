import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkbenchEvents} from '../src/workbench/events.ts';
import {OfflineModel,offlineGuide,offlineReply} from '../src/workbench/offline-model.ts';
import {initialState} from '../src/core/state.ts';
import {importBook} from '../src/core/books.ts';
import {restoreReadingEngine,ReadingRuntime} from '../src/core/runtime.ts';
import {LocalApplication} from '../src/core/application.ts';
import {HarnessRuntime} from '../src/agent/runtime.ts';
import {restoreBackup} from '../src/core/backup.ts';
import type {State} from '../src/core/types.ts';
import {activeWorkbenchSession,markWorkbenchSessionActive,rememberSession,workbenchSessions,availableWorkbenchSessions,archiveWorkbenchSessions,exportArchivedWorkbenchBackup} from '../src/workbench/store.ts';
import {workbenchPageNumbers} from '../src/workbench/runtime.ts';

test('正文偏移与任意跳转按当前页末计页，最后一页等于总页数',()=>{
 const bodyStart=25,length=1025,pageChars=140;
 assert.deepEqual(workbenchPageNumbers(bodyStart+pageChars,bodyStart,length,pageChars),{pageNumber:1,totalPages:8});
 const last=workbenchPageNumbers(length,bodyStart,length,pageChars);assert.equal(last.pageNumber,last.totalPages);
 const jumped=workbenchPageNumbers(840,bodyStart,length,pageChars),previous=workbenchPageNumbers(700,bodyStart,length,pageChars);assert.equal(jumped.pageNumber-previous.pageNumber,1);
});

test('活动场次切回后刷新沿用原指针，已有场次列表保持',t=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'localStorage'),values=new Map<string,string>();
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem(key:string){return values.get(key)??null;},setItem(key:string,value:string){values.set(key,value);}}});
 t.after(()=>{if(descriptor)Object.defineProperty(globalThis,'localStorage',descriptor);else Reflect.deleteProperty(globalThis,'localStorage');});
 const offline={id:crypto.randomUUID(),mode:'offline' as const,title:'离线记录',createdAt:1},live={id:crypto.randomUUID(),mode:'live' as const,title:'真实记录',createdAt:2};
 rememberSession(offline);rememberSession(live);markWorkbenchSessionActive(live.id);assert.equal(activeWorkbenchSession()?.id,live.id);
 markWorkbenchSessionActive(offline.id);assert.equal(activeWorkbenchSession()?.id,offline.id);assert.equal(workbenchSessions().length,2);assert.throws(()=>markWorkbenchSessionActive(crypto.randomUUID()),/不存在/);
 assert.deepEqual([...values.keys()].sort(),['yixu-workbench-active-session-v1','yixu-workbench-sessions-v1']);
});

test('归档排除默认启动和打开，陈旧标签记元数据不能解除归档，当前存档受保护',async t=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'localStorage'),values=new Map<string,string>();
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem(key:string){return values.get(key)??null;},setItem(key:string,value:string){values.set(key,value);}}});
 t.after(()=>{if(descriptor)Object.defineProperty(globalThis,'localStorage',descriptor);else Reflect.deleteProperty(globalThis,'localStorage');});
 const old={id:crypto.randomUUID(),mode:'live' as const,title:'原资料',createdAt:1},current={id:crypto.randomUUID(),mode:'live' as const,title:'新空态',createdAt:2};
 rememberSession(old);rememberSession(current);markWorkbenchSessionActive(current.id);
 assert.throws(()=>archiveWorkbenchSessions([current.id],current.id),/正在使用/);
 assert.equal(archiveWorkbenchSessions([old.id],current.id),1);const archived=workbenchSessions().find(s=>s.id===old.id)!;
 assert.ok(archived.archivedAt);assert.deepEqual(availableWorkbenchSessions().map(s=>s.id),[current.id]);assert.equal(activeWorkbenchSession()?.id,current.id);
 assert.throws(()=>markWorkbenchSessionActive(old.id),/已归档/);rememberSession({...old,title:'陈旧标签稍后保存'});
 assert.equal(workbenchSessions().find(s=>s.id===old.id)?.archivedAt,archived.archivedAt);assert.equal(archiveWorkbenchSessions([old.id],current.id),0);
 values.set('yixu-workbench-active-session-v1',old.id);assert.equal(activeWorkbenchSession(),undefined);assert.equal(availableWorkbenchSessions()[0].id,current.id);
 await assert.rejects(exportArchivedWorkbenchBackup(current.id),/归档存档不存在/);
});
test('两个问题按replyTo记录实际可见耗时，ready与有用分别保存',()=>{
 let clock=100;const log=new WorkbenchEvents('offline',undefined,()=>clock),first=log.add('action','第一问');log.question('question-a',first);
 clock=120;log.question('question-b',log.add('action','第二问'));
 clock=190;log.ready('reply-b','question-b');clock=220;log.ready('reply-a','question-a');
 assert.equal(log.data.timings['reply-b'].firstVisibleMs,undefined);assert.equal(log.data.timings['reply-a'].visibleAt,undefined);
 clock=250;assert.equal(log.visible('reply-b',0,10),true);assert.equal(log.data.timings['reply-b'].firstVisibleMs,130);
 clock=270;assert.equal(log.visible('reply-a'),true);assert.equal(log.data.timings['reply-a'].firstVisibleMs,170);
 assert.equal(log.visible('reply-a'),false);assert.equal(log.data.timings['reply-a'].userMarkedHelpful,undefined);log.helpful('reply-a');assert.equal(log.data.timings['reply-a'].userMarkedHelpful,true);
 const restored=new WorkbenchEvents('offline',structuredClone(log.data),()=>800);restored.ready('unmatched');assert.equal(restored.visible('unmatched'),true);assert.equal(restored.data.timings.unmatched.firstVisibleMs,undefined);
 // A page reload creates a new clock domain, so it cannot infer paint time for an old ready response.
 const before=new WorkbenchEvents('offline',undefined,()=>1);before.ready('old-ready');const cold=new WorkbenchEvents('offline',structuredClone(before.data),()=>999);assert.equal(cold.visible('old-ready'),false);
});

test('输入评价说明保留选择，纯按钮可取消选择',()=>{
 const log=new WorkbenchEvents('offline');log.rate('reply','accurate');log.rate('reply','accurate','核对操作说明');assert.deepEqual(log.data.ratings.reply.values,['accurate']);assert.equal(log.data.ratings.reply.note,'核对操作说明');log.rate('reply','accurate');assert.deepEqual(log.data.ratings.reply.values,[]);
});

test('离线技术回应经正式引擎和Harness保存，浏览未授权内容不参与，原unknown费用保持',async()=>{
 const state=initialState(),book=await importBook(offlineGuide.title,offlineGuide.text+'\n第五章 尚未提供\nUNAUTHORIZED-TECHNICAL-SENTINEL');
 state.books=[book];book.readingStrategy='companion';state.settings.services[0].enabled=true;state.settings.readingEffort='high';state.settings.tokenLimit=1000000;
 const old={id:'old-unknown',time:1,serviceId:'wechat',purpose:'历史实验',input:40,output:20,estimated:true,status:'unknown' as const};state.usage.push(old);
 let disk:State=structuredClone(state);const store={async load(){return structuredClone(disk);},async save(value:State){disk=structuredClone(value);}};
 let calls=0;const offline=new OfflineModel(),model={async completeTools(...args:Parameters<OfflineModel['completeTools']>){calls++;assert(!JSON.stringify(args[1]).includes('UNAUTHORIZED-TECHNICAL-SENTINEL'));return offline.completeTools(...args);},complete:offline.complete.bind(offline)};
 const restored=await restoreReadingEngine(store,model),engine=restored.engine,harness=new HarnessRuntime();engine.agent=harness;engine.companionCandidate={earlyReaction:true,historicalSearch:true,focusedExpression:true};
 const runtime=new ReadingRuntime(engine,{available:false,async request(){return {} as never;}}),app=new LocalApplication(runtime,async()=>({} as never));
 try{
  const end=engine.book(book.id).chapters[1].start;await app.command('setKnown',book.id,end,0);await app.command('startReading',book.id);await app.command('prepare',book.id);
  await app.command('ask',book.id,'请检查本页的操作说明。',false);const reply=engine.state.chats.filter(c=>c.role==='assistant'&&!c.excluded).at(-1);assert.equal(reply?.text,offlineReply);assert.ok(reply?.replyTo);assert.ok(calls>=1);
  assert.deepEqual(engine.state.usage.find(u=>u.id===old.id),old);assert(engine.state.usage.filter(u=>u.id!==old.id).every(u=>u.input===0&&u.output===0&&!u.estimated));
  assert.equal(engine.book(book.id).known.at(-1)?.end,end);assert.equal(engine.book(book.id).position,end);
  const backup=await app.command('exportBackup',false);assert.equal((JSON.parse(backup)).secrets,undefined);const cold=await restoreBackup(backup,initialState());assert.deepEqual(cold.usage.find(u=>u.id===old.id),old);
 }finally{runtime.dispose();await harness.dispose();}
});
