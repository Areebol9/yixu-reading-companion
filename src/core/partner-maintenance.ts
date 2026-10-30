import {applyPartnerPersonaRevision,applyPartnerThemeRevision} from './partner-persona.ts';
import type {State,ReadingDraftMaterial,ReadingReply,PartnerPersonaSource} from './types.ts';

/** Optional personal revisions share the book commit, but never undo valid book work. */
export function applyReadingPartnerMaintenance(state:State,input:{
  result:ReadingReply;material?:ReadingDraftMaterial;bookId:string;requestId:string;
  memoryIds:string[];proposalMemoryIds?:Record<string,string>;
}):void{
  const {result,material}=input,proposal=result.partnerMaintenance,issue=result.partnerMaintenanceIssue;
  if(!proposal&&!issue)return;
  const partnerId=material?.partnerPersona?.partnerId??state.partnerId;
  const candidateId='partner-maintenance:'+input.requestId;
  const candidate={id:candidateId,partnerId,bookId:input.bookId,usageId:input.requestId,proposal:structuredClone(issue?.proposal??proposal),reason:issue?.reason??'',createdAt:Date.now()};
  try{
    if(issue)throw Error(issue.reason);
    if(!proposal||!material?.partnerPersona||material.partnerPersona.participation==='none'||material.taskRole!=='maintenance')throw Error('原任务没有可修订的人格快照');
    const next:State={...state,partners:state.partners.map(p=>p.id===partnerId?{...p}:p),partnerPersonaVersions:[...(state.partnerPersonaVersions??[])],partnerThemes:[...(state.partnerThemes??[])]};
    const memories=new Set([...(material.memoryIds??[]),...input.memoryIds]);
    const chats=new Set(material.chatIds),themes=new Set(material.partnerThemeReadIds??[]);
    const bind=(source:PartnerPersonaSource):PartnerPersonaSource=>{
      if(source.kind==='theme'){if(!themes.has(source.id))throw Error('所引个人主题尚未取得全文');return source;}
      const id=source.kind==='memory'?input.proposalMemoryIds?.[source.id]??source.id:source.id;
      if(!(source.kind==='memory'?memories:chats).has(id))throw Error('个人修订引用了本任务未取得的材料');
      return{...source,id};
    };
    for(const change of proposal.themes??[]){
      if(change.partnerId!==partnerId)throw Error('个人主题不能跨伙伴修订');
      if(change.baseVersionId&&!themes.has(change.baseVersionId))throw Error('旧个人主题须先取得全文再修订');
      applyPartnerThemeRevision(next,{...change,sources:change.sources.map(bind)});
    }
    if(proposal.persona){
      if(proposal.persona.partnerId!==partnerId||proposal.persona.baseVersionId!==material.partnerPersona.personaVersionId)throw Error('人格修订必须基于本任务实际使用的版本');
      applyPartnerPersonaRevision(next,{...proposal.persona,sources:proposal.persona.sources.map(bind)});
    }
    const resolved=new Set(proposal.resolves??[]),offered=new Set(material.partnerMaintenanceCandidateIds??[]);
    for(const id of resolved)if(!offered.has(id)||!state.partnerMaintenanceCandidates?.some(c=>c.id===id&&c.partnerId===partnerId))throw Error('只能处理本任务实际取得的原修订候选');
    state.partners=next.partners;state.partnerPersonaVersions=next.partnerPersonaVersions;state.partnerThemes=next.partnerThemes;
    state.partnerMaintenanceCandidates=(state.partnerMaintenanceCandidates??[]).filter(c=>c.id!==candidateId&&!resolved.has(c.id));
  }catch(error){
    candidate.reason=error instanceof Error?error.message:String(error);
    state.partnerMaintenanceCandidates=[...(state.partnerMaintenanceCandidates??[]).filter(c=>c.id!==candidateId),candidate];
  }
}
