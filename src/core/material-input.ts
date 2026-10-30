export const MATERIAL_CONTINUATION='继续原任务；原材料、工具结果和已核验回执保持。';
type MaterialInputPart={role:string;content:string};

/** Apply the same role boundary even when an envelope is nested in other JSON. */
export function materialEnvelopeParts(value:unknown):string[]|undefined{
  if(!value||typeof value!=='object'||Array.isArray(value)||(value as {format?:unknown}).format!=='yixu-task-input-v1')return;
  const parts=(value as {parts?:unknown}).parts;
  if(!Array.isArray(parts)||parts.some(part=>!part||typeof part!=='object'||typeof part.content!=='string'||!['user','tool','assistant','system'].includes(part.role)))return[];
  return parts.filter(part=>part.role==='user'||part.role==='tool').map(part=>part.content);
}

/** New task packets have an explicit boundary while retaining each input byte. */
export function encodeMaterialInput(parts:readonly (string|MaterialInputPart)[]):string{
  const messages=parts.map(part=>typeof part==='string'?{role:'user',content:part}:part);
  return messages.length===1&&['user','tool'].includes(messages[0].role)?messages[0].content:JSON.stringify({format:'yixu-task-input-v1',parts:messages.map(({role,content})=>({role,content}))});
}

/** Read old runtime carriers without splitting prose or JSON string bodies.
 * Legacy multi-packets must consist entirely of complete objects/arrays joined
 * by the runtime's blank-line separator. Partial/mixed prose grants nothing. */
export function decodeMaterialInput(text:string):unknown[]{
  try{return[JSON.parse(text)];}catch{}
  // The pre-envelope bootstrap appended exactly this host-owned tail. Other
  // runtime instructions are JSON packets and need no prose compatibility.
  const legacyTail='\n\n'+MATERIAL_CONTINUATION;
  if(text.endsWith(legacyTail))return decodeMaterialInput(text.slice(0,-legacyTail.length));
  const values:unknown[]=[];let position=0;
  while(position<text.length){
    while(/\s/.test(text[position]??'')&&position<text.length)position++;
    const start=position;if(text[start]!=='{'&&text[start]!=='[')return[];
    const stack:string[]=[];let quoted=false,escaped=false;
    for(;position<text.length;position++){
      const char=text[position];
      if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;continue;}
      if(char==='"'){quoted=true;continue;}
      if(char==='{'||char==='[')stack.push(char);
      else if(char==='}'||char===']'){
        if(stack.pop()!==(char==='}'?'{':'['))return[];
        if(!stack.length){position++;break;}
      }
    }
    if(quoted||stack.length)return[];
    try{values.push(JSON.parse(text.slice(start,position)));}catch{return[];}
    const separatorStart=position;while(position<text.length&&/\s/.test(text[position]))position++;
    if(position<text.length&&!/\r?\n\r?\n/.test(text.slice(separatorStart,position)))return[];
  }
  return values.length>1?values:[];
}

type InputObject=Record<string,unknown>;
const object=(value:unknown):value is InputObject=>!!value&&typeof value==='object'&&!Array.isArray(value);
type DialoguePacket={key:number;scene:InputObject[];parts:{role:string;value:unknown;content:string}[]};

/** Recognize only host-owned structured scene packets; prose and unknown
 * carriers are never interpreted as instructions or silently discarded. */
function dialoguePacket(key:number,text:string):DialoguePacket|undefined{
  const values=decodeMaterialInput(text),parts:DialoguePacket['parts']=[];
  for(const value of values){
    if(object(value)&&value.format==='yixu-task-input-v1'){
      if(!Array.isArray(value.parts))return;
      for(const part of value.parts){if(!object(part)||typeof part.role!=='string'||typeof part.content!=='string')return;const decoded=decodeMaterialInput(part.content);if(decoded.length!==1)return;parts.push({role:part.role,value:decoded[0],content:part.content});}
    }else parts.push({role:'user',value,content:JSON.stringify(value)});
  }
  const scene=parts.flatMap(part=>{const value=part.value;return part.role==='user'&&object(value)&&value.task==='scene'&&object(value.event)&&typeof value.userText==='string'&&['conversation','original','previous','memories','views'].every(key=>Array.isArray(value[key]))?[value]:[];});
  return scene.length?{key,scene,parts}:undefined;
}

/** One transient linear pass over completed host packets. Dialogue bodies are
 * copied exactly, including reference targets; no summary or new read is made. */
