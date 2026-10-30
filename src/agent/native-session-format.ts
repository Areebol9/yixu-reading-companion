import {Session,SessionId,SessionLogOffset,KNOWN_SESSION_EVENT_TYPES,type SessionHeader,type SessionEvent} from '@deepseek-ai/dsh-session';
import {createSessionFormatCatalog,type SessionFormatArtifact} from '@deepseek-ai/dsh-session-format';
import {releasedV4SessionFormatCodec,restoreReleasedV4Artifact,assertReleasedV4Header,sessionFormatV3ToV4} from '@deepseek-ai/dsh-session-format-v3-to-v4';
import {releasedV0SessionFormatCodec,releasedV1SessionFormatCodec,sessionFormatV0ToV1} from '@deepseek-ai/dsh-session-format-v0-to-v1';
import {releasedV2SessionFormatCodec,sessionFormatV1ToV2} from '@deepseek-ai/dsh-session-format-v1-to-v2';
import {releasedV3SessionFormatCodec,sessionFormatV2ToV3} from '@deepseek-ai/dsh-session-format-v2-to-v3';
import {currentSessionMessageProjections} from '@deepseek-ai/dsh-session-format-catalog/message-projections';

/** Required application events are decoded explicitly; no upstream vocabulary or
 * persisted ignorable marker is changed. Unknown required types still fail. */
const productEventTypes=new Set(['yixu/model-request','yixu/model-response','yixu/model-not-dispatched','yixu/feedback','yixu/reading-check','yixu/terminal-result']);
const vocabulary=new Set([...KNOWN_SESSION_EVENT_TYPES,...productEventTypes]);
export function validateProductEventData(events:readonly {type:string;data:unknown}[]){
  for(const event of events){
    if(!productEventTypes.has(event.type))continue;
    const data=event.data;if(!data||typeof data!=='object'||Array.isArray(data))throw Error('原生扩展事件内容无效：'+event.type);
    const item=data as Record<string,unknown>,text=(key:string)=>typeof item[key]==='string'&&!!item[key];
    let valid=false;
    switch(event.type){
      case 'yixu/model-request':valid=text('agentCallId')&&Number.isSafeInteger(item.ordinal)&&Number(item.ordinal)>0&&(item.purpose===undefined||typeof item.purpose==='string')&&(item.taskExecutionId===undefined||text('taskExecutionId'));break;
      case 'yixu/model-response':valid=text('agentCallId')&&text('requestId');break;
      case 'yixu/model-not-dispatched':valid=text('agentCallId');break;
      case 'yixu/feedback':valid=text('requestId')&&text('messageId');break;
      case 'yixu/reading-check':valid=text('signature')&&text('authorization')&&text('requestId')&&text('toolCallId');break;
      case 'yixu/terminal-result':valid=text('agentCallId')&&text('operationKey')&&typeof item.accepted==='boolean'&&(item.requestId===undefined||text('requestId'));break;
    }
    if(!valid)throw Error('原生扩展事件字段无效：'+event.type);
  }
}
function restoreCurrent(artifact:SessionFormatArtifact){
  restoreReleasedV4Artifact(artifact,vocabulary);validateProductEventData(artifact.events);
  Session.fromRestore(SessionId(artifact.header.id),artifact.events as unknown as SessionEvent[],artifact.header as unknown as SessionHeader,SessionLogOffset(artifact.inheritedEventCount),'detached',currentSessionMessageProjections);
  return artifact;
}
export const productSessionFormatCatalog=createSessionFormatCatalog({currentVersion:4,codecs:[releasedV0SessionFormatCodec,releasedV1SessionFormatCodec,releasedV2SessionFormatCodec,releasedV3SessionFormatCodec,releasedV4SessionFormatCodec],currentEncoder:releasedV4SessionFormatCodec,migrations:[sessionFormatV0ToV1,sessionFormatV1ToV2,sessionFormatV2ToV3,sessionFormatV3ToV4],restoreCurrent,restoreTransformedCurrent:restoreCurrent,restoreCurrentHeader(header){assertReleasedV4Header(header);Session.fromRestore(SessionId(header.id),[],header as unknown as SessionHeader,SessionLogOffset(0),'detached');return header;}});
export function validateProductSessionEvents(header:SessionHeader,events:SessionEvent[]){
  restoreCurrent({header:{...header,delegationDepth:header.delegationDepth??0} as unknown as SessionFormatArtifact['header'],events:events as unknown as SessionFormatArtifact['events'],inheritedEventCount:0});
}
