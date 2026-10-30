import type {Context} from '@deepseek-ai/cordis';
import type {Agent} from '@deepseek-ai/dsh-agent';
import {SessionId} from '@deepseek-ai/dsh-session';
import type {SessionSeq} from '@deepseek-ai/dsh-session';
import type {SessionEvent} from '@deepseek-ai/dsh-session';
import type {ToolRunContext} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-subagent';
import {steerHostSubagentPrompt} from '@deepseek-ai/dsh-subagent/internal';
import type {} from '@deepseek-ai/dsh-jobs';
import type {} from '@deepseek-ai/dsh-workflow';
import type {AgentDelegationPort,AgentDelegationRequest,AgentDelegatedResult,AgentOperation,AgentRunRequest} from '../core/agent-port.ts';
import {hashText} from '../core/text-hash.ts';
import {nativeSessionHeadersEqual} from '../core/agent-port.ts';
import {validateStoredEvents} from '@deepseek-ai/dsh-session-persistence';

declare module '@deepseek-ai/dsh-jobs'{interface JobKindMap{'reading-review':'reading-review'}}
type Binding={admit():void;result:Promise<AgentDelegatedResult>};
type Prepared={request?:AgentDelegationRequest;input:AgentRunRequest<AgentDelegatedResult>;binding?:Binding};
type Bind=(input:AgentRunRequest<AgentDelegatedResult>,agent:Agent)=>Promise<Binding>;
const output={schema:{type:'object' as const,additionalProperties:true},render:(_args:unknown,value:unknown)=>[{type:'text' as const,text:JSON.stringify(value)}]};
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('委派参数须为对象');return value as Record<string,unknown>;}
function text(value:unknown,name:string){if(typeof value!=='string'||!value.trim())throw Error(name+'须为非空文字');return value;}
function messageText(message:{content:readonly {type:string;text?:string}[]}){return message.content.filter(block=>block.type==='text').map(block=>block.text??'').join('');}
function canonical(value:unknown):string{const ordered=(item:unknown):unknown=>Array.isArray(item)?item.map(ordered):item&&typeof item==='object'?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,ordered(value)])):item;return JSON.stringify(ordered(value));}

