import type {Memory,PublishedView,State} from './types.ts';

type DocumentOwner={bookId:string;partnerId:string;scope?:'book'|'partner';kind?:string};
const bookAnalysisKinds=new Set<Memory['kind']>(['story','opinion','question','context','stage','state','arc']);

/** Missing scope retains the original private ownership. Attribution is never rewritten. */
export function documentScope(record:DocumentOwner):'book'|'partner'{
  return record.scope==='book'&&record.kind!=='user'&&record.kind!=='shared'?'book':'partner';
}

/** Ownership only: callers still check edition, permission, withdrawal and actual sources. */
export function memoryReadableByPartner(state:Pick<State,'partnerId'>,memory:Memory,partnerId=state.partnerId):boolean{
  return memory.partnerId===partnerId||documentScope(memory)==='book'&&bookAnalysisKinds.has(memory.kind);
}
export function viewReadableByPartner(state:Pick<State,'partnerId'>,view:PublishedView,partnerId=state.partnerId):boolean{
  return view.partnerId===partnerId||documentScope(view)==='book';
}

/** A book document can develop across generators; private records retain their owner. */
export function sameDocumentOwner(before:DocumentOwner,after:DocumentOwner):boolean{
  const scope=documentScope(before);
  return before.bookId===after.bookId&&scope===documentScope(after)&&(scope==='book'||before.partnerId===after.partnerId);
}
