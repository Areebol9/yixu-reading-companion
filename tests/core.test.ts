import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chunks,covers,importBook,locateObservation,mergeRanges,subtractRanges} from '../src/core/books.ts';
import {deleteChat,evidence,forgetMemory,readText,searchText,usableMemories} from '../src/core/context.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import {restoreBackup} from '../src/core/backup.ts';
import {initialState} from '../src/core/state.ts';
import {parseReadingReply,reserveUsage} from '../src/core/model.ts';
import {filterWebPages,publicWebUrl,validateSearch} from '../src/core/web.ts';
import {validateService} from '../src/core/services.ts';
import {selectMemories} from '../src/core/recall.ts';
import {TransientServiceError,ModelRequestError} from '../src/core/errors.ts';
import {accounting,setCostLimit} from '../src/core/accounting.ts';
import {mcpText,exaSearchPages,exaFetchedPage} from '../src/core/mcp-search.ts';
import type {ModelPort,State,Store} from '../src/core/types.ts';

const sample='第一章 已读\n这是用于检查阅读边界的一段资料，记录编号甲尚未改变。\n第二章 后续\n未来唯一标记SECRET-OMEGA，编号甲在此改变。';
const fixture=async()=>{const state=initialState();const book=await importBook('边界资料',sample);book.known=[{start:0,end:book.chapters[1].start}];book.position=book.known[0].end;state.books.push(book);state.settings.services[0].enabled=true;return {state,book};};
const store:Store={async load(){return undefined;},async save(){}};

test('网页范围拒绝维基根域名、子域名和尾点写法，保留原始机构来源',()=>{
 for(const host of ['wikipedia.org','zh.wikipedia.org','WIKIPEDIA.ORG.','zh.wikipedia.org.','wikimedia.org','commons.wikimedia.org.']){
  assert.throws(()=>publicWebUrl('https://'+host+'/page'));
  assert.deepEqual(filterWebPages([{title:'外部资料',url:'https://'+host+'/page',extract:'不得进入模型'}],'测试书籍'),[]);
 }
 assert.equal(publicWebUrl('https://developer.android.com/reference').hostname,'developer.android.com');
});

test('授权前文的读取、检索和派生记忆均不能暴露后续唯一标记',async()=>{
 const {state,book}=await fixture();
 assert.throws(()=>readText(book,{start:0,end:book.text.length}));
 assert.equal(searchText(book,'SECRET-OMEGA').length,0);
 state.memories.push({id:'later',bookId:book.id,partnerId:'default',kind:'opinion',text:'后续结论',evidence:[evidence(book,{start:book.known[0].end,end:book.text.length})],parents:[],chatIds:[],createdAt:0,forgotten:false,source:'background'});
 assert.equal(usableMemories(state,book).length,0);
});
test('跳章和回看不自动补齐未读空白，准备分片没有截断尾部',()=>{
 const known=mergeRanges([{start:0,end:20},{start:40,end:65}]);
 assert.equal(covers(known,{start:15,end:45}),false);
 const pieces=chunks([{start:0,end:23456}],6000);
 assert.equal(pieces.reduce((n,s)=>n+s.end-s.start,0),23456);
 assert.deepEqual(subtractRanges(known,[{start:5,end:15}]),[{start:0,end:5},{start:15,end:20},{start:40,end:65}]);
});
test('重复文本不会任意选择其中一个位置，模糊识别必须有充分锚点',async()=>{
 const book=await importBook('重复','同样文字用于识别定位核查，同样文字用于识别定位核查。');
 assert.equal(locateObservation(book,'同样文字用于识别定位核查').status,'ambiguous');
 assert.equal(locateObservation(book,'识别').status,'missing');
});
test('删除聊天保留独立记忆，忘记会排除派生记忆和原交流再次输入',async()=>{
 const {state,book}=await fixture(), refs=[evidence(book,book.known[0])];
 state.chats.push({id:'c',bookId:book.id,sessionId:'s',role:'user',text:'个人偏好资料',createdAt:0,evidence:refs,excluded:false});
 state.memories.push({id:'m',bookId:book.id,partnerId:'default',kind:'user',text:'个人偏好资料',evidence:refs,parents:[],chatIds:['c'],createdAt:0,forgotten:false,source:'conversation'});
 state.memories.push({...state.memories[0],id:'derived',text:'相关派生理解',parents:['m']});
 deleteChat(state,'c'); assert.equal(usableMemories(state,book).length,2);
 forgetMemory(state,'m');assert.equal(usableMemories(state,book).length,0);
});
test('请求前的预算预留和腾讯200K限制不可由换书绕过',async()=>{
 const {state}=await fixture(),service=state.settings.services[0];
 assert.throws(()=>reserveUsage(state,service,[{role:'user',content:'汉'.repeat(70000)}],'测试'));
 state.settings.tokenLimit=5000;reserveUsage(state,service,[{role:'user',content:'短内容'}],'测试');
 assert.throws(()=>reserveUsage(state,service,[{role:'user',content:'再次调用'}],'测试'));
});
test('在途响应返回前结束共读，结果不得进入记忆或对话',async()=>{
 const {state,book}=await fixture();book.prepared=[...book.known];
 let release!:()=>void,entered!:()=>void;
 const invoked=new Promise<void>(r=>entered=r), gate=new Promise<void>(r=>release=r);
 const model:ModelPort={async complete(){entered();await gate;return {content:JSON.stringify({reply:'迟到回应',thoughts:[{kind:'opinion',text:'迟到观点'}],wantsLong:false}),input:20,output:20,estimated:false,elapsedMs:1};}};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id);
 const pending=engine.ask(book.id,'核对资料');await invoked;engine.stop();release();
 await assert.rejects(pending);
 assert.equal(state.chats.some(c=>c.role==='assistant'),false);assert.equal(state.memories.length,0);
});
test('安静阅读仍可保存自己的判断，不制造共同交流',async()=>{
 const {state,book}=await fixture();book.known=[{start:0,end:10}];book.prepared=[...book.known];book.position=10;
 const model:ModelPort={async complete(){return {content:JSON.stringify({reply:'本应不显示',thoughts:[{kind:'opinion',text:'阶段判断'},{kind:'shared',text:'虚构双方曾经聊过'}],wantsLong:false}),input:10,output:10,estimated:false,elapsedMs:1};}};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id);engine.quiet(true);engine.observing(true);
 await engine.observe(book.id,'这是用于检查阅读边界的一段资料，记录编号甲尚未改变。');
 assert.equal(state.memories.length,1);assert.equal(state.memories[0].kind,'opinion');assert.equal(state.chats.length,0);
});