/** Domain admission precedes native activation. The upstream manager owns every child. */
export class DelegationCoordinator{
  private readonly prepared=new Map<string,Prepared>();
  private readonly bindings=new Map<string,Binding>();
  private readonly settlements=new Set<Promise<unknown>>();
  private readonly nativeOutcomes=new Map<string,string>();
  private readonly recoverySeeds=new Map<string,readonly SessionEvent[]>();
  private readonly recoveryProvider:string;
  async settle(){while(this.settlements.size)await Promise.allSettled([...this.settlements]);}
  constructor(private readonly scope:Context,private readonly parent:Agent,private readonly port:AgentDelegationPort,
    private readonly parentInput:AgentRunRequest<unknown>,private readonly bind:Bind,private readonly operation:(execution:ToolRunContext)=>AgentOperation){
    this.recoveryProvider='reading-fork-recovery-'+String(parent.id);
    // Original fork selects its completed prefix once. This provider only reuses an
    // already persisted domain input, through the upstream seed contribution seam.
    const unregisterRecovery=scope.get('subagents')!.registerProvider({name:this.recoveryProvider,inheritsParentContext:true,capabilities:{agentOptions:true,agentPreset:false,outputSchema:false,depthLimit:true},prepareContinuable:async request=>{
      const seed=this.recoverySeeds.get(String(request.sessionId));if(request.parent!==parent||!seed)throw Error('继承恢复provider没有该原子任务的固定前缀');
      const authorized=await port.load(String(request.sessionId));if(!authorized)throw Error('原继承任务当前尚未获准接续');this.assertIndependent(authorized,String(request.sessionId));this.recoverySeeds.delete(String(request.sessionId));return{seed};
    }});scope.effect(()=>unregisterRecovery);
    // A child selected through another preset has a different Cordis ancestry.
    // Observe the root lifecycle, filter the exact native parent, and own the listener here.
    const detach=scope.root.on('agent/created',async({agent})=>{
      if(agent.session.header.parentSession!==parent.id)return;
      let prepared=this.prepared.get(agent.id);
      if(!prepared||this.bindings.has(agent.id)){const input=await port.load(agent.id);if(!input)return;const metadata=await input.session?.store.loadNative?.();if(metadata&&metadata.sessionId!==agent.id)throw Error('子任务原生归属不符');
        // Cold continuation uses the durable domain intent, never the parent's commit closures.
        prepared={input};
      }
      this.assertIndependent(prepared.input,agent.id);
      const current=prepared;
      const original=current.request?await port.lookup(current.request.operation,current.request.itemKey):await port.read(agent.id);
      if(original?.record.context==='inherit-completed'){
        if(original.inheritedFrom?.parentSessionId!==parent.id||original.inheritedFrom.eventCount!==agent.session.inheritedEventCount)throw Error('官方实际继承前缀与原任务已登记来源不符');
        // The upstream seed can retain the parent's then-pending inbox. Those are
        // historical parent obligations, not a fresh child delivery. Preserve the
        // seed and append real child inbox transitions before the manager sends its task.
        // This also covers a crash after the seed file exists but before its first
        // created callback. Accepted children retain their real pending work.
        if(current.request||!original.record.acceptedMessageId){agent.ctx.get('goals')?.disarm(agent);
          if(agent.inbox.nextStep.length)agent.inbox.splice('next-step',0,agent.inbox.nextStep.length,[]);
          if(agent.inbox.nextTurn.length)agent.inbox.splice('next-turn',0,agent.inbox.nextTurn.length,[]);
        }
      }
      let admitted=false;
      agent.ctx.on('agent/pre-step',async(payload,next)=>{
        const decision=await next();if(payload.agent!==agent||admitted||decision.kind!=='enter')return decision;
        if(current.request?.prompt){const first=decision.messages.find(message=>messageText(message)===current.request!.prompt);if(!first)throw Error('子任务实际首消息与登记的有限委派不一致，未派发');await port.accepted(current.request,String(first.id));}
        admitted=true;current.binding?.admit();return decision;
      });
      current.binding=await bind(current.input,agent);this.bindings.set(agent.id,current.binding);
      // No model runs inside this serial created callback. Manager queues the first message afterwards.
    });
    scope.effect(()=>detach);
    const detachOutcome=scope.root.on('subagent/end',info=>{if(this.bindings.has(String(info.id)))this.nativeOutcomes.set(String(info.id),info.stopReason);});scope.effect(()=>detachOutcome);
  }
  private assertIndependent(input:AgentRunRequest<AgentDelegatedResult>,id:string){
    if(input.session?.id!==id||input.task?.role!=='review'||input.readingExit||input.tools===this.parentInput.tools||input.materialExposure&&input.materialExposure===this.parentInput.materialExposure||input.commit&&input.commit===this.parentInput.commit||input.submit===this.parentInput.submit)throw Error('子任务缺少独立的只读领域材料/会话/提交端口');
    if(JSON.stringify(input.service)!==JSON.stringify(this.parentInput.service)||input.projectDirectory!==this.parentInput.projectDirectory||(input.sessionDirectory??input.projectDirectory)!==(this.parentInput.sessionDirectory??this.parentInput.projectDirectory))throw Error('子任务须保持原书工程、原生执行目录和已授权模型条件');
  }
  private async intent(operation:AgentOperation,prompt:string,label:string,delivery:'caller'|'parent',itemKey?:string):Promise<AgentDelegationRequest>{
    const key=JSON.stringify([operation.key,itemKey??null]),childSessionId='review-'+await hashText(key);
    return{operation,...(itemKey===undefined?{}:{itemKey}),parentSessionId:String(this.parent.id),childSessionId,prompt,label,delivery} satisfies AgentDelegationRequest;
  }
  private async prepare(request:AgentDelegationRequest){
    const input=await this.port.prepare(request);this.assertIndependent(input,request.childSessionId);const prepared:Prepared={request,input};this.prepared.set(request.childSessionId,prepared);return prepared;
  }
  private async acceptedFromLog(request:AgentDelegationRequest,acceptedId?:string){
    const stat=await this.scope.get('sessionPersistence')!.stat(SessionId(request.childSessionId));if(!stat)return{exists:false as const};
    if(stat.header.parentSession!==this.parent.id)throw Error('原子任务属于其他父Session');
    await using reader=await this.scope.get('sessionPersistence')!.open(SessionId(request.childSessionId),'read');const log=await reader.read();
    let found:string|undefined;
    for(const event of log.events){const e=event as SessionEvent;if(e.type==='user/message'&&messageText(e.data)===request.prompt)found=e.data.id;else if(e.type==='agent/inbox/spliced')for(const message of e.data.inserted)if(messageText(message)===request.prompt)found=message.id;}
    if(acceptedId&&found&&acceptedId!==found)throw Error('原子任务消息身份不符，未重投');
    return{exists:true as const,...(found?{messageId:found}:{})};
  }
  private async continuePrompt(request:AgentDelegationRequest,prompt:string,signal:AbortSignal){try{return await steerHostSubagentPrompt(this.scope.get('subagents')!,this.parent,SessionId(request.childSessionId),[{type:'text',text:prompt}],{kind:'yixu-runtime'},signal);}catch(error){const reasons:string[]=[],seen=new Set<unknown>();let current:unknown=error;while(current instanceof Error&&!seen.has(current)){seen.add(current);reasons.push(current.message);current=current.cause;}throw new Error('原子任务接续未建立：'+reasons.join('；'),{cause:error});}}
  private trackContinuation(request:AgentDelegationRequest){const binding=this.bindings.get(request.childSessionId);if(!binding)throw Error('原子任务接续没有独立运行绑定');const done=(async()=>{let result:AgentDelegatedResult|undefined;try{result=await binding.result;}catch{}await this.scope.get('subagents')!.waitForChildren(this.parent);await this.port.settle(request,{stopReason:this.nativeOutcomes.get(request.childSessionId)??'error',...(result?{result}:{})});})();this.settlements.add(done);void done.finally(()=>this.settlements.delete(done)).catch(()=>{});}
  private async start(request:AgentDelegationRequest,execution:ToolRunContext,trackCold=true){
    await this.scope.get('sessions')!.flush(this.parent.session);this.parentInput.assertCurrent();execution.signal.throwIfAborted();
    let recovered:Prepared|undefined;
    const prior=await this.port.lookup(request.operation,request.itemKey);
    if(prior){if(prior.childSessionId!==request.childSessionId||prior.record.prompt!==request.prompt||(prior.record.context??'fresh')!==(request.context??'fresh'))throw Error('原委派操作已经绑定不同任务');request.inheritedPresetId=prior.record.inheritedPresetId;request.presetId=prior.record.presetId;if(prior.record.dependencies)request.dependencies=structuredClone(prior.record.dependencies);if(prior.result)return{childSessionId:request.childSessionId,status:prior.record.status,result:prior.result};
      const logged=await this.acceptedFromLog(request,prior.record.acceptedMessageId);
      if(logged.exists&&logged.messageId){
        if(!prior.record.acceptedMessageId)await this.port.accepted(request,logged.messageId);
        if(!this.scope.get('agents')!.get(SessionId(request.childSessionId))){const authorized=await this.port.load(request.childSessionId);if(!authorized)throw Error('原子任务已经失效或尚无可接续责任');
          const continuationMessageId=await this.continuePrompt(request,'接续已经接受的原任务。先核已存原答和提交回执，不重复已提交结果，不扩大原委派范围。',execution.signal);this.bindings.get(request.childSessionId)?.admit();if(trackCold)this.trackContinuation(request);return{childSessionId:request.childSessionId,status:prior.record.status,acceptedMessageId:logged.messageId,continuationMessageId};}
        return{childSessionId:request.childSessionId,status:prior.record.status,acceptedMessageId:logged.messageId};
      }
      if(prior.record.status!=='prepared'||prior.record.acceptedMessageId)throw Error('原子任务尚未核清，未重复投递或派发');
      if(logged.exists){
        // A real descriptor with no original message can cold-resume through the native manager.
        const messageId=await this.continuePrompt(request,request.prompt,execution.signal);
        await this.port.accepted(request,String(messageId));this.bindings.get(request.childSessionId)?.admit();if(trackCold)this.trackContinuation(request);return{childSessionId:request.childSessionId,acceptedMessageId:messageId,status:'accepted'};
      }
      if(request.context==='inherit-completed'){
        const source=prior.inheritedFrom;if(source?.parentSessionId!==this.parent.id||!Number.isSafeInteger(source.eventCount)||source.eventCount<1)throw Error('原继承任务缺少已持久的精确父前缀');
        const authorized=await this.port.load(request.childSessionId);if(!authorized)throw Error('原继承任务冻结来源当前尚未获准');this.assertIndependent(authorized,request.childSessionId);
        if(authorized.task?.presetId!==this.parentInput.task?.presetId)throw Error('原继承任务实际预设已变化，未重建不同composition');
        await using reader=await this.scope.get('sessionPersistence')!.open(SessionId(source.parentSessionId),'read');if(!nativeSessionHeadersEqual(reader.header,this.parent.session.header))throw Error('原继承任务父会话头不符');
        const prefix=await reader.read(0,source.eventCount);if(prefix.events.length!==source.eventCount||prefix.events.some((event,index)=>event.seq!==index)||prefix.events[prefix.events.length-1]?.type!=='turn/end')throw Error('原继承任务固定前缀缺失或尚未正常闭合');validateStoredEvents(reader.header,[...prefix.events]);
        recovered={request,input:authorized};this.prepared.set(request.childSessionId,recovered);this.recoverySeeds.set(request.childSessionId,prefix.events);
      }
    }
    const inherit=request.context==='inherit-completed';
    if(inherit&&!recovered){let completed=0;for(let seq=this.parent.session.seq-1;seq>=0;seq--)if(this.parent.session.eventAt(seq as SessionSeq)?.type==='turn/end'){completed=seq+1;break;}if(!completed)throw Error('父任务尚无已完成turn前缀，不能声明继承讨论');if(!this.port.authorizeInheritance)throw Error('领域尚未核准完整讨论历史继承');await this.port.authorizeInheritance({operation:request.operation,parentSessionId:String(this.parent.id),eventCount:completed});request.inheritedPresetId=this.parentInput.task?.presetId;if(!request.inheritedPresetId)throw Error('继承讨论缺少父实际预设身份');}
    const prepared=recovered??await this.prepare(request);
    const activation=await this.scope.get('subagents')!.startActivation({provider:recovered?this.recoveryProvider:inherit?'fork':'spawn',childId:SessionId(request.childSessionId),label:request.label,delivery:request.delivery,signal:execution.signal,
      request:{parent:this.parent,prompt:[{type:'text',text:request.prompt}],cwd:prepared.input.sessionDirectory??prepared.input.projectDirectory,...(inherit?{}:{agentPreset:prepared.input.task!.presetId}),
        agentOptions:{provider:'yixu-task-'+request.childSessionId,model:prepared.input.service.model,maxTokens:prepared.input.service.maxOutput}}});
    await this.port.accepted(request,String(activation.messageId));prepared.binding?.admit();
    const done=(async()=>{const native=await activation.result;let result:AgentDelegatedResult|undefined;try{result=await prepared.binding!.result;}catch{if(native.stopReason==='completed')throw Error('原生子任务结束但领域结果尚未提交');}
      await this.port.settle(request,{stopReason:native.stopReason,...(result?{result}:{})});return{status:native.stopReason==='completed'?'completed' as const:'failed' as const,detail:native.stopReason,...(result?{result:JSON.stringify(result)}:{})};})();
    void done.catch(()=>{});
    this.settlements.add(done);void done.finally(()=>this.settlements.delete(done)).catch(()=>{});
    const jobId=request.delivery==='caller'?this.scope.get('jobs')!.start({kind:'reading-review',label:request.label,owner:this.parent.id,toolCall:{callId:execution.callId,rootCallId:execution.callId},run:()=>({done,cancel:()=>{void activation.dispose().catch(()=>{});}})}):undefined;
    return{childSessionId:request.childSessionId,acceptedMessageId:activation.messageId,...(jobId?{jobId}:{}),status:'accepted'};
  }
  install():string[]{
    this.scope.tools.register({name:'list_reading_reviews',description:'发现当前父任务已登记的只读核对意图、原操作身份、状态及结果入口，供冷接续；不读取其他书或父任务。',parameters:{type:'object',additionalProperties:false},output,execute:async()=>{this.parentInput.assertCurrent();return{items:(await this.port.list()).filter(item=>item.record.parentSessionId===this.parent.id).map(({childSessionId,record,result})=>({childSessionId,operationKey:JSON.parse(record.operationKey)[0],itemKey:JSON.parse(record.operationKey)[1],status:record.status,prompt:record.prompt,label:record.label,...(result?.resultRef??record.resultRef?{resultRef:result?.resultRef??record.resultRef}:{})}))};}});
    this.scope.tools.register({name:'get_reading_review',description:'按原子任务ID读取当前书真实核对状态与已持久结果引用。原生结束通知若没有正文，也从此取得真实结果；不重启任务。',parameters:{type:'object',properties:{childSessionId:{type:'string'}},required:['childSessionId'],additionalProperties:false},output,execute:async(args,execution)=>{this.parentInput.assertCurrent();execution.signal.throwIfAborted();const saved=await this.port.read(text(object(args).childSessionId,'子任务ID'));if(!saved||saved.record.parentSessionId!==this.parent.id)throw Error('当前父任务无权读取该子任务');return saved;}});
    this.scope.tools.register({name:'resume_reading_review',description:'显式接续当前父任务已登记的原子核对。原结果已提交则只取原回执；原unknown必须先核，不新建替代Session。',parameters:{type:'object',properties:{childSessionId:{type:'string'}},required:['childSessionId'],additionalProperties:false},output,execute:async(args,execution)=>{
      this.parentInput.assertCurrent();const childSessionId=text(object(args).childSessionId,'原子任务ID'),saved=await this.port.read(childSessionId);if(!saved||saved.record.parentSessionId!==this.parent.id)throw Error('当前父任务无权接续该子任务');if(saved.result)return{childSessionId,status:saved.record.status,result:saved.result};if(saved.record.status==='unknown')throw Error('原子任务请求尚未核清，未重发');
      const [key,itemKey]=JSON.parse(saved.record.operationKey),[sessionId,requestId,toolCallId]=JSON.parse(key),native=await this.parentInput.session?.store.loadNative?.(),call=native?.calls.find(call=>call.requestId===requestId);if(sessionId!==this.parent.id||!call||typeof toolCallId!=='string')throw Error('原子任务没有当前父会话的真实调用身份');
      let matched=false;for(let seq=0;seq<this.parent.session.seq;seq++){const event=this.parent.session.eventAt(seq as SessionSeq);if(event?.type==='tool/call'&&event.data.callId===toolCallId&&['delegate_reading_review','reading_review_workflow'].includes(event.data.name)){matched=true;break;}}if(!matched)throw Error('原子任务没有原生委派调用，未补造');
      const record=saved.record,operation:AgentOperation={agentSessionId:sessionId,agentCallId:call.agentCallId,requestId,toolCallId,key};return this.start({operation,...(itemKey===null?{}:{itemKey}),parentSessionId:sessionId,childSessionId,prompt:record.prompt,label:record.label,delivery:record.delivery,...(record.context?{context:record.context}:{}),...(record.presetId?{presetId:record.presetId}:{}),...(record.inheritedPresetId?{inheritedPresetId:record.inheritedPresetId}:{}),...(record.dependencies?{dependencies:record.dependencies}:{})},execution);
    }});
    this.scope.tools.register({name:'delegate_reading_review',description:'为具体疑点启动有限只读核对子任务；context默认fresh，inherit-completed仅在领域核准完整历史当前权限后继承已完成讨论。只有确需主伙伴综合时选择parent交付。',parameters:{type:'object',properties:{prompt:{type:'string'},label:{type:'string'},delivery:{type:'string',enum:['caller','parent']},context:{type:'string',enum:['fresh','inherit-completed']}},required:['prompt','label','delivery'],additionalProperties:false},output,
      execute:async(args,execution)=>{const values=object(args),prompt=text(values.prompt,'核对任务'),label=text(values.label,'任务名称');if(values.delivery!=='caller'&&values.delivery!=='parent'||values.context!==undefined&&!['fresh','inherit-completed'].includes(String(values.context)))throw Error('无效交付或上下文方式');const request=await this.intent(this.operation(execution),prompt,label,values.delivery);if(values.context==='inherit-completed')request.context='inherit-completed';return this.start(request,execution);}});
    const itemSchema={type:'object' as const,properties:{prompt:{type:'string' as const},label:{type:'string' as const}},required:['prompt','label'],additionalProperties:false};
    this.scope.tools.register({name:'reading_review_workflow',description:'为有限核对项运行原生Workflow。parallel使用items并行；pipeline使用stages顺序依赖，每阶段取得上一阶段已持久结果引用，原文仍按许可取材。',parameters:{type:'object',properties:{mode:{type:'string',enum:['parallel','pipeline']},items:{type:'array',items:itemSchema},stages:{type:'array',items:itemSchema}},required:['mode'],additionalProperties:false},output,
      execute:async(args,execution)=>this.workflow(args,execution)});
    this.scope.tools.register({name:'resume_reading_workflow',description:'按list_reading_reviews发现的原operationKey显式接续当前父任务真实Workflow；mode/items/stages必须与原调用相同。原unknown仍先核原请求，不建立替代项。',parameters:{type:'object',properties:{operationKey:{type:'string'},mode:{type:'string',enum:['parallel','pipeline']},items:{type:'array',items:itemSchema},stages:{type:'array',items:itemSchema}},required:['operationKey','mode'],additionalProperties:false},output,execute:async(args,execution)=>{
      this.parentInput.assertCurrent();const{operationKey,...originalArgs}=object(args),parsed=JSON.parse(text(operationKey,'原操作身份')) as unknown;if(!Array.isArray(parsed)||parsed.length!==3||parsed[0]!==this.parent.id||typeof parsed[1]!=='string'||typeof parsed[2]!=='string')throw Error('原工作流操作不属于当前父任务');
      let original:SessionEvent<'tool/call'>|undefined;for(let seq=0;seq<this.parent.session.seq;seq++){const event=this.parent.session.eventAt(seq as SessionSeq);if(event?.type==='tool/call'&&event.data.callId===parsed[2]){original=event;break;}}
      if(!original||original.data.name!=='reading_review_workflow'||canonical(JSON.parse(original.data.arguments))!==canonical(originalArgs))throw Error('原工作流真实调用或参数不符，未建立替代任务');
      const native=await this.parentInput.session?.store.loadNative?.(),link=native?.calls.find(call=>call.requestId===parsed[1]);if(!link)throw Error('原工作流调用尚无原生领域关联');
      const operation:AgentOperation={agentSessionId:String(this.parent.id),agentCallId:link.agentCallId,requestId:parsed[1],toolCallId:parsed[2],key:String(operationKey)};
      if(!(await this.port.list()).some(item=>item.record.parentSessionId===this.parent.id&&JSON.parse(item.record.operationKey)[0]===operation.key))throw Error('原工作流没有已登记意图，不能用接续伪造新工作');
      return this.workflow(originalArgs,execution,operation);
    }});
    return['list_reading_reviews','get_reading_review','resume_reading_review','delegate_reading_review','reading_review_workflow','resume_reading_workflow'];
  }
  private async workflow(args:unknown,execution:ToolRunContext,originalOperation?:AgentOperation){
    await this.scope.get('sessions')!.flush(this.parent.session);this.parentInput.assertCurrent();execution.signal.throwIfAborted();
    const values=object(args),pipeline=values.mode==='pipeline',declared=pipeline?values.stages:values.items;
    if(!['parallel','pipeline'].includes(String(values.mode))||!Array.isArray(declared)||!declared.length||pipeline&&values.items!==undefined||!pipeline&&values.stages!==undefined)throw Error('Workflow需要有限items并行项或stages依赖阶段');
    const items=declared.map(item=>{const value=object(item);return{prompt:text(value.prompt,'核对任务'),label:text(value.label,'任务名称')};}),operation=originalOperation??this.operation(execution),intents=await Promise.all(items.map((item,index)=>this.intent(operation,item.prompt,item.label,'caller',String(index))));
    const pending:typeof intents=[];
    // Workflow's public startChild API cannot select an existing child id. Recover established
    // items through the native activation manager first; only proven absent items reach PTC.
    for(let index=0;index<intents.length;index++){
      const planned=intents[index],prior=await this.port.lookup(operation,planned.itemKey);
      if(!prior){pending.push(planned);continue;}
      planned.childSessionId=prior.childSessionId;
      if(prior.record.prompt!==planned.prompt||prior.record.parentSessionId!==this.parent.id)throw Error('原Workflow项身份已变化');
      if(prior.result)continue;
      if(prior.record.status==='unknown')throw Error('原Workflow项请求尚未核清，未新增派发');
      if(pipeline&&pending.length)throw Error('原依赖阶段缺少前置结果，未越过原任务');
      await this.start(planned,execution,false);await this.scope.get('subagents')!.waitForChildren(this.parent);
      const binding=this.bindings.get(planned.childSessionId);let result:AgentDelegatedResult|undefined;
      try{result=binding?await binding.result:(await this.port.read(planned.childSessionId))?.result;}catch{}
      if(!result)throw Error('原Workflow项尚未取得可用领域结果，未跳过或新建替代任务');
      await this.port.settle(planned,{stopReason:'completed',result});
    }
    if(!pending.length)return{recovered:true,items:await this.workflowResults(intents)};
    // ContinuableCreateRequest has no prompt/options. A fixed native PTC script declares the
    // exact starts; first-step equality checks admission. The inherited provider is routed by
    // GenerateOptions.sessionId to the independent domain adapter with its authorized service.
    let index=0;const provider='reading-workflow-'+await hashText(operation.key),outcomes=new Map<string,string>();
    const detach=this.scope.root.on('subagent/end',info=>{if(intents.some(item=>item.childSessionId===info.id))outcomes.set(String(info.id),info.stopReason);});
    const unregister=this.scope.get('subagents')!.registerProvider({name:provider,inheritsParentContext:false,capabilities:{agentOptions:true,agentPreset:false,outputSchema:false,depthLimit:true},prepareContinuable:async request=>{
      const planned=pending[index++];if(!planned||request.parent!==this.parent)throw Error('Workflow尝试建立未登记的额外任务');
      planned.childSessionId=String(request.sessionId);
      // Workflow-PTC's public child request has no agentPreset field. A late select
      // after subagent/descriptor is intentionally not a creation-time selection in
      // upstream coldResume. Preserve its actual inherited composition identity.
      planned.presetId=this.parentInput.task?.presetId;if(!planned.presetId)throw Error('Workflow缺少父原生预设身份');
      if(pipeline){const position=intents.indexOf(planned),previous=intents[position-1];if(previous){const saved=await this.port.lookup(operation,previous.itemKey);if(!saved?.result)throw Error('前一阶段尚无真实已提交结果');planned.dependencies=[{childSessionId:saved.childSessionId,resultRef:saved.result.resultRef}];}}
      const existing=await this.port.lookup(operation,planned.itemKey);if(existing)throw Error('该Workflow原项已建立，未重复启动');await this.prepare(planned);return{};
    }});
    const script=pipeline?'return await pipeline([null], ...args.items.map(item => async (_previous, _item) => await agent(item.prompt)));':'return await parallel(args.items.map(item => () => agent(item.prompt)));';
    let run:ReturnType<Context['workflowEngine']['start']>|undefined;
    try{run=this.scope.get('workflowEngine')!.start({script,args:{items:pending.map(item=>({prompt:item.prompt,label:item.label}))},meta:{name:'reading-review',description:pipeline?'依赖前阶段真实结果的有限核对':'当前任务的有限并行核对'},parent:this.parent,signal:execution.signal,subagentProvider:provider,maxTotalAgents:pending.length});const outcome=await run.result;
      for(const planned of pending){const binding=this.bindings.get(planned.childSessionId);if(!binding)continue;let result:AgentDelegatedResult|undefined;try{result=await binding.result;}catch{}const stopReason=outcomes.get(planned.childSessionId)??outcome.stopReason;await this.port.settle(planned,{stopReason,...(result?{result}:{})});}
      if(outcome.stopReason!=='completed')throw Error(outcome.error??'原生Workflow未完成');
      const results=await this.workflowResults(intents);if(results.some(item=>!item.result))throw Error('原生Workflow结束但领域核对结果未齐');
      return{workflowId:run.id,items:results};
    }finally{await run?.dispose();unregister();detach();}
  }
  private async workflowResults(intents:AgentDelegationRequest[]){return Promise.all(intents.map(async planned=>{const saved=await this.port.lookup(planned.operation,planned.itemKey);return{...(planned.itemKey!==undefined?{itemKey:planned.itemKey}:{}),childSessionId:saved?.childSessionId??planned.childSessionId,...(saved?{status:saved.record.status}:{}),...(saved?.result?{result:saved.result}:{})};}));}
}
