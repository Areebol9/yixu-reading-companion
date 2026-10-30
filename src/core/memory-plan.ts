import {bookVersionAllowsRange} from './book-versions.ts';
import {documentScope,memoryReadableByPartner,sameDocumentOwner} from './book-document-ownership.ts';
import {parseDocumentOrganization,inheritDocumentOrganization,mapDocumentOrganization,mergeDocumentOrganizations} from './document-organization.ts';
import {inheritKnowledgeDistribution} from './knowledge-distribution.ts';
import {requireMemoryText} from './memory-bodies.ts';
import {formationSources} from './formation-sources.ts';
import {bindDocumentRevision,documentSourceEvidence,prepareDocumentRevisions} from './document-revision.ts';
import {planArcMemories} from './arc-state.ts';
import {bindWorldPlan,prepareWorldReply,worldNote} from './world-identity.ts';
import {bookTextSlice,covers,id,mergeRanges,normalize} from './books.ts';
import {boundBasis} from './basis.ts';
import {parseNarrative} from './narrative.ts';
import {bindSemanticPlan,semanticNote,remapSemanticReferences,validateSemanticState} from './semantic-notes.ts';
import {historicalReadingBriefs,planReadingBrief} from './reading-brief.ts';
import {planNarrativeMemories} from './stage-state.ts';
import {chatAllowsMemory,currentQuestion,evidence,isBackgroundMemory,isCurrentMemory,isCurrentUnderstanding,isUsableSourceVersion,isEvidenceAllowed,matchSourceQuote,usableMemories} from './context.ts';
import type {Book,Evidence,Memory,NarrativeMode,Range,ReadingReply,ReadingStrategy,State,StateWriteVersion,WebReference} from './types.ts';

export type MemoryPlan = { added: Memory[]; reused: string[]; ids: string[]; result?:ReadingReply;formation?:{material:import('./types.ts').QueryMaterial;stamp:string};preparedWorkspace?:import('./types.ts').CompanionWorkspace; proposalMemoryIds?: Record<string,string>;entityRoots?:import('./types.ts').EntityRoot[]; briefId?: string; developments?: { previousId: string; nextId: string }[] };

/** Record only the task's original text that was actually supplied. Discussion
 * without original text has no invented reading stage. */
export function readingStageFor(task: Range[], supplied: Range[]): Range[] {
  return mergeRanges(task.flatMap(t => supplied.map(s => ({ start: Math.max(t.start,s.start), end: Math.min(t.end,s.end) })).filter(r=>r.end>r.start)));
}

export function canDevelopMemory(memory: Memory, source: Memory['source'] = 'reading'): boolean {
  return isCurrentMemory(memory) && (['opinion','question'].includes(memory.kind)||memory.kind==='user'&&source==='conversation'&&memory.source==='conversation') && memory.source!=='correction' &&
    (source === 'background' ? isBackgroundMemory(memory) : !isBackgroundMemory(memory)&&['preparation','reading','conversation','review'].includes(memory.source));
}
/** A new partial answer may continue another provided partial answer. Follow
 * only its actual one-hop link, with both records available in this task. Never
 * guess a question by text or turn a partial answer into a closing update. */
