import test from 'node:test';
import assert from 'node:assert/strict';
import {importBook,covers,chapterContentEnd} from '../src/core/books.ts';
import {nextSceneOpportunity} from '../src/core/scene-scheduling.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import {initialState} from '../src/core/state.ts';
import {HarnessRuntime} from '../src/agent/runtime.ts';
import {hashText} from '../src/core/text-hash.ts';
import {restoreBackup} from '../src/core/backup.ts';
import type {AgentModelReply,Book,ModelMessage,ModelPort,ModelTool,Range,State,Store} from '../src/core/types.ts';

const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return{promise,resolve};};
async function until(check:()=>boolean){const end=Date.now()+3000;while(!check()){if(Date.now()>end)throw Error('工程交接未完成');await new Promise(done=>setTimeout(done,3));}}
const finish=(value:unknown):AgentModelReply=>({content:'',reasoning:'',finish:'tool_calls',toolCalls:[{id:'finish',type:'function',function:{name:'finish_reading',arguments:JSON.stringify(value)}}],input:20,output:10,estimated:false,elapsedMs:1});
const paragraph=(index:number)=>`工程登记${index}：`+'记录'.repeat(304)+'。';
async function setup(handler:(role:'scene'|'maintenance'|'query',messages:ModelMessage[],tools:ModelTool[],state:State)=>Promise<AgentModelReply>,text='第一章 工程登记\n'+[1,2,3,4,5].map(paragraph).join('\n')+'\n\n第二章 工程复测\n复测记录已保存。\n'){
  const state=initialState(),book=await importBook('工程调度资料',text);book.readingStrategy='companion';state.books=[book];state.settings.services[0].enabled=true;state.settings.tokenLimit=10000000;state.settings.minReactionMs=0;
  let disk=structuredClone(state),calls=0,active=0,maxActive=0;const observed:{role:string;messages:ModelMessage[]}[]=[];
  const store:Store={async readBookRanges(version,ranges){return{version,length:text.length,pieces:await Promise.all(ranges.map(async r=>({...r,text:text.slice(r.start,r.end),hash:await hashText(text.slice(r.start,r.end))}))) };},async load(){return structuredClone(disk);},async save(value){disk=structuredClone(value);}};
  const model:ModelPort={async complete(){throw Error('此工程测试没有外部模型');},async completeTools(_service,messages,tools){if(++calls>12)throw Error('工程假模型未取得有效终态');active++;maxActive=Math.max(maxActive,active);const terminal=tools.find(t=>t.name==='finish_reading'),properties=terminal?.parameters.properties as Record<string,unknown>|undefined;const role=properties?.quiet?'scene':properties?.documents?'maintenance':'query';observed.push({role,messages:structuredClone(messages)});try{return await handler(role,messages,tools,state);}finally{active--;}}};
  const engine=new ReadingEngine(state,store,model),harness=new HarnessRuntime(),shown:string[]=[];engine.agent=harness;engine.onReaction=t=>shown.push(t);await engine.startReading(book.id);engine.observing(true);engine.sourceActive(true);
  return{state,book,engine,store,shown,observed,disk:()=>disk,calls:()=>calls,active:()=>active,maxActive:()=>maxActive,observe:(range:Range)=>engine.observe(book.id,book.text.slice(range.start,range.end),'body','continuous-page',{...range,version:book.version}),async close(){engine.stop();await until(()=>!engine.busy);await harness.dispose();}};
}
function maintenanceResult(messages:ModelMessage[],includeViews=true){
  const packet=messages.flatMap(m=>m.content.split('\n\n').map(t=>{try{return JSON.parse(t);}catch{return{};}})).find(p=>p.task==='maintenance');
  const views=includeViews?(packet.viewTargets as string[]).map(target=>{const existing=target.startsWith('v')?packet.views.find((v:any)=>v.id===target):undefined;return{kind:existing?.kind??target,key:existing?.key??'工程状态',text:'工程状态已登记。',sourceMemoryIds:['t1'],sourceIds:['p1'],...(existing?{previousId:existing.id}:{})};}):undefined;
  return{documents:[{operation:'create',text:'本批工程记录已保存。',sourceIds:['p1']}],...(views?{views}:{})};
}

