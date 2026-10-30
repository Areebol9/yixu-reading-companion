import {useLayoutEffect,useRef,useState} from 'react';
import {createChatViewport} from './chat-viewport.ts';

type History={available:boolean;loading:boolean;error:string;retained:boolean;load:()=>unknown;retain:()=>void;resume:()=>void};
export function useChatViewport(key:string,ids:string[],visible:boolean,history?:History){
  const scroller=useRef<HTMLDivElement>(null),controller=useRef(createChatViewport()),[pending,setPending]=useState(0);
  const anchors=useRef(new Map<string,{id:string;offset:number}>()),lastKey=useRef('');
  const latest=useRef({key,ids,visible,history});latest.current={key,ids,visible,history};
  const realign=useRef<(()=>void)|undefined>(undefined),captureAnchor=useRef<(()=>void)|undefined>(undefined),cancelIntent=useRef<(()=>void)|undefined>(undefined),programmaticTop=useRef<number|undefined>(undefined),idsKey=JSON.stringify(ids);
  useLayoutEffect(()=>{
    const element=scroller.current;if(!element)return;
    let frame:number|undefined,intent=0,intentUntil=0,dragging=false,touchY:number|undefined;
    cancelIntent.current=()=>{intent=0;intentUntil=0;dragging=false;};
    const shown=()=>latest.current.visible&&document.visibilityState==='visible';
    const atBottom=()=>element.scrollHeight-element.clientHeight-element.scrollTop<=48;
    const remember=()=>{const top=element.getBoundingClientRect().top;for(const row of element.querySelectorAll<HTMLElement>('[data-chat-id]')){const bounds=row.getBoundingClientRect();if(bounds.bottom>top){anchors.current.set(key,{id:row.dataset.chatId!,offset:bounds.top-top});break;}}};
    captureAnchor.current=remember;
    const align=()=>{
      frame=undefined;const current=latest.current,anchor=anchors.current.get(key);
      if(shown()&&lastKey.current===key&&!controller.current.following()&&anchor){const row=element.querySelector<HTMLElement>(`[data-chat-id="${CSS.escape(anchor.id)}"]`);if(row)controller.current.shift(row.getBoundingClientRect().top-element.getBoundingClientRect().top-anchor.offset);}
      setPending(controller.current.update(key,current.ids,element,shown()));lastKey.current=key;programmaticTop.current=element.scrollTop;
      if(shown()&&!controller.current.following())remember();
    };
    const schedule=()=>{if(frame===undefined)frame=requestAnimationFrame(align);};
    realign.current=schedule;
    const resume=()=>{if(latest.current.history?.retained){intent=0;intentUntil=0;latest.current.history.resume();programmaticTop.current=element.scrollTop;}};
    const input=(direction:number)=>{
      if(!shown())return;intent=direction;intentUntil=performance.now()+700;
      if(direction<0){controller.current.pause(element);remember();latest.current.history?.retain();}
      else if(atBottom())resume();
    };
    const requestEarlier=()=>{
      const history=latest.current.history;
      if(!shown()||!history?.available||history.loading||history.error)return;
      controller.current.pause(element);remember();void history.load();
    };
    let lastScrollTop=element.scrollTop;
    const onScroll=()=>{
      const top=element.scrollTop,delta=top-lastScrollTop;lastScrollTop=top;if(!shown())return;
      const programmed=programmaticTop.current!==undefined&&Math.abs(top-programmaticTop.current)<1;
      programmaticTop.current=undefined;
      const user=!programmed&&(dragging||performance.now()<intentUntil&&Math.sign(delta)===intent&&intent!==0);
      setPending(controller.current.scroll(element,user));
      if(!controller.current.following())remember();
      if(!user)return;
      if(delta<0){latest.current.history?.retain();if(top<=96)requestEarlier();}
      else if(delta>0&&atBottom())resume();
    };
    const onWheel=(event:WheelEvent)=>{if(!event.deltaY)return;input(Math.sign(event.deltaY));if(event.deltaY<0&&element.scrollTop<=96)requestEarlier();};
    const onKey=(event:KeyboardEvent)=>{
      if((event.target as Element).closest('input,textarea,select,[contenteditable="true"],button,a'))return;
      if(['ArrowUp','PageUp','Home'].includes(event.key)||event.key===' '&&event.shiftKey)input(-1);
      else if(['ArrowDown','PageDown','End',' '].includes(event.key))input(1);
    };
    const onPointerDown=(event:PointerEvent)=>{const bounds=element.getBoundingClientRect();dragging=event.pointerType==='mouse'&&event.clientX>=bounds.left+element.clientLeft+element.clientWidth;};
    const onPointerUp=()=>{dragging=false;};
    const onTouchStart=(event:TouchEvent)=>{touchY=event.touches[0]?.clientY;};
    const onTouchMove=(event:TouchEvent)=>{const y=event.touches[0]?.clientY;if(y!==undefined&&touchY!==undefined&&Math.abs(y-touchY)>1)input(Math.sign(touchY-y));touchY=y;};
    const resize=new ResizeObserver(schedule),observed=new Set<Element>();resize.observe(element);
    const syncChildren=()=>{for(const child of observed)if(child.parentElement!==element){resize.unobserve(child);observed.delete(child);}for(const child of element.children)if(!observed.has(child)){observed.add(child);resize.observe(child);}schedule();};
    const mutations=new MutationObserver(syncChildren);mutations.observe(element,{childList:true});syncChildren();
    element.addEventListener('scroll',onScroll);element.addEventListener('wheel',onWheel,{passive:true});element.addEventListener('keydown',onKey);element.addEventListener('pointerdown',onPointerDown);document.addEventListener('pointerup',onPointerUp);element.addEventListener('touchstart',onTouchStart,{passive:true});element.addEventListener('touchmove',onTouchMove,{passive:true});document.addEventListener('visibilitychange',schedule);if(frame!==undefined)cancelAnimationFrame(frame);align();
    return()=>{if(frame!==undefined)cancelAnimationFrame(frame);realign.current=undefined;captureAnchor.current=undefined;cancelIntent.current=undefined;resize.disconnect();mutations.disconnect();element.removeEventListener('scroll',onScroll);element.removeEventListener('wheel',onWheel);element.removeEventListener('keydown',onKey);element.removeEventListener('pointerdown',onPointerDown);document.removeEventListener('pointerup',onPointerUp);element.removeEventListener('touchstart',onTouchStart);element.removeEventListener('touchmove',onTouchMove);document.removeEventListener('visibilitychange',schedule);};
  },[key]);
  useLayoutEffect(()=>{realign.current?.();},[key,idsKey,visible]);
  return{scroller,pending,pause:()=>{cancelIntent.current?.();if(scroller.current){controller.current.pause(scroller.current);captureAnchor.current?.();}},latest:()=>{cancelIntent.current?.();if(scroller.current){setPending(controller.current.latest(scroller.current));programmaticTop.current=scroller.current.scrollTop;}}};
}
