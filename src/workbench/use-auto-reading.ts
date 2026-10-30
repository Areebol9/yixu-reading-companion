import {useEffect,useLayoutEffect,useRef} from 'react';
import type {RefObject} from 'react';
import type {WorkbenchClient,WorkbenchSnapshot,WorkbenchSourceReceipt} from './contract.ts';
import {visibleReadingRange} from './visible-reading.ts';
import {readingParagraphs} from './reading-layout.ts';
import {localReadingDelay,runAutoReading} from './auto-reading-driver.ts';

/** A timer and ordinary page actions. Application owns permission, tasks and budget. */
export function useAutoReading(client:WorkbenchClient,snapshot:WorkbenchSnapshot,paper:RefObject<HTMLDivElement|null>,content:RefObject<HTMLDivElement|null>,startedHere:boolean,capture:()=>Promise<WorkbenchSourceReceipt>){
  const current=useRef({snapshot,capture});
  const wake=useRef<(()=>void)|undefined>(undefined);
  useLayoutEffect(()=>{const old=current.current.snapshot;current.current={snapshot,capture};
    if(old.page?.navigationRevision!==snapshot.page?.navigationRevision||old.page?.bookId!==snapshot.page?.bookId||old.page?.version!==snapshot.page?.version||old.pageLoading!==snapshot.pageLoading||old.autoReading?.settings?.charactersPerMinute!==snapshot.autoReading?.settings?.charactersPerMinute)wake.current?.();
  });
  useEffect(()=>{
    if(!startedHere||snapshot.autoReading?.phase!=='reading')return;
    const controller=new AbortController();
    const changed=()=>wake.current?.(),scroller=paper.current,resize=new ResizeObserver(changed);
    if(scroller){scroller.addEventListener('scroll',changed);resize.observe(scroller);}if(content.current)resize.observe(content.current);
    window.addEventListener('resize',changed);
    window.addEventListener('focus',changed);
    window.addEventListener('pageshow',changed);
    document.addEventListener('visibilitychange',changed);
    document.addEventListener('resume',changed);
    const wait=async(ms:number,signal:AbortSignal)=>{
      const interrupted=new AbortController(),notify=()=>interrupted.abort();wake.current=notify;
      try{await(client.waitReadingDelay?.bind(client)??localReadingDelay)(ms,AbortSignal.any([signal,interrupted.signal]));}
      catch(error){if(signal.aborted||!interrupted.signal.aborted)throw error;}
      finally{if(wake.current===notify)wake.current=undefined;}
    };
    void runAutoReading({
      viewport:()=>{const s=current.current.snapshot,page=s.page,settings=s.autoReading?.settings;
        if(s.autoReading?.phase!=='reading'){controller.abort();return;}
        if(!page||s.pageLoading||!settings)return;
        const range=visibleReadingRange(paper.current,content.current,page);if(!range)return;
        return{page,range,charactersPerMinute:settings.charactersPerMinute,bodyEnd:readingParagraphs(page.text,page.start,page.chapterTitle).filter(p=>!p.heading).at(-1)?.end??page.end};},
      capture:()=>current.current.capture(),
      scroll:()=>paper.current?.scrollBy({top:Math.max(24,paper.current.clientHeight*.65),behavior:'instant'}),
      advance:()=>client.advanceAutoReading(),
      wait,
      now:()=>performance.now(),
    },controller.signal).catch(error=>{if(!controller.signal.aborted)void client.stopAutoReading('自动伴读已停止：'+(error instanceof Error?error.message:String(error))).catch(()=>{});});
    return()=>{controller.abort();scroller?.removeEventListener('scroll',changed);resize.disconnect();window.removeEventListener('resize',changed);window.removeEventListener('focus',changed);window.removeEventListener('pageshow',changed);document.removeEventListener('visibilitychange',changed);document.removeEventListener('resume',changed);};
  },[client,startedHere,snapshot.autoReading?.phase,snapshot.autoReading?.startedAt]);
}
