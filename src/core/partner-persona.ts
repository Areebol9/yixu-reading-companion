import type {Partner,PartnerPersonaExample,PartnerPersonaParameters,PartnerPersonaSnapshot,PartnerPersonaVersion,PartnerPersonaRevision,PartnerPersonaEdit,PartnerPersonaSource,PartnerThemeRevision,PartnerThemeVersion,PartnerPreferences,State} from './types.ts';
import {DEFAULT_PERSONA_TEMPLATE_ID,getPersonaTemplate,personaTemplates} from './persona-templates.ts';
import {bookVersionPrefixLength} from './book-versions.ts';
import {chatAllowsMemory,isEvidenceAllowed,isUsableSourceVersion,memoryIsForgotten} from './context.ts';
import {validateService} from './services.ts';

type PersonaReadState={readonly settings?:{readonly language?:'zh-CN'|'en'};readonly partnerId:string;readonly partners:readonly {readonly id:string;readonly name:string;readonly traits:string;readonly personaVersionId?:string;readonly preferences?:Readonly<Omit<PartnerPreferences,'fixedPersona'>>&{readonly fixedPersona?:readonly (keyof PartnerPersonaParameters)[]}}[];readonly partnerPersonaVersions?:readonly {readonly id:string;readonly partnerId:string;readonly templateId?:string;readonly text:string;readonly adoptedExamples?:readonly PartnerPersonaExample[]}[]};
function nonempty(value:unknown,label:string):asserts value is string{if(typeof value!=='string'||!value.trim())throw Error(`${label}须为非空文字`);}
function partnerRecord(state:State,partnerId:string):Partner{const partner=state.partners.find(p=>p.id===partnerId);if(!partner)throw Error('伙伴不存在');return partner;}
function timestamp(now:number){if(!Number.isFinite(now)||now<0)throw Error('人格记录时间无效');return now;}
function uniqueId(prefix:string){return `${prefix}:${crypto.randomUUID()}`;}

