import {test} from 'node:test';
import assert from 'node:assert/strict';
import {importBook} from '../src/core/books.ts';
import {evidence,forgetMemory,usableMemories} from '../src/core/context.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import {parseReadingReply} from '../src/core/model.ts';
import {questionIndex,recallTerms,searchMemories,selectMemories} from '../src/core/recall.ts';
import {initialState} from '../src/core/state.ts';
import type {Memory,ModelPort,Store} from '../src/core/types.ts';

async function fixture(){
 const state=initialState(),book=await importBook('记忆检索工程资料','第一章 记录\nAX设备登记。\n'+('本段仅为工程资料占位，已记录。\n'.repeat(1800))+'当前页面记录已经结束。\n第二章 后文\nFUTURE-RECALL-SENTINEL');
 book.position=book.chapters[1].start;book.known=[{start:0,end:book.position}];book.prepared=[...book.known];state.books=[book];state.settings.services[0].enabled=true;
 const old:Memory={id:'old-view',bookId:book.id,partnerId:state.partnerId,kind:'opinion',text:'AX方案维护成本偏高，拆分模块更合适。',evidence:[evidence(book,{start:0,end:18})],parents:[],chatIds:[],createdAt:1,forgotten:false,source:'reading'};
 state.memories.push(old);
 for(let i=0;i<45;i++)state.memories.push({...old,id:'recent-'+i,kind:'story',text:'当前页面的工程记录编号'+i,evidence:[evidence(book,{start:book.position-40,end:book.position})],createdAt:100+i});
 return {state,book,old};
}
const store:Store={async load(){return undefined;},async save(){}};

test('检索词保留句段和字段边界，兼容中文扩展字与独立拉丁词',()=>{
 const terms=recallTerms('线索。韩立\n设备 AX BY 𠮷田');
 assert.ok(terms.has('线索'));assert.ok(terms.has('韩立'));assert.ok(terms.has('ax'));assert.ok(terms.has('by'));assert.ok(terms.has('𠮷田'));
 for(const absent of ['索韩','立设','axby'])assert.equal(terms.has(absent),false);
});

test('未载入正文只参与明确元数据目录检索，不能冒充全文或预选内容，旧问题不凭两个缺失正文认定同文恢复',async()=>{
 const {state,book,old}=await fixture();state.memories=[{...old,text:undefined,documentTitle:'AX设备历史完整看法',bodyRef:{key:'memory-body-'+'a'.repeat(64),hash:'a'.repeat(64),chars:old.text!.length}}];
 const index=searchMemories(state,book,{query:'AX',view:'index'},[],'reading','companion',{opinionNavigation:{currentUnderstanding:{id:old.id,text:undefined}}});
 assert.equal(index.items[0].text,undefined);assert.equal(index.searchScope,'metadata-and-loaded-bodies');assert.deepEqual(index.unloadedBodyIds,[old.id]);
 assert.throws(()=>searchMemories(state,book,{ids:[old.id],view:'full'},[],'reading','companion'),/正文尚未载入/);
 assert.deepEqual(selectMemories(state,book,{start:0,end:18},'AX'),[]);
 assert.deepEqual(questionIndex(state,book,[{start:0,end:18}],[],[]).records,[]);
 state.memories[0].forgotten=true;assert.equal(searchMemories(state,book,{query:'AX',view:'index'},[],'reading','companion').total,0);
});

test('旧问题能沿可见部分答案中的新名称取回，类型筛选不切断关系，也不借后文排序',async()=>{
 const {state,book,old}=await fixture();
 const question:Memory={...old,id:'case',kind:'question',text:'仓库损坏的装置是什么，用途和剩余隐患各是什么？'};
 const partial:Memory={...old,id:'case-detail',kind:'story',text:'铭牌确认为QX7温控器；用途明确，隐患仍待检查。',answersPartOf:question.id};state.memories=[question,partial];
 assert.deepEqual(searchMemories(state,book,{query:'QX7',kind:'question'}).items.map(m=>m.id),[question.id]);
 assert.deepEqual(searchMemories(state,book,{query:'QX7',ids:[question.id]}).items.map(m=>m.id),[question.id]);
 const start=book.position-40;book.text=book.text.slice(0,start)+'QX7控制器复检。'+book.text.slice(start+9);
 assert.deepEqual(questionIndex(state,book,[{start,end:book.position}],[],[],1000).records.map(m=>m.id),[question.id,partial.id]);
 partial.evidence=[evidence(book,{start:book.position,end:book.text.length})];
 assert.equal(searchMemories(state,book,{query:'QX7',kind:'question'}).total,0);
 assert.deepEqual(questionIndex(state,book,[{start,end:book.position}],[],[],1000).records,[]);
 partial.evidence=old.evidence;forgetMemory(state,partial.id);assert.equal(searchMemories(state,book,{query:'QX7',kind:'question'}).total,0);
});

