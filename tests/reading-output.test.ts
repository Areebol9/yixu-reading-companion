import test from 'node:test';
import assert from 'node:assert/strict';
import { readingOpinionFinal, conversationFinalContent, readingSubmissionContent, readingEnvelopeText } from '../src/core/reading-output.ts';
import { readingSubmit } from '../src/core/reading-agent.ts';
import { readingReceiptCandidate, receiveCompanionReadingReceipt, companionReadingReceiptUsable } from '../src/core/companion-receipts.ts';
import { initialState } from '../src/core/state.ts';
import { importBook } from '../src/core/books.ts';
import { ReadingReferences } from '../src/core/reading-references.ts';
import { queryMaterialStamp } from '../src/core/query-checkpoints.ts';
import type { AgentModelReply, QueryMaterial, ReadingReply, Usage } from '../src/core/types.ts';

const prose='  工程观点：复测正在进行，移交条件仍需核对。\r\n登记与校准记录继续保留。  \n';
const response=(content:string,toolCalls:AgentModelReply['toolCalls']=[],finish:AgentModelReply['finish']='stop'):AgentModelReply=>({content,toolCalls,finish,input:11,output:7,estimated:false});
const call=(name:string,args:string)=>({id:'output-unit-tool',type:'function' as const,function:{name,arguments:args}});

test('自然终态逐字作为普通opinion且无聊天正文，伴读引用实际首条理解',()=>{
  for(const strategy of ['structured','full-original','companion'] as const){
    let complete=0;const result=readingOpinionFinal(prose,()=>complete++,strategy);
    assert.equal(complete,1);assert.equal(result.reply,'');assert.deepEqual(result.thoughts,[{kind:'opinion',text:prose}]);assert.deepEqual(Buffer.from(result.thoughts[0].text),Buffer.from(prose));assert.equal(result.replyBasis,undefined);
    assert.deepEqual(result.workspace,strategy==='companion'?{understanding:'t1'}:undefined);
    assert.equal(result.thoughts.some(t=>t.kind==='shared'),false);
  }
});

test('自然正文边界完整保留，超限和协议碎片直接拒绝，不补写或截字',()=>{
  assert.equal(readingOpinionFinal('检'.repeat(12000),()=>{}).thoughts[0].text.length,12000);
  assert.throws(()=>readingOpinionFinal('检'.repeat(12001),()=>{}));
  for(const text of ['', '  \r\n', '{}', '{"reply":"工程答复","thoughts":', '```json\n{}\n```', '<tool>read_original</tool>']){
    assert.throws(()=>readingOpinionFinal(text,()=>{}));assert.throws(()=>conversationFinalContent(text,()=>{}));
  }
  assert.throws(()=>readingOpinionFinal(prose,()=>{throw Error('尚未完成必需取材');}),/尚未完成必需取材/);
  assert.throws(()=>conversationFinalContent(prose,()=>{throw Error('尚未完成必需取材');}),/尚未完成必需取材/);
});

test('同包终态正文优先于占位reply，结构提议保持且正文归因回到完整形成依赖',()=>{
  const submitted:ReadingReply={reply:'占位：看上方正文。',thoughts:[{kind:'opinion',text:'复测与移交需分别核对。'}],reinforce:['m1'],wantsLong:false,title:'工程核对',workspace:{understanding:'t1'},replyBasis:{memoryIds:[],chatIds:[]}};
  const snapshot=structuredClone(submitted),result=conversationFinalContent(prose,()=>{},submitted);
  assert.equal(result.reply,prose);assert.deepEqual(result.thoughts,snapshot.thoughts);assert.deepEqual(result.workspace,snapshot.workspace);assert.deepEqual(result.reinforce,snapshot.reinforce);assert.equal(result.title,snapshot.title);assert.equal(result.replyBasis,undefined);assert.deepEqual(submitted,snapshot);
});

test('安静阅读显式提交承担理解，同包工程说明不覆盖选择',()=>{
  const submitted:ReadingReply={reply:'',thoughts:[{kind:'opinion',text:'原提交的完整工程理解。'.repeat(220)}],reinforce:[],wantsLong:false,workspace:{understanding:'t1',focus:['m1']}};
  const result=readingSubmissionContent(prose,()=>{},'companion',submitted);
  assert.deepEqual(result,submitted);assert.deepEqual(result.workspace,{understanding:'t1',focus:['m1']});
  const duplicate=readingSubmissionContent(prose,()=>{},'companion',{...submitted,thoughts:[{kind:'opinion',text:prose}]});assert.equal(duplicate.thoughts.length,1);assert.equal(duplicate.workspace?.understanding,'t1');
});

