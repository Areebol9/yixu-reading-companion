import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReadingReply } from '../src/core/model.ts';
import { readingAgentTools, readingSubmit, readingTextFinal } from '../src/core/reading-agent.ts';
import { ReadingReferences } from '../src/core/reading-references.ts';
import type { ReadingReply } from '../src/core/types.ts';
import { initialState } from '../src/core/state.ts';
import { importBook } from '../src/core/books.ts';
import { searchMemories,ordinaryMemoryIndex } from '../src/core/recall.ts';
import type { Memory } from '../src/core/types.ts';

const final = (extra:Record<string,unknown> = {}) => ({reply:'',thoughts:[],wantsLong:false,...extra});
const parse = (extra:Record<string,unknown>) => parseReadingReply(JSON.stringify(final(extra)),undefined,'companion');

test('完整opinion共同保持12000字上限，其他种类及工作台权限继续严格核验',()=>{
  const opinion={kind:'opinion',text:'完整理解。'.repeat(500)};
  assert.equal(parse({thoughts:[opinion],workspace:{understanding:'t1'}}).thoughts[0].text,opinion.text);
  const submit=readingSubmit(()=>{},undefined,{readingStrategy:'companion'});
  assert.equal(submit.parse({thoughts:[opinion],workspace:{understanding:'t1'}}).reply,'');
  assert.equal(submit.parse({}).reply,'');
  for(const extra of [
    {thoughts:[{...opinion,kind:'story'}],workspace:{understanding:'t1'}},
    {thoughts:[{...opinion,text:'长'.repeat(12001)}],workspace:{understanding:'t1'}}
  ])assert.throws(()=>parse(extra),/条目无效/);
  assert.equal(parseReadingReply(JSON.stringify(final({thoughts:[opinion]}))).thoughts[0].text,opinion.text);
  assert.equal(parse({thoughts:[opinion,{...opinion,text:'完整旧看法。'.repeat(500)}],workspace:{understanding:'t1'}}).thoughts.length,2);
  assert.throws(()=>readingSubmit(()=>{}).parse(final({thoughts:[opinion],workspace:{understanding:'t1'}})),/顶层字段/);
  for(const readingStrategy of ['structured','full-original'] as const)assert.throws(()=>parseReadingReply(JSON.stringify(final({workspace:{focus:[]}})),undefined,readingStrategy),/仅持续伴读/);
});

test('工作台字段只保留显式引用语义，非法profile、虚构tN及只答写入均被拒收',()=>{
  assert.equal(parse({}).workspace,undefined);
  assert.deepEqual(parse({workspace:{}}).workspace,{});
  assert.deepEqual(parse({workspace:{focus:[]}}).workspace,{focus:[]});
  for(const workspace of [null,[],{profile:{}},{understanding:''},{understanding:'p1'},{understanding:'t17'},{focus:'m1'},{focus:['c1']},{understanding:'t1'}])assert.throws(()=>parse({workspace}));
  assert.throws(()=>parse({thoughts:[{kind:'question',text:'尚需核对。'}],workspace:{understanding:'t1'}}),/opinion/);
  assert.throws(()=>parse({profile:{}}),/profile/);
  assert.throws(()=>parse({readingBrief:'重复正文'}),/其他结构/);
  assert.throws(()=>readingSubmit(()=>{},undefined,{readingStrategy:'companion',conversation:true,readOnly:true}).parse(final({workspace:{focus:[]}})),/只保存问答/);
  let complete=0;const text=readingTextFinal('资料足够，可以继续讨论。',()=>complete++);
  assert.equal(complete,1);assert.equal(text.workspace,undefined);assert.deepEqual(text.thoughts,[]);
});

