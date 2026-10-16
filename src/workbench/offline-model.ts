import type {AgentModelReply,ModelPort,ModelReply} from '../core/types.ts';
export const offlineGuide={title:'使用指南',text:'第一章 阅读位置与范围\n换章和章节跳转用于浏览。点击“开始伴读”后，伙伴只接上屏幕中实际可见的正文，下方文字随滚动接上。中途加入时，先用“补读前文”确认自己实际读过的范围，跳过的空缺不会自动补上。\n\n第二章 交流与控制\n输入问题并发送，可以演练交流操作。安静时继续理解，明确提问仍可回应。暂停停止新增跟随，已发出的请求收妥后保留原任务；继续接续原任务，结束保存已有结果并停止本次共读。\n\n第三章 体验备注\n从回复旁“记下感受”或输入区下方“记录阅读感受”记录实际体验。也可以只写备注。首个可见回应和有帮助标记分别记录。离线场次使用固定技术回应，外部模型调用为零，只用于界面操作演练。\n\n第四章 导入与模型服务\n使用“添加书籍或备份”加入自己有权使用的书籍，或载入自己的阅读备份。在模型设置中填写兼容OpenAI的接口地址、服务商提供的模型名称和API密钥，保存后开始共读。阅读记录保存在当前浏览器，可导出备份。归档存档后，原记录保留且退出自动打开和接续。'};
export const offlineReply='【界面演练】这是固定技术回应，用于检查换章、授权、交流与人工记录；本轮外部模型调用为零。';
export class OfflineModel implements ModelPort {
 async complete(_service:unknown,_messages:unknown,signal:AbortSignal):Promise<ModelReply>{signal.throwIfAborted();return {content:JSON.stringify({reply:offlineReply,thoughts:[],wantsLong:false}),input:0,output:0,estimated:false,elapsedMs:0};}
 async completeTools(_service:unknown,_messages:unknown,_tools:unknown,signal:AbortSignal):Promise<AgentModelReply>{signal.throwIfAborted();return {content:offlineReply,toolCalls:[],finish:'stop',reasoning:'',input:0,output:0,estimated:false,elapsedMs:0};}
}
