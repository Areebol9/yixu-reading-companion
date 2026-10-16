import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState} from '../src/core/state.ts';
import {importBook} from '../src/core/books.ts';
import {evidence} from '../src/core/context.ts';
import {planMemories} from '../src/core/memory-plan.ts';
import {maintenanceUnderstandingErrors,submittedUnderstandingMemoryIds,maintenanceViewBasisErrors} from '../src/core/reading-continuity.ts';
import {planPublishedViews} from '../src/core/published-views.ts';
import {prepareMemoryIdentities} from '../src/core/memory-identity.ts';

test('新正文不能只提交概要；完整认识原样复用不凑新稿，纯概要不造认识',async()=>{
 const state=initialState(),book=await importBook('工程登记','第一章 登记\n登记已经完成。');state.books=[book];book.known=[{start:book.text.indexOf('\n')+1,end:book.text.length}];const claim={ranges:book.known};
 const empty=planMemories(state,book,{reply:'',thoughts:[],wantsLong:false},[evidence(book,book.known[0])],[],[],'reading');
 assert.match(maintenanceUnderstandingErrors(state,book,claim,empty)[0],/不能仅凭两份概要推进prepared/);
 const reply={reply:'',thoughts:[{kind:'opinion' as const,text:'登记已完成，后续移交仍待核实。'}],wantsLong:false};
 const added=planMemories(state,book,reply,[evidence(book,book.known[0])],[],[],'reading',undefined,[],book.known,new Map(),book.known);
 assert.equal(added.added.length,1);assert.deepEqual(maintenanceUnderstandingErrors(state,book,claim,added),[]);state.memories.push(...added.added);
 const reused=planMemories(state,book,reply,[evidence(book,book.known[0])],[],[],'reading',undefined,[],book.known,new Map(),book.known);
 assert.equal(reused.added.length,0);assert.equal(reused.reused.length,1);assert.deepEqual(maintenanceUnderstandingErrors(state,book,claim,reused),[]);
 assert.deepEqual(maintenanceUnderstandingErrors(state,book,{ranges:[]},empty),[]);book.prepared=book.known;assert.deepEqual(maintenanceUnderstandingErrors(state,book,claim,empty),[]);
});

test('本批完整opinion原样复用可支持双概要keep，只有reinforce或提供旧m不算提交',async()=>{
 const state=initialState(),book=await importBook('复用工程','第一章 登记\n工程登记已经完成。');state.books=[book];book.known=[{start:book.text.indexOf('\n')+1,end:book.text.length}];const refs=[evidence(book,book.known[0])],reply={reply:'',thoughts:[{kind:'opinion' as const,text:'工程登记已经完成，继续保留复核责任。'}],wantsLong:false};
 const original=planMemories(state,book,reply,refs,[],[],'reading',undefined,[],book.known,new Map(),book.known);state.memories.push(...original.added);await prepareMemoryIdentities(state.memories);const m=state.memories[0];
 const first=await planPublishedViews(state,book,(['overview','current'] as const).map(kind=>({kind,key:kind,text:'工程概要。',sourceMemoryIds:[m.id]})),[m],[],[],new Map(),refs);state.publishedViews=first.added;state.viewPublications=[first.publication!];
 const reused=planMemories(state,book,reply,refs,[],[],'reading',undefined,[],book.known,new Map(),book.known),submitted=submittedUnderstandingMemoryIds(state,book,reused);assert.equal(reused.added.length,0);assert.deepEqual(submitted,[m.id]);
 const proposals=first.added.map(v=>({operation:'keep' as const,kind:v.kind,key:v.key,previousId:v.id,sourceViewIds:[v.id],sourceMemoryIds:[reused.proposalMemoryIds!.t1]}));
 const kept=await planPublishedViews(state,book,proposals,[m],first.added.map(v=>v.id),[],new Map(),refs,{memoryIds:[],chatIds:[],evidence:[],submittedMemoryIds:submitted});const claim={hash:'a'.repeat(64),viewReviewVersion:1 as const,ranges:book.known,chatIds:[],viewTargets:first.added.map(v=>`view:${v.id}` as const)};
 assert.deepEqual(maintenanceViewBasisErrors(state,book,claim,kept.added,submitted,[m.id],[]),[]);assert.equal(maintenanceViewBasisErrors(state,book,claim,kept.added,[],[m.id],[]).length,2);
 const reinforced=planMemories(state,book,{reply:'',thoughts:[],wantsLong:false,reinforce:[m.id]},refs,[m.id],[],'reading');assert.deepEqual(submittedUnderstandingMemoryIds(state,book,reinforced),[]);
});
