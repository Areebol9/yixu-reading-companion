import {stampsEqual} from './memory-identity.ts';
import {dependencyNodeSnapshot} from './dependency-nodes.ts';
import type {ReadingDraftMaterial,State} from './types.ts';

function withoutReaderInteraction(value:unknown):unknown{
  if(!Array.isArray(value)||value[11]!=='paragraph'||value[15]!=='interaction')return value;
  if(value[16]===null&&value[17]===null)return value.slice(0,15);
  return [...value.slice(0,18),null];
}
/** New stamps exclude local likes. Existing v3 tasks may explain a changed chat
 * node only using the hash-verified original node retained by preparation. Cold
 * tasks lacking that original stay blocked; displayed text is never a substitute
 * for session, anchor, formation, evidence, or relationship provenance. */
export function dependencyStampsEqual(state:State,material:ReadingDraftMaterial,actual:string,expected:string):boolean {
  if(stampsEqual(actual,expected))return true;
  let current:any,original:any;try{current=JSON.parse(actual);original=JSON.parse(expected);}catch{return false;}
  if(current.dependencyStampVersion!==3||original.dependencyStampVersion!==3||!Array.isArray(current.chats)||!Array.isArray(original.chats)||current.chats.length!==original.chats.length)return false;
  let explained=false;
  for(let index=0;index<current.chats.length;index++){
    const now=current.chats[index],before=original.chats[index];if(stampsEqual(JSON.stringify(now),JSON.stringify(before)))continue;
    if(now?.kind!=='chat'||before?.kind!=='chat'||now.id!==before.id||!material.chatIds.includes(now.id))return false;
    const chat=state.chats.find(chat=>chat.id===now.id);if(!chat)return false;
    const saved=dependencyNodeSnapshot(chat,'chat',now.id,before.hash),present=dependencyNodeSnapshot(chat,'chat',now.id,now.hash);
    if(saved===undefined||present===undefined||!stampsEqual(JSON.stringify(withoutReaderInteraction(saved)),JSON.stringify(withoutReaderInteraction(present))))return false;
    current.chats[index]=before;explained=true;
  }
  return explained&&stampsEqual(JSON.stringify(current),expected);
}