const personaParameterLabels={identityBackground:'身份与背景',values:'价值观与取舍',thinking:'思考习惯',interests:'兴趣与阅读偏好',emotions:'情绪与反应',boundaries:'相处边界',expression:'表达方式'} as const;
type PersonaParameterKey=keyof PartnerPersonaParameters;
const personaParameterKeys=Object.keys(personaParameterLabels) as PersonaParameterKey[];
/** Structural ownership of the accepted templates; their prose remains unchanged. */
const templateSectionDimensions:Record<string,Record<string,readonly PersonaParameterKey[]>>={
  // Old titles remain meaningful for saved versions and already dispatched tasks.
  'chi-xia':{'身份背景':['identityBackground'],'价值取舍':['values'],'思考习惯':['thinking'],'兴趣和阅读喜好':['interests'],'情绪':['emotions'],'相处':['boundaries'],'表达':['expression'],'来历与阅读习气':['identityBackground'],'阅读趣味与价值取舍':['interests','values','emotions'],'思考习惯与认识更新':['thinking','values'],'相处魅力与表达质地':['emotions','boundaries','expression']},
  'song-qingyue':{'来历与眼界':['identityBackground'],'阅读品味与价值取舍':['interests','values','emotions'],'思考习惯与认识更新':['thinking','values'],'相处质地与表达方式':['emotions','boundaries','expression']},
  'su-yan':{'来历与市井底色':['identityBackground'],'阅读偏好与取舍':['interests','values'],'相处温度与独立尺度':['values','emotions','boundaries'],'表达习惯与边界感':['expression','boundaries'],'自知与延展空间':['thinking','interests']},
  'shen-ke':{'来历与底色':['identityBackground'],'审美品味与倾向':['interests','values'],'思考习惯与反差':['thinking','emotions'],'共处与自我认识':['values','emotions','boundaries','expression']},
  'yu-xiaoyu':{'1. 身份背景':['identityBackground'],'2. 价值取舍':['values'],'3. 思考习惯':['thinking'],'4. 兴趣和阅读喜好（初始态，随共读动态演化）':['interests'],'5. 情绪':['emotions'],'6. 相处':['boundaries'],'7. 表达':['expression']},
  'yu-xiaoyu-en':{'1. Identity and background':['identityBackground'],'2. Values and priorities':['values'],'3. Thinking habits':['thinking'],'4. Interests and reading preferences (initial state, evolving through shared reading)':['interests'],'5. Emotions':['emotions'],'6. Getting along':['boundaries'],'7. Expression':['expression']},
  'liang-xiao':{'1. 身份背景':['identityBackground'],'2. 价值取舍':['values'],'3. 思考习惯':['thinking'],'4. 兴趣和阅读喜好（可变部分）':['interests'],'5. 情绪':['emotions'],'6. 相处':['boundaries'],'7. 表达':['expression']}
};
const personaParameterTitle=(key:PersonaParameterKey)=>`当前用户设定：${personaParameterLabels[key]}`;
type ParameterSection={key:PersonaParameterKey;value:string;start:number;end:number;contentStart:number;contentEnd:number};
/** A unique delimiter keeps arbitrary user text, including Markdown headings, verbatim. */
function parameterSections(text:string):ParameterSection[]{
  const result:ParameterSection[]=[];
  for(const match of text.matchAll(/^<!-- partner-persona-parameter:([a-zA-Z]+):([a-z0-9-]+) -->\n## ([^\n]+)\n/gm)){
    const key=match[1] as PersonaParameterKey;
    if(!Object.hasOwn(personaParameterLabels,key)||match[3]!==personaParameterTitle(key))continue;
    const contentStart=match.index!+match[0].length,closing=`\n<!-- /partner-persona-parameter:${key}:${match[2]} -->`,contentEnd=text.indexOf(closing,contentStart);
    if(contentEnd<0||result.some(section=>match.index!<section.end))continue;
    result.push({key,value:text.slice(contentStart,contentEnd),start:match.index!,end:contentEnd+closing.length,contentStart,contentEnd});
  }
  return result;
}
function parameterSectionText(key:PersonaParameterKey,value:string):string{
  let token:string;do{token=crypto.randomUUID();}while(value.includes(token));
  return`<!-- partner-persona-parameter:${key}:${token} -->\n## ${personaParameterTitle(key)}\n${value}\n<!-- /partner-persona-parameter:${key}:${token} -->`;
}
/** Hide only our confirmed storage delimiters; headings and user text remain verbatim. */
export function personaReadableText(text:string):string{
  let readable=text;
  for(const section of parameterSections(text).reverse()){
    const headingStart=text.indexOf('\n',section.start)+1;
    readable=readable.slice(0,section.start)+text.slice(headingStart,section.contentEnd)+readable.slice(section.end);
  }
  return readable;
}
function normalizedParameters(parameters:PartnerPersonaParameters):PartnerPersonaParameters{
  return Object.fromEntries(personaParameterKeys.flatMap(key=>parameters[key]?.trim()?[[key,parameters[key]]]:[]));
}
/** Current version text is authoritative; old actual settings remain readable until explicitly saved. */
export function getPartnerPersonaParameters(snapshot:PartnerPersonaSnapshot):PartnerPersonaParameters{
  const configured=parameterSections(snapshot.text);
  return configured.length?Object.fromEntries(configured.map(section=>[section.key,section.value])):normalizedParameters(snapshot.preferences.persona??{});
}

/** Adoption is explicit data, never inferred from research files or template similarity. */
function validateAdoptedExamples(examples:readonly PartnerPersonaExample[]|undefined):void{
  if(examples===undefined)return;
  if(!Array.isArray(examples))throw Error('已采用人格示范须为数组');
  const ids=new Set<string>();
  for(const example of examples){
    if(!example||typeof example!=='object')throw Error('人格示范资源无效');
    nonempty(example.id,'示范标识');nonempty(example.version,'示范版本');nonempty(example.text,'示范原文');
    if(ids.has(example.id))throw Error('同一人格版本不能同时采用同一示范的多个版本');ids.add(example.id);
    if(!example.source||!['fictional','external'].includes(example.source.kind))throw Error('人格示范须区分虚构情境与外部来源');nonempty(example.source.reference,'示范来源');
    const basis=example.basis;if(!basis||typeof basis!=='object'||(basis.text!==undefined)===(basis.sections!==undefined))throw Error('人格示范须给完整人格或明确小节的适用基准');
    if(basis.text!==undefined)nonempty(basis.text,'示范适用人格原文');
    else{
      if(!Array.isArray(basis.sections)||!basis.sections.length)throw Error('示范适用小节须非空');
      const titles=new Set<string>();for(const section of basis.sections){nonempty(section?.title,'示范适用小节');nonempty(section?.text,'示范适用小节原文');if(titles.has(section.title))throw Error('示范适用小节不能重复');titles.add(section.title);}
    }
    if(basis.parameters!==undefined)validatePartnerPreferences({persona:basis.parameters});
  }
}
/** Changed dependencies retire an example for new tasks while old versions retain it. */
function applicableExampleAdoption(text:string,examples:readonly PartnerPersonaExample[]|undefined,parameters:PartnerPersonaParameters={},templateId?:string):Pick<PartnerPersonaSnapshot,'adoptedExamples'>{
  validateAdoptedExamples(examples);if(!examples?.length)return{};
  const configured=parameterSections(text),currentParameters=configured.length?Object.fromEntries(configured.map(section=>[section.key,section.value])):normalizedParameters(parameters),currentSections=sections(text);
  const adoptedExamples=examples.filter(example=>{
    const basis=example.basis,configuredBasis=basis.text!==undefined?parameterSections(basis.text):[],basisParameters=basis.parameters??(configuredBasis.length?Object.fromEntries(configuredBasis.map(section=>[section.key,section.value])):{});
    // Section-based examples depend only on their declared dimensions. Unknown
    // sections retain the full comparison instead of guessing independence.
    const keys=basis.text!==undefined?personaParameterKeys:basis.sections.flatMap(section=>{
      const configuredKey=personaParameterKeys.find(key=>section.title===personaParameterTitle(key));
      return configuredKey?[configuredKey]:templateId&&templateSectionDimensions[templateId]?.[section.title]||personaParameterKeys;
    });
    if(keys.some(key=>currentParameters[key]!==basisParameters[key]))return false;
    return basis.text!==undefined?basis.text===text:basis.sections.every(section=>{const matching=currentSections.filter(current=>current.title===section.title);return matching.length===1&&matching[0].body===section.text;});
  });
  return adoptedExamples.length?{adoptedExamples:structuredClone(adoptedExamples)}:{};
}
/** User text is preserved as configuration, never invented reading history. */
export function validatePartnerPreferences(value:unknown):asserts value is PartnerPreferences{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['userAddress','partnerAddress','relationshipRequests','backgroundPersona','limitAutomaticRequests','persona','fixedPersona'].includes(key)))throw Error('伙伴相处设置包含不支持的项目');
  const preferences=value as Record<string,unknown>;
  for(const key of ['userAddress','partnerAddress','relationshipRequests']){
    const text=preferences[key];if(text!==undefined&&(typeof text!=='string'||text.length>4000))throw Error('相处要求须为4000字以内的文字');
  }
  if(preferences.backgroundPersona!==undefined&&typeof preferences.backgroundPersona!=='boolean')throw Error('后台人格参与须为开启或关闭');
  if(preferences.limitAutomaticRequests!==undefined&&typeof preferences.limitAutomaticRequests!=='boolean')throw Error('自动请求合并须为开启或关闭');
  const persona=preferences.persona;
  if(persona!==undefined&&(!persona||typeof persona!=='object'||Array.isArray(persona)||Object.keys(persona).some(key=>!Object.hasOwn(personaParameterLabels,key))||Object.values(persona).some(text=>text!==undefined&&(typeof text!=='string'||text.length>4000))))throw Error('人格参数须为支持项目内4000字以内的文字');
  const fixed=preferences.fixedPersona;
  if(fixed!==undefined&&(!Array.isArray(fixed)||fixed.some(key=>typeof key!=='string'||!Object.hasOwn(personaParameterLabels,key))||new Set(fixed).size!==fixed.length))throw Error('长期保持须为支持的人格维度且不能重复');
}

