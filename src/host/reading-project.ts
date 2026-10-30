import {mkdir,readFile,rename,rm,realpath,lstat,writeFile} from 'node:fs/promises';
import {join,resolve,isAbsolute,relative} from 'node:path';
import {randomUUID} from 'node:crypto';
import {NodeStore} from './node-store.ts';
import {createSharedBookProject} from './shared-book-project.ts';

export type ReadingProjectManifest={schema:'yixu-reading-project-v1';archiveId:string;title:string;createdAt:number;dataDirectory:'data';nativeDirectory:'runtime'};
export async function readReadingProject(directory:string):Promise<ReadingProjectManifest>{
  if(!isAbsolute(directory))throw Error('请选择书籍工程文件夹');
  let value:ReadingProjectManifest;
  try{value=JSON.parse(await readFile(join(directory,'project.json'),'utf8'));}
  catch{throw Error('所选文件夹中没有可打开的书籍工程，请选择已保存的工程文件夹。');}
  if(value.schema!=='yixu-reading-project-v1'||!/^[0-9a-f-]{36}$/i.test(value.archiveId)||typeof value.title!=='string'||value.dataDirectory!=='data'||value.nativeDirectory!=='runtime')throw Error('书籍工程文件格式无法识别，原文件保持。');
  try{if(!(await lstat(join(directory,'data','archives',value.archiveId,'domain.sqlite'))).isFile())throw Error();}
  catch{throw Error('该工程的阅读资料不完整，请选择完整的工程文件夹。');}
  return value;
}

function folderName(title:string):string{
  const name=title.replace(/[<>:"/\\|?*\u0000-\u001f]/g,' ').replace(/\s+/g,' ').trim().slice(0,80).replace(/[. ]+$/,'')||'书籍工程';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)?'书籍 '+name:name;
}

/** An explicit save-copy operation. Opening a project never calls this path. */
export async function saveReadingProjectCopy(source:NodeStore,bookId:string,parentDirectory:string,privatePreparationDirectory:string):Promise<{directory:string;title:string}>{
  if(!isAbsolute(parentDirectory))throw Error('请选择保存工程副本的位置');
  const parent=await realpath(parentDirectory);
  if(!(await lstat(parent)).isDirectory())throw Error('请选择文件夹作为保存位置');
  const job=randomUUID(),temporary=join(resolve(privatePreparationDirectory),job),stage=join(parent,'.yixu-project-'+job+'.pending');
  // Only newly created staging folders belong to this operation.
  if(relative(parent,stage)!=='.yixu-project-'+job+'.pending')throw Error('无法创建工程副本');
  await mkdir(temporary,{recursive:true});await mkdir(stage);
  let snapshot:NodeStore|undefined;
  try{
    const filename=join(temporary,'snapshot.sqlite');await source.createExportSnapshot(filename);snapshot=new NodeStore(filename,source.receiptDirectory);
    const archiveId=randomUUID(),database=join(stage,'data','archives',archiveId,'domain.sqlite');
    const result=await createSharedBookProject(snapshot,database,bookId);
    const manifest:ReadingProjectManifest={schema:'yixu-reading-project-v1',archiveId,title:result.title,createdAt:Date.now(),dataDirectory:'data',nativeDirectory:'runtime'};
    await writeFile(join(stage,'project.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
    await writeFile(join(stage,'README.txt'),'打开此文件夹即可继续阅读。\n本副本包含本书原文、已保存的阅读进度、交流和理解资料。\n模型服务、密钥和原运行日志留在原客户端；在新的客户端中自行选择模型。\n此副本包含交流记录，分享前请确认其中内容适合提供给接收者。\n',{flag:'wx',mode:0o600});
    const base=folderName(result.title);let directory=join(parent,base),index=2;
    for(;;){try{await lstat(directory);directory=join(parent,base+' ('+(index++)+')');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')break;throw error;}}
    await rename(stage,directory);
    return{directory,title:result.title};
  }catch(error){
    if(error instanceof Error&&error.message.startsWith('无法准备分享副本'))throw error;
    throw Error('工程副本未保存完成，原工程保持。请检查所选文件夹是否可写。');
  }finally{
    await snapshot?.close();
    await rm(stage,{recursive:true,force:true});await rm(temporary,{recursive:true,force:true});
  }
}
