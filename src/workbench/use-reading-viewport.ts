import {useEffect} from 'react';
import type {RefObject} from 'react';

type Viewport={visible:boolean;range?:{start:number;end:number}};
/** Only the latest painted viewport is relevant while its previous observation
 * is being acknowledged. This queue owns UI observations, never model tasks. */
export function useReadingViewport({scope,enabled,element,measure,deliver,onError}:{
  scope:string;enabled:boolean;element:RefObject<HTMLElement|null>;
  measure:()=>Viewport;deliver:(view:Viewport)=>Promise<unknown>;onError:(error:unknown)=>void;
}){
  useEffect(()=>{
    if(!enabled)return;
    let closed=false,frame=0,sending=false,pending:Viewport|undefined,lastQueued='';
    const drain=async()=>{
      if(sending)return;sending=true;
      try{while(pending&&!closed){const view=pending;pending=undefined;try{await deliver(view);}catch(error){lastQueued='';if(!closed)onError(error);}}}
      finally{sending=false;}
    };
    const capture=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{
      if(closed)return;const view=measure(),key=JSON.stringify(view);
      if(key===lastQueued)return;lastQueued=key;pending=view;void drain();
    });};
    const paper=element.current,resize=new ResizeObserver(capture);
    if(paper)resize.observe(paper);
    paper?.addEventListener('scroll',capture);window.addEventListener('resize',capture);window.addEventListener('scroll',capture);document.addEventListener('visibilitychange',capture);capture();
    return()=>{closed=true;pending=undefined;cancelAnimationFrame(frame);resize.disconnect();paper?.removeEventListener('scroll',capture);window.removeEventListener('resize',capture);window.removeEventListener('scroll',capture);document.removeEventListener('visibilitychange',capture);};
    // scope captures page/source identity and rendered visibility. A new source
    // retires queued old frames; the host rejects an already sent stale frame.
  },[scope,enabled,element]);
}
