import type {Evidence,FormationSources,State,TaskMaterialRef} from './types.ts';
import {memoryIsForgotten,createChatMemoryChecker} from './context.ts';
import {bookVersionAllowsRange} from './book-versions.ts';

/** Expand legacy provenance only when forming a new result. New records carry
 * the flattened withdrawal index; importing old records never rewrites them. */
export function formationSources(state:State,input:{memoryIds:readonly string[];chatIds:readonly string[];viewIds?:readonly string[];habitIds?:readonly string[];evidence:readonly Evidence[];materialRef?:TaskMaterialRef}):FormationSources{
  const memories=new Map(state.memories.map(m=>[m.id,m])),chats=new Map(state.chats.map(c=>[c.id,c])),views=new Map((state.publishedViews??[]).map(v=>[v.id,v]));
  const memoryIds=new Set<string>(),chatIds=new Set<string>(),viewIds=new Set<string>(),habitIds=new Set(input.habitIds),evidence=new Map<string,Evidence>();
  const addEvidence=(items:readonly Evidence[])=>{for(const e of items)evidence.set(JSON.stringify([e.bookId,e.version,e.start,e.end]),Object.freeze({...e}));};
  const pending:{kind:'memory'|'chat'|'view';id:string}[]=[...input.memoryIds.map(id=>({kind:'memory' as const,id})),...input.chatIds.map(id=>({kind:'chat' as const,id})),...(input.viewIds??[]).map(id=>({kind:'view' as const,id}))];
  addEvidence(input.evidence);
  const append=(audit:FormationSources)=>{audit.memoryIds.forEach(id=>memoryIds.add(id));audit.chatIds.forEach(id=>chatIds.add(id));audit.viewIds.forEach(id=>viewIds.add(id));audit.habitIds?.forEach(id=>habitIds.add(id));addEvidence(audit.evidence);};
  while(pending.length){const {kind,id}=pending.pop()!,seen=kind==='memory'?memoryIds:kind==='chat'?chatIds:viewIds;if(seen.has(id))continue;seen.add(id);
    if(kind==='memory'){const m=memories.get(id);if(!m)throw Error('形成来源认识不存在：'+id);addEvidence(m.evidence);[...(m.habitIds??[]),...(m.basis?.habitIds??[])].forEach(id=>habitIds.add(id));if(m.formationSources){append(m.formationSources);continue;}
      pending.push(...[...m.parents,...(m.basis?.memoryIds??[])].map(id=>({kind:'memory' as const,id})),...[...m.chatIds,...(m.basis?.chatIds??[])].map(id=>({kind:'chat' as const,id})));
    }else if(kind==='view'){const v=views.get(id);if(!v)throw Error('形成来源概要不存在：'+id);addEvidence(v.evidence);if(v.formationSources){append(v.formationSources);continue;}
      pending.push(...v.memorySources.map(s=>({kind:'memory' as const,id:s.id})),...v.contextChatIds.map(id=>({kind:'chat' as const,id})),...v.viewSources.map(id=>({kind:'view' as const,id})));
    }else{const c=chats.get(id);if(!c)throw Error('形成来源交流不存在：'+id);addEvidence(c.evidence);
      pending.push(...[...(c.memoryIds??[]),...(c.basis?.memoryIds??[])].map(id=>({kind:'memory' as const,id})),...[...(c.contextChatIds??[]),...(c.basis?.chatIds??[]),...(c.replyTo?[c.replyTo]:[]),...(c.paragraphCommentId?[c.paragraphCommentId]:[])].map(id=>({kind:'chat' as const,id})));
    }
  }
  const audit:FormationSources={kind:'formation-sources-v1',...(input.materialRef?{materialRef:Object.freeze({...input.materialRef})}:{}),memoryIds:[...memoryIds],chatIds:[...chatIds],viewIds:[...viewIds],...(habitIds.size?{habitIds:[...habitIds]}:{}),evidence:[...evidence.values()]};
  Object.freeze(audit.memoryIds);Object.freeze(audit.chatIds);Object.freeze(audit.viewIds);if(audit.habitIds)Object.freeze(audit.habitIds);Object.freeze(audit.evidence);return Object.freeze(audit);
}