export function normalizeDevelopments(state: State, book: Book, result: ReadingReply, providedIds: string[], source: Memory['source'] = 'reading'): ReadingReply {
  return { ...result, thoughts: result.thoughts.map(thought => {
    if (!thought.answersPartOf || thought.updates) return thought;
    const prior = state.memories.find(m => m.id === thought.answersPartOf);
    if (!prior?.answersPartOf || !providedIds.includes(prior.id) || prior.bookId !== book.id || !memoryReadableByPartner(state,prior) ||
      !isCurrentMemory(prior) || !isEvidenceAllowed(book, prior.evidence) || (source === 'background') !== isBackgroundMemory(prior)) return thought;
    const question = currentQuestion(state,book,prior.answersPartOf);
    if (!question || question.kind !== 'question' || !providedIds.includes(question.id) || question.bookId !== book.id || !memoryReadableByPartner(state,question) ||
      !canDevelopMemory(question, source) || !isEvidenceAllowed(book, question.evidence)) return thought;
    return { ...thought, answersPartOf: question.id };
  }) };
}
export function validateDevelopments(state: State, book: Book, result: ReadingReply, providedIds: string[], source: Memory['source'] = 'reading',label:(id:string)=>string=id=>id): void {
  const seen = new Set<string>();
  for(const t of result.thoughts)if(t.documentOperation==='merge'&&!t.updates||t.documentOperation!=='merge'&&t.mergePreviousIds!==undefined)throw Error('认识归并须明确主前驱且额外前驱只用于merge');
  for (const thought of result.thoughts) if (thought.answersPartOf) {
    const question = state.memories.find(m=>m.id===thought.answersPartOf);
    if (thought.updates || !['story','opinion'].includes(thought.kind) || !question || question.kind !== 'question' ||
      question.bookId !== book.id || !memoryReadableByPartner(state,question) || !providedIds.includes(question.id) ||
      !canDevelopMemory(question,source) || !isEvidenceAllowed(book,question.evidence)) throw new Error(`部分答案目标${label(thought.answersPartOf)}无效：只能关联本轮已提供的未解疑问或其可用部分答案，不能同时关闭原问题。保留其他合法条目，只修正这一关联。`);
  }
  for (const thought of result.thoughts) if (thought.updates) {
    const prior=state.memories.find(memory=>memory.id===thought.updates);
    if(prior&&thought.scope!==undefined&&thought.scope!==documentScope(prior))throw Error('旧文档修订须保留原scope；私人记录须在原归属下继续维护');
    if(thought.documentOperation==='merge'){
      const ids=[thought.updates,...(thought.mergePreviousIds??[])];
      if(thought.kind!=='opinion'||!thought.text.trim()||!thought.updateReason?.trim()||!thought.mergePreviousIds?.length||new Set(ids).size!==ids.length||thought.edits!==undefined||thought.appendText!==undefined)throw Error('认识归并须完整新正文、原因及互异的多个当前opinion前驱');
      for(const id of ids){
        const previous=state.memories.find(m=>m.id===id);
        if(prior&&previous&&!sameDocumentOwner(prior,previous))throw Error('归并前驱须保持相同文档归属，书籍分析与私人相处记录分别维护');
        if(!previous||previous.kind!=='opinion'||previous.bookId!==book.id||!memoryReadableByPartner(state,previous)||!providedIds.includes(id)||!canDevelopMemory(previous,source)||!isEvidenceAllowed(book,previous.evidence)||seen.has(id))throw Error(`认识归并前驱${label(id)}须为本轮完整提供且仍有效的同书且当前可维护的opinion，每个前驱同包仅可使用一次`);
        requireMemoryText(previous);seen.add(id);
      }
      continue;
    }
    if(thought.mergePreviousIds!==undefined)throw Error('额外前驱只用于显式merge');
    const previous = state.memories.find(m => m.id === thought.updates);
    const unchanged = previous && thought.kind === previous.kind && normalize(thought.text) === normalize(requireMemoryText(previous));
    if (!previous || !providedIds.includes(previous.id) || previous.bookId !== book.id || !memoryReadableByPartner(state,previous) || !(thought.documentOperation==='restore'?previous.documentState==='retired'&&canDevelopMemory({...previous,documentState:undefined},source):canDevelopMemory(previous, source)) || !isEvidenceAllowed(book, previous.evidence) ||
      !unchanged && !['story','opinion'].includes(thought.kind)&&!(thought.kind==='user'&&previous.kind==='user'&&source==='conversation') || seen.has(previous.id) || !thought.updateReason?.trim()) {
      const parent=previous?.answersPartOf&&providedIds.includes(previous.id)&&providedIds.includes(previous.answersPartOf)?`它是${label(previous.answersPartOf)}的部分答案；新发现可用answersPartOf继续关联原问题，不能直接替换这条历史事实。`:'';
      throw new Error(`更新旧理解目标${label(thought.updates)}无效。${parent}只能更新本轮已提供且可更新的自身看法或疑问；每个目标本轮只更新一次，新的疑问请单独记录。保留其他合法条目，只修正这一条。`);
    }
    seen.add(previous.id);
  }
}

