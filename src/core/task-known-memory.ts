import {memoryReadableByPartner,sameDocumentOwner} from './book-document-ownership.ts';
import {isEvidenceAllowed,memoryIsForgotten} from './context.ts';
import {applyDocumentRevision,validateDocumentRevision} from './document-revision.ts';
import {memoryContentIdentity,memoryReadVersion} from './memory-identity.ts';
import {taskFullMemoryIds} from './material-projection.ts';
import type {MaterialExposureReceipt} from './material-projection.ts';
import type {Book,Memory,State,Understanding} from './types.ts';

/** The caller has verified this task's original operation and its exact saved
 * candidate hash -> immutable result ID (or an imminent validated proposal).
 * A loaded body, an assistant claim, or an unrelated write is not such proof.
 * Keep the original edits/append/operation: materialized text alone loses the
 * distinction between authored bytes and untouched bytes copied by the host. */
export type TaskKnownMemoryWrite={memoryId:string;proposal:Understanding};

/** Exact versions known by this task, independently of book/private scope.
 * This is not an input-exposure receipt, a current-head assertion, or new write
 * authority. Callers still validate task identity, current sources and heads at
 * their normal dispatch/commit fences. Missing input receipts grant no reads. */
export function taskKnownMemoryIds(state:State,book:Book,memories:readonly Memory[],receipts:readonly MaterialExposureReceipt[]|undefined,writes:readonly TaskKnownMemoryWrite[]=[]):Set<string>{
  const live=new Map(state.memories.map(memory=>[memory.id,memory]));
  const eligible=memories.filter(memory=>{
    if(memory.bookId!==book.id||!memoryReadableByPartner(state,memory)||memory.forgotten||memory.invalidatedBy||memory.reviewDisposition==='unsupported'||memoryIsForgotten(state,memory)||!isEvidenceAllowed(book,memory.evidence))return false;
    const current=live.get(memory.id);
    return !current||sameDocumentOwner(memory,current)&&!current.forgotten&&!current.invalidatedBy&&current.reviewDisposition!=='unsupported'&&memoryReadableByPartner(state,current)&&!memoryIsForgotten(state,current)&&isEvidenceAllowed(book,current.evidence)&&memoryReadVersion(memory)===memoryReadVersion(current);
  });
  const byId=new Map(eligible.map(memory=>[memory.id,memory]));
  const known=taskFullMemoryIds(eligible,receipts);
  // Fixed point permits several verified operations in the same task, without
  // treating an arbitrary replacedBy chain as proof that its bodies were read.
  let changed=true;
  while(changed){
    changed=false;
    for(const {memoryId,proposal} of writes){
      if(known.has(memoryId))continue;
      const memory=byId.get(memoryId);
      if(!memory||typeof memory.text!=='string'||memory.kind!==proposal.kind)continue;
      const previous=proposal.updates?byId.get(proposal.updates):undefined;
      if(proposal.updates&&(!previous||!sameDocumentOwner(previous,memory)))continue;
      const copied=['revise','organize','retire','restore'].includes(proposal.documentOperation??'')||proposal.edits!==undefined||proposal.appendText!==undefined;
      let exact=false;
      if(copied){
        if(!previous||!known.has(previous.id)||typeof previous.text!=='string'||memory.correctionOf!==previous.id||memory.revisionKind!=='development')continue;
        if(proposal.documentOperation==='revise'||proposal.edits!==undefined||proposal.appendText!==undefined){
          // The old immutable version can now be historical after this very
          // write. Only its lifecycle pointer is ignored during reconstruction.
          try{
            if(!memory.documentRevision||memory.documentRevision.previousId!==previous.id)continue;
            validateDocumentRevision(memory,previous,book);
            exact=applyDocumentRevision({...previous,replacedBy:undefined},proposal).text===memory.text;
          }catch{continue;}
        }else exact=memory.text===previous.text&&(!proposal.text||proposal.text===memory.text);
      }else{
        // Full authored bytes also count when storage deduplicates to an old ID.
        // Never certify normalized-but-not-identical prose.
        const authored=proposal.kind==='opinion'?proposal.text:proposal.text.trim();
        exact=!!authored.trim()&&authored===memory.text;
        if(proposal.documentOperation==='merge')exact=exact&&[proposal.updates,...(proposal.mergePreviousIds??[])].every(id=>!!id&&known.has(id));
      }
      if(exact){memoryContentIdentity(memory);known.add(memory.id);changed=true;}
    }
  }
  return known;
}