test('问题目录已提供的内容不再次占普通资料额度，完整条件仍在各自目录中',async()=>{
 const {state,book,old}=await fixture();state.memories=[old,{...old,id:'question',kind:'question',text:'AX允许拆卸的条件是什么？'}];
 const current={start:0,end:18},directory=questionIndex(state,book,[current],[],[],700);
 const notes=selectMemories(state,book,current,'',[],700-directory.chars,{excludeIds:directory.records.map(m=>m.id)});
 assert.deepEqual(directory.records.map(m=>m.id),['question']);assert.deepEqual(notes.map(m=>m.id),[old.id]);
});

test('增量片段开头和分散的新段落都用于召回，问题目录保留完整条件及已有部分答案',async()=>{
 const {state,book,old}=await fixture();const end=book.position;
 book.text=book.text.slice(0,end-1900)+'AX设备模块可拆卸。'+book.text.slice(end-1889);
 const selected=selectMemories(state,book,{start:end-1900,end},'',[],1800,{maxItems:6});assert.ok(selected.some(m=>m.id===old.id));
 const separate=selectMemories(state,book,{start:end-200,end},'',[],1800,{maxItems:6,materialRanges:[{start:end-1900,end:end-1800},{start:end-200,end}]});assert.ok(separate.some(m=>m.id===old.id));
 const question={...old,id:'open',kind:'question' as const,text:'AX设备允许拆卸的条件是什么，是否允许带电操作？'};
 const answer={...old,id:'partial',kind:'story' as const,text:'AX允许断电拆卸，带电条件尚未明确。',answersPartOf:question.id};
 state.memories.push(question,answer,{...question,id:'future-index',text:'AX未来许可',evidence:[evidence(book,{start:book.position,end:book.text.length})]});
 const index=questionIndex(state,book,[{start:end-1900,end}],[],[],700);
 assert.deepEqual(index.records.map(m=>m.id),['open','partial']);assert.equal(index.items[0].text,question.text);assert.equal(index.items[1].answersPartOf,question.id);assert.ok(index.chars<=700);
 assert.deepEqual(questionIndex(state,book,[{start:end-1900,end}],[],[],20).items,[]);
 assert.deepEqual(searchMemories(state,book,{ids:['open','future-index']}).items.map(m=>m.id),['open']);
  state.memories.push({...question,id:'independent',source:'background'});
  assert.equal(questionIndex(state,book,[{start:end-1900,end}],[],[],700).records.some(m=>m.id==='independent'),false);
  assert.deepEqual(questionIndex(state,book,[{start:end-1900,end}],[],[],700,'background').records.map(m=>m.id),['independent']);
});

test('当前材料重新提到的旧主体不被近期主角记录挤出，接续问题同时参考真实交流主题',async()=>{
 const state=initialState(),book=await importBook('主体接续工程资料','第一章 移交\nBX设备已移交外部，交接责任仍待核实。\n第二章 现场\nAX设备继续处理记录，临时用到BX设备过去留下的方案。\n第三章 未读\nBX返回。');
 state.books=[book];book.known=[{start:0,end:book.chapters[1].end}];book.prepared=[...book.known];book.position=book.chapters[1].end;
 const prior:Memory={id:'prior-subject',bookId:book.id,partnerId:state.partnerId,kind:'story',text:'BX设备已移交外部，交接责任仍待核实。',evidence:[evidence(book,book.chapters[0])],parents:[],chatIds:[],createdAt:1,forgotten:false,source:'reading',readingStage:[book.chapters[0]],narrative:{category:'event',subjects:['BX设备']}};
 state.memories=[prior,...Array.from({length:20},(_,i)=>({...prior,id:'recent-'+i,text:'AX设备继续处理现场记录，进度编号'+i,readingStage:[book.chapters[1]],createdAt:100+i,narrative:{category:'event' as const,subjects:['AX设备']}}))];
 const options={maxItems:6},selected=selectMemories(state,book,book.chapters[1],'',[],900,options);
 assert.ok(selected.some(m=>m.id===prior.id));assert.ok(selected.length<=6);assert.ok(selected.reduce((n,m)=>n+m.text.length+JSON.stringify(m.narrative).length,0)<=900);
 state.memories.push({...prior,id:'future',text:'FUTURE-HIDDEN',readingStage:[book.chapters[2]],evidence:[evidence(book,book.chapters[2])],createdAt:999},{...prior,id:'other',bookId:'elsewhere',createdAt:999});
 assert.deepEqual(selectMemories(state,book,book.chapters[1],'',[],900,options),selected);
 const silentRange={start:book.chapters[1].start,end:book.chapters[1].start+9};
 const resumed=selectMemories(state,book,silentRange,'继续刚才的讨论。',[],900,{focusQuestion:true,discussion:'刚才谈到BX设备的交接责任仍待核实。',maxItems:6});
 assert.ok(resumed.some(m=>m.id===prior.id));
});

