import {Context} from '@deepseek-ai/cordis';
import type {Agent} from '@deepseek-ai/dsh-agent';
import {LocalSpillStore} from '@deepseek-ai/dsh-spill-local';
import * as SpillPolicy from '@deepseek-ai/dsh-spill-policy';
import {ToolResultPruner} from '@deepseek-ai/dsh-compaction-tool-result-pruner';
import type {SaveTextSpill,SpillRef} from '@deepseek-ai/dsh-spill';
import {readFile,realpath} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,relative,isAbsolute} from 'node:path';
import {SessionId} from '@deepseek-ai/dsh-session';
import {ToolCallId,freezeMessage,type ContentBlock} from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-token-meter';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-compaction';
import type {AgentRunRequest,NativeSessionReference} from '../core/agent-port.ts';
import {hashText} from '../core/text-hash.ts';

export type NativeSpillBody={kind:'agent-session-spill-v1';locator:string;hash:string;bytes:number;text:string};
async function spillPath(reference:NativeSessionReference,entry:NonNullable<NativeSessionReference['spills']>[number]){
  const cwd=(reference.header as {cwd?:string}).cwd;if(!cwd)throw Error('长结果没有书籍工程归属');
  const root=await realpath(join(cwd,'.dsh','spills')),path=await realpath(entry.storageLocator??entry.locator),part=relative(root,path);if(!part||part==='..'||part.startsWith('..\\')||part.startsWith('../')||isAbsolute(part))throw Error('长结果存储不在本书工程内');return path;
}
/** Fully consuming each text stream is required before a portable backup succeeds. */
export function createNativeSpillStreamReader(){return async function*(reference:NativeSessionReference){
  for(const entry of reference.spills??[]){const path=await spillPath(reference,entry);yield{kind:'agent-session-spill-v1' as const,locator:entry.locator,hash:entry.hash,bytes:entry.bytes,text:(async function*(){
    const hash=createHash('sha256'),decoder=new TextDecoder('utf-8',{fatal:true});let bytes=0;
    for await(const chunk of createReadStream(path)){const buffer=chunk as Buffer;bytes+=buffer.byteLength;hash.update(buffer);const text=decoder.decode(buffer,{stream:true});if(text)yield text;}
    const tail=decoder.decode();if(tail)yield tail;if(bytes!==entry.bytes||hash.digest('hex')!==entry.hash)throw Error('长结果备份原文件哈希或长度不符');
  })()};}
};}
export async function readNativeSpillBodies(reference:NativeSessionReference):Promise<NativeSpillBody[]>{const bodies:NativeSpillBody[]=[];for await(const body of createNativeSpillStreamReader()(reference)){let text='';for await(const chunk of body.text)text+=chunk;bodies.push({...body,text});}return bodies;}
/** Original model-visible locator remains the logical key; only physical storage moves. */
export async function restoreNativeSpills(input:{reference:NativeSessionReference;spillBodies?:NativeSpillBody[];projectDirectory:string}):Promise<NativeSessionReference>{
  const reference=structuredClone(input.reference);if(!reference.spills?.length)return reference;
  if((reference.header as {cwd?:unknown}).cwd!==input.projectDirectory)throw Error('长结果恢复目标与原生书工程不符');
  const ctx=new Context();try{await ctx.plugin(LocalSpillStore,{root:join(input.projectDirectory,'.dsh','spills'),cleanupPeriodDays:0});const store=ctx.get('spillStore');if(!store)throw Error('长结果恢复存储未就绪');
    for(const entry of reference.spills){const body=input.spillBodies?.find(body=>body.locator===entry.locator);if(!body||body.hash!==entry.hash||body.bytes!==entry.bytes||Buffer.byteLength(body.text,'utf8')!==entry.bytes||await hashText(body.text)!==entry.hash)throw Error('便携备份缺少经核验的完整长结果');
      const saved=await store.saveText({owner:{sessionId:SessionId(reference.sessionId)},source:{kind:'tool',toolName:entry.toolName,callId:ToolCallId(entry.callId),label:'result'},suggestedName:'restored-result.txt',content:body.text});entry.storageLocator=saved.locator;
    }
    return reference;
  }finally{await ctx.fiber.dispose();}
}

/** The official backend owns files. The domain reference authenticates which locators
 * this Session may retrieve; a model-authored notice or arbitrary path grants nothing. */
class ReadingSpillStore extends LocalSpillStore{
  constructor(ctx:Context,root:string,private readonly capture:(input:SaveTextSpill,ref:SpillRef)=>Promise<void>){super(ctx,{root,cleanupPeriodDays:0});}
  override async saveText(input:SaveTextSpill){const ref=await super.saveText(input);await this.capture(input,ref);return ref;}
}

