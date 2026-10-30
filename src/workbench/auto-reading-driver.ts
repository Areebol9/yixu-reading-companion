import type {WorkbenchPage,WorkbenchSourceReceipt} from './contract.ts';

export type ReadingViewport={page:WorkbenchPage;range:{start:number;end:number};bodyEnd:number;charactersPerMinute:number};
export function localReadingDelay(ms:number,signal:AbortSignal):Promise<void>{
  return new Promise((resolve,reject)=>{
    signal.throwIfAborted();
    const cancel=()=>{clearTimeout(timer);reject(signal.reason);};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve();},Math.ceil(ms));
    signal.addEventListener('abort',cancel,{once:true});
  });
}

/** Mechanical reader. Saving observations and model work remain application responsibilities. */
export async function runAutoReading(io:{
  viewport:()=>ReadingViewport|undefined;
  capture:()=>Promise<WorkbenchSourceReceipt>;
  scroll:()=>void;
  advance:()=>Promise<void>;
  wait:(ms:number,signal:AbortSignal)=>Promise<void>;
  now:()=>number;
},signal:AbortSignal){
  let previousPage='',previousEnd:number|undefined,due=0,advancedPage:string|undefined,visibleAt=0,chars=0,speed=0;
  while(!signal.aborted){
    const v=io.viewport();
    if(!v){await io.wait(50,signal);continue;}
    const {page,range}=v,key=JSON.stringify([page.bookId,page.version,page.navigationRevision,page.start]);
    // A command receipt can precede the renderer's next committed page.
    if(key===advancedPage){await io.wait(50,signal);continue;}
    if(key!==previousPage||range.end!==previousEnd){
      const observedAt=io.now(),receipt=await io.capture();signal.throwIfAborted();
      if(receipt.status==='obsolete'){
        if(receipt.reason==='source-replaced')throw Error('当前阅读窗口已由另一个窗口接替');
        await io.wait(50,signal);continue;
      }
      const start=key===previousPage?Math.max(range.start,previousEnd??range.start):range.start;
      chars=Array.from(page.text.slice(start-page.start,range.end-page.start)).filter(char=>/\S/u.test(char)).length;
      previousPage=key;previousEnd=range.end;visibleAt=observedAt;speed=v.charactersPerMinute;due=visibleAt+chars*60000/speed;
    }
    if(speed!==v.charactersPerMinute){speed=v.charactersPerMinute;due=visibleAt+chars*60000/speed;}
    const remaining=due-io.now();if(remaining>0){await io.wait(remaining,signal);continue;}
    // Never operate an old DOM after an asynchronous capture or wait.
    const latest=io.viewport();
    if(!latest||latest.page.navigationRevision!==page.navigationRevision||latest.page.bookId!==page.bookId||latest.page.version!==page.version||latest.page.start!==page.start||latest.range.end!==range.end)continue;
    if(range.end>=v.bodyEnd){advancedPage=key;await io.advance();}
    else io.scroll();
    await io.wait(0,signal);
  }
}
