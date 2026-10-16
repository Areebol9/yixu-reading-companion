import test from 'node:test';
import assert from 'node:assert/strict';
import {importBook} from '../src/core/books.ts';
import {correctMemory,evidence} from '../src/core/context.ts';
import {initialState} from '../src/core/state.ts';
import {hashText} from '../src/core/text-hash.ts';
import {hydrateMemoryBodies} from '../src/core/memory-bodies.ts';
import {prepareMemoryIdentities,prepareMemoryTextIdentity,memoryContentIdentity,stampsEqual} from '../src/core/memory-identity.ts';
import {prepareMemoryRecovery} from '../src/core/memory-recovery.ts';
import {createReadingDraft,dependencyStamp,readingDraftUsable} from '../src/core/reading-drafts.ts';
import {correctionFocusRevision,correctionRepairStamp,correctionRepairUsable} from '../src/core/companion-correction-repair.ts';
import {restoreReadingEngine} from '../src/core/runtime.ts';
import {projectWorkDossier} from '../src/core/work-dossier.ts';
import {createFactReview} from '../src/core/fact-review.ts';
import type {Memory,MemoryBody,ReadingDraftMaterial,Store} from '../src/core/types.ts';

async function fixture(){
  const state=initialState(),book=await importBook('正文接续工程','第一章 登记\n设备甲共有三件。原材料保存在柜中。');
  state.books=[book];book.known=[{start:0,end:book.text.length}];
  const memory:Memory={id:'actual-memory',bookId:book.id,partnerId:state.partnerId,kind:'story',text:'设备甲共有三件。',evidence:book.known.map(r=>evidence(book,r)),parents:[],chatIds:[],createdAt:1,forgotten:false,source:'reading'};
  state.memories=[memory];
  const material:ReadingDraftMaterial={messages:[],refs:memory.evidence,originalRanges:[...book.known],memoryIds:[memory.id],chatIds:[],habitIds:[],passages:[]};
  const body=async(m:Memory):Promise<MemoryBody>=>{const text=m.text!,hash=await hashText(text),key='memory-body-'+hash;m.bodyRef={key,hash,chars:text.length};return {key,hash,text};};
  const draft=(v2=false)=>createReadingDraft(state,book,{source:'preparation',ranges:[...book.known],input:'工程输入'},{reply:'',thoughts:[],wantsLong:false},[],{...material,...(v2?{sourceStampVersion:2 as const}:{})},'ready');
  return {state,book,memory,material,body,draft};
}

test('正文来源身份跨驻留、存储key和导航保持，同长改字与撤回使结果失效',async()=>{
  const f=await fixture();await prepareMemoryIdentities([f.memory]);const d=f.draft(true),original=d.dependencyStamp;await f.body(f.memory);
  f.memory.documentTitle='导航标题';f.memory.navigationCues=['导航词'];f.memory.bodyRef!.key='other-store-key';
  assert.equal(dependencyStamp(f.state,d.material),original);delete f.memory.text;
  assert.equal(dependencyStamp(f.state,d.material),original);assert.equal(readingDraftUsable(f.state,d),true);
  f.memory.text='设备乙共有三件。';assert.throws(()=>memoryContentIdentity(f.memory),/尚未准备/);
  await prepareMemoryIdentities([f.memory]);assert.equal(readingDraftUsable(f.state,d),false);
  f.memory.text='设备甲共有三件。';await prepareMemoryIdentities([f.memory]);assert.equal(readingDraftUsable(f.state,d),true);
  f.memory.parents=['changed-parent'];assert.equal(readingDraftUsable(f.state,d),false);f.memory.parents=[];
  f.memory.basis={memoryIds:[],chatIds:['changed-chat']};assert.equal(readingDraftUsable(f.state,d),false);delete f.memory.basis;
  f.memory.forgotten=true;assert.equal(readingDraftUsable(f.state,d),false);
});

test('旧草稿有限读回真实正文，原印记不重写，嵌套属性顺序不造成丢稿',async()=>{
  const f=await fixture(),d=f.draft(),savedStamp=d.dependencyStamp,b=await f.body(f.memory);f.state.readingDrafts=[d];delete f.memory.text;
  f.memory.evidence=f.memory.evidence.map(({bookId,version,start,end})=>({end,start,version,bookId}));
  f.memory.documentTitle='旧档新导航';
  const reads:string[][]=[];const store:Store={async load(){return f.state;},async save(){},async readMemoryBodies(refs){reads.push(refs.map(r=>r.key));return [b];}};
  await prepareMemoryRecovery(f.state,store);
  assert.deepEqual(reads,[[b.key]]);assert.equal(readingDraftUsable(f.state,d),true);assert.equal(d.dependencyStamp,savedStamp);
  assert.equal(stampsEqual('{"a":{"b":1,"c":2}}','{"a":{"c":2,"b":1}}'),true);
});

