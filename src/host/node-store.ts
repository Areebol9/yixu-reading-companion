import {DatabaseSync, backup} from 'node:sqlite';
import {ReceiptTexts} from './stored-text.ts';
import {ContentObjects,type ContentObject} from './content-objects.ts';
import {StoragePreparation,type PreparedStorage} from './storage-preparation.ts';
import {createHash} from 'node:crypto';
import {nativeJsonlLines,type NativePrefixReader} from './content-object-native.ts';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {stateCollections, stateRecordKey} from '../core/types.ts';
import type {State, Store, StateChangeSet, StoredStateChangeSet, StorageCommitReceipt,MemoryBodyRef, MemoryBody, TaskMaterialRef, TaskMaterialBody, Range, BookRangeResult, BookTextQuery} from '../core/types.ts';
import {searchStoredBook} from './book-search.ts';
import {nativeSessionHeadersEqual,type NativeSessionReference,type AgentSessionSnapshot} from '../core/agent-port.ts';
import {prepareMemoryBodySnapshot} from '../core/memory-bodies.ts';
import {captureStorageChanges, prepareStorageChanges, restoreStorageMaterials, resolveStorageMaterials,validateTaskMaterialRef,storageMaterialOwners} from '../core/storage-records.ts';
import {hashText} from '../core/text-hash.ts';
import {updateRecordArray} from '../core/record-arrays.ts';
import {validateBookSourceLineage} from '../core/book-versions.ts';
import type {ObservationMetadata,ObservationChanges} from '../workbench/observation-store.ts';

const chunkChars = 32768;
const nativeOriginalKey=(reference:NativeSessionReference)=>reference.sessionId+':'+reference.eventCount+':'+createHash('sha256').update(JSON.stringify(reference.header)).digest('hex');
type Original = {version: string; length: number; chunks: {text: string; hash: string}[]};
type PortableNativeOriginal={kind:'dsh-original-jsonl-prefix-v1';sessionId:string;eventCount:number;encoding:'utf8';bytes:number;hash:string;chunks:{hash:string;bytes:number}[]};

