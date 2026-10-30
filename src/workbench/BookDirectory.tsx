import { t } from './i18n.ts';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { BookView } from '../core/application-contract.ts';
import './book-directory.css';

export function BookDirectory({ book, position, search, onSelect, onClearSearch }: {
  book: BookView; position: number; search: string; onSelect: (start: number) => void; onClearSearch?: () => void;
}) {
  const entries = book.directory?.entries ?? book.chapters;
  const tree = useMemo(() => {
    const indexes = new Map<number, number>(), parents: (number | undefined)[] = [], levels: number[] = [], branches = new Set<number>();
    const stack: number[] = [];
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index], level = Math.max(0, entry.level ?? 0);
      while (stack.length && (entries[stack.at(-1)!].level ?? 0) >= level) stack.pop();
      const parent = entry.parentIndex === undefined ? level > 0 ? stack.at(-1) : undefined : indexes.get(entry.parentIndex);
      parents.push(parent); levels.push(parent === undefined ? 0 : levels[parent] + 1);
      if (parent !== undefined) branches.add(parent);
      indexes.set(entry.index, index); stack.push(index);
    }
    return { parents, levels, branches };
  }, [entries]);
  let current = -1;
  for (let index = 0; index < entries.length; index++) if (entries[index].start <= position && position < entries[index].end) current = index;
  if (current < 0 && entries.length && position >= entries.at(-1)!.end) current = entries.length - 1;
  const structureKey = `${book.id}:${entries.map((entry, index) => `${entry.start}/${tree.parents[index] ?? ''}`).join(',')}`;
  const volumes=entries.flatMap((entry,index)=>entry.kind==='volume'||entry.kind==='part'?[index]:[]);
  if(!volumes.length)for(const index of tree.branches)if(tree.parents[index]===undefined)volumes.push(index);
  let currentVolume=-1;
  for(let at:number|undefined=current<0?undefined:current;at!==undefined;at=tree.parents[at])if(volumes.includes(at)){currentVolume=at;break;}
  if(currentVolume<0)currentVolume=volumes.filter(index=>index<=current).at(-1)??-1;
  const [browsedVolume,setBrowsedVolume]=useState({structure:structureKey,index:currentVolume});
  const selectedVolume=browsedVolume.structure===structureKey?browsedVolume.index:currentVolume;
  const container=useRef<HTMLElement>(null),volumeBar=useRef<HTMLDivElement>(null),pendingTarget=useRef<number|undefined>(current<0?undefined:current);
  const [expanded, setExpanded] = useState<Set<number>>(() => {
    const open = new Set<number>();
    for (let at: number | undefined = current < 0 ? undefined : current; at !== undefined; at = tree.parents[at]) open.add(at);
    return open;
  });
  const [expandedStructure, setExpandedStructure] = useState(structureKey);
  useEffect(() => {
    pendingTarget.current=current<0?undefined:current;
    setBrowsedVolume({structure:structureKey,index:currentVolume});
    setExpanded(previous => {
      const next = new Set(expandedStructure === structureKey ? previous : []);
      for (let at: number | undefined = current < 0 ? undefined : current; at !== undefined; at = tree.parents[at]) next.add(at);
      return next;
    });
    setExpandedStructure(structureKey);
  }, [book.id, structureKey, current, currentVolume]);
  const query = search.trim().normalize('NFKC').toLocaleLowerCase();
  const [searchCollapsed,setSearchCollapsed]=useState<ReadonlySet<number>>(new Set());
  useEffect(()=>setSearchCollapsed(new Set()),[query,structureKey]);
  function reveal(index:number){
    const element=container.current,row=element?.querySelector<HTMLElement>(`[data-directory-index="${index}"]`);
    if(!element||!row||!element.getClientRects().length)return false;
    const bounds=element.getBoundingClientRect(),item=row.getBoundingClientRect(),top=bounds.top+(volumeBar.current?.offsetHeight??0);
    if(item.top<top)element.scrollTop-=top-item.top;
    else if(item.bottom>bounds.bottom)element.scrollTop+=item.bottom-bounds.bottom;
    return true;
  }
  useLayoutEffect(()=>{
    if(!query&&pendingTarget.current!==undefined&&reveal(pendingTarget.current))pendingTarget.current=undefined;
  },[structureKey,current,expanded,query,browsedVolume]);
  useLayoutEffect(()=>{
    const element=container.current;if(!element)return;
    let shown=element.getClientRects().length>0&&element.clientHeight>0;
    const resize=new ResizeObserver(()=>{
      const nextShown=element.getClientRects().length>0&&element.clientHeight>0;
      if(nextShown&&!shown&&!query&&current>=0){
        pendingTarget.current=current;
        setExpanded(previous=>{const next=new Set(previous);for(let at:number|undefined=current;at!==undefined;at=tree.parents[at])next.add(at);return next;});
      }
      shown=nextShown;
      if(nextShown&&!query&&pendingTarget.current!==undefined&&reveal(pendingTarget.current))pendingTarget.current=undefined;
    });
    resize.observe(element);return()=>resize.disconnect();
  },[structureKey,current,query]);
  const matched = new Set<number>(), visible = new Set<number>();
  if (query) {
    for (let index = 0; index < entries.length; index++) if (entries[index].title.normalize('NFKC').toLocaleLowerCase().includes(query)) {
      matched.add(index);
      for (let at: number | undefined = index; at !== undefined && !visible.has(at); at = tree.parents[at]) visible.add(at);
    }
  } else {
    for (let index = 0; index < entries.length; index++) {
      const parent = tree.parents[index];
      if (parent === undefined || visible.has(parent) && expanded.has(parent)) visible.add(index);
    }
  }
  if(query)for(const index of [...visible]){
    for(let parent=tree.parents[index];parent!==undefined;parent=tree.parents[parent])if(searchCollapsed.has(parent)){visible.delete(index);break;}
  }
  function toggle(index: number) {
    if(query){setSearchCollapsed(previous=>{const next=new Set(previous);if(next.has(index))next.delete(index);else next.add(index);return next;});return;}
    setExpanded(previous => { const next = new Set(previous); if (next.has(index)) next.delete(index); else next.add(index); return next; });
  }
  function browseVolume(index:number){
    if(!volumes.includes(index))return;
    onClearSearch?.();pendingTarget.current=index;setBrowsedVolume({structure:structureKey,index});
    setExpanded(previous=>{const next=new Set(previous);for(let at:number|undefined=index;at!==undefined;at=tree.parents[at])next.add(at);return next;});
  }
  return <nav className="chapter-list book-directory" aria-label={t("书籍目录")} ref={container}>
    {!!volumes.length&&<div className="book-directory-volume-bar" ref={volumeBar}><span>{t("卷")}</span><select aria-label={t("选择目录卷")} value={selectedVolume} onChange={event=>browseVolume(Number(event.target.value))}>{selectedVolume<0&&<option value={-1}>{t("选择卷")}</option>}{volumes.map(index=><option key={entries[index].index} value={index}>{entries[index].title}</option>)}</select></div>}
    {entries.map((entry, index) => {
      if(!visible.has(index))return null;
      const branch=tree.branches.has(index),opened=query?!searchCollapsed.has(index):expanded.has(index);
      return <div className={`book-directory-row${branch?' book-directory-group':''}`} data-directory-index={index} style={{paddingLeft:Math.min(tree.levels[index],8)*12}} key={`${entry.start}:${entry.index}`}>
        {!branch&&<span className="book-directory-spacer" aria-hidden="true"/>}
        <button type="button" className={`chapter-item${branch?' book-directory-group-button':''}${index===current?' selected':''}${matched.has(index)?' book-directory-match':''}`} aria-current={index===current?'location':undefined} aria-label={branch?`${opened?t("收起"):t("展开")}${entry.title}`:undefined} aria-expanded={branch?opened:undefined} title={entry.title} onClick={()=>branch?toggle(index):onSelect(entry.start)}>
          {branch&&<span className="book-directory-chevron" aria-hidden="true">{opened?'▾':'▸'}</span>}<span className="book-directory-title">{entry.title}</span>{index===current&&<span className="book-directory-current" aria-hidden="true">·</span>}
        </button>
      </div>;
    })}
    {!visible.size && <p className="side-empty">{query ? t("没有找到这个标题，试试其他关键词。") : t("这本书的目录还未整理，可在书籍信息中识别目录。")}</p>}
  </nav>;
}
