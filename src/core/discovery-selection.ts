import type {MemoryDocumentIndex} from './memory-discovery.ts';

export type MemoryCandidateLane = 'current'|'history'|'focused'|'coverage';
export type MemoryCandidateSelection = {id:string;lane:MemoryCandidateLane};
export type MemoryCandidateSelectionOptions = {maxChars?:number;maxDocuments?:number;includeHistory?:boolean};
export type MemoryCandidateDocuments = {
  current?:readonly MemoryDocumentIndex[];focused?:readonly MemoryDocumentIndex[];coverage?:readonly MemoryDocumentIndex[];
  /** Authorized metadata for explicitly linked versions, not another retrieval lane. */
  companions?:readonly MemoryDocumentIndex[];
};

function limits(options:MemoryCandidateSelectionOptions):{chars:number;count:number} {
  const chars=options.maxChars??24000,count=options.maxDocuments??8;
  if(!Number.isSafeInteger(chars)||chars<0||!Number.isSafeInteger(count)||count<0||count>8)throw Error('阅读档案选择预算无效');
  return {chars,count};
}

/** Stable lane interleaving. A real old/current pair uses at most two slots per turn. */
export function selectMemoryDocumentCandidates(branches:MemoryCandidateDocuments,options:MemoryCandidateSelectionOptions={}):{ids:string[];selections:MemoryCandidateSelection[];remainingIds:string[]} {
  const budget=limits(options),all=[...(branches.current??[]),...(branches.focused??[]),...(branches.coverage??[]),...(branches.companions??[])];
  const byId=new Map(all.map(item=>[item.id,item])),selected=new Set<string>(),seenHashes=new Set<string>(),remaining=new Set<string>(),selections:MemoryCandidateSelection[]=[];
  let chars=0;
  const lanes:([MemoryCandidateLane,readonly MemoryDocumentIndex[]])[]=[['current',branches.current??[]],['focused',branches.focused??[]],['coverage',branches.coverage??[]]];
  const positions=new Map<MemoryCandidateLane,number>();
  const add=(item:MemoryDocumentIndex,lane:MemoryCandidateLane)=>{
    if(selected.has(item.id)||seenHashes.has(item.bodyHash))return;
    if(!Number.isSafeInteger(item.bodyChars)||item.bodyChars<0)throw Error('阅读档案正文长度无效');
    if(selections.length>=budget.count||chars+item.bodyChars>budget.chars){remaining.add(item.id);return;}
    chars+=item.bodyChars;selected.add(item.id);seenHashes.add(item.bodyHash);remaining.delete(item.id);selections.push({id:item.id,lane});
  };
  const group=(item:MemoryDocumentIndex,lane:MemoryCandidateLane)=>{
    const latest=[...(item.developmentChainIds??[])].reverse().map(id=>byId.get(id)).find((candidate):candidate is MemoryDocumentIndex=>!!candidate);
    if(latest&&latest.id!==item.id){
      if(item.bodyHash===latest.bodyHash)add(latest,lane);
      else if(options.includeHistory){
        if(selections.length+2<=budget.count&&chars+item.bodyChars+latest.bodyChars<=budget.chars){add(item,'history');add(latest,lane);}
        else {add(latest,lane);add(item,'history');}
      }
      else {add(latest,lane);if(!selected.has(latest.id))remaining.add(item.id);}
    }else add(item,lane);
  };
  // Each lane gets an opportunity before another version group from that lane.
  let pending=true;
  while(pending){pending=false;for(const [lane,items] of lanes){let at=positions.get(lane)??0;while(at<items.length&&selected.has(items[at].id))at++;if(at>=items.length){positions.set(lane,at);continue;}pending=true;group(items[at],lane);positions.set(lane,at+1);}}
  return {ids:selections.map(item=>item.id),selections,remainingIds:[...remaining].filter(id=>!selected.has(id))};
}

export function validateMemorySelectionOptions(options:MemoryCandidateSelectionOptions):void {limits(options);}

type RankedDiscoveryCandidate = {memory:{id:string;readingStage?:{start:number;end:number}[];createdAt:number};index:{terms:string[]};score:number};
/** Diversity only changes close relevance ranks; formation coordinates never imply event time. */
export function diverseDiscoveryOrder<T extends RankedDiscoveryCandidate>(ranked:readonly T[],relevance:boolean):T[] {
  if(ranked.length<2)return [...ranked];
  const stage=(item:T)=>Math.min(...(item.memory.readingStage??[]).map(r=>r.start));
  const positions=ranked.map(stage).filter(Number.isFinite),first=positions.length?Math.min(...positions):0,last=positions.length?Math.max(...positions):0;
  const bucket=(item:T)=>{const at=stage(item);return Number.isFinite(at)?Math.min(3,Math.floor((at-first)/(last-first+1)*4)):-1;};
  const unused=[...ranked],chosen:T[]=[],usedStages=new Set<number>(),top=Math.max(0,...ranked.map(item=>item.score));
  const termSets=new Map(ranked.map(item=>[item,new Set(item.index.terms)]));
  // Only the bounded first page is diversified. The chronological/relevance
  // tail remains stable for subsequent navigation without quadratic all-book work.
  while(unused.length&&chosen.length<8){
    let best=0,bestUtility=-Infinity;
    for(let i=0;i<unused.length;i++){
      const item=unused[i],terms=termSets.get(item)!,similarity=chosen.reduce((max,previous)=>{
        let overlap=0;for(const term of previous.index.terms)if(terms.has(term))overlap++;
        return Math.max(max,overlap/Math.max(1,Math.min(terms.size,previous.index.terms.length)));
      },0);
      const base=relevance&&top>0?item.score/top:1;
      const utility=base+(usedStages.has(bucket(item))?0:.15)+(1-similarity)*.1;
      if(utility>bestUtility){best=i;bestUtility=utility;}
    }
    const [item]=unused.splice(best,1);chosen.push(item);usedStages.add(bucket(item));
  }
  return [...chosen,...unused];
}