test('自然机会按实际段末与首派身份限四加章末；短章忽略排版尾空白',async()=>{
  const state=initialState(),book=await importBook('工程资料','第一章 工程\n'+[1,2,3,4,5].map(paragraph).join('\n')+'\n\n第二章 工程\n完成。\n');state.books=[book];
  const chapter=book.chapters[0],end=chapterContentEnd(book,chapter);book.known=[{start:chapter.start,end:chapter.start+200}];
  assert.equal(nextSceneOpportunity(state,book,book.known,book.known),undefined);
  for(let n=1;n<=4;n++){const stop=Math.min(end-1,chapter.start+630*n);book.known=[{start:chapter.start,end:stop}];const planned=nextSceneOpportunity(state,book,book.known,book.known);assert.ok(planned);assert.equal(planned.opportunity.slot,n);state.usage.push({id:'call'+n,time:n,serviceId:'test',purpose:'现场参与',input:1,output:1,estimated:false,status:'complete',dispatchState:'response-received',sceneOpportunity:planned.opportunity,requestKey:JSON.stringify([book.id,book.version,state.partnerId,'reading',planned.ranges,'scene'])});}
  book.known=[{start:chapter.start,end}];const ending=nextSceneOpportunity(state,book,[{start:end-30,end}],book.known);assert.equal(ending?.opportunity.slot,'end');assert.ok(!covers(book.known,{start:end,end:chapter.end}));
  const short=book.chapters[1],shortEnd=chapterContentEnd(book,short);book.known=[{start:short.start,end:shortEnd}];assert.equal(nextSceneOpportunity(state,book,book.known,book.known)?.opportunity.slot,'end');
});

test('小增量仅登记后台责任；章末现场与维护同时在途，保存各自真实成果',async()=>{
  const release=deferred(),roles=new Set<string>();const f=await setup(async(role,messages)=>{roles.add(role);await release.promise;return role==='scene'?finish({quiet:true}):finish(maintenanceResult(messages));});
  try{
    const start=f.book.text.indexOf('\n')+1;await f.observe({start,end:start+50});assert.equal(f.calls(),0);assert.ok(f.disk().maintenanceJobs?.some(j=>covers(j.ranges,{start,end:start+50})));assert.equal(f.state.books[0].prepared.length,0);
    const end=chapterContentEnd(f.book,f.book.chapters[0]),reading=f.observe({start,end});await until(()=>roles.has('scene')&&roles.has('maintenance'));assert.equal(f.active(),2);assert.equal(f.maxActive(),2);
    release.resolve();await reading;await until(()=>!f.engine.busy);assert.ok(covers(f.book.prepared,{start,end}));assert.ok(f.state.readings?.some(r=>r.sceneOpportunity?.slot==='end'));assert.equal(f.state.publishedViews?.length,2);assert.ok(f.state.usage.some(u=>u.maintenanceDispatch?.committed));
  }finally{release.resolve();await f.close();}
});

test('同维护任务补齐同包tN视图后才提交完整认识与prepared',async()=>{
  let attempts=0;const f=await setup(async(role,messages,_tools,state)=>{if(role==='scene')return finish({quiet:true});attempts++;if(attempts===2){assert.equal(state.memories.length,0);assert.equal(state.books[0].prepared.length,0);assert.match(JSON.stringify(messages),/tN仅指本包/);}return finish(maintenanceResult(messages,attempts>1));});
  try{const start=f.book.text.indexOf('\n')+1,end=chapterContentEnd(f.book,f.book.chapters[0]);await f.observe({start,end});await until(()=>!f.engine.busy);assert.equal(attempts,2);const calls=f.state.usage.filter(u=>u.maintenanceDispatch);assert.equal(calls.length,2);assert.equal(new Set(calls.map(u=>u.maintenanceDispatch!.request.maintenanceJobId)).size,1);assert.equal(f.state.memories.length,1,JSON.stringify(f.state.maintenanceJobs));assert.equal(f.state.publishedViews?.length,2);assert.ok(covers(f.book.prepared,{start,end}));assert.equal(calls.filter(u=>u.maintenanceDispatch?.committed).length,1);}finally{await f.close();}
});

