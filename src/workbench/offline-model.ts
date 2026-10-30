import type {AgentModelReply,ModelPort,ModelReply,ModelMessage,ModelTool} from '../core/types.ts';
import {decodeMaterialInput,materialEnvelopeParts} from '../core/material-input.ts';
export const offlineGuide={title:'测试台操作指南（技术样本）',text:'第一章 阅读位置与范围\n换章和章节跳转用于浏览。点击“开始跟随阅读”后，伙伴只接上屏幕中实际可见的正文，下方文字随滚动接上。中途加入时，先用“接上前文”确认自己实际读过的范围，跳过的空缺不会自动补上。\n\n第二章 交流与控制\n输入问题并发送，可以演练交流操作。安静时继续理解，明确提问仍可回应。暂停后停止跟读新内容，已发出的回复仍会接收并保存；继续后接着处理，结束时保存已有结果并停止本次共读。\n\n第三章 体验备注\n从回复旁“记下感受”或输入区下方“记下这次感受”记录实际体验。也可以只写备注。首个可见回应和有帮助标记分别记录。离线场次使用固定技术回应，外部模型调用为零，只用于界面操作演练。\n\n第四章 导入与保存\n在书架中添加文本书籍，确认章节与当前阅读位置后，可选择模型服务并开始共读。完整便携备份用于显式导入已有资料；导入后保留原文件，检查读点、交流、伙伴理解与累计用量。暂停或退出时等待已发出的回复并保存，重新打开后点击继续伴读。'};
export const offlineReply='【界面演练】这是固定技术回应，用于检查换章、授权、交流与人工记录；本轮外部模型调用为零。';
const offlineUnderstanding='【界面演练】本包技术材料用于验证阅读位置、许可、文档与概要的正常保存链路。这是固定模拟认识，不代表真实作品理解或真人体验。';
function packets(messages:ModelMessage[]):any[]{
 const expand=(value:unknown):any[]=>{
  if(typeof value==='string')return decodeMaterialInput(value).flatMap(expand);
  if(Array.isArray(value))return value.flatMap(expand);
  if(!value||typeof value!=='object')return[];
  const parts=materialEnvelopeParts(value);return parts!==undefined?parts.flatMap(expand):[value];
 };
 return messages.filter(message=>message.role==='user'||message.role==='tool').flatMap(message=>expand(message.content));
}
function documentResult(messages:ModelMessage[]){
 const values=packets(messages),packet=values.find(value=>value.task==='maintenance');
 const sourceIds=[...new Set(messages.filter(message=>message.role==='user'||message.role==='tool').flatMap(message=>[...message.content.matchAll(/【(p[1-9]\d*)】/gu)].map(match=>match[1])))];
 if(!sourceIds.length)throw Error('离线阅读演练缺少本轮实际原文编号，保留任务并停止模拟提交');
 const documents=[{operation:'create',text:offlineUnderstanding,organization:{roles:['opinion'],subject:null},sourceIds}];
 if(!packet)return{documents};
 const views=(packet.viewTargets??[]).map((target:string)=>{
  const old=(packet.views??[]).find((view:any)=>view.id===target||view.kind===target);
  return{decision:'publish',...(old?{target:old.id}:{kind:target,key:target}),text:'【界面演练】本批技术材料的正常文档提交与概要检查。',sourceMemoryIds:['t1'],sourceIds};
 });
 return{documents,views};
}
export class OfflineModel implements ModelPort {
 async complete(_service:unknown,_messages:unknown,signal:AbortSignal):Promise<ModelReply>{signal.throwIfAborted();return {content:JSON.stringify({reply:offlineReply,thoughts:[],wantsLong:false}),input:0,output:0,estimated:false,elapsedMs:0};}
 async completeTools(_service:unknown,messages:ModelMessage[],tools:ModelTool[],signal:AbortSignal):Promise<AgentModelReply>{
  signal.throwIfAborted();const terminal=tools.find(tool=>tool.name==='finish_reading'),properties=terminal?.parameters.properties as Record<string,unknown>|undefined;
  const calls=new Map(messages.flatMap(message=>(message.tool_calls??[]).map(call=>[call.id,call.function.name] as const)));
  const lastResult=messages.slice().reverse().find(message=>message.role==='tool'&&calls.get(message.tool_call_id??'')==='finish_reading');
  if(lastResult?.content.includes('概要版本尚无实际完整供入回执')&&tools.some(tool=>tool.name==='read_published_views')){
   const ids=[...new Set(lastResult.content.match(/\bv[1-9]\d*\b/gu)??[])];
   if(!ids.length)throw Error('离线概要取回反馈缺少实际版本编号，原任务保持');
   const priorFailure=messages.slice(0,messages.indexOf(lastResult)).map((message,index)=>({message,index})).reverse().find(({message})=>message.role==='tool'&&calls.get(message.tool_call_id??'')==='finish_reading'&&message.content.includes('概要版本尚无实际完整供入回执'));
   if(priorFailure&&messages.slice(priorFailure.index+1,messages.indexOf(lastResult)).some(message=>message.tool_calls?.some(call=>{if(call.function.name!=='read_published_views')return false;try{const read=JSON.parse(call.function.arguments);return ids.every(id=>read.ids?.includes(id));}catch{return false;}})))throw Error('离线演练已按原反馈取回概要，但原提交仍无全文回执；停止重复模拟并保留原任务');
   const laterRead=messages.slice(messages.indexOf(lastResult)+1).some(message=>message.tool_calls?.some(call=>call.function.name==='read_published_views'));
   if(!laterRead)return{content:'',toolCalls:[{id:crypto.randomUUID(),type:'function',function:{name:'read_published_views',arguments:JSON.stringify({ids})}}],finish:'tool_calls',reasoning:'',input:0,output:0,estimated:false,elapsedMs:0};
  }
  if(properties?.quiet||properties?.documents){const value=properties.quiet?{quiet:true}:documentResult(messages);return{content:'',toolCalls:[{id:crypto.randomUUID(),type:'function',function:{name:'finish_reading',arguments:JSON.stringify(value)}}],finish:'tool_calls',reasoning:'',input:0,output:0,estimated:false,elapsedMs:0};}
  return {content:offlineReply,toolCalls:[],finish:'stop',reasoning:'',input:0,output:0,estimated:false,elapsedMs:0};
 }
}
