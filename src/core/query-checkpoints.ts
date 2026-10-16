import {bookTextSlice} from './books.ts';
import {viewAllowed} from './published-views.ts';
import {validateTaskMaterialRef} from './storage-records.ts';
import {validateMaterialProjection} from './material-projection.ts';
import {isWorkspaceVersion} from './types.ts';
import {covers,bookLength,normalize} from './books.ts';
import {chatIsTaskSource,isEvidenceAllowed} from './context.ts';
import {dependencyStamp} from './reading-drafts.ts';
import {parseReadingReply} from './model.ts';
import {isNaturalReadingText} from './reading-output.ts';
import {completeSubmitObject} from './agent-port.ts';
import {publicWebUrl} from './web.ts';
import {chatBelongsToPartner} from './discussion-recall.ts';
import {ReadingReferences} from './reading-references.ts';
import {hashText} from './text-hash.ts';
import {stampsEqual} from './memory-identity.ts';
import {stagedHabits,validHabit} from './habits.ts';
import type {AgentModelReply,Chat,ModelReply,QueryCheckpoint,QueryMaterial,State} from './types.ts';

/** Both the live response and an attested host receipt enter the same candidate lifecycle. */
export function receiveQueryResponse(q:QueryCheckpoint,response:ModelReply,material:QueryMaterial|undefined,stamp:string|undefined,phase:'main'|'receipt-repair'):boolean{
  if('toolCalls'in response&&material?.readingStrategy==='companion'&&material.answerScope==='overview'&&!material.answerPreparation)return false;
  let candidate:QueryCheckpoint['candidate'];
  if('toolCalls'in response){const r=response as AgentModelReply,submit=r.toolCalls.filter(t=>t.function.name==='submit_reading');if(submit.length&&(r.toolCalls.length!==1||submit.length!==1))throw Error('完整问题提交不能和新取材工具混在同一回执');if(submit.length)candidate={format:'submit',text:completeSubmitObject(submit[0].function.arguments),...(isNaturalReadingText(r.content)?{finalText:r.content}:{}),transport:'agent',phase};else if(r.finish==='stop')candidate={format:'content',text:r.content,transport:'agent',phase};}
  else candidate={format:'content',text:response.content,transport:'json',phase};
  if(!candidate)return false;
  try{const raw=JSON.parse(candidate.text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));if(raw&&['read','lookup','recall','history','search','readPage'].some(k=>raw[k]))return false;}catch{}
  if(!material||!stamp)throw Error('原答已结算；原输入的完整材料或编号映射尚未核验，暂不应用');
  q.status='received';q.candidate=candidate;q.material=structuredClone(material);delete q.result;delete q.blockedReason;q.dependencyStamp=stamp;delete q.pendingReceipt;return true;
}

