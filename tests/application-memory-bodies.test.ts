import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initialState} from '../src/core/state.ts';
import {importBook} from '../src/core/books.ts';
import {AnalysisCore} from '../src/core/analysis-core.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import {ReadingRuntime} from '../src/core/runtime.ts';
import {LocalApplication} from '../src/core/application.ts';
import {ApplicationServer} from '../src/core/application-wire.ts';
import {restoreBackup} from '../src/core/backup.ts';
import {NativeStore} from '../src/native/store.ts';
import {releasePersistedMemoryBodies} from '../src/core/memory-bodies.ts';
import {planWorkspace,workspaceFor} from '../src/core/companion-workspace.ts';
import type {NativeRequest} from '../src/native/channel.ts';
import type {Memory,MemoryBody,State} from '../src/core/types.ts';

const body='LONG-ARCHIVE-BODY：人物长期保留的认识与证据全文。';
async function fixture(before?:(method:string)=>Promise<void>){
 const state=initialState(),book=await importBook('正文仓工程资料','第一章 已读\n设备登记为三件。\n第二章 尚未提供\nUNAUTHORIZED-ORIGINAL');
 const end=book.chapters[1].start;book.known=[{start:0,end}];book.position=end;state.books=[book];
 const memory:Memory={id:'archive',bookId:book.id,partnerId:state.partnerId,kind:'story',text:body,documentTitle:'设备登记认识',navigationCues:['设备','登记'],evidence:[{bookId:book.id,version:book.version,start:0,end}],parents:[],chatIds:[],createdAt:1,forgotten:false,source:'reading'};
 state.memories=[memory];let saved:State|undefined;const originals=new Map<string,string>(),bodies=new Map<string,MemoryBody>(),calls:string[]=[];
 const request:NativeRequest=async<T>(method:string,data:any):Promise<T>=>{
  calls.push(method);await before?.(method);
  if(method==='putBookText'){originals.set(data.version,data.text);return undefined as T;}
  if(method==='putMemoryBody'){bodies.set(data.key,structuredClone(data));return undefined as T;}
  if(method==='saveState'){saved=structuredClone(data);return undefined as T;}
  if(method==='loadState')return structuredClone(saved??null) as T;
  if(method==='readBookText')return originals.get(data.version) as T;
  if(method==='readMemoryBodies')return data.refs.map((ref:any)=>bodies.get(ref.key)).filter(Boolean) as T;
  throw Error('unexpected '+method);
 };
 await new NativeStore(request).save(state);const store=new NativeStore(request),loaded=(await store.load())!;
 const engine=new ReadingEngine(loaded,store,{async complete(){throw Error('此检查不能调用模型');}}),runtime=new ReadingRuntime(engine,{available:false,async request(){return {} as never;}}),app=new LocalApplication(runtime,async()=>({} as never));
 return {state:loaded,book:loaded.books[0],engine,runtime,app,store,bodies,calls,saved:()=>saved!};
}

test('冷态界面与桥快照只含导航，完整正文由显式command返回且不留大回执',async()=>{
 const f=await fixture();try{
  assert.equal(f.state.memories[0].text,undefined);assert(!JSON.stringify(f.app.snapshot).includes(body));assert.equal(f.app.snapshot.state.memories[0].documentTitle,'设备登记认识');
  const messages:any[]=[],server=new ApplicationServer(f.app,(kind,value)=>messages.push({kind,value})),request={id:crypto.randomUUID(),epoch:server.epoch,name:'readMemoryBody' as const,args:[f.book.id,'archive']};
  await server.receive(request);assert.equal(messages.at(-1).value.value,body);assert(!JSON.stringify(server.frame()).includes(body));
  const bodyReads=f.calls.filter(call=>call==='readMemoryBodies').length;await server.receive(request);
  assert.match(messages.at(-1).value.error,/此操作已完成/);assert.equal(f.calls.filter(call=>call==='readMemoryBodies').length,bodyReads);
  const index=await f.app.command('readWorkDossier',f.book.id,{view:'index'}),full=await f.app.command('readWorkDossier',f.book.id,{view:'full',snapshot:index.snapshot});
  assert.equal(full.items.find(item=>item.id==='archive')?.text,body);assert.equal(f.state.memories[0].text,undefined);
  const coreCopy=JSON.parse(await new AnalysisCore(f.engine).backup());assert.equal(coreCopy.memories[0].text,body);assert.equal(coreCopy.memories[0].bodyRef,undefined);assert.equal(f.state.memories[0].text,undefined);
 }finally{f.runtime.dispose();}
});

