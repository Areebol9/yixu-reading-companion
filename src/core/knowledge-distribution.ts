import {normalize} from './books.ts';
import {recallTerms} from './recall-terms.ts';

/** Navigation to complete prose. These labels never assert who actually knows. */
export type KnowledgeDistribution={topics:string[];subjects?:string[];scopeCues?:string[];changeCues?:string[]};
export type KnowledgeDocumentQuery={topic?:string;subject?:string};
export const knowledgeDistributionSchema={type:'object',description:'知识主题完整认识的导航标签，不能代替正文或证明主体知情。主体/群体/职业/范围均使用开放名称；通常范围、条件、实际持有人、例外、部分知情、误信、声称及传播变化在正文表达。topics=[]清除该导航；省略字段沿旧版导航。',properties:{
  topics:{type:'array',items:{type:'string'},description:'会影响剧情或行为的知识主题及查找别名。'},
  subjects:{type:'array',items:{type:'string'},description:'正文涉及的实际主体或范围名称，不是完整持有人名单。'},
  scopeCues:{type:'array',items:{type:'string'},description:'用于发现相关默认背景的职业、组织、渠道、保密或专业门槛线索，不自动赋予成员知情。'},
  changeCues:{type:'array',items:{type:'string'},description:'正文中相关传播、获知、隐瞒、矛盾行为的查找词；命中只提示回看。'}
},required:['topics'],additionalProperties:false};
export const knowledgeQuerySchema={type:'object',properties:{topic:{type:'string'},subject:{type:'string'}},additionalProperties:false};
export function parseKnowledgeDistribution(value:unknown,field='knowledgeDistribution'):KnowledgeDistribution|undefined{
  if(value===undefined)return;
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error(`${field}须为导航对象；事实和条件保留在完整正文`);
  const raw=value as Record<string,unknown>,result:Record<string,string[]>={};
  for(const key of Object.keys(raw))if(!['topics','subjects','scopeCues','changeCues'].includes(key))throw Error(`${field}.${key}不是导航字段；知情程度和依据应写在正文`);
  for(const key of ['topics','subjects','scopeCues','changeCues']){
    const entries=raw[key];if(entries===undefined&&key!=='topics')continue;
    if(!Array.isArray(entries))throw Error(`${field}.${key}须为字符串数组，省略沿用或[]明确清空`);
    result[key]=[...new Set(entries.map((entry,index)=>{if(typeof entry!=='string'||!entry.trim())throw Error(`${field}.${key}[${index}]须为非空导航名称`);return entry.trim();}))];
  }
  return result as KnowledgeDistribution;
}
export function validateKnowledgeQuery(value:unknown):asserts value is KnowledgeDocumentQuery {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['topic','subject'].includes(k)))throw Error('知识导航查询仅接受topic和subject，名称不限定主体类型');
  for(const [key,entry] of Object.entries(value))if(entry!==undefined&&(typeof entry!=='string'||!entry.trim()))throw Error(`knowledge.${key}须为非空主题或主体名称`);
}
export function knowledgeNavigationText(value:KnowledgeDistribution|undefined):string {
  return value?[...value.topics,...(value.subjects??[]),...(value.scopeCues??[]),...(value.changeCues??[])].join('\n'):'';
}
function matches(text:string,query:string):boolean {
  const normalized=normalize(text),needle=normalize(query);if(normalized.includes(needle))return true;
  const wanted=recallTerms(query),available=recallTerms(text);return wanted.size>0&&[...wanted].every(term=>available.has(term));
}
export function knowledgeQueryMatch(value:KnowledgeDistribution|undefined,query:KnowledgeDocumentQuery,textTerms:readonly string[],bodyText?:string):'navigation'|'body-fallback'|undefined {
  const topic=query.topic,subject=query.subject;
  if(value&&(!topic||matches(value.topics.join('\n'),topic))&&(!subject||matches([...(value.subjects??[]),...(value.scopeCues??[])].join('\n'),subject)))return 'navigation';
  const terms=new Set(textTerms);
  const bodyMatches=(needle:string|undefined)=>!needle||(bodyText!==undefined?matches(bodyText,needle):recallTerms(needle).size>0&&[...recallTerms(needle)].every(term=>terms.has(term)));
  return bodyMatches(topic)&&bodyMatches(subject)?'body-fallback':undefined;
}
export type KnowledgeMaintenanceMatch={topics:string[];subjects:string[];scopeCues:string[];changeCues:string[]};
/** One immutable reading surface can match many documents. Tokenize that same
 * surface once; this matcher and its memo live only for its caller's operation. */