/** PC domain storage. Official DSH JSONL remains the separate native log authority. */
export class NodeStore implements Store {
  readNativeAgentSession?: Store['readNativeAgentSession'];
  readNativeConversationCheckpoint?:Store['readNativeConversationCheckpoint'];
  readNativeAgentSessionStream?: (reference:NativeSessionReference)=>Promise<{header:unknown;events:AsyncIterable<unknown>}>;
  readNativeAgentSpills?:(reference:NativeSessionReference)=>AsyncIterable<{kind:'agent-session-spill-v1';locator:string;hash:string;bytes:number;text:AsyncIterable<string>}>;
  readNativeAgentOriginal?:NativePrefixReader;
  private database: DatabaseSync;
  private content: ContentObjects;
  private preparation:StoragePreparation;
  private portableRoots?:Set<string>;
  private writing: Promise<void> = Promise.resolve();
  private closed = false;
  private projection?:State;
  private verifiedBodies=new Map<string,string>();
  private immutableRecords=new Map<string,string>();
  private revision=0;
  private committed=new Set<(change:{revision:number;reset:boolean;changes:StoredStateChangeSet})=>void>();
  constructor(readonly filename: string,readonly receiptDirectory?:string) {
    mkdirSync(dirname(filename), {recursive: true});
    this.database = new DatabaseSync(filename);
    this.database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS head(id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entities(collection TEXT NOT NULL, key TEXT NOT NULL, ordering INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(collection,key));
      CREATE INDEX IF NOT EXISTS entities_ordering ON entities(ordering);
      CREATE TABLE IF NOT EXISTS objects(bucket TEXT NOT NULL, key TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(bucket,key));
      CREATE TABLE IF NOT EXISTS observation_entries(kind TEXT NOT NULL,key TEXT NOT NULL,ordering INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(kind,key));
      CREATE TABLE IF NOT EXISTS text_meta(version TEXT PRIMARY KEY, length INTEGER NOT NULL, chunk_chars INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS text_chunks(version TEXT NOT NULL, idx INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(version,idx));`);
    this.content=new ContentObjects(this.database,receiptDirectory?new ReceiptTexts(receiptDirectory):undefined);
    this.preparation=new StoragePreparation(receiptDirectory);
  }
  private queue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writing.catch(() => {}).then(() => { if (this.closed) throw Error('本地存档已关闭'); return work(); });
    this.writing = next.then(()=>{});void this.writing.catch(()=>{});return next;
  }
  private object<T>(bucket: string, key: string): T | undefined {
    const row = this.database.prepare('SELECT json FROM objects WHERE bucket=? AND key=?').get(bucket, key);
    return row ? this.content.decode(String(row.json)) : undefined;
  }
  private putObject(bucket: string, key: string, value: unknown) {
    this.database.prepare('INSERT INTO objects(bucket,key,json) VALUES(?,?,?) ON CONFLICT(bucket,key) DO UPDATE SET json=excluded.json').run(bucket, key, this.content.encode(value));
  }
  async load(): Promise<State | undefined> {
    // A rejected write never invalidates the last committed archive. Its caller
    // and flush still receive that rejection; cold/diagnostic reads stay usable.
    await this.writing.catch(()=>{});
    const row = this.database.prepare('SELECT json FROM head WHERE id=1').get();
    if (!row) {
      if (this.database.prepare('SELECT 1 FROM entities LIMIT 1').get()) throw Error('存档资料头缺失，未建立空档覆盖');
      return undefined;
    }
    const state = this.content.decode(String(row.json)) as State;
    delete (state as State & {storageOrder?: number}).storageOrder;
    for (const name of stateCollections) (state as unknown as Record<string, unknown>)[name] = [];
    for (const row of this.database.prepare('SELECT collection,json FROM entities ORDER BY ordering').all()) {
      if (!(stateCollections as readonly string[]).includes(String(row.collection))) throw Error('存档含未知实体集合');
      (state as unknown as Record<string, unknown[]>)[String(row.collection)].push(this.content.decode(String(row.json)));
    }
    for(const book of state.books)if(book.sourceLineage)await validateBookSourceLineage(book,this.readBookText.bind(this));
    await restoreStorageMaterials(state, this.readTaskMaterials.bind(this)); return state;
  }
  async readMemoryBodies(refs: readonly MemoryBodyRef[]): Promise<MemoryBody[]> {
    const results: MemoryBody[] = [];
    for (const ref of refs) {
      const value = this.object<MemoryBody>('memoryBodies', ref.key); if (!value) continue;
      if (value.hash !== ref.hash || value.key !== 'memory-body-' + ref.hash || value.text.length !== ref.chars || await hashText(value.text) !== ref.hash) throw Error('阅读正文对象校验失败');
      results.push(value);
    } return results;
  }
  async readTaskMaterials(refs: readonly TaskMaterialRef[]): Promise<TaskMaterialBody[]> {
    const results: TaskMaterialBody[] = [];
    for (const ref of refs) {
      validateTaskMaterialRef(ref); const value = this.object<TaskMaterialBody>('taskMaterials', ref.key); if (!value) continue;
      const text = JSON.stringify(value.value);
      if (value.hash !== ref.hash || value.key !== ref.key || new TextEncoder().encode(text).length !== ref.bytes || await hashText(text) !== ref.hash) throw Error('原任务材料正文校验失败');
      results.push(value);
    } return results;
  }
  async readBookRanges(version: string, ranges: readonly Range[]): Promise<BookRangeResult> {
    const meta = this.database.prepare('SELECT length,chunk_chars FROM text_meta WHERE version=?').get(version);
    if (!meta || meta.chunk_chars !== chunkChars) throw Error('原文范围仓缺失或版本不符');
    const length = Number(meta.length), pieces: BookRangeResult['pieces'] = [];
    for (const range of ranges) {
      if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end <= range.start || range.end > length) throw Error('原文范围越界');
      let text = '';
      for (let index = Math.floor(range.start / chunkChars); index <= Math.floor((range.end - 1) / chunkChars); index++) {
        const row = this.database.prepare('SELECT json FROM text_chunks WHERE version=? AND idx=?').get(version, index);
        if (!row) throw Error('原文范围块缺失'); const chunk = this.content.decode(String(row.json)) as {text: string; hash: string};
        if (await hashText(chunk.text) !== chunk.hash) throw Error('原文范围块校验失败');
        const start = index * chunkChars; text += chunk.text.slice(Math.max(0, range.start - start), Math.min(chunk.text.length, range.end - start));
      }
      if (text.length !== range.end - range.start) throw Error('原文范围长度不符');
      pieces.push({...range, text, hash: await hashText(text)});
    } return {version, length, pieces};
  }
  async readBookText(version: string): Promise<string> {
    const meta = this.database.prepare('SELECT length FROM text_meta WHERE version=?').get(version); if (!meta) throw Error('原文缺失');
    const {pieces} = await this.readBookRanges(version, [{start: 0, end: Number(meta.length)}]);
    if (await hashText(pieces[0].text) !== version) throw Error('原文版本不符'); return pieces[0].text;
  }
  async searchBookText(version: string, query: BookTextQuery) {
    const meta = this.database.prepare('SELECT length FROM text_meta WHERE version=?').get(version); if (!meta) throw Error('原文版本不存在');
    return searchStoredBook(version, Number(meta.length), query, async (start, end) => (await this.readBookRanges(version, [{start, end}])).pieces[0].text);
  }
  async readMemoryIndex(): Promise<unknown> { return this.object('memoryIndex', 'current'); }
  private prepareObjectWrite(bucket:string,key:string,value:unknown){
    const pending=this.preparation.values([value]).then(([prepared])=>{this.content.verifyPrepared(prepared.objects);return prepared;});void pending.catch(()=>{});
    return this.queue(async()=>{const prepared=await pending;this.database.exec('BEGIN IMMEDIATE');try{this.content.installPrepared(prepared.objects);this.database.prepare('INSERT INTO objects(bucket,key,json) VALUES(?,?,?) ON CONFLICT(bucket,key) DO UPDATE SET json=excluded.json').run(bucket,key,prepared.json);this.database.exec('COMMIT');}catch(error){this.database.exec('ROLLBACK');throw error;}});
  }
  writeMemoryIndex(index: unknown) { return this.prepareObjectWrite('memoryIndex','current',index); }
  async loadObservations<T>(): Promise<T | undefined> {
    await this.writing;
    let header=this.object<Record<string,unknown>>('observationHeader','current');
    if(!header){
      const legacy=this.object<ObservationMetadata>('observations','current');if(!legacy)return undefined;
      // One explicit cold migration. Ordinary navigation never re-reads this blob.
      await this.saveObservations(legacy);header=this.object<Record<string,unknown>>('observationHeader','current')!;
    }
    const observations:ObservationMetadata['observations']={events:[],ratings:{},timings:{},questions:{},readyDomains:{}},drafts:NonNullable<ObservationMetadata['drafts']>={};
    for(const row of this.database.prepare('SELECT kind,key,json FROM observation_entries ORDER BY kind,ordering').iterate()){
      const kind=String(row.kind),value=this.content.decode(String(row.json));
      if(kind==='drafts')drafts[String(row.key)]=value;
      else if(kind==='events')observations.events.push(value);
      else if(['ratings','timings','questions','readyDomains'].includes(kind))(observations as unknown as Record<string,Record<string,unknown>>)[kind][String(row.key)]=value;
      else throw Error('阅读记录含未知实体类型');
    }
    return {...header,observations,drafts} as T;
  }
  private async prepareObservationChanges(changes:ObservationChanges){
    const values=[changes.header,...changes.events,...(['ratings','timings','questions','readyDomains'] as const).flatMap(kind=>Object.values(changes[kind])),...Object.values(changes.drafts??{}).filter(value=>value!==null)];
    const prepared=await this.preparation.values(values);this.content.verifyPrepared(prepared.flatMap(value=>value.objects));return prepared;
  }
  private writeObservationChanges(changes:ObservationChanges,prepared:Awaited<ReturnType<NodeStore['prepareObservationChanges']>>){
    let at=0;const encode=()=>prepared[at++].json;
    this.database.prepare('INSERT INTO objects(bucket,key,json) VALUES(?,?,?) ON CONFLICT(bucket,key) DO UPDATE SET json=excluded.json').run('observationHeader','current',encode());
    const put=this.database.prepare('INSERT INTO observation_entries(kind,key,ordering,json) VALUES(?,?,?,?) ON CONFLICT(kind,key) DO UPDATE SET ordering=excluded.ordering,json=excluded.json');
    for(let index=0;index<changes.events.length;index++){const event=changes.events[index];put.run('events',event.id,changes.eventStart+index,encode());}
    for(const kind of ['ratings','timings','questions','readyDomains'] as const)for(const key of Object.keys(changes[kind]))put.run(kind,key,0,encode());
    for(const [key,value]of Object.entries(changes.drafts??{}))if(value===null)this.database.prepare("DELETE FROM observation_entries WHERE kind='drafts' AND key=?").run(key);else put.run('drafts',key,0,encode());
  }
  saveObservationChanges(changes:ObservationChanges){
    const copy=structuredClone(changes),pending=this.prepareObservationChanges(copy);void pending.catch(()=>{});
    return this.queue(async()=>{const prepared=await pending,objects=prepared.flatMap(value=>value.objects);this.database.exec('BEGIN IMMEDIATE');try{this.content.installPrepared(objects);this.writeObservationChanges(copy,prepared);this.database.exec('COMMIT');}catch(error){this.database.exec('ROLLBACK');throw error;}});
  }
  saveObservations(value:unknown){
    const copy=structuredClone(value) as ObservationMetadata;
    const {observations,drafts,...header}=copy;if(!observations||!Array.isArray(observations.events))return Promise.reject(Error('阅读记录格式无效'));
    const changes={header,eventStart:0,events:observations.events,ratings:observations.ratings??{},timings:observations.timings??{},questions:observations.questions??{},readyDomains:observations.readyDomains??{},drafts};
    const pending=this.prepareObservationChanges(changes);void pending.catch(()=>{});
    return this.queue(async()=>{
      const prepared=await pending,objects=prepared.flatMap(value=>value.objects);
      this.database.exec('BEGIN IMMEDIATE');try{
        this.content.installPrepared(objects);
        this.database.exec('DELETE FROM observation_entries');
        this.writeObservationChanges(changes,prepared);
        this.database.prepare("DELETE FROM objects WHERE bucket='observations' AND key='current'").run();this.database.exec('COMMIT');
      }catch(error){this.database.exec('ROLLBACK');throw error;}
    });
  }
  async prepareObservationExport(){await this.writing;if(!this.object('observationHeader','current')){const legacy=this.object('observations','current');if(legacy)await this.saveObservations(legacy);}return this.object<Record<string,unknown>>('observationHeader','current')??{};}
  *exportObservationEntries(kind:'events'|'ratings'|'timings'|'questions'|'readyDomains'|'drafts'):Generator<{key:string;value:unknown}>{
    for(const row of this.database.prepare('SELECT key,json FROM observation_entries WHERE kind=? ORDER BY ordering,key').iterate(kind))yield{key:String(row.key),value:this.content.decode(String(row.json))};
  }
  save(state: State): Promise<void> {
    const preceding=this.writing;
    const books = state.books.map(book => ({...book}));
    const pendingSnapshot = prepareMemoryBodySnapshot({...state, books: books.map(book => ({...book, textLength: book.text.length || book.textLength, text: ''}))});
    void pendingSnapshot.catch(() => {});
    const preparedFull=(async () => {
      const snapshot = await pendingSnapshot, copy = snapshot.state;
      // Full replacements may refer to originals imported by a preceding
      // write. Observe that committed prefix before checking immutable texts;
      // preparation itself still runs outside the writer callback.
      await preceding.catch(()=>{});
      const head = {...copy} as Record<string, unknown>;
      for (const name of stateCollections) delete head[name]; delete head.secrets; delete head.exportedAt;
      const collections: StateChangeSet['collections'] = {};
      for (const name of stateCollections) (collections as Record<string, unknown>)[name] = {put: copy[name] ?? []};
      const originals: Original[] = [];
      const retainedVersions=new Set<string>();
      if(books.some(book=>book.sourceLineage))for(const row of this.database.prepare("SELECT json FROM entities WHERE collection='books'").all()){
        const prior=this.content.decode(String(row.json)) as State['books'][number];retainedVersions.add(prior.version);
        for(const prefix of prior.sourceLineage?.prefixes??[])retainedVersions.add(prefix.version);
      }
      for (const book of books) {
        if(book.sourceLineage){
          await validateBookSourceLineage(book,async version=>{
            if(version===book.version&&book.text)return book.text;
            if(this.database.prepare('SELECT 1 FROM text_meta WHERE version=?').get(version))return this.readBookText(version);
            if(retainedVersions.has(version))throw Error('已保留的旧版本原文缺失，未从当前全文静默重建');
            const prefix=book.sourceLineage!.prefixes.find(item=>item.version===version);
            if(!prefix||!book.text)throw Error('旧版本原文缺失');return book.text.slice(0,prefix.chars);
          });
          // A portable full source contains every exact prefix. Recreate its
          // immutable original by hash when importing into an empty store.
          for(const prefix of book.sourceLineage.prefixes)if(!this.database.prepare('SELECT 1 FROM text_meta WHERE version=?').get(prefix.version)){
            if(!book.text)throw Error('旧版本原文缺失');
            const text=book.text.slice(0,prefix.chars),chunks=[];
            for(let i=0;i<text.length;i+=chunkChars){const part=text.slice(i,i+chunkChars);chunks.push({text:part,hash:await hashText(part)});}
            originals.push({version:prefix.version,length:text.length,chunks});
          }
        }
        const meta = this.database.prepare('SELECT length FROM text_meta WHERE version=?').get(book.version);
        if (book.text) {
          if (await hashText(book.text) !== book.version) throw Error('导入原文版本不符');
          if (meta && meta.length !== book.text.length) throw Error('同版本原文长度冲突');
          if (!meta) {
            const chunks = []; for (let i = 0; i < book.text.length; i += chunkChars) { const text = book.text.slice(i, i + chunkChars); chunks.push({text, hash: await hashText(text)}); }
            originals.push({version: book.version, length: book.text.length, chunks});
          }
        } else if (!meta) throw Error('原文尚未保存');
      }
      const prepared=await this.preparation.changes({id:'full-import',collections,memoryBodies:snapshot.bodies});
      const encodedOriginals:string[][]=[];
      for(const original of originals){const chunks=await this.preparation.values(original.chunks);encodedOriginals.push(chunks.map(chunk=>chunk.json));for(const chunk of chunks)prepared.objects.push(...chunk.objects);}
      this.verifyPreparedStorage(prepared);return{prepared,full:{head,originals,encodedOriginals},snapshot};
    })();void preparedFull.catch(()=>{});
    return this.queue(async()=>{const result=await preparedFull;this.commit(result.prepared,result.full);result.snapshot.commit();});
  }
  applyChanges(changes: StateChangeSet): Promise<StorageCommitReceipt> {
    const captured = captureStorageChanges(changes), memories = changes.collections.memories?.put;
    const pending = memories?.length ? prepareMemoryBodySnapshot({memories} as State) : undefined; void pending?.catch(() => {});
    const prepared=(async()=>{
      const snapshot = await pending;
      const input = snapshot ? {...captured, collections: {...captured.collections, memories: {...captured.collections.memories, put: snapshot.state.memories}}, memoryBodies: [...(captured.memoryBodies ?? []), ...snapshot.bodies]} : captured;
      const prepared=await this.preparation.changes(input);this.verifyPreparedStorage(prepared);return {prepared,snapshot};
    })();void prepared.catch(()=>{});
    return this.queue(async()=>{const result=await prepared;this.commit(result.prepared);result.snapshot?.commit();return{id:changes.id,collections:result.prepared.changes.collections};});
  }
  private verifyPreparedStorage(prepared:PreparedStorage){
    for(const name of ['memories','publishedViews'] as const)for(const value of prepared.changes.collections[name]?.put??[]){
      const key=stateRecordKey(name,value as never),identity=name+':'+key;
      if(!this.immutableRecords.has(identity)){
        const row=this.database.prepare('SELECT json FROM entities WHERE collection=? AND key=?').get(name,key);
        if(row){const prior=this.content.decode(String(row.json)),hash=name==='memories'?(prior.bodyRef?.hash??(typeof prior.text==='string'?createHash('sha256').update(prior.text).digest('hex'):undefined)):createHash('sha256').update(prior.text).digest('hex');if(!hash)throw Error('已保存文档的正文身份缺失');this.immutableRecords.set(identity,hash);}
      }
      const hash=prepared.immutable.find(value=>value.identity===identity)?.hash;
      const prior=this.immutableRecords.get(identity);if(!hash||prior&&hash!==prior)throw Error('同一文档版本的正文不可更换；请形成新的文档版本');
    }
    for(const value of prepared.bodies){const {bucket}=value;
      const identity=bucket+':'+value.key,row=this.database.prepare('SELECT json FROM objects WHERE bucket=? AND key=?').get(bucket,value.key);if(!row)continue;const json=String(row.json);
      if(this.verifiedBodies.get(identity)!==json){const previous=this.content.decode(json),text=bucket==='memoryBodies'?previous.text:JSON.stringify(previous.value);if(previous.key!==value.key||previous.hash!==value.hash||typeof text!=='string'||createHash('sha256').update(text).digest('hex')!==value.hash)throw Error('不可变正文对象冲突');this.verifiedBodies.set(identity,json);}
    }
    this.content.verifyPrepared(prepared.objects);
  }
  private commit(prepared: PreparedStorage, full?: {head: Record<string, unknown>; originals: Original[];encodedOriginals?:string[][]}) {
    const {changes}=prepared,encoded=new Map(prepared.encoded);
    const row = this.database.prepare('SELECT json FROM head WHERE id=1').get();
    if (!row && !full) throw Error('局部资料尚未初始化');
    const head = full ? {...full.head} : this.content.decode(String(row!.json));
    Object.assign(head, changes.set); for (const key of changes.unset ?? []) delete head[key]; head.schema = 1;
    const verified:{identity:string;json:string}[]=[];
    const writes:{bucket:string;key:string;json:string}[]=[];
    const immutable=prepared.immutable;
    for(const {identity,hash}of immutable){const prior=this.immutableRecords.get(identity);if(prior&&prior!==hash)throw Error('同一文档版本的正文不可更换；请形成新的文档版本');}
    // Earlier queued writes may have published this immutable identity. Its
    // successful commit also installed the verification proof, so the writer
    // checks only the exact row identity, never re-decodes/hashes a large body.
    for(const value of prepared.bodies){const {bucket}=value;
      const identity=bucket+':'+value.key,row=this.database.prepare('SELECT json FROM objects WHERE bucket=? AND key=?').get(bucket,value.key);
      const json=row?String(row.json):encoded.get(identity)!;
      if(row&&this.verifiedBodies.get(identity)!==json)throw Error('不可变正文在准备后发生变化');
      if(!row)writes.push({bucket,key:value.key,json});verified.push({identity,json});
    }
    // The small mutable head is merged only after earlier writes have committed.
    // It uses ordinary JSON, without content encoding or object writes.
    const encodedHead=JSON.stringify(head);
    // Content objects and their domain references publish in the same SQLite
    // transaction. Receipt files are immutable external originals and may remain
    // unreferenced after rollback; they are not part of the SQLite transaction.
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.content.installPrepared(prepared.objects);
      for(const write of writes)this.database.prepare('INSERT INTO objects VALUES(?,?,?)').run(write.bucket,write.key,write.json);
      for (const [position,original] of (full?.originals ?? []).entries()) {
        const old=this.database.prepare('SELECT length FROM text_meta WHERE version=?').get(original.version);if(old){if(old.length!==original.length)throw Error('同版本原文长度冲突');continue;}
        this.database.prepare('INSERT INTO text_meta VALUES(?,?,?)').run(original.version, original.length, chunkChars);
        original.chunks.forEach((_, i) => this.database.prepare('INSERT INTO text_chunks VALUES(?,?,?)').run(original.version, i, full!.encodedOriginals![position][i]));
      }
      if (full) this.database.exec('DELETE FROM entities');
      let ordering = Number(this.database.prepare('SELECT COALESCE(MAX(ordering),-1)+1 AS n FROM entities').get()!.n);
      for (const name of stateCollections) {
        const change = changes.collections[name]; if (!change) continue;
        for (const key of change.remove ?? []) this.database.prepare('DELETE FROM entities WHERE collection=? AND key=?').run(name, key);
        for (const value of change.put ?? []) {
          const record = value as Record<string, any>, key = stateRecordKey(name, value as never); if (!key) throw Error('实体存储身份缺失');
          if (name === 'books') { const meta = this.database.prepare('SELECT length FROM text_meta WHERE version=?').get(record.version); if (!meta || meta.length !== record.textLength) throw Error('原文版本或长度尚未保存'); }
          const references = [record.materialRef, record.pendingReceipt?.materialRef, record.maintenanceDispatch?.materialRef, record.agentResponse?.materialRef].filter(Boolean);
          if (name === 'memories') { if (!record.bodyRef || !this.database.prepare('SELECT 1 FROM objects WHERE bucket=? AND key=?').get('memoryBodies',record.bodyRef.key)) throw Error('阅读正文引用未保存'); }
          for (const ref of references) { validateTaskMaterialRef(ref); if (!this.database.prepare('SELECT 1 FROM objects WHERE bucket=? AND key=?').get('taskMaterials',ref.key)) throw Error('任务正文引用未保存'); }
          const previous = this.database.prepare('SELECT ordering FROM entities WHERE collection=? AND key=?').get(name, key);
          this.database.prepare('INSERT INTO entities VALUES(?,?,?,?) ON CONFLICT(collection,key) DO UPDATE SET json=excluded.json').run(name, key, previous?.ordering ?? ordering++, encoded.get('entity:'+name+':'+key)!);
        }
      }
      this.database.prepare('INSERT INTO head VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(encodedHead);
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
    for(const {identity,json}of verified)this.verifiedBodies.set(identity,json);
    for(const {identity,hash}of immutable)this.immutableRecords.set(identity,hash);
    if(full)this.projection=undefined;
    else if(this.projection){
      const previous=this.projection,head={...previous,...structuredClone(changes.set??{})};for(const key of changes.unset??[])delete head[key];
      for(const name of stateCollections){const change=changes.collections[name];
        if(!change){(head as any)[name]=previous[name];continue;}
        (head as any)[name]=updateRecordArray(previous[name]??[],name,record=>stateRecordKey(name,record as never),structuredClone(change.put??[]) as any[],change.remove);
      }this.projection=head;
    }
    const event={revision:++this.revision,reset:!!full,changes};for(const listener of this.committed)try{listener(event);}catch(error){console.error('已提交投影订阅未完成：',error);}
  }
  readProjectionState():State {
    if(this.projection)return this.projection;
    const state=this.exportHead() as unknown as State;for(const name of stateCollections)(state as any)[name]=[];
    for(const row of this.database.prepare('SELECT collection,json FROM entities ORDER BY ordering').iterate())(state as any)[String(row.collection)].push(this.content.decode(String(row.json)));
    return this.projection=state;
  }
  subscribeCommitted(listener:(change:{revision:number;reset:boolean;changes:StoredStateChangeSet})=>void){this.committed.add(listener);return()=>{this.committed.delete(listener);};}
  async flush() { await this.writing; }
  async readPartnerAvatar(id:string):Promise<import('../core/types.ts').PartnerAvatarAsset|undefined>{return this.object('partnerAvatars',id);}
  async writePartnerAvatar(asset:import('../core/types.ts').PartnerAvatarAsset):Promise<void>{
    const {partnerAvatarAsset}=await import('../core/partner-avatar.ts'),verified=await partnerAvatarAsset(asset.dataUrl);
    if(verified.id!==asset.id||verified.mimeType!==asset.mimeType)throw Error('头像图片身份不符');
    const prior=this.object<import('../core/types.ts').PartnerAvatarAsset>('partnerAvatars',asset.id);if(prior){if(prior.dataUrl!==asset.dataUrl)throw Error('头像资源冲突');return;}
    await this.prepareObjectWrite('partnerAvatars',asset.id,asset);
  }
  async createExportSnapshot(filename:string) {return this.queue(async()=>{await backup(this.database,filename);});}
  /** Only the unpublished export snapshot receives portable event chains. */
  async preparePortableNativeSessions(){
    const groups=new Map<string,Record<string,any>[]>();
    for(const record of this.exportEntities('agentSessions'))if(record.native){const key=JSON.stringify([record.native.sessionId,record.native.header]),group=groups.get(key);if(group)group.push(record);else groups.set(key,[record]);}
    const put=async(value:TaskMaterialBody['value'])=>{const text=JSON.stringify(value),hash=await hashText(text),key='task-material-'+hash;this.putObject('taskMaterials',key,{key,hash,value});return{key,hash,bytes:Buffer.byteLength(text)};};
    for(const records of groups.values()){
      // Several task records can point at different confirmed cuts of the same
      // append-only native log. Read that generation once, retaining each cut.
      const ordered=[...records].sort((a,b)=>a.native.eventCount-b.native.eventCount),largest=ordered.at(-1)!.native as NativeSessionReference;
      const wanted=new Set<number>(ordered.map(record=>record.native.eventCount));
      if(!this.readNativeAgentOriginal)throw Error('Native original JSONL byte reader is unavailable');
      const originalHash=createHash('sha256'),chunks:{hash:string;bytes:number}[]=[],prefixes=new Map<number,{bytes:number;hash:string;chunks:{hash:string;bytes:number}[]}>();
      let originalBytes=0,rows=0,block=Buffer.allocUnsafe(32768),filled=0,snapshot:AgentSessionSnapshot|undefined;
      const flushBytes=()=>{if(!filled)return;const bytes=block.subarray(0,filled),hash=createHash('sha256').update(bytes).digest('hex');this.putObject('nativeByteChunks',hash,{hash,bytes:bytes.length,base64:bytes.toString('base64')});chunks.push({hash,bytes:bytes.length});block=Buffer.allocUnsafe(32768);filled=0;};
      for await(const line of nativeJsonlLines(this.readNativeAgentOriginal(largest,value=>{snapshot=value;}))){
        originalHash.update(line);originalBytes+=line.length;
        for(let offset=0;offset<line.length;){const size=Math.min(block.length-filled,line.length-offset);line.copy(block,filled,offset,offset+size);filled+=size;offset+=size;if(filled===block.length)flushBytes();}
        if(wanted.has(rows++)){flushBytes();prefixes.set(rows-1,{bytes:originalBytes,hash:originalHash.copy().digest('hex'),chunks:[...chunks]});}
      }
      if(rows!==largest.eventCount+1||prefixes.size!==wanted.size)throw Error('Portable native original watermark differs');
      let native:{header:unknown;events:AsyncIterable<unknown>};
      if(snapshot){const captured=snapshot;native={header:captured.header,events:(async function*(){yield* captured.events;})()};}
      else{if(!this.readNativeAgentSessionStream)throw Error('Native backup stream is unavailable');native=await this.readNativeAgentSessionStream(largest);}
      if(!nativeSessionHeadersEqual(native.header,largest.header))throw Error('Portable native header differs');
      const tails=new Map<number,TaskMaterialRef|undefined>([[0,undefined]]);let count=0,events:unknown[]=[],tail:TaskMaterialRef|undefined;
      const flush=async()=>{if(!events.length)return;tail=await put({kind:'agent-session-events-v1',sessionId:largest.sessionId,start:count-events.length,events,...(tail?{previous:tail}:{})});events=[];};
      for await(const event of native.events){if((event as {seq?:number})?.seq!==count)throw Error('Portable native event sequence is invalid');events.push(event);count++;if(events.length===64||wanted.has(count))await flush();if(wanted.has(count))tails.set(count,tail);}
      await flush();if(count!==largest.eventCount)throw Error('Portable native event watermark differs');
      const spills=new Map<string,TaskMaterialRef>();
      for(const record of ordered){
        const reference=record.native as NativeSessionReference,prefix=prefixes.get(reference.eventCount)!;
        const original={kind:'dsh-original-jsonl-prefix-v1',sessionId:reference.sessionId,eventCount:reference.eventCount,encoding:'utf8',...prefix},originalKey=nativeOriginalKey(reference),previous=this.object<any>('nativeOriginals',originalKey);
        // Chunk boundaries are storage details; the immutable identity is the
        // exact byte prefix, not how a previous backup partitioned those bytes.
        if(previous&&['kind','sessionId','eventCount','encoding','bytes','hash'].some(key=>previous[key]!==original[key as keyof typeof original]))throw Error('Native original immutable prefix changed');
        this.putObject('nativeOriginals',originalKey,original);
        let old=record.materialRef?(await this.readTaskMaterials([record.materialRef]))[0]?.value:undefined;
        if(!old||!('kind'in old)||old.kind!=='agent-session-manifest-v1'){
          await resolveStorageMaterials([record],this.readTaskMaterials.bind(this));
          const prepared=await prepareStorageChanges({id:'portable-native',collections:{agentSessions:{put:[record as never]}}});
          for(const body of prepared.taskMaterials??[])this.putObject('taskMaterials',body.key,body);
          const ref=(prepared.collections.agentSessions!.put![0] as any).materialRef;old=this.object<TaskMaterialBody>('taskMaterials',ref.key)?.value;
        }
        if(!old||!('kind'in old)||old.kind!=='agent-session-manifest-v1')throw Error('Portable native domain manifest is invalid');
        const spillBodyRefs:TaskMaterialRef[]=[];
        for(const entry of reference.spills??[]){const key=JSON.stringify([entry.locator,entry.hash,entry.bytes]);let ref=spills.get(key);
          if(!ref){if(!this.readNativeAgentSpills)throw Error('Native spill backup stream is unavailable');let found=false;
            for await(const body of this.readNativeAgentSpills({...reference,spills:[entry]})){if(found||body.locator!==entry.locator||body.hash!==entry.hash||body.bytes!==entry.bytes)throw Error('Portable native spill identity differs');let text='';for await(const part of body.text)text+=part;ref=await put({...body,text});found=true;}
            if(!ref)throw Error('Portable native spill is missing');spills.set(key,ref);
          }spillBodyRefs.push(ref);
        }
        const tail=tails.get(reference.eventCount),manifest={...old,header:reference.header,eventCount:reference.eventCount,...(tail?{tail}:{}),...(spillBodyRefs.length?{spillBodyRefs}:{})};if(!tail)delete manifest.tail;
        const materialRef=await put(manifest);const {material:_,...metadata}=record;
        this.database.prepare("UPDATE entities SET json=? WHERE collection='agentSessions' AND key=?").run(this.content.encode({...metadata,materialRef}),record.id);
      }
    }
  }
  /** Portable rows remain encoded; no whole-archive material expansion. */
  *portableRows():Generator<{table:string;values:unknown[]}>{
    const avatarIds=new Set([...this.database.prepare("SELECT json FROM entities WHERE collection='partners'").iterate()].flatMap(row=>{const partner=this.content.decode(String(row.json));return partner.avatar?.kind==='image'?[partner.avatar.assetId]:[];}));
    this.portableRoots=new Set();
    // Export the closure of retained state and history. Old unreferenced task
    // snapshots remain on disk, but do not inflate every future backup.
    const taskKeys=new Set<string>(),pending:string[]=[];
    const scan=(value:any):void=>{if(!value||typeof value!=='object')return;
      if(typeof value.key==='string'&&/^task-material-[a-f0-9]{64}$/.test(value.key)&&typeof value.hash==='string'&&Number.isSafeInteger(value.bytes)){validateTaskMaterialRef(value);if(!taskKeys.has(value.key)){taskKeys.add(value.key);pending.push(value.key);}}
      for(const item of Object.values(value))scan(item);
    };
    for(const table of ['head','entities','observation_entries'])for(const row of this.database.prepare('SELECT json FROM '+table).iterate())scan(this.content.decode(String(row.json)));
    for(const row of this.database.prepare("SELECT json FROM objects WHERE bucket NOT IN ('taskMaterials','state','texts')").iterate())scan(this.content.decode(String(row.json)));
    while(pending.length){const key=pending.pop()!,value=this.object('taskMaterials',key);if(!value)throw Error('Portable task closure has a missing object');scan(value);}
    const columns:Record<string,string[]>= {head:['id','json'],entities:['collection','key','ordering','json'],objects:['bucket','key','json'],observation_entries:['kind','key','ordering','json'],text_meta:['version','length','chunk_chars'],text_chunks:['version','idx','json']};
    for(const [table,keys]of Object.entries(columns))for(const row of this.database.prepare('SELECT '+keys.join(',')+' FROM '+table).iterate()){
      if(table==='objects'&&['state','texts'].includes(String(row.bucket)))continue;
      if(table==='objects'&&row.bucket==='partnerAvatars'&&!avatarIds.has(String(row.key)))continue;
      if(table==='objects'&&row.bucket==='taskMaterials'&&!taskKeys.has(String(row.key)))continue;
      // Legacy ordinary-user rows enter the new representation only in this
      // isolated snapshot, leaving the source archive untouched.
      if(keys.includes('json')){const value=this.content.decode(String(row.json));if(table==='head'){delete value.secrets;delete value.exportedAt;delete value.storageOrder;}row.json=this.content.encode(value);for(const hash of this.content.references(String(row.json)))this.portableRoots.add(hash);}
      yield{table,values:keys.map(key=>row[key])};
    }
  }
  portableObjects(){if(!this.portableRoots)throw Error('Portable records must precede their object closure');return this.content.objects(this.portableRoots);}
  readPortableNativeOriginalManifest(reference:NativeSessionReference):PortableNativeOriginal{
    const original=this.object<PortableNativeOriginal>('nativeOriginals',nativeOriginalKey(reference));
    if(!original||original.kind!=='dsh-original-jsonl-prefix-v1'||original.sessionId!==reference.sessionId||original.eventCount!==reference.eventCount||original.encoding!=='utf8'||!Number.isSafeInteger(original.bytes)||original.bytes<1||!/^[a-f0-9]{64}$/.test(original.hash)||!Array.isArray(original.chunks)||original.chunks.some(chunk=>!/^[a-f0-9]{64}$/.test(chunk.hash)||!Number.isSafeInteger(chunk.bytes)||chunk.bytes<1))throw Error('Portable native original byte manifest is missing or invalid');
    return original;
  }
  async *readPortableNativeOriginal(reference:NativeSessionReference):AsyncGenerator<Uint8Array>{
    const original=this.readPortableNativeOriginalManifest(reference);
    const digest=createHash('sha256');let count=0;
    for(const ref of original.chunks){const chunk=this.object<any>('nativeByteChunks',ref.hash);if(!chunk||typeof chunk.base64!=='string')throw Error('Portable native original byte block is missing');const bytes=Buffer.from(chunk.base64,'base64');
      if(bytes.toString('base64')!==chunk.base64||bytes.length!==ref.bytes||chunk.bytes!==ref.bytes||chunk.hash!==ref.hash||createHash('sha256').update(bytes).digest('hex')!==ref.hash)throw Error('Portable native original byte block is corrupt');digest.update(bytes);count+=bytes.length;yield bytes;
    }
    if(count!==original.bytes||digest.digest('hex')!==original.hash)throw Error('Portable native original prefix hash or length mismatch');
  }
  importPortableObject(value:ContentObject){this.content.put(value);}
  importPortableRow(row:{table:string;values:unknown[]}){
    const widths:Record<string,number>={head:2,entities:4,objects:3,observation_entries:4,text_meta:3,text_chunks:3};
    if(!row||!Object.hasOwn(widths,row.table)||!Array.isArray(row.values)||row.values.length!==widths[row.table]||row.values.some(value=>typeof value!=='string'&&typeof value!=='number'))throw Error('Portable storage row is invalid');
    this.database.prepare('INSERT INTO '+row.table+' VALUES('+row.values.map(()=>'?').join(',')+')').run(...row.values as (string|number)[]);
  }
  validatePortableRows(){
    for(const row of this.portableRows())if(row.table==='entities'){
      const [name,key,,text]=row.values,record=this.content.decode(String(text));if(!(stateCollections as readonly unknown[]).includes(name)||stateRecordKey(name as never,record)!==key)throw Error('Portable entity identity is invalid');
    }
  }
  exportHead(): Record<string,unknown> {
    const row=this.database.prepare('SELECT json FROM head WHERE id=1').get();if(!row)throw Error('存档资料头缺失');
    const head=this.content.decode(String(row.json));delete head.storageOrder;delete head.secrets;return head;
  }
  *exportEntities(collection:string):Generator<Record<string,any>> {
    if(!(stateCollections as readonly string[]).includes(collection))throw Error('未知实体集合');
    for(const row of this.database.prepare('SELECT json FROM entities WHERE collection=? ORDER BY ordering').iterate(collection))yield this.content.decode(String(row.json));
  }
  /** Raw normal-IDB transfer. Used only in an unpublished staging directory. */
  async importBrowserRecord(store: string, key: unknown, value: any) {
    return this.queue(async () => {
      if (store === 'head' && key === 'current') this.database.prepare('INSERT INTO head VALUES(1,?)').run(this.content.encode(value));
      else if (store === 'entities') {
        if (!Array.isArray(key) || !(stateCollections as readonly string[]).includes(value.collection) || key[0] !== value.collection || stateRecordKey(value.collection, value.value) !== key[1]) throw Error('迁移实体身份不符');
        this.database.prepare('INSERT INTO entities VALUES(?,?,?,?)').run(value.collection, String(key[1]), value.order, JSON.stringify(value.value));
      } else if (store === 'textMeta') {
        if (value.version !== key || value.chunkChars !== chunkChars) throw Error('迁移原文元数据不符');
        this.database.prepare('INSERT INTO text_meta VALUES(?,?,?)').run(value.version, value.length, value.chunkChars);
      } else if (store === 'textChunks') {
        if (!Array.isArray(key) || await hashText(value.text) !== value.hash) throw Error('迁移原文块校验失败');
        this.database.prepare('INSERT INTO text_chunks VALUES(?,?,?)').run(String(key[0]), Number(key[1]), this.content.encode(value));
      } else if (['memoryBodies', 'taskMaterials', 'memoryIndex', 'observations', 'state', 'texts'].includes(store)) {
        if (store === 'memoryBodies' && (key !== value.key || await hashText(value.text) !== value.hash)) throw Error('迁移认识正文不符');
        if (store === 'taskMaterials' && (key !== value.key || await hashText(JSON.stringify(value.value)) !== value.hash)) throw Error('迁移任务材料不符');
        this.putObject(store, String(key), value);
      } else if (!(store === 'head' && key === 'authority')) throw Error('未知的迁移资料集合');
    });
  }
  async validateBrowserImport() {
    await this.flush();
    if (!this.database.prepare('SELECT 1 FROM head').get()) {
      const legacy = this.object<State>('state', 'current'); if (!legacy) throw Error('原存档没有权威资料，未建立空档');
      for (const book of legacy.books) if (!book.text) book.text = this.object<string>('texts', book.version) ?? this.object<string>('texts', book.id + ':' + book.version) ?? '';
      await this.save(legacy);
      this.database.prepare("DELETE FROM objects WHERE bucket IN ('state','texts')").run();
    }
    const state = await this.load(); if (!state) throw Error('原存档缺少权威资料头，未发布空档');
    for (const book of state.books) {
      const text = await this.readBookText(book.version);
      if (book.textLength !== text.length) throw Error('迁移原文长度不符');
    }
    for (let i = 0; i < state.memories.length; i += 64) {
      const refs = state.memories.slice(i, i + 64).flatMap(m => m.bodyRef ? [m.bodyRef] : []);
      if ((await this.readMemoryBodies(refs)).length !== refs.length) throw Error('迁移认识正文缺失');
    }
    // Validate references and linked session chunks without retaining all task bodies together.
    const checked=new Map<string,{hash:string;bytes:number;kind?:string;sourceValid:boolean;start?:number;count?:number;sessionId?:string;previous?:TaskMaterialRef}>();
    const pending:{ref:TaskMaterialRef;source?:boolean;migrationSource?:boolean;chain?:{sessionId:string;end:number}}[]=storageMaterialOwners(state).flatMap(owner=>owner.materialRef?[{ref:owner.materialRef}]:[]);
    while(pending.length){
      const {ref,chain,source,migrationSource}=pending.pop()!;validateTaskMaterialRef(ref);let summary=checked.get(ref.key);
      if(!summary){
        const body=(await this.readTaskMaterials([ref]))[0];if(!body)throw Error('迁移任务正文引用缺失或身份不符');
        const value=body.value as any,bytes=new TextEncoder().encode(JSON.stringify(value)).length;
        summary={hash:body.hash,bytes,kind:value.kind,sourceValid:!value.kind&&Array.isArray(value.messages)&&!!value.references&&typeof value.references==='object'&&!Array.isArray(value.references)&&Array.isArray(value.ranges)&&Array.isArray(value.webSources)&&Array.isArray(value.readUrls)};
        if(value.kind==='agent-session-manifest-v1'){
          if(!Number.isSafeInteger(value.eventCount)||value.eventCount<0||!!value.tail!==(value.eventCount>0)||typeof value.header?.id!=='string')throw Error('迁移原生事件清单无效');
          pending.push({ref:value.sources,source:true});if(value.tail)pending.push({ref:value.tail,chain:{sessionId:value.header.id,end:value.eventCount}});
          if(value.migrationSourceRef)pending.push({ref:value.migrationSourceRef,migrationSource:true});
          for(const ref of value.spillBodyRefs??[])pending.push({ref});if(value.inheritedMaterialRef)pending.push({ref:value.inheritedMaterialRef,source:true});
        }else if(value.kind==='agent-session-events-v1'){
          if(!Array.isArray(value.events)||!value.events.length||!Number.isSafeInteger(value.start)||value.start<0||value.events.some((event:any,index:number)=>event.seq!==value.start+index))throw Error('迁移原生事件分块不连续');
          Object.assign(summary,{start:value.start,count:value.events.length,sessionId:value.sessionId,previous:value.previous});
        }
        checked.set(ref.key,summary);
      }
      if(summary.hash!==ref.hash||summary.bytes!==ref.bytes)throw Error('迁移任务正文引用摘要或长度不符');
      if(source&&!summary.sourceValid)throw Error('迁移原会话来源字典缺失或格式不符');
      if(migrationSource&&summary.kind!=='agent-session-migration-source-v1')throw Error('迁移源原件类型不符');
      if(summary.kind==='agent-session-events-v1'){
        if(!chain||summary.sessionId!==chain.sessionId||(summary.start! + summary.count!)!==chain.end)throw Error('迁移事件前缀与清单不符');
        if(summary.previous)pending.push({ref:summary.previous,chain:{sessionId:chain.sessionId,end:summary.start!}});else if(summary.start!==0)throw Error('迁移事件前缀缺失');
      }
    }
    await this.flush(); return {books: state.books.map(b => ({id: b.id, version: b.version, position: b.position})), agentSessions: state.agentSessions?.length ?? 0};
  }
  async close() { await this.writing.catch(()=>{}); this.closed = true; await this.preparation.close();this.database.close(); }
}
