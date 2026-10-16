import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../src/core/state.ts';
import { importBook } from '../src/core/books.ts';
import { parseReadingReply } from '../src/core/model.ts';
import { ReadingSources } from '../src/core/reading-sources.ts';
import { ReadingReferences } from '../src/core/reading-references.ts';
import { queryMaterialStamp } from '../src/core/query-checkpoints.ts';
import { createReadingDraft } from '../src/core/reading-drafts.ts';
import { companionReadingReceiptIds, companionReadingReceiptUsable, matchingCompanionReadingReceipt, mergeCompanionReadingReceipts, pruneCompanionReadingReceipts, readingReceiptCandidate, receiveCompanionReadingReceipt, validateCompanionReadingReceipts } from '../src/core/companion-receipts.ts';
import type { AgentModelReply, ModelReply, QueryMaterial, ReadingDraftRequest } from '../src/core/types.ts';

const payload={reply:'',thoughts:[{kind:'opinion',text:'新的复测阶段应接续旧检修愿望。',updates:'m1',updateReason:'复测开始',basis:{memoryIds:['m1'],chatIds:[]}}],workspace:{understanding:'t1'}};
const response=(text=JSON.stringify(payload)):AgentModelReply=>({content:'',reasoning:'PRIVATE REASONING SHOULD NEVER BE STORED',input:11,output:7,estimated:false,finish:'tool_calls',toolCalls:[{id:'submit-call',type:'function',function:{name:'submit_reading',arguments:text}}]});

async function fixture(source:ReadingDraftRequest['source']='reading'){
  const state=initialState(),book=await importBook('回执接续工程','第一章 检修\n检修员希望恢复正常运行，设备已移入检修室。\n第二章 复测\n校准已完成，设备正在进行复测。');
  state.books=[book];book.known=[{start:0,end:book.text.length}];book.position=book.text.length;
  const range={start:book.chapters[0].start,end:book.chapters[0].start+20},e={...range,bookId:book.id,version:book.version};
  state.memories=[{id:'original-opinion',bookId:book.id,partnerId:state.partnerId,kind:'opinion',text:'检修员希望恢复正常运行，仍在等待校准。',source:source==='background'?'background':'reading',evidence:[e],parents:[],chatIds:[],createdAt:1,forgotten:false}];
  const refs=new ReadingReferences(),messages=refs.messages([{role:'user',content:JSON.stringify({memories:[state.memories[0]],current:book.text.slice(range.start,range.end)})}]);
  const material:QueryMaterial={messages,refs:[e],originalRanges:[range],memoryIds:['original-opinion'],chatIds:[],habitIds:[],passages:[['p1',{text:book.text.slice(range.start,range.start+10),evidence:{...e,end:range.start+10}}]],references:refs.snapshot(),webSources:[],ranges:[range],readUrls:[],readingStrategy:'companion',narrativeMode:'legacy',workspaceRevision:0,workspaceSource:source==='background'?'background':'reading'};
  const request:ReadingDraftRequest={source,ranges:[range],input:'自动跟读'},requestKey=JSON.stringify([book.id,book.version,state.partnerId,source,request.ranges]);
  state.usage.push({id:'actual-usage',time:Date.now(),serviceId:state.settings.serviceId,purpose:'连续理解',input:11,output:7,estimated:false,status:'complete',dispatchState:'response-received',requestKey});
  const stamp=queryMaterialStamp(state,material),receive=()=>receiveCompanionReadingReceipt(state,book,request,requestKey,'actual-usage',material,stamp,response())!;
  return{state,book,request,requestKey,material,stamp,receive};
}

test('已返回完整理解在Abort前接住，磁盘恢复沿原短号与资料解析，零重答且不保存reasoning',async()=>{
  const f=await fixture(),abort=new AbortController();abort.abort();
  const r=f.receive();assert.equal(abort.signal.aborted,true);assert.equal(r.status,'received');
  assert.equal(JSON.stringify(r).includes('PRIVATE REASONING'),false);
  const disk=JSON.parse(JSON.stringify(f.state));validateCompanionReadingReceipts(disk);pruneCompanionReadingReceipts(disk);
  const old=matchingCompanionReadingReceipt(disk,disk.books[0],f.request,f.requestKey)!;
  assert.equal(companionReadingReceiptUsable(disk,old),true);
  const refs=new ReadingReferences();refs.restore(old.material.references);
  const parsed=refs.decode(parseReadingReply(old.candidate.text,old.material.stateWriteVersion,old.material.readingStrategy));
  assert.equal(parsed.thoughts[0].updates,'original-opinion');assert.equal(parsed.workspace?.understanding,'t1');
  assert.equal(disk.usage.length,1);assert.equal(disk.usage[0].output,7);
  disk.companionWorkspaces=[{bookId:f.book.id,version:f.book.version,partnerId:disk.partnerId,source:'reading',revision:12,focusIds:[],updatedAt:Date.now()}];
  assert.equal(companionReadingReceiptUsable(disk,old),true,'前台新工作台不改原资料，旧原答仍可解析，发布CAS由engine决定');
});

