import {createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import {NodeStore} from './node-store.ts';
import {JsonFileWriter} from './json-stream.ts';
import {readJsonFile} from './json-reader.ts';
import {bindVerifiedContentTransfer} from '../core/content-object-transfer.ts';
import {hydrateMemoryBodies} from '../core/memory-bodies.ts';
import {resolveStorageMaterials} from '../core/storage-records.ts';
import {decodeAgentSession,decodeAgentSessionSources} from '../core/agent-session-storage.ts';
import {nativeSessionHeadersEqual} from '../core/agent-port.ts';
import {materializeCreateHeader} from '@deepseek-ai/dsh-session-persistence';
import {validateProductSessionEvents} from '../agent/native-session-format.ts';
import type {SessionHeader,SessionEvent} from '@deepseek-ai/dsh-session';
import type {ContentObject} from './content-objects.ts';
import type {State,TaskMaterialRef,TaskMaterialBody} from '../core/types.ts';
import {verifyNativePrefixBytes} from './content-object-native.ts';

export const portableSchema='yixu-portable-content/v1';
const proofItem=(digest:ReturnType<typeof createHash>,kind:string,value:unknown)=>digest.update(JSON.stringify([kind,value])+'\n');

/** The snapshot is private to this export. Content rows are produced before the
 * object table so legacy JSON can be normalized without changing the source. */
export async function writePortableBackup(writer:JsonFileWriter,store:NodeStore){
  await store.preparePortableNativeSessions();
  const digest=createHash('sha256');let records=0,objects=0;
  await writer.raw('{"schema":'+JSON.stringify(portableSchema)+',"records":');
  await writer.array(store.portableRows(),async row=>{proofItem(digest,'record',row);records++;await writer.value(row);});
  await writer.raw(',"objects":');
  await writer.array(store.portableObjects(),async object=>{proofItem(digest,'object',object);objects++;await writer.value(object);});
  await writer.raw(',"manifest":');await writer.value({records,objects,sha256:digest.digest('hex')});await writer.raw('}');
}

export async function isPortableBackup(filename:string){
  const file=await open(filename,'r');try{const bytes=Buffer.alloc(256),{bytesRead}=await file.read(bytes,0,bytes.length,0);return /^\s*\{\s*"schema"\s*:\s*"yixu-portable-content\/v1"\s*,/.test(bytes.subarray(0,bytesRead).toString('utf8'));}finally{await file.close();}
}

/** A parser item is committed to a still-unpublished SQLite staging store and
 * then discarded. A missing/corrupt block never reaches archive publication. */
export async function readPortableBackup(filename:string,store:NodeStore,onEntity?:(collection:string,count:number)=>void):Promise<State>{
  if(await store.load())throw Error('Portable import requires an empty isolated staging store');
  const digest=createHash('sha256');let records=0,objects=0,sawObjects=false;
  const parsed=await readJsonFile(filename,onEntity,async(collection,item)=>{
    if(collection==='records'){if(sawObjects)throw Error('Portable record order is invalid');store.importPortableRow(item as never);proofItem(digest,'record',item);records++;return false;}
    if(collection==='objects'){sawObjects=true;store.importPortableObject(item as ContentObject);proofItem(digest,'object',item);objects++;return false;}
    throw Error('Portable backup contains an unexpected collection');
  }) as {schema?:unknown;manifest?:{records:number;objects:number;sha256:string};records:unknown[];objects:unknown[]};
  const manifest=parsed?.manifest,hash=digest.digest('hex');
  if(parsed?.schema!==portableSchema||Object.keys(parsed).some(key=>!['schema','records','objects','manifest'].includes(key))||!Array.isArray(parsed.records)||!Array.isArray(parsed.objects)||!manifest||manifest.records!==records||manifest.objects!==objects||manifest.sha256!==hash)throw Error('Portable manifest hash or object count mismatch');
  store.validatePortableRows();await store.validateBrowserImport();
  const state=await store.load();if(!state)throw Error('Portable backup has no authoritative state');
  // Preserve the existing full domain validation; only private execution bodies
  // are streamed. Book text and current domain records still occupy memory.
  for(const book of state.books)book.text=await store.readBookText(book.version);
  await hydrateMemoryBodies(store,state.memories);
  const groups=new Map<string,NonNullable<State['agentSessions']>>();
  for(const record of state.agentSessions??[])if(record.native){const key=JSON.stringify([record.native.sessionId,record.native.header]),group=groups.get(key);if(group)group.push(record);else groups.set(key,[record]);}
  for(const group of groups.values()){
    // This cache lives only for this validated archive and native generation.
    // Shared immutable source/event blocks are read and hash-checked once.
    const bodies=new Map<string,{ref:TaskMaterialRef;body:TaskMaterialBody}>();
    const read=async(ref:TaskMaterialRef)=>{const known=bodies.get(ref.key);if(known){if(known.ref.hash!==ref.hash||known.ref.bytes!==ref.bytes)throw Error('Portable shared material reference differs');return known.body;}const found=await store.readTaskMaterials([ref]);if(found.length!==1)throw Error('Portable native material is missing');bodies.set(ref.key,{ref,body:found[0]});return found[0];};
    const ordered=[...group].sort((a,b)=>b.native!.eventCount-a.native!.eventCount),largest=ordered[0];
    if(!largest.materialRef){
      // Old inline carriers retain the original complete validation path.
      for(const record of ordered)try{await resolveStorageMaterials([record],readRefs=>Promise.all(readRefs.map(read)));const snapshot=record.material!.snapshot;if(snapshot.events.length!==record.native!.eventCount||!nativeSessionHeadersEqual(snapshot.header,record.native!.header))throw Error('Portable native prefix is inconsistent');validateProductSessionEvents(materializeCreateHeader(snapshot.header as SessionHeader),snapshot.events as SessionEvent[]);await verifyNativePrefixBytes(store.readPortableNativeOriginal(record.native!),snapshot);}finally{delete record.material;}
      continue;
    }
    const loadManifest=async(record:typeof largest)=>{if(!record.materialRef)throw Error('Portable native manifest is missing');const body=await read(record.materialRef),manifest=body.value;if(!('kind'in manifest)||manifest.kind!=='agent-session-manifest-v1'||manifest.eventCount!==record.native!.eventCount||!nativeSessionHeadersEqual(manifest.header,record.native!.header)||typeof manifest.dependencyStamp!=='string'||!!manifest.tail!==(manifest.eventCount>0))throw Error('Portable native prefix is inconsistent');return{ref:record.materialRef,body,manifest};};
    const full=await loadManifest(largest),material=await decodeAgentSession(full.manifest,full,read),snapshot=material.snapshot;
    validateProductSessionEvents(materializeCreateHeader(snapshot.header as SessionHeader),snapshot.events as SessionEvent[]);
    const tails=new Map<number,TaskMaterialRef|undefined>([[0,undefined]]);let cursor=full.manifest.eventCount,tail=full.manifest.tail;
    while(tail){tails.set(cursor,tail);const chunk=(await read(tail)).value;if(!('kind'in chunk)||chunk.kind!=='agent-session-events-v1')throw Error('Portable native event block is invalid');cursor=chunk.start;tail=chunk.previous;}
    const original=store.readPortableNativeOriginalManifest(largest.native!),prefixes=new Map<number,{bytes:number;hash:string}>(),fallback:typeof ordered=[];
    const inheritedEnd=snapshot.events.findIndex(event=>(event as {type?:string;data?:{inherited?:boolean}}).type==='session/end-seed'&&(event as {data?:{inherited?:boolean}}).data?.inherited===true);
    for(const record of ordered){
      const saved=record===largest?full:await loadManifest(record),native=record.native!,raw=store.readPortableNativeOriginalManifest(native),expected=tails.get(native.eventCount);
      const shared=tails.has(native.eventCount)&&saved.manifest.tail?.key===expected?.key&&saved.manifest.tail?.hash===expected?.hash&&saved.manifest.tail?.bytes===expected?.bytes&&raw.chunks.length<=original.chunks.length&&raw.chunks.every((chunk,index)=>chunk.hash===original.chunks[index].hash&&chunk.bytes===original.chunks[index].bytes)&&(!(snapshot.header as {isSeeded?:boolean}).isSeeded||native.eventCount>inheritedEnd);
      if(!shared){fallback.push(record);continue;}
      // The highest prefix proves these exact event blocks. Validate each
      // task's own sources without allocating its whole earlier events array.
      if(record!==largest)await decodeAgentSessionSources(saved.manifest,read);
      const prior=prefixes.get(native.eventCount);if(prior&&(prior.bytes!==raw.bytes||prior.hash!==raw.hash))throw Error('Portable tasks disagree on the same native prefix');
      prefixes.set(native.eventCount,{bytes:raw.bytes,hash:raw.hash});
    }
    await verifyNativePrefixBytes(store.readPortableNativeOriginal(largest.native!),snapshot,prefixes);
    for(const record of fallback){const saved=await loadManifest(record),older=(await decodeAgentSession(saved.manifest,saved,read)).snapshot;validateProductSessionEvents(materializeCreateHeader(older.header as SessionHeader),older.events as SessionEvent[]);await verifyNativePrefixBytes(store.readPortableNativeOriginal(record.native!),older);}
    for(const record of ordered)delete record.material;
  }
  const metadata=await store.loadObservations<Record<string,unknown>>();
  if(metadata)(state as unknown as Record<string,unknown>).workbenchMetadata={schema:'yixu-workbench-metadata/v1',...metadata};
  bindVerifiedContentTransfer(state,{manifestHash:hash,store:{readTaskMaterials:store.readTaskMaterials.bind(store),readMemoryBodies:store.readMemoryBodies.bind(store),readPartnerAvatar:store.readPartnerAvatar.bind(store)}});return state;
}
