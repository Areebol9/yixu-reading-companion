export type ReplyRange = {start:number;end:number};

/** A contiguous run of fully painted glyphs, clipped by both the chat viewport and overlays. */
export function visibleReplyRange(element:HTMLElement, scroller:HTMLElement, sourceText?:string):ReplyRange|undefined {
  const doc=element.ownerDocument,win=doc.defaultView;
  if(!win||doc.visibilityState!=='visible'||!element.getClientRects().length)return;
  const box=scroller.getBoundingClientRect();
  const top=Math.max(0,box.top+scroller.clientTop),bottom=Math.min(win.innerHeight,box.bottom-scroller.clientTop);
  const left=Math.max(0,box.left+scroller.clientLeft),right=Math.min(win.innerWidth,box.right-scroller.clientLeft);
  if(bottom<=top||right<=left)return;
  const nodes:Node[]=[];
  if(element.firstChild?.nodeType===3&&!element.firstChild.nextSibling)nodes.push(element.firstChild);
  else {
    const walker=doc.createTreeWalker(element,4); // NodeFilter.SHOW_TEXT, also safe across browser realms.
    for(let node=walker.nextNode();node;node=walker.nextNode())nodes.push(node);
  }
  const plain=sourceText===undefined||sourceText===element.textContent;
  let plainOffset=0;
  for(const node of nodes){
    const text=node.textContent??'',textOffset=plainOffset;plainOffset+=text.length;
    if(!text.trim())continue;
    let sourceOffset=textOffset;
    if(!plain){
      // MarkdownMessage supplies the parser's source positions. Restrict each
      // lookup to its own source span, so repeated link labels cannot match URLs.
      const source=node.parentElement?.closest<HTMLElement>('[data-reply-source-start][data-reply-source-end]');
      if(!source||!element.contains(source))continue;
      const start=Number(source.dataset.replySourceStart),end=Number(source.dataset.replySourceEnd);
      if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<=start||end>sourceText!.length)continue;
      sourceOffset=sourceText!.indexOf(text,start);
      // Entity/escape transformations without an exact source match stay
      // unacknowledged; rendered text must never invent an original-text range.
      if(sourceOffset<start||sourceOffset+text.length>end)continue;
    }
    const offsets:number[]=[];let offset=0;for(const glyph of text){offsets.push(offset);offset+=glyph.length;}offsets.push(offset);
    const range=doc.createRange(),rect=(i:number)=>{range.setStart(node,offsets[i]);range.setEnd(node,offsets[i+1]);return range.getBoundingClientRect();};
    const lowerBound=(test:(index:number)=>boolean)=>{let low=0,high=offsets.length-1;while(low<high){const middle=(low+high)>>>1;if(test(middle))high=middle;else low=middle+1;}return low;};
    const begin=lowerBound(i=>rect(i).top>=top),end=lowerBound(i=>rect(i).bottom>bottom);
    let start:number|undefined,last:number|undefined;
    for(let i=begin;i<end;i++){
      if(!text.slice(offsets[i],offsets[i+1]).trim())continue;
      const bounds=rect(i),hit=bounds.width>0&&bounds.height>0&&bounds.top>=top&&bounds.bottom<=bottom&&bounds.left>=left&&bounds.right<=right
        ?doc.elementFromPoint((bounds.left+bounds.right)/2,(bounds.top+bounds.bottom)/2):null;
      if(hit&&(hit===element||element.contains(hit))){start??=offsets[i];last=offsets[i+1];}
      else if(start!==undefined)break;
    }
    // One painted text run is sufficient for presentation/timing. Do not join
    // separate nodes across source syntax or an unpainted part of the message.
    if(start!==undefined&&last!==undefined)return{start:sourceOffset+start,end:sourceOffset+last};
  }
}

/** Keep only one acknowledgement in flight. Failed writes retry from a fresh visible measurement. */
export function observeReplyVisibility(options:{measure:()=>ReplyRange|undefined;record:(range:ReplyRange)=>boolean|Promise<boolean>;schedule:(callback:()=>void)=>unknown;cancel:(handle:unknown)=>void}){
  let stopped=false,recorded=false,pending=false,retry:unknown;
  const check=()=>{
    if(stopped||recorded||pending)return;
    if(retry!==undefined){options.cancel(retry);retry=undefined;}
    const range=options.measure();if(!range)return;
    pending=true;
    void Promise.resolve().then(()=>options.record(range)).then(accepted=>{recorded=accepted===true;},()=>{}).finally(()=>{
      pending=false;if(!stopped&&!recorded)retry=options.schedule(()=>{retry=undefined;check();});
    });
  };
  return{check,stop(){stopped=true;if(retry!==undefined)options.cancel(retry);}};
}
