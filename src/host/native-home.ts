import {mkdir,realpath,readFile,open,link,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {samePhysicalPath} from './path-identity.ts';

/** Execution-log location is archive identity; ownership itself remains official OS leasing. */
export async function bindNativeHome(dataRoot:string,home:string){
  await mkdir(dataRoot,{recursive:true});await mkdir(home,{recursive:true});
  const canonicalHome=await realpath(home),canonicalRoot=await realpath(dataRoot),file=join(canonicalRoot,'native-home.json');
  const expected={schema:'yixu-native-home-v1',nativeHome:canonicalHome};
  const project=process.env.YIXU_OPENED_PROJECT_DIRECTORY;
  const portable=!!project&&await samePhysicalPath(resolve(project,'data'),canonicalRoot)&&await samePhysicalPath(resolve(project,'runtime'),canonicalHome);
  const stored=portable?{schema:'yixu-project-native-home-v1',nativeHome:'../runtime'}:expected;
  const existingBinding=async()=>{
    const existing=JSON.parse(await readFile(file,'utf8'));
    if(portable){if(existing.schema!=='yixu-project-native-home-v1'||existing.nativeHome!=='../runtime')throw Error('工程的运行记录位置无法识别，原资料保持。');return expected;}
    if(existing.schema!==expected.schema||!(await samePhysicalPath(existing.nativeHome,canonicalHome)))throw Error('此存档目录已绑定另一原生日志home；原日志与存档保持，未自动重绑');return existing as typeof expected;
  };
  try{return await existingBinding();}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const temporary=join(canonicalRoot,'.native-home-'+randomUUID()+'.pending'),handle=await open(temporary,'wx',0o600);
  try{await handle.writeFile(JSON.stringify(stored));await handle.sync();}finally{await handle.close();}
  let bound=expected;
  try{await link(temporary,file);}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;bound=await existingBinding();}
  finally{await unlink(temporary);}
  return bound;
}
