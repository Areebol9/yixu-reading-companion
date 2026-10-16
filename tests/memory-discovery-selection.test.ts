import {test} from 'node:test';
import assert from 'node:assert/strict';
import {importBook} from '../src/core/books.ts';
import {evidence} from '../src/core/context.ts';
import {discoverMemoryDocuments,MemoryDiscoveryCache,selectAndReadMemoryDocuments} from '../src/core/memory-discovery.ts';
import {initialState} from '../src/core/state.ts';
import {hashText} from '../src/core/text-hash.ts';
import type {Memory,MemoryBody,MemoryBodyRef} from '../src/core/types.ts';

async function fixture(){
  const state=initialState(),book=await importBook('档案选材工程材料','第一章\n'+'已知设备记录。'.repeat(500));
  book.known=[{start:0,end:book.text.length}];state.books=[book];
  const values=new Map<string,MemoryBody>(),reads:string[]=[],cache=new MemoryDiscoveryCache();
  const make=async(id:string,text:string,start:number):Promise<Memory>=>{
    const hash=await hashText(text),key='memory-body-'+hash;values.set(key,{key,hash,text});
    const memory:Memory={id,bookId:book.id,partnerId:state.partnerId,kind:'opinion',bodyRef:{key,hash,chars:text.length},evidence:[evidence(book,{start:0,end:start+10})],readingStage:[{start,end:start+10}],parents:[],chatIds:[],createdAt:start,forgotten:false,source:'reading'};
    state.memories.push(memory);return memory;
  };
  const readBodies=async(refs:readonly MemoryBodyRef[])=>refs.flatMap(ref=>{reads.push(ref.key);return values.has(ref.key)?[values.get(ref.key)!]:[];});
  return {state,book,make,readBodies,reads,cache,values};
}

test('短实质相关稿优先于同命中但很长的杂稿和仅标题匹配；重复正文不重复占候选',async()=>{
  const f=await fixture();
  await f.make('long','motor storage maintenance '+Array.from({length:800},(_,i)=>'unrelated'+i).join(' '),30);
  await f.make('focused','motor storage maintenance requires separate space',60);
  const titleOnly=await f.make('title-only','unrelated architecture',90);titleOnly.documentTitle='motor storage maintenance';
  const duplicate=await f.make('same-prose','motor storage maintenance requires separate space',120);
  const result=await discoverMemoryDocuments(f.state,f.book,{query:'motor storage maintenance'},f.readBodies,{cache:f.cache});
  assert.equal(result.items[0].id,duplicate.id);assert.equal(result.total,3);
  assert.ok(result.items.findIndex(item=>item.id==='long')>0);assert.ok(result.items.findIndex(item=>item.id==='title-only')>0);
});

test('后继沿明确发展链授权而非形成时间，遇隐藏/失效节点停止且环不回指',async()=>{
  const f=await fixture(),old=await f.make('old','maintenance original rule',10),middle=await f.make('middle','maintenance revised rule',100),latest=await f.make('latest','maintenance current rule',200),later=await f.make('related-later','maintenance another equipment',300);
  old.replacedBy=middle.id;middle.revisionKind='development';middle.correctionOf=old.id;middle.replacedBy=latest.id;latest.revisionKind='development';latest.correctionOf=middle.id;
  let result=await discoverMemoryDocuments(f.state,f.book,{query:'maintenance'},f.readBodies,{cache:f.cache});
  let item=result.items.find(item=>item.id===old.id)!;
  assert.equal(item.directSuccessorId,middle.id);assert.deepEqual(item.developmentChainIds,[middle.id,latest.id]);assert.ok(item.laterDevelopmentIds.includes(later.id));assert.ok(!item.laterDevelopmentIds.includes(latest.id));
  latest.replacedBy=old.id;old.revisionKind='development';
  result=await discoverMemoryDocuments(f.state,f.book,{query:'maintenance'},f.readBodies,{cache:f.cache});assert.deepEqual(result.items.find(item=>item.id===old.id)!.developmentChainIds,[middle.id,latest.id]);
  middle.partnerId='other-partner';
  result=await discoverMemoryDocuments(f.state,f.book,{query:'maintenance'},f.readBodies,{cache:f.cache});item=result.items.find(item=>item.id===old.id)!;
  assert.equal(item.directSuccessorId,undefined);assert.equal(item.developmentChainIds,undefined);
  middle.partnerId=f.state.partnerId;middle.invalidatedBy='withdrawal';
  result=await discoverMemoryDocuments(f.state,f.book,{query:'maintenance'},f.readBodies,{cache:f.cache});assert.equal(result.items.find(item=>item.id===old.id)!.directSuccessorId,undefined);
});

