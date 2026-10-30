import type { ModelTool } from './types.ts';

export type AnswerScope = 'overview' | 'focused';
export type AnswerAspect = { need:string; memoryIds?:string[]; sourceIds?:string[]; query?:string };
export type AnswerPreparation = { aspects:{need:string;memoryIds:string[];sourceIds:string[];unavailableIds:string[]}[] };

/** Explicit caller scope wins. Only unmistakable cross-stage requests opt in;
 * asking for a longer response alone does not change the material scope. */
export function answerScopeFor(question:string, explicit?:AnswerScope):AnswerScope {
  if(explicit!==undefined){if(explicit!=='overview'&&explicit!=='focused')throw Error('问题取材范围无效');return explicit;}
  return /全书|跨(?:章节|阶段|时间|时)|从(?:开头|最初|第一章).{0,20}到|(?:至今|到目前|到现在|读到这里).{0,8}(?:整体|回顾|梳理|总结)|(?:回顾|梳理|总结).{0,16}(?:一路|前后|各阶段|不同阶段|多条线索)/u.test(question)?'overview':'focused';
}

export const answerPreparationPolicy='prepare_answer是可选的批量取材工具：可按当前问题选择相关方面及已给m/p，按需补查旧认识。材料足够时直接交流。它返回实际材料、版本关系和取得情况，不判断事实真假，也不规定表达结构。';
export const prepareAnswerTool:ModelTool={
  name:'prepare_answer',
  description:'为本题选择1至3方面的实际依据；复用已给m/p，需要时按query取回相关完整文档及真实后继。返回材料后自然回答，不写长期记忆。',
  parameters:{type:'object',properties:{aspects:{type:'array',minItems:1,maxItems:3,items:{type:'object',properties:{
    need:{type:'string',minLength:1,maxLength:160,description:'本题需要了解的一个具体方面；只写简短取材目的。'},
    memoryIds:{type:'array',maxItems:8,items:{type:'string',pattern:'^m[1-9][0-9]*$'},description:'本轮已提供或发现的文档编号；已取得全文可直接复用。'},
    sourceIds:{type:'array',items:{type:'string',pattern:'^p[1-9][0-9]*$'},description:'精选关键且去重的本轮实际原文编号。'},
    query:{type:'string',minLength:1,maxLength:160,description:'有材料缺口时用于找旧认识的具体主题、别名或关系；已有材料足够可省略。'}
  },required:['need'],additionalProperties:false}}},required:['aspects'],additionalProperties:false}
};

export function parseAnswerAspects(input:unknown):AnswerAspect[]{
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>k!=='aspects'))throw Error('本题取材参数须为aspects');
  const aspects=(input as {aspects?:unknown}).aspects;
  if(!Array.isArray(aspects)||aspects.length<1||aspects.length>3)throw Error('请为本题选择1至3个取材方面');
  return aspects.map((raw,index)=>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!['need','memoryIds','sourceIds','query'].includes(k)))throw Error('本题取材方面字段无效');
    if(typeof raw.need!=='string'||!raw.need.trim()||raw.need.length>160)throw Error('取材目的须为1至160字符');
    for(const [key,prefix] of [['memoryIds','m'],['sourceIds','p']] as const)if(raw[key]!==undefined){
      const list=raw[key],field=`aspects[${index}].${key}`;
      if(!Array.isArray(list))throw Error(key==='sourceIds'?`${field}须为本轮实际提供的p编号数组`:'取材编号须为本轮实际提供的'+prefix+'编号，最多8项');
      if(key==='memoryIds'&&list.length>8)throw Error('取材编号须为本轮实际提供的'+prefix+'编号，最多8项');
      let invalid=-1;list.some((id:unknown,at:number)=>{if(typeof id!=='string'||!new RegExp('^'+prefix+'[1-9][0-9]*$').test(id)){invalid=at;return true;}return false;});
      if(invalid>=0)throw Error(key==='sourceIds'?`${field}[${invalid}]须为本轮实际提供的p编号`:'取材编号须为本轮实际提供的'+prefix+'编号，最多8项');
    }
    if(raw.query!==undefined&&(typeof raw.query!=='string'||!raw.query.trim()||raw.query.length>160))throw Error('补查词须为1至160字符');
    if(!raw.memoryIds?.length&&!raw.sourceIds?.length&&!raw.query)throw Error('每方面请至少选择已给m/p，或给出需要补查的query');
    return {need:raw.need.trim(),...(raw.memoryIds?.length?{memoryIds:[...new Set(raw.memoryIds as string[])]}:{}),...(raw.sourceIds?.length?{sourceIds:[...new Set(raw.sourceIds as string[])]}:{}),...(raw.query?{query:raw.query.trim()}:{})};
  });
}