test('旧备份不能恢复已忘记的派生认识，也不能回退本机用量',async()=>{
 const {state,book}=await fixture(),refs=[evidence(book,book.known[0])];
 state.chats.push({id:'c-old',bookId:book.id,sessionId:'s',role:'user',text:'一项应被忘记的个人偏好',createdAt:0,evidence:refs,excluded:false});
 state.memories.push({id:'root',bookId:book.id,partnerId:'default',kind:'user',text:'用户偏好记录',evidence:refs,parents:[],chatIds:['c-old'],createdAt:0,forgotten:false,source:'conversation'});
 state.memories.push({...state.memories[0],id:'child',text:'不同措辞的派生判断',parents:['root']});
 const before=JSON.stringify(state);forgetMemory(state,'root');
 reserveUsage(state,state.settings.services[0],[{role:'user',content:'后续消耗'}],'测试');
 const restored=await restoreBackup(before,state);
 assert.equal(usableMemories(restored,book).length,0);assert.equal(restored.chats[0].excluded,true);
 assert.equal(restored.usage.length,1);assert.equal(restored.settings.services[0].enabled,false);
});

test('一次后文许可不改变实际进度，随后普通交流不带入后文和该次聊天',async()=>{
 const {state,book}=await fixture();book.prepared=[...book.known];
 const original=JSON.stringify(book.known),position=book.position,seen:string[]=[];
 const model:ModelPort={async complete(service,messages){seen.push(JSON.stringify(messages));return {content:JSON.stringify({reply:'有限回答',thoughts:[{kind:'opinion',text:'不应持久化的未来认识'}],wantsLong:false}),input:10,output:10,estimated:false,elapsedMs:1};}};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id);
 await engine.askWithFuture(book.id,'本次允许查看指定后文',{start:book.chapters[1].start,end:book.text.length});
 assert.ok(seen.some(s=>s.includes('SECRET-OMEGA')));assert.equal(JSON.stringify(book.known),original);assert.equal(book.position,position);assert.equal(state.memories.length,0);
 seen.length=0;await engine.ask(book.id,'只讨论正常已读范围');
 assert.ok(seen.every(s=>!s.includes('SECRET-OMEGA')&&!s.includes('本次允许查看指定后文')));
});
test('独立背景处理覆盖完整正文，但不改写用户进度或生成共同经历',async()=>{
 const {state,book}=await fixture();const known=JSON.stringify(book.known),position=book.position;
 const model:ModelPort={async complete(_s,m){return {content:JSON.stringify({reply:'',thoughts:[{kind:'story',text:'背景阶段记录'+JSON.parse(m[1].content).currentRange.start},{kind:'shared',text:'不成立的共同阅读'}],wantsLong:false}),input:10,output:10,estimated:false,elapsedMs:1};}};
 const engine=new ReadingEngine(state,store,model);await engine.prepareBackground(book.id);
 assert.equal(JSON.stringify(book.known),known);assert.equal(book.position,position);assert.equal(state.chats.length,0);
 assert.ok(covers(book.backgroundPrepared!,{start:0,end:book.text.length}));assert.equal(state.memories.length,2);
 const available=usableMemories(state,book);assert.equal(available.length,1);assert.ok(available.every(m=>m.evidence.every(r=>covers(book.known,r))));assert.ok(state.partners[0].backgroundBooks.includes(book.id));
 assert.equal(engine.session?.prepared,false);
});

test('模型繁忙期间经过的每个正文范围均保留，跳过区域不自动补读',async()=>{
 const {state}=await fixture();
 const parts=['起始已读资料有足够多的字符。','页面甲包含新出现的记录甲编号。','跳过的未知内容不得因此读取。','页面乙包含随后看到的记录乙编号。','页面丙包含最后看到的记录丙编号。'];
 const book=await importBook('连续范围',parts.join('\n'));state.books=[book];
 book.known=[{start:0,end:parts[0].length}];book.prepared=[...book.known];book.position=parts[0].length;
 let release!:()=>void,enter!:()=>void;const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>enter=r);const inputs:string[]=[];
 const model:ModelPort={async complete(s,m){inputs.push(JSON.stringify(m));if(inputs.length===1){enter();await gate;}return {content:JSON.stringify({reply:'阶段回应',thoughts:[],wantsLong:false}),input:10,output:10,estimated:false,elapsedMs:1};}};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id);engine.observing(true);
 const first=engine.observe(book.id,parts[1]);await entered;
 const second=engine.observe(book.id,parts[3]);const third=engine.observe(book.id,parts[4]);
 await new Promise(r=>setImmediate(r));
 const span=(i:number)=>{const match=locateObservation(book,parts[i]);assert.equal(match.status,'matched');return (match as {range:{start:number;end:number}}).range;};
 assert.ok(covers(book.known,span(3)));assert.ok(covers(book.known,span(4)));assert.equal(covers(book.known,span(2)),false);
 release();await Promise.all([first,second,third]);
 assert.ok(covers(book.prepared,span(1)));assert.ok(covers(book.prepared,span(3)));assert.ok(covers(book.prepared,span(4)));
 assert.ok(inputs.every(s=>!s.includes(parts[2])));assert.equal(state.chats.filter(c=>c.role==='assistant').length,1);
});