type StoredResult=NonNullable<NativeSessionReference['spills']>[number];
function storedResultContent(entry:StoredResult):ContentBlock[]{
  return[{type:'text',text:JSON.stringify({
    delivery:'stored-tool-result',expanded:false,
    original:{path:entry.locator,hash:entry.hash,bytes:entry.bytes},
    read:{tool:'read',arguments:{path:entry.locator,offset:0}},
    instruction:'这是本次工具结果的完整原件入口，正文尚未展开，不算已经读过。先用已有read取回；需要分段时用offset/limit（UTF16字符）顺序读取同一文件。文档的完整范围、版本和语义单位以原件中的结构为准，不从首尾片段猜测，也不必重新调用资料工具生成同一结果。'
  })}];
}

/** Keep JSON atomic when the official pressure policy prunes old results too.
 * The existing native file remains the only recovery authority. */
class ReadingResultPruner extends ToolResultPruner{
  constructor(ctx:Context,private readonly reference:()=>NativeSessionReference|undefined){super(ctx);}
  override pruneContent(content:readonly ContentBlock[]):ContentBlock[]|null{
    const pruned=super.pruneContent(content);if(!pruned||content.some(block=>block.type!=='text'))return pruned;
    const text=content.map(block=>block.type==='text'?block.text:'').join('');
    try{JSON.parse(text);}catch{return pruned;}
    const hash=createHash('sha256').update(text,'utf8').digest('hex'),entry=this.reference()?.spills?.find(item=>item.hash===hash);
    // A JSON body without an authenticated file cannot be safely narrowed.
    return entry?storedResultContent(entry):null;
  }
}