test('后续新正文可复用本包完整认识并双keep，同批提交后才推进prepared',async()=>{
 let maintenance=0;const f=await setup(async(role,messages)=>{if(role==='scene')return finish({quiet:true});maintenance++;const p=messages.flatMap(m=>m.content.split('\n\n').flatMap(t=>{try{return[JSON.parse(t)];}catch{return[];}})).find(p=>p.task==='maintenance');return finish({documents:[{operation:'create',text:'本批工程记录已保存。',sourceIds:['p1']}],views:p.viewTargets.map((target:string)=>{const old=p.views.find((v:any)=>v.id===target);return old?{operation:'keep',kind:old.kind,key:old.key,previousId:old.id,sourceViewIds:[old.id],sourceMemoryIds:['t1']}:{kind:target,key:'工程状态',text:'工程状态已登记。',sourceMemoryIds:['t1']};})});});
 try{const first=f.book.chapters[0],second=f.book.chapters[1],a={start:f.book.text.indexOf('\n')+1,end:chapterContentEnd(f.book,first)},b={start:f.book.text.indexOf('\n',second.start)+1,end:chapterContentEnd(f.book,second)};await f.observe(a);await until(()=>!f.engine.busy);const id=f.state.memories[0].id;await f.observe(b);await until(()=>!f.engine.busy);assert.equal(maintenance,2);assert.equal(f.state.memories.length,1);assert.equal(f.state.memories[0].id,id);assert.ok(covers(f.book.prepared,b));const last=f.state.usage.filter(u=>u.maintenanceDispatch?.committed).at(-1)!;assert.equal(last.maintenanceDispatch!.committed!.viewIds.length,2);assert.ok(last.maintenanceDispatch!.committed!.memoryIds.includes(id));}finally{await f.close();}
});

test('章末claim在途时迟到quiet成果原子登记；后续只采用原record一次',async()=>{
  const entered=deferred(),release=deferred();let maintenanceCalls=0;const f=await setup(async(role,messages)=>{if(role==='scene'){await entered.promise;return finish({quiet:true,sceneInsight:{text:'本段工程状态还需核对。',sourceIds:['p1']}});}maintenanceCalls++;if(maintenanceCalls===1){entered.resolve();await release.promise;}return finish(maintenanceResult(messages));});
  try{const start=f.book.text.indexOf('\n')+1,end=chapterContentEnd(f.book,f.book.chapters[0]);const reading=f.observe({start,end});await until(()=>!!f.state.readings?.some(r=>r.sceneInsight));const record=f.state.readings!.find(r=>r.sceneInsight)!;assert.ok(f.disk().maintenanceJobs?.some(j=>j.sceneRecordIds?.includes(record.id)));assert.ok(f.state.usage.find(u=>u.maintenanceDispatch)?.maintenanceDispatch?.claim.sceneRecordIds===undefined);release.resolve();await reading;await until(()=>!f.engine.busy);assert.equal(maintenanceCalls,2,JSON.stringify(f.state.maintenanceJobs));const consumed=f.state.usage.filter(u=>u.maintenanceDispatch?.committed&&u.maintenanceDispatch.claim.sceneRecordIds?.includes(record.id));assert.equal(consumed.length,1);assert.deepEqual(consumed[0].maintenanceDispatch!.claim.ranges,[]);const saved=await restoreBackup(JSON.stringify(f.disk()),initialState());assert.ok(saved.readings?.some(r=>r.id===record.id&&r.sceneInsight));assert.equal(saved.maintenanceJobs?.length??0,0);}finally{release.resolve();await f.close();}
});

