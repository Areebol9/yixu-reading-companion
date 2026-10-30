import {documentOrganizationSchema} from './document-organization.ts';

/** A task-local candidate is derived from explicit model submissions. Original
 * responses stay in the native/usage records; amendment never edits those. */
export type ReadingDocumentCandidate={id:string;payload:Record<string,unknown>;submissionHash?:string;normalizations?:ReadingSubmissionNormalization[]};
type Change={path:string;value?:unknown;remove?:boolean};
const fields=['documents','views','reinforce','working','understanding','focus','paragraphComments','reaction','partnerMaintenance'];
const arrayFields=fields.filter(field=>!['understanding','reaction','partnerMaintenance'].includes(field));
export type ReadingSubmissionNormalization='trailing-closers'|'arguments-wrapper';
export type ParsedReadingSubmissionPayload={value:Record<string,unknown>;normalizations:ReadingSubmissionNormalization[]};
/** Locate a complete root object without treating brackets in JSON strings as
 * structure. JSON.parse still validates every byte inside that object. */
function readingObjectEnd(text:string):number|undefined{
  if(text[0]!=='{')return;
  const stack:string[]=[];let quoted=false,escaped=false;
  for(let index=0;index<text.length;index++){
    const char=text[index];
    if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;continue;}
    if(char==='"'){quoted=true;continue;}
    if(char==='{'||char==='[')stack.push(char);
    else if(char==='}'||char===']'){
      if(stack.pop()!==(char==='}'?'{':'['))return;
      if(!stack.length)return index+1;
    }
  }
}
/** Syntax feedback explains the existing contract; it never chooses where an
 * ambiguous expression belongs or drops any part of the settled response. */
function parseReadingJson(text:string):unknown{
  try{return JSON.parse(text);}catch(error){
    if(!(error instanceof SyntaxError))throw error;
    const hasReaction=[...text.matchAll(/"(?:[^"\\]|\\.)*"/g)].some(token=>token[0]==='"reaction"'&&/^\s*:/.test(text.slice(token.index!+token[0].length)));
    throw new SyntaxError(error.message+'；请保留原有文字，修正JSON字段名、括号及分隔符后沿原任务续交。'+(hasReaction?'reaction只接受一个对象；若要发表多条段评，使用paragraphComments数组，每项含sourceId、quote、text，不在对象内并列无字段名的对象。':'')+'完整原答保持。',{cause:error});
  }
}
/** Derive only the two unambiguous reading carrier corrections. No document,
 * string, target, candidate identity or original response is rewritten here.
 * Domain shape/source/version validation follows this parser as usual. */
export function parseReadingSubmissionPayload(raw:string):ParsedReadingSubmissionPayload{
  const text=raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''),normalizations:ReadingSubmissionNormalization[]=[];
  let parsed:unknown;
  try{parsed=parseReadingJson(text);}catch(error){
    const end=readingObjectEnd(text);
    if(end===undefined||!/^\s*[}\]](?:\s*[}\]])*\s*$/.test(text.slice(end)))throw error;
    // A complete, valid object must exist before an entirely closing-only tail.
    // Missing punctuation, truncation and additional values remain errors.
    parsed=parseReadingJson(text.slice(0,end));normalizations.push('trailing-closers');
  }
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('阅读候选须为JSON对象');
  let value=parsed as Record<string,unknown>;
  if(Object.keys(value).length===1&&Object.hasOwn(value,'arguments')){
    let inner=value.arguments;
    // A single JSON-string carrier is decoded exactly once. The contained JSON
    // must already be complete: no punctuation repair or recursive decoding.
    if(typeof inner==='string')try{inner=JSON.parse(inner);}catch{}
    if(inner&&typeof inner==='object'&&!Array.isArray(inner)&&Object.keys(inner).some(key=>[...fields,'candidate','changes','readingStage','quiet','sceneInsight'].includes(key))){
      value=inner as Record<string,unknown>;normalizations.push('arguments-wrapper');
    }
  }
  return{value,normalizations};
}
export const readingDocumentFactFields:ReadonlySet<string>=new Set(['readingStage','createdAt','updatedAt','bodyHash','bodyChars','canUpdate','navigationOnly','bodyFormat']);
const emptyObject=(value:unknown):boolean=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===0;
/** Optional metadata may have no value; body edits and known clearing values
 * never pass through this omission. Unknown populated members still fail the
 * ordinary domain validator, as do missing required organization members. */