test('离开阅读页后迟到的理解可以保存，但不弹出主动回复',async()=>{
 const {state,book}=await fixture();book.prepared=[...book.known];
 let release!:()=>void,enter!:()=>void;const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>enter=r);
 const model:ModelPort={async complete(){enter();await gate;return {content:JSON.stringify({reply:'不应弹出',thoughts:[{kind:'opinion',text:'此处形成的理解'}],wantsLong:false}),input:10,output:10,estimated:false,elapsedMs:1};}};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id);engine.observing(true);
 const pending=engine.observe(book.id,book.text.slice(book.chapters[1].start));await entered;engine.sourceActive(false);release();await pending;
 assert.equal(state.chats.length,0);assert.equal(state.memories.length,1);
});

test('通用搜索保留不同公开来源，阻止明显后文查询和未启用的来源',()=>{
 assert.throws(()=>validateSearch('当前作品 结局','当前作品'));
 assert.throws(()=>validateSearch('密钥 abc','当前作品'));
 const pages=filterWebPages([{title:'物理资料',url:'https://science.example.org/gravity',extract:'物体之间的吸引作用。'},
 {title:'第二个来源',url:'https://other.example.org',extract:'另一份现实资料。'},
 {title:'未启用来源',url:'https://zh.wikipedia.org/?curid=2',extract:'内容'},
 {title:'本地地址',url:'https://127.0.0.1',extract:'无关'},
 {title:'坏地址',url:'invalid',extract:'错误'}],'当前作品');
 assert.equal(pages.length,2);
});

test('实机混合字形和尾部错字仅授权实际锚定的片段，不扩展到未见后文',async()=>{
 const raw='第一章 初始记录\n这是一份工程验证材料，不是小说。记录编号甲持有物件A，编号乙持有物件B。两件物品的保管状态分别登记，暂时没有发生移交。后续唯一内容。';
 const ocr='第一章 初始记录\n这是一份工程验证材料,不是小说。\n记录编号甲持有物件A,編号乙持有物件\nB。两件物品的保管状伏态分別登记,暂时';
 const book=await importBook('OCR实机核查',raw),match=locateObservation(book,ocr);
 assert.equal(match.status,'matched');if(match.status!=='matched')return;
 assert.ok(book.text.slice(match.range.start,match.range.end).includes('编号甲持有物件A'));
 assert.ok(match.range.end<=raw.indexOf('没有发生移交'));
 const repeated=await importBook('重复OCR片段',raw+'\n'+raw);
 assert.equal(locateObservation(repeated,ocr).status,'ambiguous');
});

test('恢复前校验位置和引用版本，失败时保留本机原状态',async()=>{
 const {state,book}=await fixture();const before=JSON.stringify(state),bad=structuredClone(state);
 bad.books[0].position=book.text.length+1;
 await assert.rejects(restoreBackup(JSON.stringify(bad),state),/阅读位置/);assert.equal(JSON.stringify(state),before);
 const duplicate=structuredClone(state);duplicate.books.push(duplicate.books[0]);
 await assert.rejects(restoreBackup(JSON.stringify(duplicate),state),/重复/);
});

test('预置渠道不可改址复用密钥，自定义地址必须独立配置且使用HTTPS',()=>{
 const service=initialState().settings.services[0];
 assert.throws(()=>validateService({...service,baseUrl:'https://another.example/v1'}));
 assert.throws(()=>validateService({...service,id:'custom-12345678',baseUrl:'http://another.example/v1'}));
 assert.throws(()=>validateService({...service,id:'custom-12345678',baseUrl:'https://key@another.example/v1'}));
 assert.equal(validateService({...service,id:'custom-12345678',baseUrl:'https://another.example/v1/'}).baseUrl,'https://another.example/v1');
});

test('单次输出可设置65536且旧默认与累计预算保持原值',()=>{
 const state=initialState(),before=structuredClone(state),service=state.settings.services[0];
 assert.equal(validateService({...service,maxOutput:65536}).maxOutput,65536);
 assert.equal(validateService({...service,maxOutput:16384}).maxOutput,16384);
 for(const maxOutput of [65537,255,65535.5])assert.throws(()=>validateService({...service,maxOutput}),/单次输出/);
 assert.equal(validateService(service).maxOutput,4096);assert.deepEqual(state,before);
});

