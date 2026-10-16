import { hostRequest } from './environment.ts';
import { ReadingEngine } from '../core/engine.ts';
import { ReadingRuntime, restoreReadingEngine } from '../core/runtime.ts';
import type { RuntimeHost } from '../core/runtime.ts';
import { ChatModel } from '../core/model.ts';
import { LocalApplication } from '../core/application.ts';
import { NativeStore } from './store.ts';
import { initialState } from '../core/state.ts';
import { bookLength, importBook, normalize } from '../core/books.ts';
import type { ModelMessage, ModelPort } from '../core/types.ts';
import { probeTitle, probePage, probeText, probeSentinel, unicodeFixture, largeProbeText } from './probe-fixture.ts';
import { hashText } from '../core/text-hash.ts';
import { publicWebUrl } from '../core/web.ts';
import { pageText } from '../core/page-text.ts';
import { validateMigration } from '../core/migration.ts';
import { correctMemory,currentQuestion, evidence, usableMemories } from '../core/context.ts';
import {selectReadingBrief} from '../core/reading-brief.ts';
import {HarnessFactReviewer} from '../agent/fact-reviewer.ts';
import type { Memory } from '../core/types.ts';

function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function packet(reply = '', thoughts: unknown[] = [], lookup?: string) { return { content: JSON.stringify({ reply, thoughts, wantsLong: false, lookup }), input: 10, output: 10, estimated: false, elapsedMs: 1 }; }
async function probe() {
  check(typeof window === 'undefined' && typeof document === 'undefined', 'Browser globals unexpectedly available');
  const config = await hostRequest<{ realModel: boolean; largeCharacters?: number }>('probeConfig');
  const unicodeHash = await hashText(unicodeFixture);
  check(new URL('https://EXAMPLE.org:443/a/../资料').href === 'https://example.org/%E8%B5%84%E6%96%99', 'URL normalization differs');
  for (const url of ['https://zh.wikipedia.org./a', 'https://127.1/a', 'https://user:pass@example.org/']) {
    let denied = false; try { publicWebUrl(url); } catch { denied = true; } check(denied, 'Excluded web origin accepted');
  }
  const html = pageText('https://example.org/', '<head><title>工程 &amp; 检查</title></head><nav>导航</nav><article><p>设备&#65;X</p><script>执行代码</script><p>3件</p></article>');
  check(html.title === '工程 & 检查' && html.extract.includes('设备AX') && !/执行代码|导航/.test(html.extract), 'Native HTML extraction failed');
  const unicodeBytes = Array.from(new TextEncoder().encode(unicodeFixture));
  const state = initialState(), book = await importBook(probeTitle, probeText);
  book.position = book.text.indexOf(probePage); book.known = [{ start: 0, end: book.position }]; book.prepared = [...book.known]; state.books = [book]; state.settings.services[0].enabled = true; state.settings.minReadChars = 1; state.settings.minReactionMs = 0;
  state.settings.services[0].effort = 'medium'; state.settings.services[0].maxOutput = 2048; state.settings.tokenLimit = 40000;
  const store = new NativeStore(hostRequest);
  let entered!: () => void; const inFlight = new Promise<void>(resolve => entered = resolve);
  const calls: string[] = [], hostCalls: string[] = []; let askedForText = false, cancelled = false, captureToken = '';
  const traces: { task: string; elapsedMs?: number; status?: string; input?: number; output?: number; reply?: string; questionDelayMs?: number }[] = [];
  let questionAt = 0;
  const remote = new ChatModel((request, signal) => hostRequest('model', request, signal));
  const model: ModelPort = { async complete(service, messages, signal) {
    check(!JSON.stringify(messages).includes(probeSentinel), 'Unseen text reached model');
    const task = messages.flatMap(m => { try { return [JSON.parse(m.content)]; } catch { return []; } }).find(m => m.task)?.task;
    calls.push(task);
    if (config.realModel) {
      const began = performance.now(), trace = { task, questionDelayMs: task === 'conversation' ? Math.round(began - questionAt) : undefined } as typeof traces[number]; traces.push(trace);
      if (calls.length === 1) entered();
      try {
        const response = await remote.complete(service, messages, signal);
        Object.assign(trace, { status: 'complete', elapsedMs: Math.round(performance.now() - began), input: response.input, output: response.output });
        try { trace.reply = JSON.parse(response.content).reply; } catch {}
        return response;
      } catch (error) {
        Object.assign(trace, { status: signal.aborted ? 'cancelled' : 'failed', elapsedMs: Math.round(performance.now() - began) });
        if (signal.aborted) cancelled = true;
        throw error;
      }
    }
    if (calls.length === 1) {
      entered();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 30000);
        signal.addEventListener('abort', () => { cancelled = true; clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
      throw new Error('Reading was not preempted');
    }
    await new Promise(resolve => setTimeout(resolve, 15)); signal.throwIfAborted();
    if (task === 'conversation' && !askedForText) { askedForText = true; return packet('', [], '设备AX'); }
    return task === 'conversation' ? packet('工程登记为3件，编号001。', [{ kind: 'story', text: '设备AX登记3件，编号001。' }]) : packet('', [{ kind: 'opinion', text: '本条工程记录的数量与编号已经核对。' }]);
  } };
  const engine = new ReadingEngine(state, store, model), runtime = new ReadingRuntime(engine, { available: true, async request<T>(method: Parameters<RuntimeHost['request']>[0], payload: any) {
    hostCalls.push(method);
    if (method === 'readingSources') return [{ id: 'engineering', installed: true }] as T;
    if (method === 'startCapture') captureToken = payload.captureToken;
    return {} as T;
  } });
  const application = new LocalApplication(runtime, hostRequest);
  await application.command('startCapture', book.id, 'engineering');
  const reading = runtime.receive('observation', { captureToken, sourceId: 'engineering', kind: 'body', text: probePage }); void reading.catch(() => {});
  await inFlight;
  if (config.realModel) await new Promise(resolve => setTimeout(resolve, 500));
  questionAt = performance.now();
  await Promise.all([reading, application.command('ask', book.id, '核对当前设备的数量和编号。')]);
  check(cancelled, 'Cancellation did not propagate');
  if (!config.realModel) check(calls.join(',') === 'reading,conversation,conversation,reading', 'Unexpected task/tool order');
  else check(calls[0] === 'reading' && calls[1] === 'conversation' && calls.at(-1) === 'reading', 'Question was not prioritized');
  check(state.usage[0].status === 'unknown', 'Cancelled reservation was lost');
  check(state.chats.length === 2 && state.chats[0].delivery === 'answered', 'Question did not complete exactly once');
  if (!config.realModel) check(state.memories.length >= 1, 'No understanding was committed');
  check(normalize(book.prepared.map(r => book.text.slice(r.start, r.end)).join('')).includes(normalize(probePage)), 'Interrupted text was not resumed');
  const commandSnapshot = application.snapshot;
  check(!('text' in commandSnapshot.state.books[0]), 'Original text entered UI snapshot');
  const readonlySnapshot = !Reflect.set(commandSnapshot.state.books[0], 'position', 0);
  check(readonlySnapshot && book.position > 0 && commandSnapshot.state.books[0].position === book.position, 'UI changed authoritative reading position');
  await application.command('renameConversation', engine.session!.id, '工程核对记录');
  await application.command('updateLimits', { costLimit: 2 });
  check(application.snapshot.state.conversations[0].manualTitle, 'Command did not persist manual title');
  let largeImport: { characters: number; elapsedMs: number; version: string; heap: unknown; reloadMs?: number } | undefined;
  if (config.largeCharacters) {
    const began = performance.now();
    const added = await application.command('importText', '工程规模资料', largeProbeText(config.largeCharacters));
    const imported = engine.book(added.bookId);
    check(bookLength(imported) === config.largeCharacters && imported.known.length === 0, 'Large import altered reading permission');
    largeImport = { characters: bookLength(imported), elapsedMs: Math.round(performance.now() - began), version: imported.version, heap: await hostRequest('probeHeap') };
  }
  runtime.dispose(); await engine.persist();
  let invalidKeyRejected = false, mismatchedTextRejected = false, inlineTextRejected = false;
  try { await hostRequest('putBookText', { version: '../outside', text: probeText }); } catch { invalidKeyRejected = true; }
  try { await hostRequest('putBookText', { version: '0'.repeat(64), text: probeText }); } catch { mismatchedTextRejected = true; }
  try { await hostRequest('saveState', state); } catch { inlineTextRejected = true; }
  check(invalidKeyRejected && mismatchedTextRejected && inlineTextRejected, 'Native storage accepted invalid text data');
  const completedCalls = calls.length;
  const reloadBegan = performance.now(), restored = await restoreReadingEngine(store, model);
  check(restored.engine.state.books.every(b => b.text === '' && bookLength(b) > 0), 'Startup materialized original books');
  if (largeImport) {
    largeImport.reloadMs = Math.round(performance.now() - reloadBegan);
    const imported = restored.engine.state.books.find(b => b.version === largeImport!.version);
    check(!!imported, 'Large original metadata missing');
    await restored.engine.withOriginal(imported.id, original => check(original.text === largeProbeText(largeImport!.characters), 'Large original did not survive native reload'));
  }
  check(restored.engine.state.chats.length === 2 && restored.engine.state.books[0].title === probeTitle, 'Native storage round trip failed');
  check(restored.engine.session === undefined && calls.length === completedCalls, 'Startup invoked work automatically');
  check(restored.engine.state.settings.costBudgetId === state.settings.costBudgetId, 'Budget identity changed during persistence');
  const migrated = await validateMigration(JSON.parse(await application.command('exportBackup', false)));
  check(migrated.state.books[0].version === book.version && migrated.state.chats.length === state.chats.length && migrated.state.settings.services[0].enabled === state.settings.services[0].enabled, 'Migration validation lost data or configuration');
  let draftCheckpoint: {reused:boolean;generations:number;privateInCore:boolean}|undefined;
  let correctionRecovery:{sourceInputsPreserved:boolean;earlierPreserved:boolean;descendantsRetired:boolean;saved:boolean}|undefined;
  let sourceRevalidation:{calls:number;factRestored:boolean;briefRestored:boolean;parentPreserved:boolean;viewPreserved:boolean;currentPointer:boolean;wrongRelationRemoved:boolean;sourceResume:boolean;saved:boolean}|undefined;
  if(!config.realModel&&!config.largeCharacters){
    // The native probe has its own store/process. Production reader data and
    // services are not touched by this interrupted-save exercise.
    const pendingState=restored.engine.state,pendingBook=pendingState.books[0],marker='原生草稿保存工程记录';
    // This stage uses only a fixed local model. The earlier budget test left a
    // monetary cap, so give this fixture explicit zero prices instead of making
    // an unpriced request or changing the production application's settings.
    pendingState.settings.services.forEach(service=>{service.inputPrice=0;service.outputPrice=0;});
    pendingBook.prepared=[];let generated=0,failFinal=true;
    const localModel:ModelPort={async complete(){generated++;return packet('',[{kind:'story',text:marker}]);}};
    const interrupted=new ReadingEngine(pendingState,{load:()=>store.load(),readBookText:version=>store.readBookText(version),async save(s){
      if(failFinal&&s.memories.some(m=>m.text===marker))throw new Error('Expected native checkpoint interruption');
      await store.save(s);
    }},localModel);
    await interrupted.startReading(pendingBook.id);let stopped=false,checkpointError='';
    try{await interrupted.prepare(pendingBook.id);}catch(error){checkpointError=String(error);stopped=checkpointError.includes('Expected native checkpoint interruption');}
    check(stopped&&pendingState.readingDrafts?.length===1&&generated===1,`Completed understanding was not checkpointed: ${checkpointError}; generated=${generated}; drafts=${pendingState.readingDrafts?.length}`);
    const pendingRuntime=new ReadingRuntime(interrupted,{available:false,async request(){throw Error('Unexpected device request');}}),pendingApp=new LocalApplication(pendingRuntime,hostRequest);
    const privateInCore=!('readingDrafts' in pendingApp.snapshot.state);
    pendingRuntime.dispose();await interrupted.persist();failFinal=false;
    const cold=await restoreReadingEngine(new NativeStore(hostRequest),localModel);
    check(cold.engine.state.readingDrafts?.length===1&&cold.engine.state.books[0].text==='','Native lazy reload lost the draft');
    await cold.engine.startReading(pendingBook.id);await cold.engine.prepare(pendingBook.id);
    const reused=generated===1&&Number(cold.engine.state.readingDrafts?.length)===0&&cold.engine.state.memories.filter(m=>m.text===marker).length===1;
    check(reused&&privateInCore,'Native restore regenerated understanding or exposed its draft');cold.engine.stop();await cold.engine.persist();
    draftCheckpoint={reused,generations:generated,privateInCore};
    const migrationState=structuredClone(cold.engine.state),migrationBook=migrationState.books[0],refs=[evidence(migrationBook,migrationBook.known[0])];
    const topic='native-correction-history';migrationState.conversations.push({id:topic,bookId:migrationBook.id,title:'工程更正来源',manualTitle:false,start:refs[0].start,end:refs[0].end,createdAt:1,kind:'discussion'});
    const make=(id:string,text:string,createdAt:number,parents:string[],chatIds:string[]):Memory=>({id,text,createdAt,parents,chatIds,kind:'story',source:'reading',bookId:migrationBook.id,partnerId:migrationState.partnerId,evidence:refs,forgotten:false});
    const early=make('native-earlier','早期工程认识',1,[],['native-input']),late=make('native-late','后来的工程认识',3,[],['native-input','native-old-reply']),child=make('native-child','依据后来认识的判断',4,[late.id],[]);
    migrationState.memories.push(early,late,child);
    migrationState.chats.push({id:'native-input',bookId:migrationBook.id,sessionId:topic,role:'user',text:'早期工程输入',evidence:refs,createdAt:1,excluded:false},
      {id:'native-old-reply',bookId:migrationBook.id,sessionId:topic,role:'assistant',text:'早期工程回答',evidence:refs,createdAt:2,excluded:false,memoryIds:[early.id]},
      {id:'native-dependent-reply',bookId:migrationBook.id,sessionId:topic,role:'assistant',text:'依据后来认识的回答',evidence:refs,createdAt:5,excluded:false,memoryIds:[child.id]});
    const revision=correctMemory(migrationState,late.id,'后来的工程更正');
    early.invalidatedBy=revision.id;
    for(const id of ['native-input','native-old-reply'])migrationState.chats.find(c=>c.id===id)!.outdatedBy=revision.id;
    await store.save(migrationState);
    const repaired=await restoreReadingEngine(new NativeStore(hostRequest),localModel),after=await new NativeStore(hostRequest).load();
    correctionRecovery={sourceInputsPreserved:['native-input','native-old-reply'].every(id=>!repaired.engine.state.chats.find(c=>c.id===id)?.outdatedBy),
      earlierPreserved:!repaired.engine.state.memories.find(m=>m.id===early.id)?.invalidatedBy,
      descendantsRetired:repaired.engine.state.memories.find(m=>m.id===child.id)?.invalidatedBy===revision.id&&repaired.engine.state.chats.find(c=>c.id==='native-dependent-reply')?.outdatedBy===revision.id,
      saved:!!after&&!after.memories.find(m=>m.id===early.id)?.invalidatedBy&&!after.chats.find(c=>c.id==='native-input')?.outdatedBy};
    check(Object.values(correctionRecovery).every(Boolean),'Native correction migration lost source history or restored dependent claims');
    const reviewState=structuredClone(repaired.engine.state),reviewBook=reviewState.books[0],reviewChild=reviewState.memories.find(m=>m.id===child.id)!;
    reviewChild.text='工程登记设备AX为5件。';reviewChild.readingStage=refs.map(({start,end})=>({start,end}));
    const parent=make('native-open-question','设备AX数量及登记来源分别是什么？',2,[late.id],[]);parent.kind='question';parent.readingStage=reviewChild.readingStage;reviewState.memories.push(parent);
    reviewChild.answersPartOf=parent.id;reviewChild.parents.push(parent.id);
    const reviewBrief=make('native-review-brief','工程登记设备AX为5件，登记来源尚待核对。',4,[late.id],[]);
    reviewBrief.kind='context';reviewBrief.invalidatedBy=revision.id;reviewBrief.readingStage=reviewChild.readingStage;reviewState.memories.push(reviewBrief);
    const view=make('native-factual-view','我认为查明工程登记来源有助于追踪设备记录。',4,[late.id],[]);view.kind='opinion';view.readingStage=reviewChild.readingStage;reviewState.memories.push(view);
    const unrelatedQuestion=make('native-unrelated-question','设备AX登记来源与恢复期限分别是什么？',5,[],[]);unrelatedQuestion.kind='question';unrelatedQuestion.readingStage=reviewChild.readingStage;
    const wrongAnswer=make('native-wrong-answer','工程登记设备AX为3件。',6,[unrelatedQuestion.id],[]);wrongAnswer.answersPartOf=unrelatedQuestion.id;wrongAnswer.readingStage=reviewChild.readingStage;
    reviewState.memories.push(unrelatedQuestion,wrongAnswer);
    let reviewCalls=0;
    const reviewModel=new ChatModel(async request=>{
      reviewCalls++;const input=(request.body.messages as ModelMessage[]).filter(m=>m.role==='user').flatMap(m=>{try{return[JSON.parse(m.content)];}catch{return[];}}).find(p=>p.candidates);
      const source=input.sources.find((s:{text:string})=>s.text.includes('设备AX'));check(source,'Native review source is missing');
      const kind=input.candidates[0].kind;
      const text=kind==='context'?'工程登记设备AX为3件，登记来源尚待核对。':kind==='question'||kind==='opinion'?input.candidates[0].text:'工程登记设备AX为3件。';
      const args=JSON.stringify({items:[{id:'m0',text,sourceIds:[source.id],reason:'按固定工程原文核对数量。',...(input.candidates[0].partialQuestion?{answerRelation:input.candidates[0].partialQuestion.text.includes('数量')?'keep':'remove'}:{})}]}).slice(0,-1);
      return {status:200,body:{choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:'native-review-'+reviewCalls,type:'function',function:{name:'submit_review',arguments:args}}]}}],usage:{prompt_tokens:10,completion_tokens:10}}};
    });
    const reviewEngine=new ReadingEngine(reviewState,new NativeStore(hostRequest),reviewModel),reviewer=new HarnessFactReviewer();reviewEngine.factReviewer=reviewer;
    try{await reviewEngine.reviewFacts(reviewBook.id,reviewChild.id);await reviewEngine.reviewFacts(reviewBook.id,reviewBrief.id);
      await reviewEngine.reviewFacts(reviewBook.id,parent.id);await reviewEngine.reviewFacts(reviewBook.id,view.id);await reviewEngine.reviewFacts(reviewBook.id,wrongAnswer.id);await reviewEngine.persist();}
    finally{reviewEngine.stop();await reviewer.dispose();}
    const reviewedDisk=await new NativeStore(hostRequest).load(),fact=reviewState.memories.find(m=>m.id===reviewChild.replacedBy)!;
    const pendingFact={...fact,id:'native-source-resume',source:'reading' as const,reviewDisposition:undefined,reviewReason:undefined,parents:[],correctionOf:undefined,replacedBy:undefined};reviewState.memories.push(pendingFact);
    const interruptedEngine=new ReadingEngine(reviewState,new NativeStore(hostRequest),new ChatModel(async()=>{throw new Error('Fixed interruption before review submit');})),interruptedReviewer=new HarnessFactReviewer();interruptedEngine.factReviewer=interruptedReviewer;
    try{await interruptedEngine.reviewFacts(reviewBook.id,pendingFact.id);}catch{}finally{interruptedEngine.stop();await interruptedReviewer.dispose();}
    const interruptedDisk=await new NativeStore(hostRequest).load(),pendingTask=interruptedDisk?.tasks?.find(t=>t.items.some(i=>i.memoryId===pendingFact.id)),cache=pendingTask?.items[0].reviewSources;
    check(cache?.sources.length&&cache.sources.every(s=>!('text' in s)),'Native interrupted review did not save original-text coordinates');
    const resumedReview=await restoreReadingEngine(new NativeStore(hostRequest),reviewModel),resumedReviewer=new HarnessFactReviewer();resumedReview.engine.factReviewer=resumedReviewer;
    try{await resumedReview.engine.resumeFactReview(pendingTask!.id);}finally{resumedReview.engine.stop();await resumedReviewer.dispose();}
    const resumedDisk=await new NativeStore(hostRequest).load();
    sourceRevalidation={calls:reviewCalls,factRestored:usableMemories(reviewState,reviewBook).some(m=>m.id===fact.id)&&fact.text==='工程登记设备AX为3件。',
      briefRestored:selectReadingBrief(reviewState,reviewBook)?.text==='工程登记设备AX为3件，登记来源尚待核对。',
      parentPreserved:fact.answersPartOf===parent.id&&currentQuestion(reviewState,reviewBook,parent.id)?.text===parent.text&&currentQuestion(reviewState,reviewBook,parent.id)?.replacedBy===undefined,
      viewPreserved:usableMemories(reviewState,reviewBook).some(m=>m.id===view.replacedBy&&m.kind==='opinion'&&m.text===view.text),
      currentPointer:usableMemories(reviewState,reviewBook).find(m=>m.id===fact.id)?.answersPartOf===parent.replacedBy,
      wrongRelationRemoved:!!wrongAnswer.replacedBy&&usableMemories(reviewState,reviewBook).some(m=>m.id===wrongAnswer.replacedBy&&m.text===wrongAnswer.text&&!m.answersPartOf)&&currentQuestion(reviewState,reviewBook,unrelatedQuestion.id)?.text===unrelatedQuestion.text,
      sourceResume:pendingTask?.status==='interrupted'&&resumedDisk?.tasks?.find(t=>t.id===pendingTask.id)?.status==='complete'&&!resumedDisk.tasks.find(t=>t.id===pendingTask.id)!.items[0].reviewSources&&!!resumedDisk.memories.find(m=>m.id===pendingFact.id)?.replacedBy,
      saved:!!reviewedDisk&&reviewedDisk.memories.find(m=>m.id===fact.id)?.text===fact.text&&reviewedDisk.memories.some(m=>m.id===wrongAnswer.replacedBy&&m.text===wrongAnswer.text&&!m.answersPartOf)&&reviewedDisk.tasks?.filter(t=>t.items.some(i=>[reviewChild.id,reviewBrief.id,wrongAnswer.id].includes(i.memoryId))).every(t=>t.status==='complete')===true};
    check(reviewCalls===6&&Object.entries(sourceRevalidation).filter(([k])=>k!=='calls').every(([,v])=>v),'Native source revalidation lost facts, stage or parent question');
  }
  return { ok: true, browserGlobals: false, model: config.realModel ? 'authorized Tencent DeepSeek Flash medium; engineering material' : 'fixed engineering fixture; no network', calls, hostCalls, traces,
    draftCheckpoint,correctionRecovery,sourceRevalidation,
    invalidKeyRejected, mismatchedTextRejected, inlineTextRejected, readonlySnapshot, uiOriginalExcluded: !('text' in commandSnapshot.state.books[0]), applicationCommands: true, nativeUrlHtmlMigration: true,
    usage: state.usage.map(u => ({ purpose: u.purpose, status: u.status, input: u.input, output: u.output, estimated: u.estimated })),
    bookVersion: book.version, unicodeBytes, unicodeHash, largeImport, memoryCount: state.memories.length, storedChats: restored.engine.state.chats.length, cancelledReservation: state.usage[0].status };
}
void probe().then(result => __hostSend(JSON.stringify({ method: 'report', payload: result })), error => __hostSend(JSON.stringify({ method: 'report', payload: { ok: false, error: String(error) + '\n' + (error?.stack ?? '') } })));
