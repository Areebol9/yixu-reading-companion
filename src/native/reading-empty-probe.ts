// Two local supplier responses exercise QuickJS Harness reawakening and native disk.
import { hostRequest } from './environment-access.ts';
import { NativeStore } from './store.ts';
import { ReadingEngine } from '../core/engine.ts';
import { HarnessRuntime } from '../agent/runtime.ts';
import { ChatModel } from '../core/model.ts';
import { initialState } from '../core/state.ts';
import { importBook, covers } from '../core/books.ts';
import { workspaceFor } from '../core/companion-workspace.ts';
import type { Store } from '../core/types.ts';
const body='  \r\n'+'工程完整记录：校准已完成，复测仍在进行，移交条件待核对。'.repeat(75)+'\r\n  ';
const raw=JSON.stringify({text:body});
function check(value:unknown,message:string):asserts value {if(!value)throw Error(message);}
async function probe(){
  const store=new NativeStore(hostRequest),state=initialState(),book=await importBook('原生缺正文续交工程资料','第一章 登记\n设备已登记，校准尚待完成。\n第二章 复测\n校准已完成，复测仍在进行。\n第三章 未读\nUNREAD-NATIVE-EMPTY');
  state.books=[book];book.readingStrategy='companion';book.known=[{start:0,end:book.chapters[0].end}];book.prepared=structuredClone(book.known);book.position=book.chapters[0].end;
  state.settings.services[0].enabled=true;state.settings.tokenLimit=3000000;state.settings.defaultQuiet=true;state.settings.minReadChars=1;
  let firstUsageSaved=false,rawSaved=false,requests=0;
  const diskStore:Store={load:()=>store.load(),async save(s){await store.save(s);if(s.usage.length===1&&s.usage[0].status==='complete'){const disk=await store.load();check(disk?.usage[0]?.status==='complete'&&disk.usage[0].input===11&&disk.usage[0].output===7,'空答实际用量未先写原生磁盘');firstUsageSaved=true;}const receipt=s.companionReadingReceipts?.find(r=>r.candidate.format==='reading-text'&&r.candidate.text===raw);if(receipt){const disk=await store.load();check(disk?.companionReadingReceipts?.some(r=>r.id===receipt.id&&r.material.outputProtocol==='reading-text-v1'&&r.candidate.text===raw),'续交原正文渠道未先落盘');rawSaved=true;}}};
  const model=new ChatModel(async(request,signal)=>{
    requests++;check(requests<=2,'额外派发了第三次固定响应');check(!JSON.stringify(request.body).includes('UNREAD-NATIVE-EMPTY'),'未读范围进入请求');
    const tools=(request.body.tools as {function:{name:string}}[]).map(t=>t.function.name);check(tools.includes('finish_reading')&&!tools.includes('react_to_reading'),'安静阅读出口错误');
    if(requests===2){check(firstUsageSaved,'续交早于原空答结算');check((request.body.messages as {role:string}[]).filter(m=>m.role==='user').length>=2,'未在原Harness任务中增加完成反馈');}
    const response=requests===1?{status:200,body:{choices:[{finish_reason:'stop',message:{content:'',reasoning_content:'PRIVATE EMPTY NATIVE REASONING'}}],usage:{prompt_tokens:11,completion_tokens:7}}}:{status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:'ENGINE META CANNOT BECOME READING',tool_calls:[{id:'reading-empty-finish',type:'function',function:{name:'finish_reading',arguments:raw}}]}}],usage:{prompt_tokens:11,completion_tokens:7}}};
    return hostRequest('model',{...request,companionProbe:{response}},signal);
  });
  const engine=new ReadingEngine(state,diskStore,model),runtime=new HarnessRuntime(),shown:string[]=[];engine.agent=runtime;engine.onReaction=text=>shown.push(text);
  try{
    await engine.startReading(book.id);engine.observing(true);const page=book.chapters[1];await engine.observe(book.id,book.text.slice(page.start,page.end),'body','continuous-page');
    const disk=await store.load();check(disk&&requests===2&&firstUsageSaved&&rawSaved,'原生续交未完成');
    check(disk.usage.length===2&&disk.usage.every(u=>u.status==='complete'&&u.dispatchState==='response-received'&&u.input===11&&u.output===7&&!u.estimated)&&disk.usage[0].id!==disk.usage[1].id&&disk.usage[0].requestKey===disk.usage[1].requestKey,'原任务两笔实际用量未完整保存');
    check(disk.memories.length===1&&disk.memories[0].kind==='opinion'&&disk.memories[0].text===body&&disk.memories[0].id===workspaceFor(disk,disk.books[0]).understandingId,'完整正文未逐字保存一次并接当前理解');
    check(disk.readings?.length===1&&disk.readings[0].draftId===disk.usage[1].id&&covers(disk.books[0].prepared,page),'原段未正确完成');check(disk.chats.length===0&&shown.length===0,'续交反馈制造读者发言或旧反应');check(!JSON.stringify(disk).includes('PRIVATE EMPTY NATIVE REASONING'),'推理被冒充正文');
    return{probe:'reading-empty-continuation',ok:true,requests,firstUsageSaved,rawSaved,sameTask:true,twoUsageComplete:true,bodyByteExact:true,singleOpinion:true,noChats:true,noReaction:true,usageIds:disk.usage.map(u=>u.id),readingDraftId:disk.readings[0].draftId,bodyLength:body.length};
  }finally{engine.stop();await runtime.dispose();}
}
void probe().then(result=>hostRequest('report',result),error=>hostRequest('report',{probe:'reading-empty-continuation',ok:false,error:String(error)+'\n'+String(error?.stack??'')}));