test('只有真正完整的最终回执成为候选，中途工具与混合提交不能被误保存',()=>{
  assert.deepEqual(readingReceiptCandidate(response()),{transport:'agent',format:'submit',text:JSON.stringify(payload)});
  assert.equal(readingReceiptCandidate(response('{"reply":"","thoughts":[]'))?.text,'{"reply":"","thoughts":[]}');
  assert.equal(readingReceiptCandidate(response('{"reply":"broken"')),undefined);
  const intermediate=response(JSON.stringify({reply:'',read:{start:0,end:10}}));assert.equal(readingReceiptCandidate(intermediate),undefined);
  const mixed=response();mixed.toolCalls.push({id:'read',type:'function',function:{name:'read_original',arguments:'{"start":0,"end":10}'}});assert.equal(readingReceiptCandidate(mixed),undefined);
  const json:ModelReply={content:'{"recall":{"kind":"opinion"}}',input:1,output:1,estimated:false};assert.equal(readingReceiptCandidate(json),undefined);
  assert.equal(readingReceiptCandidate({...response(),finish:'stop',toolCalls:[],content:'资料已经足够。'})?.format,'content');
});

test('冷启动尚未载入外部原文只核形成版本与坐标，载回正文后仍严格核对原p',async()=>{
  const f=await fixture(),r=f.receive(),original=f.book.text;f.book.textLength=original.length;f.book.text='';
  validateCompanionReadingReceipts(f.state);assert.equal(pruneCompanionReadingReceipts(f.state),false);assert.equal(r.status,'received');
  f.book.text=original;assert.equal(companionReadingReceiptUsable(f.state,r),true);
  f.book.text='异'+original.slice(1);assert.equal(companionReadingReceiptUsable(f.state,r),false);assert.equal(pruneCompanionReadingReceipts(f.state),true);assert.equal(r.status,'blocked');
});

test('来源撤回或更正后保留blocked原答，匹配不会误以为未请求；变更当前伙伴不改形成身份',async()=>{
  for(const change of ['permission','memory','forgotten'] as const){
    const f=await fixture(),r=f.receive();
    if(change==='permission')f.book.known=[];
    if(change==='memory')f.state.memories[0].invalidatedBy='actual-correction';
    if(change==='forgotten')f.state.forgotten.push({id:'forgotten',bookId:f.book.id,text:'新的复测阶段',time:Date.now()});
    assert.equal(companionReadingReceiptUsable(f.state,r),false);assert.equal(pruneCompanionReadingReceipts(f.state),true);
    assert.equal(r.status,'blocked');assert.equal(matchingCompanionReadingReceipt(f.state,f.book,f.request)?.id,r.id);
    assert.equal(r.candidate.text,JSON.stringify(payload));assert.equal(f.state.usage.length,1);
    validateCompanionReadingReceipts(f.state);
  }
  const f=await fixture(),formedPartner=f.state.partnerId;f.state.partners.push({...f.state.partners[0],id:'different-partner'});f.state.partnerId='different-partner';
  assert.equal(f.receive().partnerId,formedPartner);
});

test('实际调用关联和原资料模式必须有效，目录字典损坏不能替换原权限',async()=>{
  for(const change of ['unknown','key','profile','dictionary'] as const){
    const f=await fixture();
    if(change==='unknown')f.state.usage[0].status='unknown';
    if(change==='key')f.state.usage[0].requestKey='unrelated-request';
    if(change==='profile')f.material.readingStrategy='structured';
    if(change==='dictionary')f.material.references.memory=[['unprovided','c1']];
    assert.throws(()=>f.receive());assert.equal(f.state.companionReadingReceipts,undefined);
  }
  const f=await fixture();f.book.known=[];const blocked=f.receive();assert.equal(blocked.status,'blocked','回执到达时权限已变化仍接住原答，不重答');
  f.state.books=[];validateCompanionReadingReceipts(f.state);assert.equal(pruneCompanionReadingReceipts(f.state),true);assert.deepEqual(f.state.companionReadingReceipts,[]);
});