/** Apply only a user's explicit save; ordinary profile changes do not create persona versions. */
export function revisePartnerPersonaParameters(state:State,partnerId:string,parameters:PartnerPersonaParameters,fixedKeys:readonly PersonaParameterKey[],now=Date.now()):{changed:boolean;parametersChanged:boolean;fixedChanged:boolean;version?:PartnerPersonaVersion}{
  validatePartnerPreferences({persona:parameters,fixedPersona:[...fixedKeys]});
  const partner=partnerRecord(state,partnerId),snapshot=getPartnerPersonaSnapshot(state,partnerId),before=getPartnerPersonaParameters(snapshot),next=normalizedParameters(parameters);
  const fixed=personaParameterKeys.filter(key=>fixedKeys.includes(key)),priorFixed=partner.preferences?.fixedPersona??[];
  const parametersChanged=personaParameterKeys.some(key=>before[key]!==next[key]),fixedChanged=fixed.length!==priorFixed.length||fixed.some(key=>!priorFixed.includes(key));
  if(!parametersChanged&&!fixedChanged)return{changed:false,parametersChanged:false,fixedChanged:false};
  timestamp(now);
  const existing=parameterSections(snapshot.text),retainLegacy=existing.length===0&&Object.keys(normalizedParameters(partner.preferences?.persona??{})).length>0;
  let version:PartnerPersonaVersion|undefined;
  if(parametersChanged||retainLegacy){
    let text=snapshot.text;
    for(const section of [...existing].reverse()){
      if(next[section.key]===section.value)continue;
      const start=section.start>=2&&text.slice(section.start-2,section.start)==='\n\n'?section.start-2:section.start;
      text=text.slice(0,start)+(next[section.key]!==undefined?`\n\n${parameterSectionText(section.key,next[section.key]!)}`:'')+text.slice(section.end);
    }
    for(const key of personaParameterKeys)if(next[key]!==undefined&&!existing.some(section=>section.key===key))text+=`\n\n${parameterSectionText(key,next[key]!)}`;
    let previous=partner.personaVersionId?state.partnerPersonaVersions?.find(record=>record.id===partner.personaVersionId&&record.partnerId===partnerId):undefined;
    if(!previous){
      previous={id:uniqueId('persona'),partnerId,templateId:partner.templateId??'legacy',templateVersion:'legacy',text:snapshot.text,createdAt:now,reason:'保留用户配置前的原人格',sources:[]};
      (state.partnerPersonaVersions??=[]).push(previous);
    }
    version={id:uniqueId('persona'),partnerId,templateId:previous.templateId,templateVersion:previous.templateVersion,previousId:previous.id,text,createdAt:now,reason:'用户明确保存人格配置；原文按维度纳入当前人格',sources:[],...applicableExampleAdoption(text,previous.adoptedExamples,next,previous.templateId)};
    (state.partnerPersonaVersions??=[]).push(version);partner.personaVersionId=version.id;
  }
  const preferences={...partner.preferences,fixedPersona:fixed};
  if(version||existing.length)delete preferences.persona;
  partner.preferences=preferences;
  return{changed:true,parametersChanged,fixedChanged,...(version?{version}:{})};
}

/** Existing partners keep their own body until an explicit template choice. */
export function getPartnerPersonaSnapshot(state:PersonaReadState,partnerId=state.partnerId,purpose:'conversation'|'maintenance'='conversation'):PartnerPersonaSnapshot{
  const partner=state.partners.find(p=>p.id===partnerId);if(!partner)throw Error('伙伴不存在');
  if(purpose==='maintenance'&&partner.preferences?.backgroundPersona!==true)return{partnerId:partner.id,name:partner.name,text:'',preferences:{},participation:'none'};
  const version=partner.personaVersionId?state.partnerPersonaVersions?.find(v=>v.id===partner.personaVersionId&&v.partnerId===partner.id):undefined;
  if(partner.personaVersionId&&!version)throw Error('当前伙伴人格版本缺失');
  const text=version?.text??partner.traits;
  return{partnerId:partner.id,...(version?{personaVersionId:version.id}:{}),name:partner.name,text,preferences:{...structuredClone(partner.preferences??{}),...(partner.preferences?.fixedPersona?{fixedPersona:[...partner.preferences.fixedPersona]}:{fixedPersona:undefined})},participation:'persona',...(purpose==='conversation'?{...(state.settings?.language?{language:state.settings.language}:{}),...applicableExampleAdoption(text,version?.adoptedExamples,partner.preferences?.persona,version?.templateId)}:{})};
}

/** Frontstage receives identity and current content; editing rules belong to maintenance. */
export function renderPartnerPersonaSystem(snapshot:PartnerPersonaSnapshot,purpose:'conversation'|'maintenance'='conversation'):string{
  if(snapshot.participation==='none')return '当前执行后台阅读资料维护，依据获准正文与已保存资料履行维护职责。';
  if(purpose==='maintenance')return renderPartnerPersonaMaintenanceSystem(snapshot);
  let text=snapshot.text;
  for(const section of parameterSections(snapshot.text).reverse())text=text.slice(0,section.start)+`## 当前${personaParameterLabels[section.key]}\n${section.value}`+text.slice(section.end);
  const parts=[`你是${snapshot.name}，与读者一起阅读和交流。`,text];
  if(!parameterSections(snapshot.text).length)for(const key of personaParameterKeys){const value=snapshot.preferences.persona?.[key];if(value?.trim())parts.push(`## 当前${personaParameterLabels[key]}\n${value}`);}
  parts.push(...relationshipRequirements(snapshot.preferences));
  if(snapshot.adoptedExamples?.length)parts.push('## 已采用的行为示范\n以下内容以示范身份提供人物在不同语境中的反应。虚构示范和外部表达参照均不属于你与读者实际发生的交流或共同经历。',...snapshot.adoptedExamples.map(example=>`### ${example.source.kind==='fictional'?'虚构示范':'外部表达参照'}\n${example.text}`));
  if(snapshot.language)parts.push(snapshot.language==='en'?'Reply to the reader in English. Preserve original names and quotations where needed.':'请用简体中文与读者交流；需要时保留原名与原文引用。');
  return parts.filter(Boolean).join('\n\n');
}