test('跨阶段首包从全部候选选出，冷索引复用仅回读代表稿；旧稿来源排序显式说明形成窗回退',async()=>{
  const f=await fixture();for(let i=0;i<24;i++)await f.make('document-'+i,'equipment maintenance document'+i,20+i*80);
  const chronological=await discoverMemoryDocuments(f.state,f.book,{mode:'coverage',limit:4},f.readBodies,{cache:f.cache});
  assert.ok(chronological.items.every(item=>item.readingStage![0].start<300));
  f.reads.length=0;
  const diverse=await discoverMemoryDocuments(f.state,f.book,{mode:'coverage',selection:'diverse',limit:4},f.readBodies,{cache:f.cache});
  assert.ok(diverse.items.some(item=>item.readingStage![0].start>1400));assert.equal(diverse.items.length,4);assert.equal(diverse.coverage.complete,false);assert.equal(diverse.indexing.reusedBodies,24);assert.equal(f.reads.length,4);
  const sources=await discoverMemoryDocuments(f.state,f.book,{mode:'coverage',rangeBasis:'source',order:'source-asc',limit:1},f.readBodies,{cache:f.cache});
  assert.deepEqual(sources.items[0].sourceRanges,[]);assert.equal(sources.items[0].orderingRangeBasis,'formation');
});

test('自动全文取材在总预算内交错当前、历史配对和覆盖稿，冷正文未写回状态且超限保留剩余',async()=>{
  const f=await fixture(),current=await f.make('current','C'.repeat(20),10),old=await f.make('old','O'.repeat(30),100),latest=await f.make('latest','N'.repeat(40),200),coverage=await f.make('coverage','V'.repeat(30),300);
  old.replacedBy=latest.id;latest.revisionKind='development';latest.correctionOf=old.id;
  const documents=await discoverMemoryDocuments(f.state,f.book,{mode:'coverage'},f.readBodies,{cache:f.cache}),find=(id:string)=>documents.items.find(item=>item.id===id)!;
  f.reads.length=0;
  const material=await selectAndReadMemoryDocuments(f.state,f.book,{currentIds:[current.id],focused:[find(old.id)],coverage:[find(coverage.id),find(old.id)]},f.readBodies,{cache:f.cache},{maxChars:120,maxDocuments:4,includeHistory:true});
  assert.deepEqual(material.items.map(item=>item.id),[current.id,old.id,latest.id,coverage.id]);assert.deepEqual(material.selections.map(item=>item.lane),['current','history','focused','coverage']);assert.equal(material.items.reduce((sum,item)=>sum+item.text.length,0),120);assert.equal(f.reads.length,4);assert.ok(f.state.memories.every(item=>item.text===undefined));
  const limited=await selectAndReadMemoryDocuments(f.state,f.book,{currentIds:[current.id],focused:[find(old.id)],coverage:[find(coverage.id)]},f.readBodies,{cache:f.cache},{maxChars:50,maxDocuments:4});
  assert.deepEqual(limited.items.map(item=>item.id),[current.id,coverage.id]);assert.ok(limited.remainingIds.includes(latest.id));assert.equal(limited.items.reduce((sum,item)=>sum+item.text.length,0),50);
});

test('自动首包跳过超预算大稿并补足有效候选；正文损坏或存储等待撤权不能冒充已取得',async()=>{
  const f=await fixture(),large=await f.make('large','L'.repeat(50),10),missing=await f.make('missing','M'.repeat(10),100),good=await f.make('good','G'.repeat(20),200),extra=await f.make('extra','E'.repeat(20),300);
  const result=await discoverMemoryDocuments(f.state,f.book,{mode:'coverage'},f.readBodies,{cache:f.cache});
  f.values.delete(missing.bodyRef!.key);
  const material=await selectAndReadMemoryDocuments(f.state,f.book,{currentIds:[large.id],focused:result.items.filter(item=>[missing.id,good.id].includes(item.id)),coverage:result.items.filter(item=>item.id===extra.id)},f.readBodies,{cache:f.cache},{maxChars:40});
  assert.deepEqual(material.items.map(item=>item.id),[good.id,extra.id]);assert.ok(material.remainingIds.includes(large.id));assert.ok(material.unavailableIds.includes(missing.id));
  await assert.rejects(selectAndReadMemoryDocuments(f.state,f.book,{currentIds:[good.id]},async refs=>{const values=await f.readBodies(refs);f.book.known=[];return values;},{cache:f.cache}),/许可|身份/);
});

test('自动真实后继回取在已索引冷稿文本遗忘处停链，不泄露被屏蔽后继或跨过它',async()=>{
  const f=await fixture(),old=await f.make('old','maintenance original arrangement',10),hidden=await f.make('hidden','maintenance protected wish',100),latest=await f.make('latest','maintenance later arrangement',200);
  old.replacedBy=hidden.id;hidden.revisionKind='development';hidden.replacedBy=latest.id;latest.revisionKind='development';
  const page=await discoverMemoryDocuments(f.state,f.book,{query:'maintenance'},f.readBodies,{cache:f.cache}),before=page.items.find(item=>item.id===old.id)!;
  f.state.forgotten.push({id:'text-forgetting',bookId:f.book.id,text:'protected wish',time:3});
  const material=await selectAndReadMemoryDocuments(f.state,f.book,{focused:[before]},f.readBodies,{cache:f.cache});
  assert.deepEqual(material.items.map(item=>item.id),[old.id]);assert.deepEqual(material.selections.map(item=>item.id),[old.id]);assert.deepEqual(material.unavailableIds,[]);assert.deepEqual(material.remainingIds,[]);
});
