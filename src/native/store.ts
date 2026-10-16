import {stateCollections} from '../core/types.ts';
import type { Book,BookRangeResult,Range,MemoryBody,MemoryBodyRef,State,StateChangeSet,Store,TaskMaterialBody,TaskMaterialRef } from '../core/types.ts';
import { bookLength } from '../core/books.ts';
import { BoundedMemoryBodyCache, prepareMemoryBodySnapshot, releasePersistedMemoryBodies } from '../core/memory-bodies.ts';
import type { NativeRequest } from './channel.ts';
import {captureStorageChanges,prepareStorageChanges,restoreStorageMaterials,validateTaskMaterialRef} from '../core/storage-records.ts';
import {hashText} from '../core/text-hash.ts';

export class NativeStore implements Store {
  private writtenOriginals = new Set<string>();
  private writing: Promise<void> = Promise.resolve();
  private bodyCache = new BoundedMemoryBodyCache();
  private writtenBodies = new Set<string>();
  private writtenTaskMaterials = new Set<string>();
  private verifiedTaskBodies = new WeakSet<TaskMaterialBody>();
  private request: NativeRequest;
  constructor(request: NativeRequest) { this.request = request; }
  async load(): Promise<State | undefined> {
    const state = await this.request<State | null>('loadState');
    if (!state) return undefined;
    const transfer = state as unknown as Record<string, unknown>;
    const hadEnvelope = 'secrets' in transfer || 'exportedAt' in transfer;
    const migrate = transfer.nativeStorageMigrationRequired === true;
    delete transfer.secrets; delete transfer.exportedAt; delete transfer.nativeStorageMigrationRequired;
    this.retainBookTexts(state.books);
    if (migrate || hadEnvelope || state.memories.some(memory => typeof memory.text === 'string')) {
      await this.save(state);
      releasePersistedMemoryBodies(state);
      return this.load();
    }
    await restoreStorageMaterials(state,this.readTaskMaterials.bind(this));return state;
  }
  async readMemoryIndex(): Promise<unknown | undefined> { return await this.request<unknown>('readMemoryIndex') ?? undefined; }
  writeMemoryIndex(index: unknown): Promise<void> {
    const copy = structuredClone(index);
    if (new TextEncoder().encode(JSON.stringify(copy)).length > 16_000_000) return Promise.reject(Error('阅读档案索引超过当前支持体积'));
    const next = this.writing.catch(() => {}).then(async () => { await this.request('writeMemoryIndex', { index: copy }); });
    this.writing = next; return next;
  }
  async readMemoryBodies(refs: readonly MemoryBodyRef[]): Promise<MemoryBody[]> {
    return this.bodyCache.read(refs, async missing => {
      const bodies: MemoryBody[] = [];
      for (let start = 0; start < missing.length; start += 128) bodies.push(...await this.request<MemoryBody[]>('readMemoryBodies', { refs: missing.slice(start, start + 128) }));
      return bodies;
    });
  }
  async readBookText(version: string): Promise<string> {
    const text = await this.request<string>('readBookText', { version });
    return text;
  }
  async readBookRanges(version:string,ranges:readonly Range[]):Promise<BookRangeResult>{return this.request('readBookRanges',{version,ranges});}
  async readTaskMaterials(refs:readonly TaskMaterialRef[]):Promise<TaskMaterialBody[]>{
    for(const ref of refs)validateTaskMaterialRef(ref);
    const result:TaskMaterialBody[]=[];
    for(let i=0;i<refs.length;i+=128){const items=await this.request<{key:string;hash:string;text:string}[]>('readTaskMaterials',{refs:refs.slice(i,i+128)});for(const item of items)result.push({key:item.key,hash:item.hash,value:JSON.parse(item.text)});}
    return result;
  }
  applyChanges(changes:StateChangeSet):Promise<void>{
    const captured=captureStorageChanges(changes),memories=changes.collections.memories?.put;
    const snapshot=memories?.length?prepareMemoryBodySnapshot({memories} as State):undefined;snapshot?.catch(()=>{});
    const next=this.writing.catch(()=>{}).then(async()=>{
      const prepared=await snapshot;
      const input=prepared?{...captured,collections:{...captured.collections,memories:{...captured.collections.memories,put:prepared.state.memories}},memoryBodies:[...(captured.memoryBodies??[]),...prepared.bodies]}:captured;
      for(const book of input.collections.books?.put??[])if(book.text)throw Error('局部提交只接受原文元信息，完整原文请走导入');
      const wire=await prepareStorageChanges(input);
      for(const body of wire.memoryBodies??[])if(!this.writtenBodies.has(body.key)){await this.request('putMemoryBody',body);this.writtenBodies.add(body.key);}
      await this.persistTaskMaterials(wire.taskMaterials??[]);
      const {memoryBodies:_,taskMaterials:__,...metadata}=wire;
      await this.request('applyStateChanges',metadata);prepared?.commit();
    });this.writing=next;return next;
  }
  retainBookTexts(books: readonly Book[]): void {
    // Keep verification keys only; originals are never retained in this adapter.
    const resident = new Set(books.map(b => b.version));
    for (const version of this.writtenOriginals) if (!resident.has(version)) this.writtenOriginals.delete(version);
  }
  private async persistTaskMaterials(bodies:readonly TaskMaterialBody[]):Promise<void>{
    for(const body of bodies){let text:string|undefined;if(!this.verifiedTaskBodies.has(body)){text=JSON.stringify(body.value);if(body.key!=='task-material-'+body.hash||await hashText(text)!==body.hash)throw Error('任务材料校验失败');this.verifiedTaskBodies.add(body);}if(this.writtenTaskMaterials.has(body.key))continue;text??=JSON.stringify(body.value);await this.request('putTaskMaterial',{key:body.key,hash:body.hash,text,bytes:new TextEncoder().encode(text).length});this.writtenTaskMaterials.add(body.key);}
  }
  save(state: State): Promise<void> {
    const originals = state.books.filter(book => book.text.length > 0).map(book => ({ version: book.version, text: book.text }));
    const snapshot = prepareMemoryBodySnapshot({ ...state, books: state.books.map(book => ({ ...book, textLength: bookLength(book), text: '' })) });
    snapshot.catch(() => {});
    const next = this.writing.catch(() => {}).then(async () => {
      const prepared = await snapshot, copy = prepared.state;
      delete (copy as unknown as Record<string, unknown>).secrets;
      delete (copy as unknown as Record<string, unknown>).exportedAt;
      for (const original of originals) {
        if(await hashText(original.text)!==original.version)throw Error('导入原文版本不符');
        if(!this.writtenOriginals.has(original.version)){await this.request('putBookText', original);this.writtenOriginals.add(original.version);}
      }
      for (const body of prepared.bodies) if (!this.writtenBodies.has(body.key)) {
        await this.request('putMemoryBody', body); this.writtenBodies.add(body.key);
      }
      const collections:StateChangeSet['collections']={};for(const name of stateCollections)(collections as any)[name]={put:(copy as any)[name]??[]};
      const wire=await prepareStorageChanges({id:'full-import',collections});
      await this.persistTaskMaterials(wire.taskMaterials??[]);
      const metadata={...copy} as Record<string,unknown>;for(const name of stateCollections)metadata[name]=wire.collections[name]?.put??[];
      await this.request('saveState',metadata);
      prepared.commit();
    });
    this.writing = next; return next;
  }
}
