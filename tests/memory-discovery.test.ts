import {test} from 'node:test';
import assert from 'node:assert/strict';
import {importBook} from '../src/core/books.ts';
import {evidence} from '../src/core/context.ts';
import {discoverMemoryDocuments,MemoryDiscoveryCache,readMemoryDocuments} from '../src/core/memory-discovery.ts';
import {initialState} from '../src/core/state.ts';
import {hashText} from '../src/core/text-hash.ts';
import type {Memory,MemoryBody,MemoryBodyRef} from '../src/core/types.ts';

async function fixture(count=12){
  const state=initialState(),book=await importBook('独立阅读档案工程材料','第一章 已读\n'+'工程材料。'.repeat(300)+'\n第二章 尚未读\n私有后文。');
  book.known=[{start:0,end:book.chapters[1].start}];state.books=[book];
  const values=new Map<string,MemoryBody>(),readIds:string[]=[];
  const make=async(id:string,text:string,stage={start:20,end:40}):Promise<Memory>=>{
    const hash=await hashText(text),key='memory-body-'+hash;values.set(key,{key,hash,text});
    return {id,bookId:book.id,partnerId:state.partnerId,kind:'opinion',bodyRef:{key,hash,chars:text.length},evidence:[evidence(book,{start:0,end:stage.end})],readingStage:[stage],parents:[],chatIds:[],createdAt:stage.start,forgotten:false,source:'reading'};
  };
  for(let i=0;i<count;i++)state.memories.push(await make('archive-'+i,'文档编号'+i+'。\n'+(i===0?'工位甲需要独立空间，并为备用设备保留稳定供电。':'设备文档编号 '+i+' 描述维护事项。'),{start:20+i*50,end:40+i*50}));
  const readBodies=async(refs:readonly MemoryBodyRef[])=>refs.flatMap(ref=>{readIds.push(ref.key);const value=values.get(ref.key);return value?[value]:[];});
  return {state,book,values,readIds,readBodies,make};
}

test('独立全文自然段被发现，目录不授全文权；hash侧车冷恢复只读本页命中而增量只扫描新增正文',async()=>{
  const {state,book,values,readIds,readBodies,make}=await fixture(),cache=new MemoryDiscoveryCache();
  const query={query:'工位甲空间',mode:'focused' as const};
  const first=await discoverMemoryDocuments(state,book,query,readBodies,{cache});
  assert.equal(first.total,1);assert.equal(first.items[0].id,'archive-0');assert.equal(first.items[0].navigationOnly,true);assert.equal(first.coverage.complete,false);
  const hit=first.items[0].paragraphHits[0],text=values.get(state.memories[0].bodyRef!.key)!.text;
  assert.equal(text.slice(hit.start,hit.end),'工位甲需要独立空间，并为备用设备保留稳定供电。');assert.equal(text.slice(hit.excerptStart,hit.excerptEnd),hit.text);
  // Twelve cold entries plus one re-read: the early hit has left the bounded body cache.
  assert.equal(first.indexing.readBodies,13);assert.equal(state.memories[0].text,undefined);
  const restored=new MemoryDiscoveryCache();restored.import(JSON.parse(JSON.stringify(cache.export())));readIds.length=0;
  const warm=await discoverMemoryDocuments(state,book,query,readBodies,{cache:restored});
  assert.equal(warm.indexing.reusedBodies,12);assert.equal(readIds.length,1);assert.deepEqual(warm.items,first.items);
  state.memories.push(await make('new-document','最新工程材料。另有独立附录。',{start:700,end:720}));readIds.length=0;
  await discoverMemoryDocuments(state,book,query,readBodies,{cache:restored});assert.equal(readIds.length,2);
  const full=await readMemoryDocuments(state,book,['archive-0'],readBodies);assert.equal(full.items[0].text,text);assert.equal(state.memories[0].text,undefined);
});