/** Prepare changes without publishing them; the host commits memory and reply together. */
export function planMemories(state: State, book: Book, result: ReadingReply, refs: Evidence[], parents: string[], chatIds: string[], source: Memory['source'], webSources?: WebReference[], habitIds: string[] = [], originalRanges: Range[] = [], passages: ReadonlyMap<string, NonNullable<Memory['sourceQuote']>> = new Map(), readingStage?: Range[], options: {readingStrategy?:ReadingStrategy;narrativeMode?:NarrativeMode;stateWriteVersion?:StateWriteVersion;arcCandidate?:'v1';worldCandidate?:'v1';historicalSourceIds?:readonly string[];freshOpinion?:true;documentScope?:'book'|'partner';formationSources?:import('./types.ts').FormationSources} = {}): MemoryPlan {
  if(chatIds.some(id=>{const chat=state.chats.find(c=>c.id===id);return chat&&!chatAllowsMemory(state,chat);}))throw Error('本次交流未允许长期采用，不能成为认识来源');
  const prepared=prepareDocumentRevisions(result,id=>parents.includes(id)?state.memories.find(m=>m.id===id):undefined);result=prepared.result;
  const documentSources={book,refs,originalRanges,passages};
  for(const thought of result.thoughts)if(thought.documentOperation){
    documentSourceEvidence([...(thought.sourceIds??[]),...(thought.quoteSource?[thought.quoteSource]:[]),...(thought.edits??[]).flatMap(edit=>edit.sourceIds??[])],documentSources);
    if(thought.basis&&!boundBasis(thought.basis,parents,chatIds,habitIds))throw Error('文档basis只可引用本轮完整取得的m/c/h来源，原答保持');
    if(['revise','organize','retire','restore'].includes(thought.documentOperation??'')){
      const old=state.memories.find(m=>m.id===thought.updates)!;
      if(!old.evidence.every(e=>e.bookId===book.id&&bookVersionAllowsRange(book,e.version,e)&&covers(refs,e)))throw Error('局部修订须保留本轮实际取得旧全文的完整来源范围，原答保持');
    }
  }
  for(const thought of result.thoughts)if(thought.documentOperation==='merge')for(const id of [thought.updates!,...(thought.mergePreviousIds??[])]){
    const old=state.memories.find(m=>m.id===id);
    if(!old||!old.evidence.every(e=>e.bookId===book.id&&bookVersionAllowsRange(book,e.version,e)&&covers(refs,e)))throw Error('认识归并须保留每个实际全文前驱的完整获准来源范围');
  }
  if(result.workspace!==undefined&&options.readingStrategy!=='companion')throw Error('当前任务未开放伴读工作台写入');
  for(const [index,thought] of result.thoughts.entries()){
    const full=thought.kind==='opinion';
    if(!full&&thought.text.length>1800)throw Error('理解正文超出当前任务允许长度');
  }
  if(result.arcUpdates!==undefined&&(options.arcCandidate!=='v1'||options.narrativeMode!=='stages'))throw Error('当前任务未开放弧线候选写入');
  const hasSemantic=result.thoughts.some(t=>t.temporal!==undefined||t.clue!==undefined);
  if(hasSemantic&&(options.worldCandidate!=='v1'||options.narrativeMode!=='stages'))throw Error('当前任务未开放有源时间与线索写入');
  const formationAudit=options.formationSources??formationSources(state,{memoryIds:parents,chatIds,habitIds,evidence:refs});
  const attachFormation=(memory:Memory)=>{
    memory.formationSources??=formationAudit;
    const bases=[...new Set([memory.correctionOf,memory.stateChangeOf,memory.arcChangeOf].filter((id):id is string=>!!id))];
    if(bases.length)memory.writeBaseIds=[...new Set([...(memory.writeBaseIds??[]),...bases])];
    const materialized=[...(memory.stageNarrative?.previousStageId?[memory.stageNarrative.previousStageId]:[]),...(memory.stateProjection?.parts??[]).flatMap(part=>part.memoryRef?[part.memoryRef.memoryId]:[]),...(memory.arcProjection?.parts??[]).flatMap(part=>[...(part.memoryRef?[part.memoryRef.memoryId]:[]),...(part.impact?[part.impact.targetVersionId]:[])])];
    memory.basis??={memoryIds:materialized,chatIds:[]};
    memory.parents=[...new Set([...memory.basis.memoryIds,...(memory.writeBaseIds??[]),...materialized])];
    memory.chatIds=[...memory.basis.chatIds];
    if(memory.basis.habitIds?.length)memory.habitIds=[...memory.basis.habitIds];
  };
  const plan: MemoryPlan = { added: [], reused: [], ids: [], developments: [],result };
  const world=prepareWorldReply(state,book,result,options.worldCandidate==='v1');result=world.reply;
  const proposalSources = new Map<string, Memory>();
  // Normalized reuse is still a successful proposal. Structural verbatim
  // references keep their stricter proposalSources contract below.
  const proposalBindings = new Map<string,string>();
  const semanticProposals=new Map<string,typeof result.thoughts[number]>();
  result = normalizeDevelopments(state, book, result, parents, source);
  validateDevelopments(state, book, result, parents, source);
  const historical=new Set(options.historicalSourceIds??[]);
  if([...historical].some(id=>!parents.includes(id)||!state.memories.some(m=>m.id===id&&m.bookId===book.id&&memoryReadableByPartner(state,m)&&isBackgroundMemory(m)===(source==='background')&&isUsableSourceVersion(state,m)&&isEvidenceAllowed(book,m.evidence)&&m.evidence.every(e=>covers(refs,e))))||result.thoughts.some(t=>[...(t.updates?[t.updates]:[]),...(t.mergePreviousIds??[])].some(id=>historical.has(id))))throw Error('历史资料仅可作为本轮实际完整来源，不能更新或恢复为当前记录');
  const eligible = usableMemories(state, book).filter(m=>typeof m.text==='string');
  const archivedBriefs=new Set(historicalReadingBriefs(state,book).map(m=>m.id));
  if (parents.some(id => state.memories.some(m => m.id === id && !archivedBriefs.has(id) && !historical.has(m.id) && !result.thoughts.some(t=>t.documentOperation==='restore'&&t.updates===m.id) && !isCurrentMemory(m) && !isCurrentUnderstanding(m, state.memories.find(next => next.id === m.replacedBy), book))) || chatIds.some(id => state.chats.some(c => c.id === id && (c.excluded || c.outdatedBy)))) {
    if(hasSemantic)throw Error('时间或线索候选的实际来源已失效，不能提交');
    if(options.worldCandidate&&(result.entityRoots?.length||result.thoughts.some(t=>Object.keys(worldNote(t)).length)))throw Error('本次主体来源未能成功形成，不能消费此候选提交');
    if (options.narrativeMode === 'stages' && result.stateUpdates?.some(u => u.operations?.some(op => /^t[1-9]\d*$/.test(op.memoryId ?? '')))) throw Error('本次事实来源未能成功形成，不能提交引用它的状态');
    plan.added.forEach(attachFormation);return plan;
  }
  for (const memoryId of result.reinforce ?? []) {
    if (parents.includes(memoryId) && eligible.some(m => m.id === memoryId&&!['context','stage','state','arc'].includes(m.kind))) plan.reused.push(memoryId);
  }
  for (const [index, thought] of result.thoughts.entries()) {
    const previousOwner=thought.updates?state.memories.find(memory=>memory.id===thought.updates):undefined;
    const scope=previousOwner?documentScope(previousOwner):['user','shared'].includes(thought.kind)?'partner':thought.scope??options.documentScope??'partner';
    if(thought.scope==='book'&&['user','shared'].includes(thought.kind))throw Error('用户认识与私人共同经历须保留为partner文档');
    const owner={bookId:book.id,partnerId:state.partnerId,scope,kind:thought.kind};
    const previousOrganization=thought.documentOperation==='merge'?mergeDocumentOrganizations([thought.updates!,...(thought.mergePreviousIds??[])].map(id=>state.memories.find(m=>m.id===id)?.organization)):thought.updates?state.memories.find(m=>m.id===thought.updates)?.organization:undefined;
    const organization=inheritDocumentOrganization(previousOrganization,parseDocumentOrganization(thought.organization));
    const semantic=thought.temporal!==undefined||thought.clue!==undefined;
    if (!thought.text.trim() || (thought.kind === 'shared' || thought.kind === 'user') && source !== 'conversation'||state.forgotten.some(f => f.bookId === book.id && normalize(thought.text).includes(normalize(f.text)))) {if(semantic||thought.documentOperation==='merge')throw Error('候选正文为空或包含已遗忘材料，拒绝整次候选');continue;}
    // Correction recovery must publish its own formation/withdrawal lineage, even
    // when the returned complete prose equals an earlier valid interpretation.
    const existing = !['revise','merge','organize','retire','restore'].includes(thought.documentOperation??'')&&!(options.freshOpinion&&thought.kind==='opinion')&&!semantic&&[...eligible,...plan.added].find(m => sameDocumentOwner(m,owner)&&!m.temporal&&!m.clue&&(!thought.updates || m.id === thought.updates) && m.answersPartOf === thought.answersPartOf && m.kind === thought.kind && (thought.kind==='opinion'?m.text===thought.text:normalize(requireMemoryText(m))===normalize(thought.text))&&(thought.organization===undefined&&!thought.updates||JSON.stringify(m.organization)===JSON.stringify(organization))&&(thought.knowledgeDistribution===undefined||JSON.stringify(m.knowledgeDistribution)===JSON.stringify(thought.knowledgeDistribution))&&JSON.stringify(worldNote(m))===JSON.stringify(worldNote(thought))&&JSON.stringify(m.narrative)===JSON.stringify(parseNarrative(thought.narrative,thought.kind)));
    if (existing) {
      proposalBindings.set(`t${index + 1}`,existing.id);
      if (existing.text === (thought.kind==='opinion'?thought.text:thought.text.trim())) proposalSources.set(`t${index + 1}`, existing);
      if (!plan.added.some(m => m.id === existing.id)) plan.reused.push(existing.id); continue;
    }
    const unique = mergeRanges(refs.filter(r => r.bookId === book.id && bookVersionAllowsRange(book,r.version,r))).map(r => evidence(book,r));
    if (!isEvidenceAllowed(book,unique)) {if(semantic)throw Error('时间或线索正文形成范围未获准');continue;}
    const basis=boundBasis(thought.basis,parents,chatIds,habitIds)??{memoryIds:[],chatIds:[]};
    const writeBaseIds=[...new Set([...(thought.updates?[thought.updates]:[]),...(thought.mergePreviousIds??[])])];
    const memory: Memory = {id:id(),bookId:book.id,partnerId:state.partnerId,scope,kind:thought.kind,text:thought.kind==='opinion'?thought.text:thought.text.trim(),evidence:unique,parents:[...new Set([...basis.memoryIds,...writeBaseIds])],chatIds:[...basis.chatIds],formationSources:formationAudit,...(writeBaseIds.length?{writeBaseIds}:{}),createdAt:Date.now(),forgotten:false,source,webSources,basis,...worldNote(thought)};
    if(organization)memory.organization=organization;
    if(thought.documentTitle!==undefined)memory.documentTitle=thought.documentTitle;
    if(thought.navigationCues!==undefined)memory.navigationCues=[...thought.navigationCues];
    const previousKnowledge=thought.updates?state.memories.find(m=>m.id===thought.updates)?.knowledgeDistribution:undefined;
    const knowledgeDistribution=inheritKnowledgeDistribution(previousKnowledge,thought.knowledgeDistribution,requireMemoryText(memory),state.forgotten.filter(f=>f.bookId===book.id).flatMap(f=>typeof f.text==='string'?[f.text]:[]));
    if(knowledgeDistribution)memory.knowledgeDistribution=knowledgeDistribution;
    if(thought.updates){
      const previous=state.memories.find(m=>m.id===thought.updates)!;
      if(thought.documentOperation==='revise')memory.documentRevision=bindDocumentRevision(previous,thought,documentSources,prepared.revisions.get(index));
      if(thought.documentTitle===undefined&&previous.documentTitle!==undefined)memory.documentTitle=previous.documentTitle;
      if(thought.navigationCues===undefined&&previous.navigationCues!==undefined)memory.navigationCues=[...previous.navigationCues];
    }
    if (thought.answersPartOf) memory.answersPartOf = thought.answersPartOf;
    if (readingStage?.length) {
      if (readingStage.some(r => !Number.isSafeInteger(r.start) || !Number.isSafeInteger(r.end) || r.start < 0 || r.end <= r.start ||
        !unique.some(e => e.start <= r.start && e.end >= r.end))) throw new Error('认识形成阶段超出本次实际资料范围');
      memory.readingStage = mergeRanges(readingStage);
    }
    if (['story','opinion','question'].includes(thought.kind)) {
      memory.narrative = parseNarrative(thought.narrative, thought.kind);
      const selected = thought.quoteSource ? passages.get(thought.quoteSource) : undefined;
      // The selected passage was supplied by the core. Recheck it before attaching.
      if (selected && selected.text.length >= 8 && selected.text.length <= 200 && isEvidenceAllowed(book, [selected.evidence]) &&
        originalRanges.some(r => r.start <= selected.evidence.start && r.end >= selected.evidence.end) &&
        bookTextSlice(book,selected.evidence.start, selected.evidence.end) === selected.text) memory.sourceQuote = structuredClone(selected);
      else memory.sourceQuote = matchSourceQuote(book, originalRanges, thought.quote);
      const sources = thought.sourceIds?.map(sourceId => passages.get(sourceId));
      if (sources?.length && sources.every(s => s && isEvidenceAllowed(book, [s.evidence]) &&
        unique.some(r => r.start <= s.evidence.start && r.end >= s.evidence.end) &&
        originalRanges.some(r => r.start <= s.evidence.start && r.end >= s.evidence.end) &&
        bookTextSlice(book,s.evidence.start, s.evidence.end) === s.text)) {
        memory.sourceEvidence = mergeRanges(sources.map(s => s!.evidence)).map(r => evidence(book, r));
      } else if (memory.sourceQuote) memory.sourceEvidence = [{ ...memory.sourceQuote.evidence }];
      if(thought.documentOperation){
        const supplied=documentSourceEvidence([...(thought.sourceIds??[]),...(thought.quoteSource?[thought.quoteSource]:[]),...(thought.edits??[]).flatMap(edit=>edit.sourceIds??[])],documentSources);
        const previous=thought.updates?state.memories.find(m=>m.id===thought.updates):undefined;
        const inherited=[previous,...(thought.mergePreviousIds??[]).map(id=>state.memories.find(m=>m.id===id))].flatMap(m=>m?.sourceEvidence??(m?.sourceQuote?[m.sourceQuote.evidence]:[]));
        const selected=mergeRanges([...inherited,...supplied]).map(r=>evidence(book,r));
        if(selected.length)memory.sourceEvidence=selected;
      }
    }
    if(thought.documentOperation==='retire')memory.documentState='retired';
    if (thought.updates) {
      memory.correctionOf = thought.updates; memory.revisionKind = 'development'; memory.revisionReason = thought.updateReason;
      if(thought.documentOperation==='merge')memory.mergePreviousIds=[...thought.mergePreviousIds!];
      for(const previousId of [thought.updates,...(thought.mergePreviousIds??[])])plan.developments!.push({previousId,nextId:memory.id});
    }
    plan.added.push(memory);
    semanticProposals.set(memory.id,thought);
    proposalSources.set(`t${index + 1}`, memory);
    proposalBindings.set(`t${index + 1}`,memory.id);
  }
  for(const [index,thought]of result.thoughts.entries())if(thought.replacementIds){
    const memory=plan.added.find(m=>m.id===proposalBindings.get(`t${index+1}`));if(!memory||memory.documentState!=='retired')throw Error('承接关系必须随退出操作提交');
    memory.documentSuccessors=thought.replacementIds.map(ref=>{const id=proposalBindings.get(ref)??(parents.includes(ref)?ref:undefined),target=[...state.memories,...plan.added].find(m=>m.id===id);if(!target||!sameDocumentOwner(memory,target)||!isCurrentMemory(target)||target.bookId!==book.id||!memoryReadableByPartner(state,target)||!isEvidenceAllowed(book,target.evidence)||target.id===memory.id||target.id===thought.updates||plan.developments?.some(d=>d.previousId===target.id))throw Error('承接文档须为实际取得或本包形成且仍有效的其他文档');return target.id;});
  }
  // Attach verified p evidence first so acquisition's own p also supports its
  // attribution. Validate entity binding before resolving semantic relations.
  bindSemanticPlan(state,book,plan.added,semanticProposals,proposalSources,{parents,refs,originalRanges,passages,source,historicalSourceIds:options.historicalSourceIds},true);
  if(options.worldCandidate==='v1'){bindWorldPlan(state,book,plan.added,proposalSources,world.roots,parents,refs,source);if(world.roots.length)plan.entityRoots=world.roots;}
  bindSemanticPlan({...state,entityRoots:[...(state.entityRoots??[]),...world.roots]},book,plan.added,semanticProposals,proposalSources,{parents,refs,originalRanges,passages,source,historicalSourceIds:options.historicalSourceIds});
  // Compare persistent semantics after p/m/t binding. Identical prose with a
  // changed time, source or interpretation must create a distinct version.
  const replacements=new Map<string,string>();let reused=true;
  while(reused){reused=false;for(const memory of plan.added){if(memory.mergePreviousIds||!memory.temporal&&!memory.clue||replacements.has(memory.id))continue;remapSemanticReferences(memory,replacements);const existing=[...eligible,...plan.added.filter(m=>m!==memory&&!replacements.has(m.id)&&plan.added.indexOf(m)<plan.added.indexOf(memory))].find(m=>sameDocumentOwner(m,memory)&&(!memory.correctionOf||m.id===memory.correctionOf)&&m.kind===memory.kind&&m.answersPartOf===memory.answersPartOf&&normalize(requireMemoryText(m))===normalize(requireMemoryText(memory))&&JSON.stringify(worldNote(m))===JSON.stringify(worldNote(memory))&&JSON.stringify(m.narrative)===JSON.stringify(memory.narrative)&&JSON.stringify(semanticNote(m))===JSON.stringify(semanticNote(memory)));if(existing){replacements.set(memory.id,existing.id);if(state.memories.some(m=>m.id===existing.id))plan.reused.push(existing.id);reused=true;}}}
  const resolve=(key:string)=>{const seen=new Set<string>();while(replacements.has(key)&&!seen.has(key)){seen.add(key);key=replacements.get(key)!;}return key;};
  for(const m of plan.added){remapSemanticReferences(m,replacements);m.parents=[...new Set(m.parents.map(resolve))];if(m.basis)m.basis={...m.basis,memoryIds:[...new Set(m.basis.memoryIds.map(resolve))]};if(m.attribution?.contentRef)m.attribution.contentRef.memoryId=resolve(m.attribution.contentRef.memoryId);for(const l of m.ruleLinks??[])l.memoryId=resolve(l.memoryId);for(const b of m.entityBindings??[])b.memoryId=resolve(b.memoryId);}
  for(const [key,m]of proposalSources)if(replacements.has(m.id))proposalSources.set(key,eligible.find(v=>v.id===resolve(m.id))??plan.added.find(v=>v.id===resolve(m.id))!);
  plan.added=plan.added.filter(m=>!replacements.has(m.id));plan.developments=plan.developments!.filter(d=>!replacements.has(d.nextId));
  plan.reused = [...new Set(plan.reused)].filter(id => !plan.developments!.some(change => change.previousId === id));
  plan.ids = [...new Set([...plan.reused,...plan.added.map(m => m.id)])];
  if(proposalBindings.size)plan.proposalMemoryIds=Object.fromEntries([...proposalBindings].map(([key,value])=>[key,resolve(value)]));
  for(const memory of plan.added)if(memory.organization?.related?.length){
    const proposal=semanticProposals.get(memory.id)!;
    const explicit=proposal.organization?.related!==undefined;
    memory.organization=mapDocumentOrganization(memory.organization,key=>{
      const targetId=plan.proposalMemoryIds?.[key]??key;
      const target=plan.added.find(m=>m.id===targetId)??state.memories.find(m=>m.id===targetId);
      if(!target||target.id===memory.id||target.bookId!==book.id||!memoryReadableByPartner(state,target)||isBackgroundMemory(target)!==(source==='background')||!isUsableSourceVersion({...state,memories:[...state.memories,...plan.added]},target)||!isEvidenceAllowed(book,target.evidence))throw Error('文档导航须指向同书且当前可读取的合法具体版本或本批有效t');
      // Navigation does not assert that the target supports this document.
      // Semantic adoption stays explicit in basis and its exposure checks.
      return targetId;
    });
  }
  if(hasSemantic)validateSemanticState({...state,memories:[...state.memories,...plan.added],entityRoots:[...(state.entityRoots??[]),...world.roots]});
  if(options.narrativeMode==='stages'){
    const detached={...state,memories:[...state.memories,...plan.added]};
    const added=planNarrativeMemories(detached,book,result,{refs,parents,chatIds,source,habitIds,originalRanges,passages,readingStage:readingStage??[],newMemoryIds:plan.added.map(m=>m.id),stateWriteVersion:options.stateWriteVersion??1,proposalSources});
    if(webSources?.length)added.forEach(m=>{m.webSources=structuredClone(webSources);});
    plan.added.push(...added);plan.ids.push(...added.map(m=>m.id));
    if(options.arcCandidate==='v1'){const arcs=planArcMemories({...state,memories:[...state.memories,...plan.added]},book,result,{refs,parents,chatIds,source,habitIds,originalRanges,passages,readingStage:readingStage??[],newMemoryIds:plan.added.map(m=>m.id),stateWriteVersion:2,proposalSources});plan.added.push(...arcs);plan.ids.push(...arcs.map(m=>m.id));}
    plan.added.forEach(attachFormation);return plan;
  }
  const brief=planReadingBrief(state,book,result.readingBrief,refs,parents,chatIds,source,readingStage??[],plan.ids,habitIds);
  if(brief){
    const previous=brief.previous?state.memories.find(memory=>memory.id===brief.previous!.id):undefined;
    brief.memory.scope=previous?documentScope(previous):options.documentScope??'partner';
    plan.added.push(brief.memory);plan.briefId=brief.memory.id;
    if(brief.previous)plan.developments!.push({previousId:brief.previous.id,nextId:brief.memory.id});
  }
  plan.added.forEach(attachFormation);return plan;
}

