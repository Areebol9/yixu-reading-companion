import {stat} from 'node:fs/promises';
import {resolve} from 'node:path';

/** Existing OS aliases can name one object even when realpath preserves both spellings. */
export async function samePhysicalPath(left:unknown,right:unknown):Promise<boolean>{
  if(typeof left!=='string'||!left||typeof right!=='string'||!right)return false;
  const a=resolve(left),b=resolve(right);if(a===b)return true;
  try{
    const [first,second]=await Promise.all([stat(a,{bigint:true}),stat(b,{bigint:true})]);
    return first.dev!==0n&&first.ino!==0n&&second.dev!==0n&&second.ino!==0n&&first.dev===second.dev&&first.ino===second.ino&&(first.mode&0o170000n)===(second.mode&0o170000n);
  }catch(error){if(['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))return false;throw error;}
}