test('权限与更正遗忘先于正文读取，形成窗和来源坐标分别导航；阅读档案整体分页去重保持明确覆盖',async()=>{
  const {state,book,readIds,readBodies,make}=await fixture(3),original=state.memories[0];
  state.memories.push({...original,id:'duplicate',createdAt:999},
    {...original,id:'future',evidence:[evidence(book,book.chapters[1])]},
    {...original,id:'other-book',bookId:'other'},{...original,id:'other-partner',partnerId:'other'},
    {...original,id:'forgotten',forgotten:true},{...original,id:'corrected',replacedBy:'replacement'},
    {...original,id:'background',source:'background'});
  state.memories.push({...await make('replacement','修订后的完整理解。',{start:200,end:220}),source:'correction'});
  const first=await discoverMemoryDocuments(state,book,{mode:'coverage',limit:1},readBodies);
  assert.equal(first.total,4);assert.ok(first.nextCursor);assert.equal(first.items[0].id,'duplicate');assert.ok(first.coverage.eligibleDocuments<state.memories.length);
  assert.equal(readIds.length,5);const ids=[first.items[0].id];let cursor=first.nextCursor;
  while(cursor){const page=await discoverMemoryDocuments(state,book,{mode:'coverage',limit:1,cursor},readBodies);ids.push(...page.items.map(x=>x.id));cursor=page.nextCursor;}
  assert.equal(new Set(ids).size,4);assert.equal(ids.includes('archive-0'),false);
  const formation=await discoverMemoryDocuments(state,book,{mode:'coverage',range:{start:100,end:130}},readBodies);assert.deepEqual(formation.items.map(x=>x.id),['archive-2']);
  const source=await discoverMemoryDocuments(state,book,{mode:'coverage',range:{start:100,end:130},rangeBasis:'source'},readBodies);assert.deepEqual(source.items,[]);
  book.known=[];await assert.rejects(discoverMemoryDocuments(state,book,{mode:'coverage',limit:1,cursor:first.nextCursor},readBodies),/许可|权限/);
});

test('全文校验hash/长度，metadata查询及侧车不能冒充正文；存储等待期间撤权或身份改变拒绝整页',async()=>{
  const {state,book,values,readBodies}=await fixture(1),ref=state.memories[0].bodyRef!;
  values.set(ref.key,{key:ref.key,hash:ref.hash,text:'伪造内容'});
  const broken=await readMemoryDocuments(state,book,['archive-0'],readBodies);assert.deepEqual(broken.items,[]);assert.deepEqual(broken.unavailableIds,['archive-0']);
  values.set(ref.key,{key:ref.key,hash:ref.hash,text:'伪'.repeat(ref.chars)});
  assert.deepEqual((await discoverMemoryDocuments(state,book,{mode:'coverage'},readBodies)).items,[]);
  const inline='有来源的完整阅读稿。';state.memories[0]={...state.memories[0],text:inline,bodyRef:undefined};
  const hash=await hashText(inline);state.memories[0]={...state.memories[0],text:undefined,bodyRef:{key:ref.key,hash,chars:inline.length}};values.set(ref.key,{key:ref.key,hash,text:inline});
  await assert.rejects(readMemoryDocuments(state,book,['archive-0'],async refs=>{const result=await readBodies(refs);book.known=[];return result;}),/许可/);
  book.known=[{start:0,end:book.chapters[1].start}];
  await assert.rejects(discoverMemoryDocuments(state,book,{mode:'coverage'},async refs=>{const result=await readBodies(refs);state.partnerId='other';return result;}),/许可|身份/);
});

test('文本遗忘在冷索引和热索引中都屏蔽完整旧稿，中文断句跨界仍按实际正文复核',async()=>{
  const {state,book,readBodies}=await fixture(1),cache=new MemoryDiscoveryCache();
  await discoverMemoryDocuments(state,book,{mode:'coverage'},readBodies,{cache});
  state.forgotten.push({id:'detached-forgetting',bookId:book.id,text:'工位甲。需要',time:2});
  const result=await discoverMemoryDocuments(state,book,{query:'工位甲'},readBodies,{cache});
  assert.equal(result.total,0);assert.equal(result.coverage.eligibleDocuments,0);assert.deepEqual(result.coverage.unavailableBodyIds,[]);
});

test('明确全文成组按预算保留剩余IDs，首份大稿完整展开；索引导入错误不覆盖有效cache',async()=>{
  const {state,book,readBodies,make}=await fixture(0);state.memories.push(await make('large','正文。'.repeat(9000)),await make('second','第二份正文。'),await make('third','第三份正文。'));
  const page=await readMemoryDocuments(state,book,['large','second','third','missing'],readBodies);
  assert.equal(page.items[0].text.length,27000);assert.deepEqual(page.remainingIds,['second','third']);assert.deepEqual(page.unavailableIds,['missing']);
  const cache=new MemoryDiscoveryCache();await discoverMemoryDocuments(state,book,{mode:'coverage'},readBodies,{cache});const saved=cache.export();
  assert.throws(()=>cache.import({schema:1,entries:[{hash:'invalid',chars:1,terms:[],forgetTerms:[],paragraphs:[]}]}));assert.deepEqual(cache.export(),saved);
  const corrupted=structuredClone(saved);corrupted.entries[0].paragraphs[0].end=900000;assert.throws(()=>cache.import(corrupted));
});