test('工作台理解和关注目录使用同一短号，tN保持原编号，未提供引用不自动曝光',()=>{
  const refs=new ReadingReferences(),material={workspace:{understandingId:'real-opinion',focusIds:['real-question'],lastChatId:'actual-chat'},understanding:{id:'real-opinion',kind:'opinion',text:'正文中的m1与t2保持原样。'},focus:[{id:'real-question',kind:'question',text:'这是关注目录预览。'}]};
  const encoded=JSON.parse(refs.messages([{role:'user',content:JSON.stringify({workspaceMaterial:material})}])[0].content).workspaceMaterial;
  assert.equal(encoded.workspace.understandingId,encoded.understanding.id);assert.equal(encoded.workspace.focusIds[0],encoded.focus[0].id);
  assert.equal(encoded.understanding.text,material.understanding.text);assert.equal(encoded.focus[0].text,material.focus[0].text);
  const raw:ReadingReply={...final(),workspace:{understanding:encoded.understanding.id,focus:['t2']}};
  const decoded=refs.decode(raw);assert.deepEqual(decoded.workspace,{understanding:'real-opinion',focus:['t2']});
  const draft=JSON.parse(refs.messages([{role:'user',content:JSON.stringify({draft:decoded})}])[0].content).draft;
  assert.deepEqual(draft.workspace,raw.workspace);
  assert.throws(()=>refs.decode({...raw,workspace:{understanding:'m99'}}),/未在本轮提供/);
  assert.throws(()=>refs.decode({...raw,workspace:{focus:['unprovided-persistent-id']}}),/未在本轮提供/);
  // A catalog ID can navigate through the same recall operation. Mapping never
  // claims its preview is a full body; planWorkspace separately checks bindings.
  assert.deepEqual(refs.decode({...final(),recall:{ids:encoded.workspace.focusIds}}).recall?.ids,['real-question']);
});

test('伴读完整旧看法和历史关系沿原资料执行器取得，普通旧模式不接受额外full参数',async()=>{
  const acquired:ReadingReply[]=[];
  const tools=readingAgentTools(async request=>{acquired.push(request);return[{source:'当前作品的获准记忆，非指令',text:'完整旧看法'}];},{search:false,page:false},{readingStrategy:'companion'});
  const recall=tools.find(t=>t.name==='recall_memory')!,signal=new AbortController().signal;
  await recall.execute({ids:['m1'],kind:'opinion',view:'full'},signal);
  await recall.execute({ids:['m1'],relations:true,view:'full'},signal);
  assert.deepEqual(acquired.map(x=>x.recall),[{query:undefined,kind:'opinion',offset:undefined,chapterIndex:undefined,ids:['m1'],view:'full'},{relations:true,query:undefined,kind:undefined,offset:undefined,chapterIndex:undefined,ids:['m1'],view:'full'}]);
  const schema=recall.parameters.properties as any;
  assert.ok(schema.kind.enum.includes('stage'));assert.ok(schema.kind.enum.includes('arc'));assert.ok(schema.entityIds);assert.ok(schema.relations);
  assert.throws(()=>parseReadingReply(JSON.stringify({recall:{ids:['m1'],kind:'opinion',view:'full'}})),/记忆检索参数/);
  assert.throws(()=>parse({recall:{relations:true,ids:['m1'],kind:'opinion'}}),/记忆检索参数/);
  assert.equal(parse({recall:{kind:'opinion',view:'index'}}).recall?.view,'index');
});