test('较早但相关的记忆能被找回，排序前已排除跨书与未读内容',async()=>{
 const {state,book}=await fixture(),refs=[evidence(book,book.known[0])];
 for(let i=0;i<80;i++)state.memories.push({id:'memory-'+i,bookId:book.id,partnerId:'default',kind:'story',text:i===0?'仓库钥匙交给了保管人赵甲。':'阶段性无关记录'+i,evidence:refs,parents:[],chatIds:[],createdAt:i,forgotten:false,source:'preparation'});
 state.memories.push({...state.memories[0],id:'future-match',text:'仓库钥匙的后文变化',evidence:[evidence(book,{start:book.chapters[1].start,end:book.text.length})]});
 state.memories.push({...state.memories[0],id:'other-book',bookId:'elsewhere'});
 const result=selectMemories(state,book,book.known[0],'仓库钥匙交给谁？',[],500);
 assert.ok(result.some(m=>m.id==='memory-0'));assert.ok(result.every(m=>!['future-match','other-book'].includes(m.id)));
 assert.ok(result.reduce((n,m)=>n+m.text.length,0)<=500);
});

test('网页工具只读取本轮真实搜索结果，模型自拟网址不会触发读取',async()=>{
 const {state,book}=await fixture();book.prepared=[...book.known];state.settings.searchEnabled=true;
 let call=0,reads=0;
 const model:ModelPort={async complete(){call++;return {content:JSON.stringify({reply:'有限回答',thoughts:[],wantsLong:false,...(call===1?{readPage:'https://unknown.example.org/private'}:{})}),input:10,output:10,estimated:false,elapsedMs:1};}};
 const engine=new ReadingEngine(state,store,model);engine.readPage=async()=>{reads++;return '不应读取';};await engine.start(book.id);await engine.ask(book.id,'查阅现实资料');
 assert.equal(reads,0);assert.equal(call,2);
});

test('正文不匹配后暂停接入段评，并取消上一位置的迟到主动表达',async()=>{
 const {state,book}=await fixture();book.prepared=[...book.known];
 let release!:()=>void,enter!:()=>void,calls=0;const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>enter=r);
 const model:ModelPort={async complete(){calls++;enter();await gate;return {content:JSON.stringify({reply:'旧位置回应',thoughts:[],wantsLong:false}),input:10,output:10,estimated:false,elapsedMs:1};}};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id);engine.observing(true);
 await engine.observe(book.id,'这是另一部作品的段评，不应混进当前作品。','comment');assert.equal(calls,0);
 const pending=engine.observe(book.id,book.text.slice(book.chapters[1].start));await entered;
 await engine.observe(book.id,'完全不在此文档中的独立材料ABCDXYZ');
 await engine.observe(book.id,'另一作品的评论，不能交给这个共读会话。','comment');
 release();await pending;assert.equal(calls,1);assert.equal(state.chats.length,0);
});

test('模型繁忙时新发言立即保存，结束会话不丢失排队发言，也不再发起请求',async()=>{
 const {state,book}=await fixture();book.prepared=[...book.known];
 let release!:()=>void,enter!:()=>void,calls=0;const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>enter=r);
 const snapshots:string[]=[];const saved:Store={async load(){return undefined;},async save(s){snapshots.push(JSON.stringify(s.chats));}};
 const model:ModelPort={async complete(){calls++;enter();await gate;return {content:JSON.stringify({reply:'迟到内容',thoughts:[],wantsLong:false}),input:10,output:10,estimated:false,elapsedMs:1};}};
 const engine=new ReadingEngine(state,saved,model);await engine.start(book.id);
 const first=engine.ask(book.id,'第一条已发送');await entered;
 const second=engine.ask(book.id,'第二条排队内容');
 assert.ok(snapshots.at(-1)?.includes('第二条排队内容'));
 const settled=Promise.allSettled([first,second]);engine.stop();release();await settled;
 assert.equal(calls,1);assert.deepEqual(state.chats.map(c=>c.text),['第一条已发送','第二条排队内容']);
});

test('前文准备可回查原文，未命中与越界均明确返回且不暴露后文',async()=>{
 const {state,book}=await fixture();const seen:string[]=[];
 const model:ModelPort={async complete(s,m){
  seen.push(JSON.stringify(m));const n=seen.length;
  return {content:JSON.stringify({reply:'',thoughts:n===4?[{kind:'story',text:'核对后的前文事实'}]:[],wantsLong:false,...(n===1?{lookup:'未出现的词语'}:n===2?{read:{start:book.chapters[1].start,end:book.text.length}}:n===3?{lookup:'编号甲'}:{})}),input:10,output:10,estimated:false,elapsedMs:1};
 }};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id);await engine.prepare(book.id);
 assert.equal(seen.length,4);assert.ok(seen[1].includes('未找到匹配'));assert.ok(seen[2].includes('该范围未获准'));
 assert.ok(seen[3].includes('toolResults')&&seen[3].includes('获准原文'));assert.ok(seen.every(s=>!s.includes('SECRET-OMEGA')));
 assert.equal(engine.session?.prepared,true);assert.equal(state.memories.length,1);
});

test('准备期间读到新内容，不把尚未处理的新范围标为就绪',async()=>{
 const {state,book}=await fixture();const original=book.known[0].end;
 let release!:()=>void,enter!:()=>void;const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>enter=r);
 const model:ModelPort={async complete(){enter();await gate;return {content:JSON.stringify({reply:'',thoughts:[],wantsLong:false}),input:10,output:10,estimated:false,elapsedMs:1};}};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id);
 const preparing=engine.prepare(book.id);await entered;await engine.setKnown(book.id,book.text.length);release();await preparing;
 assert.equal(engine.session?.prepared,false);assert.ok(covers(book.prepared,{start:0,end:original}));assert.equal(covers(book.prepared,{start:0,end:book.text.length}),false);
});

