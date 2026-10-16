import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importBook } from '../src/core/books.ts';
import { applyFactReview, createFactReview, factReviewMessages, focusFactReview, parseFactReview, reviewableFact } from '../src/core/fact-review.ts';
import {initialState} from '../src/core/state.ts';
import {evidence} from '../src/core/context.ts';

test('长看法核对保留完整原文与空白，并继续拒绝重写和撤权结果',async()=>{
 const {book}=await fixture(),state=initialState();state.books=[book];
 const text='  \r\n'+('这是对设备记录的独立看法，仍待后续观察。'.repeat(140))+'\r\n  ';
 const memory={id:'long-view',bookId:book.id,partnerId:state.partnerId,kind:'opinion' as const,text,evidence:[evidence(book,book.known[0])],parents:[],chatIds:[],createdAt:1,forgotten:false,source:'reading' as const};state.memories=[memory];
 const review=createFactReview(book,[memory]);
 const output=(value:string)=>JSON.stringify({items:[{id:'m0',text:value,sourceIds:[review.sources[0].id],reason:'事实依据保持，主观看法逐字保留'}]});
 const result=parseFactReview(review,output(text));assert.equal(result[0].text,text);
 assert.throws(()=>parseFactReview(review,output(text.trim())),/逐字/);
 assert.throws(()=>createFactReview(book,[{...memory,text:'检'.repeat(12001)}]));
 const revoked=structuredClone(state);revoked.books[0].known=[];assert.throws(()=>applyFactReview(revoked,review,result),/权限/);
 const [revision]=applyFactReview(state,review,result);assert.equal(state.memories.find(m=>m.id===revision)!.text,text);assert.equal(memory.replacedBy,revision);
});

async function fixture() {
  const book = await importBook('工程事实', '第一章 登记\n设备甲共有3件。\n测试成功后才可能分配到乙组。\n第二章 后续\nUNREAD-SENTINEL');
  const end = book.chapters[0].end; book.known = [{ start: 0, end }];
  const refs = [{ bookId: book.id, version: book.version, start: 0, end }];
  const candidates = [{ id: 'actual-record-A', text: '设备甲有4件。', evidence: refs }, { id: 'actual-record-B', text: '测试后一定分配到乙组。', evidence: refs }];
  return { book, candidates, review: createFactReview(book, candidates) };
}
test('核对只使用获准原文，短编号由程序映射回原记录和原文坐标', async () => {
  const { book, review } = await fixture(), payload = JSON.stringify(factReviewMessages(review));
  assert.ok(!payload.includes('actual-record-A')); assert.ok(!payload.includes('UNREAD-SENTINEL'));
  const raw = JSON.stringify({ items: [{ id: 'm1', text: '测试成功后才可能分配到乙组。', sourceIds: ['p2'], reason: '保留必要条件和可能性' }, { id: 'm0', text: '设备甲共有3件。', sourceIds: ['p1'], reason: '修正数量' }] });
  const result = parseFactReview(review, raw); assert.equal(result[0].originalId, 'actual-record-B'); assert.equal(result[1].originalId, 'actual-record-A');
  assert.equal(book.text.slice(result[0].evidence[0].start, result[0].evidence[0].end), '测试成功后才可能分配到乙组。');
});
test('缺项、重复、伪造记录ID或来源不能通过校验，不能按顺序猜测替换对象', async () => {
  const { review } = await fixture();
  const good = [{ id: 'm0', text: '3件', sourceIds: ['p1'], reason: '核对' }, { id: 'm1', text: null, sourceIds: [], reason: '当前原文不足' }];
  for (const items of [good.slice(0,1), [good[0],good[0]], [{ ...good[0], id: 'actual-record-A' }, good[1]], [{ ...good[0], sourceIds: ['p99'] }, good[1]], [{ ...good[0], sourceIds: [] },good[1]], [good[0], { ...good[1], sourceIds: ['p1'] }]]) assert.throws(() => parseFactReview(review, JSON.stringify({ items })), /未修改记忆/);
  assert.equal(parseFactReview(review, JSON.stringify({ items: good }))[1].text, null);
});

