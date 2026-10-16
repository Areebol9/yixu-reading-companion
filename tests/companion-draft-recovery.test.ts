import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState} from '../src/core/state.ts';
import {importBook} from '../src/core/books.ts';
import {correctMemory,forgetMemory} from '../src/core/context.ts';
import {createReadingDraft,dependencyStamp,readingDraftUsable,validateReadingDrafts} from '../src/core/reading-drafts.ts';
import {queryCheckpoint,queryMaterialStamp,queryResultUsable,validateQueryCheckpoints} from '../src/core/query-checkpoints.ts';
import {planWorkspace} from '../src/core/companion-workspace.ts';
import {pruneCompanionReadingReceipts,receiveCompanionReadingReceipt} from '../src/core/companion-receipts.ts';
import {ReadingReferences} from '../src/core/reading-references.ts';
import {restoreBackup} from '../src/core/backup.ts';
import type {QueryMaterial,ReadingReply} from '../src/core/types.ts';

async function fixture(){
  const state=initialState(),book=await importBook('伴读原答恢复资料','第一章 检修\n检修员希望恢复正常运行，设备已移入检修室。\n第二章 复测\n校准已完成，设备正在进行复测。');
  state.books=[book];book.known=[{start:0,end:book.text.length}];book.position=book.text.length;book.readingStrategy='companion';
  const span={start:0,end:book.chapters[0].end},e={...span,bookId:book.id,version:book.version};
  const old={id:'source-opinion',bookId:book.id,partnerId:state.partnerId,kind:'opinion' as const,text:'检修员希望恢复正常运行，仍在等待校准。',evidence:[e],parents:[],chatIds:[],createdAt:1,forgotten:false,source:'reading' as const};state.memories=[old];
  state.conversations=[{id:'session',bookId:book.id,title:'检修交流',manualTitle:false,start:0,end:span.end,createdAt:1}];
  const q={id:'question',bookId:book.id,partnerId:state.partnerId,sessionId:'session',role:'user' as const,text:'检修员的愿望如何接续？',evidence:[e],createdAt:2,excluded:false,delivery:'failed' as const};state.chats=[q];
  const refs=new ReadingReferences();const messages=refs.messages([{role:'user',content:JSON.stringify({current:book.text.slice(span.start,span.end),memories:[old]})}]);
  const material:QueryMaterial={messages,refs:[e],originalRanges:[span],memoryIds:[old.id],chatIds:[q.id],habitIds:[],passages:[['p1',{text:book.text.slice(0,12),evidence:{...e,end:12}}]],
    references:refs.snapshot(),webSources:[],ranges:[span],readUrls:[],readingStrategy:'companion',narrativeMode:'legacy',workspaceRevision:0,workspaceSource:'reading'};
  const result:ReadingReply={reply:'',wantsLong:false,thoughts:[{kind:'opinion',text:'完整接续看法。'.repeat(800)}],workspace:{understanding:'t1',focus:[old.id]}};
  const request={source:'reading' as const,ranges:[span],input:'自动跟读'};
  return{state,book,old,q,material,result,request};
}

test('伴读完整草稿与问题结果保留形成模式；前台正常发展后原答仍能独立恢复',async()=>{
  const f=await fixture(),draft=createReadingDraft(f.state,f.book,f.request,f.result,[],f.material,'ready');f.state.readingDrafts=[draft];
  const cp=queryCheckpoint(f.state,f.q.id);cp.status='ready';cp.material=structuredClone(f.material);cp.result={...f.result,reply:'检修员的愿望继续影响复测阶段。'};cp.dependencyStamp=queryMaterialStamp(f.state,cp.material,cp.result);
  validateReadingDrafts(f.state);validateQueryCheckpoints(f.state);assert.ok(readingDraftUsable(f.state,draft));assert.ok(queryResultUsable(f.state,cp));
  const next={...f.old,id:'foreground-opinion',text:'检修员的愿望已接到复测，校准完成。',parents:[f.old.id],correctionOf:f.old.id,revisionKind:'development' as const,revisionReason:'复测开始。'};
  f.old.replacedBy=next.id;f.state.memories.push(next);
  planWorkspace(f.state,f.book,{understanding:'t1',focus:[]},{memoryIds:[],proposalMemoryIds:{t1:next.id}},{expectedRevision:0});
  assert.ok(readingDraftUsable(f.state,draft));assert.ok(queryResultUsable(f.state,cp));
  assert.equal(draft.material.workspaceRevision,0);assert.equal(draft.material.workspaceSource,'reading');
  const restored=await restoreBackup(JSON.stringify(f.state),initialState());
  assert.equal(restored.readingDrafts?.[0].material.readingStrategy,'companion');assert.equal(restored.readingDrafts?.[0].material.workspaceRevision,0);
  assert.equal(restored.readingDrafts?.[0].result.thoughts[0].text,f.result.thoughts[0].text);
  assert.ok(readingDraftUsable(restored,restored.readingDrafts![0]));assert.ok(queryResultUsable(restored,restored.queryCheckpoints![0]));
});