/** Checked against live flags on each boundary. The audit's immutable index is
 * reused; development alone never revokes a historical body. */
export function formationSourceChecker(state:State,evidenceAllowed:(refs:Evidence[])=>boolean):(audit:FormationSources)=>boolean{
  const memories=new Map(state.memories.map(m=>[m.id,m])),chats=new Map(state.chats.map(c=>[c.id,c])),views=new Map((state.publishedViews??[]).map(v=>[v.id,v])),habits=new Map((state.habits??[]).map(h=>[h.id,h])),partners=new Set(state.partners.map(p=>p.id));
  const memo=new WeakMap<FormationSources,boolean>(),chatAllowed=createChatMemoryChecker(state);
  return audit=>{const prior=memo.get(audit);if(prior!==undefined)return prior;
    const allowed=evidenceAllowed(audit.evidence)&&audit.memoryIds.every(id=>{const m=memories.get(id),next=m?.replacedBy?memories.get(m.replacedBy):undefined;return !!m&&partners.has(m.partnerId)&&!memoryIsForgotten(state,m)&&!m.invalidatedBy&&m.reviewDisposition!=='unsupported'&&(!m.replacedBy||next?.revisionKind==='development');})&&audit.chatIds.every(id=>{const c=chats.get(id),parent=c?.replyTo?chats.get(c.replyTo):undefined,owner=c?.partnerId??state.partners.find(p=>p.legacyUnlabelled)?.id??(state.partners.length===1?state.partners[0].id:undefined);return !!c&&!!owner&&partners.has(owner)&&chatAllowed(c)&&!c.excluded&&!c.outdatedBy&&!c.replacedBy&&!c.futureGrant&&parent?.memoryAllowed!==false;})&&audit.viewIds.every(id=>views.has(id));
    const complete=allowed&&(audit.habitIds??[]).every(id=>{const habit=habits.get(id);return !!habit&&!habit.forgotten&&!habit.invalidatedBy&&!habit.retiredBy;});memo.set(audit,complete);return complete;
  };
}

/** Structural verification for cold records. The bound task reference remains
 * the authority for what the model actually received, never its declarations. */
export function validateFormationSources(audit:FormationSources,state:State):void{
  const ids=(value:unknown):value is string[]=>Array.isArray(value)&&value.every(id=>typeof id==='string'&&!!id)&&new Set(value).size===value.length;
  if(!audit||audit.kind!=='formation-sources-v1'||Object.keys(audit).some(key=>!['kind','materialRef','memoryIds','chatIds','viewIds','habitIds','evidence'].includes(key))||!ids(audit.memoryIds)||!ids(audit.chatIds)||!ids(audit.viewIds)||audit.habitIds!==undefined&&!ids(audit.habitIds)||!Array.isArray(audit.evidence))throw Error('完整供材审计格式无效');
  const memories=new Set(state.memories.map(m=>m.id)),chats=new Set(state.chats.map(c=>c.id)),views=new Set((state.publishedViews??[]).map(v=>v.id));
  if(audit.memoryIds.some(id=>!memories.has(id))||audit.chatIds.some(id=>!chats.has(id))||audit.viewIds.some(id=>!views.has(id))||audit.habitIds?.some(id=>!state.habits?.some(habit=>habit.id===id)))throw Error('完整供材审计缺少实际来源记录');
  for(const e of audit.evidence){const book=state.books.find(book=>book.id===e?.bookId);if(!book||typeof e.version!=='string'||!Number.isSafeInteger(e.start)||!Number.isSafeInteger(e.end)||e.start<0||e.end<=e.start||e.end>(book.textLength??book.text.length)||!bookVersionAllowsRange(book,e.version,e))throw Error('完整供材审计的原文版本或范围无效');}
  if(audit.materialRef&&(!audit.materialRef.key||!/^[a-f0-9]{64}$/.test(audit.materialRef.hash)))throw Error('完整供材审计的任务引用无效');
}