function relationshipRequirements(preferences:PartnerPreferences,maintenance=false):string[]{
  return[preferences.userAddress?`对读者的称呼：${preferences.userAddress}`:'',preferences.partnerAddress?`读者对${maintenance?'伙伴':'你'}的称呼：${preferences.partnerAddress}`:'',preferences.relationshipRequests?`双方相处要求：${preferences.relationshipRequests}`:''].filter(Boolean);
}

/** Complete editing authority is supplied only to the background maintenance task. */
function renderPartnerPersonaMaintenanceSystem(snapshot:PartnerPersonaSnapshot):string{
  const parts=[`当前伙伴：${snapshot.name}`,'以下完整人格及用户明确配置共同决定伙伴的身份、判断倾向与表达方式。',personaReadableText(snapshot.text)];
  if(snapshot.personaVersionId)parts.splice(1,0,'初始背景为角色设定；实际阅读与共同经历以本次提供的已保存资料为准。');
  const preferences=snapshot.preferences;
  const configured=parameterSections(snapshot.text);
  const parameters=Object.entries(personaParameterLabels).flatMap(([key,label])=>{
    const value=configured.length?undefined:preferences.persona?.[key as keyof typeof personaParameterLabels];return value?.trim()?[`${label}：${value}`]:[];
  });
  if(parameters.length)parts.push('用户已保存的人格维度：对应维度是当前人格的一部分，留空维度沿用完整人格；除身份背景及用户要求长期保持的维度外，可随真实经历继续发展。这些配置属于设定，实际共同经历仍以已保存资料为准。\n'+parameters.join('\n\n'));
  if(configured.length)parts.push('“当前用户设定”小节是本版完整人格的一部分，相应维度以这些小节为准；除身份背景及用户要求长期保持的维度外，可依据真实经历进行有来源的局部修订。');
  const fixed=(preferences.fixedPersona??[]).map(key=>personaParameterLabels[key]);
  parts.push('身份与背景保留当前设定，日常人格维护不改写；用户明确重新配置时可以修改。'+(fixed.length?`用户要求长期保持的人格维度：${fixed.join('、')}。日常维护须保留这些维度，包括原人格相关段落及当前用户设定小节；用户明确重新配置时可以修改。`:''));
  parts.push(...relationshipRequirements(preferences,true));
  return parts.filter(Boolean).join('\n\n');
}