export function memoryIntent(text: string): 'save' | 'skip' | undefined {
  if (/(?:不要|不用|别|无需|不必|本次不|这次不)(?:再|继续)?(?:保存|记录)(?:本次|这次|新的?|当前的?)?(?:理解|认识|看法)/u.test(text)) return 'skip';
  if (/(?:不要|不用|别|无需|不必).{0,3}(?:记住|记下|记入记忆|存入记忆)|\b(?:do not|don't) remember\b/iu.test(text)) return 'skip';
  if (/(?:不要|不用|别|无需|不必|本次不|这次不)(?:再|继续)?(?:保存|写入|写进|存入)(?:新的?|长期)?记忆|\b(?:do not|don't) (?:save|store|write)\b.{0,40}\b(?:memory|memories)\b/iu.test(text)) return 'skip';
  if (/(?:^|[，。！？\s])(?:请|帮我|替我|麻烦你|给我)?(?:记住|记下|记一下|记着)|(?:请|帮我|替我)(?:把|将).{1,80}(?:记住|记下|存入记忆)|\bremember (?:this|that)\b/iu.test(text)) return 'save';
  if (/(?:^|[，。！？\s]|并)(?:请|帮我|替我)?(?:保存|记录)(?:本次|这次|新的?|当前的?)?(?:理解|认识|看法)/u.test(text)) return 'save';
  return undefined;
}
