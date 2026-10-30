import {createReadStream} from 'node:fs';

/** Parse one JSON token/entity at a time; never construct the full raw backup string. */
export async function readJsonFile(filename:string,onEntity?:(collection:string,count:number)=>void,onItem?:(collection:string,value:unknown,index:number)=>Promise<boolean|void>):Promise<unknown>{
  const stream=createReadStream(filename,{encoding:'utf8'}),source=stream[Symbol.asyncIterator]();let chunk='',index=0,ended=false;
  const fill=async()=>{while(index===chunk.length&&!ended){const next=await source.next();ended=!!next.done;chunk=next.done?'':String(next.value);index=0;}};
  const peek=async()=>{await fill();return chunk[index];};
  const take=async()=>{const char=await peek();if(char===undefined)throw Error('备份 JSON 提前结束');index++;return char;};
  const white=async()=>{while(/^[\x20\t\r\n]$/.test(await peek()??''))index++;};
  const string=async()=>{
    if(await take()!=='"')throw Error('备份 JSON 字符串格式错误');const parts=['"'];
    for(;;){await fill();if(ended)throw Error('备份 JSON 字符串未结束');
      const quote=chunk.indexOf('"',index),slash=chunk.indexOf('\\',index),next=quote<0?slash:slash<0?quote:Math.min(quote,slash);
      if(next<0){parts.push(chunk.slice(index));index=chunk.length;continue;}
      parts.push(chunk.slice(index,next+1));index=next+1;
      if(chunk[next]==='"')return JSON.parse(parts.join('')) as string;
      parts.push(await take());
    }
  };
  const value=async(path:string[]):Promise<unknown>=>{
    await white();const first=await peek();
    if(first==='"')return string();
    if(first==='['){index++;const values:unknown[]=[];await white();if(await peek()===']'){index++;return values;}
      let count=0;for(;;){const item=await value([...path,String(count)]);const retain=path.length===1?await onItem?.(path[0],item,count):true;if(retain!==false)values.push(item);count++;if(path.length===1)onEntity?.(path[0],count);await white();const end=await take();if(end===']')return values;if(end!==',')throw Error('备份 JSON 数组分隔无效');}
    }
    if(first==='{'){index++;const object:Record<string,unknown>={};await white();if(await peek()==='}'){index++;return object;}
      for(;;){await white();const key=await string();if(Object.hasOwn(object,key))throw Error('备份 JSON 字段重复');await white();if(await take()!==':')throw Error('备份 JSON 字段分隔无效');Object.defineProperty(object,key,{value:await value([...path,key]),writable:true,enumerable:true,configurable:true});await white();const end=await take();if(end==='}')return object;if(end!==',')throw Error('备份 JSON 对象分隔无效');}
    }
    let token='';for(;;){const char=await peek();if(char===undefined||/[\x20\t\r\n,\]}]/.test(char))break;token+=char;index++;}
    if(!token)throw Error('备份 JSON 值缺失');const parsed=JSON.parse(token);if(parsed!==null&&typeof parsed!=='number'&&typeof parsed!=='boolean')throw Error('备份 JSON 值格式错误');return parsed;
  };
  try{const parsed=await value([]);await white();if(await peek()!==undefined)throw Error('备份 JSON 结尾有多余数据');return parsed;}finally{stream.destroy();}
}
