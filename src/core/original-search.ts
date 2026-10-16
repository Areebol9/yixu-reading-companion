import {bookLength,bookTextSlice} from './books.ts';
import {readableRanges,evidence} from './context.ts';
import {rangeOriginal,loadOriginalRanges} from './originals.ts';
import {parseOriginalHistoryQuery} from './types.ts';
import type {Book,OriginalHistoryQuery,Range,Store} from './types.ts';

/** Search only permitted independent ranges. Original storage stays chunked;
 * only the selected page of exact prose joins the task's range lease. */
export async function searchPermittedOriginal(store:Store,book:Book,input:OriginalHistoryQuery,extra:Range[]=[]){
  const request=parseOriginalHistoryQuery(input),order=request.order??'source-asc';
  if(request.range&&request.range.end>bookLength(book))throw Error('原文查询范围超出作品');
  const ranges=readableRanges(book,extra).map(r=>({start:Math.max(r.start,request.range?.start??r.start),end:Math.min(r.end,request.range?.end??r.end)})).filter(r=>r.end>r.start);
  const binding=JSON.stringify([book.id,book.version,request.query,order,request.range??null,ranges]);
  let offset=0;if(request.cursor){const cursor=JSON.parse(request.cursor);if(cursor.binding!==binding||!Number.isSafeInteger(cursor.offset)||cursor.offset<0)throw Error('原文续页条件或许可已变化');offset=cursor.offset;}
  const terms=request.query.split(/[\s，。？！、,:;]+/u).filter(t=>t.length>=2).slice(0,6);
  const hits:{start:number;end:number;score:number}[]=[],seen=new Set<string>();
  const compare=(a:typeof hits[number],b:typeof hits[number])=>order==='source-desc'?b.start-a.start||b.score-a.score:order==='relevance'?b.score-a.score||a.start-b.start:a.start-b.start||b.score-a.score;
  for(const range of ranges)for(let start=range.start;start<range.end;start+=65536){
    const bodyEnd=Math.min(range.end,start+65536),readStart=Math.max(range.start,start-180),end=Math.min(range.end,bodyEnd+Math.max(1024,...terms.map(t=>t.length+220))),scoped=await rangeOriginal(store,book,[{start:readStart,end}]),text=bookTextSlice(scoped,readStart,end);
    for(const term of terms){let position=text.indexOf(term);while(position>=0){const absolute=readStart+position;
      if(absolute>=start&&absolute<bodyEnd){const left=Math.max(range.start,absolute-180),right=Math.min(range.end,absolute+term.length+220),key=left+':'+right;
        if(!seen.has(key)){seen.add(key);const excerpt=bookTextSlice(scoped,left,right);hits.push({start:left,end:right,score:terms.filter(t=>excerpt.includes(t)).length});}}
      position=text.indexOf(term,position+term.length);
    }}
  }
  hits.sort(compare);const buckets=new Map<number,number[]>(),unique=hits.filter(hit=>{const key=Math.floor(hit.start/120);if([key-1,key,key+1].some(k=>(buckets.get(k)??[]).some(start=>Math.abs(start-hit.start)<120)))return false;buckets.set(key,[...(buckets.get(key)??[]),hit.start]);return true;});
  const total=unique.length;if(offset>total)throw Error('原文续页超出结果');
  const selected=unique.slice(offset,offset+5);await loadOriginalRanges(store,book,selected);
  const items=selected.map(span=>({text:bookTextSlice(book,span.start,span.end),evidence:evidence(book,span)}));
  const next=offset+items.length;
  return{items,total,order,range:request.range,permittedRanges:ranges,...(next<total?{nextCursor:JSON.stringify({binding,offset:next})}:{}),notice:'本次许可范围内的原文定位，坐标可继续展开；未命中不证明事件不存在。'};
}
