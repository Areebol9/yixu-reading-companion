import {brotliCompressSync,brotliDecompressSync,constants} from 'node:zlib';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {join} from 'node:path';

const compressed='!yixu/brotli-text/v1\n';
export const receiptFrame='!yixu/receipt-text/v1\n';
export const textDigest=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex');
/** Framed data is used only inside storage envelopes, never in user strings. */
export function packStoredText(text:string):string{
 if(text.length<512)return text;
 const packed=compressed+brotliCompressSync(Buffer.from(text),{params:{[constants.BROTLI_PARAM_QUALITY]:4}}).toString('base64');
 return packed.length<text.length?packed:text;
}
export function unpackStoredText(data:string):string{
 return data.startsWith(compressed)?brotliDecompressSync(Buffer.from(data.slice(compressed.length),'base64')).toString('utf8'):data;
}
/** One immutable compressed original shared by domain records and the HTTP ledger.
 * References are hashes only; the host supplies the private store directory. */
export class ReceiptTexts{
 constructor(readonly directory:string){}
 private path(hash:string){if(!/^[a-f0-9]{64}$/.test(hash))throw Error('Invalid receipt object hash');return join(this.directory,hash+'.br');}
 put(text:string):string{
  const hash=textDigest(text),path=this.path(hash);
  try{this.get(hash);return hash;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  mkdirSync(this.directory,{recursive:true});
  const bytes=brotliCompressSync(Buffer.from(text,'utf8'),{params:{[constants.BROTLI_PARAM_QUALITY]:4}});
  try{const fd=openSync(path,'wx');try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;this.get(hash);}
  return hash;
 }
 get(hash:string):string{
  const value=brotliDecompressSync(readFileSync(this.path(hash))).toString('utf8');
  if(textDigest(value)!==hash)throw Error('Receipt original is corrupt');return value;
 }
}
