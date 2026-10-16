import test from 'node:test';
import assert from 'node:assert/strict';
import { currentProcessEvents,groupProcessEvents } from '../src/workbench/process-events.ts';
import type { WorkbenchEvent } from '../src/workbench/contract.ts';
const event=(id:string,extra={}):WorkbenchEvent=>({id,kind:'status',title:'ENGINE MOCK state',detail:'ENGINE MOCK exact duplicate',mode:'live',at:Number(id)||1,clockMs:0,clockDomain:'current',...extra});

test('纯重复事件聚合但不同真实请求不混并，原事件原字节保持',()=>{
 const original=Array.from({length:200},(_,index)=>event(String(index))),bytes=JSON.stringify(original),groups=groupProcessEvents(original);
 assert.equal(groups.length,1);assert.equal(groups[0].count,200);assert.equal(groups[0].event.id,'199');assert.equal(JSON.stringify(original),bytes);
 assert.equal(groupProcessEvents([event('1',{requestId:'a'}),event('2',{requestId:'b'})]).length,2);
 assert.equal(groupProcessEvents([event('1',{elapsedMs:10}),event('2',{elapsedMs:20})]).length,2);
});
test('本次相关沿实际活动与话题身份，旧未知活动仍可达、已消费请求事件留历史，不凭年代猜完成',()=>{
 const events=[event('old-active',{requestId:'unresolved',at:1,clockDomain:'past'}),event('consumed',{requestId:'already-consumed',at:200}),event('chat',{chatId:'current-chat',at:150}),event('old-chat',{chatId:'other-chat',at:150}),event('generic-current',{at:200}),event('generic-past',{at:20})],snapshot={events,book:{id:'book'},app:{session:{id:'conversation'},activities:[{bookId:'book',stage:'unknown',requestId:'unresolved'}],state:{chats:[{id:'current-chat',bookId:'book',sessionId:'conversation'},{id:'other-chat',bookId:'book',sessionId:'past'}],conversations:[{id:'conversation',bookId:'book',createdAt:100}]}}} as any;
 assert.deepEqual(currentProcessEvents(snapshot).map(item=>item.id),['old-active','chat','generic-current']);assert.equal(snapshot.events.length,6);
});
