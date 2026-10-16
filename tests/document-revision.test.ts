import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState} from '../src/core/state.ts';
import {importBook} from '../src/core/books.ts';
import {evidence} from '../src/core/context.ts';
import {ReadingSources} from '../src/core/reading-sources.ts';
import {ReadingReferences} from '../src/core/reading-references.ts';
import {readingDocumentsPayload,readingDocumentsTool,validateReadingDocumentsPayloadShape} from '../src/core/reading-output.ts';
import {applyDocumentRevision,materializeDocumentRevisions} from '../src/core/document-revision.ts';
import {planMemories} from '../src/core/memory-plan.ts';
import {parseReadingReply} from '../src/core/model.ts';
import {restoreBackup} from '../src/core/backup.ts';
import type {Memory,ReadingReply} from '../src/core/types.ts';

async function fixture(){
  const state=initialState(),book=await importBook('局部文档接续资料','第一章 起点\n人物甲希望旅行，也担忧危险。旧问题等待解释。\n第二章 后续\n祈求可离线保存。人物甲仍有旅行愿望。');
  const early={start:0,end:book.chapters[1].start},later={start:early.end,end:book.text.length};
  book.known=[{start:0,end:book.text.length}];book.prepared=[...book.known];book.position=book.text.length;state.books=[book];
  const old:Memory={id:'old',bookId:book.id,partnerId:state.partnerId,kind:'opinion',text:'  愿望：人物甲想旅行，也拒绝危险。🌱\r\n\r\n条件：祈求是否可保存仍未知。\n\n问题：旧疑问仍待解释。  ',documentTitle:'人物甲与祈求',navigationCues:['旅行愿望'],evidence:[evidence(book,early)],sourceEvidence:[evidence(book,early)],parents:[],chatIds:[],createdAt:1,forgotten:false,source:'reading'};
  state.memories=[old];const sources=new ReadingSources();sources.render(book,later);const p=[...sources.passages.keys()][0];
  const doc={operation:'revise',updates:'old',updateReason:'后文说明保存条件，旅行愿望与未解问题继续保留。',edits:[{oldText:'条件：祈求是否可保存仍未知。',newText:'条件：祈求可离线保存。',sourceIds:[p]}],appendText:'\n进展：人物甲仍有旅行愿望。',sourceIds:[p],basis:{memoryIds:[],chatIds:[]}};
  const payload=(document:any=doc)=>({documents:[document],working:['t1']});
  const reply=()=>readingDocumentsPayload(payload(),{resolveProvidedDocument:id=>id===old.id?old:undefined});
  const plan=(result:ReadingReply=reply(),parents=['old'],originals=[later],passages=sources.passages)=>planMemories(state,book,result,[evidence(book,book.known[0])],parents,[],'reading',undefined,[],originals,passages,[later],{readingStrategy:'companion'});
  return{state,book,old,early,later,sources,p,doc,payload,reply,plan};
}

test('局部替换沿同一旧全文定位，愿望、未知与未触文字逐字保留，追加完全显式',async()=>{
  const f=await fixture(),before=structuredClone(f.old),result=f.reply(),memory=f.plan(result).added[0];
  assert.equal(memory.text,f.old.text!.replace(f.doc.edits[0].oldText,f.doc.edits[0].newText)+f.doc.appendText);
  assert.ok(memory.text!.startsWith('  愿望：人物甲想旅行，也拒绝危险。🌱\r\n\r\n'));
  assert.ok(memory.text!.includes('问题：旧疑问仍待解释。  '));assert.deepEqual(f.old,before);
  assert.equal(memory.documentRevision?.previousId,'old');assert.equal(memory.documentRevision?.changes.length,2);
  for(const change of memory.documentRevision!.changes){assert.deepEqual(change.sourceEvidence,[evidence(f.book,f.later)]);}
  assert.equal(memory.correctionOf,'old');assert.equal(memory.revisionKind,'development');
  assert.deepEqual(memory.basis,{memoryIds:['old'],chatIds:[]});assert.deepEqual(memory.sourceEvidence,[evidence(f.book,f.book.known[0])]);
  assert.equal(memory.documentTitle,f.old.documentTitle);assert.deepEqual(memory.navigationCues,f.old.navigationCues);
});

test('重复、重叠和串行命中新文字均拒绝；未取得全文或过期目标保持旧文',async()=>{
  const f=await fixture();
  assert.throws(()=>applyDocumentRevision({...f.old,text:'重复。重复。'},{edits:[{oldText:'重复。',newText:'另一项。'}]}),/唯一逐字/);
  assert.throws(()=>applyDocumentRevision(f.old,{edits:[{oldText:'祈求是否可保存仍未知',newText:'祈求可保存'},{oldText:'保存仍未知',newText:'保存已知'}]}),/重叠/);
  assert.throws(()=>applyDocumentRevision(f.old,{edits:[{oldText:'祈求是否可保存仍未知',newText:'新出现的短句'},{oldText:'新出现的短句',newText:'再次更换'}]}),/唯一逐字/);
  assert.throws(()=>f.plan(f.reply(),[]),/实际取得全文/);
  assert.throws(()=>readingDocumentsPayload(f.payload()),/完整文档上下文/);
  assert.throws(()=>readingDocumentsPayload(f.payload(),{resolveProvidedDocument:()=>({...f.old,text:undefined})}),/尚未载入/);
  for(const changed of [{replacedBy:'later'},{invalidatedBy:'correction'},{forgotten:true},{historicalOnly:true as const}]){
    assert.throws(()=>materializeDocumentRevisions(f.reply(),()=>({...f.old,...changed})),/有效opinion/);
  }
  assert.equal(f.old.text!.includes('保存仍未知'),true);
});

