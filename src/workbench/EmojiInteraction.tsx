import { t } from './i18n.ts';
import {useState} from 'react';
import type {MessageEmojiReaction} from '../core/types.ts';
import {isSingleEmoji,localReaderActorId} from '../core/message-reactions.ts';
import './emoji-interactions.css';

export {isEmojiOnlyText} from '../core/message-reactions.ts';

const commonEmoji=['👍','❤️','😊','😂','🥹','🤔','😮','😢','👏','🎉','🙌','✨','👀','💡','🫂','🔥','😅','😭','😌','🙏','💔','💯','🤝','🤩'];

export function EmojiPicker({onSelect,onClose}:{onSelect:(emoji:string)=>void;onClose?:()=>void}){
  const [custom,setCustom]=useState('');
  const valid=isSingleEmoji(custom);
  const select=(emoji:string)=>{onSelect(emoji);onClose?.();};
  return <div className="emoji-picker" role="group" aria-label={t("选择表情")} onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();onClose?.();}}}>
    <div className="emoji-picker-header"><span>{t("选择表情")}</span>{onClose&&<button type="button" className="text-action" aria-label={t("关闭表情选择")} onClick={onClose}>{t("关闭")}</button>}</div>
    <div className="emoji-picker-grid">{commonEmoji.map(emoji=><button type="button" key={emoji} aria-label={t("选择 {0}",emoji)} onClick={()=>select(emoji)}>{emoji}</button>)}</div>
    <form className="emoji-picker-custom" onSubmit={event=>{event.preventDefault();if(valid)select(custom);}}><input aria-label={t("其他表情")} placeholder={t("输入或粘贴一个表情")} value={custom} onChange={event=>setCustom(event.target.value)} maxLength={64}/><button type="submit" className="text-action" disabled={!valid}>{t("使用")}</button></form>
  </div>;
}

export function MessageEmojiReactions({reactions=[],onToggle,disabled=false,partnerName=t("伙伴"),actorNames={}}:{
  reactions?:readonly Readonly<MessageEmojiReaction>[];onToggle:(emoji:string,active:boolean)=>void;disabled?:boolean;partnerName?:string;actorNames?:Readonly<Record<string,string>>;
}){
  const [choosing,setChoosing]=useState(false);
  const groups=new Map<string,Readonly<MessageEmojiReaction>[]>();
  for(const reaction of reactions){const group=groups.get(reaction.emoji)??[];group.push(reaction);groups.set(reaction.emoji,group);}
  const name=(reaction:Readonly<MessageEmojiReaction>)=>reaction.actor==='user'?t("我"):actorNames[reaction.actorId]??partnerName;
  const mine=(group:readonly Readonly<MessageEmojiReaction>[])=>group.some(reaction=>reaction.actor==='user'&&reaction.actorId===localReaderActorId);
  return <div className="message-emoji-interaction">
    <div className="message-emoji-reactions" aria-label={t("表情回应")}>
      {[...groups].map(([emoji,group])=>{const selected=mine(group),authors=group.map(name).join('、');return <button type="button" key={emoji} className={`message-emoji-reaction${selected?' selected':''}`} aria-pressed={selected} title={`${authors} · ${selected?t("点击撤销我的回应"):t("点击添加我的回应")}`} aria-label={`${emoji}，${authors}，${selected?t("撤销我的回应"):t("添加我的回应")}`} disabled={disabled} onClick={()=>onToggle(emoji,!selected)}><span className="reaction-emoji">{emoji}</span><span>{group.length}</span></button>;})}
      <button type="button" className="text-action emoji-add" aria-expanded={choosing} disabled={disabled} onClick={()=>setChoosing(value=>!value)}>{t("+ 表情")}</button>
    </div>
    {choosing&&!disabled&&<EmojiPicker onClose={()=>setChoosing(false)} onSelect={emoji=>onToggle(emoji,true)}/>}
  </div>;
}