const emptyUnknownMetadata=(value:unknown):boolean=>value===null||typeof value==='string'&&!value.trim()||emptyObject(value);
/** Relocate the two known misplaced metadata fields on a derived candidate.
 * Empty optional metadata is omitted before comparing copies, while valued
 * conflicts remain for combined diagnosis. */
export function normalizeReadingDocumentPlacement(value:Record<string,unknown>,index:number):{document:Record<string,unknown>;errors:string[]}{
  const document={...value},organization=value.organization,errors:string[]=[];
  if(typeof document.documentTitle==='string'&&!document.documentTitle.trim())delete document.documentTitle;
  if(emptyObject(document.knowledgeDistribution))delete document.knowledgeDistribution;
  if(!organization||typeof organization!=='object'||Array.isArray(organization))return{document,errors};
  const navigation={...organization} as Record<string,unknown>;
  if(emptyObject(navigation.knowledgeDistribution))delete navigation.knowledgeDistribution;
  for(const field of ['navigationCues','knowledgeDistribution'])if(navigation[field]!==undefined){
    if(document[field]!==undefined&&!equal(document[field],navigation[field])){
      errors.push(`documents[${index}].organization.${field}与documents[${index}].${field}的值冲突；保留原答，请明确选择同一字段的值`);continue;
    }
    document[field]=navigation[field];delete navigation[field];
  }
  for(const key of Object.keys(navigation))if(emptyUnknownMetadata(navigation[key])&&!Object.hasOwn(documentOrganizationSchema.properties,key)&&!['navigationCues','knowledgeDistribution'].includes(key))delete navigation[key];
  document.organization=navigation;return{document,errors};
}
/** Remove host-owned duplicates and relocate known misplaced metadata on a
 * derived candidate only. Original responses and submission hashes stay intact. */
