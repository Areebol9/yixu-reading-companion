import {mapDocumentOrganization} from './document-organization.ts';
import type { MemoryBasis, ModelMessage, ReadingReply,StatePartOperation,ArcUpdate,WorldNote,SemanticNote,SemanticNoteProposal,PartnerPersonaSource } from './types.ts';
import {parseStructuralBasis} from './basis.ts';
import type {StructureRelationIndex} from './structure-relations.ts';
import {documentCapacity} from './types.ts';

type Kind = 'memory' | 'chat' | 'habit' | 'part' | 'entity';
const prefix: Record<Kind, string> = { memory: 'm', chat: 'c', habit: 'h',part:'s',entity:'e' };

/** Request-local display IDs. Persistent records and free text never change. */
export class ReadingReferences {
  private forward: Record<Kind, Map<string, string>> = { memory: new Map(), chat: new Map(), habit: new Map(),part:new Map(),entity:new Map() };
  private reverse: Record<Kind, Map<string, string>> = { memory: new Map(), chat: new Map(), habit: new Map(),part:new Map(),entity:new Map() };
  memoryLabel(id:string):string{return this.forward.memory.get(id)??'未提供的编号';}
  /** A saved proposal may be referenced by the rest of its original task.
   * Registering its ID does not fabricate a model input/read receipt. */
  savedMemory(id:string):string{return this.expose('memory',id);}
  entityLabel(id:string):string{return this.forward.entity.get(id)??'未提供的编号';}
  snapshot():Record<Kind,[string,string][]>{return Object.fromEntries(Object.entries(this.forward).map(([kind,map])=>[kind,[...map]])) as Record<Kind,[string,string][]>;}
  restore(snapshot:Record<Kind,[string,string][]>):void{
    for(const kind of Object.keys(prefix) as Kind[]){const pairs=snapshot[kind];if(!Array.isArray(pairs)||pairs.some(([id,label])=>typeof id!=='string'||!new RegExp('^'+prefix[kind]+'[1-9]\\d*$').test(label)||!Number.isSafeInteger(Number(label.slice(1))))||new Set(pairs.map(p=>p[0])).size!==pairs.length||new Set(pairs.map(p=>p[1])).size!==pairs.length)throw Error('问题显示编号字典无效');this.forward[kind]=new Map(pairs);this.reverse[kind]=new Map(pairs.map(([id,label])=>[label,id]));}
  }

