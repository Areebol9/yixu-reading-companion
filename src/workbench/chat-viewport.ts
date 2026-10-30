type Viewport={scrollTop:number;scrollHeight:number;clientHeight:number};
type Position={top:number;following:boolean;ids:string[];pending:Set<string>};
export function createChatViewport(){
  const positions=new Map<string,Position>();let current:Position|undefined,key='';
  const align=(view:Viewport)=>{if(current)view.scrollTop=current.following?view.scrollHeight:current.top;};
  return{
    following(){return current?.following??true;},
    pause(view:Viewport){if(current){current.top=view.scrollTop;current.following=false;}},
    shift(delta:number){if(current&&!current.following)current.top=Math.max(0,current.top+delta);},
    update(nextKey:string,ids:string[],view:Viewport,visible:boolean){
      if(key!==nextKey||!current){key=nextKey;current=positions.get(key);if(!current){current={top:0,following:true,ids:[...ids],pending:new Set()};positions.set(key,current);}}
      const prior=new Set(current.ids),shown=new Set(ids);let previousEnd=-1;for(let index=ids.length-1;index>=0;index--)if(prior.has(ids[index])){previousEnd=index;break;}
      // Prepending history adds no unread messages; a disjoint target window is navigation.
      if(previousEnd>=0||!prior.size)for(let index=previousEnd+1;index<ids.length;index++)if(!prior.has(ids[index]))current.pending.add(ids[index]);
      for(const id of current.pending)if(!shown.has(id))current.pending.delete(id);current.ids=[...ids];
      if(visible){align(view);if(current.following)current.pending.clear();}
      return current.pending.size;
    },
    scroll(view:Viewport,user=true){if(current){current.top=view.scrollTop;if(user)current.following=view.scrollHeight-view.clientHeight-view.scrollTop<=48;if(current.following)current.pending.clear();}return current?.pending.size??0;},
    latest(view:Viewport){if(current){current.following=true;current.pending.clear();align(view);}return 0;},
  };
}