export function readingCandidateContent(value:Record<string,unknown>):Record<string,unknown>{
  const {readingStage:_,...content}=value;
  for(const field of ['documents','views'] as const)if(Array.isArray(content[field]))content[field]=content[field].map((item,index)=>{
    if(!item||typeof item!=='object'||Array.isArray(item))return item;
    const body=Object.fromEntries(Object.entries(item).filter(([key])=>field==='documents'?!readingDocumentFactFields.has(key):key!=='readingStage'));
    return field==='documents'?normalizeReadingDocumentPlacement(body,index).document:body;
  });
  return content;
}
export const candidateFields={candidate:{type:'string',description:'续交时引用工具返回的candidate；未改部分保留，tN编号沿原documents顺序。可直接填写要替换的字段，或用changes修改局部。'},changes:{type:'array',items:{type:'object',properties:{path:{type:'string',description:'JSON Pointer，如 /views/0 或 /documents/1/edits/0/newText。数组尾部用 /- 或当前长度追加；documents不可删除数组项，其余数组可明确删除。'},value:{description:'明确替换或追加值；与remove:true二选一。'},remove:{type:'boolean',description:'true删除指定字段或非documents数组项；documents原有位置保留，避免改变tN。'}},required:['path'],additionalProperties:false}}};
export function validateCandidateAmendment(value:Record<string,unknown>):void{
  if(typeof value.candidate!=='string'||!value.candidate||value.changes!==undefined&&!Array.isArray(value.changes)||Object.keys(value).some(k=>!['candidate','changes','readingStage',...fields].includes(k)))throw Error('候选续交使用candidate及要修改的字段或changes；未改内容保留，确认原候选可用changes:[]');
  for(const raw of value.changes as unknown[]??[]){const change=raw as Change;if(!change||typeof change!=='object'||Array.isArray(change)||Object.keys(change).some(k=>!['path','value','remove'].includes(k))||typeof change.path!=='string'||!change.path.startsWith('/')||change.remove!==undefined&&change.remove!==true||(change.remove===true)===Object.hasOwn(change,'value'))throw Error('候选修改须给path及value或remove:true');}
}
const equal=(a:unknown,b:unknown):boolean=>{
  if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
  const left=Object.keys(a),right=Object.keys(b);return left.length===right.length&&left.every(key=>Object.hasOwn(b,key)&&equal((a as Record<string,unknown>)[key],(b as Record<string,unknown>)[key]));
};
export function resolveReadingCandidate(raw:unknown,previous:ReadingDocumentCandidate|undefined):Record<string,unknown>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('阅读候选须为JSON对象');
  const value=raw as Record<string,unknown>;
  if(!Object.hasOwn(value,'candidate'))return readingCandidateContent(structuredClone(value));
  validateCandidateAmendment(value);
  if(!previous||previous.id!==value.candidate)throw Error('候选编号不属于本任务当前已保存候选；请使用最近反馈中的candidate');
  const result=structuredClone(previous.payload);
  const touched=new Set<string>();
  for(const change of value.changes as Change[]??[]){
    const segments=change.path.slice(1).split('/').map(s=>s.replace(/~1/g,'/').replace(/~0/g,'~'));
    // An invalid first submission can contain extra top-level fields. Removing
    // those exact fields is a correction, not permission to introduce new ones.
    const removesExtraRoot=change.remove===true&&segments.length===1&&Object.hasOwn(result,segments[0]);
    if(!fields.includes(segments[0])&&!removesExtraRoot||segments.some(s=>!s||['__proto__','prototype','constructor'].includes(s)))throw Error('候选修改路径无效');
    touched.add(segments[0]);
    if(segments.length===2&&arrayFields.includes(segments[0])&&!Object.hasOwn(result,segments[0])&&(segments[1]==='0'||segments[1]==='-')&&!change.remove)result[segments[0]]=[];
    let parent:any=result;
    for(const key of segments.slice(0,-1)){if(!parent||typeof parent!=='object'||!Object.hasOwn(parent,key))throw Error('候选修改父路径不存在：'+change.path);parent=parent[key];}
    const key=segments.at(-1)!;
    if(!parent||typeof parent!=='object')throw Error('候选修改父对象无效：'+change.path);
    if(Array.isArray(parent)){
      const index=key==='-'?parent.length:/^(0|[1-9]\d*)$/.test(key)?Number(key):-1;
      if(index<0||index>parent.length||change.remove&&index===parent.length)throw Error('候选数组位置不存在：'+change.path+'；追加使用/-或当前长度'+parent.length);
      if(change.remove){if(segments.length===2&&segments[0]==='documents')throw Error('documents不能删除数组项或改变既有tN；可修改原项，新增文档在尾部追加');parent.splice(index,1);}
      else parent[index]=structuredClone(change.value);
    }else if(change.remove)delete parent[key];else parent[key]=structuredClone(change.value);
  }
  for(const field of fields)if(Object.hasOwn(value,field)){
    if(touched.has(field)&&!equal(result[field],value[field]))throw Error(`候选${field}与changes对同一字段给出冲突结果；只保留一个明确修改`);
    result[field]=structuredClone(value[field]);
  }
  if(Array.isArray(previous.payload.documents)&&(!Array.isArray(result.documents)||result.documents.length<previous.payload.documents.length))throw Error('documents不能删除数组项或缩短原候选，既有tN位置须保留');
  return readingCandidateContent(result);
}