export function questionStamp(q:Chat):string{return JSON.stringify([q.id,q.bookId,q.partnerId,q.sessionId,q.text,q.evidence,q.excluded,q.outdatedBy,q.replacedBy,q.futureGrant,q.memoryAllowed,q.longReply,q.corrects,...(q.paragraphCommentId?['paragraph-comment',q.paragraphCommentId]:[]),...(q.answerScope?['answer-scope',q.answerScope]:[])]);}
export function querySourceStamp(state:State,memoryIds:string[]=[],chatIds:string[]=[],sourceStampVersion?:2):string{
  return dependencyStamp(state,{messages:[],refs:[],originalRanges:[],memoryIds,chatIds,habitIds:[],passages:[],basisStampVersion:1,...(sourceStampVersion?{sourceStampVersion}:{})});
}
export function queryMaterialState(state:State,m:QueryMaterial):State{return m.pendingHabits?stagedHabits(state,m.pendingHabits):state;}
export function pendingHabitInputStamp(state:State,plan:NonNullable<QueryMaterial['pendingHabits']>):string{return JSON.stringify((state.habits??[]).filter(h=>plan.retired.some(r=>r.id===h.id)||plan.added.some(n=>n.partnerId===h.partnerId&&n.key===h.key)&&!h.forgotten&&!h.retiredBy&&!h.invalidatedBy).sort((a,b)=>a.id.localeCompare(b.id)));}
export function queryMaterialStamp(state:State,m:QueryMaterial,result?:QueryCheckpoint['result']):string{const stamp=dependencyStamp(queryMaterialState(state,m),{...m,messages:[],memoryIds:[...m.memoryIds,...(m.partialMemoryIds??[])]},result);return m.answerScope||m.answerPreparation?JSON.stringify({...JSON.parse(stamp),...(m.answerScope?{answerScope:m.answerScope}:{}),...(m.answerPreparation?{answerPreparation:m.answerPreparation}:{})}):stamp;}
export function queryCheckpoint(state:State,questionId:string):QueryCheckpoint{
  const q=state.chats.find(q=>q.id===questionId&&q.role==='user'),book=state.books.find(b=>b.id===q?.bookId);
  if(!q||!book||q.excluded||q.outdatedBy||q.replacedBy||q.futureGrant||!chatBelongsToPartner(state,q))throw Error('原问题不适用持久接续');
  const old=state.queryCheckpoints?.find(c=>c.questionId===questionId);
  if(old){if(old.questionStamp!==questionStamp(q)||old.version!==book.version||old.partnerId!==state.partnerId)throw Error('原问或作品已变化，不能沿用旧问题进度');if(old.blockedReason)throw Error(old.blockedReason);if(old.status==='consumed'||q.delivery==='answered'||state.chats.some(c=>c.role==='assistant'&&c.replyTo===q.id&&!c.excluded&&!c.outdatedBy&&!c.replacedBy))throw Error('原问题已保存完整回应');return old;}
  const value:QueryCheckpoint={id:questionId,questionId,bookId:book.id,version:book.version,partnerId:state.partnerId,questionStamp:questionStamp(q),status:'acquired',usageIds:[],acquired:[]};(state.queryCheckpoints??=[]).push(value);return value;
}
export function queryResultUsable(state:State,c:QueryCheckpoint):boolean{
  const book=state.books.find(b=>b.id===c.bookId&&b.version===c.version),q=state.chats.find(q=>q.id===c.questionId),m=c.material;
  if(!book||!q||!m||c.questionStamp!==questionStamp(q)||q.delivery==='answered'||c.status==='consumed'||!isEvidenceAllowed(book,m.refs)||!stampsEqual(queryMaterialStamp(state,m,c.status==='ready'?c.result:undefined),c.dependencyStamp??''))return false;
  if(m.viewIds?.some(id=>{const view=state.publishedViews?.find(v=>v.id===id);return!view||!viewAllowed(state,book,view);}))return false;
  if(m.pendingHabits&&m.habitInputStamp!==pendingHabitInputStamp(state,m.pendingHabits))return false;
  const formed=queryMaterialState(state,m);
  if([...m.memoryIds,...(m.partialMemoryIds??[])].some(id=>!formed.memories.some(x=>x.id===id&&x.bookId===book.id&&x.partnerId===c.partnerId&&!x.forgotten&&!x.invalidatedBy&&isEvidenceAllowed(book,x.evidence)))||m.chatIds.some(id=>!formed.chats.some(x=>x.id===id&&x.bookId===book.id&&chatIsTaskSource(formed,x,q)&&!x.excluded&&(!x.outdatedBy&&!x.replacedBy||m.historicalCommentIds?.includes(id)&&x.presentation==='paragraph')&&!x.futureGrant&&isEvidenceAllowed(book,x.evidence))))return false;
  if(m.originalRanges.some(r=>!isEvidenceAllowed(book,[{...r,bookId:book.id,version:book.version}])))return false;
  if(m.passages.some(([,p])=>p.evidence.bookId!==book.id||p.evidence.version!==book.version||!covers(m.originalRanges,p.evidence)||!covers(m.refs,p.evidence)||(book.text||covers(book.residentRanges??[],p.evidence))&&bookTextSlice(book,p.evidence.start,p.evidence.end)!==p.text))return false;
  const text=normalize(JSON.stringify(c.result??c.candidate));if(state.forgotten.some(f=>f.bookId===book.id&&text.includes(normalize(f.text))))return false;
  return true;
}
export function validateQueryCheckpoints(state:State):void{
  if(state.queryCheckpoints===undefined)return;if(!Array.isArray(state.queryCheckpoints))throw Error('问题接续记录无效');
  const seen=new Set<string>();
  for(const c of state.queryCheckpoints){
    const book=state.books.find(b=>b.id===c?.bookId&&b.version===c.version),q=state.chats.find(q=>q.id===c?.questionId&&q.role==='user');
    if(!book||!q&&c.status!=='consumed'||c.id!==c.questionId||seen.has(c.questionId)||q&&!chatBelongsToPartner({...state,partnerId:c.partnerId},q)||!state.partners.some(p=>p.id===c.partnerId)||typeof c.questionStamp!=='string'||!['acquired','received','ready','consumed'].includes(c.status)||!Array.isArray(c.usageIds)||new Set(c.usageIds).size!==c.usageIds.length||c.usageIds.some(id=>!state.usage.some(u=>u.id===id&&u.questionId===c.questionId&&['main','receipt-repair'].includes(u.queryPhase??'')))||!Array.isArray(c.acquired)||q?.futureGrant)throw Error('问题接续的原问、来源或调用关联无效');
    if(c.status==='consumed'&&!/^[a-f0-9]{64}$/.test(c.questionStamp))throw Error('问题消费指纹无效');
    if(c.limits&&(c.limits.main!=='host-admitted'&&![4,6].includes(c.limits.main)||c.limits['receipt-repair']!=='host-admitted'&&![1,2].includes(c.limits['receipt-repair'])||(['main','receipt-repair'] as const).some(p=>typeof c.limits![p]==='number'&&c.usageIds.filter(id=>state.usage.some(u=>u.id===id&&u.queryPhase===p&&u.dispatchState!=='not-dispatched')).length>(c.limits![p] as number))))throw Error('问题调用阶段进度无效');
    seen.add(c.questionId);
    if(c.pendingReceipt){
      const p=c.pendingReceipt,u=state.usage.find(u=>u.id===p.usageId);
      if(c.status==='consumed'||!u||!c.usageIds.includes(u.id)||u.questionId!==c.questionId||u.queryPhase!==p.phase||!['main','receipt-repair'].includes(p.phase)||!/^[a-f0-9]{64}$/.test(p.payloadHash)||typeof p.dependencyStamp!=='string'||u.coreReadingPayload&&u.coreReadingPayload.hash!==p.payloadHash)throw Error('问题待收原回执的调用身份无效');
      if(!p.material&&p.materialRef)validateTaskMaterialRef(p.materialRef);else validateQueryCheckpoints({...state,queryCheckpoints:[{...c,pendingReceipt:undefined,status:'received',material:p.material,dependencyStamp:p.dependencyStamp,candidate:{format:'content',text:'',transport:'json',phase:p.phase}}]});
    }
    const range=(e:any)=>e&&e.bookId===book.id&&e.version===book.version&&Number.isSafeInteger(e.start)&&Number.isSafeInteger(e.end)&&e.start>=0&&e.end>e.start&&e.end<=bookLength(book);
    for(const a of c.acquired){if(!a||a.kind==='original'?!a||!range(a.evidence):a.kind==='memory'?typeof a.id!=='string'||!['story','opinion','question','shared','user','context','stage','state','arc'].includes(a.memoryKind)||!['full','index','partial'].includes(a.view)||a.history!==undefined&&typeof a.history!=='boolean'||a.indexQuery!==undefined&&(a.view!=='index'||a.memoryKind!=='opinion'||typeof a.indexQuery!=='string'||a.indexQuery.length>160)||typeof a.stamp!=='string':a.kind==='chat'?typeof a.id!=='string'||typeof a.stamp!=='string'||!Number.isSafeInteger(a.textStart)||!Number.isSafeInteger(a.textEnd)||a.textStart<0||a.textEnd<=a.textStart:true)throw Error('问题已取材料形态无效');}
    if(c.status==='received'||c.status==='ready'){
      if(!c.material&&c.materialRef){validateTaskMaterialRef(c.materialRef);if(!c.candidate||typeof c.dependencyStamp!=='string')throw Error('冷问题结果身份无效');continue;}
      const m=c.material;if(!m||!Array.isArray(m.refs)||m.refs.some(e=>!range(e))||!Array.isArray(m.originalRanges)||m.originalRanges.some(r=>!range({...r,bookId:book.id,version:book.version}))||!Array.isArray(m.memoryIds)||!Array.isArray(m.chatIds)||!Array.isArray(m.habitIds)||!Array.isArray(m.passages)||typeof c.dependencyStamp!=='string'||!m.references||!Array.isArray(m.webSources)||!Array.isArray(m.messages)||m.messages.some(x=>x.role!=='user'||typeof x.content!=='string'||x.reasoning_content!==undefined||x.tool_calls!==undefined)||!Array.isArray(m.ranges)||!Array.isArray(m.readUrls))throw Error('问题结果的形成材料无效');
      validateMaterialProjection({...state,partnerId:c.partnerId},book,m);
      if(m.historicalSourceIds!==undefined&&(!Array.isArray(m.historicalSourceIds)||new Set(m.historicalSourceIds).size!==m.historicalSourceIds.length||m.historicalSourceIds.some(id=>typeof id!=='string'||!m.memoryIds.includes(id))))throw Error('问题历史完整来源无效');
      if(m.sourceStampVersion!==undefined&&m.sourceStampVersion!==2)throw Error('问题来源身份版本无效');
      if(m.answerScope!==undefined&&!['overview','focused'].includes(m.answerScope))throw Error('问题取材范围无效');
      if(m.replyStyle&&(!Number.isSafeInteger(m.replyStyle.targetChars)||m.replyStyle.targetChars<0||m.replyStyle.targetChars>20000||!Number.isSafeInteger(m.replyStyle.visibleLimit)||m.replyStyle.visibleLimit<=0||m.replyStyle.visibleLimit>20000||typeof m.replyStyle.expanded!=='boolean'||m.replyStyle.quiet!==false))throw Error('原问题的回应范围无效');
      if(m.deferWorkspace!==undefined&&m.deferWorkspace!==true||m.deferWorkspaceRepairId!==undefined&&(typeof m.deferWorkspaceRepairId!=='string'||!m.deferWorkspaceRepairId)||!!m.deferWorkspace!==!!m.deferWorkspaceRepairId)throw Error('原问题的工作台交接上下文无效');
      if(m.answerPreparation){
        const plan=m.answerPreparation;
        if(!Array.isArray(plan.aspects)||plan.aspects.length<1||plan.aspects.length>3||plan.aspects.some(a=>!a||typeof a.need!=='string'||!a.need.trim()||a.need.length>160||!Array.isArray(a.memoryIds)||a.memoryIds.some(id=>!m.memoryIds.includes(id))||!Array.isArray(a.sourceIds)||a.sourceIds.some(id=>!m.passages.some(([key])=>key===id))||!Array.isArray(a.unavailableIds)||a.unavailableIds.some(id=>typeof id!=='string'||id.length>128)))throw Error('本题材料组织引用了未取得的资料');
      }

      if(m.outputProtocol!==undefined&&!['reading-text-v1','reading-documents-v1'].includes(m.outputProtocol)||m.outputProtocol==='reading-documents-v1'&&m.readingStrategy!=='companion')throw Error('问题输出协议无效');
      if(m.readingStrategy!==undefined&&!['structured','full-original','companion'].includes(m.readingStrategy)||
        m.narrativeMode!==undefined&&!['legacy','stages'].includes(m.narrativeMode)||m.stateWriteVersion!==undefined&&![1,2].includes(m.stateWriteVersion)||
        m.workspaceRevision!==undefined&&(!Number.isSafeInteger(m.workspaceRevision)||m.workspaceRevision<0)||
        m.workspaceSource!==undefined&&m.workspaceSource!=='reading'||
        m.workspaceVersion!==undefined&&!isWorkspaceVersion(m.workspaceVersion,m.workspaceRevision)||
      (m.workspaceRevision!==undefined||m.workspaceSource!==undefined||m.workspaceVersion!==undefined)&&m.readingStrategy!=='companion')throw Error('问题形成时的资料模式或工作台版本无效');
      if(m.readingStrategy==='companion'&&(m.narrativeMode!==undefined&&m.narrativeMode!=='legacy'||m.analysisTask||m.arcCandidate||m.worldCandidate))throw Error('伴读问题不能沿用专门结构模式');
      if(m.pendingHabits&&(!Array.isArray(m.pendingHabits.added)||m.pendingHabits.added.some(h=>h.partnerId!==c.partnerId||h.sourceBookId!==book.id||h.sourceChatId!==c.questionId||!validHabit(h.key,h.value))||!Array.isArray(m.pendingHabits.retired)||!Array.isArray(m.pendingHabits.ids)||typeof m.habitInputStamp!=='string'))throw Error('问题待提交习惯计划无效');
      for(const [key,p]of m.passages)if(!/^p[1-9]\d*$/.test(key)||typeof p?.text!=='string'||p.text.length>200||!range(p.evidence)||!covers(m.originalRanges,p.evidence)||(book.text||covers(book.residentRanges??[],p.evidence))&&p.text!==bookTextSlice(book,p.evidence.start,p.evidence.end))throw Error('问题结果原文编号无效');
      for(const [kind,pairs]of Object.entries(m.references)){if(!['memory','chat','habit','part','entity'].includes(kind)||!Array.isArray(pairs)||pairs.some(p=>!Array.isArray(p)||p.length!==2||p.some(s=>typeof s!=='string'))||new Set(pairs.map(p=>p[0])).size!==pairs.length||new Set(pairs.map(p=>p[1])).size!==pairs.length)throw Error('问题显示编号字典无效');}
      if(Object.keys(m.references).length!==5)throw Error('问题显示编号字典不完整');for(const w of m.webSources)publicWebUrl(w.url);
      new ReadingReferences().restore(m.references);
      if(c.status==='received'&&(!c.candidate||!['submit','content'].includes(c.candidate.format)||typeof c.candidate.text!=='string'||!['agent','json'].includes(c.candidate.transport)||!['main','receipt-repair'].includes(c.candidate.phase)||c.candidate.finalText!==undefined&&(c.candidate.format!=='submit'||typeof c.candidate.finalText!=='string'||!isNaturalReadingText(c.candidate.finalText))))throw Error('问题完整候选无效');
      if(m.historicalCommentIds!==undefined&&(!Array.isArray(m.historicalCommentIds)||m.historicalCommentIds.some(id=>typeof id!=='string'||!m.chatIds.includes(id)||!state.chats.some(chat=>chat.id===id&&chat.presentation==='paragraph'))))throw Error('问题材料的历史段评引用无效');
      if(c.status==='ready'){const result=parseReadingReply(JSON.stringify(c.result),m.stateWriteVersion,m.readingStrategy??'structured');if(result.read||result.lookup||result.recall||result.history||result.search||result.readPage)throw Error('工具请求不能成为完整问题结果');
        if(m.readingStrategy==='companion'&&(result.readingBrief!==undefined||result.stageNarrative!==undefined||result.stateUpdates!==undefined||result.arcUpdates!==undefined||result.entityRoots!==undefined))throw Error('伴读问题不能沿用专门结构写入');}
    }
  }
}

