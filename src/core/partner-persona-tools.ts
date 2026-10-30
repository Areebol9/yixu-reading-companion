import type {AgentTool} from './agent-port.ts';
import type {PartnerMaintenanceProposal,PartnerPersonaRevision,PartnerPersonaSource,PartnerThemeRevision,PartnerThemeVersion,State} from './types.ts';
import {readPartnerThemes} from './partner-persona.ts';

const identifier={type:'string',minLength:1};
const text={type:'string',minLength:1};
const localEdit={type:'object',properties:{oldText:text,newText:{type:'string'}},required:['oldText','newText'],additionalProperties:false};
const source={oneOf:[
  {type:'object',properties:{kind:{type:'string',enum:['memory','chat']},id:identifier,bookId:identifier,version:identifier},required:['kind','id','bookId','version'],additionalProperties:false},
  {type:'object',properties:{kind:{const:'theme'},id:identifier},required:['kind','id'],additionalProperties:false}
]};
const sources={type:'array',minItems:1,items:source,description:'真实使用的认识、交流或已读个人主题版本；memory/chat须给所属书籍与书籍版本。可用本批成功文档的tN，宿主保存后绑定实际ID；目录本身不作来源。'};
export const partnerMaintenanceSchema={type:'object',description:'仅后台按真实经历维护可变阅读倾向与个人体会，可省略。初始身份、成长背景及用户喜好不能直接改写为伙伴人格。',properties:{
  resolves:{type:'array',minItems:1,uniqueItems:true,items:identifier,description:'可选：本次实际替代或处理的已供入待修订候选id。须同时提交明确persona/themes修订，成功保存后由宿主核对并移除对应候选。'},
  persona:{type:'object',properties:{partnerId:identifier,baseVersionId:identifier,edits:{type:'array',minItems:1,items:{type:'object',properties:{section:{...text,description:'已提供完整人格中实际Markdown小节名称，仅可变阅读倾向与体会。'},oldText:text,newText:{type:'string'}},required:['section','oldText','newText'],additionalProperties:false}},reason:text,sources},required:['partnerId','baseVersionId','edits','reason','sources'],additionalProperties:false},
  themes:{type:'array',minItems:1,items:{type:'object',properties:{partnerId:identifier,themeId:identifier,baseVersionId:identifier,title:text,summary:text,text:{...text,description:'仅新建主题时提供完整正文。接续旧主题仅用精确edits/appendText，未改文字保留。'},edits:{type:'array',minItems:1,items:localEdit},appendText:text,reason:text,sources,retired:{const:true}},required:['partnerId','reason','sources'],oneOf:[{required:['title','summary','text'],not:{anyOf:[{required:['themeId']},{required:['baseVersionId']},{required:['edits']},{required:['appendText']},{required:['retired']}]}},{required:['themeId','baseVersionId'],not:{required:['text']}}],additionalProperties:false}}
},anyOf:[{required:['persona']},{required:['themes']}],additionalProperties:false};

