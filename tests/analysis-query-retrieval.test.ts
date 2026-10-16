import test from 'node:test';
import assert from 'node:assert/strict';
import {AnalysisCore} from '../src/core/analysis-core.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import {ChatModel} from '../src/core/model.ts';
import {HarnessRuntime} from '../src/agent/runtime.ts';
import {initialState} from '../src/core/state.ts';
import {ModelRequestError} from '../src/core/errors.ts';
import {evidence} from '../src/core/context.ts';
import {analysisCandidatePool,searchMemories} from '../src/core/recall.ts';
import {selectAnalysisMaterials} from '../src/core/analysis-materials.ts';
import {bindWorldPlan,MissingWorldIdentityBindingsError} from '../src/core/world-identity.ts';
import type {Memory,Store} from '../src/core/types.ts';

const empty={memoryIds:[],chatIds:[]};
const response=(name:string,args:unknown)=>({status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:'query-retrieval-mock',type:'function',function:{name,arguments:JSON.stringify(args)}}]}}],usage:{prompt_tokens:0,completion_tokens:0}}});
const packet=(body:any)=>JSON.parse(body.messages.find((m:any)=>m.role==='user'&&m.content.startsWith('{')).content.split('\n\n')[0]);
const pages=(body:any)=>body.messages.filter((m:any)=>m.role==='tool').flatMap((m:any)=>{try{return(JSON.parse(m.content).results??[]).flatMap((r:any)=>{try{return[JSON.parse(r.text)];}catch{return[];}});}catch{return[];}}).filter((p:any)=>Array.isArray(p.items));

