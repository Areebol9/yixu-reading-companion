import {isEvidenceAllowed} from './context.ts';
import {semanticNote} from './semantic-notes.ts';
import type {Book,Memory,Range} from './types.ts';

/** A view over permitted concrete versions; it never changes the stored annotation. */
export function visibleSemanticMemory(book:Book,m:Memory,versions:ReadonlyMap<string,Memory>,options:{extra?:Range[];world?:boolean;chatIds?:ReadonlySet<string>}={}):Memory{
  const copy=structuredClone(m),note=semanticNote(m);let gap=false;
  if(copy.basis)copy.basis={memoryIds:copy.basis.memoryIds.filter(id=>versions.has(id)),chatIds:copy.basis.chatIds.filter(id=>options.chatIds?.has(id))};
  if(!options.world||!versions.has(m.id)){delete copy.temporal;delete copy.clue;delete(copy as any).semanticAvailability;return copy;}
  const sourced=(refs:NonNullable<Memory['sourceEvidence']>)=>refs.length>0&&refs.every(e=>isEvidenceAllowed(book,[e],options.extra??[]));
  const story=(id:string)=>{const target=versions.get(id),refs=[...(target?.sourceEvidence??[]),...(target?.sourceQuote?[target.sourceQuote.evidence]:[])];return target?.kind==='story'&&sourced(refs)?target:undefined;};
  if(note.temporal){
    const temporal=note.temporal;
    for(const axis of ['occurrence','acquisition'] as const){const anchor=temporal[axis];if(!anchor)continue;
      if(axis==='acquisition'&&(!options.world||!copy.attribution||!['received','believes'].includes(copy.attribution.mode))){delete temporal[axis];if(options.world)gap=true;continue;}
      if(!sourced(anchor.sourceEvidence)){delete temporal[axis];gap=true;continue;}
      if(anchor.relations){const filtered=anchor.relations.filter(r=>{const target=story(r.targetId);return !!target?.temporal?.occurrence&&sourced(target.temporal.occurrence.sourceEvidence);});if(filtered.length!==anchor.relations.length)gap=true;anchor.relations=filtered;}
    }
    if(temporal.revelation&&!sourced(temporal.revelation.sourceEvidence)){delete temporal.revelation;gap=true;}
    if(Object.keys(temporal).length)copy.temporal=temporal;else delete copy.temporal;
  }
  if(note.clue){const clue=note.clue;
    if(!sourced(clue.sourceEvidence)){delete copy.clue;gap=true;}
    else{const valid=(ref:typeof clue.setupRef)=>{const target=story(ref.memoryId);return !!target&&typeof target.text==='string'&&Number.isSafeInteger(ref.start)&&Number.isSafeInteger(ref.end)&&ref.start>=0&&ref.end>ref.start&&ref.end<=target.text.length&&!splitsSurrogate(target.text,ref.start)&&!splitsSurrogate(target.text,ref.end);};
      // A removed setup cannot leave an apparently usable interpretation chain.
      if(!valid(clue.setupRef)){delete copy.clue;gap=true;}
      else{const payoffs=clue.payoffRefs?.filter(valid);if(payoffs?.length!==clue.payoffRefs?.length||clue.status==='confirmed'&&!payoffs?.length){delete copy.clue;gap=true;}else copy.clue={...clue,...(payoffs?{payoffRefs:payoffs}:{})};}
    }
  }
  if(gap)(copy as any).semanticAvailability='needs-review';
  return copy;
}
function splitsSurrogate(text:string,index:number):boolean{return index>0&&index<text.length&&text.charCodeAt(index-1)>=0xD800&&text.charCodeAt(index-1)<=0xDBFF&&text.charCodeAt(index)>=0xDC00&&text.charCodeAt(index)<=0xDFFF;}
export function semanticMaterial(m:Memory){return{...semanticNote(m),...((m as any).semanticAvailability?{semanticAvailability:(m as any).semanticAvailability}:{}),partnerFormation:{...(m.readingStage?{readingStage:structuredClone(m.readingStage)}:{}),basis:{memoryIds:structuredClone(m.basis?.memoryIds??[]),chatIds:structuredClone(m.basis?.chatIds??[])},recordedAt:m.createdAt}};}