export function knowledgeMaintenanceMatcher(newText:string):(value:KnowledgeDistribution|undefined)=>KnowledgeMaintenanceMatch|undefined {
  if(!newText.trim())return()=>undefined;
  const normalized=normalize(newText),matchedCues=new Map<string,boolean>();let available:Set<string>|undefined;
  const match=(cue:string):boolean=>{
    const known=matchedCues.get(cue);if(known!==undefined)return known;
    let found=normalized.includes(normalize(cue));
    if(!found){const wanted=recallTerms(cue);available??=recallTerms(newText);found=wanted.size>0&&[...wanted].every(term=>available!.has(term));}
    matchedCues.set(cue,found);return found;
  };
  return value=>{
    if(!value?.topics.length)return;
    const matched:KnowledgeMaintenanceMatch={topics:[],subjects:[],scopeCues:[],changeCues:[]};
    for(const key of Object.keys(matched) as (keyof KnowledgeMaintenanceMatch)[])matched[key]=(value[key]??[]).filter(match);
    return Object.values(matched).some(entries=>entries.length)?matched:undefined;
  };
}
export function knowledgeMaintenanceMatch(value:KnowledgeDistribution|undefined,newText:string):KnowledgeMaintenanceMatch|undefined {
  if(!value?.topics.length)return;
  return knowledgeMaintenanceMatcher(newText)(value);
}
/** Inherit navigation only while the current complete prose still carries it. */
export function inheritKnowledgeDistribution(previous:KnowledgeDistribution|undefined,proposal:KnowledgeDistribution|undefined,text:string,withdrawn:readonly string[]):KnowledgeDistribution|undefined {
  const hidden=(cue:string)=>withdrawn.some(word=>!!normalize(word)&&normalize(cue).includes(normalize(word)));
  if(proposal)for(const cues of Object.values(proposal))for(const cue of cues)if(hidden(cue))throw Error('knowledgeDistribution包含已遗忘的导航词，须与当前获准正文一起撤回');
  if(proposal&&!proposal.topics.length)return{topics:[]};
  if(!previous&&!proposal)return;
  const result:KnowledgeDistribution={topics:[]};
  for(const key of ['topics','subjects','scopeCues','changeCues'] as const){
    const explicit=proposal?.[key],inherited=(previous?.[key]??[]).filter(cue=>!hidden(cue)&&matches(text,cue));
    if(explicit!==undefined||inherited.length)result[key]=[...(explicit??inherited)];
  }
  return result.topics.length?result:undefined;
}
export const knowledgeDistributionPolicy='涉及能影响剧情和行为的知识主题时，可在完整opinion上提供knowledgeDistribution导航。正文按实际需要接续通常知情范围及职业/组织/渠道背景、保密或专业门槛支持的默认不知、实际所学、个体例外、部分知情、误信、对外声称、传播及变化；不硬分人物/势力/大众，不要求逐人列举。仅见某人知道不构成完整名单。允许有依据的职业或组织默认推断，明确其依据和不确定条件；退出群体不会自动抹去本人已学。新传播或行为矛盾可触发旧全文回看，命中导航词不自动证明变化或知情。knowledgeMaintenance给已供全文和待展开候选：按需要展开，只有实际新依据影响旧认识才develop/revise；无变化可保留，不为填标签强迫每页改稿。subject-context只提示相关背景；用于判断个体默认范围前，取得knowledgeContextVia指向的主体稿全文，核实当前职业、实际所学和形成阶段，不能据scopeCues推定成员身份。目录标签不能作为事实依据，知情力度、说话者和阶段条件保持在完整正文，旧版保留形成时点。';