test('保存期间读者翻过原段：同ID原话转段评且不触即时回调',async()=>{
  const saving=deferred(),release=deferred();let scene=0;const text='第一章 登记\n工程登记已完成。\n\n第二章 复测\n工程复测已完成。\n';
  const f=await setup(async role=>{assert.equal(role,'scene');scene++;return finish(scene===1?{reaction:{text:'登记结果已保存。',sourceId:'p1',quote:'工程登记已完成'}}:{quiet:true});},text);
  f.book.known=[{start:0,end:text.length}];f.book.prepared=[...f.book.known];const save=f.store.save.bind(f.store);let held=false;
  f.store.save=async state=>{if(!held&&state.chats.some(c=>c.readingReaction&&c.publication?.status==='published')){held=true;saving.resolve();await release.promise;}await save(state);};
  try{const chapter=f.book.chapters[0],first={start:text.indexOf('\n')+1,end:chapterContentEnd(f.book,chapter)},second={start:text.indexOf('\n',f.book.chapters[1].start)+1,end:chapterContentEnd(f.book,f.book.chapters[1])};
    const original=f.observe(first);await saving.promise;const moved=f.observe(second);await until(()=>f.book.position===second.end);release.resolve();await Promise.all([original,moved]);
    const candidate=f.state.chats.find(c=>c.readingReaction)!;assert.equal(candidate.presentation,'paragraph');assert.equal(candidate.anchor?.quote,'工程登记已完成');assert.equal(candidate.publication?.destination,'paragraph');assert.deepEqual(f.shown,[]);assert.equal(f.state.chats.filter(c=>c.text==='登记结果已保存。').length,1);const restored=await restoreBackup(JSON.stringify(f.disk()),initialState());assert.equal(restored.chats.find(c=>c.id===candidate.id)?.anchor?.hash,candidate.anchor?.hash);
  }finally{release.resolve();await f.close();}
});

test('暂停只挂起自动下一派发，明确QA使用实际空位；普通插话不取消原在途',async()=>{
  const entered=deferred(),release=deferred();let maintenance=0,queries=0;const f=await setup(async(role,messages)=>{if(role==='scene'){entered.resolve();await release.promise;return finish({quiet:true});}if(role==='query'){queries++;return{content:'工程核对已完成。',reasoning:'',finish:'stop',toolCalls:[],input:10,output:5,estimated:false,elapsedMs:1};}maintenance++;if(maintenance===1)return{...finish({}),toolCalls:[{id:'lookup',type:'function',function:{name:'discover_memory_documents',arguments:'{"query":"工程登记"}'}}]};return finish(maintenanceResult(messages));});
  try{const start=f.book.text.indexOf('\n')+1,end=chapterContentEnd(f.book,f.book.chapters[0]),reading=f.observe({start,end});await entered.promise;await f.engine.pauseReadingSafely();const asking=f.engine.ask(f.book.id,'核对工程记录。');await until(()=>queries===1);await asking;assert.equal(f.maxActive(),2);assert.ok(f.active()>=1);assert.equal(f.state.usage.filter(u=>u.status==='unknown').length,0,JSON.stringify({calls:f.calls(),maintenance,jobs:f.state.maintenanceJobs,tools:f.state.usage.map(u=>[u.purpose,u.modelTools])}));release.resolve();await reading;await f.engine.resumeReadingSafely();await until(()=>!f.engine.busy);assert.ok(maintenance>=1);assert.equal(f.state.usage.filter(u=>u.status==='unknown').length,0,JSON.stringify({calls:f.calls(),maintenance,jobs:f.state.maintenanceJobs,tools:f.state.usage.map(u=>[u.purpose,u.modelTools])}));}finally{release.resolve();await f.close();}
});

