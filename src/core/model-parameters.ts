import type {ModelEffort,Service} from './types.ts';

type ParameterService=Pick<Service,'baseUrl'|'model'|'thinking'|'effort'> & Partial<Pick<Service,'id'|'temperature'|'topP'>>;
export type ModelParameterSupport={efforts:readonly ModelEffort[];temperature?:{min:number;max:number};topP?:{min:number;max:number};note:string};

function officialModel(service:ParameterService):'flash'|'pro'|undefined{
  let url:URL;try{url=new URL(service.baseUrl);}catch{return;}
  if(url.origin!=='https://api.deepseek.com'||!['','/v1','/beta'].includes(url.pathname.replace(/\/$/,''))||url.search||url.hash)return;
  if(service.model==='deepseek-flash')return 'flash';
  if(service.model==='deepseek-v4-pro')return 'pro';
}
function thinkingEnabled(service:ParameterService):boolean{
  if(service.thinking!==undefined)return service.thinking==='deepseek';
  if(service.id?.startsWith('custom-'))return false;
  // Preserve the original built-in channel protocol without guessing a custom API.
  return officialModel(service)!==undefined||service.id==='wechat'||service.id==='deepseek';
}

export function modelParameterSupport(service:ParameterService):ModelParameterSupport{
  const model=officialModel(service),thinking=thinkingEnabled(service);
  if(!model)return {efforts:[service.effort],note:'该渠道与型号的参数支持尚未确认；保留当前思考配置，暂不提供采样参数调整。'};
  if(thinking)return {efforts:['low','high','max'],...(model==='flash'?{topP:{min:0.95,max:1}}:{}),note:`DeepSeek 官方思考模式支持 low、high、max；已有 medium 按官方规则等同 high。温度在思考模式下无效。${model==='flash'?'Flash 的 top_p 可设为 0.95～1。':'V4 Pro 的 top_p 由提供方固定。'}`};
  return {efforts:[],temperature:{min:0,max:2},note:`DeepSeek 官方非思考模式可调整温度，推理强度不参与请求。${model==='flash'?'Flash 的 top_p 由提供方固定为 1。':'V4 Pro 非思考模式的 top_p 在官方说明中存在差异，支持范围待核，暂不开放。'}`};
}

/** Validate explicit new settings only; loading an original archive does not call this. */
export function validateModelParameters(service:ParameterService):void{
  const support=modelParameterSupport(service);
  for(const [field,label,range] of [['temperature','温度',support.temperature],['topP','top_p',support.topP]] as const){
    const value=service[field];if(value===undefined)continue;
    if(typeof value!=='number'||!Number.isFinite(value))throw Error(`${label}须为有限数值`);
    if(!range)throw Error(`当前渠道、型号或思考模式不支持设置${label}，请清除该参数`);
    if(value<range.min||value>range.max)throw Error(`${label}应在 ${range.min}～${range.max} 之间`);
  }
}

/** Wire parameters shared by both model paths and the host's request validation. */
export function modelRequestParameters(service:ParameterService):Record<string,unknown>{
  const official=officialModel(service),thinking=thinkingEnabled(service),support=modelParameterSupport(service);
  const parameters:Record<string,unknown>=thinking?{thinking:{type:'enabled'},reasoning_effort:official&&service.effort==='medium'?'high':service.effort}:official?{thinking:{type:'disabled'}}:{};
  if(support.temperature&&typeof service.temperature==='number'&&Number.isFinite(service.temperature)&&service.temperature>=support.temperature.min&&service.temperature<=support.temperature.max)parameters.temperature=service.temperature;
  if(support.topP&&typeof service.topP==='number'&&Number.isFinite(service.topP)&&service.topP>=support.topP.min&&service.topP<=support.topP.max)parameters.top_p=service.topP;
  return parameters;
}
