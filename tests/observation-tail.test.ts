import { test } from 'node:test';
import assert from 'node:assert/strict';
import { covers, importBook, locateObservation } from '../src/core/books.ts';
import { ReadingEngine } from '../src/core/engine.ts';
import { ReadingRuntime } from '../src/core/runtime.ts';
import { initialState } from '../src/core/state.ts';
import type { ModelMessage } from '../src/core/types.ts';

test('间隔锚点不遗漏错字之后真实可见的精确尾部，也不延伸到未显示正文',async()=>{
  const shown=Array.from({length:18},(_,i)=>`设备${i}已登记${i+2}件。`).join('')+'本页末段代号为甲乙丙丁戊己庚辛壬癸';
  const observed=shown.slice(0,-11)+'错'+shown.slice(-10),book=await importBook('尾部定位',shown+'\nUNSEEN-TAIL');
  const result=locateObservation(book,observed);
  assert.equal(result.status,'matched');if(result.status!=='matched')return;
  assert.deepEqual(result.range,{start:0,end:shown.length});assert.ok(result.score<1&&result.score>=.92);
});

const page = '第一章 资料\n' + Array.from({length:16},(_,i)=>`编号${i}记录设备${i+2}项，已经按次序检查完毕。`).join('') + '本段记录全部结束';
const tail = '甲狼组前身是镜州界内一股联合工坊';
const noisyTail = '甲浪组前身是鏡州界内一股联合工方';

test('已唯一定位页面后恢复错字末行，半句留在缓冲，未识别间隔仍不进入权限',async()=>{
  const gap='\nGAP-NOT-OBSERVED\n',book=await importBook('末行工程资料',page+gap+tail+'\nUNSEEN-FUTURE');
  const observed=page+'\n'+noisyTail,result=locateObservation(book,observed);
  assert.equal(result.status,'matched');if(result.status!=='matched')return;
  assert.equal(result.ranges.length,2);
  const tailStart=book.text.indexOf(tail),latest=result.ranges.at(-1)!;
  assert.equal(latest.start,tailStart);assert.ok(latest.end>tailStart+10&&latest.end<=tailStart+tail.length);
  assert.equal(covers(result.ranges,{start:page.length,end:tailStart}),false);
  const state=initialState();state.books=[book];state.settings.services[0].enabled=true;
  book.known=[{start:0,end:book.text.indexOf('\n')+1}];book.prepared=[...book.known];
  const requests:ModelMessage[][]=[];
  const engine=new ReadingEngine(state,{async load(){return state;},async save(){}},{async complete(_service,messages){requests.push(messages);return {content:JSON.stringify({reply:'',thoughts:[],wantsLong:false}),input:1,output:1,estimated:false,elapsedMs:1};}});
  try{
    await engine.startReading(book.id);engine.observing(true);await engine.observe(book.id,observed);
    assert.equal(requests.length,1);assert.equal(book.position,latest.end);
    assert.equal(JSON.stringify(requests).includes('GAP-NOT-OBSERVED'),false);assert.equal(JSON.stringify(requests).includes('UNSEEN-FUTURE'),false);
    assert.equal(JSON.stringify(requests).includes('甲狼组前身'),false);assert.ok(JSON.stringify(requests).includes('编号15记录设备17项'));
    assert.ok(covers(book.buffered??[],latest));assert.equal(covers(book.prepared,latest),false);
  }finally{engine.stop();}
});

test('末行已经完整匹配时不以更差的候选越过真实末尾',async()=>{
  const shown=page+'\n'+tail,book=await importBook('末尾边界',shown+'下一页不允许出现');
  const result=locateObservation(book,shown.replace('编号3','編号3'));
  assert.equal(result.status,'matched');if(result.status!=='matched')return;
  assert.ok(result.ranges.every(range=>range.end<=shown.length));
  assert.equal(result.ranges.at(-1)!.end,shown.length);
});

test('附近重复末行不任意选取后一个位置，未见文字保持未授权',async()=>{
  const book=await importBook('重复末行',page+'\n'+tail+'\n'+tail+'\nUNSEEN-FUTURE');
  const result=locateObservation(book,page+'\n'+noisyTail);
  assert.equal(result.status,'matched');if(result.status!=='matched')return;
  assert.ok(result.ranges.every(range=>range.end<=page.length));
});

test('不相干页脚不能借助已匹配正文取得后续权限',async()=>{
  const book=await importBook('页脚',page+'\n'+tail+'\nUNSEEN-FUTURE');
  const result=locateObservation(book,page+'\n阅读设置与本地书架使用统计页面');
  assert.equal(result.status,'matched');if(result.status!=='matched')return;
  assert.ok(result.ranges.every(range=>range.end<=page.length));
});

test('可信单列裁剪画面补齐锚点之间的OCR遗漏，不连接跨页空白或延伸尾部',async()=>{
  const missed='\nOCR-MISSED-IN-FRAME\n',skipped='\nSEPARATE-UNSEEN-CHAPTER\n';
  const later='后面的独立页面记载了另一批设备，编号与数量均已分别核对。';
  const book=await importBook('连续画面工程',page+missed+tail+skipped+later+'\nUNSEEN-FUTURE');
  book.known=[{start:0,end:book.text.indexOf('\n')+1}];book.prepared=[...book.known];
  const state=initialState();state.books=[book];state.settings.services[0].enabled=true;
  const requests:ModelMessage[][]=[];let captureToken='';
  const engine=new ReadingEngine(state,{async load(){return state;},async save(){}},{async complete(_s,m){requests.push(m);return {content:JSON.stringify({reply:'',thoughts:[],wantsLong:false}),input:1,output:1,estimated:false,elapsedMs:1};}});
  const runtime=new ReadingRuntime(engine,{available:true,async request<T>(method,payload){
    if(method==='readingSources')return [{id:'qidian',installed:true}] as T;
    if(method==='startCapture')captureToken=(payload as {captureToken:string}).captureToken;
    return {} as T;
  }});
  try{
    await runtime.startCapture(book.id,'qidian');
    await runtime.receive('observation',{captureToken,sourceId:'qidian',kind:'body',coverage:'continuous-page',text:page+'\n'+noisyTail});
    assert.ok(covers(book.known,{start:page.length,end:book.text.indexOf(tail)}));
    assert.ok(JSON.stringify(requests).includes('OCR-MISSED-IN-FRAME'));
    const boundary=book.position;assert.ok(boundary<=book.text.indexOf(skipped));
    await runtime.receive('observation',{captureToken,sourceId:'qidian',kind:'body',coverage:'continuous-page',text:later});
    assert.equal(covers(book.known,{start:boundary,end:book.text.indexOf(later)}),false);
    assert.equal(JSON.stringify(requests).includes('SEPARATE-UNSEEN-CHAPTER'),false);
    assert.equal(JSON.stringify(requests).includes('UNSEEN-FUTURE'),false);
  }finally{runtime.dispose();}
});
