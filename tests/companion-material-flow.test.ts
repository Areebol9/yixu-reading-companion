import test from 'node:test';
import assert from 'node:assert/strict';
import {ReadingEngine} from '../src/core/engine.ts';
import {ChatModel} from '../src/core/model.ts';
import {HarnessRuntime} from '../src/agent/runtime.ts';
import {initialState} from '../src/core/state.ts';
import {importBook,covers} from '../src/core/books.ts';
import {evidence} from '../src/core/context.ts';
import {hashText} from '../src/core/text-hash.ts';
import {restoreBackup} from '../src/core/backup.ts';
import type {Book,Memory,MemoryBody,MemoryBodyRef,State,Store} from '../src/core/types.ts';

const packets=(body:any)=>body.messages.filter((m:any)=>m.role==='user').flatMap((m:any)=>m.content.split('\n\n')).flatMap((text:string)=>{try{return[JSON.parse(text)];}catch{return[];}});
const main=(body:any)=>packets(body).find((p:any)=>p.currentRange)!;
const natural=(content:string)=>({status:200,body:{choices:[{finish_reason:'stop',message:{content}}],usage:{prompt_tokens:19,completion_tokens:11}}});
const tool=(name:string,args:unknown)=>({status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:'material-flow-call',type:'function',function:{name,arguments:JSON.stringify(args)}}]}}],usage:{prompt_tokens:19,completion_tokens:11}}});
const provided=(packet:any)=>[...(packet.memories??[]),...(packet.workspaceMaterial?.working??[]),...(packet.workspaceMaterial?.understanding?[packet.workspaceMaterial.understanding]:[])];
const firstP=(packet:any)=>/【(p[1-9]\d*)】/.exec(packet.current)?.[1];

async function fixture(respond:(body:any)=>Promise<any>|any,setup?:(state:State,book:Book,bodies:Map<string,MemoryBody>)=>Promise<void>|void){
  const state=initialState(),book=await importBook('伴读材料流工程资料','第一章 登记\n备用电源需要稳定供电，原有维护条件继续保留。\n第二章 补充\n祈求可离线保存；检修阶段结束后仍需保留旅行愿望。\n第三章 总况\n现场正在复测，旧记录待按主题核对。\n第四章 未读\nFORBIDDEN-MATERIAL-FLOW');
  book.readingStrategy='companion';book.known=[{start:0,end:book.chapters[0].end}];book.prepared=structuredClone(book.known);book.position=book.chapters[0].end;state.books=[book];
  state.settings.services[0].enabled=true;state.settings.services[0].contextLimit=200000;state.settings.tokenLimit=3000000;state.settings.minReadChars=1;state.settings.defaultQuiet=true;
  const bodies=new Map<string,MemoryBody>(),bodyReads:string[]=[];await setup?.(state,book,bodies);
  let disk=structuredClone(state);const requests:any[]=[];
  const store:Store={async load(){return structuredClone(disk);},async save(s){disk=structuredClone(s);},async readMemoryBodies(refs){return refs.flatMap(ref=>{bodyReads.push(ref.key);const body=bodies.get(ref.key);return body?[structuredClone(body)]:[];});}};
  const model=new ChatModel(async request=>{requests.push(request);assert.equal(JSON.stringify(request.body).includes('FORBIDDEN-MATERIAL-FLOW'),false);return respond(request.body);});
  const engine=new ReadingEngine(state,store,model),runtime=new HarnessRuntime();engine.agent=runtime;await engine.startReading(book.id);
  return{state,book,engine,runtime,store,requests,bodyReads,bodies,get disk(){return structuredClone(disk);},async close(){engine.stop();await runtime.dispose();}};
}
function memory(state:State,book:Book,id:string,text:string,stage=book.chapters[0]):Memory{
  return{id,bookId:book.id,partnerId:state.partnerId,kind:'opinion',text,evidence:[evidence(book,{start:0,end:stage.end})],readingStage:[{start:stage.start,end:stage.end}],parents:[],chatIds:[],createdAt:stage.start+1,source:'reading',forgotten:false};
}
async function cold(state:State,book:Book,bodies:Map<string,MemoryBody>,id:string,text:string,stage=book.chapters[0]):Promise<Memory>{
  const hash=await hashText(text),key='memory-body-'+hash;bodies.set(key,{key,hash,text});
  return{...memory(state,book,id,text,stage),text:undefined,bodyRef:{key,hash,chars:text.length}};
}

