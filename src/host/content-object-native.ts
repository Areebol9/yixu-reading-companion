import {createReadStream} from 'node:fs';
import {readdir,realpath,stat} from 'node:fs/promises';
import {join,relative,isAbsolute,resolve} from 'node:path';
import {createZstdDecompress} from 'node:zlib';
import {createHash} from 'node:crypto';
import {productSessionFormatCatalog as sessionFormatCatalog} from '../agent/native-session-format.ts';
import type {NativeSessionReference,AgentSessionSnapshot} from '../core/agent-port.ts';
import {nativeSessionHeadersEqual} from '../core/agent-port.ts';

export type NativePrefixReader=(reference:NativeSessionReference,completed?:(snapshot:AgentSessionSnapshot)=>void)=>AsyncIterable<Uint8Array>;
type LogicalReader=(reference:NativeSessionReference)=>Promise<{header:unknown;events:AsyncIterable<unknown>}>;

/** Keep an unfinished row as fragments. Large tool/message rows are copied
 * once when complete, rather than once for every incoming byte block. */
export async function* nativeJsonlLines(bytes:AsyncIterable<Uint8Array>):AsyncGenerator<Buffer>{
  const fragments:Buffer[]=[];let length=0;
  for await(const part of bytes){const chunk=Buffer.from(part.buffer,part.byteOffset,part.byteLength);let start=0;
    for(let end=chunk.indexOf(10,start);end>=0;end=chunk.indexOf(10,start)){
      const tail=chunk.subarray(start,end+1);yield fragments.length?Buffer.concat([...fragments,tail],length+tail.length):tail;
      fragments.length=0;length=0;start=end+1;
    }
    if(start<chunk.length){const tail=chunk.subarray(start);fragments.push(tail);length+=tail.length;}
  }
  if(length)throw Error('Native JSONL physical row is incomplete');
}

/** Node 24 stops at the first zstd frame. Its public bytesWritten cursor lets
 * us advance to the next concatenated frame without a private frame parser. */
export async function* readNativeJsonlBytes(file:string):AsyncGenerator<Uint8Array>{
  const size=(await stat(file)).size;let offset=0;
  while(offset<size){
    const source=createReadStream(file,{start:offset,end:size-1,highWaterMark:32768}),plain=file.endsWith('.zstd')?source.pipe(createZstdDecompress()):source;
    if(plain!==source)source.on('error',error=>plain.destroy(error));
    try{for await(const chunk of plain)yield Buffer.from(chunk);if(plain===source)return;
      const consumed=(plain as ReturnType<typeof createZstdDecompress>).bytesWritten;if(!Number.isSafeInteger(consumed)||consumed<=0)throw Error('Native compressed frame made no progress');offset+=consumed;
    }finally{plain.destroy();source.destroy();}
  }
}

/** Read-only inventory of the archive-owned official v4 generation. No private
 * compression parser or writer is copied; Node decodes concatenated zstd frames
 * and the official catalog validates the original physical JSONL rows. */