function object(value:unknown,keys:readonly string[],label:string):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw Error(`${label}字段无效`);
  return value as Record<string,unknown>;
}
function requiredText(value:unknown,label:string):string{
  if(typeof value!=='string'||!value.trim())throw Error(`${label}须为非空文字`);return value;
}
function parseSources(value:unknown):PartnerPersonaSource[]{
  if(!Array.isArray(value)||!value.length)throw Error('伙伴修订须给真实认识或交流来源');
  return value.map(raw=>{
    const s=object(raw,['kind','id','bookId','version'],'伙伴修订来源');
    const id=requiredText(s.id,'来源id');
    if(s.kind==='theme'){
      if(s.bookId!==undefined||s.version!==undefined)throw Error('个人主题来源只填实际主题版本id');return{kind:'theme' as const,id};
    }
    if(s.kind!=='memory'&&s.kind!=='chat')throw Error('伙伴修订只接受真实memory/chat或已读theme来源');
    return{kind:s.kind,id,bookId:requiredText(s.bookId,'来源bookId'),version:requiredText(s.version,'来源version')};
  });
}
function parseEdits(value:unknown,persona:boolean):{oldText:string;newText:string;section?:string}[]{
  if(!Array.isArray(value)||!value.length)throw Error('局部修订须有明确oldText/newText');
  return value.map(raw=>{
    const edit=object(raw,persona?['section','oldText','newText']:['oldText','newText'],'伙伴局部修订');
    if(typeof edit.newText!=='string')throw Error('局部修订newText须为文字，明确删除可为空');
    const oldText=requiredText(edit.oldText,'局部修订oldText');
    if(oldText===edit.newText)throw Error('伙伴局部修订须有实际变化');
    return{oldText,newText:edit.newText,...(persona?{section:requiredText(edit.section,'人格目标小节')}:{})};
  });
}
/** Syntax only. Binding, actual exposure, current authority and conflict handling belong to the host commit. */
export function parsePartnerMaintenance(value:unknown):PartnerMaintenanceProposal|undefined{
  if(value===undefined)return;
  const proposal=object(value,['persona','themes','resolves'],'partnerMaintenance');
  let resolves:string[]|undefined;
  if(proposal.resolves!==undefined){
    if(!Array.isArray(proposal.resolves)||!proposal.resolves.length)throw Error('resolves须列明本次实际处理的待修订候选id');
    resolves=proposal.resolves.map(id=>requiredText(id,'待修订候选id'));
    if(new Set(resolves).size!==resolves.length)throw Error('resolves不能重复填写候选id');
  }
  let persona:PartnerPersonaRevision|undefined;
  if(proposal.persona!==undefined){
    const p=object(proposal.persona,['partnerId','baseVersionId','edits','reason','sources'],'人格局部修订');
    persona={partnerId:requiredText(p.partnerId,'partnerId'),baseVersionId:requiredText(p.baseVersionId,'人格原版本'),edits:parseEdits(p.edits,true) as PartnerPersonaRevision['edits'],reason:requiredText(p.reason,'人格修改理由'),sources:parseSources(p.sources)};
  }
  let themes:PartnerThemeRevision[]|undefined;
  if(proposal.themes!==undefined){
    if(!Array.isArray(proposal.themes)||!proposal.themes.length)throw Error('themes须包含明确主题修订');
    themes=proposal.themes.map(raw=>{
      const t=object(raw,['partnerId','themeId','baseVersionId','title','summary','text','edits','appendText','reason','sources','retired'],'个人主题修订');
      const common={partnerId:requiredText(t.partnerId,'partnerId'),reason:requiredText(t.reason,'主题修改理由'),sources:parseSources(t.sources)};
      if(t.themeId===undefined){
        if(['baseVersionId','edits','appendText','retired'].some(key=>t[key]!==undefined))throw Error('新主题须提交完整正文，不填写旧版本或旧稿操作');
        return{...common,title:requiredText(t.title,'新主题title'),summary:requiredText(t.summary,'新主题summary'),text:requiredText(t.text,'新主题text')};
      }
      if(t.text!==undefined)throw Error('已有主题只允许局部edits/appendText，不覆盖完整text');
      if(t.retired!==undefined&&t.retired!==true)throw Error('主题退出须明确retired:true');
      const edits=t.edits===undefined?undefined:parseEdits(t.edits,false);
      const appendText=t.appendText===undefined?undefined:requiredText(t.appendText,'主题追加正文');
      const title=t.title===undefined?undefined:requiredText(t.title,'主题title'),summary=t.summary===undefined?undefined:requiredText(t.summary,'主题summary');
      if(!edits&&!appendText&&!title&&!summary&&!t.retired)throw Error('主题修订须有明确局部或目录变化');
      return{...common,themeId:requiredText(t.themeId,'themeId'),baseVersionId:requiredText(t.baseVersionId,'主题原版本'),...(edits?{edits}:{}),...(appendText?{appendText}:{}),...(title?{title}:{}),...(summary?{summary}:{}),...(t.retired?{retired:true as const}:{})};
    });
  }
  if(!persona&&!themes)throw Error('partnerMaintenance须有实际人格或主题修订');
  return{...(persona?{persona}:{}),...(themes?{themes}:{}),...(resolves?{resolves}:{})};
}

export const partnerMaintenancePolicy='后台可在原finish_reading中用可选partnerMaintenance接续个人阅读主题和有真实依据的阅读倾向；没有实际变化就省略。人格只按实际小节及精确oldText/newText修改可变倾向，保留初始身份与成长背景；主题新建给完整text，旧主题给原版本及局部edits/appendText。每项给理由和实际使用的memory/chat/theme来源，不以用户口味替换伙伴自己的判断。个人主题是跨书体会入口，剧情与原话继续留在原书。';

/** Uses the task's fixed version IDs while rechecking live source permissions at every read. */
export function partnerPersonaTools(options:{getState:()=>State;partnerId:string;themeVersionIds:readonly string[];assertCurrent:()=>void;onRead?:(themes:PartnerThemeVersion[])=>void|Promise<void>}):AgentTool[]{
  const ids=[...new Set(options.themeVersionIds)];
  const available=()=>{options.assertCurrent();return ids.flatMap(id=>{try{return readPartnerThemes(options.getState(),[id],options.partnerId,{history:true});}catch{return[];}});};
  return[
    {name:'list_partner_themes',description:'查看本任务伙伴个人阅读主题的简短目录；主题是跨书体会，目录不提供全文依据。只含任务快照内且当前来源仍有权使用的版本。',parameters:{type:'object',properties:{},additionalProperties:false},execute:async(raw,signal)=>{
      signal.throwIfAborted();object(raw,[],'个人主题目录参数');
      return{partnerId:options.partnerId,themes:available().map(t=>({id:t.id,themeId:t.themeId,title:t.title,summary:t.summary,revision:t.revision,...(t.retired?{retired:true}:{})}))};
    }},
    {name:'read_partner_themes',description:'按本任务个人主题目录中明确的不可变版本id成组读取全文及真实来源。只能读取当前伙伴的任务快照版本；目录不授全文或修改资格。',parameters:{type:'object',properties:{ids:{type:'array',minItems:1,uniqueItems:true,items:identifier}},required:['ids'],additionalProperties:false},execute:async(raw,signal)=>{
      signal.throwIfAborted();const query=object(raw,['ids'],'个人主题全文参数');
      if(!Array.isArray(query.ids)||!query.ids.length||query.ids.some(id=>typeof id!=='string'||!ids.includes(id)))throw Error('主题全文只接受本任务目录中明确的版本id');
      options.assertCurrent();const themes=readPartnerThemes(options.getState(),[...new Set(query.ids as string[])],options.partnerId,{history:true});
      await options.onRead?.(themes);options.assertCurrent();signal.throwIfAborted();return{partnerId:options.partnerId,themes};
    }}
  ];
}
