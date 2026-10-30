/** Optional navigation for complete prose; labels and links never replace it. */
export const documentRoles = ['stage','arc','topic','opinion'] as const;
export type DocumentRole = typeof documentRoles[number];
/** A model-declared maintenance object; labels never infer membership. */
export type DocumentSubject = {key:string;title:string;purpose:string;role:DocumentRole;primary:boolean;aliases?:string[]};
export type DocumentOrganization = {
  roles: DocumentRole[];
  topics?: string[];
  related?: {id:string;reason:string}[];
  /** Omission inherits the predecessor; null explicitly leaves its object. */
  subject?:DocumentSubject|null;
};
export type DocumentOrganizationQuery = {role?:DocumentRole;topic?:string;subjectKey?:string;primary?:boolean};
export const documentOrganizationSchema = {type:'object',description:'完整正文的组织导航。stage=连贯阶段，arc=跨场景剧情线，topic=人物/关系/规则等长期专题，opinion=独立看法；可兼具多项，不强制每批新建。topics填写正文主题/别名；related引用已合法发现的m或本批t编号并说明导航关联；作为判断依据时另在basis声明实际读取的资料，不能把同时出现写成因果。subject由模型明确建立维护对象，key在同书同归属同来源中稳定；书籍共享对象不按生成伙伴拆分，私人对象才按伙伴隔离，title为对象名称、purpose为明确职责、role为该对象用途；primary明确当前主稿，同对象可有多篇成员但最多一篇有效主稿。不同职责可用不同key，标签和文字相似不建立归属。subject:null明确退出对象，省略继承旧版；merge省略时只继承主前驱的subject。各数组[]明确清空。',properties:{
  roles:{type:'array',uniqueItems:true,items:{type:'string',enum:documentRoles}},
  topics:{type:'array',uniqueItems:true,items:{type:'string',minLength:1}},
  related:{type:'array',items:{type:'object',properties:{id:{type:'string',minLength:1},reason:{type:'string',minLength:1}},required:['id','reason'],additionalProperties:false}},
  subject:{anyOf:[{type:'null'},{type:'object',properties:{key:{type:'string',minLength:1},title:{type:'string',minLength:1},purpose:{type:'string',minLength:1},role:{type:'string',enum:documentRoles},primary:{type:'boolean'},aliases:{type:'array',uniqueItems:true,items:{type:'string',minLength:1}}},required:['key','title','purpose','role','primary'],additionalProperties:false}]}
},required:['roles'],additionalProperties:false};
export const documentOrganizationQuerySchema={type:'object',properties:{role:{type:'string',enum:documentRoles},topic:{type:'string',minLength:1},subjectKey:{type:'string',minLength:1,description:'按模型明确建立的稳定维护对象key精确筛选；标签、别名或搜索命中不能建立归属。'},primary:{type:'boolean',description:'只筛选明确属于维护对象且primary等于此值的文档。'}},additionalProperties:false};
export function parseDocumentSubject(value:unknown):DocumentSubject|null {
  if(value===null)return null;
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('organization.subject须为明确维护对象或null');
  const raw=value as Record<string,unknown>;
  if(Object.keys(raw).some(k=>!['key','title','purpose','role','primary','aliases'].includes(k))||
    ['key','title','purpose'].some(k=>typeof raw[k]!=='string'||!(raw[k] as string).trim())||
    !documentRoles.includes(raw.role as DocumentRole)||typeof raw.primary!=='boolean'||
    raw.aliases!==undefined&&(!Array.isArray(raw.aliases)||raw.aliases.some(alias=>typeof alias!=='string'||!alias.trim())))throw Error('organization.subject须明确key、title、purpose、role和primary，aliases仅接受非空名称数组');
  return {key:(raw.key as string).trim(),title:(raw.title as string).trim(),purpose:(raw.purpose as string).trim(),role:raw.role as DocumentRole,primary:raw.primary,
    ...(raw.aliases!==undefined?{aliases:[...new Set((raw.aliases as string[]).map(alias=>alias.trim()))]}:{})};
}
export function parseDocumentOrganization(value:unknown):DocumentOrganization|undefined {
  if(value===undefined)return;
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('organization须为文档导航对象');
  const raw=value as Record<string,unknown>;
  const unexpected=Object.keys(raw).filter(k=>!['roles','topics','related','subject'].includes(k));
  if(unexpected.length)throw Error('organization含未定义字段：'+unexpected.join('、')+'；该层仅允许roles、topics、related、subject'+(unexpected.includes('basis')?'。basis须放在对应documents项下，与organization同级':''));
  if(!Array.isArray(raw.roles))throw Error('organization.roles须为数组，可用stage、arc、topic、opinion');
  const invalid=raw.roles.flatMap((role,index)=>documentRoles.includes(role)?[]:[index]);
  if(invalid.length)throw Error('organization.roles的第'+invalid.join('、')+'项（从0计）仅接受stage、arc、topic、opinion');
  const result:DocumentOrganization={roles:[...new Set(raw.roles)]};
  if(raw.subject!==undefined)result.subject=parseDocumentSubject(raw.subject);
  if(raw.topics!==undefined){if(!Array.isArray(raw.topics)||raw.topics.some(t=>typeof t!=='string'||!t.trim()))throw Error('organization.topics须为非空主题名称数组');result.topics=[...new Set(raw.topics.map(t=>(t as string).trim()))];}
  if(raw.related!==undefined){
    if(!Array.isArray(raw.related)||raw.related.some(r=>!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).some(k=>!['id','reason'].includes(k))||typeof r.id!=='string'||!r.id.trim()||typeof r.reason!=='string'||!r.reason.trim()))throw Error('organization.related须给出具体文档id与关联reason');
    result.related=raw.related.map(r=>({id:r.id,reason:r.reason.trim()}));
    if(new Set(result.related.map(r=>r.id)).size!==result.related.length)throw Error('organization.related不能重复引用同一具体版本');
  }
  return result;
}
export function inheritDocumentOrganization(previous:DocumentOrganization|undefined,next:DocumentOrganization|undefined):DocumentOrganization|undefined {
  return next?structuredClone({...previous,...next}):previous?structuredClone(previous):undefined;
}
export function mergeDocumentOrganizations(values:(DocumentOrganization|undefined)[]):DocumentOrganization|undefined {
  const present=values.filter((value):value is DocumentOrganization=>!!value);if(!present.length)return;
  const links=new Map<string,{id:string;reason:string}>();
  for(const value of present)for(const link of value.related??[]){const old=links.get(link.id);links.set(link.id,old&&old.reason!==link.reason?{id:link.id,reason:old.reason+'\n'+link.reason}:link);}
  // Only the declared main predecessor carries object identity. Another
  // predecessor's primary flag cannot silently assign the merged document.
  return {roles:[...new Set(present.flatMap(value=>value.roles))],topics:[...new Set(present.flatMap(value=>value.topics??[]))],related:[...links.values()],
    ...(values[0]?.subject!==undefined?{subject:structuredClone(values[0].subject)}:{})};
}
export function mapDocumentOrganization(value:DocumentOrganization|undefined,resolve:(id:string)=>string):DocumentOrganization|undefined {
  return value?{...value,...(value.related?{related:value.related.map(link=>({...link,id:resolve(link.id)}))}:{})}:undefined;
}
export function validateDocumentOrganizationQuery(value:unknown):asserts value is DocumentOrganizationQuery {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['role','topic','subjectKey','primary'].includes(k)))throw Error('organization查询仅接受role、topic、subjectKey和primary');
  const q=value as DocumentOrganizationQuery;
  if(q.role!==undefined&&!documentRoles.includes(q.role)||q.topic!==undefined&&(typeof q.topic!=='string'||!q.topic.trim())||q.subjectKey!==undefined&&(typeof q.subjectKey!=='string'||!q.subjectKey.trim())||q.primary!==undefined&&typeof q.primary!=='boolean')throw Error('文档组织查询无效');
}
export function matchesDocumentOrganization(value:DocumentOrganization|undefined,query:DocumentOrganizationQuery):boolean {
  const needle=query.topic?.trim().toLocaleLowerCase();
  return (!query.role||!!value?.roles.includes(query.role)||value?.subject?.role===query.role)&&(!needle||!!value?.topics?.some(topic=>{const label=topic.toLocaleLowerCase();return label.includes(needle)||needle.includes(label);}))&&
    (query.subjectKey===undefined||value?.subject?.key===query.subjectKey.trim())&&(query.primary===undefined||value?.subject?.primary===query.primary);
}