test('同原usage精确消费与本地blocked跨备份保持；同范围的另一结果不吞原答',async()=>{
  const f=await fixture(),r=f.receive(),old=structuredClone(f.state);
  const parsed=parseReadingReply(JSON.stringify(payload),undefined,'companion');
  const draft=createReadingDraft(f.state,f.book,f.request,parsed,[],{...f.material,messages:f.material.messages},'ready');draft.id='another-response';f.state.readingDrafts=[draft];
  assert.equal(companionReadingReceiptUsable(f.state,r),true,'同范围另一结果不消费原usage');
  draft.id=r.id;assert.equal(companionReadingReceiptUsable(f.state,r),false);assert.equal(pruneCompanionReadingReceipts(f.state),true);
  mergeCompanionReadingReceipts(old,f.state);assert.deepEqual(old.companionReadingReceipts,[],'旧备份不得复活已形成草稿的同原答');
  const g=await fixture(),blocked=g.receive(),snapshot=structuredClone(g.state);blocked.status='blocked';blocked.blockedReason='明确更正';
  mergeCompanionReadingReceipts(snapshot,g.state);assert.equal(snapshot.companionReadingReceipts?.[0].status,'blocked');
  assert.equal(snapshot.companionReadingReceipts?.[0].candidate.text,blocked.candidate.text);
  g.state.readings=[{id:'finished-reading',bookId:g.book.id,version:g.book.version,partnerId:g.state.partnerId,source:'reading',ranges:g.request.ranges,memoryIds:[],createdAt:Date.now(),draftId:blocked.id}];
  mergeCompanionReadingReceipts(snapshot,g.state);assert.deepEqual(snapshot.companionReadingReceipts,[]);
});

test('同Harness明确后提交替代原错误候选，恢复只取末候选，消费整链不吞无链同范围回执',async()=>{
  const f=await fixture(),first=f.receive(),early=structuredClone(f.state);
  const nextUsage=(id:string)=>f.state.usage.push({...f.state.usage[0],id});
  nextUsage('corrected-usage');const corrected=receiveCompanionReadingReceipt(f.state,f.book,f.request,f.requestKey,'corrected-usage',f.material,f.stamp,response(),first.id)!;
  nextUsage('latest-usage');const latest=receiveCompanionReadingReceipt(f.state,f.book,f.request,f.requestKey,'latest-usage',f.material,f.stamp,response(),corrected.id)!;
  assert.deepEqual(companionReadingReceiptIds(f.state,latest.id),[latest.id,corrected.id,first.id]);
  assert.equal(companionReadingReceiptUsable(f.state,first),false);assert.equal(matchingCompanionReadingReceipt(f.state,f.book,f.request)?.id,latest.id);
  const pending=JSON.parse(JSON.stringify(f.state));validateCompanionReadingReceipts(pending);assert.equal(matchingCompanionReadingReceipt(pending,pending.books[0],f.request)?.id,latest.id);
  nextUsage('unlinked-same-range');const unlinked=receiveCompanionReadingReceipt(f.state,f.book,f.request,f.requestKey,'unlinked-same-range',f.material,f.stamp,response())!;
  assert.deepEqual(companionReadingReceiptIds(f.state,latest.id),[latest.id,corrected.id,first.id]);
  const parsed=parseReadingReply(JSON.stringify(payload),undefined,'companion'),draft=createReadingDraft(f.state,f.book,f.request,parsed,[],f.material,'ready');draft.id=latest.id;draft.supersededReceiptIds=companionReadingReceiptIds(f.state,latest.id).slice(1);f.state.readingDrafts=[draft];
  assert.equal(pruneCompanionReadingReceipts(f.state),true);assert.deepEqual(f.state.companionReadingReceipts?.map(r=>r.id),[unlinked.id]);
  early.usage=structuredClone(f.state.usage);mergeCompanionReadingReceipts(early,f.state);assert.deepEqual(early.companionReadingReceipts?.map(r=>r.id),[unlinked.id],'仅有最早错误回执的旧备份也不得复活祖先');assert.equal(early.companionReadingReceipts?.[0].status,'received');
  f.state.readingDrafts=[];f.state.readings=[{id:'chain-consumed-reading',bookId:f.book.id,version:f.book.version,partnerId:f.state.partnerId,source:f.request.source,ranges:f.request.ranges,memoryIds:[],createdAt:Date.now(),draftId:latest.id,supersededReceiptIds:[corrected.id,first.id]}];
  const ancestorOnly=structuredClone(pending);ancestorOnly.companionReadingReceipts=ancestorOnly.companionReadingReceipts?.filter(r=>r.id===first.id);
  ancestorOnly.usage=structuredClone(f.state.usage);mergeCompanionReadingReceipts(ancestorOnly,f.state);assert.deepEqual(ancestorOnly.companionReadingReceipts?.map(r=>r.id),[unlinked.id]);assert.equal(ancestorOnly.companionReadingReceipts?.[0].status,'received');
});