export async function installReadingSpill(scope:Context,agent:Agent,input:AgentRunRequest<unknown>,reference:()=>NativeSessionReference|undefined,checkpoint:()=>Promise<void>){
  // Retain the original header spelling for locators even when Windows exposes
  // the same physical execution folder through another registered alias.
  const sessionDirectory=agent.session.header.cwd??input.sessionDirectory??input.projectDirectory;if(!sessionDirectory)throw Error('原生材料持久取回需要书籍执行目录');
  const isolated=scope.isolate('spillStore').isolate('toolResultPruner');
  let backend:ReadingSpillStore|undefined;
  await isolated.plugin({name:'yixu-reading-spill',apply(ctx:Context){backend=new ReadingSpillStore(ctx,join(sessionDirectory,'.dsh','spills'),async(saved,ref)=>{
    const native=reference();if(!native||saved.owner.sessionId!==native.sessionId||saved.source.kind!=='tool')throw Error('长结果缺少原生任务归属');
    const hash=await hashText(saved.content);native.spills??=[];
    if(!native.spills.some(item=>item.locator===ref.locator))native.spills.push({locator:ref.locator,hash,bytes:ref.bytes,callId:saved.source.callId,toolName:saved.source.toolName});
    await checkpoint();
  });}});
  // This is an inline-result allocation, not a provider-call quota. Actual request capacity
  // and cost admission still run on the complete frozen GenerateOptions.
  const inlineTokens=Math.min(12500,Math.max(512,Math.floor((input.service.contextLimit-input.service.maxOutput)/4)));
  await isolated.plugin(SpillPolicy,{maxInlineTokens:inlineTokens});
  await isolated.plugin({name:'yixu-reading-result-pruner',inject:['tokenMeter'],apply(ctx:Context){new ReadingResultPruner(ctx,reference);}});
  const pruner=isolated.get('toolResultPruner');if(!backend||!pruner)throw Error('原生长结果策略尚未就绪');
  const domainTools=new Set(input.tools.map(tool=>tool.name));
  // Run outside the official spill policy: it has already saved the complete
  // settled result, but its generic head/tail preview is not a JSON document.
  scope.on('tools/post-execute',async(execution,result,next)=>{
    const decision=await next();
    if(execution.agent!==agent||execution.parent!==undefined||!domainTools.has(execution.name)||result.isError||decision.kind!=='accept'||Object.hasOwn(decision,'value'))return decision;
    const entry=reference()?.spills?.find(item=>item.callId===String(execution.callId)&&item.toolName===execution.name);
    return entry?{kind:'accept',content:storedResultContent(entry),...(decision.additionalContexts?{additionalContexts:decision.additionalContexts}:{})}:decision;
  },{prepend:true});
  scope.tools.register({name:'read',description:'取回本任务真实保存的长工具结果。path须来自本任务结果索引，offset/limit按UTF16字符；每次重新核当前许可和来源。',parameters:{type:'object',properties:{path:{type:'string'},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1}},required:['path'],additionalProperties:false},
    output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:(value as {text:string}).text}]},async execute(args,execution){
      input.assertCurrent();execution.signal.throwIfAborted();const values=args as {path:string;offset?:number;limit?:number},native=reference(),entry=native?.spills?.find(item=>item.locator===values.path);if(!entry)throw Error('该文件不是本Session实际登记的材料结果');
      const content=await readFile(await spillPath(native!,entry),'utf8');if(Buffer.byteLength(content,'utf8')!==entry.bytes||await hashText(content)!==entry.hash)throw Error('长结果原文件校验失败，未曝光替代内容');
      const offset=values.offset??0,end=values.limit===undefined?content.length:Math.min(content.length,offset+values.limit);if(!Number.isSafeInteger(offset)||offset<0||offset>content.length||values.limit!==undefined&&(!Number.isSafeInteger(values.limit)||values.limit<1)||offset>0&&/[\uDC00-\uDFFF]/.test(content[offset])||end<content.length&&/[\uDC00-\uDFFF]/.test(content[end]))throw Error('取回范围无效或切开UTF16字符');
      input.assertCurrent();execution.signal.throwIfAborted();return{text:content.slice(offset,end),offset,end,complete:offset===0&&end===content.length};
    }});
  scope.tools.register({name:'list_spilled_results',description:'列出本任务真实保存的长结果入口；不读取其他任务或任意文件。',parameters:{type:'object',additionalProperties:false},output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},async execute(){input.assertCurrent();return{results:reference()?.spills??[]};}});
  return{tools:['read','list_spilled_results'],async afterDispatch(inputTokens:number){
    // Exact duplicate tool bodies need no semantic decision. Keep the newest
    // complete copy on the surface and a durable locator for every replaced one.
    // Use native replacement events so restart and exposure see the same input.
    const seen=new Map<string,string>();let deduplicated=false;
    for(const seq of [...agent.session.surface.nodes].reverse()){
      const event=agent.session.eventAt(seq);if(event?.type!=='tool/result')continue;
      const original=agent.session.deriveEventMessage(event);if(!original||original.role!=='tool'||original.content.some(block=>block.type!=='text'))continue;
      const content=original.content.map(block=>block.type==='text'?block.text:'').join('');
      const prior=seen.get(content),callId=String(event.data.message.source.callId);
      if(!prior){seen.set(content,callId);continue;}
      const notice=`此工具结果与调用 ${prior} 的完整结果逐字相同，请复用该结果。原件可从 list_spilled_results 取回。`;
      if(content.length<=notice.length)continue;
      const hash=await hashText(content);
      if(!reference()?.spills?.some(item=>item.hash===hash))await backend!.saveText({owner:{sessionId:agent.id},source:{kind:'tool',toolName:'duplicate-result',callId:event.data.message.source.callId,label:'result'},suggestedName:'duplicate-result.txt',content});
      const meter=scope.get('tokenMeter');if(!meter)throw Error('原生结果投影缺少token计量服务');
      agent.session.append('compaction/prune',{shadowedRange:{start:seq,end:seq},shadowedSeqs:[seq],shadowedTokenCount:meter.estimateMessage(original)});
      agent.session.append('tool/result',{...event.data,message:freezeMessage({...original,content:[{type:'text',text:notice}]})},{surfaceOp:{op:'replace',startSeq:seq,endSeq:seq},sourceEventSeqs:[seq]});deduplicated=true;
    }
    if(deduplicated)await checkpoint();
    // Keep useful read results while the actual request has room. Pruning every
    // large result after one use made corrections repeatedly fetch the same body.
    // Reserve the configured output plus the existing compaction headroom; the
    // official compaction engine still owns admission of the next full request.
    if(!Number.isFinite(inputTokens)||inputTokens<input.service.contextLimit-2*input.service.maxOutput)return;
    // Called only after the frozen request really returned and exposure was acknowledged.
    // The original events stay immutable. Persist every candidate before the official
    // replay-safe shadow-price/replace algorithm narrows subsequent surface history.
    for(const seq of [...agent.session.surface.nodes]){const event=agent.session.eventAt(seq);if(event?.type!=='tool/result')continue;const message=agent.session.deriveEventMessage(event);if(!message||pruner.measureContent(message.content)<=pruner.config.thresholdChars)continue;if(message.content.some(block=>block.type!=='text'))continue;
      const content=message.content.map(block=>block.type==='text'?block.text:'').join(''),hash=await hashText(content),native=reference();if(native?.spills?.some(item=>item.hash===hash))continue;
      await backend!.saveText({owner:{sessionId:agent.id},source:{kind:'tool',toolName:'retained-result',callId:event.data.message.source.callId,label:'result'},suggestedName:'retained-result.txt',content});
    }
    const result=pruner.pruneSession(agent.session);if(result.pruned.length)await checkpoint();
  }};
}