test('正式阅读finish_reading局部接续旧全文，未触愿望和条件逐字保留且出处随备份恢复',async()=>{
  const oldText='  旅行愿望：人物甲希望旅行，仍拒绝危险。🌱\r\n\r\n条件：祈求保存方式尚未知。\n\n维护条件：备用电源须稳定供电。  ';
  let alias='',p='';const f=await fixture(body=>{
    const packet=main(body),old=provided(packet).find((m:any)=>m.text===oldText);assert.ok(old,'真实首包须给出旧完整正文');alias=old.id;p=firstP(packet)!;assert.ok(p);
    return tool('finish_reading',{documents:[{operation:'revise',updates:alias,updateReason:'本段明确离线保存，原愿望和供电条件继续保留。',edits:[{oldText:'条件：祈求保存方式尚未知。',newText:'条件：祈求可离线保存。',sourceIds:[p]}]}],working:['t1']});
  },async(state,book,bodies)=>{state.memories=[await cold(state,book,bodies,'prior-reading',oldText)];state.companionWorkspaces=[{bookId:book.id,version:book.version,partnerId:state.partnerId,source:'reading',revision:0,workingIds:[],focusIds:[],updatedAt:1}];});
  try{
    f.engine.observing(true);const next=f.book.chapters[1];await f.engine.observe(f.book.id,f.book.text.slice(next.start,next.end),'body','continuous-page');
    const old=f.state.memories.find(m=>m.id==='prior-reading')!,made=f.state.memories.find(m=>m.documentRevision)!;
    assert.ok(made);assert.equal(old.text??f.bodies.get(old.bodyRef!.key)?.text,oldText);assert.equal(old.replacedBy,made.id);
    assert.equal(made.text,oldText.replace('条件：祈求保存方式尚未知。','条件：祈求可离线保存。'));
    assert.equal(made.revisionKind,'development');assert.ok(made.parents.includes(old.id));assert.equal(made.documentRevision?.previousId,old.id);
    const changed=made.documentRevision!.changes[0];assert.ok(changed.sourceEvidence.length);assert.ok(changed.sourceEvidence.every(e=>e.start>=next.start&&e.end<=next.end));
    assert.ok(covers(f.book.prepared,next));assert.equal(f.requests.length,1);assert.equal(f.state.chats.length,0);
    const restored=await restoreBackup(JSON.stringify(f.disk),initialState(),f.store);assert.deepEqual(restored.memories.find(m=>m.id===made.id)?.documentRevision,made.documentRevision);assert.equal(restored.memories.find(m=>m.id===made.id)?.text,made.text);
  }finally{await f.close();}
});

