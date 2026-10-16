import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState} from '../src/core/state.ts';
import {importBook} from '../src/core/books.ts';
import {prepareMemoryIdentities} from '../src/core/memory-identity.ts';
import {planPublishedViews,parseViewProposals,coreViewHeads,coreViewMergeGroups,currentPublishedViews,maintenanceViewTargetComplete,resolveMaintenanceViewTargets,validatePublishedViews,viewDescendsFrom} from '../src/core/published-views.ts';
import {checkedMaintenanceRanges,maintenanceCoreTargets} from '../src/core/reading-continuity.ts';
import {readingDocumentsTool,isReadingViewCapacityUpgrade,readingFeedback} from '../src/core/reading-output.ts';
import {remainingMaintenanceJob} from '../src/core/maintenance-recovery.ts';
import {ReadingEngine} from '../src/core/engine.ts';
import type {Memory,PublishedView,Usage} from '../src/core/types.ts';

async function fixture(){
 const state=initialState(),book=await importBook('概要接续工程','第一章 登记\n工程登记已经完成。第二项仍待复核。');book.known=[{start:book.text.indexOf('\n')+1,end:book.text.length}];state.books=[book];
 const memory:Memory={id:'full-technical-memory',kind:'opinion',text:'工程登记完成，保留后续复核条件。',bookId:book.id,partnerId:state.partnerId,source:'reading',evidence:book.known.map(r=>({...r,bookId:book.id,version:book.version})),parents:[],chatIds:[],createdAt:1,forgotten:false};state.memories=[memory];await prepareMemoryIdentities(state.memories);
 const first=await planPublishedViews(state,book,['overview','current'].map(kind=>({kind:kind as 'overview'|'current',key:kind+'主概要',text:'工程登记待复核。',sourceMemoryIds:[memory.id]})),[memory],[],[],new Map(),memory.evidence);state.publishedViews=first.added;state.viewPublications=[first.publication!];return{state,book,memory,first};
}

test('已有核心头拒绝不同key重新初始化及同key无前继覆盖；正常真实前继接续保持链',async()=>{
 const {state,book,memory,first}=await fixture(),old=first.added[0];
 for(const key of [old.key,'另一个自由名称'])await assert.rejects(planPublishedViews(state,book,[{kind:old.kind,key,text:'本轮检查完成。',sourceMemoryIds:[memory.id]}],[memory],[old.id],[],new Map(),memory.evidence),/已有核心概要/);
 const next=await planPublishedViews(state,book,[{kind:old.kind,key:old.key,previousId:old.id,text:'本轮检查完成。',sourceMemoryIds:[memory.id]}],[memory],[old.id],[],new Map(),memory.evidence);assert.equal(next.added[0].previousId,old.id);assert.equal(next.publication!.viewIds.includes(old.id),false);assert.equal(next.publication!.viewIds.includes(first.added[1].id),true);
});

