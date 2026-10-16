import {hydrateMemoryBodies} from './memory-bodies.ts';
import {readStructureRelations} from './structure-relations.ts';
import {projectWorkDossier,parseWorkDossierRequest} from './work-dossier.ts';
import type {WorkDossierRequest,WorkDossierResult} from './work-dossier.ts';
import type {RelationSeeds} from './structure-relations.ts';
import {entityIndex} from './world-identity.ts';
import {bookLength,importBook} from './books.ts';
import {currentArcs} from './arc-state.ts';
import {planAnalysisRecovery} from './analysis-recovery.ts';
import {selectAnalysisMaterials} from './analysis-materials.ts';
import type {AnalysisMaterials} from './analysis-materials.ts';
import {ReadingEngine} from './engine.ts';
import {restoreReadingEngine} from './runtime.ts';
import {initialState} from './state.ts';
import {restoreBackup} from './backup.ts';
import type {AgentRunner} from './agent-port.ts';
import type {AgentFactReviewer} from './agent-review-port.ts';
import type {Book,ModelPort,Range,Store,State} from './types.ts';

type Ports={agent?:AgentRunner;factReviewer?:AgentFactReviewer};
type ProfileKind='analysis'|'full-original';
/** Headless access to the same core. It owns no parallel state, model or usage ledger. */
export class AnalysisCore{
  readonly engine:ReadingEngine;
  constructor(engine:ReadingEngine){this.engine=engine;}
  static async restore(store:Store,model:ModelPort,ports:Ports={}):Promise<AnalysisCore>{
    const {engine}=await restoreReadingEngine(store,model);engine.agent=ports.agent;engine.factReviewer=ports.factReviewer;return new AnalysisCore(engine);
  }
  static async fromBackup(raw:string,store:Store,model:ModelPort,ports:Ports={}):Promise<AnalysisCore>{
    const state=await restoreBackup(raw,initialState());await store.save(state);store.retainBookTexts?.(state.books);return this.restore(store,model,ports);
  }
  async importText(title:string,text:string):Promise<string>{
    const book=await importBook(title,text);let bookId=book.id;
    await this.engine.editState(state=>{const existing=state.books.find(b=>b.version===book.version);if(existing)bookId=existing.id;else state.books.push(book);});return bookId;
  }
  open(bookId:string):Promise<void>{return this.engine.startReading(bookId);}
  grant(bookId:string,ranges:Range[]):Promise<void>{return this.engine.grantAnalysisRanges(bookId,ranges);}
  configure(bookId:string,options:{arcCandidate?:'v1'|null;worldCandidate?:'v1'|null}):Promise<void>{return this.engine.configureCandidates(bookId,options);}
  analyze(bookId:string,ranges?:Range[],options:{profile?:ProfileKind}={}):Promise<void>{return this.engine.analyzeAuthorized(bookId,ranges,options.profile??'analysis');}
  query(bookId:string,text:string,options:{profile?:ProfileKind;conversationId?:string;memoryAllowed?:boolean;long?:boolean}={}):Promise<void>{return this.engine.queryAnalyzed(bookId,text,options.profile??'analysis',options.conversationId,{memoryAllowed:options.memoryAllowed,long:options.long});}
  correctMemory(memoryId:string,text:string):Promise<void>{return this.engine.correctMemory(memoryId,text);}
  reviewFacts(bookId:string,memoryId?:string):Promise<{reviewed:number;unsupported:number}>{return this.engine.reviewFacts(bookId,memoryId);}
  resumeFactReview(taskId:string):Promise<{reviewed:number;unsupported:number}>{return this.engine.resumeFactReview(taskId);}
  cancelFactReview(taskId:string):Promise<void>{return this.engine.cancelFactReview(taskId);}
  async queryMaterials(bookId:string,query='',options:{focusRanges?:Range[];budget?:number;profile?:ProfileKind}={}):Promise<AnalysisMaterials>{
    return this.engine.inspectAnalysisMaterials(bookId,query,options);
  }
  async dossier(bookId:string,request:WorkDossierRequest={}):Promise<WorkDossierResult>{
    const parsed=parseWorkDossierRequest(request);
    return this.engine.withReadOnlyOriginal(bookId,async book=>{
      if(parsed.view!=='full')return projectWorkDossier(this.engine.state,book,parsed);
      const index=projectWorkDossier(this.engine.state,book,{...parsed,view:'index'}),ids=index.items.filter(item=>item.availability==='available').map(item=>item.id);
      return this.engine.withMemoryBodies(ids,()=>projectWorkDossier(this.engine.state,book,parsed));
    });
  }
  async relations(bookId:string,seeds:RelationSeeds,options:{offset?:number;query?:string;profile?:ProfileKind}={}){
    return this.engine.withOriginal(bookId,book=>{const state=this.engine.state;return structuredClone(readStructureRelations(state,book,seeds,{source:'preparation',readingStrategy:options.profile==='full-original'?'full-original':'structured',arcCandidate:book.arcCandidate,worldCandidate:book.worldCandidate,offset:options.offset,query:options.query}).index);});
  }
  recoveryPlan(bookId:string,ranges?:Range[],options:{profile?:ProfileKind}={}){
    return planAnalysisRecovery(this.engine.state,this.engine.book(bookId),{profile:options.profile,requestedRanges:ranges,transport:this.engine.factReviewer&&this.engine.model.completeTools?'agent':'json'});
  }
  status(bookId:string,options:{profile?:ProfileKind}={}){
    const plan=this.recoveryPlan(bookId,undefined,options),state=this.engine.state,book=this.engine.book(bookId);
    return{...plan,entities:entityIndex(state,book,{source:'preparation'}),buffered:structuredClone(book.buffered??[]),pending:structuredClone(plan.unprocessedRanges),drafts:(state.readingDrafts??[]).filter(d=>d.bookId===bookId&&d.partnerId===state.partnerId).map(d=>({id:d.id,ranges:structuredClone(d.ranges),arcCandidate:d.material.arcCandidate,worldCandidate:d.material.worldCandidate})),arcHeads:currentArcs(state,book,{source:'preparation'}),capabilityLimits:['稳定主体由有源声明形成，同名和别名仍须有依据消歧','人物知情仍由有据正文表达，不是完整知识模拟','当前可用弧线头不是全世界同时状态','处理完成不证明24项要素已全面建模']};
  }
  async backup():Promise<string>{
    const base=this.engine.state,copy:State=structuredClone({...base,memories:base.memories.map(({text,...metadata})=>metadata),books:base.books.map(b=>({...b,text:'',textLength:bookLength(b)}))});
    for(let start=0;start<copy.memories.length;start+=64){if(this.engine.state!==base)throw Error('资料已切换，请重新备份');const batch=copy.memories.slice(start,start+64);batch.forEach((m,i)=>{if(base.memories[start+i].text!==undefined)m.text=base.memories[start+i].text;});await hydrateMemoryBodies(this.engine.store,batch);batch.forEach(m=>delete m.bodyRef);}
    for(const book of copy.books){if(this.engine.state!==base)throw Error('资料已切换，请重新备份');book.text=await this.engine.withOriginal(book.id,original=>original.text);}
    if(this.engine.state!==base)throw Error('资料已切换，请重新备份');return JSON.stringify(copy);
  }
}