test('原答依赖仍保护完整原文、真实来源和形成版本；更正、遗忘、撤权拒用',async()=>{
  for(const change of ['correction','forget','permission','chat','original','formation'] as const){
    const f=await fixture(),draft=createReadingDraft(f.state,f.book,f.request,f.result,[],f.material,'ready');f.state.readingDrafts=[draft];
    const cp=queryCheckpoint(f.state,f.q.id);cp.status='ready';cp.material=structuredClone(f.material);cp.result=f.result;cp.dependencyStamp=queryMaterialStamp(f.state,cp.material,cp.result);
    if(change==='correction')correctMemory(f.state,f.old.id,'检修登记已更正。');
    if(change==='forget')forgetMemory(f.state,f.old.id);
    if(change==='permission')f.book.known=[];
    if(change==='chat')f.q.excluded=true;
    if(change==='original'){draft.material.originalRanges[0].end--;cp.material.originalRanges[0].end--;}
    if(change==='formation'){draft.material.workspaceRevision=1;cp.material.workspaceRevision=1;}
    assert.equal(readingDraftUsable(f.state,draft),false,change);assert.equal(queryResultUsable(f.state,cp),false,change);
  }
});

test('旧草稿与旧指纹在书籍切换伴读后沿原structured恢复，不能获得新完整写入能力',async()=>{
  const f=await fixture(),legacy={...f.material};delete legacy.readingStrategy;delete legacy.workspaceRevision;delete legacy.workspaceSource;
  const ordinary:ReadingReply={reply:'',wantsLong:false,thoughts:[{kind:'opinion',text:'继续留意检修与复测。'}]};
  assert.equal(dependencyStamp(f.state,legacy),dependencyStamp(f.state,{...legacy,readingStrategy:'structured',stateWriteVersion:1}));
  const draft=createReadingDraft(f.state,f.book,f.request,ordinary,[],legacy,'ready');delete draft.material.readingStrategy;f.state.readingDrafts=[draft];
  validateReadingDrafts(f.state);const restored=await restoreBackup(JSON.stringify(f.state),initialState());assert.ok(readingDraftUsable(restored,restored.readingDrafts![0]));
  assert.equal(restored.readingDrafts?.[0].result.workspace,undefined);
  draft.result=f.result;assert.throws(()=>validateReadingDrafts(f.state),/记忆条目|workspace/);
});

test('receipt原usage形成同id草稿，再由ReadingRecord.draftId精确消费且不重派',async()=>{
  const f=await fixture(),requestKey=JSON.stringify([f.book.id,f.book.version,f.state.partnerId,f.request.source,f.request.ranges]);
  f.state.usage=[{id:'returned-usage',requestKey,time:1,serviceId:f.state.settings.serviceId,purpose:'跟读',input:10,output:10,estimated:false,status:'complete',dispatchState:'response-received'}];
  const receipt=receiveCompanionReadingReceipt(f.state,f.book,f.request,requestKey,'returned-usage',f.material,queryMaterialStamp(f.state,f.material),{content:JSON.stringify(f.result),input:10,output:10,estimated:false})!;
  const draft=createReadingDraft(f.state,f.book,f.request,f.result,[],f.material,'ready');draft.id=receipt.id;f.state.readingDrafts=[draft];
  validateReadingDrafts(f.state);assert.equal(pruneCompanionReadingReceipts(f.state),true);assert.deepEqual(f.state.companionReadingReceipts,[]);
  f.state.readings=[{id:'completed',bookId:f.book.id,version:f.book.version,partnerId:f.state.partnerId,source:'reading',ranges:f.request.ranges,memoryIds:[],draftId:draft.id,createdAt:2}];
  assert.equal(readingDraftUsable(f.state,draft),false);const restored=await restoreBackup(JSON.stringify(f.state),f.state);assert.deepEqual(restored.readingDrafts,[]);
});