test('工具形状校验与旧全文物化分开，三种操作均公开原文与basis且拒绝混合载体',async()=>{
  const f=await fixture();assert.doesNotThrow(()=>validateReadingDocumentsPayloadShape(f.payload()));
  assert.throws(()=>validateReadingDocumentsPayloadShape(f.payload({...f.doc,text:'混入的整篇正文'})),/只填/);
  assert.throws(()=>validateReadingDocumentsPayloadShape(f.payload({...f.doc,edits:[],appendText:undefined})),/实际替换/);
  for(const operation of ['create','develop']){
    const doc={operation,text:'新的完整认识。',sourceIds:[f.p],quoteSource:f.p,basis:{memoryIds:[],chatIds:[]},...(operation==='develop'?{updates:'old',updateReason:'完整接续。'}:{})};
    const parsed=readingDocumentsPayload(f.payload(doc));assert.deepEqual(parsed.thoughts[0].sourceIds,[f.p]);assert.equal(parsed.thoughts[0].quoteSource,f.p);
    assert.throws(()=>readingDocumentsPayload(f.payload({...doc,sourceIds:['p0']})),/sourceIds/);
    assert.throws(()=>readingDocumentsPayload(f.payload({...doc,basis:{memoryIds:'old',chatIds:[]}})),/basis/);
    assert.throws(()=>f.plan(readingDocumentsPayload(f.payload({...doc,quoteSource:'p99999'}))),/p99999/);
  }
  const schema:any=readingDocumentsTool.parameters;assert.deepEqual(schema.properties.documents.items.properties.operation.enum,['create','develop','revise']);
});

test('原文p须是本轮给入的同版获准原句，不能以旧坐标或篡改片段支撑修订',async()=>{
  const f=await fixture();
  const bad=structuredClone(f.doc);bad.edits[0].sourceIds=['p99999'];assert.throws(()=>f.plan(readingDocumentsPayload(f.payload(bad),{resolveProvidedDocument:()=>f.old})),/p99999/);
  assert.throws(()=>f.plan(f.reply(),['old'],[f.early]),/实际提供/);
  const passages=new Map(f.sources.passages);passages.set(f.p,{...passages.get(f.p)!,text:'篡改原文'});
  assert.throws(()=>f.plan(f.reply(),['old'],[f.later],passages),/实际提供/);
  const foreign=new Map(f.sources.passages);foreign.set(f.p,{...foreign.get(f.p)!,evidence:{...foreign.get(f.p)!.evidence,version:'另一版'}});
  assert.throws(()=>f.plan(f.reply(),['old'],[f.later],foreign),/实际提供/);
  const legacy=parseReadingReply(JSON.stringify({reply:'',thoughts:[{kind:'opinion',text:'旧接口保守概括。',sourceIds:['p99999']}]}));
  assert.equal(f.plan(legacy).added[0].sourceEvidence,undefined);
});

test('备份保留段落改动与精确来源；伪造区间、越权出处或丢前身依赖拒绝恢复',async()=>{
  const f=await fixture(),memory=f.plan().added[0];f.old.replacedBy=memory.id;f.state.memories.push(memory);
  const restored=await restoreBackup(JSON.stringify(f.state),initialState());assert.deepEqual(restored.memories.find(m=>m.id===memory.id)?.documentRevision,memory.documentRevision);
  const mutate=[(m:Memory)=>m.documentRevision!.changes[0].after.start++, (m:Memory)=>m.documentRevision!.changes[0].sourceEvidence[0].end=f.book.text.length+1, (m:Memory)=>m.documentRevision!.previousId=memory.id, (m:Memory)=>m.basis!.memoryIds=[]];
  for(const change of mutate){const state=structuredClone(f.state);change(state.memories[1]);await assert.rejects(restoreBackup(JSON.stringify(state),initialState()),/局部修订/);}
});

test('真实后继与相关晚期候选分别编码，局部修订basis引用未知目录会明确拒绝',async()=>{
  const f=await fixture(),refs=new ReadingReferences(),message={role:'user' as const,content:JSON.stringify({memoryDiscovery:{items:[{id:'old',directSuccessorId:'next',developmentChainIds:['next','last'],laterDevelopmentIds:['related'],bodyChars:100}]}})};
  const shown=JSON.parse(refs.messages([message])[0].content).memoryDiscovery.items[0];
  assert.equal(shown.id,'m1');assert.equal(shown.directSuccessorId,refs.memoryLabel('next'));assert.deepEqual(shown.developmentChainIds,['next','last'].map(id=>refs.memoryLabel(id)));
  assert.notEqual(shown.directSuccessorId,shown.laterDevelopmentIds[0]);
  const reply=f.reply();reply.thoughts[0].basis={memoryIds:['m999'],chatIds:[]};reply.thoughts[0].updates='m1';
  assert.throws(()=>refs.decode(reply),/basis编号未在本轮提供/);
});