test('ENGINE MOCK问题取材同池：完整条件回查、当前修订和阶段、原文、答复保存与身份权限',async()=>{
  const state=initialState();state.settings.services[0].enabled=true;state.settings.tokenLimit=2_000_000;
  let disk=structuredClone(state),phase='seed',first:{start:number;end:number};
  const store:Store={async load(){return structuredClone(disk);},async save(s){disk=structuredClone(s);}};
  const condition='ENGINE MOCK：保管仍以完整验收为条件，每月检查和延期并不解除条件。'+'验收约束逐项保持。'.repeat(60);
  const transport='ENGINE MOCK：运输延期，交接签收仍未完成；验收与保管条件独立。'+'运输登记条件完整保持。'.repeat(60);
  const stageText='ENGINE MOCK：保管验收和运输登记经过。'+'登记过程按顺序保留，验收和延期同时记录。'.repeat(38);
  const model=new ChatModel(async request=>{
    const body=request.body,p=packet(body);assert.equal(JSON.stringify(body).includes('UNREAD-RETRIEVAL'),false);
    if(phase==='seed')return response('submit_reading',{
      stageNarrative:{text:stageText,sourceIds:['p1'],basis:empty},
      thoughts:[{kind:'story',text:'ENGINE MOCK：运输签收记录需核对。',sourceIds:['p1'],basis:empty},{kind:'story',text:'ENGINE MOCK：登记人甲员，原始姓名声明。'+'姓名声明详细登记。'.repeat(100),identityClaim:{type:'name',entityId:'new1',name:'甲员',cognition:'observed'},sourceIds:['p1'],basis:empty}],entityRoots:[{key:'new1',memoryId:'t2'}],
      stateUpdates:[{topic:'保管验收',basis:empty,operations:[{op:'add',text:condition,sourceIds:['p1']}]},{topic:'运输登记',basis:empty,operations:[{op:'add',text:transport,sourceIds:['p1']}]}],
      arcUpdates:[{label:'保管运输待核线',basis:empty,operations:[{op:'add',role:'condition',memoryId:'t1'}]}]
    });
    const navigation=[...(p.analysisMaterials??[]),...(p.analysisIndex?.items??[])];
    for(const kind of ['stage','state'])assert.ok(navigation.some((m:any)=>m.kind===kind),'结构正文或可执行入口须实际到达首包');
    assert.ok(p.analysisIndex.items.some((m:any)=>m.kind==='arc'&&m.availability==='needs-review'));
    assert.equal((p.analysisMaterials??[]).some((m:any)=>m.kind==='arc'),false,'停用旧arc仅作待核入口');
    if(phase==='interrupted')throw new ModelRequestError('ENGINE MOCK问题待接续','not-dispatched');
    const got=pages(body),last=got.at(-1);
    if(!last||last.nextOffset!==undefined)return response('recall_memory',{query:'保管 验收 运输 登记',...(last?{offset:last.nextOffset}:{})});
    const items=got.flatMap((page:any)=>page.items);
    assert.ok(items.some((m:any)=>m.kind==='stage'&&m.text===stageText));
    const a=items.find((m:any)=>m.kind==='state'&&m.stateProjection?.topic==='保管验收'),b=items.find((m:any)=>m.kind==='state'&&m.stateProjection?.topic==='运输登记');
    assert.ok(a&&b);assert.equal(a.text,condition+'ENGINE MOCK修订：须由签收人确认。');assert.equal(b.text,transport);assert.equal(items.some((m:any)=>m.kind==='arc'),false);
    if(!body.messages.some((m:any)=>m.role==='tool'&&m.content.includes('原文登记警告')))return response('read_original',first);
    return response('submit_reading',{reply:'ENGINE MOCK：依据完整原文和两个当前状态，延期没有解除每月检查、完整验收和签收确认的保管条件。',replyBasis:{memoryIds:[a.id,b.id,items.find((m:any)=>m.kind==='stage').id],chatIds:[]},thoughts:[],reinforce:[]});
  });
  const harness=new HarnessRuntime(),engine=new ReadingEngine(state,store,model);engine.agent=harness;const core=new AnalysisCore(engine);
  try{
    const id=await core.importText('ENGINE MOCK问题取材工程','第一章 登记\nENGINE MOCK：甲员登记。原文登记警告：每月检查，完整验收和签收确认前仍保管。运输延期。\n'+'无关登记背景。'.repeat(2800)+'\n第二章 当前\nENGINE MOCK：现在运输延期，仍需核对早期条件。\n第三章 未读\nUNREAD-RETRIEVAL'),book=engine.book(id);
    first={start:book.chapters[0].start,end:book.chapters[0].start+120};await core.grant(id,[{start:book.chapters[0].start,end:book.chapters[0].end}]);await core.configure(id,{arcCandidate:'v1',worldCandidate:'v1'});await core.analyze(id,[first]);
    const original=state.memories.find(m=>m.stateProjection?.topic==='保管验收')!,source=state.memories.find(m=>m.kind==='story'&&!m.identityClaim)!,name=state.memories.find(m=>m.identityClaim)!,arc=state.memories.find(m=>m.kind==='arc')!;
    await core.correctMemory(original.id,condition+'ENGINE MOCK修订：须由签收人确认。');await core.correctMemory(source.id,'ENGINE MOCK：签收记录的原理解需要重新核对。');assert.ok(arc.invalidatedBy);
    await core.grant(id,[{start:book.chapters[1].start,end:book.chapters[1].end}]);
    const query='保管 验收 运输 登记 甲员',picked=await core.queryMaterials(id,query);assert.ok(picked.chars<=3000);assert.equal(picked.records.some(m=>m.id===original.id),false);
    phase='query';const before=state.memories.length;await core.query(id,query,{memoryAllowed:false,long:true});assert.equal(state.memories.length,before);
    const answer=state.chats.find(c=>c.role==='assistant')!;assert.ok(answer.text.includes('签收确认'));assert.ok(answer.basis?.memoryIds.length===3);assert.ok(answer.evidence.some(e=>e.start<=first.start&&e.end>=first.end));
    phase='interrupted';await assert.rejects(core.query(id,query,{memoryAllowed:false,long:true}),/问题待接续/);
    const pending=state.chats.filter(c=>c.role==='user').at(-1)!;
    const restored=await AnalysisCore.fromBackup(await core.backup(),store,model,{agent:harness});
    try{
      await restored.engine.editState(s=>{s.settings.services[0].enabled=true;});
      await restored.engine.setReadingMode(id,'stages');
      const s=restored.engine.state,pool=analysisCandidatePool(s,restored.engine.book(id),{source:'conversation',arcCandidate:'v1'});
      assert.equal(pool.all.some(m=>m.id===original.id||m.id===arc.id),false);assert.ok(pool.states.some(m=>m.correctionOf===original.id));assert.equal(s.chats.find(c=>c.id===answer.id)!.text,answer.text);
      // Hand retry uses current settings and still takes the actual analysis pool.
      phase='query';await restored.engine.retryQuestion(pending.id);assert.equal(s.memories.length,before);
    }finally{restored.engine.stop();}

    // Directory identities are navigation; only the actual full-name retrieval grants binding.
    const directory=selectAnalysisMaterials(state,book,{source:'conversation',query,queryMode:true,worldCandidate:'v1',arcCandidate:'v1',budget:1400,chats:[]});
    assert.equal(directory.records.some(m=>m.id===name.id),false);assert.ok(directory.entityIndex?.items.some(e=>e.id===name.identityClaim!.entityId),JSON.stringify({index:directory.index,chars:directory.chars,entities:directory.entityIndex}));
    const added:Memory={...structuredClone(name),id:'engine-mock-world-write',text:'ENGINE MOCK：甲员核对运输登记。',about:[{entityId:name.identityClaim!.entityId}]};delete added.identityClaim;delete added.entityBindings;
    assert.throws(()=>bindWorldPlan(state,book,[added],new Map(),[],directory.records.map(m=>m.id),[evidence(book,first)],'conversation'),MissingWorldIdentityBindingsError);
    const full=searchMemories(state,book,{ids:[name.id]},[],'conversation');bindWorldPlan(state,book,[added],new Map(),[],full.items.map(m=>m.id),[evidence(book,first)],'conversation');assert.deepEqual(added.entityBindings,[{entityId:name.identityClaim!.entityId,memoryId:name.id}]);
    const automatic=selectAnalysisMaterials(state,book,{source:'preparation',focusRanges:[first],worldCandidate:'v1',budget:1800});assert.ok(automatic.records.some(m=>m.id===name.id),'自动新读仍预供完整姓名');

    // Out-of-scope matches cannot affect counts or no-kind pages; ordinary legacy background stays compatible.
    const scoped=structuredClone(state),base=structuredClone(name),future=evidence(book,{start:book.chapters[2].start,end:book.chapters[2].end});
    scoped.memories.push(...[{...base,id:'future',evidence:[future],sourceEvidence:[future]},{...base,id:'foreign-book',bookId:'other-book'},{...base,id:'foreign-partner',partnerId:'other-partner'},{...base,id:'background',source:'background' as const,identityClaim:undefined,entityBindings:undefined}]);
    const current=searchMemories(state,book,{},[],'conversation','structured',{analysis:true,arcCandidate:'v1'}),protectedPage=searchMemories(scoped,book,{},[],'conversation','structured',{analysis:true,arcCandidate:'v1'});assert.equal(protectedPage.total,current.total);assert.deepEqual(protectedPage.items.map(m=>m.id),current.items.map(m=>m.id));
    assert.equal(searchMemories(scoped,book,{},[],'conversation','full-original',{analysis:true,arcCandidate:'v1'}).items.some(m=>['stage','state'].includes(m.kind)&&m.source!=='correction'),false);
  }finally{engine.stop();await engine.persist();await harness.dispose();}
});