test('旧更正恢复array印记剥新增引用和导航，保留原回执字节',async()=>{
  const f=await fixture();f.memory.kind='opinion';
  const oldDraft=structuredClone(f.memory),correction:Memory={...structuredClone(f.memory),id:'actual-correction',text:'设备甲数量需更正。',source:'correction',correctionOf:f.memory.id};
  f.memory.invalidatedBy=correction.id;f.state.memories.push(correction);
  const p={id:'actual-repair',bookId:f.book.id,version:f.book.version,partnerId:f.state.partnerId,source:'reading' as const,workspaceRevision:0,ranges:[...f.book.known],oldMemoryId:f.memory.id,oldDraft,memoryIds:[f.memory.id],chatIds:[],habitIds:[],correctionIds:[correction.id],dependencyStamp:'',status:'pending' as const,createdAt:1};
  f.state.companionCorrectionRepairs=[p];p.dependencyStamp=correctionRepairStamp(f.state,p.id);assert.ok(Array.isArray(JSON.parse(p.dependencyStamp)));const saved=p.dependencyStamp;
  const bodies=[await f.body(f.memory),await f.body(correction)];delete f.memory.text;delete correction.text;
  f.memory.documentTitle='新目录';f.state.memories[0]=Object.fromEntries(Object.entries(f.memory).reverse()) as Memory;
  await prepareMemoryRecovery(f.state,{async load(){return f.state;},async save(){},async readMemoryBodies(){return bodies;}});
  assert.equal(correctionRepairUsable(f.state,p),true);assert.equal(correctionRepairStamp(f.state,p.id),saved);assert.equal(p.dependencyStamp,saved);
});

test('新更正恢复依赖按hash校验，冷恢复复用inline旧稿不加载历史正文',async()=>{
  const f=await fixture();f.memory.kind='opinion';const oldDraft=structuredClone(f.memory);
  const correction:Memory={...structuredClone(f.memory),id:'hashed-correction',text:'按哈希验证新更正。',source:'correction',correctionOf:f.memory.id};
  f.memory.invalidatedBy=correction.id;f.state.memories.push(correction);await prepareMemoryIdentities([...f.state.memories,oldDraft]);
  const p={id:'hashed-repair',bookId:f.book.id,version:f.book.version,partnerId:f.state.partnerId,source:'reading' as const,workspaceRevision:0,ranges:[...f.book.known],oldMemoryId:f.memory.id,oldDraft,memoryIds:[f.memory.id],chatIds:[],habitIds:[],correctionIds:[correction.id],dependencyStamp:'',status:'pending' as const,createdAt:1};
  f.state.companionCorrectionRepairs=[p];p.dependencyStamp=correctionRepairStamp(f.state,p.id);assert.equal(JSON.parse(p.dependencyStamp).sourceStampVersion,2);
  const bodies=[await f.body(f.memory),await f.body(correction)];delete f.memory.text;delete correction.text;const requested:string[]=[];
  await prepareMemoryRecovery(f.state,{async load(){return f.state;},async save(){},async readMemoryBodies(refs){requested.push(...refs.map(r=>r.key));return bodies;}});
  assert.deepEqual(requested,[]);assert.equal(f.memory.text,undefined);assert.equal(correction.text,undefined);assert.equal(correctionRepairUsable(f.state,p),true);
});

test('两篇当前工作理解依赖同一来源时分别保留完整更正恢复任务',async()=>{
  const f=await fixture();
  const a:Memory={...structuredClone(f.memory),id:'work-document-a',kind:'opinion',text:'第一篇当前完整理解。',parents:[f.memory.id]},b:Memory={...structuredClone(f.memory),id:'work-document-b',kind:'opinion',text:'第二篇当前完整理解。',parents:[f.memory.id]};
  f.state.memories.push(a,b);await f.body(a);await f.body(b);await prepareMemoryIdentities(f.state.memories);await prepareMemoryTextIdentity('设备甲共有四件。');
  f.state.companionWorkspaces=[{bookId:f.book.id,version:f.book.version,partnerId:f.state.partnerId,source:'reading',revision:0,workingIds:[a.id,b.id],workingRevision:0,focusIds:[],updatedAt:1}];
  correctMemory(f.state,f.memory.id,'设备甲共有四件。');
  const repairs=f.state.companionCorrectionRepairs!;assert.equal(repairs.length,2);assert.deepEqual(new Set(repairs.map(p=>p.oldMemoryId)),new Set([a.id,b.id]));
  assert.ok(repairs.every(p=>p.workingDocument===true&&JSON.parse(p.dependencyStamp).sourceStampVersion===2&&correctionRepairUsable(f.state,p)));
  delete a.text;delete b.text;assert.ok(repairs.every(p=>correctionRepairUsable(f.state,p)));assert.deepEqual(repairs.map(p=>p.oldDraft!.text),['第一篇当前完整理解。','第二篇当前完整理解。']);
});