test('替代链接只允许同真实task并拒绝缺前项、循环及不同input；无字段旧回执仍兼容',async()=>{
  const f=await fixture(),first=f.receive();f.state.usage.push({...f.state.usage[0],id:'next-usage'});
  assert.throws(()=>receiveCompanionReadingReceipt(f.state,f.book,{...f.request,input:'另一个实际任务'},f.requestKey,'next-usage',f.material,f.stamp,response(),first.id),/替代链/);
  assert.throws(()=>receiveCompanionReadingReceipt(f.state,f.book,f.request,f.requestKey,'next-usage',f.material,f.stamp,response(),'missing-previous'),/替代链/);
  assert.equal(f.state.companionReadingReceipts?.length,1);validateCompanionReadingReceipts(f.state);
  const next=receiveCompanionReadingReceipt(f.state,f.book,f.request,f.requestKey,'next-usage',f.material,f.stamp,response(),first.id)!;
  first.supersedesId=next.id;assert.throws(()=>validateCompanionReadingReceipts(f.state),/循环/);
  delete first.supersedesId;validateCompanionReadingReceipts(f.state);
  const bad=structuredClone(f.state);bad.companionReadingReceipts![1].partnerId='another-partner';assert.throws(()=>companionReadingReceiptIds(bad,next.id),/同任务/);
});


test('有效多步原文取材超过256个p时，原答保留完整字典而不另设隐含取材上限',async()=>{
 const state=initialState(),book=await importBook('原文资料展开工程','第一章 SOURCE\n'+('ENGINE SOURCE FIELD '.repeat(5)+'\n').repeat(650));state.books=[book];book.known=[{start:0,end:book.text.length}];
 const range=book.known[0],sources=new ReadingSources(),provided=sources.render(book,range);assert.ok(sources.passages.size>256);
 const material:QueryMaterial={messages:[{role:'user',content:JSON.stringify({current:provided})}],refs:[{...range,bookId:book.id,version:book.version}],originalRanges:[range],memoryIds:[],chatIds:[],habitIds:[],passages:[...sources.passages],references:new ReadingReferences().snapshot(),webSources:[],ranges:[range],readUrls:[],readingStrategy:'companion',narrativeMode:'legacy',workspaceRevision:0,workspaceSource:'reading'};
 const request:ReadingDraftRequest={source:'reading',ranges:[range],input:''},key=JSON.stringify([book.id,book.version,state.partnerId,'reading',request.ranges]);state.usage.push({id:'wide-source-original',time:1,serviceId:state.settings.serviceId,purpose:'连续阅读取材',input:1,output:1,estimated:false,status:'complete',dispatchState:'response-received',requestKey:key});
 const original=receiveCompanionReadingReceipt(state,book,request,key,'wide-source-original',material,queryMaterialStamp(state,material),response(JSON.stringify({reply:'',thoughts:[{kind:'opinion',text:'ENGINE VIEW',quoteSource:'p'+sources.passages.size}],workspace:{understanding:'t1'}})))!;
 assert.equal(original.status,'received');assert.equal(original.material.passages.length,sources.passages.size);assert.equal(companionReadingReceiptUsable(state,original),true);validateCompanionReadingReceipts(state);
 const restored=new ReadingSources();restored.restore(original.material.passages);assert.equal(restored.passages.get('p'+sources.passages.size)?.text,sources.passages.get('p'+sources.passages.size)?.text);
});