test('完整opinion不再截为短条，其余事实条目保留原短限',()=>{
  for(const strategy of ['structured','full-original','companion'] as const){
    const submit=readingSubmit(()=>{},undefined,{readingStrategy:strategy});
    const views=[{kind:'opinion',text:'检'.repeat(12000)},{kind:'opinion',text:'修'.repeat(9000)}];
    const parsed=submit.parse({reply:'',thoughts:views});assert.equal(parsed.thoughts.length,views.length);parsed.thoughts.forEach((thought,index)=>{assert.equal(thought.kind,views[index].kind);assert.ok(thought.text===views[index].text,'完整opinion逐字保留');});
    assert.throws(()=>submit.parse({reply:'',thoughts:[{kind:'opinion',text:'检'.repeat(12001)}]}));
    assert.throws(()=>submit.parse({reply:'',thoughts:[{kind:'story',text:'检'.repeat(1801)}]}));
  }
});

test('取材中间文字不成为可恢复终态候选，完整stop原文可保留',()=>{
  assert.equal(readingReceiptCandidate(response('取材中的工程说明。',[call('read_original','{"start":0,"end":10}')],'tool_calls')),undefined);
  assert.equal(readingReceiptCandidate(response('取材中的工程说明。',[call('read_original','{"start":0,"end":10}'),call('submit_reading','{}')],'tool_calls')),undefined);
  const candidate=readingReceiptCandidate(response(prose));assert.equal(candidate?.text,prose);assert.equal(candidate?.format,'content');
  assert.equal(readingReceiptCandidate(response('{"reply":"未完成","thoughts":')),undefined);
});

async function receiptFixture(status:Usage['status'],strategy:'companion'|'full-original'){
  const state=initialState(),book=await importBook('终态回执权限工程资料','第一章 检修\n设备已登记，复测尚待完成。');state.books=[book];book.known=[{start:0,end:book.text.length}];book.position=book.text.length;
  const range={start:0,end:book.text.length},e={bookId:book.id,version:book.version,...range},refs=new ReadingReferences();
  const material:QueryMaterial={messages:[{role:'user',content:'工程取材已提供。'}],refs:[e],originalRanges:[range],memoryIds:[],chatIds:[],habitIds:[],passages:[],references:refs.snapshot(),webSources:[],ranges:[range],readUrls:[],readingStrategy:strategy,narrativeMode:'legacy',basisStampVersion:1};
  const request={source:'reading' as const,ranges:[range],input:'自动跟读'},requestKey=JSON.stringify([book.id,book.version,state.partnerId,request.source,request.ranges]);
  state.usage=[{id:'actual-output-receipt',time:1,serviceId:state.settings.serviceId,purpose:'跟读',input:11,output:7,estimated:false,status,dispatchState:status==='complete'?'response-received':'dispatch-started',requestKey}];
  return{state,book,material,request,requestKey};
}

test('原答保存承接形成strategy及真实complete用量，unknown或failed不能制造成功原回执',async()=>{
  for(const strategy of ['companion','full-original'] as const){
    const f=await receiptFixture('complete',strategy),receipt=receiveCompanionReadingReceipt(f.state,f.book,f.request,f.requestKey,'actual-output-receipt',f.material,queryMaterialStamp(f.state,f.material),response(prose))!;
    assert.ok(receipt);assert.equal(receipt.material.readingStrategy,strategy);assert.equal(receipt.candidate.text,prose);assert.equal(companionReadingReceiptUsable(f.state,receipt),true);
    f.book.known=[];assert.equal(companionReadingReceiptUsable(f.state,receipt),false);assert.equal(receipt.candidate.text,prose);
    for(const status of ['unknown','failed'] as const){const blocked=await receiptFixture(status,strategy);assert.throws(()=>receiveCompanionReadingReceipt(blocked.state,blocked.book,blocked.request,blocked.requestKey,'actual-output-receipt',blocked.material,queryMaterialStamp(blocked.state,blocked.material),response(prose)));assert.equal(blocked.state.companionReadingReceipts?.length??0,0);assert.equal(blocked.state.usage[0].status,status);}
  }
});