test('五个实际初始化分支须一对显式归并后继；旧稿/同claim核对凭据及未定账本保留',async()=>{
 const {state,book,memory,first}=await fixture();
 // A legacy archive contains repeated kind-only initialization commits.
 const extra:PublishedView[]=[{...structuredClone(first.added[0]),id:'legacy-overview-2',key:'旧初始化总体二'},{...structuredClone(first.added[1]),id:'legacy-current-2',key:'旧初始化当前二'},{...structuredClone(first.added[1]),id:'legacy-current-3',key:'旧初始化当前三'}];
 state.publishedViews!.push(...extra);state.viewPublications![0].viewIds.push(...extra.map(v=>v.id));
 const committed=(id:string,viewIds:string[]):Usage=>({id,status:'complete',requestKey:JSON.stringify([book.id,book.version,state.partnerId,'reading',book.known,'maintenance',id,'a'.repeat(64)]),maintenanceDispatch:{request:{maintenanceJobId:id},claim:{hash:'a'.repeat(64),ranges:book.known,chatIds:[],viewTargets:['overview','current'],viewReviewVersion:1},committed:{viewIds}}} as unknown as Usage);
 state.usage=[committed('init-1',first.added.map(v=>v.id)),committed('init-2',extra.slice(0,2).map(v=>v.id)),committed('init-3',[extra[2].id])];
 const heads=coreViewHeads(state,book),ids=heads.map(v=>v.id),targets=ids.map(id=>('view:'+id) as const);assert.equal(heads.length,5);assert.equal(maintenanceCoreTargets(state,book).length,5);assert.deepEqual(coreViewMergeGroups(state,book).map(g=>g.heads.length),[2,3]);
 const engine=new ReadingEngine(state,{async load(){return state;},async save(){}},{async complete(){throw Error('No external model');}}),ctx:any={viewIds:[],refs:[]};assert.equal((engine as any).supplementMaintenanceHeads(book,ctx),true);const supplied=JSON.stringify(ctx.maintenanceSupplement.affectedViews);assert.equal((engine as any).supplementMaintenanceHeads(book,ctx),false);assert.equal(JSON.stringify(ctx.maintenanceSupplement.affectedViews),supplied,'cold acceptance and catch share pending full materials');assert.equal(ctx.maintenanceSupplement.affectedViews.length,5);engine.stop();
 const separate=heads.map(v=>({kind:v.kind,key:v.key,previousId:v.id,text:'各自更新。',sourceMemoryIds:[memory.id]}));await assert.rejects(planPublishedViews(state,book,separate,[memory],ids,[],new Map(),memory.evidence),/多个待归并头/);
 const proposals=['overview','current'].map(kind=>{const group=heads.filter(v=>v.kind===kind);return{kind:kind as 'overview'|'current',key:group[0].key,previousId:group[0].id,mergePreviousIds:group.slice(1).map(v=>v.id),sourceViewIds:group.map(v=>v.id),sourceMemoryIds:[memory.id],text:'已核对全部旧稿并归并同一工程职责。'};});
 const merge=await planPublishedViews(state,book,parseViewProposals(proposals),[memory],ids,[],new Map(),memory.evidence);assert.equal(merge.publication!.viewIds.length,2);for(const target of targets)assert.equal(maintenanceViewTargetComplete(state,book,target,merge.added),true);
 const unpaid={id:'retained-unknown',status:'unknown',maintenanceDispatch:{request:{maintenanceJobId:'frozen-owner'},claim:{hash:'frozen-hash'},committed:undefined}} as unknown as Usage;state.usage.push(unpaid);const beforeUnknown=JSON.stringify(unpaid);
 state.publishedViews!.push(...merge.added);state.viewPublications=[merge.publication!];validatePublishedViews(state);assert.equal(state.publishedViews!.length,7);assert.equal(currentPublishedViews(state,book).length,2);assert.deepEqual(checkedMaintenanceRanges(state,book).both,book.known);assert.equal(resolveMaintenanceViewTargets(state,book,targets).length,2);
 const pending={id:'unclaimed-view-debt',bookId:book.id,version:book.version,partnerId:state.partnerId,status:'pending' as const,createdAt:1,ranges:[],chatIds:[],viewTargets:targets};assert.equal(remainingMaintenanceJob(state,pending),undefined);
 const frozen={...pending,id:'frozen-owner',status:'blocked' as const,pendingDispatch:{usageId:unpaid.id,payloadHash:'old'}};assert.equal(remainingMaintenanceJob(state,frozen),frozen);assert.equal(JSON.stringify(unpaid),beforeUnknown);
 const withoutMerge={...merge.added[0],mergePreviousIds:undefined};assert.equal(viewDescendsFrom(state,withoutMerge,extra[0].id),false,'supplied viewSources do not prove a merge');
});

test('未证明为重复初始化的旧作用域既不强并，也不阻塞其真实前继更新',async()=>{
 const {state,book,memory,first}=await fixture(),old=first.added[0],independent={...structuredClone(old),id:'independent-legacy-overview',key:'独立旧作用域'};state.publishedViews!.push(independent);state.viewPublications![0].viewIds.push(independent.id);assert.deepEqual(coreViewMergeGroups(state,book),[]);
 const next=await planPublishedViews(state,book,[{kind:old.kind,key:old.key,previousId:old.id,sourceMemoryIds:[memory.id],text:'继续核对主职责。'}],[memory],[old.id],[],new Map(),memory.evidence);assert.equal(next.publication!.viewIds.includes(independent.id),true);assert.equal(next.publication!.viewIds.includes(old.id),false);
});

test('归并只认实际额外前继与明确采用；可选schema升级严格且反馈不重复正文',async()=>{
 const {state,book,memory,first}=await fixture(),old=first.added[0];
 assert.throws(()=>parseViewProposals([{kind:'topic',key:'独立专题',previousId:old.id,mergePreviousIds:['other'],sourceViewIds:['other'],sourceMemoryIds:[memory.id],text:'专题。'}]),/归并/);
 assert.throws(()=>parseViewProposals([{kind:'overview',key:old.key,previousId:old.id,mergePreviousIds:['missing'],sourceMemoryIds:[memory.id],text:'概要。'}]),/归并/);
 const current=structuredClone({name:readingDocumentsTool.name,description:readingDocumentsTool.description,parameters:readingDocumentsTool.parameters}),legacy=structuredClone(current);delete (legacy.parameters.properties as any).views.items.properties.mergePreviousIds;assert.equal(isReadingViewCapacityUpgrade(legacy,current),true);
 const changed=structuredClone(current);(changed.parameters.properties as any).views.items.properties.mergePreviousIds.description+='其他含义';assert.equal(isReadingViewCapacityUpgrade(legacy,changed),false);const permission=structuredClone(current);(permission.parameters.properties as any).views.items.properties.sourceMemoryIds.items.type='number';assert.equal(isReadingViewCapacityUpgrade(legacy,permission),false);
 const feedback=readingFeedback({accepted:false,errors:['真实字段错误'],expressionDelivery:{paragraphComments:[],reaction:undefined}});assert.deepEqual(feedback.errors,['真实字段错误']);assert.equal('reason'in feedback,false);assert.equal('reaction'in feedback.expressionDelivery,false);
});