test('正文command不为错书、其他伙伴、未读或已忘记档案读body',async()=>{
 const f=await fixture();try{
  const original=f.state.memories[0],count=()=>f.calls.filter(call=>call==='readMemoryBodies').length;
  await assert.rejects(f.app.command('readMemoryBody','missing-book','archive'));
  original.partnerId='other';await assert.rejects(f.app.command('readMemoryBody',f.book.id,'archive'),/许可内/);original.partnerId=f.state.partnerId;
  const allowed=structuredClone(original.evidence);original.evidence[0].end=f.book.textLength!;await assert.rejects(f.app.command('readMemoryBody',f.book.id,'archive'),/许可内/);original.evidence=allowed;
  original.forgotten=true;await assert.rejects(f.app.command('readMemoryBody',f.book.id,'archive'),/许可内/);assert.equal(count(),0);
 }finally{f.runtime.dispose();}
});

test('导出分批取完整档案到备份，活态保持懒读；metadata-only文件拒绝作为完整备份',async()=>{
 const f=await fixture();try{
  const raw=await f.app.command('exportBackup',false),backup=JSON.parse(raw);
  assert.equal(backup.memories[0].text,body);assert.equal(backup.memories[0].bodyRef,undefined);assert.equal(f.state.memories[0].text,undefined);
  assert.equal(backup.books[0].text.includes('UNAUTHORIZED-ORIGINAL'),true); // The user's portable backup preserves the whole owned source.
  assert.equal((await restoreBackup(raw,initialState())).memories[0].text,body);
  const metadata=structuredClone(backup);delete metadata.memories[0].text;metadata.memories[0].bodyRef=f.state.memories[0].bodyRef;
  await assert.rejects(restoreBackup(JSON.stringify(metadata),initialState()),/记忆记录无效/);
  const corrupt=structuredClone(backup);corrupt.memories[0].bodyRef={...f.state.memories[0].bodyRef,chars:1};
  await assert.rejects(restoreBackup(JSON.stringify(corrupt),initialState()),/校验失败/);
 }finally{f.runtime.dispose();}
});

test('冷态忘记先载入原文，实际忘记凭据保存完整正文并阻止再次读取',async()=>{
 const f=await fixture();try{
  await f.app.command('forgetMemory','archive');assert.equal(f.state.memories[0].forgotten,true);assert.equal(f.state.forgotten.find(item=>item.id==='archive')?.text,body);
  assert.equal(f.saved().forgotten.find(item=>item.id==='archive')?.text,body);assert.equal(f.saved().memories[0].text,undefined);
  assert.equal(f.state.memories[0].text,undefined);
  await assert.rejects(f.app.command('readMemoryBody',f.book.id,'archive'),/许可内/);
  releasePersistedMemoryBodies(f.state);
 }finally{f.runtime.dispose();}
});

test('冷态删除来源聊天在落盘前保留正文lease，失效链写入完整忘记凭据后卸载',async()=>{
 const f=await fixture();try{
  f.state.chats.push({id:'source-chat',bookId:f.book.id,partnerId:f.state.partnerId,sessionId:'scene',role:'user',text:'技术登记',evidence:[],createdAt:1,excluded:false});
  f.state.memories[0].correctionRepairSources={memoryIds:[],chatIds:['source-chat'],habitIds:[]};
  await f.store.save(f.state);assert.equal(f.state.memories[0].text,undefined);
  await f.app.command('deleteChat','source-chat');
  assert.equal(f.state.chats.some(chat=>chat.id==='source-chat'),false);assert.equal(f.state.memories[0].forgotten,true);
  assert.equal(f.saved().forgotten.find(item=>item.id==='archive')?.text,body);
  assert.equal(f.state.memories[0].text,undefined);
 }finally{f.runtime.dispose();}
});

test('完整导出恢复到同书冷态增量工作集，保留已有正文及本地独有正文且不加载live全档案',async()=>{
 const f=await fixture();try{
  const raw=await f.app.command('exportBackup',false);
  const local:Memory={...structuredClone(f.state.memories[0]),id:'local-extra',kind:'question',text:'本地新形成的问题原文全文。',bodyRef:undefined,documentTitle:'增量问题'};
  f.state.memories.push(local);
  planWorkspace(f.state,f.book,{working:['local-extra']},{memoryIds:['local-extra']},{expectedRevision:0});
  await f.store.save(f.state);releasePersistedMemoryBodies(f.state);
  assert(f.state.memories.every(memory=>memory.text===undefined));
  const restored=await restoreBackup(raw,f.state,f.store);
  assert.equal(restored.memories.find(memory=>memory.id==='archive')?.text,body);
  assert.equal(restored.memories.find(memory=>memory.id==='local-extra')?.text,'本地新形成的问题原文全文。');
  assert.deepEqual(workspaceFor(restored,restored.books[0]).workingIds,['local-extra']);
  assert(f.state.memories.every(memory=>memory.text===undefined));
  await f.app.command('restoreBackup',raw,false);
  assert.deepEqual(workspaceFor(f.engine.state,f.engine.state.books[0]).workingIds,['local-extra']);
  assert(f.saved().memories.every(memory=>memory.text===undefined&&!!memory.bodyRef));
  assert.equal(await f.app.command('readMemoryBody',f.book.id,'local-extra'),'本地新形成的问题原文全文。');
 }finally{f.runtime.dispose();}
});