test('JSON终态坏类型只恢复明确文本叶子，按固定字段顺序逐字保留并整体丢弃结构操作',()=>{
  const brief='  工程简报：校准已完成。\r\n  ',reply='\r\n工程阅读反应：复测继续。  ',same='  重复工程条件须保留。\r\n';
  const raw=JSON.stringify({thoughts:[{kind:'thread',text:same,updates:'m1',answersPartOf:'m2',world:{text:'WORLD-OPERATION-ONLY'}},{kind:'opinion',text:same},{kind:'story',text:'  \r\n'},{kind:'story',text:123}],reply,readingBrief:brief,
    stateUpdates:[{stateChangeOf:'m3',status:'ended',text:'STATE-OPERATION-ONLY'}],entityRoots:[{name:'WORLD-ENTITY-ONLY'}],reasoning_content:'PRIVATE-ENVELOPE-REASONING',unknown:'UNKNOWN-ENVELOPE-TEXT'});
  const expected=brief+'\n\n'+reply+'\n\n'+same+'\n\n'+same;
  assert.equal(readingEnvelopeText(raw),expected);assert.equal(readingEnvelopeText('```json\n'+raw+'\n```'),expected);
  assert.throws(()=>readingOpinionFinal(raw,()=>{}),'纯自然正文入口不接收JSON容器');
  for(const strategy of ['structured','full-original','companion'] as const){
    let complete=0;const result=readingSubmissionContent(raw,()=>complete++,strategy);
    assert.equal(complete,1);assert.equal(result.reply,'');assert.equal(result.thoughts.length,1);assert.equal(result.thoughts[0].kind,'opinion');assert.ok(Buffer.from(result.thoughts[0].text).equals(Buffer.from(expected)));
    assert.equal(result.thoughts[0].updates,undefined);assert.equal(result.thoughts[0].answersPartOf,undefined);assert.equal(result.stateUpdates,undefined);assert.equal(result.entityRoots,undefined);assert.equal(result.readingBrief,undefined);
    assert.equal(result.thoughts[0].text.includes('PRIVATE-ENVELOPE-REASONING'),false);assert.equal(result.thoughts[0].text.includes('UNKNOWN-ENVELOPE-TEXT'),false);assert.equal(result.thoughts[0].text.includes('OPERATION-ONLY'),false);
  }
});

test('JSON终态取材容器、无文本及超限拒绝，恢复文本仍须完成必需资料检查',()=>{
  for(const key of ['read','lookup','recall','history','search','readPage']){
    const raw=JSON.stringify({reply:'工程正文已返回。',[key]:null});assert.throws(()=>readingEnvelopeText(raw),key);assert.throws(()=>readingSubmissionContent(raw,()=>{}),key);
  }
  for(const raw of ['{}','[]','{"thoughts":','{"thoughts":[{"kind":"thread","text":123}]}','{"readingBrief":"  \\r\\n"}',JSON.stringify({reply:'检'.repeat(12001)})])assert.throws(()=>readingSubmissionContent(raw,()=>{}));
  const raw=JSON.stringify({reply:'工程正文已返回。',thoughts:[{kind:'thread',text:'复测仍在进行。'}]});
  assert.throws(()=>readingSubmissionContent(raw,()=>{throw Error('必需取材尚未完成');}),/必需取材尚未完成/);
});

test('JSON交流只使用明确非空reply，不能从thoughts或brief编造答复',()=>{
  const raw=JSON.stringify({readingBrief:'BRIEF-NOT-CHAT',reply:prose,thoughts:[{kind:'thread',text:'THOUGHT-NOT-CHAT',updates:'m1'}],reasoning_content:'PRIVATE-ENVELOPE-REASONING'});
  assert.equal(readingEnvelopeText(raw,true),prose);const result=conversationFinalContent(raw,()=>{});assert.equal(result.reply,prose);assert.deepEqual(result.thoughts,[]);assert.equal(result.replyBasis,undefined);
  for(const reply of [undefined,'','  \r\n',123])assert.throws(()=>conversationFinalContent(JSON.stringify({reply,readingBrief:'可读简报。',thoughts:[{kind:'thread',text:'可读认识。'}]}),()=>{}));
});