  private expose(kind: Kind, id: string): string {
    const known = this.forward[kind].get(id);
    if (known) return known;
    let next=this.forward[kind].size+1;while(this.reverse[kind].has(prefix[kind]+next))next++;
    const short = prefix[kind] + next;
    this.forward[kind].set(id, short); this.reverse[kind].set(short, id);
    return short;
  }
  private resolve(kind: Kind, id: string): string | undefined {
    // Existing compatible transports may still echo a supplied persistent ID.
    return this.reverse[kind].get(id) ?? (this.forward[kind].has(id) ? id : undefined);
  }
  private relations(index:StructureRelationIndex):StructureRelationIndex{
    const node=(n:StructureRelationIndex['items'][number]['from'])=>({...n,id:this.expose(n.kind,n.id)});
    return{...index,items:index.items.map(e=>({...e,ownerId:this.expose('memory',e.ownerId),from:node(e.from),to:node(e.to),...(e.partId?{partId:this.expose('part',e.partId)}:{})})),nodes:index.nodes.map(n=>({...n,id:this.expose('memory',n.id)})),entityIds:index.entityIds.map(id=>this.expose('entity',id)),...(index.missingBodyIds?{missingBodyIds:index.missingBodyIds.map(id=>this.expose('memory',id))}:{})};
  }
  private subject(value:any){return value?{...value,...(value.currentPrimary?{currentPrimary:{...value.currentPrimary,id:this.expose('memory',value.currentPrimary.id)}}:{}),...(value.currentPrimaryConflictIds?{currentPrimaryConflictIds:value.currentPrimaryConflictIds.map((id:string)=>this.expose('memory',id))}:{})}:value;}
  private organization(value:import('./document-organization.ts').DocumentOrganization|undefined,decode:boolean){return mapDocumentOrganization(value,id=>{if(/^t[1-9]\d*$/.test(id))return id;const mapped=decode?this.resolve('memory',id):this.expose('memory',id);if(!mapped)throw Error('文档关联编号未提供，请先取得完整正文');return mapped;});}
  private basis(value: MemoryBasis | undefined, decode: boolean, structural=false): MemoryBasis | undefined {
    if(structural)value=parseStructuralBasis(value);
    if (!value) return undefined;
    const result: MemoryBasis = { memoryIds: [], chatIds: [] };
    for (const [field, kind] of [['memoryIds', 'memory'], ['chatIds', 'chat'], ['habitIds', 'habit']] as const) {
      if (value[field] === undefined) continue;
      const ids = value[field]!.map(id => structural&&kind==='memory'&&/^t[1-9]\d*$/.test(id)?id:decode ? this.resolve(kind, id) : this.forward[kind].get(id) ?? id);
      // Attribution is optional. Unknown IDs retain the existing conservative dependency fallback.
      if (ids.some(id => id === undefined)){if(structural)throw Error('结构basis编号未在本轮提供，不能降级为整批依赖');return undefined;}
      result[field] = ids as string[];
    }
    return result;
  }
  private world(value:WorldNote,decode:boolean):WorldNote{
    const copy=structuredClone(value),entity=(key:string)=>{if(/^new[1-8]$/.test(key))return key;const resolved=decode?this.resolve('entity',key):this.expose('entity',key);if(!resolved)throw Error('主体编号未在本轮合法提供，不能猜身份');return resolved;};
    const memory=(key:string,proposal=false)=>{if(proposal&&/^t[1-9][0-9]*$/.test(key))return key;const resolved=decode?this.resolve('memory',key):this.expose('memory',key);if(!resolved)throw Error('身份或归属的具体版本未提供，请先取得完整来源');return resolved;};
    if(copy.about)copy.about=copy.about.map(x=>({...x,entityId:entity(x.entityId)}));
    if(copy.identityClaim){const c=copy.identityClaim;c.entityId=entity(c.entityId);if(c.targetId)c.targetId=entity(c.targetId);if(c.speakerId)c.speakerId=entity(c.speakerId);if(c.changeOf)c.changeOf=memory(c.changeOf);}
    if(copy.attribution){copy.attribution.holderId=entity(copy.attribution.holderId);if(copy.attribution.speakerId)copy.attribution.speakerId=entity(copy.attribution.speakerId);if(copy.attribution.contentRef)copy.attribution.contentRef.memoryId=memory(copy.attribution.contentRef.memoryId,true);}
    if(copy.ruleLinks)copy.ruleLinks=copy.ruleLinks.map(l=>({...l,memoryId:memory(l.memoryId,true)}));
    if(copy.worldChangeOf)copy.worldChangeOf=memory(copy.worldChangeOf);
    if(copy.entityBindings)copy.entityBindings=copy.entityBindings.map(b=>({...b,entityId:entity(b.entityId),memoryId:memory(b.memoryId)}));
    return copy;
  }
  private semantic<T extends SemanticNote|SemanticNoteProposal>(value:T,decode:boolean):T{
    const copy=structuredClone(value),memory=(key:string)=>{if(/^t[1-9][0-9]*$/.test(key))return key;const resolved=decode?this.resolve('memory',key):this.expose('memory',key);if(!resolved)throw Error('时间或线索具体版本尚未完整提供，请先取回正文');return resolved;};
    for(const axis of [copy.temporal?.occurrence,copy.temporal?.acquisition])for(const r of axis?.relations??[])r.targetId=memory(r.targetId);
    if(copy.clue)for(const r of [copy.clue.setupRef,...(copy.clue.payoffRefs??[])])r.memoryId=memory(r.memoryId);
    return copy;
  }
  private memoryItems<T extends { id: string; answersPartOf?: string; stageNarrative?: {previousStageId?:string}; stateChangeOf?:string;stateProjection?:{parts?:{id:string;memoryRef?:{memoryId:string}}[]} }>(items: T[]): T[] {
    for (const item of items) this.expose('memory',item.id);
    for(const raw of items){const formation=(raw as any).partnerFormation;if(formation?.basis){for(const id of formation.basis.memoryIds??[])this.expose('memory',id);for(const id of formation.basis.chatIds??[])this.expose('chat',id);}}
    // A pointer can be looked up even when the original question is not in this
    // page. The memory tool still applies book, partner and reading permissions.
    for (const item of items) if(item.answersPartOf)this.expose('memory',item.answersPartOf);
    // New narrative pointers reach only records already filtered by the core.
    for(const item of items){
      if(item.stageNarrative?.previousStageId)this.expose('memory',item.stageNarrative.previousStageId);
      for(const id of (item as any).laterDevelopmentIds??[])this.expose('memory',id);
      for(const via of (item as any).knowledgeContextVia??[])this.expose('memory',via.memoryId);
      if((item as any).directSuccessorId)this.expose('memory',(item as any).directSuccessorId);
      for(const id of (item as any).developmentChainIds??[])this.expose('memory',id);
      for(const id of (item as any).documentSuccessors??[])this.expose('memory',id);
      if((item as any).documentRevision?.previousId)this.expose('memory',(item as any).documentRevision.previousId);
      if(item.stateChangeOf)this.expose('memory',item.stateChangeOf);
      for(const part of item.stateProjection?.parts??[]){this.expose('part',part.id);if(part.memoryRef)this.expose('memory',part.memoryRef.memoryId);}
    }
    for(const raw of items){const item=raw as any;if(item.arcId)this.expose('memory',item.arcId);if(item.arcChangeOf)this.expose('memory',item.arcChangeOf);if(item.arcProjection){this.expose('memory',item.arcProjection.arcId);for(const part of item.arcProjection.parts??[]){this.expose('part',part.id);if(part.memoryRef)this.expose('memory',part.memoryRef.memoryId);if(part.impact)for(const key of ['sourceArcId','sourceVersionId','targetArcId','targetVersionId'])this.expose('memory',part.impact[key]);}}}
    return items.map(raw=>{const item:any=this.semantic(this.world({...raw} as any,false) as any,false);if(item.partnerFormation?.basis)item.partnerFormation={...item.partnerFormation,basis:this.basis(item.partnerFormation.basis,false)};if(item.arcId)item.arcId=this.forward.memory.get(item.arcId);if(item.arcChangeOf)item.arcChangeOf=this.forward.memory.get(item.arcChangeOf);if(item.arcProjection)item.arcProjection={...item.arcProjection,arcId:this.forward.memory.get(item.arcProjection.arcId),parts:item.arcProjection.parts.map((part:any)=>({...part,id:this.forward.part.get(part.id),...(part.memoryRef?{memoryRef:{...part.memoryRef,memoryId:this.forward.memory.get(part.memoryRef.memoryId)}}:{}),...(part.impact?{impact:Object.fromEntries(Object.entries(part.impact).map(([key,value])=>[key,['sourceArcId','sourceVersionId','targetArcId','targetVersionId'].includes(key)?this.forward.memory.get(value as string):value]))}:{})}))};return ({ ...item, id:this.forward.memory.get(item.id)!,
      ...(item.organization?{organization:this.organization(item.organization,false)}:{}),...(item.subject?{subject:this.subject(item.subject)}:{}),
      ...(item.matchedHistoryIds?{matchedHistoryIds:item.matchedHistoryIds.map((id:string)=>this.expose('memory',id))}:{}),
      ...(item.laterDevelopmentIds?{laterDevelopmentIds:item.laterDevelopmentIds.map((id:string)=>this.forward.memory.get(id))}:{}),
      ...(item.knowledgeContextVia?{knowledgeContextVia:item.knowledgeContextVia.map((via:any)=>({...via,memoryId:this.forward.memory.get(via.memoryId)}))}:{}),
      ...(item.directSuccessorId?{directSuccessorId:this.forward.memory.get(item.directSuccessorId)}:{}),
      ...(item.developmentChainIds?{developmentChainIds:item.developmentChainIds.map((id:string)=>this.forward.memory.get(id))}:{}),
      ...(item.documentSuccessors?{documentSuccessors:item.documentSuccessors.map((id:string)=>this.forward.memory.get(id))}:{}),
      ...(item.documentRevision?{documentRevision:{...item.documentRevision,previousId:this.forward.memory.get(item.documentRevision.previousId)}}:{}),
      ...(typeof item.text==='string'&&item.kind==='opinion'?{capacity:documentCapacity(item.text.length)}:{}),
      ...(item.answersPartOf ? { answersPartOf:this.forward.memory.get(item.answersPartOf) } : {}),
      ...(item.stageNarrative?{stageNarrative:{...item.stageNarrative,...(item.stageNarrative.previousStageId?{previousStageId:this.forward.memory.get(item.stageNarrative.previousStageId)}:{})}}:{}),
      ...(item.stateChangeOf?{stateChangeOf:this.forward.memory.get(item.stateChangeOf)}:{}),
      ...(item.stateProjection?{stateProjection:{...item.stateProjection,...(item.stateProjection.parts?{parts:item.stateProjection.parts.map((part:any)=>({...part,id:this.forward.part.get(part.id)!,...(part.memoryRef?{memoryRef:{...part.memoryRef,memoryId:this.forward.memory.get(part.memoryRef.memoryId)!}}:{})}))}:{})}}:{}) });});
  }
  private stateOperation(operation:StatePartOperation,decode:boolean):StatePartOperation{
    const mapped={...operation};
    for(const [field,kind]of [['partId','part'],['memoryId','memory']]as const){
      const raw=operation[field];if(!raw)continue;
      if(field==='memoryId'&&/^t[1-9][0-9]*$/.test(raw))continue;
      const id=decode?this.resolve(kind,raw):this.forward[kind].get(raw)??raw;
      if(!id)throw Error(field==='partId'?'状态部件编号未在本轮完整基态中提供，请先取得完整状态与parts':'状态来源编号未在本轮提供，请先取得完整story或question');
      mapped[field]=id;
    }
    return mapped;
  }
  private arcUpdate(update:ArcUpdate,decode:boolean):ArcUpdate{
    const resolve=(key:string)=>{const value=decode?this.resolve('memory',key):this.forward.memory.get(key)??key;if(!value)throw Error('弧线编号未在本轮提供，目录不授予完整写入资格');return value;};
    return{...update,...(update.basis!==undefined?{basis:this.basis(update.basis,decode,true)}:{}),...(update.arcChangeOf?{arcChangeOf:resolve(update.arcChangeOf)}:{}),operations:update.operations.map(operation=>({...this.stateOperation(operation,decode),...(operation.impact?{impact:{...operation.impact,targetId:resolve(operation.impact.targetId)}}:{})}))};
  }
  private workspace(value:NonNullable<ReadingReply['workspace']>,decode:boolean,errors?:string[]):NonNullable<ReadingReply['workspace']>{
    const reference=(id:string,field:'understanding'|'focus'|'working')=>{
      if(/^t[1-9][0-9]*$/.test(id))return id;
      const resolved=decode?this.resolve('memory',id):this.forward.memory.get(id);
      if(!resolved&&decode&&field!=='understanding')return id;
      if(!resolved&&errors){errors.push(`workspace.${field}：引用${id}未在本轮提供`);return id;}
      if(!resolved)throw Error(decode?`工作台${field}须引用本轮已完整展开的mN或本次tN；tN为本次documents第N篇，完整理解正文写入documents.text，目录只用于回查`:'工作台认识编号未在本轮提供，请先取得完整认识；目录只用于回查');
      // Mapping supplies identity only. The publication plan checks full-body
      // authority, current version, partner and original-reading permissions.
      return resolved;
    };
    return{...(value.understanding!==undefined?{understanding:reference(value.understanding,'understanding')}:{}),...(value.focus!==undefined?{focus:value.focus.map(id=>reference(id,'focus'))}:{}),...(value.working!==undefined?{working:value.working.map(id=>reference(id,'working'))}:{})};
  }
  private partnerMaintenance(reply:ReadingReply,decode:boolean):Pick<ReadingReply,'partnerMaintenance'|'partnerMaintenanceIssue'>{
    if(!reply.partnerMaintenance)return{};
    const proposal=reply.partnerMaintenance;
    try{
      const sources=(items:PartnerPersonaSource[]):PartnerPersonaSource[]=>items.map(source=>{
        if(source.kind==='theme'||source.kind==='memory'&&/^t[1-9][0-9]*$/.test(source.id))return{...source};
        const id=decode?this.resolve(source.kind,source.id):this.forward[source.kind].get(source.id)??source.id;
        if(!id)throw Error(`伙伴修订来源${source.id}未在本任务实际提供`);
        return{...source,id};
      });
      return{partnerMaintenance:{...(proposal.persona?{persona:{...proposal.persona,sources:sources(proposal.persona.sources)}}:{}),...(proposal.themes?{themes:proposal.themes.map(theme=>({...theme,sources:sources(theme.sources)}))}:{}),...(proposal.resolves?{resolves:[...proposal.resolves]}:{})}};
    }catch(error){return{partnerMaintenance:undefined,partnerMaintenanceIssue:{reason:(error as Error).message,proposal:structuredClone(proposal)}};}
  }
  decode(reply: ReadingReply,errors?:string[]): ReadingReply {
    const chatId = reply.history?.chatId ? this.resolve('chat', reply.history.chatId) : undefined;
    if (reply.history?.chatId && !chatId) throw new Error('交流编号未在本轮提供，请先检索真实交流');
    const entityIds=reply.recall?.entityIds?.map(id=>{const found=this.resolve('entity',id);if(!found)throw Error('主体编号未在本轮提供');return found;});
    const memoryIds=reply.recall?.ids?.map(id=>{const resolved=this.resolve('memory',id);if(!resolved)throw new Error('记忆编号未在本轮提供，请使用目录编号或关键词检索');return resolved;});
    return { ...reply,...this.partnerMaintenance(reply,true),...(reply.workspace?{workspace:this.workspace(reply.workspace,true,errors)}:{}),...(reply.stageNarrative?.basis!==undefined?{stageNarrative:{...reply.stageNarrative,basis:this.basis(reply.stageNarrative.basis,true,true)}}:{}), ...(reply.arcUpdates?{arcUpdates:reply.arcUpdates.map(u=>this.arcUpdate(u,true))}:{}), replyBasis: this.basis(reply.replyBasis, true),
      ...(reply.stateUpdates?{stateUpdates:reply.stateUpdates.map(update=>{
        const target=update.stateChangeOf?this.resolve('memory',update.stateChangeOf):undefined;
        if(update.stateChangeOf&&!target)throw new Error('状态更新编号未在本轮提供，请先取得完整当前状态');
        return{...update,...(update.basis!==undefined?{basis:this.basis(update.basis,true,true)}:{}),...(target?{stateChangeOf:target}:{}),...(update.operations?{operations:update.operations.map(op=>this.stateOperation(op,true))}:{})};
      })}:{}),
      ...((memoryIds||entityIds)?{recall:{...reply.recall,...(memoryIds?{ids:memoryIds}:{}),...(entityIds?{entityIds}: {})}}:{}),
      ...(chatId ? { history: { ...reply.history, chatId } } : {}),
      views:reply.views?.map(v=>({...v,sourceMemoryIds:v.sourceMemoryIds.map(id=>/^t[1-9]\d*$/.test(id)?id:this.resolve('memory',id)??id),reviewedMemoryIds:v.reviewedMemoryIds?.map(id=>/^t[1-9]\d*$/.test(id)?id:this.resolve('memory',id)??id),dropSourceMemoryIds:v.dropSourceMemoryIds?.map(id=>this.resolve('memory',id)??id),chatIds:v.chatIds?.map(id=>this.resolve('chat',id)??id)})),
      thoughts: reply.thoughts.map(thought => {
        const updates = thought.updates ? this.resolve('memory', thought.updates) : undefined;
        if(thought.updates&&!updates){if(errors)errors.push(`documents.updates：引用${thought.updates}未在本轮提供`);else throw new Error('理解更新编号未在本轮提供，请使用已取得记忆的编号');}
        const mergePreviousIds=thought.mergePreviousIds?.map(id=>{const resolved=this.resolve('memory',id);if(!resolved)throw Error('归并前驱尚未在本轮提供：'+id);return resolved;});
        const answersPartOf = thought.answersPartOf ? this.resolve('memory',thought.answersPartOf) : undefined;
        if (thought.answersPartOf && !answersPartOf) throw new Error('部分答案关联的疑问尚未提供，请先取得原疑问');
        return { ...this.semantic(this.world(thought,true) as typeof thought,true),...(thought.organization?{organization:this.organization(thought.organization,true)}:{}),basis: this.basis(thought.basis, true,thought.documentOperation!==undefined), ...(updates ? { updates } : {}), ...(mergePreviousIds?{mergePreviousIds}:{}),...(thought.replacementIds?{replacementIds:thought.replacementIds.map(id=>/^t[1-9]\d*$/.test(id)?id:this.resolve('memory',id)??(()=>{throw Error('承接文档编号未提供：'+id);})())}:{}), ...(answersPartOf ? { answersPartOf } : {}) };
      }),
      reinforce: reply.reinforce?.flatMap(id => { const target = this.resolve('memory', id); return target ? [target] : []; })
    };
  }
  private draft(reply: ReadingReply): ReadingReply {
    return { ...reply,...this.partnerMaintenance(reply,false),...(reply.workspace?{workspace:this.workspace(reply.workspace,false)}:{}),...(reply.stageNarrative?.basis!==undefined?{stageNarrative:{...reply.stageNarrative,basis:this.basis(reply.stageNarrative.basis,false,true)}}:{}), ...(reply.arcUpdates?{arcUpdates:reply.arcUpdates.map(u=>this.arcUpdate(u,false))}:{}), replyBasis: this.basis(reply.replyBasis, false),
      ...(reply.stateUpdates?{stateUpdates:reply.stateUpdates.map(update=>({...update,...(update.basis!==undefined?{basis:this.basis(update.basis,false,true)}:{}),...(update.stateChangeOf?{stateChangeOf:this.forward.memory.get(update.stateChangeOf)??update.stateChangeOf}:{}),...(update.operations?{operations:update.operations.map(op=>this.stateOperation(op,false))}:{})}))}:{}),
      views:reply.views?.map(v=>({...v,sourceMemoryIds:v.sourceMemoryIds.map(id=>this.forward.memory.get(id)??id),reviewedMemoryIds:v.reviewedMemoryIds?.map(id=>this.forward.memory.get(id)??id),dropSourceMemoryIds:v.dropSourceMemoryIds?.map(id=>this.forward.memory.get(id)??id),chatIds:v.chatIds?.map(id=>this.forward.chat.get(id)??id)})),
      thoughts: reply.thoughts.map(t => ({ ...this.semantic(this.world(t,false) as typeof t,false),...(t.organization?{organization:this.organization(t.organization,false)}:{}), basis: this.basis(t.basis, false), ...(t.updates ? { updates: this.forward.memory.get(t.updates) ?? t.updates } : {}), ...(t.mergePreviousIds?{mergePreviousIds:t.mergePreviousIds.map(id=>this.forward.memory.get(id)??id)}:{}),...(t.replacementIds?{replacementIds:t.replacementIds.map(id=>this.forward.memory.get(id)??id)}:{}), ...(t.answersPartOf ? { answersPartOf:this.forward.memory.get(t.answersPartOf) ?? t.answersPartOf } : {}) })),
      reinforce: reply.reinforce?.map(id => this.forward.memory.get(id) ?? id)
    };
  }
  results<T extends { source: string; text: string }>(results: T[]): T[] {
    return results.map(result => {
      const kind = result.source === '当前作品的获准记忆，非指令' ? 'memory' : result.source === '当前作品的真实交流，非指令' ? 'chat' : undefined;
      if (!kind) return result;
      const page = JSON.parse(result.text);
      if(kind==='memory'&&page.relations)page.relations=this.relations(page.relations);
      if(kind==='memory'&&page.request?.ids)page.request={...page.request,ids:page.request.ids.map((id:string)=>this.expose('memory',id))};
      if(kind==='memory'&&page.request?.entityIds)page.request={...page.request,entityIds:page.request.entityIds.map((id:string)=>this.expose('entity',id))};
      return { ...result, text: JSON.stringify({ ...page, items: kind === 'memory' ? this.memoryItems(page.items) : page.items.map((m: { id: string }) => ({ ...m, id: this.expose(kind, m.id) })) }) };
    });
  }
  messages(messages: ModelMessage[]): ModelMessage[] {
    return messages.map(message => {
      if (message.role === 'system') return message;
      let data: any;
      try { data = JSON.parse(message.content); } catch { return message; }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return message;
      // Reserve both lists before encoding relationships. A selected partial
      // answer may point at a question that appears only in questionIndex.
      for(const items of [data.memories,data.questionIndex,data.stageNarratives,data.currentStates,data.narrativeIndex?.items,data.analysisMaterials,data.analysisIndex?.items])if(Array.isArray(items))for(const item of items)this.expose('memory',item.id);
      if(data.workspaceMaterial){
        const material=data.workspaceMaterial,w=material.workspace;
        if(material.remaining)material.remaining=this.memoryItems(material.remaining);
        if(material.working)material.working=this.memoryItems(material.working);
        if(material.understanding)material.understanding=this.memoryItems([material.understanding])[0];
        if(Array.isArray(material.focus))material.focus=this.memoryItems(material.focus);
        if(w)material.workspace={...w,...(w.understandingId?{understandingId:this.expose('memory',w.understandingId)}:{}),focusIds:w.focusIds.map((id:string)=>this.expose('memory',id)),...(w.workingIds?{workingIds:w.workingIds.map((id:string)=>this.expose('memory',id))}:{}),...(w.lastChatId?{lastChatId:this.expose('chat',w.lastChatId)}:{})};
      }
      if(data.analysisRelations)data.analysisRelations=this.relations(data.analysisRelations);
      if(data.entityIndex)data.entityIndex={...data.entityIndex,items:data.entityIndex.items.map((x:any)=>({...x,id:this.expose('entity',x.id),names:x.names.map((n:any)=>({...n,memoryId:this.expose('memory',n.memoryId)})),claimIds:x.claimIds.map((key:string)=>this.expose('memory',key))}))};
      if(data.knowledgeMaintenance?.candidates)data.knowledgeMaintenance={...data.knowledgeMaintenance,candidates:this.memoryItems(data.knowledgeMaintenance.candidates)};
      if(data.memoryDiscovery)data.memoryDiscovery={...data.memoryDiscovery,items:this.memoryItems(data.memoryDiscovery.items)};
      if(data.memoryCoverage)data.memoryCoverage={...data.memoryCoverage,items:this.memoryItems(data.memoryCoverage.items)};
      if(data.memorySelection){const selection=data.memorySelection;data.memorySelection={...selection,...(Array.isArray(selection.selections)?{selections:selection.selections.map((item:{id:string;lane:string})=>({...item,id:this.expose('memory',item.id)}))}:{}),...(Array.isArray(selection.remainingIds)?{remainingIds:selection.remainingIds.map((id:string)=>this.expose('memory',id))}:{}),...(Array.isArray(selection.unavailableIds)?{unavailableIds:selection.unavailableIds.map((id:string)=>this.expose('memory',id))}:{})};}
      if(Array.isArray(data.analysisMaterials))data.analysisMaterials=this.memoryItems(data.analysisMaterials);
      if(data.analysisIndex)data.analysisIndex={...data.analysisIndex,items:this.memoryItems(data.analysisIndex.items)};
      if(data.analysisCompleteness?.missingBodies)data.analysisCompleteness={...data.analysisCompleteness,missingBodies:data.analysisCompleteness.missingBodies.map((item:any)=>({...item,id:this.expose('memory',item.id)}))};
      if(Array.isArray(data.analysisChats)){for(const item of data.analysisChats)this.expose('chat',item.id);data.analysisChats=data.analysisChats.map((c:any)=>({...c,id:this.expose('chat',c.id),...(c.replyTo?{replyTo:this.expose('chat',c.replyTo)}:{})}));}
      if(data.analysisChatIndex)data.analysisChatIndex={...data.analysisChatIndex,items:data.analysisChatIndex.items.map((c:any)=>({...c,id:this.expose('chat',c.id)}))};
      if(data.analysisCompleteness?.missingChats)data.analysisCompleteness={...data.analysisCompleteness,missingChats:data.analysisCompleteness.missingChats.map((item:any)=>({...item,id:this.expose('chat',item.id)}))};
      if (Array.isArray(data.memories)) data.memories = this.memoryItems(data.memories);
      for(const key of ['remainingMemoryIds','unavailableMemoryIds'])if(Array.isArray(data[key]))data[key]=data[key].map((id:string)=>this.expose('memory',id));
      if (Array.isArray(data.directory)) data.directory = this.memoryItems(data.directory);
      if(Array.isArray(data.questionIndex))data.questionIndex=this.memoryItems(data.questionIndex);
      for(const key of ['stageNarratives','currentStates'])if(Array.isArray(data[key]))data[key]=this.memoryItems(data[key]);
      if(data.narrativeIndex&&Array.isArray(data.narrativeIndex.items))data.narrativeIndex={...data.narrativeIndex,items:this.memoryItems(data.narrativeIndex.items)};
      if(data.readingBrief&&typeof data.readingBrief.id==='string')data.readingBrief={...data.readingBrief,id:this.expose('memory',data.readingBrief.id)};
      if (Array.isArray(data.chapterContext)) data.chapterContext = data.chapterContext.map((c: { memoryIds: string[] }) => ({ ...c, memoryIds: c.memoryIds.map(id => this.expose('memory', id)) }));
      if(Array.isArray(data.stageReadings))data.stageReadings=data.stageReadings.map((r:{memoryIds:string[]})=>({...r,memoryIds:r.memoryIds.map(id=>this.expose('memory',id))}));
      for(const key of ['conversation','newConversation'])if(Array.isArray(data[key])){
        const supplied=new Set<string>(data[key].map((c:{id:string})=>c.id));
        for(const id of supplied)this.expose('chat',id);
        data[key]=data[key].map((c:{id:string;replyTo?:string;paragraphCommentId?:string;sharedChatId?:string;bodyRefId?:string})=>{const item={...c,id:this.expose('chat',c.id)};for(const pointer of ['replyTo','paragraphCommentId','sharedChatId','bodyRefId'] as const){const id=c[pointer];if(id&&supplied.has(id))item[pointer]=this.expose('chat',id);}return item;});
      }
      if(Array.isArray(data.reviewSources))data.reviewSources=data.reviewSources.map((source:any)=>({...source,memoryIds:source.memoryIds.map((id:string)=>this.expose('memory',id))}));
      if(Array.isArray(data.views))data.views=data.views.map((view:any)=>({...view,...(Array.isArray(view.reviewedMemoryIds)?{reviewedMemoryIds:view.reviewedMemoryIds.map((id:string)=>this.expose('memory',id))}:{}),...(Array.isArray(view.adoptedMemoryIds)?{adoptedMemoryIds:view.adoptedMemoryIds.map((id:string)=>this.expose('memory',id))}:{})}));
      if(Array.isArray(data.viewChecks))data.viewChecks=data.viewChecks.map((check:any)=>({...check,versions:check.versions.map((version:any)=>{const [previous,current]=this.memoryItems([version.previous,version.current]);return{previous,current};})}));
      for (const key of ['commonHabits', 'habitUpdate']) if (Array.isArray(data[key])) data[key] = data[key].map((h: { id: string }) => ({ ...h, id: this.expose('habit', h.id) }));
      if (data.userChatId) data.userChatId = this.expose('chat', data.userChatId);
      if (data.undeliveredReadingReaction) {
        const reaction = data.undeliveredReadingReaction;
        reaction.memoryIds = reaction.memoryIds.map((id: string) => this.expose('memory', id));
        reaction.chatIds = reaction.chatIds.map((id: string) => this.expose('chat', id));
      }
      if (data.toolResults) data.toolResults = this.results(data.toolResults);
      if (data.draft) data.draft = this.draft(data.draft);
      return { ...message, content: JSON.stringify(data) };
    });
  }
}
