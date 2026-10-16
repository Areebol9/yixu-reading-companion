import React, {useEffect,useRef,useState} from 'react';

type Request = { id: string; title: string; message?: string; value?: string; resolve: (value: string | boolean | null) => void };

function Dialog({request,finish}:{request:Request;finish:(value:string|boolean|null)=>void}) {
  const ref=useRef<HTMLDialogElement>(null),input=useRef<HTMLInputElement>(null);
  const [value,setValue]=useState(request.value ?? '');
  useEffect(()=>{
    const previous=document.activeElement,dialog=ref.current!;
    dialog.showModal();if(input.current){input.current.focus();input.current.select();}
    return ()=>{dialog.close();if(previous instanceof HTMLElement)previous.focus();};
  },[]);
  return <dialog ref={ref} className="app-dialog" aria-labelledby="app-dialog-title" onCancel={e=>{e.preventDefault();finish(null);}}>
    <form onSubmit={e=>{e.preventDefault();finish(request.value === undefined ? true : value);}}>
      <h2 id="app-dialog-title">{request.title}</h2>
      {request.message && <p>{request.message}</p>}
      {request.value !== undefined && <label>新标题<input ref={input} value={value} onChange={e=>setValue(e.target.value)} maxLength={80}/></label>}
      <div className="button-row"><button type="button" className="secondary" onClick={()=>finish(null)}>取消</button><button className="primary" disabled={request.value !== undefined && !value.trim()}>{request.value === undefined ? '确认继续' : '保存标题'}</button></div>
    </form>
  </dialog>;
}

/** App-owned, non-blocking confirmations work in native WebView and browser hosts. */
export function useAppDialog() {
  const [request,setRequest]=useState<Request>();
  const active=useRef<Request|undefined>(undefined);
  const open=(data:Omit<Request,'resolve'|'id'>)=>new Promise<string|boolean|null>(resolve=>{
    if(active.current){resolve(null);return;}
    const next={...data,resolve,id:crypto.randomUUID()};active.current=next;setRequest(next);
  });
  const finish=(value:string|boolean|null)=>{const pending=active.current;active.current=undefined;setRequest(undefined);pending?.resolve(value);};
  useEffect(()=>()=>{active.current?.resolve(null);active.current=undefined;},[]);
  return {
    confirm: async (message:string,title='确认操作') => (await open({title,message})) === true,
    prompt: async (title:string,value:string) => {const result=await open({title,value});return typeof result === 'string' ? result : null;},
    dialog: request ? <Dialog key={request.id} request={request} finish={finish}/> : null
  };
}