test('旧focus交接跨引用新增与对象属性顺序继续沿原问题恢复',async()=>{
  const f=await fixture(),focus=f.memory,b=await f.body(focus);
  const before={bookId:f.book.id,version:f.book.version,partnerId:f.state.partnerId,source:'reading' as const,revision:0,focusIds:[],updatedAt:1};
  const after={...before,revision:1,focusIds:[focus.id],updatedAt:2};f.state.companionWorkspaces=[after];
  const question={id:'focus-question',bookId:f.book.id,partnerId:f.state.partnerId,sessionId:'focus-session',role:'user' as const,text:'工程关注问题',evidence:focus.evidence,excluded:false,createdAt:1};f.state.chats=[question];
  const {bodyRef,...legacyFocus}=focus;
  const sourceStamp=JSON.stringify([[legacyFocus],question]);
  const p={id:'focus-repair',bookId:f.book.id,version:f.book.version,partnerId:f.state.partnerId,source:'reading' as const,workspaceRevision:0,ranges:[...f.book.known],oldMemoryId:focus.id,memoryIds:[],chatIds:[],habitIds:[],correctionIds:[],dependencyStamp:'',status:'pending' as const,createdAt:1,focusHandoffs:[{before,after,questionId:question.id,sourceStamp}]};
  focus.documentTitle='本次导航';focus.navigationCues=['设备'];f.state.memories[0]=Object.fromEntries(Object.entries(focus).reverse()) as Memory;delete f.state.memories[0].text;
  await hydrateMemoryBodies({async load(){return f.state;},async save(){},async readMemoryBodies(){return[b];}},f.state.memories);
  assert.equal(correctionFocusRevision(f.state,p,0),1);assert.equal(p.focusHandoffs[0].sourceStamp,sourceStamp);
});

test('冷启动只为旧待办读取依赖，新v2和其他历史正文保持未驻留',async()=>{
  const f=await fixture(),old=f.draft(),oldBody=await f.body(f.memory);
  const recent:Memory={...structuredClone(f.memory),id:'new-source',text:'当前工程来源。'},unrelated:Memory={...structuredClone(f.memory),id:'unrelated',text:'其他历史材料。'};
  f.state.memories.push(recent,unrelated);await prepareMemoryIdentities([recent]);const recentBody=await f.body(recent);await f.body(unrelated);
  const v2=createReadingDraft(f.state,f.book,{source:'preparation',ranges:[...f.book.known],input:'新工程输入'},{reply:'',thoughts:[],wantsLong:false},[],{...f.material,memoryIds:[recent.id],sourceStampVersion:2},'ready');
  f.state.readingDrafts=[old,v2];for(const m of f.state.memories)delete m.text;
  const requested:string[]=[];let saves=0;
  const restored=await restoreReadingEngine({async load(){return f.state;},async save(){saves++;},async readMemoryBodies(refs){requested.push(...refs.map(r=>r.key));return [oldBody,recentBody].filter(b=>refs.some(r=>r.key===b.key));}},{} as never);
  try{assert.deepEqual(requested,[oldBody.key]);assert.equal(f.state.readingDrafts.length,2);assert.equal(recent.text,undefined);assert.equal(unrelated.text,undefined);assert.equal(saves,0);}finally{restored.engine.stop();}
});

test('恢复正文缺失或损坏不清理任务、不删除原答、不保存失效状态',async()=>{
  const f=await fixture(),d=f.draft(),b=await f.body(f.memory);f.state.readingDrafts=[d];delete f.memory.text;
  const before=JSON.stringify(f.state);let saves=0;
  await assert.rejects(restoreReadingEngine({async load(){return f.state;},async save(){saves++;},async readMemoryBodies(){return [{...b,text:'坏正文'}];}},{} as never),/校验失败/);
  assert.equal(JSON.stringify(f.state),before);assert.equal(saves,0);
});

test('档案游标在正文加载后保持，全文与核对必须取得真实正文',async()=>{
  const f=await fixture(),body=await f.body(f.memory);delete f.memory.text;
  const index=projectWorkDossier(f.state,f.book,{view:'index'});
  assert.throws(()=>projectWorkDossier(f.state,f.book,{view:'full'}),/尚未载入/);
  assert.throws(()=>createFactReview(f.book,[f.memory]),/尚未载入/);
  await hydrateMemoryBodies({async load(){return f.state;},async save(){},async readMemoryBodies(){return [body];}},[f.memory]);
  const full=projectWorkDossier(f.state,f.book,{view:'full',snapshot:index.snapshot});assert.equal(full.snapshot,index.snapshot);assert.equal(full.items[0].text,body.text);
  assert.equal(createFactReview(f.book,[f.memory]).candidates[0].text,body.text);
});
