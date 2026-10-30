import { t } from './i18n.ts';
import {memo} from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {Root,Element} from 'hast';
import './markdown-message.css';

// Keep rendered text tied to the original message for visibility receipts.
// Markdown formatting and link destinations are never mistaken for read text.
function sourcePositions(){
  return(tree:Root,file:{value:unknown})=>{
    const source=String(file.value);
    const walk=(parent:Root|Element)=>{
      parent.children=parent.children.map(child=>{
        if(child.type==='element'){walk(child);return child;}
        if(child.type!=='text'||!child.value.trim())return child;
        let start=child.position?.start.offset,end=child.position?.end.offset,text=child;
        if(start===undefined&&parent.type==='element'&&parent.tagName==='code'){
          const from=parent.position?.start.offset,to=parent.position?.end.offset;
          if(from!==undefined&&to!==undefined){
            const original=source.slice(from,to),body=child.value.replace(/\n$/,'');
            const afterFence=/^ {0,3}(?:`{3,}|~{3,})/.test(original)?original.indexOf('\n')+1:0;
            const exact=original.indexOf(child.value,afterFence),index=exact>=0?exact:original.indexOf(body,afterFence);
            if(index>=0&&body){if(exact<0)text={...child,value:body};start=from+index;end=start+text.value.length;}
          }
        }
        if(start===undefined||end===undefined)return child;
        return{type:'element',tagName:'span',properties:{'data-reply-source-start':start,'data-reply-source-end':end},children:[text]} satisfies Element;
      }) as typeof parent.children;
    };
    walk(tree);
  };
}
const remarkPlugins=[remarkGfm],rehypePlugins=[sourcePositions];
export const MarkdownMessage=memo(function MarkdownMessage({text,className=''}:{text:string;className?:string}){
  return <div className={`markdown-message ${className}`}><Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} skipHtml components={{
    a:({children,href})=><a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    img:({alt})=><span>{alt||t("图片")}</span>,
  }}>{text}</Markdown></div>;
});
