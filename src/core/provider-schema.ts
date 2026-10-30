import type {ModelTool,Service} from './types.ts';
import {validateProviderCapabilities} from './provider-capabilities.ts';
import type {ProviderSchemaReceipt} from './provider-capabilities.ts';

type Schema=Record<string,unknown>;
export class ProviderSchemaError extends Error{constructor(readonly path:string,message:string){super(path+': '+message);this.name='ProviderSchemaError';}}
const fail=(path:string,message:string):never=>{throw new ProviderSchemaError(path,message);};
const object=(value:unknown):value is Schema=>!!value&&typeof value==='object'&&!Array.isArray(value);
const annotations=new Set(['title','description','default']);

function disjoint(branches:Schema[]):boolean{
  // A shared finite-valued discriminator proves oneOf and anyOf equivalent.
  for(const key of Object.keys((branches[0]?.properties??{}) as Schema)){
    const values=branches.map(branch=>{
      if(!(branch.required as string[]|undefined)?.includes(key))return undefined;
      const field=(branch.properties as Record<string,Schema>|undefined)?.[key];
      return field&&('const'in field?[field.const]:Array.isArray(field.enum)?field.enum:undefined);
    });
    if(values.every(value=>value?.length)&&values.every((left,i)=>values.slice(i+1).every(right=>!left!.some(value=>right!.some(other=>JSON.stringify(value)===JSON.stringify(other))))))return true;
  }
  const types=branches.map(branch=>branch.type);
  return types.every(type=>typeof type==='string')&&new Set(types).size===types.length&&!types.includes('number') || types.every(type=>typeof type==='string')&&new Set(types).size===types.length&&!types.includes('integer');
}

function strictSchema(source:Schema,path:string):Schema{
  const schema=structuredClone(source);
  if(schema.allOf!==undefined){
    // Only disjoint object-property intersections are merged. Closed-object
    // intersections and duplicate constraints need a richer surface contract.
    const branches=schema.allOf;if(schema.additionalProperties===false||!Array.isArray(branches)||!branches.length||branches.some(branch=>!object(branch)||branch.type!=='object'||branch.additionalProperties!==undefined&&branch.additionalProperties!==true))fail(path+'.allOf','无法证明该交集与strict表面合同等价');
    const merged:Schema={...schema};delete merged.allOf;merged.type='object';
    const properties={...((merged.properties??{}) as Schema)},required=[...((merged.required??[]) as string[])];
    for(const branch of branches as Schema[]){if(Object.keys(branch).some(key=>!['type','properties','required','additionalProperties'].includes(key)))fail(path+'.allOf','交集含未编译的约束');for(const[key,value]of Object.entries((branch.properties??{}) as Schema)){if(Object.hasOwn(properties,key))fail(path+'.allOf','同字段交集不能静默覆盖');properties[key]=value;}required.push(...((branch.required??[]) as string[]));}
    merged.properties=properties;merged.required=[...new Set(required)];return strictSchema(merged,path);
  }
  if(schema.oneOf!==undefined){
    const branches=schema.oneOf;if(!Array.isArray(branches)||branches.some(branch=>!object(branch))||!disjoint(branches as Schema[]))fail(path+'.oneOf','分支未证明互斥，不能改为anyOf');
    delete schema.oneOf;schema.anyOf=branches;
  }
  if(schema.const!==undefined&&typeof schema.const!=='number'){schema.enum=[schema.const];delete schema.const;}
  const allowed=new Set([...annotations,'type','properties','required','additionalProperties','items','enum','anyOf','pattern','format','minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf','const']);
  for(const key of Object.keys(schema))if(!allowed.has(key)){
    fail(path+'.'+key,'DeepSeek strict不支持且尚无语义等价编译');
  }
  if(schema.anyOf!==undefined){const branches=schema.anyOf;if(!Array.isArray(branches)||!branches.length)return fail(path+'.anyOf','分支无效');schema.anyOf=branches.map((branch:unknown,index:number)=>object(branch)?strictSchema(branch,path+'.anyOf['+index+']'):fail(path,'分支不是schema'));}
  if(schema.type==='object'){
    if(!object(schema.properties??{}))fail(path+'.properties','对象字段无效');
    // Closing an open object would change meaning, even if domain parsers ignore extras.
    if(schema.additionalProperties!==false)fail(path+'.additionalProperties','业务合同允许额外字段，不能在strict表面悄然关闭');
    const properties=(schema.properties??{}) as Record<string,Schema>,keys=Object.keys(properties),required=(schema.required??[]) as string[];schema.properties=properties;
    if(!Array.isArray(required)||required.some(key=>!keys.includes(key)))fail(path+'.required','必填字段无效');
    for(const[key,value]of Object.entries(properties))properties[key]=object(value)?strictSchema(value,path+'.'+key):fail(path+'.'+key,'字段不是schema');
    const optional=keys.filter(key=>!required.includes(key));
    if(optional.length){
      // Preserve omission as omission; never synthesize null or empty objects.
      if(optional.length>8)fail(path,'可选形状展开过大，需要显式拆分工具表面合同');
      const variants:Schema[]=[];for(let mask=0;mask<2**optional.length;mask++){const selected=keys.filter(key=>required.includes(key)||!!(mask&(1<<optional.indexOf(key))));variants.push({...schema,properties:Object.fromEntries(selected.map(key=>[key,properties[key]])),required:selected});}
      return{anyOf:variants};
    }
    schema.required=keys;
  }else if(schema.type==='array'){
    const items=schema.items;if(!object(items))return fail(path+'.items','数组元素schema无效');schema.items=strictSchema(items,path+'[]');
  }else if(schema.type!==undefined&&!['string','number','integer','boolean'].includes(String(schema.type)))fail(path+'.type','该类型尚无strict等价编译');
  if(schema.format!==undefined&&!['email','hostname','ipv4','ipv6','uuid'].includes(String(schema.format)))fail(path+'.format','strict不支持该format');
  return schema;
}

async function digest(value:unknown):Promise<string>{return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))).map(byte=>byte.toString(16).padStart(2,'0')).join('');}
export async function compileProviderTools(service:Service,tools:ModelTool[]):Promise<{tools:{type:'function';function:ModelTool&{strict?:true}}[];schema:ProviderSchemaReceipt}>{
  const capability=service.providerCapabilities;if(capability){validateProviderCapabilities(capability,service);if(tools.length&&!capability.nativeTools)fail('tools','声明渠道不支持原生工具，未回退文本包装');}
  const compiled=tools.map(tool=>({type:'function' as const,function:{name:tool.name,description:tool.description,parameters:capability?.strict?strictSchema(tool.parameters,'tools.'+tool.name):structuredClone(tool.parameters),...(capability?.strict?{strict:true as const}:{})}}));
  return{tools:compiled,schema:{version:'tool-schema-v1',businessDigest:await digest(tools),compiledDigest:await digest(compiled)}};
}