/** A short verbatim excerpt, never a newly authored character biography. */
export function getPartnerPersonaSummary(snapshot:PartnerPersonaSnapshot):string{
  if(snapshot.participation==='none')return '';
  const template=personaTemplates.find(item=>item.text===snapshot.text);if(template?.summary)return template.summary;
  const related=sections(snapshot.text).find(section=>/相处|共处|表达/.test(section.title));
  const body=related?.body??snapshot.text;
  const paragraph=body.split(/\r?\n/).map(line=>line.trim()).find(line=>line&&!/^#{1,6}\s|^>/.test(line))??'';
  return(paragraph.match(/[^。！？]+[。！？]|[^。！？]+$/gu)??[]).slice(0,2).join('').trim();
}

export function createPartnerFromTemplate(state:State,templateId=DEFAULT_PERSONA_TEMPLATE_ID,options:{id?:string;name?:string;now?:number}={}):Partner{
  const template=getPersonaTemplate(templateId),id=options.id??uniqueId('partner');nonempty(id,'伙伴标识');
  if(state.partners.some(p=>p.id===id))throw Error('伙伴标识已存在');
  const name=options.name??template.name;nonempty(name,'伙伴名称');
  const version:PartnerPersonaVersion={id:uniqueId('persona'),partnerId:id,templateId:template.id,templateVersion:template.version,text:template.text,createdAt:timestamp(options.now??Date.now()),reason:'从所选初始人格建立伙伴',sources:[],...applicableExampleAdoption(template.text,template.adoptedExamples,{},template.id)};
  const partner:Partner={id,name,traits:'',backgroundBooks:[],templateId:template.id,personaVersionId:version.id,avatar:structuredClone(template.avatar),preferences:{}};
  (state.partnerPersonaVersions??=[]).push(version);state.partners.push(partner);return partner;
}

/** Explicit language setup may localize an untouched empty archive's default. */
export function initializeDefaultPartnerLanguage(state:State,language:'zh-CN'|'en'):void{
  if(language!=='en'||state.books.length||state.chats.length||state.memories.length||state.usage.length||state.conversations.length||state.partners.length!==1)return;
  const partner=state.partners[0],versions=state.partnerPersonaVersions??[],initial=getPersonaTemplate(DEFAULT_PERSONA_TEMPLATE_ID),previous=versions[0];
  if(partner.id!=='default'||state.partnerId!==partner.id||partner.templateId!==initial.id||partner.name!==initial.name||partner.traits||partner.backgroundBooks.length||Object.keys(partner.preferences??{}).length||versions.length!==1||!previous||previous.id!==partner.personaVersionId||previous.previousId||previous.text!==initial.text||previous.templateId!==initial.id||previous.templateVersion!==initial.version||previous.sources.length||JSON.stringify(partner.avatar)!==JSON.stringify(initial.avatar))return;
  const template=getPersonaTemplate('yu-xiaoyu-en');
  const version:PartnerPersonaVersion={id:uniqueId('persona'),partnerId:partner.id,templateId:template.id,templateVersion:template.version,previousId:previous.id,text:template.text,createdAt:Date.now(),reason:'首次英文设置采用默认英文伙伴',sources:[],...applicableExampleAdoption(template.text,template.adoptedExamples,{},template.id)};
  versions.push(version);partner.templateId=template.id;partner.personaVersionId=version.id;partner.name=template.name;partner.avatar=structuredClone(template.avatar);
}

/** This is an explicit user configuration operation, never an archive migration. */
export function adoptPartnerTemplate(state:State,partnerId:string,templateId:string,now=Date.now()):PartnerPersonaVersion{
  const partner=partnerRecord(state,partnerId),template=getPersonaTemplate(templateId);timestamp(now);
  if(partner.personaVersionId)throw Error('当前伙伴已有人格；选择其他人格时请建立新伙伴');
  let previousId=partner.personaVersionId;
  if(!previousId){
    const original:PartnerPersonaVersion={id:uniqueId('persona'),partnerId,templateId:'legacy',templateVersion:'legacy',text:partner.traits,createdAt:now,reason:'保留采用模板前的原人格',sources:[]};
    (state.partnerPersonaVersions??=[]).push(original);previousId=original.id;
  }else if(!state.partnerPersonaVersions?.some(v=>v.id===previousId&&v.partnerId===partnerId))throw Error('原人格版本缺失');
  const version:PartnerPersonaVersion={id:uniqueId('persona'),partnerId,templateId:template.id,templateVersion:template.version,previousId,text:template.text,createdAt:now,reason:'明确选择初始人格模板',sources:[],...applicableExampleAdoption(template.text,template.adoptedExamples,{},template.id)};
  (state.partnerPersonaVersions??=[]).push(version);partner.personaVersionId=version.id;partner.templateId=template.id;if(!partner.avatar)partner.avatar=structuredClone(template.avatar);
  if(partner.name==='共读伙伴'||!partner.name.trim())partner.name=template.name;
  return version;
}

/** Explicitly replace this character's base body; preserve settings and immutable history. */
export function replacePartnerPersonaFromTemplate(state:State,partnerId:string,templateId:string,now=Date.now()):PartnerPersonaVersion{
  const partner=partnerRecord(state,partnerId),template=getPersonaTemplate(templateId),snapshot=getPartnerPersonaSnapshot(state,partnerId);timestamp(now);
  const current=partner.personaVersionId?state.partnerPersonaVersions?.find(version=>version.id===partner.personaVersionId&&version.partnerId===partnerId):undefined;
  if((current?.templateId??partner.templateId)!==template.id)throw Error('替换正文须保持当前伙伴身份；其他人格请建立新伙伴');
  const parameters=getPartnerPersonaParameters(snapshot),configured=parameterSections(snapshot.text);
  let text=template.text;
  for(const key of personaParameterKeys){
    const value=parameters[key];if(value===undefined)continue;
    const existing=configured.find(section=>section.key===key);
    text+=`\n\n${existing?snapshot.text.slice(existing.start,existing.end):parameterSectionText(key,value)}`;
  }
  // A new explicit adoption captures the user's current related settings. Later
  // unrelated dimension changes do not invalidate these section-based examples.
  const examples=template.adoptedExamples?.map(example=>({...structuredClone(example),basis:{...structuredClone(example.basis),parameters:structuredClone(parameters)}}));
  const adoption=applicableExampleAdoption(text,examples,parameters,template.id);
  if(current?.templateVersion===template.version&&current.text===text&&JSON.stringify(current.adoptedExamples)===JSON.stringify(adoption.adoptedExamples))return current;
  let previous=current;
  if(!previous){
    previous={id:uniqueId('persona'),partnerId,templateId:partner.templateId??'legacy',templateVersion:'legacy',text:snapshot.text,createdAt:now,reason:'保留用户明确替换前的原人格',sources:[]};
    (state.partnerPersonaVersions??=[]).push(previous);
  }
  const version:PartnerPersonaVersion={id:uniqueId('persona'),partnerId,templateId:template.id,templateVersion:template.version,previousId:previous.id,text,createdAt:now,reason:'用户明确采用同一伙伴的完整替换正文；保留原人格与用户配置',sources:[],...adoption};
  (state.partnerPersonaVersions??=[]).push(version);partner.personaVersionId=version.id;partner.templateId=template.id;
  if(partner.preferences?.persona){const preferences={...partner.preferences};delete preferences.persona;partner.preferences=preferences;}
  return version;
}

type Section={title:string;start:number;end:number;body:string};
function sections(text:string):Section[]{
  const parameters=parameterSections(text),headings=[...text.matchAll(/^#{2,4} (.+)$/gm)].filter(heading=>!parameters.some(section=>heading.index!>=section.start&&heading.index!<section.end));
  const base=headings.map((heading,index)=>{
    const start=heading.index!+heading[0].length;let end=headings[index+1]?.index??text.length;
    const parameter=parameters.find(section=>section.start>=start&&section.start<end);
    if(parameter)end=parameter.start>=2&&text.slice(parameter.start-2,parameter.start)==='\n\n'?parameter.start-2:parameter.start;
    return{title:heading[1],start,end,body:text.slice(start,end)};
  });
  return [...base,...parameters.map(section=>({title:personaParameterTitle(section.key),start:section.contentStart,end:section.contentEnd,body:section.value}))].sort((a,b)=>a.start-b.start);
}
function localEdits(text:string,edits:readonly {oldText:string;newText:string}[]):string{
  if(!Array.isArray(edits))throw Error('局部修订须为数组');
  const located=edits.map(edit=>{
    nonempty(edit.oldText,'原段落');if(typeof edit.newText!=='string'||edit.oldText===edit.newText)throw Error('局部修订须给不同的新文字');
    const start=text.indexOf(edit.oldText);if(start<0||text.indexOf(edit.oldText,start+1)>=0)throw Error('修订原文须在目标正文内唯一逐字匹配');
    return{...edit,start,end:start+edit.oldText.length};
  }).sort((a,b)=>a.start-b.start);
  for(let i=1;i<located.length;i++)if(located[i].start<located[i-1].end)throw Error('局部修订段落互相重叠');
  let result='',cursor=0;for(const edit of located){result+=text.slice(cursor,edit.start)+edit.newText;cursor=edit.end;}return result+text.slice(cursor);
}
function unchangedEditParagraphs(base:string,current:string,edits:readonly {oldText:string;newText:string}[]):boolean{
  return edits.every(edit=>{
    if(!edit||typeof edit.oldText!=='string'||!edit.oldText)return false;
    const before=base.indexOf(edit.oldText),after=current.indexOf(edit.oldText);
    if(before<0||after<0||base.indexOf(edit.oldText,before+1)>=0||current.indexOf(edit.oldText,after+1)>=0)return false;
    const paragraph=(text:string,start:number)=>{const end=text.indexOf('\n\n',start+edit.oldText.length),boundary=text.lastIndexOf('\n\n',start);return text.slice(boundary<0?0:boundary+2,end<0?text.length:end);};
    return paragraph(base,before)===paragraph(current,after);
  });
}
function personaText(current:PartnerPersonaVersion,base:PartnerPersonaVersion,edits:readonly PartnerPersonaEdit[],fixedKeys:readonly PersonaParameterKey[]):string{
  if(!Array.isArray(edits)||!edits.length)throw Error('人格修订须有明确局部修改');
  const template=personaTemplates.find(item=>item.id===current.templateId),dimensions=templateSectionDimensions[current.templateId];if(base.templateId!==current.templateId||base.templateVersion!==current.templateVersion)throw Error('人格模板已改变，请接续当前版本');
  const baseSections=sections(base.text),currentSections=sections(current.text),grouped=new Map<string,PartnerPersonaEdit[]>();
  for(const edit of edits){
    if(!edit||typeof edit.section!=='string'||template?.protectedSections.includes(edit.section)||dimensions?.[edit.section]?.includes('identityBackground')||edit.section===personaParameterTitle('identityBackground'))throw Error('初始身份与来历不在日常修订范围');
    const configuredKey=personaParameterKeys.find(key=>edit.section===personaParameterTitle(key));
    if(!template&&!configuredKey)throw Error('该原人格尚无明确的小节维护边界，保留原文；用户配置的小节可按现有维度维护');
    if(fixedKeys.some(key=>edit.section===personaParameterTitle(key)||dimensions?.[edit.section]?.includes(key)))throw Error('用户要求长期保持的人格维度不在日常修订范围');
    if(typeof edit.newText!=='string'||/^#{1,6}\s/m.test(edit.newText)||/<!-- \/?partner-persona-parameter:/.test(edit.newText))throw Error('局部修改不能增改人格标题或小节边界');
    grouped.set(edit.section,[...(grouped.get(edit.section)??[]),edit]);
  }
  const replacements:{oldText:string;newText:string}[]=[];
  for(const [title,changes]of grouped){
    const before=baseSections.filter(s=>s.title===title),live=currentSections.filter(s=>s.title===title);
    if(before.length!==1||live.length!==1||!unchangedEditParagraphs(before[0].body,live[0].body,changes))throw Error('人格目标段落已有变化，保留本次修订候选');
    const body=localEdits(live[0].body,changes);nonempty(body,'修订后小节');replacements.push({oldText:live[0].body,newText:body});
  }
  const text=localEdits(current.text,replacements),before=parameterSections(current.text),after=parameterSections(text);
  if(before.length!==after.length||before.some(section=>!after.some(next=>next.key===section.key)))throw Error('局部修改须保留用户设定小节边界');
  if(before.some(section=>(section.key==='identityBackground'||fixedKeys.includes(section.key))&&after.find(next=>next.key===section.key)?.value!==section.value))throw Error('局部修改须保留身份背景及长期保持的人格维度');
  return text;
}

function sourceAvailable(state:State,partnerId:string,source:PartnerPersonaSource,live:boolean,seen:Set<string>):boolean{
  if(!source||typeof source.id!=='string'||!source.id)return false;
  if(source.kind==='theme'){
    const theme=state.partnerThemes?.find(t=>t.id===source.id&&t.partnerId===partnerId);
    if(!theme||seen.has(theme.id))return false;
    const visited=new Set(seen);visited.add(theme.id);
    return(!live||!theme.retired)&&theme.sources.length>0&&theme.sources.every(s=>sourceAvailable(state,partnerId,s,live,visited));
  }
  if(source.kind!=='memory'&&source.kind!=='chat')return false;
  const book=state.books.find(b=>b.id===source.bookId);if(!book||bookVersionPrefixLength(book,source.version)===undefined)return false;
  if(source.kind==='memory'){
    const memory=state.memories.find(m=>m.id===source.id&&m.bookId===book.id&&m.partnerId===partnerId);
    return!!memory&&(!live||isUsableSourceVersion(state,memory)&&!memoryIsForgotten(state,memory)&&isEvidenceAllowed(book,memory.evidence)&&memory.evidence.every(e=>e.bookId===book.id&&e.end<=(bookVersionPrefixLength(book,source.version)??0)));
  }
  const chat=state.chats.find(c=>c.id===source.id&&c.bookId===book.id&&(!c.partnerId||c.partnerId===partnerId));
  return!!chat&&(!live||!chat.excluded&&!chat.futureGrant&&!chat.replacedBy&&!chat.outdatedBy&&chatAllowsMemory(state,chat)&&isEvidenceAllowed(book,chat.evidence)&&chat.evidence.every(e=>e.bookId===book.id&&e.end<=(bookVersionPrefixLength(book,source.version)??0)));
}
function assertSources(state:State,partnerId:string,sources:readonly PartnerPersonaSource[],live=true){
  if(!Array.isArray(sources)||!sources.length||sources.some(s=>!sourceAvailable(state,partnerId,s,live,new Set())))throw Error('伙伴修订须引用本伙伴真实、可用的已保存来源');
}

export function applyPartnerPersonaRevision(state:State,proposal:PartnerPersonaRevision,now=Date.now()):PartnerPersonaVersion{
  const partner=partnerRecord(state,proposal.partnerId),current=state.partnerPersonaVersions?.find(v=>v.id===partner.personaVersionId&&v.partnerId===partner.id),base=state.partnerPersonaVersions?.find(v=>v.id===proposal.baseVersionId&&v.partnerId===partner.id);
  if(!current||!base)throw Error('人格修订基准版本缺失');nonempty(proposal.reason,'修订理由');assertSources(state,partner.id,proposal.sources);timestamp(now);
  const text=personaText(current,base,proposal.edits,partner.preferences?.fixedPersona??[]);if(text===current.text)throw Error('人格修订未形成实际变化');
  const version:PartnerPersonaVersion={id:uniqueId('persona'),partnerId:partner.id,templateId:current.templateId,templateVersion:current.templateVersion,previousId:current.id,text,createdAt:now,reason:proposal.reason,sources:structuredClone(proposal.sources),edits:structuredClone(proposal.edits),...applicableExampleAdoption(text,current.adoptedExamples,partner.preferences?.persona,current.templateId)};
  state.partnerPersonaVersions!.push(version);partner.personaVersionId=version.id;return version;
}

function themeHeads(state:Pick<State,'partnerThemes'>,partnerId:string):PartnerThemeVersion[]{
  const versions=(state.partnerThemes??[]).filter(t=>t.partnerId===partnerId),parents=new Set(versions.map(t=>t.previousId));return versions.filter(t=>!parents.has(t.id));
}
export function partnerThemeGuide(state:State,partnerId=state.partnerId):Pick<PartnerThemeVersion,'id'|'themeId'|'title'|'summary'|'revision'>[]{
  return themeHeads(state,partnerId).filter(t=>!t.retired&&t.sources.length>0&&t.sources.every(s=>sourceAvailable(state,partnerId,s,true,new Set([t.id])))).map(({id,themeId,title,summary,revision})=>({id,themeId,title,summary,revision}));
}
export function readPartnerThemes(state:State,ids:readonly string[],partnerId=state.partnerId,options:{history?:boolean}={}):PartnerThemeVersion[]{
  const allowed=options.history?state.partnerThemes??[]:themeHeads(state,partnerId);
  return ids.map(id=>{const theme=allowed.find(t=>t.id===id&&t.partnerId===partnerId);if(!theme||theme.retired)throw Error('个人阅读主题版本不可用');assertSources(state,partnerId,theme.sources);return structuredClone(theme);});
}

export function applyPartnerThemeRevision(state:State,proposal:PartnerThemeRevision,now=Date.now()):PartnerThemeVersion{
  partnerRecord(state,proposal.partnerId);nonempty(proposal.reason,'修订理由');assertSources(state,proposal.partnerId,proposal.sources);timestamp(now);
  let previous:PartnerThemeVersion|undefined,text:string,title:string,summary:string;
  if(proposal.themeId){
    const heads=themeHeads(state,proposal.partnerId).filter(t=>t.themeId===proposal.themeId),base=state.partnerThemes?.find(t=>t.id===proposal.baseVersionId&&t.themeId===proposal.themeId&&t.partnerId===proposal.partnerId);
    if(heads.length!==1||!base)throw Error('个人主题修订基准版本缺失');previous=heads[0];
    if(previous.retired)throw Error('该个人主题已结束');if(proposal.text!==undefined)throw Error('已有个人主题须局部修订，不能整稿覆盖');
    if(base.id!==previous.id&&(!unchangedEditParagraphs(base.text,previous.text,proposal.edits??[])||proposal.appendText!==undefined&&base.text!==previous.text||proposal.title!==undefined&&base.title!==previous.title||proposal.summary!==undefined&&base.summary!==previous.summary||proposal.retired&&base.text!==previous.text))throw Error('个人主题目标已有变化，保留本次修订候选');
    text=localEdits(previous.text,proposal.edits??[]);if(proposal.appendText!==undefined){nonempty(proposal.appendText,'追加正文');text+='\n\n'+proposal.appendText;}
    title=proposal.title??previous.title;summary=proposal.summary??previous.summary;
    if(text===previous.text&&title===previous.title&&summary===previous.summary&&!proposal.retired)throw Error('个人主题修订未形成实际变化');
  }else{
    if(proposal.baseVersionId!==undefined||proposal.edits!==undefined||proposal.appendText!==undefined||proposal.retired)throw Error('新主题须给完整正文与真实来源');
    nonempty(proposal.text,'主题正文');nonempty(proposal.title,'主题标题');nonempty(proposal.summary,'主题导览');text=proposal.text;title=proposal.title;summary=proposal.summary;
  }
  nonempty(text,'主题正文');nonempty(title,'主题标题');nonempty(summary,'主题导览');
  const version:PartnerThemeVersion={id:uniqueId('theme-version'),themeId:previous?.themeId??uniqueId('theme'),partnerId:proposal.partnerId,...(previous?{previousId:previous.id}:{}),revision:(previous?.revision??0)+1,title,summary,text,reason:proposal.reason,sources:structuredClone(proposal.sources),createdAt:now,...(proposal.edits?{edits:structuredClone(proposal.edits)}:{}),...(proposal.appendText?{appendText:proposal.appendText}:{}),...(proposal.retired?{retired:true}:{})};
  (state.partnerThemes??=[]).push(version);return version;
}

/** Validate persisted references without treating superseded evidence as current. */
export function validatePartnerPersonas(state:State):void{
  for(const collection of [state.partnerPersonaVersions,state.partnerThemes]){
    if(collection!==undefined&&!Array.isArray(collection))throw Error('伙伴资料集合无效');const seen=new Set<string>();
    for(const record of collection??[]){if(!record||typeof record.id!=='string'||!record.id||seen.has(record.id)||!state.partners.some(p=>p.id===record.partnerId))throw Error('伙伴资料身份无效');seen.add(record.id);timestamp(record.createdAt);nonempty(record.reason,'伙伴资料理由');}
  }
  if(state.partnerMaintenanceCandidates!==undefined&&!Array.isArray(state.partnerMaintenanceCandidates))throw Error('人格维护原候选集合无效');
  const candidateIds=new Set<string>();
  for(const candidate of state.partnerMaintenanceCandidates??[]){
    if(!candidate||typeof candidate.id!=='string'||!candidate.id||candidateIds.has(candidate.id)||!state.partners.some(p=>p.id===candidate.partnerId)||!state.books.some(b=>b.id===candidate.bookId)||candidate.usageId!==undefined&&!state.usage.some(u=>u.id===candidate.usageId)||!Object.hasOwn(candidate,'proposal'))throw Error('人格维护原候选身份无效');
    candidateIds.add(candidate.id);nonempty(candidate.reason,'原候选保存理由');timestamp(candidate.createdAt);
  }
  for(const partner of state.partners){
    if(partner.preferences!==undefined)validatePartnerPreferences(partner.preferences);
    if(partner.modelService!==undefined)validateService(partner.modelService);
    const avatar=partner.avatar;if(avatar!==undefined&&(!avatar||avatar.kind==='preset'&&(typeof avatar.id!=='string'||!avatar.id)||avatar.kind==='image'&&(typeof avatar.assetId!=='string'||!avatar.assetId)||!['preset','image'].includes(avatar.kind)))throw Error('伙伴头像引用无效');
    if(partner.personaVersionId&&!state.partnerPersonaVersions?.some(v=>v.id===partner.personaVersionId&&v.partnerId===partner.id))throw Error('当前人格指向无效');
  }
  for(const version of state.partnerPersonaVersions??[]){
    if(typeof version.text!=='string'||typeof version.templateId!=='string'||typeof version.templateVersion!=='string'||!Array.isArray(version.sources))throw Error('人格版本正文无效');
    validateAdoptedExamples(version.adoptedExamples);
    if(version.previousId&&!state.partnerPersonaVersions?.some(v=>v.id===version.previousId&&v.partnerId===version.partnerId&&v.id!==version.id))throw Error('人格前版引用无效');
    if(version.sources.length)assertSources(state,version.partnerId,version.sources,false);
    let cursor:PartnerPersonaVersion|undefined=version;const visited=new Set<string>();
    while(cursor){if(visited.has(cursor.id))throw Error('人格版本前后引用形成循环');visited.add(cursor.id);cursor=state.partnerPersonaVersions?.find(v=>v.id===cursor!.previousId);}
  }
  for(const theme of state.partnerThemes??[]){
    nonempty(theme.themeId,'主题标识');nonempty(theme.title,'主题标题');nonempty(theme.summary,'主题导览');nonempty(theme.text,'主题正文');assertSources(state,theme.partnerId,theme.sources,false);
    if(!Number.isSafeInteger(theme.revision)||theme.revision<1||theme.retired!==undefined&&theme.retired!==true)throw Error('主题版本无效');
    const previous=theme.previousId&&state.partnerThemes?.find(t=>t.id===theme.previousId&&t.themeId===theme.themeId&&t.partnerId===theme.partnerId);
    if(theme.previousId? !previous||previous.revision!==theme.revision-1:theme.revision!==1)throw Error('主题前版引用无效');
  }
  for(const partner of state.partners){const heads=themeHeads(state,partner.id),seen=new Set<string>();for(const theme of heads){if(seen.has(theme.themeId))throw Error('同一个人主题存在冲突的当前版本');seen.add(theme.themeId);}}
}

/** Normal archive restore retains immutable versions required by local tasks. */
export function mergePartnerPersonas(target:State,local:State):void{
  const partnerIds=new Set(target.partners.map(p=>p.id));
  for(const key of ['partnerPersonaVersions','partnerThemes'] as const){
    const records=new Map((target[key]??[]).map(v=>[v.id,v]));
    for(const record of local[key]??[]){if(!partnerIds.has(record.partnerId))continue;const prior=records.get(record.id);if(prior&&JSON.stringify(prior)!==JSON.stringify(record))throw Error('同一伙伴资料版本出现冲突，原件保持');if(!prior)records.set(record.id,structuredClone(record));}
    if(records.size)(target as unknown as Record<string,unknown>)[key]=[...records.values()];
  }
  for(const partner of target.partners){
    const current=local.partners.find(p=>p.id===partner.id);if(!current?.personaVersionId)continue;
    let cursor=local.partnerPersonaVersions?.find(v=>v.id===current.personaVersionId);const visited=new Set<string>();
    while(cursor&&!visited.has(cursor.id)){if(cursor.id===partner.personaVersionId||!partner.personaVersionId&&cursor.templateId==='legacy'&&cursor.text===partner.traits){partner.personaVersionId=current.personaVersionId;partner.templateId=current.templateId;break;}visited.add(cursor.id);cursor=local.partnerPersonaVersions?.find(v=>v.id===cursor!.previousId);}
  }
  const candidates=new Map((target.partnerMaintenanceCandidates??[]).map(c=>[c.id,c]));
  for(const candidate of local.partnerMaintenanceCandidates??[])if(partnerIds.has(candidate.partnerId)&&target.books.some(b=>b.id===candidate.bookId)){
    const prior=candidates.get(candidate.id);if(prior&&JSON.stringify(prior)!==JSON.stringify(candidate))throw Error('同一人格维护原候选出现冲突');if(!prior)candidates.set(candidate.id,structuredClone(candidate));
  }
  if(candidates.size)target.partnerMaintenanceCandidates=[...candidates.values()];
  validatePartnerPersonas(target);
}
