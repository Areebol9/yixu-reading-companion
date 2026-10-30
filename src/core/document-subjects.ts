import {isBackgroundMemory,isCurrentMemory} from './context.ts';
import {documentScope} from './book-document-ownership.ts';
import {parseDocumentSubject} from './document-organization.ts';
import type {DocumentRole,DocumentSubject} from './document-organization.ts';
import type {Memory,State} from './types.ts';

export type DocumentSubjectNavigation = DocumentSubject & {
  /** A concrete immutable version ID, never a title-based guess. */
  currentPrimary?:{id:string;title:string;purpose:string;role:DocumentRole};
  /** Invalid competing declarations are exposed without choosing a winner. */
  currentPrimaryConflictIds?:string[];
};
const scopeKey=(memory:Memory,subjectKey:string)=>JSON.stringify([memory.bookId,documentScope(memory)==='book'?'book':['partner',memory.partnerId],isBackgroundMemory(memory)?'background':'reading',subjectKey]);

/** Validate already projected current versions without changing any record. */
export function validateDocumentSubjectPrimaries(memories:readonly Memory[]):void {
  const primaries=new Map<string,string>();
  for(const memory of memories){
    if(!isCurrentMemory(memory)||memory.organization?.subject==null)continue;
    const subject=parseDocumentSubject(memory.organization.subject)!;
    if(!subject.primary)continue;
    const key=scopeKey(memory,subject.key),previous=primaries.get(key);
    if(previous!==undefined&&previous!==memory.id)throw Error(`维护对象${subject.key}存在多个当前主稿（${previous}、${memory.id}）；请明确接续、退出或调整primary后再提交`);
    primaries.set(key,memory.id);
  }
}

/** Call after final planMemory, before publication. Normal development and
 * retire edges replace old versions; no separate subject registry is stored. */
export function validatePlannedDocumentSubjects(state:Pick<State,'memories'>,plan:{added:readonly Memory[];developments?:readonly {previousId:string;nextId:string}[]}):void {
  const successors=new Map((plan.developments??[]).map(edge=>[edge.previousId,edge.nextId]));
  const affected=new Set([...plan.added,...state.memories.filter(memory=>successors.has(memory.id))].flatMap(memory=>memory.organization?.subject?[scopeKey(memory,memory.organization.subject.key)]:[]));
  // An unrelated historical subject cannot block a local document update.
  validateDocumentSubjectPrimaries([...state.memories,...plan.added].filter(memory=>memory.organization?.subject&&affected.has(scopeKey(memory,memory.organization.subject.key))).map(memory=>successors.has(memory.id)?{...memory,replacedBy:successors.get(memory.id)}:memory));
}

/** The caller supplies only permission-checked, visible documents. A member
 * reaches the model-declared current primary through identity, not similarity. */
export function documentSubjectNavigation(memory:Memory,visible:readonly Memory[]):DocumentSubjectNavigation|undefined {
  const subject=memory.organization?.subject;if(!subject)return;
  const primaries=visible.filter(candidate=>isCurrentMemory(candidate)&&candidate.organization?.subject?.primary&&scopeKey(candidate,candidate.organization.subject.key)===scopeKey(memory,subject.key));
  const primary=primaries.length===1?primaries[0]:undefined,declared=primary?.organization?.subject;
  return {...structuredClone(subject),...(primary&&declared?{currentPrimary:{id:primary.id,title:primary.documentTitle??declared.title,purpose:declared.purpose,role:declared.role}}:{}),
    ...(primaries.length>1?{currentPrimaryConflictIds:primaries.map(candidate=>candidate.id)}:{})};
}

/** Search cues only; a hit never creates or changes object membership. */
export function documentSubjectNavigationText(memory:Memory):string {
  const subject=memory.organization?.subject;
  return subject?[subject.key,subject.title,subject.purpose,...(subject.aliases??[])].join('\n'):'';
}
