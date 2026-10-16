import type {FactSource} from '../core/fact-review.ts';

type LiteralSource={id:string;text:string};
type SourcePointer={id:string;blockRef:string;textStart:number;textEnd:number};
type SourceBlock={id:string;text:string};
type SourceMaterial={sources:LiteralSource[]}|{sources:{columns:string[];rows:[string,string,number,number][]};sourceBlocks:SourceBlock[];sourceFormat:string};

/** Display only the already supplied text once. Original p identities and evidence stay in the reviewer. */
export function reviewSourceMaterial(sources:readonly FactSource[]):SourceMaterial{
  const literal={sources:sources.map(({id,text})=>({id,text}))};
  if(!sources.length)return literal;
  const groups=new Map<string,{source:FactSource;index:number}[]>();
  sources.forEach((source,index)=>{
    const key=JSON.stringify([source.evidence.bookId,source.evidence.version]);
    const group=groups.get(key)??[];group.push({source,index});groups.set(key,group);
  });
  const blocks:SourceBlock[]=[],pointers:SourcePointer[]=[];
  for(const group of groups.values()){
    group.sort((a,b)=>a.source.evidence.start-b.source.evidence.start||b.source.evidence.end-a.source.evidence.end);
    let current:{block:SourceBlock;start:number;end:number}|undefined;
    for(const {source,index} of group){
      const {start,end}=source.evidence;
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||source.text.length!==end-start)throw Error('复核来源正文与原文坐标不一致');
      if(!current||start>current.end){
        const block={id:`b${blocks.length+1}`,text:source.text};blocks.push(block);current={block,start,end};
      }else{
        const offset=start-current.start,overlap=Math.min(current.end,end)-start;
        if(current.block.text.slice(offset,offset+overlap)!==source.text.slice(0,overlap))throw Error('复核来源的重叠原文不一致');
        if(end>current.end){current.block.text+=source.text.slice(overlap);current.end=end;}
      }
      pointers[index]={id:source.id,blockRef:current.block.id,textStart:start-current.start,textEnd:end-current.start};
    }
  }
  const shared={sources:{columns:['id','blockRef','textStart','textEnd'],rows:pointers.map(({id,blockRef,textStart,textEnd}):[string,string,number,number]=>[id,blockRef,textStart,textEnd])},sourceBlocks:blocks,sourceFormat:'sources.rows依sources.columns还原每个p；blockRef对应sourceBlocks.text，按UTF16半开区间[textStart,textEnd)还原原文。块仅当前响应包有效；提交来源只用原p编号，不能引用块编号。'};
  const bytes=(value:SourceMaterial)=>new TextEncoder().encode(JSON.stringify(value)).length;
  return bytes(shared)<bytes(literal)?shared:literal;
}