test('记忆检索先筛权限与有效性，未读背景、其他书和伙伴、被更正或遗忘的记录不影响结果数量',async()=>{
 const {state,book,old}=await fixture();
 const blocked:Memory[]=[
  {...old,id:'future',text:'FUTURE-RECALL-SENTINEL',source:'background',evidence:[evidence(book,{start:book.position,end:book.text.length})]},
  {...old,id:'other-book',bookId:'elsewhere'}, {...old,id:'other-partner',partnerId:'elsewhere'},
  {...old,id:'forgotten',forgotten:true}, {...old,id:'replaced',replacedBy:'new'}, {...old,id:'invalidated',invalidatedBy:'new'}
 ];
 const baseline=searchMemories(state,book,{kind:'opinion'});state.memories.push(...blocked);
 assert.deepEqual(searchMemories(state,book,{kind:'opinion'}),baseline);
 assert.deepEqual(searchMemories(state,book,{query:'FUTURE-RECALL-SENTINEL'}).items,[]);
 const permitted=searchMemories(state,book,{query:'FUTURE-RECALL-SENTINEL'},[{start:book.position,end:book.text.length}]);
 assert.deepEqual(permitted.items.map(m=>m.id),['future']);
 state.forgotten.push({id:'tombstone',bookId:book.id,text:old.text,time:10});
 assert.equal(searchMemories(state,book,{kind:'opinion'}).total,0);
});

test('记忆按关键词或类别查询，翻页不丢项且正文预算有限，空结果可改词重查',async()=>{
 const {state,book,old}=await fixture();
 assert.deepEqual(searchMemories(state,book,{query:'AX',kind:'opinion'}).items,[old]);
 assert.equal(searchMemories(state,book,{query:'未出现词语'}).total,0);
 state.memories=Array.from({length:9},(_,i)=>({...old,id:String(i),text:'维护记录'+String(i)+'。'.repeat(1700),createdAt:i}));
 const ids:string[]=[];let offset=0;
 for(let i=0;i<10;i++){
  const page=searchMemories(state,book,{kind:'opinion',offset});
  assert.equal(page.total,9);assert.ok(page.items.reduce((n,m)=>n+m.text.length,0)<=4000);
  ids.push(...page.items.map(m=>m.id));if(page.nextOffset===undefined)break;assert.ok(page.nextOffset>offset);offset=page.nextOffset;
 }
 assert.equal(ids.length,9);assert.equal(new Set(ids).size,9);
});

test('记忆工具参数不接受换书、任意类别或非法游标，空对象可浏览当前作品',()=>{
 assert.ok(parseReadingReply('{"recall":{}}').recall);
 assert.equal(parseReadingReply('{"recall":{"query":"AX","kind":"opinion","offset":8}}').recall?.offset,8);
 for(const recall of [null,'AX',{bookId:'another'},{query:1},{query:'a'.repeat(161)},{kind:'all'},{kind:['opinion']},{offset:-1},{offset:1.2}])assert.throws(()=>parseReadingReply(JSON.stringify({recall})),/记忆检索/);
});