test('单独讨论自动命名，手改标题与回看章节范围均保留',async()=>{
 const {state,book}=await fixture();book.prepared=[...book.known];
 const model:ModelPort={async complete(){return {content:JSON.stringify({reply:'讨论结果',title:'记录变更讨论',thoughts:[],wantsLong:false}),input:10,output:10,estimated:false,elapsedMs:1};}};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id,undefined,'discussion');await engine.ask(book.id,'核对记录变更');
 const c=state.conversations[0];assert.equal(c.title,'记录变更讨论');c.manualTitle=true;c.title='用户自己的标题';await engine.ask(book.id,'继续核对');assert.equal(c.title,'用户自己的标题');
 await engine.start(book.id);engine.observing(true);await engine.observe(book.id,book.text.slice(book.chapters[1].start));await engine.observe(book.id,book.text.slice(0,book.chapters[1].start));
 const reading=state.conversations[1];assert.ok(reading.start<reading.end);assert.ok(reading.title.startsWith('第一章'));assert.ok(reading.title.endsWith('第二章 后续'));
});

test('工具中间请求可执行，最终回应可省略空操作，但不接受无效字段类型',()=>{
 const parsed=parseReadingReply('{"lookup":"编号甲"}');assert.equal(parsed.lookup,'编号甲');assert.deepEqual(parsed.thoughts,[]);
 assert.equal(parseReadingReply('{"reply":"有效回应","thoughts":[]}').wantsLong,false);
 assert.deepEqual(parseReadingReply('{"reply":"本次没有新增认识"}').thoughts,[]);
 assert.throws(()=>parseReadingReply('{"reply":"无效理解字段","thoughts":null}'));
 assert.throws(()=>parseReadingReply('{"lookup":"编号甲","thoughts":"错误类型"}'));
 assert.throws(()=>parseReadingReply('{"read":{"start":5,"end":2}}'));
});

test('准备长篇按片段接续，明确提问先于剩余准备，提问本身不代替前文准备',async()=>{
 const {state}=await fixture();const book=await importBook('长前文','事实记录。'.repeat(3000));state.books=[book];book.known=[{start:0,end:book.text.length}];book.position=book.text.length;
 let release!:()=>void,enter!:()=>void;const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>enter=r),order:string[]=[];
 const model:ModelPort={async complete(s,m){const task=m.at(-1)!.content;order.push(task.includes('优先处理这条明确问题')?'question':'prepare');if(order.length===1){enter();await gate;}return {content:JSON.stringify({reply:'',thoughts:[],wantsLong:false}),input:10,output:10,estimated:false,elapsedMs:1};}};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id);
 const preparing=engine.prepare(book.id);await entered;const question=engine.ask(book.id,'优先处理这条明确问题');await new Promise(r=>setImmediate(r));release();
 await Promise.all([preparing,question]);assert.equal(order[0],'prepare');assert.equal(order[1],'question');assert.ok(order.slice(2).every(x=>x==='prepare'));
 assert.ok(covers(book.prepared,{start:0,end:book.text.length}));assert.equal(engine.session?.prepared,true);
 const next=await importBook('未准备的书','仅确认但没有准备的原文。');next.known=[{start:0,end:next.text.length}];next.position=next.text.length;state.books.push(next);await engine.start(next.id);await engine.ask(next.id,'核对当前位置');assert.equal(next.prepared.length,0);assert.equal(engine.session?.prepared,false);
});

test('连续短片段合成一次理解，等待期间停止不会额外调用模型',async()=>{
 const {state}=await fixture();
 const parts=['已经准备好的起始记录。','新片段甲记录唯一编号甲。','新片段乙记录唯一编号乙。','新片段丙记录唯一编号丙。'];
 const book=await importBook('短片段',parts.join(''));state.books=[book];book.known=[{start:0,end:parts[0].length}];book.prepared=[...book.known];book.position=parts[0].length;
 const seen:string[]=[];const model:ModelPort={async complete(s,m){seen.push(JSON.stringify(m));return {content:JSON.stringify({reply:'',thoughts:[],wantsLong:false}),input:10,output:10,estimated:false,elapsedMs:1};}};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id);engine.observing(true);
 const reads=parts.slice(1).map(text=>engine.observe(book.id,text));await new Promise(r=>setImmediate(r));assert.equal(seen.length,0);
 await Promise.all(reads);assert.equal(seen.length,1);assert.ok(parts.slice(1).every(text=>seen[0].includes(text.replace(/。$/, ''))));
 book.prepared=[{start:0,end:parts[0].length}];await engine.start(book.id);engine.session!.prepared=true;engine.observing(true);
 const pending=engine.observe(book.id,parts[1]);await new Promise(r=>setImmediate(r));engine.stop();await pending;assert.equal(seen.length,1);
});

test('插话打断正在生成的长篇，保留原问题并优先响应新方向',async()=>{
 const {state,book}=await fixture();book.prepared=[...book.known];
 let enter!:()=>void;const entered=new Promise<void>(r=>enter=r);let calls=0;
 const model:ModelPort={async complete(s,m,signal){calls++;if(calls===1){enter();await new Promise<void>((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('已停止','AbortError')),{once:true}));}return {content:JSON.stringify({reply:'新方向的回应',thoughts:[],wantsLong:false}),input:10,output:10,estimated:false,elapsedMs:1};}};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id);
 const long=engine.ask(book.id,'展开之前的问题',true);const failure=assert.rejects(long,{name:'AbortError'});await entered;
 await engine.ask(book.id,'改为讨论新的问题');await failure;
 assert.deepEqual(state.chats.map(c=>c.text),['展开之前的问题','改为讨论新的问题','新方向的回应']);assert.equal(calls,2);
});