test('overview在同一Harness先选m/p和query，实际冷旧稿与真实后继入工具历史后才自然答',async()=>{
  let stage=0,oldAlias='',currentAlias='',p='';let initialIds:string[]=[];
  const f=await fixture(body=>{
    const packet=main(body);
    if(stage++===0){
      assert.deepEqual(body.tools.map((t:any)=>t.function.name),['prepare_answer']);
      initialIds=provided(packet).map((m:any)=>m.id);currentAlias=provided(packet)[0].id;p=firstP(packet)!;
      const old=packet.memoryCoverage.items.find((m:any)=>m.title==='隐患旅程甲早期');assert.ok(old);oldAlias=old.id;assert.ok(!initialIds.includes(oldAlias));
      assert.equal(body.messages.filter((m:any)=>m.role==='tool').length,0);
      return tool('prepare_answer',{aspects:[{need:'跨阶段接续维护条件与人物愿望',memoryIds:[oldAlias,currentAlias],sourceIds:[p],query:'隐患旅程甲'}]});
    }
    const history=body.messages.filter((m:any)=>m.role==='tool').map((m:any)=>m.content).join('\n');
    assert.ok(history.includes('COLD-OLD-FULL-END'),'冷旧稿须真正取回');assert.ok(history.includes('COLD-NEXT-FULL-END'),'真实后继须真正取回');
    assert.ok(history.includes('认识的接续'));assert.equal(f.state.memories.length,3,'prepare_answer不得写长期记忆');
    assert.equal(f.state.chats.filter(c=>c.role==='assistant').length,0);return natural('早期愿望仍保留，保存方式已由后续记录说明；供电条件继续适用。');
  },async(state,book,bodies)=>{
    const end=book.chapters[2].end;book.known=[{start:0,end}];book.prepared=structuredClone(book.known);book.position=end;
    const current=memory(state,book,'current-full',('现阶段维护记录。'+'当前巡视情况。'.repeat(2000)).slice(0,12000),book.chapters[2]);
    const old=await cold(state,book,bodies,'cold-old','隐患旅程甲希望旅行，也坚持稳定供电。\n'+'早期认识。'.repeat(700)+'COLD-OLD-FULL-END');old.documentTitle='隐患旅程甲早期';
    const next=await cold(state,book,bodies,'cold-next','隐患旅程甲仍希望旅行，祈求可离线保存。\n'+'后来认识。'.repeat(700)+'COLD-NEXT-FULL-END',book.chapters[1]);next.documentTitle='隐患旅程甲接续';next.correctionOf=old.id;next.revisionKind='development';next.revisionReason='后文说明保存方式，保留早期愿望。';next.parents=[old.id];old.replacedBy=next.id;
    state.memories=[current,old,next];state.companionWorkspaces=[{bookId:book.id,version:book.version,partnerId:state.partnerId,source:'reading',revision:0,workingIds:[current.id],focusIds:[],updatedAt:1}];
  });
  try{
    await f.engine.ask(f.book.id,'综合工程各阶段的愿望、条件和当前进展。',true,undefined,{scope:'overview'});
    assert.equal(f.requests.length,2);assert.equal(f.state.memories.length,3);assert.ok(f.bodyReads.length>0);
    const question=f.state.chats.find(c=>c.role==='user')!;assert.equal(question.answerScope,'overview');
    assert.equal(f.state.usage.length,2);assert.ok(f.state.usage.every(u=>u.questionId===question.id&&u.status==='complete'));
    assert.equal(f.state.chats.filter(c=>c.role==='assistant').length,1);assert.ok(f.state.chats.at(-1)?.memoryIds?.includes('cold-old'));assert.ok(f.state.chats.at(-1)?.memoryIds?.includes('cold-next'));
  }finally{await f.close();}
});

test('当前段落感受短问通过真实Harness一次自然回应，整体一词不强制跨阶段准备',async()=>{
  const f=await fixture(body=>{assert.ok(body.tools.some((t:any)=>t.function.name!=='prepare_answer'));return natural('备用电源需要稳定供电。');});
  try{await f.engine.ask(f.book.id,'这段整体感觉怎么样？');assert.equal(f.requests.length,1);assert.equal(f.state.memories.length,0);assert.equal(f.state.chats.at(-1)?.text,'备用电源需要稳定供电。');assert.equal(f.state.chats[0].answerScope,'focused');assert.equal(f.state.usage.length,1);}finally{await f.close();}
});

test('prepare_answer拒绝未给p，反馈后沿同一题改用实际p，不写伪来源或长期记忆',async()=>{
  let stage=0,p='',feedback='';const f=await fixture(body=>{
    if(stage++===0){p=firstP(main(body))!;assert.ok(p);return tool('prepare_answer',{aspects:[{need:'核对原文条件',sourceIds:['p99999']}]});}
    if(stage===2){feedback=body.messages.filter((m:any)=>m.role==='tool').map((m:any)=>m.content).join('\n');return tool('prepare_answer',{aspects:[{need:'核对原文条件',sourceIds:[p]}]});}
    return natural('本段原文明确备用电源需要稳定供电。');
  });
  try{await f.engine.ask(f.book.id,'整体核对工程条件。',true,undefined,{scope:'overview'});assert.match(feedback,/本轮|实际|未提供|出处/);assert.equal(f.requests.length,3);assert.equal(f.state.memories.length,0);const question=f.state.chats[0];assert.ok(f.state.usage.every(u=>u.questionId===question.id&&u.status==='complete'));assert.equal(f.state.chats.filter(c=>c.role==='assistant').length,1);assert.equal(JSON.stringify(f.state.chats.at(-1)?.evidence).includes('99999'),false);}finally{await f.close();}
});