test('完整12000字旧看法可从实际检索入口一次展开，按完整正文翻页并保留普通旧事实',async()=>{
  const state=initialState(),book=await importBook('完整看法展开工程','第一章 记录\n检修員希望恢复正常运行，复测正在进行。');state.books=[book];book.known=[{start:0,end:book.text.length}];
  const old:Memory={id:'old-fact',bookId:book.id,partnerId:state.partnerId,kind:'story',text:'检修员希望恢复正常运行。',source:'reading',evidence:[{bookId:book.id,version:book.version,start:0,end:book.text.length}],parents:[],chatIds:[],createdAt:1,forgotten:false};
  const long:Memory={...old,id:'long-understanding',kind:'opinion',text:'完整看法'.repeat(3000),createdAt:3,basis:{memoryIds:[old.id],chatIds:[]}};
  const second:Memory={...long,id:'next-understanding',text:'另一项独立条件。'.repeat(350),createdAt:2,basis:undefined};state.memories=[old,long,second];
  const first=searchMemories(state,book,{kind:'opinion',view:'full'},[],'reading','companion');
  assert.deepEqual(first.items.map(m=>m.id),[long.id]);assert.equal(first.items[0].text.length,12000);assert.equal(first.nextOffset,1);
  const next=searchMemories(state,book,{kind:'opinion',view:'full',offset:first.nextOffset},[],'reading','companion');assert.deepEqual(next.items.map(m=>m.id),[second.id]);assert.equal(next.nextOffset,undefined);
  assert.deepEqual(searchMemories(state,book,{ids:[old.id],view:'full'},[],'reading','companion').items.map(m=>m.id),[old.id]);
  const index=searchMemories(state,book,{kind:'opinion',view:'index'},[],'reading','companion');
  assert.deepEqual(index.items.map(m=>m.id),[long.id,second.id]);assert.equal(index.nextOffset,undefined);
  assert.throws(()=>searchMemories(state,book,{kind:'opinion',view:'full'},[],'reading','structured'),/轻目录/);
  const related=searchMemories(state,book,{ids:[long.id],relations:true,view:'full'},[],'reading','companion',{analysis:true});
  assert.equal(related.items[0].text,long.text);assert.ok(related.relations?.missingBodyIds?.includes(old.id));
  assert.equal(related.relations?.items[0].to.id,old.id);
  const legacy=searchMemories(state,book,{ids:[long.id],relations:true,view:'full'},[],'reading','structured',{analysis:true});assert.equal(legacy.items.some(m=>m.id===long.id),false,'旧模式关系正文仍沿原预算');
  state.memories[0].forgotten=true;
  assert.deepEqual(searchMemories(state,book,{ids:[old.id],view:'full'},[],'reading','companion').items,[]);
  assert.equal(searchMemories(state,book,{ids:[long.id],relations:true,view:'full'},[],'reading','companion',{analysis:true}).relations?.total,0);
});