test('理解失败后的已读片段保留，下次阅读事件合并补齐而非丢弃',async()=>{
 const {state}=await fixture();state.settings.minReadChars=0;
 const parts=['起始记录内容已经处理。','网络中断时看到的记录甲需要保留。','下一页的新记录乙也必须接上。'];
 const book=await importBook('中断接续',parts.join('\n'));state.books=[book];book.known=[{start:0,end:parts[0].length}];book.prepared=[...book.known];book.position=parts[0].length;
 const seen:string[]=[];const model:ModelPort={async complete(s,m){seen.push(JSON.stringify(m));if(seen.length===1)throw new Error('模拟网络中断');return {content:JSON.stringify({reply:'',thoughts:[],wantsLong:false}),input:10,output:10,estimated:false,elapsedMs:1};}};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id);engine.observing(true);
 await assert.rejects(engine.observe(book.id,parts[1]),/模拟网络中断/);await engine.observe(book.id,parts[2]);
 assert.equal(seen.length,2);assert.ok(parts.slice(1).every(text=>seen[1].includes(text.replace(/。$/,''))));
 for(const text of parts.slice(1)){const match=locateObservation(book,text);assert.equal(match.status,'matched');if(match.status==='matched')assert.ok(covers(book.prepared,match.range));}
});

test('网络恢复接续原问题且不重复用户消息，明确结束后不自动重开',async()=>{
 const {state,book}=await fixture();book.prepared=[...book.known];let calls=0;
 const model:ModelPort={async complete(){calls++;return {content:JSON.stringify({reply:'恢复后的回应',thoughts:[],wantsLong:false}),input:10,output:10,estimated:false,elapsedMs:1};}};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id);engine.setNetworkAvailable(false);
 await assert.rejects(engine.ask(book.id,'保留这个问题'),TransientServiceError);assert.equal(calls,0);assert.equal(state.usage.length,0);
 const completed=new Promise<void>(resolve=>{const off=engine.subscribe(()=>{if(state.chats[0].delivery==='answered'){off();resolve();}});});
 engine.setNetworkAvailable(true);await completed;
 assert.equal(state.chats.filter(c=>c.role==='user').length,1);assert.equal(state.chats[1].replyTo,state.chats[0].id);
 engine.setNetworkAvailable(false);await assert.rejects(engine.ask(book.id,'结束前的未完成问题'),TransientServiceError);engine.stop();engine.setNetworkAvailable(true);await engine.retryPending();
 assert.equal(calls,1);assert.equal(state.chats.at(-1)?.delivery,'stopped');assert.equal(engine.session?.active,false);
});

test('已尝试请求后服务异常保留未知用量和原问，网络恢复不自动重发',async()=>{
 const {state,book}=await fixture();book.prepared=[...book.known];let calls=0;
 const model:ModelPort={async complete(){calls++;throw new TransientServiceError('临时服务故障');}};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id);
 await assert.rejects(engine.ask(book.id,'需要保留的问题'),ModelRequestError);
 await engine.retryPending();await engine.retryPending();await engine.retryPending();
 assert.equal(calls,1);assert.equal(state.usage.length,1);assert.ok(state.usage.every(u=>u.status==='unknown'));
 assert.equal(state.chats.length,1);assert.equal(state.chats[0].delivery,'failed');engine.stop();
});

test('准备任务故障恢复从未完成片段继续，不重复处理已保存片段',async()=>{
 const {state}=await fixture();const book=await importBook('准备恢复','事实记录。'.repeat(3000));state.books=[book];book.known=[{start:0,end:book.text.length}];book.position=book.text.length;
 const starts:number[]=[];let calls=0;
 const model:ModelPort={async complete(s,m){calls++;starts.push(JSON.parse(m[1].content).currentRange.start);if(calls===2)throw new ModelRequestError('临时网络故障，请求未发出','not-dispatched',{retryable:true});return {content:JSON.stringify({reply:'',thoughts:[],wantsLong:false}),input:10,output:10,estimated:false,elapsedMs:1};}};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id);
 await assert.rejects(engine.prepare(book.id),ModelRequestError);assert.ok(covers(book.prepared,{start:0,end:6000}));await engine.retryPending();
 assert.deepEqual(starts,[0,6000,6000,12000]);assert.ok(covers(book.prepared,{start:0,end:book.text.length}));assert.equal(engine.session?.prepared,true);engine.stop();
});

test('阅读中回复旧话题保留当前会话，新阅读反应与旧问题回复各归原处',async()=>{
 const {state,book}=await fixture();book.prepared=[...book.known];state.settings.minReadChars=0;
 const model:ModelPort={async complete(s,m){const task=JSON.parse(m.at(-1)!.content).task;return {content:JSON.stringify({reply:task==='reading'?'本次阅读反应':'旧话题的答复',thoughts:[],wantsLong:false}),input:10,output:10,estimated:false,elapsedMs:1};}};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id);const old=engine.session!.id;await engine.ask(book.id,'旧话题记录');engine.stop();
 await engine.startReading(book.id);engine.observing(true);const current=engine.session!.id,generation=engine.session!.generation;
 await engine.ask(book.id,'沿旧话题追问',false,old);
 assert.equal(engine.session!.id,current);assert.equal(engine.session!.generation,generation);assert.equal(engine.session!.observing,true);assert.equal(state.chats.at(-1)?.sessionId,old);
 await engine.observe(book.id,book.text.slice(book.chapters[1].start));assert.equal(state.chats.at(-1)?.sessionId,current);assert.equal(state.chats.at(-1)?.text,'本次阅读反应');engine.stop();
});

