import type {Book,State,Service} from '../core/types.ts';
import type {AutoReadingSettings,AutoReadingEstimate,WorkbenchBudget} from './contract.ts';
import {mergeRanges,subtractRanges,readingStart,chapterContentEnd} from '../core/books.ts';
import {isVolumeHeading} from './reading-layout.ts';
import {companionReadingPolicy} from '../core/companion-policy.ts';
import {ordinaryReadingTask} from '../core/terminated-reading-continuation.ts';
import {readingAgentTools} from '../core/reading-agent.ts';
import {usageTokens} from '../core/accounting.ts';

/** Directory nodes containing only a volume heading are not reading chapters. */
export function autoReadingChapters(book:{chapters:readonly Readonly<Book['chapters'][number]>[];frontMatterEnd?:number;frontMatterIncluded?:boolean}){
  return book.chapters.filter(c=>c.end>(book.frontMatterIncluded?0:book.frontMatterEnd??0)&&!(isVolumeHeading(c.title)&&(c.contentEnd??c.end)-(c.contentStart??c.start)<=c.title.length+4));
}
export function validateAutoReading(settings:AutoReadingSettings,book:Book){
  if(!settings||settings.bookId!==book.id||settings.version!==book.version||!autoReadingChapters(book).some(c=>c.index===settings.targetChapterIndex))throw Error('自动伴读目标不属于当前书籍版本');
  if(!Number.isFinite(settings.charactersPerMinute)||settings.charactersPerMinute<=0||!Number.isSafeInteger(settings.tokenLimit)||settings.tokenLimit<0||!['estimate','manual'].includes(settings.budgetMode))throw Error('请填写有效的阅读速度和非负整数 token 上限');
}
export function archiveBudget(state:State):WorkbenchBudget{
  const {actualTokens,reservedTokens,tokens}=usageTokens(state.usage);return{tokenLimit:state.settings.tokenLimit,actualTokens,reservedTokens,tokens,remainingTokens:state.settings.tokenLimit-tokens,source:'archive'};
}
const size=(ranges:{start:number;end:number}[])=>mergeRanges(ranges).reduce((sum,r)=>sum+r.end-r.start,0);
/** Program-only estimate. Its uncertainty is visible; it never authorizes spending. */
export function estimateAutoReading(state:State,book:Book,position:number,targetChapterIndex:number,service:Service,budget:WorkbenchBudget,stamps:{requestId:string;bookId:string;model:string;effort:string;contextLimit:number}[]=[]):AutoReadingEstimate{
  const chapters=autoReadingChapters(book),target=chapters.find(c=>c.index===targetChapterIndex);
  if(!target)throw Error('请选择正文终止章节');
  const start=Math.max(readingStart(book),position),end=chapterContentEnd(book,target);
  if(end<=start)throw Error('终止章节应在当前读点之后');
  const planned=[{start,end}],missing=subtractRanges(book.known,book.prepared),remainingChars=size([...subtractRanges(planned,book.prepared),...missing]);
  const sessions=new Set((state.agentSessions??[]).filter(s=>s.bookId===book.id&&s.version===book.version&&s.status==='complete').map(s=>s.id));
  const samples=state.usage.filter(u=>u.serviceId===service.id&&u.agentSessionId&&sessions.has(u.agentSessionId)&&u.status==='complete'&&!u.estimated&&!u.modelOutcome&&!u.readingTaskFailure&&!u.dispatchFailure);
  // A saved estimate stamp makes model/effort changes distinguishable. Legacy
  // sessions lacking this evidence use the explicit coarse estimate below.
  const eligible=samples.filter(u=>stamps.some(s=>s.requestId===u.id&&s.bookId===book.id&&s.model===service.model&&s.effort===service.effort&&s.contextLimit===service.contextLimit));
  const sampleRanges=eligible.flatMap(u=>u.maintenanceDispatch?.committed?u.maintenanceDispatch.claim.ranges:ordinaryReadingTask(u.requestKey??'')?.ranges??[]);
  const completed=size(subtractRanges(sampleRanges,subtractRanges(sampleRanges,book.prepared))),values=eligible.map(u=>u.input+u.output);
  const bothLanes=eligible.some(u=>!!u.sceneOpportunity)&&eligible.some(u=>!!u.maintenanceDispatch?.committed);
  let additional:number,margin:number,basis:string;
  if(values.length&&completed&&bothLanes){
    const total=values.reduce((a,b)=>a+b,0),mean=total/values.length,deviation=Math.sqrt(values.reduce((s,v)=>s+(v-mean)**2,0)/values.length);
    additional=Math.max(0,Math.ceil(remainingChars*total/completed)-budget.reservedTokens);margin=Math.ceil(deviation*Math.sqrt(Math.max(1,additional/mean)));basis=`同书、同模型与强度的 ${values.length} 笔有效请求，余量按样本波动计算`;
  }else{
    const selected=chapters.filter(c=>c.end>start&&c.start<end);
    // Opportunity frequency is not fixed by chapter. Use observed matching
    // requests when available; otherwise capacity gives only a coarse scale,
    // never an execution cadence or a guaranteed spending ceiling.
    const sceneSamples=eligible.filter(usage=>{try{return JSON.parse(usage.requestKey??'null')?.[5]==='scene';}catch{return false;}});
    const sceneChars=size(sceneSamples.flatMap(usage=>ordinaryReadingTask(usage.requestKey!)?.ranges??[]));
    const sceneCalls=sceneChars?Math.ceil(remainingChars*sceneSamples.length/sceneChars):Math.ceil(remainingChars/Math.max(1,(service.contextLimit-service.maxOutput)/3));
    const tasks=Math.max(1,sceneCalls+selected.length+2+(state.maintenanceJobs??[]).filter(j=>j.bookId===book.id).length);
    const tools=readingAgentTools(async()=>undefined,{search:false,page:false},{readingStrategy:'companion'}).map(({name,description,parameters})=>({name,description,parameters}));
    const materialBytes=new TextEncoder().encode(companionReadingPolicy+JSON.stringify(tools)).length;
    const memoryChars=state.memories.filter(m=>m.bookId===book.id&&!m.forgotten&&!m.invalidatedBy&&!m.replacedBy).reduce((n,m)=>n+(m.bodyRef?.chars??m.text?.length??0),0);
    const input=Math.min(Math.max(0,service.contextLimit-service.maxOutput),materialBytes+memoryChars*3+Math.ceil(remainingChars*3/tasks));
    // Subtract already held calls once, so in-flight work is not estimated twice.
    additional=Math.max(0,Math.ceil(tasks*(input+service.maxOutput)-budget.reservedTokens));
    margin=input+service.maxOutput;basis='粗估：按实际剩余正文、当前材料/工具大小、已有现场样本或上下文容量及后台任务估计；另留一次收尾请求。现场无固定次数，缺少完整同模型与强度样本时不保证实际调用密度';
  }
  const total=Math.ceil((budget.actualTokens+budget.reservedTokens+additional+margin)/1000)*1000;
  return{total,additional,margin,remainingChars,basis,sampleCount:eligible.length};
}