export function createNativePrefixReader(root:string,read?:LogicalReader){
  let paths:Map<string,string>|undefined;
  const inventory=async()=>{
    const result=new Map<string,string>(),base=await realpath(root);if(relative(resolve(root),base)!=='')throw Error('Native archive root must not be a symbolic link');
    for(const project of await readdir(base,{withFileTypes:true}))if(project.isDirectory()&&!project.isSymbolicLink())for(const session of await readdir(join(base,project.name),{withFileTypes:true}))if(session.isDirectory()&&!session.isSymbolicLink()){
      // Official encodeSegment uses ~XXXX for unsafe UTF-16 code units.
      const id=session.name.replace(/~([0-9A-F]{4})/g,(_,hex:string)=>String.fromCharCode(parseInt(hex,16)));
      const files=(await readdir(join(base,project.name,session.name),{withFileTypes:true})).filter(file=>file.isFile()&&!file.isSymbolicLink()&&(file.name==='session.v4.jsonl'||file.name==='session.v4.jsonl.zstd')).map(file=>file.name);
      if(!files.length)continue;if(files.length!==1||result.has(id))throw Error('Native log generation is ambiguous');
      const path=await realpath(join(base,project.name,session.name,files[0])),part=relative(base,path);
      if(!part||part==='..'||part.startsWith('..\\')||part.startsWith('../')||isAbsolute(part))throw Error('Native log escapes its archive');result.set(id,path);
    }return paths=result;
  };
  return async function*(reference:NativeSessionReference,completed?:(snapshot:AgentSessionSnapshot)=>void){
    let file=(paths??await inventory()).get(reference.sessionId);if(!file)file=(await inventory()).get(reference.sessionId);if(!file)throw Error('Native original JSONL generation is missing');
    let lines=0,restore:ReturnType<typeof sessionFormatCatalog.createRestore>|undefined;
    {
      for await(const line of nativeJsonlLines(readNativeJsonlBytes(file))){
          const physical=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line.subarray(0,-1)));
          if(lines===0){restore=sessionFormatCatalog.createRestore(physical,{recovery:'strict',validation:'current'});if(!nativeSessionHeadersEqual(restore.header,reference.header))throw Error('Native original header differs');}
          else restore!.decodeRow(physical);
          lines++;yield line;
          if(lines===reference.eventCount+1)break;
      }
      if(lines!==reference.eventCount+1||!restore)throw Error('Native original JSONL prefix is incomplete: '+lines+' records for '+reference.eventCount+' events');
      const artifact=restore.finish();if(artifact.events.length!==reference.eventCount)throw Error('Native original event watermark differs');
      if(read){const logical=await read(reference);let index=0;
        for await(const event of logical.events){if(JSON.stringify(event)!==JSON.stringify(artifact.events[index++]))throw Error('Native original rows differ from the official fixed prefix');}
        if(index!==reference.eventCount)throw Error('Native original event watermark differs');
      }
      completed?.({header:structuredClone(reference.header),events:artifact.events as unknown[]});
    }
  };
}
/** Same strict application codec for a cold logical read of the exact byte prefix. */
export function createNativeFileSessionReader(root:string){
  const source=createNativePrefixReader(root);
  return async(reference:NativeSessionReference):Promise<AgentSessionSnapshot>=>{let snapshot:AgentSessionSnapshot|undefined;for await(const _ of source(reference,value=>{snapshot=value;})){/* Fully validate the immutable prefix before exposing it. */}if(!snapshot)throw Error('Native logical prefix is missing');return snapshot;};
}

/** Explicit continuation reuses the latest real DSH compaction result. Its
 * source permission remains the caller's domain responsibility. */
export function createNativeConversationCheckpointReader(root:string){
  const read=createNativeFileSessionReader(root);
  return async(reference:NativeSessionReference):Promise<{summary:string;summarySeq:number}|undefined>=>{
    const snapshot=await read(reference);
    for(let index=snapshot.events.length-1;index>=0;index--){const event=snapshot.events[index] as {type?:string;seq?:number;data?:{summary?:unknown}};
      if(event.type==='compaction/summary'&&typeof event.data?.summary==='string'&&event.data.summary.trim()&&Number.isSafeInteger(event.seq))return{summary:event.data.summary,summarySeq:event.seq!};
    }
  };
}

export async function verifyNativePrefixBytes(bytes:AsyncIterable<Uint8Array>,snapshot:AgentSessionSnapshot,prefixes?:ReadonlyMap<number,{bytes:number;hash:string}>){
  let count=0,restore:ReturnType<typeof sessionFormatCatalog.createRestore>|undefined;
  const digest=prefixes?createHash('sha256'):undefined,seen=new Set<number>();let byteCount=0;
  for await(const line of nativeJsonlLines(bytes)){
      const row=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line.subarray(0,-1)));
      if(count++===0)restore=sessionFormatCatalog.createRestore(row,{recovery:'strict',validation:'current'});else restore!.decodeRow(row);
      if(count>snapshot.events.length+1)throw Error('Native byte attachment contains events beyond its confirmed prefix');
      digest?.update(line);byteCount+=line.length;const expected=prefixes?.get(count-1);
      if(expected){if(byteCount!==expected.bytes||digest!.copy().digest('hex')!==expected.hash)throw Error('Native shared prefix byte hash or watermark differs');seen.add(count-1);}
  }
  if(!restore||count!==snapshot.events.length+1||!nativeSessionHeadersEqual(restore.header,snapshot.header))throw Error('Native byte attachment has a different header or incomplete prefix');
  if(prefixes&&seen.size!==prefixes.size)throw Error('Native shared prefix watermark is missing');
  const events=restore.finish().events;if(events.length!==snapshot.events.length)throw Error('Native byte attachment event count differs');
  for(let index=0;index<events.length;index++)if(JSON.stringify(events[index])!==JSON.stringify(snapshot.events[index]))throw Error('Native byte attachment differs from its official logical prefix');
}