test('未结束的阅读可跨日主动接续，旧话题续聊后的跟随另开阅读段',async()=>{
 const {state,book}=await fixture();book.prepared=[...book.known];let calls=0;
 const model:ModelPort={async complete(){calls++;return {content:JSON.stringify({reply:'回应',thoughts:[],wantsLong:false}),input:10,output:10,estimated:false,elapsedMs:1};}};
 const first=new ReadingEngine(state,store,model);await first.startReading(book.id);first.quiet(true);const reading=first.session!.id;state.conversations[0].createdAt-=172800000;
 const second=new ReadingEngine(structuredClone(state),store,model);assert.equal(second.session,undefined);assert.equal(calls,0);
 await second.startReading(book.id);assert.equal(second.session!.id,reading);assert.equal(second.session!.observing,false);assert.equal(second.session!.quiet,true);assert.equal(calls,0);
 second.stop();await second.ask(book.id,'回到旧话题',false,reading);assert.equal(second.session!.mode,'discussion');assert.throws(()=>second.observing(true),/新的阅读跟随/);
 await second.startReading(book.id);assert.notEqual(second.session!.id,reading);assert.equal(second.session!.mode,'reading');first.stop();second.stop();
});

test('读到这里先补齐理解，安静模式不发收尾评论，普通收尾不虚构用户发言',async()=>{
 const {state,book}=await fixture();book.prepared=[...book.known];state.settings.minReadChars=160;let calls=0;
 const model:ModelPort={async complete(){calls++;return {content:JSON.stringify({reply:'可以保留的简短看法',thoughts:[{kind:'opinion',text:'此刻形成的看法'},{kind:'shared',text:'不应凭空制造的共同讨论'}],wantsLong:false}),input:10,output:10,estimated:false,elapsedMs:1};}};
 const engine=new ReadingEngine(state,store,model);await engine.startReading(book.id);engine.quiet(true);engine.observing(true);
 const seen=engine.observe(book.id,book.text.slice(book.chapters[1].start));await new Promise(r=>setImmediate(r));await engine.finishReading(book.id);await seen;
 assert.equal(calls,1);assert.equal(state.chats.length,0);assert.equal(engine.session!.active,true);assert.equal(engine.session!.observing,false);assert.ok(state.memories.every(m=>m.kind!=='shared'));
 engine.quiet(false);await engine.finishReading(book.id);assert.equal(calls,2);assert.equal(state.chats.length,1);assert.equal(state.chats[0].role,'assistant');engine.stop();
});

test('刚导入但尚未确认位置的书，不因准备范围为空而显示已就绪',async()=>{
 const state=initialState(),book=await importBook('未定位作品','原文尚未确认阅读位置。');state.books=[book];
 const model:ModelPort={async complete(){throw new Error('不应发起模型调用');}};
 const engine=new ReadingEngine(state,store,model);await engine.startReading(book.id);assert.equal(engine.session!.prepared,false);await assert.rejects(engine.prepare(book.id),/确认已经读到/);engine.stop();
});

test('价格按请求发起时保存，途中改价不重写已发生调用的估算',async()=>{
 const {state,book}=await fixture();book.prepared=[...book.known];const service=state.settings.services[0];service.inputPrice=2;service.outputPrice=8;setCostLimit(state,1);
 let release!:()=>void,enter!:()=>void;const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>enter=r);
 const model:ModelPort={async complete(){enter();await gate;return {content:JSON.stringify({reply:'回应',thoughts:[],wantsLong:false}),input:10,output:20,estimated:false,elapsedMs:1};}};
 const engine=new ReadingEngine(state,store,model);await engine.start(book.id);const pending=engine.ask(book.id,'核对资料');await entered;service.inputPrice=1000;service.outputPrice=1000;release();await pending;
 assert.deepEqual(state.usage[0].pricing,{input:2,output:8,currency:'CNY'});assert.equal(state.usage[0].cost,0.00018);engine.stop();
});

test('费用预算跨渠道和关闭重开保留累计，未知费用不能当零元继续',async()=>{
 const {state}=await fixture();const [a,b]=state.settings.services;for(const s of [a,b]){s.inputPrice=1;s.outputPrice=1;}
 setCostLimit(state,1);const budgetId=state.settings.costBudgetId;reserveUsage(state,a,[{role:'user',content:'一次调用'}],'测试');setCostLimit(state,undefined);reserveUsage(state,b,[{role:'user',content:'另一个渠道'}],'测试');setCostLimit(state,0.005);
 assert.equal(state.settings.costBudgetId,budgetId);assert.equal(accounting(state).costLevel,2);assert.throws(()=>reserveUsage(state,a,[{role:'user',content:'继续'}],'测试'),/费用上限/);
 setCostLimit(state,undefined);a.inputPrice=undefined;reserveUsage(state,a,[{role:'user',content:'未定价请求'}],'测试');a.inputPrice=1;setCostLimit(state,100);
 assert.throws(()=>reserveUsage(state,a,[{role:'user',content:'继续'}],'测试'),/未定价请求/);
});

