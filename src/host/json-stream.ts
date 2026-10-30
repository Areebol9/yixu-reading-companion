import {createWriteStream} from 'node:fs';
import {once} from 'node:events';
import {createHash} from 'node:crypto';

export class JsonFileWriter {
  private stream;
  private digest=createHash('sha256');
  private count=0;
  private failure?:Error;
  constructor(filename:string){this.stream=createWriteStream(filename,{flags:'wx',mode:0o600});this.stream.on('error',error=>{this.failure=error;});}
  async raw(text:string){if(this.failure)throw this.failure;const bytes=Buffer.from(text);this.digest.update(bytes);this.count+=bytes.length;if(!this.stream.write(bytes))await once(this.stream,'drain');}
  async stringParts(parts:AsyncIterable<string>|Iterable<string>){await this.raw('"');for await(const part of parts){for(let offset=0;offset<part.length;){let end=Math.min(part.length,offset+8192);if(end<part.length&&/[\uD800-\uDBFF]/.test(part[end-1]))end++;await this.raw(JSON.stringify(part.slice(offset,end)).slice(1,-1));offset=end;}}await this.raw('"');}
  async value(value:unknown):Promise<void>{
    if(value===null){await this.raw('null');return;}
    if(typeof value==='string'){await this.stringParts([value]);return;}
    if(Array.isArray(value)){await this.raw('[');for(let i=0;i<value.length;i++){if(i)await this.raw(',');await this.value(value[i]??null);}await this.raw(']');return;}
    if(typeof value==='object'){await this.object(value as Record<string,unknown>);return;}
    await this.raw(JSON.stringify(value)??'null');
  }
  async object(value:Record<string,unknown>,special:Record<string,()=>Promise<void>>={}){
    await this.raw('{');let first=true;
    for(const key of new Set([...Object.keys(value),...Object.keys(special)])){
      if(value[key]===undefined&&!special[key])continue;
      if(!first)await this.raw(',');first=false;await this.raw(JSON.stringify(key)+':');
      if(special[key])await special[key]();else await this.value(value[key]);
    }await this.raw('}');
  }
  async array(items:Iterable<unknown>|AsyncIterable<unknown>,write:(item:any)=>Promise<void>=(item)=>this.value(item)){await this.raw('[');let first=true;for await(const item of items){if(!first)await this.raw(',');first=false;await write(item);}await this.raw(']');}
  async finish(){if(this.failure)throw this.failure;if(this.stream.destroyed)throw Error('导出文件流已关闭');const finished=once(this.stream,'finish');this.stream.end();await finished;return{bytes:this.count,sha256:this.digest.digest('hex')};}
  abort(error:Error){this.stream.destroy(error);}
}