const encodedLeaves=['  工程条目：检修登记继续保留。\r\n','\r\n工程条目：复测仍在进行。  ','  重复移交条件。\r\n','  重复移交条件。\r\n','\r\n工程路径 C:\\检修\\记录，“] {”仅为正文。  '];
const encodedItems=encodedLeaves.map((text,index)=>({kind:index===0?'thread':'opinion',text,...(index===0?{updates:'m1',answersPartOf:'m2',narrative:{subjects:['检修登记'],text:'NESTED-NARRATIVE-TEXT'},reasoning:{text:'NESTED-REASONING-TEXT'}}:{})}));
const encodedValid=JSON.stringify(encodedItems);
const encodedNestedBad=encodedValid.replace('"subjects":["检修登记"]','"subjects":["检修登记"]]');
const encodedObjectEndBad=encodedValid.replace('"text":"NESTED-NARRATIVE-TEXT"}','"text":"NESTED-NARRATIVE-TEXT"}]');
const encodedOuter=(thoughts:string)=>JSON.stringify({reply:'',thoughts,stateUpdates:[{stateChangeOf:'m1',status:'ended',text:'STRUCTURE-ONLY-TEXT'}],entityRoots:[{name:'STRUCTURE-ONLY-ENTITY'}],reasoning_content:'PRIVATE-ENCODED-REASONING'});

test('编码thoughts合法内数组或嵌套多余右括号均逐字提取每顶层条目文本，重复与空白保持',()=>{
  assert.doesNotThrow(()=>JSON.parse(encodedValid));assert.throws(()=>JSON.parse(encodedNestedBad));assert.throws(()=>JSON.parse(encodedObjectEndBad));
  const expected=encodedLeaves.join('\n\n');
  for(const inner of [encodedValid,encodedNestedBad,encodedObjectEndBad]){
    const raw=encodedOuter(inner);assert.doesNotThrow(()=>JSON.parse(raw));assert.equal(readingEnvelopeText(raw),expected);
    const result=readingSubmissionContent('ENGINE CONTAINER COMMENTARY',()=>{},'full-original',undefined,raw);
    assert.equal(result.reply,'');assert.equal(result.thoughts.length,1);assert.equal(result.thoughts[0].kind,'opinion');assert.ok(Buffer.from(result.thoughts[0].text).equals(Buffer.from(expected)));
    assert.equal(result.thoughts[0].updates,undefined);assert.equal(result.thoughts[0].answersPartOf,undefined);assert.equal(result.stateUpdates,undefined);assert.equal(result.entityRoots,undefined);assert.equal(result.thoughts[0].text.includes('NESTED-'),false);assert.equal(result.thoughts[0].text.includes('PRIVATE-'),false);assert.equal(result.thoughts[0].text.includes('STRUCTURE-ONLY'),false);
  }
});

test('编码thoughts空值、非数组、未闭词法及超限拒绝，不把半段容器当完整成果',()=>{
  const invalid=['','  ','[]','{"text":"不是数组"}','"不是数组"','[{"text":"完整工程条目"}','[{"text":"完整工程条目"},{"text":"未闭合','[{"text":"\\q"}]','[{"text":"\\u12"}]','[{"text":"甲","text":"乙"}]','[{"text":"甲","text":"甲"}]','[{"text":"工程正文"]}]','[{"text":"工程正文","updates":"m1"]}]','[{"text":"甲"}{"text":"乙"}]',JSON.stringify([{text:'检'.repeat(12001)}])];
  for(const inner of invalid)assert.throws(()=>readingEnvelopeText(encodedOuter(inner)),inner.slice(0,40));
  assert.throws(()=>readingSubmissionContent('',()=>{throw Error('必需资料尚未完成');},'full-original',undefined,encodedOuter(encodedNestedBad)),/必需资料尚未完成/);
  assert.throws(()=>readingEnvelopeText(JSON.stringify({thoughts:encodedValid,read:null})),/取材/);
});

test('编码thoughts只能形成阅读看法，交流不能用内数组文本冒充reply',()=>{
  for(const inner of [encodedValid,encodedNestedBad,encodedObjectEndBad]){
    assert.throws(()=>readingEnvelopeText(encodedOuter(inner),true));assert.throws(()=>conversationFinalContent(encodedOuter(inner),()=>{}));
    const raw=JSON.stringify({reply:prose,thoughts:inner});assert.equal(conversationFinalContent(raw,()=>{}).reply,prose);
  }
});