test('重新核对不能复活遗忘、用户更正、替代版本或撤回权限；在途原因改变不能提交',async()=>{
 const {book,candidates}=await fixture(),state=initialState();state.books=[book];
 const memory={...candidates[0],bookId:book.id,kind:'story' as const,partnerId:state.partnerId,source:'reading' as const,parents:[],chatIds:[],createdAt:1,forgotten:false,invalidatedBy:'old-cause'};
 state.memories=[memory];assert.equal(reviewableFact(state,book,memory),true);
 for(const patch of [{forgotten:true},{source:'correction' as const},{replacedBy:'replacement'},{webSources:[{url:'https://example.com',title:'来源'}]}])assert.equal(reviewableFact(state,book,{...memory,...patch}),false);
 assert.equal(reviewableFact(state,{...book,known:[]},memory),false);
 const review=createFactReview(book,[memory]),result=parseFactReview(review,JSON.stringify({items:[{id:'m0',text:'设备甲共有3件。',sourceIds:['p1'],reason:'核对数量'}]}));
 memory.invalidatedBy='new-cause';assert.throws(()=>applyFactReview(state,review,result),/记录已更新/);assert.equal(memory.replacedBy,undefined);
});

test('简报累计使用范围保留为权限边界，核对入口从获准形成段开始且限制全文长度',async()=>{
 const book=await importBook('阶段核对','第一章 历史\n'+'早先工程资料。'.repeat(1700)+'\n第二章 登记\n设备AX登记3件。\n第三章\nUNREAD-BRIEF');
 book.known=[{start:0,end:book.chapters[1].end}];
 const candidate={id:'brief',kind:'context' as const,text:'设备AX登记5件；原因与期限仍待核实。',evidence:[evidence(book,book.known[0])],readingStage:[book.chapters[1]]};
 const review=createFactReview(book,[candidate]);assert.ok(review.sources.reduce((n,s)=>n+s.text.length,0)<1000);assert.equal(review.candidates[0].evidence[0].start,0);
 assert.equal(JSON.stringify(review.sources).includes('UNREAD-BRIEF'),false);
 assert.throws(()=>parseFactReview(review,JSON.stringify({items:[{id:'m0',text:'过'.repeat(1001),sourceIds:[review.sources[0].id],reason:'核对'}]})),/未修改记忆/);
});
test('核对不能填入未授权的间隔，也不能借附加资料读取其他作品或后文', async () => {
  const { book, candidates } = await fixture(); book.known = [{ start: 0, end: 6 }, { start: 10, end: 15 }];
  assert.throws(() => createFactReview(book, candidates), /超出/);
  const refs = book.known.map(r => ({ ...r, bookId: book.id, version: book.version }));
  const review = createFactReview(book, [{ ...candidates[0], evidence: refs }]);
  assert.ok(review.sources.every(s => book.known.some(r => r.start <= s.evidence.start && r.end >= s.evidence.end)));
  assert.throws(() => createFactReview(book, [{ ...candidates[0], evidence: refs }], [{ ...refs[0], bookId: 'other' }]), /超出/);
});

test('较短核对资料完整提供，关联词排名不会藏起其它事实所需的段落',async()=>{
  const book=await importBook('完整核对',Array.from({length:12},(_,i)=>`工程记录${i}：由操作员${i}登记设备${i}。`).join('\n')+'\nUNSEEN');
  const end=book.text.indexOf('\nUNSEEN');book.known=[{start:0,end}];
  const review=createFactReview(book,[{id:'one',text:'记录0与记录11的操作员不同。',evidence:[{bookId:book.id,version:book.version,start:0,end}]}]);
  const initial=focusFactReview(review);assert.equal(initial.sources.length,12);assert.deepEqual(initial.sources,review.sources);assert.ok(!JSON.stringify(initial).includes('UNSEEN'));
});

test('从句中开始的旧引用补充附近已读语境，未读间隔和后文仍不进入核对',async()=>{
  const text='第一章 记录\n设备甲又叫备用甲，登记数量为三件。\nUNREAD-GAP\n已读补充记录保持原样。\nFUTURE';
  const book=await importBook('截断引用',text),gap=text.indexOf('UNREAD-GAP'),after=gap+'UNREAD-GAP\n'.length,end=text.indexOf('\nFUTURE');
  book.known=[{start:0,end:gap},{start:after,end}];
  const start=text.indexOf('又叫'),finish=text.indexOf('三件')+2;
  const review=createFactReview(book,[{id:'old',text:'设备甲原名备用甲。',evidence:[{bookId:book.id,version:book.version,start,end:finish}]}]);
  assert.ok(review.sources.some(s=>s.text.includes('设备甲又叫备用甲')));
  assert.equal(JSON.stringify(review.sources).includes('UNREAD-GAP'),false);assert.equal(JSON.stringify(review.sources).includes('FUTURE'),false);
  assert.deepEqual(book.known,[{start:0,end:gap},{start:after,end}]);
});