test('整段已准备的历史原文按真实观察累计节奏；首包按完整工具预算保整份全文',async()=>{
  const f=await setup(async(role,messages)=>{assert.equal(role,'scene');const packet=messages.flatMap(m=>m.content.split('\n\n').flatMap(t=>{try{return[JSON.parse(t)];}catch{return[];}})).find(p=>p.task==='scene');assert.ok(packet.memories.length<2);for(const m of packet.memories)assert.equal(m.text,'工程容量全文。'+'整份记录'.repeat(2800));assert.ok(packet.remainingMemoryIds.length,JSON.stringify({remaining:packet.remainingMemoryIds,unavailable:packet.unavailableMemoryIds,selection:packet.selection}));return finish({quiet:true});});
  try{const start=f.book.text.indexOf('\n')+1,end=chapterContentEnd(f.book,f.book.chapters[0]);f.book.known=[{start,end}];f.book.prepared=[{start,end}];f.state.settings.services[0].contextLimit=24000;for(let n=0;n<2;n++)f.state.memories.push({id:'capacity-'+n,bookId:f.book.id,partnerId:f.state.partnerId,kind:'opinion',text:'工程容量全文。'+'整份记录'.repeat(2800),source:'reading',sourceEvidence:[{bookId:f.book.id,version:f.book.version,start,end:start+650}],evidence:[{bookId:f.book.id,version:f.book.version,start,end:start+650}],parents:[],chatIds:[],createdAt:n,forgotten:false});await f.observe({start,end:start+50});assert.equal(f.calls(),0);await f.observe({start:start+50,end:start+650});assert.equal(f.calls(),1);assert.equal(f.state.readings?.find(r=>r.sceneOpportunity)?.sceneOpportunity?.slot,1);assert.ok(covers(f.book.sceneObserved![0].ranges,{start,end:start+650}));const restored=await restoreBackup(JSON.stringify(f.disk()),initialState());assert.ok(covers(restored.books[0].sceneObserved![0].ranges,{start,end:start+650}));}finally{await f.close();}
});

test('旧PC章尾元数据异步补齐只规划位置；迟到观察不覆盖最新现场且保实际范围',async()=>{
  const text='第一章 登记\n'+paragraph(1)+'\n\n第二章 复测\n工程复测已完成。\n',tailEntered=deferred(),tailRelease=deferred();const f=await setup(async(role,messages)=>role==='scene'?finish({quiet:true}):finish(maintenanceResult(messages)),text);
  const originalRead=f.store.readBookRanges!.bind(f.store),first=f.book.chapters[0],second=f.book.chapters[1],a={start:text.indexOf('\n')+1,end:text.indexOf('\n')+51},b={start:text.indexOf('\n',second.start)+1,end:chapterContentEnd(f.book,second)};let held=false;
  f.book.known=[{start:0,end:text.length}];f.book.prepared=[...f.book.known];delete first.contentEnd;delete second.contentEnd;f.book.text='';f.store.readBookRanges=async(version,ranges)=>{if(!held&&ranges.some(r=>r.end===first.end)){held=true;tailEntered.resolve();await tailRelease.promise;}return originalRead(version,ranges);};
  try{const old=f.engine.observe(f.book.id,text.slice(a.start,a.end),'body','continuous-page',{...a,version:f.book.version});await tailEntered.promise;await f.engine.observe(f.book.id,text.slice(b.start,b.end),'body','continuous-page',{...b,version:f.book.version});assert.equal(f.book.position,b.end);tailRelease.resolve();await old;assert.equal(f.book.position,b.end);assert.equal(first.contentEnd,text.slice(0,first.end).trimEnd().length);assert.ok(covers(f.book.sceneObserved![0].ranges,a));assert.ok(covers(f.book.sceneObserved![0].ranges,b));assert.equal(f.observed.filter(call=>call.role==='scene').length,1);}finally{tailRelease.resolve();await f.close();}
});
