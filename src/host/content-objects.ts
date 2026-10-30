import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {packStoredText,unpackStoredText,ReceiptTexts,receiptFrame} from './stored-text.ts';

const frame='!yixu/content-tree/v1\n';
export type ContentObject={hash:string;bytes:number;format:'json-string-v1'|'json-tree-v1';data:string};
type Node=['v',unknown]|['a',Node[]]|['o',[string,Node][]]|['r',Omit<ContentObject,'data'>];
export type PreparedContent={json:string;objects:ContentObject[]};
export type ContentPreparationCache=WeakMap<object,{node:Node;objects:ContentObject[]}>;
export function contentHash(format:ContentObject['format'],data:string){return createHash('sha256').update(format+'\0').update(data).digest('hex');}

/** Pure preparation, also used by the storage worker. No SQLite writer is held
 * while serializing, hashing, compressing or saving immutable receipt files. */
export function prepareContent(value:unknown,receipts?:ReceiptTexts,cache?:ContentPreparationCache):PreparedContent{
  const objects=new Map<string,ContentObject>();
  const object=(format:ContentObject['format'],data:string,wire=false):Node=>{
    const ref={hash:contentHash(format,data),bytes:Buffer.byteLength(data),format};
    objects.set(ref.hash,{...ref,data:wire&&receipts?receiptFrame+receipts.put(JSON.parse(data)):packStoredText(data)});
    return ['r',ref];
  };
  const visit=(value:any,key?:string):Node=>{
    if(key==='formationSources'&&value?.kind==='formation-sources-v1'){
      const saved=cache?.get(value);if(saved){for(const item of saved.objects)objects.set(item.hash,item);return saved.node;}
      const normalized=JSON.parse(JSON.stringify(value));
      const tree:Node=['o',Object.entries(normalized).map(([name,item])=>[name,visit(item,name)])];
      const node=object('json-tree-v1',JSON.stringify(tree));cache?.set(value,{node,objects:[...objects.values()]});return node;
    }
    if(typeof value==='string'&&value.length>=512)return object('json-string-v1',JSON.stringify(value),key==='rawBody');
    if(!value||typeof value!=='object')return ['v',value];
    const tree:Node=Array.isArray(value)?['a',value.map(item=>visit(item))]:['o',Object.entries(value).map(([key,item])=>[key,visit(item,key)])];
    const text=JSON.stringify(tree);return text.length>=2048?object('json-tree-v1',text):tree;
  };
  // Formation audits retain their immutable shared identity for batch caching;
  // ordinary values keep JSON's undefined/NaN/toJSON normalization semantics.
  let literal:any;
  if(value&&typeof value==='object'&&(value as any).formationSources?.kind==='formation-sources-v1'&&!('toJSON'in value)){
    const {formationSources,...metadata}=value as any;literal=JSON.parse(JSON.stringify(metadata));literal.formationSources=formationSources;
  }else literal=JSON.parse(JSON.stringify(value));
  return {json:frame+JSON.stringify(visit(literal)),objects:[...objects.values()]};
}

/** The non-JSON frame distinguishes storage envelopes from every legacy JSON
 * value. All user objects are tagged literal nodes, including marker lookalikes. */
