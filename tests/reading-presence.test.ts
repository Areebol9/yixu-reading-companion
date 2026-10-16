import test from 'node:test';
import assert from 'node:assert/strict';
import { readingStatusPresentation, activityTime, resumableMaintenanceJob } from '../src/workbench/activity-presentation.ts';
import type { Activity } from '../src/workbench/activity-presentation.ts';
const activity=(id:string,kind:Activity['kind'],stage:Activity['stage']):Activity=>({id,bookId:'book',partnerId:'partner',kind,stage,purpose:kind==='maintenance'?'deep-maintenance':'scene-judgment',since:1000,startedAt:1000,updatedAt:2000});
const app=(activities:Activity[],extra={})=>({activities,state:{chats:[]},maintenanceProgress:[],readingControl:{state:'running',inFlight:0},...extra}) as any;

test('七份旧异常合并一个行动入口，全部原记录可查且不运行计时',()=>{
 const activities=Array.from({length:7},(_,i)=>activity(String(i),'maintenance',i%2?'failed':'unknown')),view=readingStatusPresentation(app(activities),'book',false);
 assert.equal(view.chips.length,0);assert.equal(view.needsAttention,true);assert.equal(view.attentionLabel,'理解整理待继续');assert.equal(view.all.length,7);
 for(const item of activities)assert.equal(activityTime(item,5000),activityTime(item,500000000));
});
test('真实并行职责全部可见，已收待发表独立于生成中；暂停仍显示真实问答',()=>{
 const activities=[activity('q','question','waiting-model'),activity('s','scene','tools'),activity('m','maintenance','saving'),activity('e','expression','waiting-publish')],view=readingStatusPresentation(app(activities),'book',true);
 assert.deepEqual(view.chips.map(chip=>chip.kind),['question','scene','maintenance','expression']);assert.equal(view.chips.filter(chip=>chip.working).length,3);assert.equal(view.chips[3].working,false);
 const paused=readingStatusPresentation(app([activities[0],activity('queued','scene','queued')],{readingControl:{state:'paused',inFlight:1}}),'book',false);assert.deepEqual(paused.chips.map(chip=>chip.kind),['question']);assert.equal(paused.needsAttention,true);
});
test('历史排队不会变成正在处理，当前明确问题只标等待；未开启且无事项不占位',()=>{
 const pending={...activity('q','question','queued'),questionId:'q'},old={...activity('old','question','queued'),questionId:'old'};
 const data=app([pending,old,activity('m','maintenance','queued')],{session:{id:'current'},state:{chats:[{id:'q',delivery:'pending',sessionId:'current'},{id:'old',delivery:'pending',sessionId:'past'}]}}),view=readingStatusPresentation(data,'book',false);
 assert.equal(view.chips.length,1);assert.equal(view.chips[0].label,'等待回应你');assert.equal(view.chips[0].working,false);assert.equal(view.attention.length,2);
 const idle=readingStatusPresentation(app([]),'book',false);assert.equal(idle.idle,false);assert.equal(idle.needsAttention,false);assert.equal(idle.chips.length,0);
});
test('已有直接现场恢复入口不重复铺提示，其它整理事项继续可见',()=>{
 const scene=activity('s','scene','failed');assert.equal(readingStatusPresentation(app([scene]),'book',false,true).needsAttention,false);
 assert.equal(readingStatusPresentation(app([scene,activity('m','maintenance','unknown')]),'book',false,true).needsAttention,true);
 assert.notEqual(activityTime(activity('live','question','waiting-model'),5000),activityTime(activity('live','question','waiting-model'),8000));
});

test('继续整理仅提供给当前真实blocked任务，暂停pending/running、在途owner和孤立记录均不伪造恢复操作',()=>{
 const item={...activity('old','maintenance','paused'),jobId:'job'},data=app([item],{session:{active:true,mode:'reading',bookId:'book'},state:{partnerId:'partner',books:[{id:'book',version:'v'}],chats:[],maintenanceJobs:[{id:'job',bookId:'book',version:'v',partnerId:'partner',status:'blocked'}]}});
 assert.equal(resumableMaintenanceJob(data,item),'job');
 for(const status of['pending','running']){const changed=structuredClone(data);changed.state.maintenanceJobs[0].status=status;assert.equal(resumableMaintenanceJob(changed,item),undefined);}
 assert.equal(resumableMaintenanceJob({...data,activities:[item,activity('owner','maintenance','waiting-model')]},item),undefined);
 const gated=structuredClone(data);gated.state.maintenanceJobs.push({...gated.state.maintenanceJobs[0],id:'gated-owner',status:'running'});gated.activities.push(activity('owner','maintenance','queued'));assert.equal(resumableMaintenanceJob(gated,item),undefined);
 assert.equal(resumableMaintenanceJob(data,{...item,jobId:'orphan'}),undefined);
});