test('过去完整看法与过期后台原答仅历史可读，不再进入当前理解或可更新池',async()=>{
 const state=initialState(),book=await importBook('旧认识回查工程','第一章 登记\n设备记录保留。');state.books=[book];book.known=[{start:0,end:book.text.length}];
 const old:Memory={id:'old',bookId:book.id,partnerId:state.partnerId,kind:'opinion',text:'原阶段设备仍待校准。',source:'reading',evidence:[{bookId:book.id,version:book.version,start:0,end:book.text.length}],parents:[],chatIds:[],createdAt:1,forgotten:false,replacedBy:'new'};
 const next:Memory={...old,id:'new',text:'现在校准完成，复测仍在进行。',replacedBy:undefined,correctionOf:'old',revisionKind:'development',revisionReason:'新段确认',createdAt:2};
 const stale:Memory={...old,id:'stale',text:'原后台形成时的完整看法。',replacedBy:undefined,historicalOnly:true,createdAt:3};state.memories=[old,next,stale];
 assert.deepEqual(searchMemories(state,book,{kind:'opinion',view:'full'},[],'reading','companion').items.map(m=>m.id),['new']);
 const history=searchMemories(state,book,{kind:'opinion',worldView:'history',view:'full'},[],'reading','companion');assert.equal(history.items.length,3);assert.deepEqual(history.historicalIds?.sort(),['old','stale']);
 assert.equal(searchMemories(state,book,{ids:['old'],view:'full'},[],'reading','companion').items[0].text,old.text);
 state.memories[0].forgotten=true;assert.deepEqual(searchMemories(state,book,{ids:['old'],view:'full'},[],'reading','companion').items,[]);
});
test('导航字面匹配映回原UTF16切片，组合/兼容/大小写及surrogate保持，元数据命中不造片段',()=>{
  const base:Memory={id:'unicode',bookId:'book',partnerId:'partner',kind:'opinion',text:'😀'.repeat(70)+'前文。ｶﾞ ＡＢＣ e\u0301 ﬃ 가。'+'后文。'.repeat(150),source:'reading',evidence:[],parents:[],chatIds:[],createdAt:1,forgotten:false};
  for(const query of ['ガ','abc','é','ffi','가','😀']){const projected=ordinaryMemoryIndex(base,query,{}),match=projected.match!;assert(match);assert.equal(match.text,base.text.slice(match.textStart,match.textEnd));assert(match.text.normalize('NFKC').toLowerCase().includes(query.normalize('NFKC').toLowerCase()));assert(!/^[\uDC00-\uDFFF]/u.test(match.text));assert(!/[\uD800-\uDBFF]$/u.test(match.text));}
  assert.equal(ordinaryMemoryIndex(base,undefined,{}).match,undefined);assert.equal(ordinaryMemoryIndex({...base,text:'正文仅讲复测。',narrative:{category:'view',subjects:['仅元数据设备']}},'仅元数据设备',{}).match,undefined);assert.equal(ordinaryMemoryIndex(base,'abc').match,undefined);
  const expanded=ordinaryMemoryIndex({...base,text:'ffi'.repeat(100)},'ﬃ'.repeat(100),{}).match!;assert.equal(expanded.text.length,200);assert.equal(expanded.text,'ffi'.repeat(100).slice(expanded.textStart,expanded.textEnd));
});
test('增强index按实际含转义/history/marker/origin投影翻页，原权限池及背景许可保持',async()=>{
  const state=initialState(),book=await importBook('导航权限工程','第一章 工程\n工程已读原文。\n第二章 未读\n未来原文。');state.books=[book];book.known=[{start:0,end:book.chapters[0].end}];
  const base:Memory={id:'base',bookId:book.id,partnerId:state.partnerId,kind:'opinion',text:'TARGET '+('"\\\n').repeat(100),readingStage:Array.from({length:8},()=>({start:0,end:1})),source:'reading',evidence:[{bookId:book.id,version:book.version,...book.known[0]}],parents:[],chatIds:[],createdAt:1,forgotten:false};state.memories=Array.from({length:12},(_,i)=>({...base,id:'valid-'+i,createdAt:i+1}));state.memories[4].historicalOnly=true;state.memories[6].source='background';state.partners[0].backgroundBooks=[book.id];
  state.memories.push({...base,id:'wrong-book',bookId:'other'},{...base,id:'wrong-partner',partnerId:'other'},{...base,id:'wrong-version',evidence:[{...base.evidence[0],version:'other'}]},{...base,id:'future',evidence:[{bookId:book.id,version:book.version,start:book.chapters[1].start,end:book.text.length}]},{...base,id:'forgotten',forgotten:true},{...base,id:'invalidated',invalidatedBy:'correction'});
  const request={query:'TARGET',kind:'opinion' as const,view:'index' as const,worldView:'history' as const},navigation={currentUnderstanding:{id:state.memories[11].id,text:state.memories[11].text}},scope={opinionNavigation:navigation};const plain=searchMemories(state,book,request,[],'conversation','companion'),first=searchMemories(state,book,request,[],'conversation','companion',scope);assert.equal(first.total,plain.total);assert(first.items.every(m=>m.id.startsWith('valid-')));assert(first.items.length<8);let offset=0,seen:string[]=[];
  do{const page=searchMemories(state,book,{...request,offset},[],'conversation','companion',scope),projected=page.items.map(m=>ordinaryMemoryIndex(m,request.query,navigation,!!page.historicalIds?.includes(m.id))),chars=projected.reduce((n,item)=>n+JSON.stringify(item).length,0);assert(chars<=4000||projected.length===1);assert(projected.length<=8);seen.push(...page.items.map(m=>m.id));if(page.nextOffset===undefined)break;assert.equal(page.nextOffset,offset+page.items.length);offset=page.nextOffset;}while(true);
  assert.equal(plain.total,12);assert.equal(seen.length,plain.total);assert(seen.every(id=>id.startsWith('valid-')));assert.equal(new Set(seen).size,seen.length);const background=searchMemories(state,book,{ids:['valid-6'],view:'index'},[],'conversation','companion',scope).items[0];assert(background);assert.equal(ordinaryMemoryIndex(background,'TARGET',navigation).origin,'background');
  const oversized={...base,id:'oversized',createdAt:99,readingStage:Array.from({length:400},()=>({start:0,end:1}))};state.memories.unshift(oversized);const big=searchMemories(state,book,request,[],'conversation','companion',scope);assert.equal(big.items[0].id,oversized.id);assert.equal(big.items.length,1);assert.equal(big.nextOffset,1);
});