export class ContentObjects {
  private verified=new Map<string,string>();
  private formationAudits=new Map<string,unknown>();
  constructor(private db:DatabaseSync,private receipts?:ReceiptTexts){db.exec('CREATE TABLE IF NOT EXISTS content_objects(hash TEXT PRIMARY KEY,bytes INTEGER NOT NULL,format TEXT NOT NULL,data TEXT NOT NULL)');}
  private unpack(data:string):string{
    if(data.startsWith(receiptFrame)){if(!this.receipts)throw Error('Receipt original store is unavailable');return JSON.stringify(this.receipts.get(data.slice(receiptFrame.length)));}
    return unpackStoredText(data);
  }
  put(object:ContentObject,wire=false){
    object={...object,data:this.unpack(object.data)};
    if(!['json-string-v1','json-tree-v1'].includes(object.format)||!Number.isSafeInteger(object.bytes)||object.bytes<0||Buffer.byteLength(object.data)!==object.bytes||contentHash(object.format,object.data)!==object.hash)throw Error('Content object hash or byte length mismatch');
    this.store(object,wire);
  }
  private store(object:ContentObject,wire:boolean){
    const old=this.db.prepare('SELECT bytes,format,data FROM content_objects WHERE hash=?').get(object.hash);
    if(old){const data=this.unpack(String(old.data));if(old.bytes!==object.bytes||old.format!==object.format||Buffer.byteLength(data)!==object.bytes||contentHash(object.format,data)!==object.hash)throw Error('Immutable content object conflict');return;}
    const data=wire&&this.receipts?receiptFrame+this.receipts.put(JSON.parse(object.data)):packStoredText(object.data);
    this.db.prepare('INSERT INTO content_objects VALUES(?,?,?,?)').run(object.hash,object.bytes,object.format,data);
  }
  encode(value:unknown):string{
    const prepared=prepareContent(value,this.receipts);this.verifyPrepared(prepared.objects);this.installPrepared(prepared.objects);return prepared.json;
  }
  /** Objects come from our preparation worker. Conflict checks and decoding are
   * performed before BEGIN; install only publishes already prepared bytes. */
  verifyPrepared(objects:readonly ContentObject[]){
    for(const object of objects){
      const old=this.db.prepare('SELECT bytes,format,data FROM content_objects WHERE hash=?').get(object.hash);
      if(old){const stored=String(old.data);if(this.verified.get(object.hash)===stored&&old.bytes===object.bytes&&old.format===object.format)continue;const data=this.unpack(stored);if(old.bytes!==object.bytes||old.format!==object.format||Buffer.byteLength(data)!==object.bytes||contentHash(object.format,data)!==object.hash)throw Error('Immutable content object conflict');this.verified.set(object.hash,stored);}
    }
  }
  installPrepared(objects:readonly ContentObject[]){
    const put=this.db.prepare('INSERT INTO content_objects VALUES(?,?,?,?) ON CONFLICT(hash) DO NOTHING');
    for(const object of objects)put.run(object.hash,object.bytes,object.format,object.data);
  }
  decode(text:string):any{
    if(!text.startsWith(frame))return JSON.parse(text);
    const active=new Set<string>();
    const visit=(node:Node,key?:string):any=>{
      if(!Array.isArray(node)||node.length!==2)throw Error('Content tree node is invalid');
      if(node[0]==='v'){if(node[1]!==null&&typeof node[1]==='object')throw Error('Content literal must be scalar');return node[1];}
      if(node[0]==='a'){if(!Array.isArray(node[1]))throw Error('Content array is invalid');return node[1].map(value=>visit(value));}
      if(node[0]==='o'){
        if(!Array.isArray(node[1]))throw Error('Content object is invalid');const result:Record<string,unknown>={};
        for(const entry of node[1]){if(!Array.isArray(entry)||entry.length!==2||typeof entry[0]!=='string'||Object.hasOwn(result,entry[0]))throw Error('Content property is invalid');Object.defineProperty(result,entry[0],{value:visit(entry[1],entry[0]),enumerable:true,writable:true,configurable:true});}return result;
      }
      if(node[0]!=='r')throw Error('Content tree tag is invalid');
      const ref=node[1];if(!ref||!/^[a-f0-9]{64}$/.test(ref.hash)||active.has(ref.hash))throw Error('Content reference is invalid or cyclic');
      if(key==='formationSources'&&this.formationAudits.has(ref.hash))return this.formationAudits.get(ref.hash);
      const row=this.db.prepare('SELECT bytes,format,data FROM content_objects WHERE hash=?').get(ref.hash);
      const data=row?this.unpack(String(row.data)):undefined;
      if(!row||data===undefined||row.bytes!==ref.bytes||row.format!==ref.format||Buffer.byteLength(data)!==ref.bytes||contentHash(ref.format,data)!==ref.hash)throw Error('Content object missing or corrupt: '+ref.hash);
      active.add(ref.hash);try{const parsed=JSON.parse(data);if(ref.format==='json-string-v1'){if(typeof parsed!=='string')throw Error('Content string is invalid');return parsed;}if(ref.format!=='json-tree-v1')throw Error('Content format is invalid');const result=visit(parsed);if(key==='formationSources'){const freeze=(value:any):void=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value);}};freeze(result);this.formationAudits.set(ref.hash,result);}return result;}finally{active.delete(ref.hash);}
    };return visit(JSON.parse(text.slice(frame.length)));
  }
  references(text:string):string[]{return text.startsWith(frame)?this.treeReferences(JSON.parse(text.slice(frame.length))):[];}
  private treeReferences(root:Node):string[]{
    const refs:string[]=[],pending=[root];while(pending.length){const node=pending.pop()!;if(node[0]==='r')refs.push(node[1].hash);else if(node[0]==='a')pending.push(...node[1]);else if(node[0]==='o')for(const [,value]of node[1])pending.push(value);}return refs;
  }
  *objects(roots?:Iterable<string>):Generator<ContentObject>{
    if(!roots){for(const row of this.db.prepare('SELECT hash,bytes,format,data FROM content_objects ORDER BY hash').iterate())yield {...row,data:packStoredText(this.unpack(String(row.data)))} as ContentObject;return;}
    const seen=new Set<string>(),pending=[...roots];while(pending.length){const hash=pending.pop()!;if(seen.has(hash))continue;seen.add(hash);
      const row=this.db.prepare('SELECT hash,bytes,format,data FROM content_objects WHERE hash=?').get(hash) as ContentObject|undefined;if(!row)throw Error('Portable content closure has a missing object');
      const data=this.unpack(row.data);if(row.format==='json-tree-v1')pending.push(...this.treeReferences(JSON.parse(data)));yield {...row,data:packStoredText(data)};
    }
  }
}