test('首次费用预算从明确启用处记账，恢复旧备份保留本机预算及后续消耗',async()=>{
 const {state}=await fixture();const before=JSON.stringify(state),service=state.settings.services[0];
 reserveUsage(state,service,[{role:'user',content:'历史未定价'}],'测试');setCostLimit(state,1);service.inputPrice=1;service.outputPrice=1;reserveUsage(state,service,[{role:'user',content:'预算内调用'}],'测试');
 const report=accounting(state);assert.equal(report.allUnknown,1);assert.equal(report.unknown,0);
 const restored=await restoreBackup(before,state);assert.equal(restored.settings.costBudgetId,state.settings.costBudgetId);assert.equal(accounting(restored).cost,report.cost);assert.equal(restored.settings.costLimit,1);
 const bad=structuredClone(state);bad.settings.costLimit=-1;await assert.rejects(restoreBackup(JSON.stringify(bad),state),/费用预算/);
});

test('匿名搜索的SSE结果按请求解析，在进入模型前排除维基百科来源',()=>{
 const content='Title: 来源甲\r\nURL: https://science.example.org/page\r\nHighlights:\r\n一条公开说明。\r\n\r\n---\r\n\r\nTitle: 不使用的来源\r\nURL: https://zh.wikipedia.org/wiki/example\r\nHighlights:\r\n不得进入结果的内容。\r\n\r\n---\r\n\r\nTitle: 来源乙\r\nURL: https://university.example.edu/page\r\nHighlights:\r\n第二条说明。';
 const raw='event: message\ndata: '+JSON.stringify({jsonrpc:'2.0',method:'notifications/message',params:{data:'非结果'}})+'\n\nevent: message\ndata: '+JSON.stringify({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:content}]}})+'\n\n';
 const pages=exaSearchPages(raw);assert.equal(pages.length,2);assert.ok(pages.every(p=>!p.extract.includes('不得进入')));assert.equal(pages[0].title,'来源甲');
 assert.throws(()=>mcpText(JSON.stringify({jsonrpc:'2.0',id:1,result:{isError:true,content:[{type:'text',text:'限额提示'}]}})),/额度上限/);
 assert.equal(exaFetchedPage(JSON.stringify({id:1,result:{content:[{type:'text',text:'# 标题\nURL: https://science.example.org/page\n正文'}]}}),'https://science.example.org/page').title,'标题');
});

test('明确联网和读网页要求不能被常识回答替代，网页来自本轮真实搜索',async()=>{
 const {state,book}=await fixture();book.prepared=[...book.known];state.settings.searchEnabled=true;let calls=0,searches=0,reads=0;
 const model:ModelPort={async complete(){calls++;return {content:JSON.stringify({reply:calls===1?'不应直接显示的常识回答':'有来源的回答',thoughts:[],wantsLong:false,...(calls===2?{search:'光谱吸收'}:{})}),input:10,output:10,estimated:false,elapsedMs:1};}};
 const engine=new ReadingEngine(state,store,model);engine.search=async()=>{searches++;return {text:'公开搜索资料',sources:[{title:'公开来源',url:'https://science.example.org/page'}]};};engine.readPage=async url=>{assert.equal(url,'https://science.example.org/page');reads++;return '实际网页正文';};
 await engine.start(book.id);await engine.ask(book.id,'请联网查阅资料并读取一个网页，解释现实中的光谱。');
 assert.equal(searches,1);assert.equal(reads,1);assert.equal(state.chats.at(-1)?.text,'有来源的回答');assert.equal(state.chats.at(-1)?.webSources?.length,1);engine.stop();
});

test('关闭联网取消在途查询，保留当前阅读会话和屏幕跟随状态',async()=>{
 const {state,book}=await fixture();book.prepared=[...book.known];state.settings.searchEnabled=true;
 const model:ModelPort={async complete(){return {content:JSON.stringify({reply:'',thoughts:[],wantsLong:false,search:'现实资料'}),input:10,output:10,estimated:false,elapsedMs:1};}};
 const engine=new ReadingEngine(state,store,model);let enter!:()=>void;const entered=new Promise<void>(r=>enter=r);
 engine.search=async(q,signal)=>{enter();await new Promise<void>((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('已取消联网','AbortError')),{once:true}));return {text:'不应使用',sources:[]};};
 await engine.startReading(book.id);engine.observing(true);const generation=engine.session!.generation;
 const pending=engine.ask(book.id,'请联网查询现实资料');const failed=assert.rejects(pending,{name:'AbortError'});await entered;engine.disableWeb();await failed;
 assert.equal(engine.session!.active,true);assert.equal(engine.session!.observing,true);assert.equal(engine.session!.generation,generation);assert.equal(state.memories.length,0);engine.stop();
});

test('明确联网但功能关闭时先保留问题不花模型用量，本次禁止联网由工具层执行',async()=>{
 const {state,book}=await fixture();book.prepared=[...book.known];let calls=0,searches=0;
 const model:ModelPort={async complete(){calls++;return {content:JSON.stringify({reply:'本地资料回应',thoughts:[],wantsLong:false,...(calls===1?{search:'不应执行'}:{})}),input:10,output:10,estimated:false,elapsedMs:1};}};
 const engine=new ReadingEngine(state,store,model);engine.search=async()=>{searches++;return {text:'外部内容',sources:[]};};await engine.start(book.id);
 await assert.rejects(engine.ask(book.id,'请联网查阅资料'),/先启用/);assert.equal(calls,0);assert.equal(state.chats[0].delivery,'failed');
 state.settings.searchEnabled=true;await engine.ask(book.id,'请不要联网，依据现有资料回答。');assert.equal(searches,0);assert.equal(calls,2);engine.stop();
});
