import {requireMemoryText,hydrateMemoryBodies} from '../core/memory-bodies.ts';
import {prepareMemoryRecovery} from '../core/memory-recovery.ts';
// Fixed debug fixture: the real Engine, Harness, NativeChannel and disk store.
// The debug service supplies responses locally; this fixture cannot use a key.
import { hostRequest } from './environment-access.ts';
import { NativeStore } from './store.ts';
import { ReadingEngine } from '../core/engine.ts';
import { HarnessRuntime } from '../agent/runtime.ts';
import { ChatModel } from '../core/model.ts';
import { initialState } from '../core/state.ts';
import { importBook, covers } from '../core/books.ts';
import { workspaceFor, workspaceMaterial } from '../core/companion-workspace.ts';
import { recoverInterruptedState } from '../core/startup.ts';
import type { State, Store } from '../core/types.ts';

const originalUnderstanding = '  \r\n'+'工程记录：设备校准已完成，复测仍在进行，移交条件尚待核对。'.repeat(120)+'\r\n  ';
const jsonBrief='  工程简报：复测后仍需核对移交条件。\r\n  ',jsonReply='\r\n工程阅读记录继续保留。  ',jsonThread='  工程关注：移交条件仍需接续核对。\r\n  ';
const completeUnderstanding=[jsonBrief,jsonReply,originalUnderstanding,jsonThread].join('\n\n');
const backgroundUnderstanding='后台阶段认识：校准完成，复测仍在进行。';
const backgroundRaw=JSON.stringify({text:backgroundUnderstanding});
const freshUnderstanding='  \r\n'+'工程第三段看法：复测仍在进行，移交记录需独立核对。'.repeat(80)+'\r\n  ';
const freshReaction='复测仍在进行，移交记录继续核对。';
const freshRaw=JSON.stringify({text:freshUnderstanding}),freshReactionRaw=JSON.stringify({text:freshReaction});
// An old typed proposal is not exposed to companion automatic reading. Even
// when a supplier sends it, the independent finish body remains the result.
const checkpointEnvelope=(target:string)=>JSON.stringify({readingBrief:jsonBrief,reply:jsonReply,thoughts:[
  {kind:'opinion',text:originalUnderstanding,updates:target,updateReason:'工程结构提议应整体丢弃'},
  {kind:'thread',text:jsonThread,answersPartOf:target}
],stateUpdates:[{stateChangeOf:target,status:'ended',text:'STRUCTURE-ONLY-NOT-READING-TEXT'}],entityRoots:[{name:'STRUCTURE-ONLY-NOT-WORLD-ENTITY'}],reasoning_content:'PRIVATE-JSON-REASONING-NOT-READING-TEXT'});
const natural = (content:string) => ({ status: 200, body: { choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 11, completion_tokens: 7 } } });
const reading=(text:string,proposal?:string,reaction?:string)=>({status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:'ENGINE READING META: 本包说明不能替代独立阅读正文。',tool_calls:[
  {id:'final-reading',type:'function',function:{name:'finish_reading',arguments:JSON.stringify({text})}},
  ...(proposal===undefined?[]:[{id:'optional-reading-proposal',type:'function',function:{name:'submit_reading',arguments:proposal}}]),
  ...(reaction===undefined?[]:[{id:'short-reading-reaction',type:'function',function:{name:'react_to_reading',arguments:JSON.stringify({text:reaction})}}])
]}}],usage:{prompt_tokens:11,completion_tokens:7}}});
const answer = () => ({ status: 200, body: { choices: [{ finish_reason: 'tool_calls', message: { content: '当前工程复测仍在进行。',tool_calls:[{id:'final-conversation',type:'function',function:{name:'submit_reading',arguments:JSON.stringify({reply:'ENGINE PLACEHOLDER',thoughts:[],wantsLong:false})}}] } }], usage: { prompt_tokens: 11, completion_tokens: 7 } } });
function check(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
function checkEngineeringChats(state:State,hasReaction:boolean){
  const users=state.chats.filter(c=>c.role==='user'),answers=state.chats.filter(c=>c.role==='assistant'&&c.replyTo),automatic=state.chats.filter(c=>c.role==='assistant'&&!c.replyTo);
  check(users.length===2&&answers.length===2&&answers.every(c=>c.text==='当前工程复测仍在进行。'&&users.some(u=>u.id===c.replyTo)), '两次实际问答未按原问题接续，或被占位替换');
  check(automatic.length===(hasReaction?1:0)&&automatic.every(c=>c.text===freshReaction), '主动反应丢失、重复或产生伪用户发言');
  check(!state.memories.some(m=>m.kind==='shared'||m.kind==='user'), '自动阅读制造共同交流或用户认识');
}
async function until(predicate: () => boolean | Promise<boolean>, stage: string) {
  const deadline = Date.now() + 8000;
  while (!await predicate()) { if (Date.now() > deadline) throw Error('工程阶段超时：' + stage); await new Promise(resolve => setTimeout(resolve, 20)); }
}
async function pending(hold: string) { await until(async () => !!(await hostRequest<Record<string, unknown>>('companionMockStatus'))[hold], hold); }
const release = (hold: string) => hostRequest('releaseCompanionMock', { hold });

async function correctionProbe(nativeStore: NativeStore) {
  const state=initialState(),book=await importBook('更正接续原生工程资料',Array.from({length:5},(_,i)=>`第${['一','二','三','四','五'][i]}章 工程\n${i===4?'UNREAD-CORRECTION-PROBE':('工程记录'+i+'。').repeat(750)}\n`).join(''));
  state.books=[book];book.readingStrategy='companion';book.narrativeMode='legacy';
  Object.assign(state.settings,{tokenLimit:3000000,defaultQuiet:true,minReadChars:1});state.settings.services[0].enabled=true;
  const bodies=['工程看法一：设备A，早期条件仍需核对。','工程看法二：早期条件接续，中段MIDDLE独立保留。','工程看法三：中段MIDDLE与晚段LATEST同时保留。','工程恢复：设备B，早期条件、中段MIDDLE与晚段LATEST继续保留。','工程第四轮：完整恢复稿接续，加入第四段实际进展。'];
  const packets:string[]=[];let requests=0;
  const model=new ChatModel(async (request,signal)=>{
    const packet=JSON.stringify(request.body);check(!packet.includes('UNREAD-CORRECTION-PROBE'),'更正恢复暴露未读第五段');packets.push(packet);
    const body=bodies[requests++];check(body,'更正探测发生额外派发');
    return hostRequest('model',{...request,companionProbe:{response:natural(body),hold:''}},signal);
  });
  const harness=new HarnessRuntime(),engine=new ReadingEngine(state,nativeStore,model);engine.agent=harness;
  let firstId='',latestId='';
  try {
    book.known=[{start:0,end:book.chapters[0].end}];book.position=book.chapters[0].end;await engine.startReading(book.id);
    for(let i=0;i<3;i++){book.known=[{start:0,end:book.chapters[i].end}];book.position=book.chapters[i].end;await engine.prepare(book.id);latestId=workspaceFor(state,book).understandingId!;if(i===0)firstId=latestId;}
    await engine.correctMemory(firstId,'工程更正：设备改为B，早期条件继续保留。');
    check(!workspaceMaterial(state,book).understanding,'更正后旧完整看法仍被当作当前来源');
    const pending=await nativeStore.load();check(pending?.companionCorrectionRepairs?.[0].status==='pending'&&pending.companionCorrectionRepairs[0].oldDraft?.text===bodies[2],'完整待修稿没有落原生磁盘');
  } finally {engine.stop();await harness.dispose();}
  const cold=await nativeStore.load();check(cold,'冷恢复状态缺失');recoverInterruptedState(cold);
  const coldHarness=new HarnessRuntime(),coldEngine=new ReadingEngine(cold,nativeStore,model);coldEngine.agent=coldHarness;
  try {
    const restored=cold.books[0];await coldEngine.startReading(restored.id);
    restored.known=[{start:0,end:restored.chapters[3].end}];restored.position=restored.chapters[3].end;await coldEngine.prepare(restored.id);
    check(requests===5&&packets[3].includes('待修订旧稿')&&packets[3].includes('MIDDLE')&&packets[3].includes('LATEST')&&packets[3].includes('设备改为B'),'冷恢复未先修复完整旧认识');
    check(packets[4].includes(bodies[3]),'新段没有接到完整修复稿');
    check(cold.companionCorrectionRepairs?.[0].status==='complete'&&!cold.companionCorrectionRepairs[0].oldDraft,'恢复状态或旧稿清除未完成');
    check(workspaceMaterial(cold,restored).understanding?.text===bodies[4],'新段完整看法未接回当前工作台');
    check(!!cold.memories.find(m=>m.id===latestId)?.invalidatedBy,'失效旧稿被重新授予当前来源权');
    await coldEngine.persist();const disk=await nativeStore.load();check(disk?.memories.some(m=>m.text===bodies[4])&&disk.companionCorrectionRepairs?.[0].status==='complete','接续结果没有落原生磁盘');
    return{probe:'companion-correction',ok:true,requests,coldPendingRestored:true,repairBeforeNewSegment:true,fullUnderstandingPreserved:true,oldDraftNotCurrent:true,unreadDenied:true,nativeDiskSaved:true};
  } finally {coldEngine.stop();await coldHarness.dispose();}
}

async function probe() {
  const config = await hostRequest<{ companionResume: boolean; companionCorrection?: boolean }>('probeConfig');
  const nativeStore = new NativeStore(hostRequest);
  if(config.companionCorrection)return correctionProbe(nativeStore);
  if (config.companionResume) {
    const saved = await nativeStore.load(); check(saved, '原生检查点缺失');
    const draft = saved.readingDrafts?.[0]; check(draft?.association === 'ready', '完整原草稿缺失');
    check(draft.material.outputProtocol==='reading-text-v1'&&draft.delivery?.protocol==='reading-text-v1'&&draft.delivery.proposal==='rejected', '独立阅读协议与附加提议拒绝状态未存入原草稿');
    const oldUsage = JSON.stringify(saved.usage), calls = { count: 0 };
    await prepareMemoryRecovery(saved,nativeStore);recoverInterruptedState(saved);
    const engine = new ReadingEngine(saved, nativeStore, new ChatModel(async () => { calls.count++; throw Error('冷启动不得重派已收到原问'); }));
    const coldShown:string[]=[];engine.onReaction=text=>coldShown.push(text);
    const harness = new HarnessRuntime(); engine.agent = harness;
    try {
      await engine.startReading(saved.books[0].id); await engine.prepare(saved.books[0].id);
      check(calls.count === 0 && JSON.stringify(saved.usage) === oldUsage, '接续重发或改写了原用量');
      check(saved.readings?.filter(r => r.draftId === draft.id).length === 1, '原草稿未精确消费');
      const record=saved.readings!.find(r=>r.draftId===draft.id)!;check(record.delivery?.protocol==='reading-text-v1'&&record.delivery.proposal==='rejected','冷接续丢失附加提议拒绝状态');
      check(saved.memories.some(m => m.text === completeUnderstanding), '完整理解在重启中丢失');
      check(!saved.readingDrafts?.length && !saved.companionReadingReceipts?.length, '原候选仍留在待办');
      await hydrateMemoryBodies(nativeStore,saved.memories);const w = workspaceFor(saved, saved.books[0]);
      check(saved.memories.find(m => m.id === w.understandingId)?.text === completeUnderstanding, '新段完整理解未接回当前工作台');
      check(saved.memories.every(m=>m.kind==='opinion'&&!m.correctionOf&&!m.replacedBy&&!m.answersPartOf&&!m.stateProjection&&!m.arcProjection)&&!saved.entityRoots?.length, '坏类型JSON执行了结构操作');
      check(saved.memories.some(m => m.historicalOnly && requireMemoryText(m).includes('后台阶段认识')), '之前的后台历史在重启中丢失');
      checkEngineeringChats(saved,true);check(coldShown.length===0,'冷接续补发了过时主动反应');check(saved.memories.some(m=>m.kind==='opinion'&&m.text===freshUnderstanding),'实际第三段完整看法在冷接续中丢失');
      await engine.persist();
      await hydrateMemoryBodies(nativeStore,saved.memories);check(!saved.memories.some(m=>requireMemoryText(m).includes('ENGINE READING META')),'工具说明被保存为认识');
      return { probe: 'companion-resume', ok: true, zeroRedispatch: true, readingTextExit:true,readingTextByteExact:true,delivery:record.delivery,structuralProposalsDiscarded:true,finalProsePreserved:true,fullUnderstandingPreserved: true, currentUnderstandingRestored: true, earlierHistoryPreserved: true, freshReactionPreserved:true,noColdReaction:true,chats: saved.chats.length, consumedDraftId: draft.id };
    } finally { engine.stop(); await harness.dispose(); }
  }

  const state = initialState(), book = await importBook('持续伴读原生工程资料', '第一章 登记\n设备校准尚待完成。\n第二章 复测\n设备校准已完成，正在进行复测。\n第三章 条件核对\n复测仍在进行，移交记录须核对。\n第四章 移交\n复测后仍需核对移交条件。\n第五章 未读\nUNREAD-NATIVE-COMPANION');
  state.books = [book]; book.position = book.chapters[0].end; book.known = [{ start: 0, end: book.position }]; book.prepared = [];
  state.settings.services[0].enabled = true; state.settings.tokenLimit = 3000000; state.settings.minReadChars = 1;state.settings.minReactionMs=0; state.settings.defaultQuiet = true;
  let stage = 'seed', requests = 0, failedCommit = false, receiptSaved = false, checkpointRaw='',checkpointProposal='',checkpointChannelsSaved=false,freshChannelsSaved=false;
  const store: Store = { load: () => nativeStore.load(), async save(s: State) {
    if (stage === 'checkpoint' && s.readings?.some(r => r.ranges.some(x => x.end > book.chapters[2].end))) { failedCommit = true; throw Error('工程中断：原草稿已存，最终提交前停止'); }
    // Capture the identity in this save's snapshot before awaiting I/O. Seed
    // preparation receipts, or a mutable state changed during an earlier save,
    // cannot satisfy the later interruption's durable-receipt barrier.
    const backgroundReceipt=stage==='interruption'?s.companionReadingReceipts?.find(r=>r.bookId===book.id&&r.request.source==='reading'&&r.candidate.format==='reading-text'&&r.candidate.text===backgroundRaw):undefined;
    const checkpointReceipt=stage==='checkpoint'&&checkpointRaw?s.companionReadingReceipts?.find(r=>r.candidate.text===checkpointRaw):undefined;
    const freshReceipt=stage==='fresh'?s.companionReadingReceipts?.find(r=>r.candidate.text===freshRaw):undefined;
    await nativeStore.save(s);
    if(backgroundReceipt)receiptSaved=true;
    if(freshReceipt){const rawDisk=await nativeStore.load();check(rawDisk?.companionReadingReceipts?.some(r=>r.id===freshReceipt.id&&r.material.outputReactionAllowed===true&&r.candidate.format==='reading-text'&&r.candidate.text===freshRaw&&r.candidate.reaction===freshReactionRaw)&&rawDisk.usage.some(u=>u.id===freshReceipt.id&&u.status==='complete'),'独立正文和短反应原渠道未真实落盘');freshChannelsSaved=true;}
    if(checkpointReceipt){const rawDisk=await nativeStore.load();check(rawDisk?.companionReadingReceipts?.some(r=>r.id===checkpointReceipt.id&&r.material.outputProtocol==='reading-text-v1'&&r.candidate.format==='reading-text'&&r.candidate.text===checkpointRaw&&r.candidate.proposal===checkpointProposal)&&rawDisk.usage.some(u=>u.id===checkpointReceipt.id&&u.status==='complete'), '独立主出口及附加原参数与实际用量未先存Android磁盘');checkpointChannelsSaved=true;}
  } };
  const model = new ChatModel(async (request, signal) => {
    requests++; check(!JSON.stringify(request.body).includes('UNREAD-NATIVE-COMPANION'), '未读资料进入原生模型');
    const packets = (request.body.messages as { role: string; content: string }[]).filter(m => m.role === 'user').flatMap(m => m.content.split('\n\n')).flatMap(text => { try { return [JSON.parse(text)]; } catch { return []; } });
    const conversation = packets.find(p => p.task === 'conversation');
    const hold = stage === 'interruption' ? conversation ? conversation.userText.includes('第一问') ? 'first' : 'second' : 'background' : '';
    if(!conversation){const names=(request.body.tools as {function:{name:string}}[]).map(t=>t.function.name);check(names.includes('finish_reading')&&!names.includes('submit_reading'),'伴读自动阅读没有直接主出口，或仍暴露旧附加提交');check(names.includes('react_to_reading')===(stage==='fresh'),'主动反应工具未按实际非安静跟读开放');}
    if(stage==='checkpoint'){checkpointRaw=JSON.stringify({text:completeUnderstanding});checkpointProposal=checkpointEnvelope(workspaceFor(state,book).understandingId!);}
    const response = conversation ? answer() : stage==='seed'?natural('初始工程认识：校准尚待完成。'):stage==='checkpoint'?reading(completeUnderstanding,checkpointProposal):stage==='fresh'?reading(freshUnderstanding,undefined,freshReaction):reading(backgroundUnderstanding);
    return hostRequest('model', { ...request, companionProbe: { response, hold } }, signal);
  });
  const engine = new ReadingEngine(state, store, model), harness = new HarnessRuntime(); engine.agent = harness;
  const shown:string[]=[];engine.onReaction=text=>shown.push(text);
  try {
    await engine.startReading(book.id); await engine.prepare(book.id);
    check(engine.session?.readingStrategy === 'companion', '默认正式入口未进入持续伴读');
    const initialId = workspaceFor(state, book).understandingId; check(initialId, '完整当前理解缺失');
    stage = 'interruption'; engine.observing(true); const page = book.chapters[1];
    const reading = engine.observe(book.id, book.text.slice(page.start, page.end), 'body', 'continuous-page'); void reading.catch(() => {});
    await pending('background'); const first = engine.ask(book.id, '第一问：核对当前工程。'); void first.catch(() => {}); await pending('first');
    const second = engine.ask(book.id, '第二问：核对移交条件。'); void second.catch(() => {});
    await release('background'); await until(() => receiptSaved, '后台原答持久化');
    check(state.memories.length === 1 && state.chats.every(c => c.role !== 'assistant'), '前台未结束却提交后台原答');
    check(engine.busy, '原生后台任务被丢弃'); const rawId = state.companionReadingReceipts![0].id;
    const rawDisk=await nativeStore.load(),raw=rawDisk?.companionReadingReceipts?.find(r=>r.id===rawId);check(raw?.material.outputProtocol==='reading-text-v1'&&raw.candidate.format==='reading-text'&&raw.candidate.text===backgroundRaw&&raw.candidate.proposal===undefined,'后台独立主出口身份与实际正文未原样落盘');
    await release('first'); await first; await pending('second');
    check(state.companionReadingReceipts?.[0].id === rawId && state.memories.length === 1, '第二前台尚未结束却推进后台');
    await release('second'); await second; await reading;
    check(workspaceFor(state, book).understandingId === initialId, '插话后旧后台覆盖当前理解');
    check(state.memories.some(m => m.historicalOnly && requireMemoryText(m).includes('后台阶段认识')), '后台原答未保存为可回查历史');
    check(covers(book.prepared, page) && state.chats.filter(c => c.role === 'assistant').length === 2, '插话后未完成原段或交流重复');
    checkEngineeringChats(state,false);check(Number(shown.length)===0,'安静跟读或旧后台发送了反应');
    check((await hostRequest<{ cancels: number }>('companionMockStatus')).cancels === 0, '插话取消了已发原生请求');
    stage='fresh';engine.quiet(false);engine.observing(true);const fresh=book.chapters[2];await engine.observe(book.id,book.text.slice(fresh.start,fresh.end),'body','continuous-page');
    check(freshChannelsSaved&&shown.length===1&&shown[0]===freshReaction,'新的非安静真实跟读未通过onReaction送达');checkEngineeringChats(state,true);
    check(state.memories.some(m=>m.kind==='opinion'&&m.text===freshUnderstanding)&&state.memories.find(m=>m.id===workspaceFor(state,book).understandingId)?.text===freshUnderstanding,'短反应替代或截断了独立完整看法');
    stage = 'checkpoint';engine.quiet(true);const next = book.chapters[3];
    let failure: unknown; try { await engine.observe(book.id, book.text.slice(next.start, next.end), 'body', 'continuous-page'); } catch (error) { failure = error; }
    check(failedCommit && failure && state.readingDrafts?.[0]?.association === 'ready', '最终提交前未留下可恢复草稿');
    const disk = await nativeStore.load(); check(disk?.readingDrafts?.[0]?.id === state.readingDrafts[0].id, '草稿未实际写入Android磁盘');
    const result=disk.readingDrafts![0].result;
    check(checkpointChannelsSaved&&result.thoughts.length===1&&result.thoughts[0].kind==='opinion'&&result.thoughts[0].text===completeUnderstanding, '独立主正文未逐字存入原草稿');
    const draft=disk.readingDrafts![0];check(draft.material.outputProtocol==='reading-text-v1'&&draft.delivery?.protocol==='reading-text-v1'&&draft.delivery.proposal==='rejected','未开放附加提交未整体拒绝或没有保存交付状态');
    check(result.reply===''&&!result.readingBrief&&!result.stateUpdates&&!result.entityRoots&&!result.thoughts[0].updates&&!result.thoughts[0].answersPartOf&&state.memories.find(m=>m.id===initialId)?.replacedBy===undefined, '坏类型JSON结构提议未整体丢弃');
    check(shown.length===1,'安静保存中断又发送了反应');checkEngineeringChats(state,true);
    return { probe: 'companion-interruption', ok: true, requests, readingTextExit:true,originalChannelsSaved:true,readingTextByteExact:true,delivery:draft.delivery,structuralProposalsDiscarded:true,finalProseReceived:true,freshReactionDelivered:true,freshReactionChannelsSaved:true,freshOpinionByteExact:true,shownReaction:shown[0],assistantChats:state.chats.filter(c=>c.role==='assistant').length,savedRawId: rawId, checkpointDraftId: state.readingDrafts[0].id, foregroundPriority: true, originalResponseSaved: true, foregroundBarrier: true, historicalOnly: true, nativeDiskCheckpoint: true };
  } finally { engine.stop(); await harness.dispose(); }
}
void probe().then(result => hostRequest('report', result), error => hostRequest('report', { probe: 'companion', ok: false, error: String(error)+'\n'+String(error?.stack ?? '') }));