export function projectCompletedConversationInputs(inputs:readonly {key:number;text:string}[]):Map<number,string>{
  const packets=inputs.flatMap(input=>{const packet=dialoguePacket(input.key,input.text);return packet?[packet]:[];}),bodies=new Map<string,string>(),conflicts=new Set<string>();
  const remember=(value:unknown)=>{if(!object(value)||typeof value.id!=='string'||typeof value.text!=='string')return;const previous=bodies.get(value.id);if(previous!==undefined&&previous!==value.text)conflicts.add(value.id);else bodies.set(value.id,value.text);};
  for(const packet of packets)for(const part of packet.parts){if(!object(part.value))continue;const value=part.value;if(Array.isArray(value.conversation))for(const chat of value.conversation)remember(chat);remember(value.paragraphComment);}
  const result=new Map<number,string>();
  for(const packet of packets){
    const conversation:InputObject[]=[],userMessages:InputObject[]=[],paragraphComments:unknown[]=[],checkpoints:unknown[]=[],retainedParts:{role:string;content:string}[]=[],materials:InputObject[]=[];
    const conversationKeys=new Set<string>(),userTexts=new Set<string>(),userIds=new Set<string>(),pendingUsers:{text:string;id?:string}[]=[],ownUserParts=new Map<string,InputObject>(),sceneParts=new Set(packet.scene);
    let safe=true;for(const part of packet.parts)if(part.role==='user'&&object(part.value)&&typeof part.value.userText==='string'&&typeof part.value.userChatId==='string')ownUserParts.set(part.value.userText,part.value);
    for(const scene of packet.scene){
      for(const raw of scene.conversation as unknown[]){
        if(!object(raw)||typeof raw.id!=='string'||!['user','assistant'].includes(String(raw.role))){safe=false;break;}
        let chat={...raw};if(typeof chat.text!=='string'&&typeof chat.bodyRefId==='string'){const text=conflicts.has(chat.bodyRefId)?undefined:bodies.get(chat.bodyRefId);if(text===undefined){safe=false;break;}const{bodyRefId,...identity}=chat;chat={...identity,text,originalBodyRefId:bodyRefId};}
        if(typeof chat.text!=='string'){safe=false;break;}
        // A resolved alias retains its historical relationship as metadata,
        // while its exact body no longer depends on another surface node.
        const key=JSON.stringify([chat.id,chat.role,chat.text]);if(!conversationKeys.has(key)){conversationKeys.add(key);conversation.push(chat);if(chat.role==='user'){userTexts.add(chat.text);userIds.add(JSON.stringify([chat.id,chat.text]));}}
      }
      const fields=(values:unknown,keys:readonly string[])=>Array.isArray(values)?values.filter(object).map(value=>Object.fromEntries(keys.filter(key=>value[key]!==undefined).map(key=>[key,value[key]]))):[];
      materials.push({...(typeof scene.book==='string'?{book:scene.book}:{}),...(object(scene.sceneRange)?{sceneRange:scene.sceneRange}:{}),originalRanges:fields(scene.original,['start','end']),previousRanges:fields(scene.previous,['start','end']),memories:fields(scene.memories,['id','bodyHash','bodyChars']),views:fields(scene.views,['id','kind','key']),...(object(scene.recentOriginalWindow)&&Array.isArray(scene.recentOriginalWindow.previouslyProvided)?{passageReferences:scene.recentOriginalWindow.previouslyProvided}:{})});
      const text=scene.userText as string,identity=ownUserParts.get(text),id=typeof identity?.userChatId==='string'&&identity.userChatId?identity.userChatId:undefined;
      if(text)pendingUsers.push({text,...(id?{id}:{})});
    }
    if(!safe)continue;
    for(const part of packet.parts){
      const value=part.value;if(sceneParts.has(value as InputObject))continue;
      if(part.role==='user'&&object(value)){
        if(typeof value.userText==='string'&&typeof value.userChatId==='string'){
          const text=value.userText,id=value.userChatId||undefined;
          if(text)pendingUsers.push({text,...(id?{id}:{})});
          continue;
        }
        if(value.webToolsAvailable!==undefined&&typeof value.requireActualSearch==='boolean'&&typeof value.requirePageRead==='boolean'&&Object.keys(value).every(key=>['webToolsAvailable','requireActualSearch','requirePageRead','instruction'].includes(key)))continue;
        if(value.paragraphComment!==undefined&&Object.keys(value).every(key=>['paragraphComment','instruction'].includes(key))){let comment=value.paragraphComment;if(object(comment)&&typeof comment.text!=='string'&&typeof comment.bodyRefId==='string'){const text=conflicts.has(comment.bodyRefId)?undefined:bodies.get(comment.bodyRefId);if(text===undefined){safe=false;break;}const{bodyRefId,...identity}=comment;comment={...identity,text,originalBodyRefId:bodyRefId};}paragraphComments.push(comment);continue;}
        if(value.previousConversationCheckpoint!==undefined&&Object.keys(value).every(key=>['previousConversationCheckpoint','instruction'].includes(key))){checkpoints.push(value.previousConversationCheckpoint);continue;}
      }
      retainedParts.push({role:part.role,content:part.content});
    }
    const distinctUsers=new Set<string>();for(const {id,text}of pendingUsers){const key=JSON.stringify([id??null,text]);if((id?userIds.has(JSON.stringify([id,text])):userTexts.has(text))||distinctUsers.has(key))continue;distinctUsers.add(key);userMessages.push({...(id?{id}:{}),role:'user',text});}
    if(safe)result.set(packet.key,JSON.stringify({format:'yixu-dialogue-history-v1',conversation,...(userMessages.length?{userMessages}:{}),...(paragraphComments.length?{paragraphComments}:{}),...(checkpoints.length?{previousConversationCheckpoints:checkpoints}:{}),materials,...(retainedParts.length?{retainedParts}:{}),materialBodies:'原任务资料已退出当前输入；原事件及取回身份保留，元数据不表示当前已提供正文。'}));
  }
  return result;
}