test('自动预选遗漏的旧看法可通过工具取回，进入回答和新记忆的实际关联，忘记后同步退出',async()=>{
 const {state,book,old}=await fixture();let calls=0;
 assert.equal(selectMemories(state,book,{start:book.position-2000,end:book.position},'早先的判断是什么？').some(m=>m.id===old.id),false);
 const model:ModelPort={async complete(service,messages){
  calls++;const sent=JSON.stringify(messages);assert.equal(sent.includes('FUTURE-RECALL-SENTINEL'),false);
  if(calls===1){assert.equal(sent.includes(old.text),false);return {content:'{"recall":{"kind":"opinion"}}',input:10,output:10,estimated:false,elapsedMs:1};}
  assert.ok(sent.includes(old.text));
  return {content:JSON.stringify({reply:'已经找到先前的工程判断。',replyBasis:{memoryIds:[old.id],chatIds:[]},thoughts:[{kind:'opinion',text:'本次沿维护成本继续核查。',basis:{memoryIds:[old.id],chatIds:[]}}]}),input:10,output:10,estimated:false,elapsedMs:1};
 }};
 const engine=new ReadingEngine(state,store,model,{original:'adaptive',memories:'selected'});await engine.start(book.id);await engine.ask(book.id,'早先的判断是什么？');
 assert.equal(calls,2);const reply=state.chats.at(-1)!,created=state.memories.at(-1)!;
 assert.ok(reply.memoryIds?.includes(old.id));assert.ok(reply.basis?.memoryIds.includes(old.id));assert.ok(created.parents.includes(old.id));
 assert.ok(reply.evidence.some(e=>e.start===0&&e.end===18));
 forgetMemory(state,old.id);assert.equal(reply.excluded,true);assert.equal(usableMemories(state,book).some(m=>m.id===created.id),false);engine.stop();
});

test('重复记忆检索沿用资料回查上限，不能把未结束的工具请求当成回答',async()=>{
 const {state,book}=await fixture();let calls=0;
 const model:ModelPort={async complete(){calls++;return {content:'{"recall":{"kind":"opinion"}}',input:10,output:10,estimated:false,elapsedMs:1};}};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id);
 await assert.rejects(engine.ask(book.id,'早先的判断是什么？'),/回查尚未完成/);
 assert.equal(calls,4);assert.equal(state.chats.length,1);assert.equal(state.chats[0].delivery,'failed');engine.stop();
});

test('一次后文许可中的检索结果只在当轮使用，普通交流不会带入临时记忆或回答',async()=>{
 const {state,book,old}=await fixture();
 state.memories.push({...old,id:'future',text:'FUTURE-RECALL-SENTINEL',source:'background',evidence:[evidence(book,{start:book.position,end:book.text.length})]});
 const count=state.memories.length;let calls=0;
 const model:ModelPort={async complete(service,messages){
  calls++;if(calls>=4)assert.equal(JSON.stringify(messages).includes('FUTURE-RECALL-SENTINEL'),false);
  const result=calls===1||calls===4?{recall:{kind:'opinion'}}:{reply:calls<4?'FUTURE-RECALL-SENTINEL':'仅当前范围的回应',thoughts:[{kind:'opinion',text:'当轮意见'}]};
  return {content:JSON.stringify(result),input:10,output:10,estimated:false,elapsedMs:1};
 }};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id);
 await engine.askWithFuture(book.id,'这一次允许回顾后续资料。',{start:book.position,end:book.text.length});
 assert.equal(calls,3);assert.equal(state.memories.length,count);assert.ok(state.chats.at(-1)?.futureGrant);
 await engine.ask(book.id,'回到通常的阅读范围。');assert.equal(calls,5);engine.stop();
});

test('一轮检索的翻页范围保持稳定，新阅读进度不会改变已开始的记忆列表',async()=>{
 const {state,book,old}=await fixture();let calls=0;
 state.memories.push({...old,id:'later',text:'FUTURE-RECALL-SENTINEL',source:'background',createdAt:1000,evidence:[evidence(book,{start:book.position,end:book.text.length})]});
 const model:ModelPort={async complete(service,messages){
  calls++;assert.equal(JSON.stringify(messages).includes('FUTURE-RECALL-SENTINEL'),false);
  if(calls===1)return {content:'{"recall":{"kind":"opinion"}}',input:10,output:10,estimated:false,elapsedMs:1};
  const result=JSON.parse(JSON.parse(messages.at(-1)!.content).toolResults[0].text);
  assert.equal(result.total,1);assert.equal(result.request.kind,'opinion');
  if(calls===2){book.known=[{start:0,end:book.text.length}];return {content:'{"recall":{"kind":"opinion","offset":1}}',input:10,output:10,estimated:false,elapsedMs:1};}
  assert.deepEqual(result.items,[]);return {content:'{"reply":"完成原范围回顾","thoughts":[]}',input:10,output:10,estimated:false,elapsedMs:1};
 }};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id);await engine.ask(book.id,'回顾先前看法。');assert.equal(calls,3);engine.stop();
});
