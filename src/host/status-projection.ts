const pick=(value:any,keys:readonly string[])=>Object.fromEntries(keys.filter(key=>value?.[key]!==undefined).map(key=>[key,value[key]]));
/** Explicit metadata allowlist: status never serializes text, chats or keys. */
export function summarizeHostSnapshot(snapshot:any){
  const state=snapshot.app?.state??{},book=state.books?.find((value:any)=>value.id===snapshot.selectedBookId)??snapshot.book;
  return{...pick(snapshot,['sessionId','mode','following','modelReady','hasKey','busyAction','error','notice','sessionArchived','budget','autoReading']),
    book:book?{...pick(book,['id','title','version','position']),chapters:book.chapters?.length}:undefined,
    page:pick(snapshot.page,['bookId','version','start','end','chapterIndex','chapterTitle','pageNumber','totalPages','position','navigationRevision']),
    settings:pick(snapshot.settings,['baseUrl','model','maxOutput','tokenLimit','contextLimit','effort','pageChars']),
    counts:Object.fromEntries(['books','chats','usage','memories','questions','maintenanceJobs'].filter(key=>Array.isArray(state[key])).map(key=>[key,key==='chats'?snapshot.app?.conversationStatistics?.chatCount??state[key].length:state[key].length])),
    readingControl:snapshot.app?.readingControl,maintenance:snapshot.app?.maintenanceProgress?.find((value:any)=>value.bookId===book?.id),flow:pick(snapshot.app?.readingFlow,['foregroundPending','sceneSavePending','sceneRestoreBookIds','sceneReceiptBookIds','maintenanceRecovery'])};
}