/** Local completion wins over an older unconsumed snapshot of the same question. */
export async function mergeQueryCheckpoints(target:State,local:State):Promise<void>{
  if(!target.queryCheckpoints&&!local.queryCheckpoints)return;
  const values=new Map((target.queryCheckpoints??[]).map(c=>[c.questionId,c]));
  for(const c of local.queryCheckpoints??[]){if(target.books.some(b=>b.id===c.bookId&&b.version===c.version)&&target.partners.some(p=>p.id===c.partnerId)&&target.chats.some(q=>q.id===c.questionId&&q.bookId===c.bookId))values.set(c.questionId,structuredClone(c));}
  for(const [id,c]of values){
    const q=local.chats.find(q=>q.id===id&&q.bookId===c.bookId),book=local.books.find(b=>b.id===c.bookId&&b.version===c.version),imported=target.chats.find(q=>q.id===id);
    if(!book||!imported||q&&q.text!==imported.text||q&&!chatBelongsToPartner({...local,partnerId:c.partnerId},q))continue;
    if(c.status==='consumed'&&c.questionStamp!==await hashText(questionStamp(imported)))continue;
    if(!q&&c.status!=='consumed')continue;
    const answers=local.chats.filter(a=>a.role==='assistant'&&a.replyTo===id);
    if(c.status!=='consumed'&&q?.delivery!=='answered'&&!answers.some(a=>!a.excluded&&!a.outdatedBy&&!a.replacedBy))continue;
    for(const chat of [...(q?[q]:[]),...answers]){const index=target.chats.findIndex(a=>a.id===chat.id),copy=structuredClone(chat);if(index<0)target.chats.push(copy);else{const saved=target.chats[index];target.chats[index]={...copy,excluded:copy.excluded||saved.excluded,outdatedBy:saved.outdatedBy??copy.outdatedBy,replacedBy:saved.replacedBy??copy.replacedBy};}}imported.delivery='answered';
    const memoryIds=new Set([...(c.committedMemoryIds??[]),...answers.flatMap(a=>a.memoryIds??[])]),chatIds=new Set(answers.flatMap(a=>a.contextChatIds??[]));
    const copied=new Set<string>();
    for(const memoryId of memoryIds){const m=local.memories.find(m=>m.id===memoryId&&m.bookId===c.bookId&&m.partnerId===c.partnerId);if(!m||copied.has(m.id))continue;copied.add(m.id);for(const parent of m.parents)memoryIds.add(parent);for(const chatId of m.chatIds)chatIds.add(chatId);if(m.correctionOf)memoryIds.add(m.correctionOf);if(m.stateChangeOf)memoryIds.add(m.stateChangeOf);if(m.arcChangeOf)memoryIds.add(m.arcChangeOf);if(!target.memories.some(x=>x.id===m.id))target.memories.push(structuredClone(m));}
    for(const chatId of chatIds){const chat=local.chats.find(x=>x.id===chatId&&x.bookId===c.bookId&&chatBelongsToPartner({...local,partnerId:c.partnerId},x));if(chat&&!target.chats.some(x=>x.id===chat.id))target.chats.push(structuredClone(chat));}
    if(local.entityRoots)target.entityRoots=[...new Map([...(target.entityRoots??[]),...local.entityRoots.filter(r=>r.bookId===c.bookId&&r.version===c.version&&r.partnerId===c.partnerId&&target.memories.some(m=>m.id===r.originMemoryId))].map(r=>[r.id,r])).values()];
    values.set(id,{id,questionId:id,bookId:c.bookId,version:c.version,partnerId:c.partnerId,questionStamp:await hashText(questionStamp(q??imported)),status:'consumed',usageIds:[...c.usageIds],limits:c.limits,acquired:[],replyId:c.replyId??answers.at(-1)?.id,committedMemoryIds:c.committedMemoryIds});
  }
  target.queryCheckpoints=[...values.values()];
}
