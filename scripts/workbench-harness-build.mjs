import {build} from 'vite';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const virtualId='\0yixu-workbench-harness';
const allowed=['node:path','node:module','node:fs','node:os','node:async_hooks','node:util/types','node:crypto','../package.json','../core/model.ts'];
const sha=value=>createHash('sha256').update(value).digest('hex');

/** Same pinned transform as the native host; no parallel agent implementation. */
export async function buildWorkbenchHarness(workspaceRoot=process.cwd()){
 const vendor=resolve(workspaceRoot,'third_party/deepseek-harness'),manifest=JSON.parse(await readFile(join(vendor,'manifest.json'),'utf8'));
 for(const file of manifest.files)if(sha(await readFile(join(vendor,file.path)))!==file.sha256)throw Error('Agent compatibility source changed: '+file.path);
 const bundle=async(entry,shared=false)=>{
  const result=await build({configFile:false,root:workspaceRoot,logLevel:'error',build:{target:'es2022',minify:false,write:false,lib:{entry:resolve(workspaceRoot,entry),formats:['es']},rolldownOptions:{external:id=>id.startsWith('node:')||shared&&id==='../core/model.ts'}}});
  const chunks=(Array.isArray(result)?result:[result]).flatMap(value=>value.output).filter(value=>value.type==='chunk');if(chunks.length!==1)throw Error('Browser Harness must remain one kernel');return chunks[0];
 };
 const compiler=await bundle('third_party/deepseek-harness/src/compile/transform.ts'),compilerPath=resolve(workspaceRoot,'.local/workbench-agent-compiler/transform.mjs');
 await mkdir(dirname(compilerPath),{recursive:true});await writeFile(compilerPath,compiler.code);
 const {lowerModuleSource}=await import(pathToFileURL(compilerPath).href+'?sha='+sha(compiler.code));
 const program=await bundle('src/agent/runtime.ts',true),lowered=lowerModuleSource({filename:'src/agent/runtime.ts',source:program.code});
 if(!lowered.lowered||lowered.moduleRequests.some(name=>!allowed.includes(name)))throw Error('Browser Harness introduced an undeclared module: '+lowered.moduleRequests.join(', '));
 const host=resolve(workspaceRoot,'src/workbench/browser-agent-host.mjs').replaceAll('\\','/'),model=resolve(workspaceRoot,'src/core/model.ts').replaceAll('\\','/');
 const code='import {browserAgentHost} from '+JSON.stringify(host)+';\nimport {ModelOutputError} from '+JSON.stringify(model)+';\n'+
  'const host=browserAgentHost({"../core/model.ts":{ModelOutputError}});\nconst kernelExports={};\n(function(require,exports,__dsh$meta,__als){\n'+lowered.code+
  '\n})(host.require,kernelExports,Object.freeze({url:"yixu-workbench-harness"}),host.als);\n'+
  'export class HarnessRuntime extends kernelExports.HarnessRuntime {\nrun(input){return host.asyncHooks.runAtAsyncContextRoot(()=>super.run(input));}\ndispose(){return host.asyncHooks.runAtAsyncContextRoot(()=>super.dispose());}\n}\n';
 const record={upstreamCommit:manifest.commit,entry:'src/agent/runtime.ts',hostModules:lowered.moduleRequests,lowered:true,bytes:Buffer.byteLength(code),sha256:sha(code)};
 await writeFile(resolve(workspaceRoot,'.local/workbench-agent-compiler/build.json'),JSON.stringify(record,null,2));
 const licenses=[{fileName:'licenses/harness/DeepSeek-compatibility.txt',source:await readFile(join(vendor,'LICENSE'),'utf8')}];
 const packages=new Set();
 for(const id of Object.keys(program.modules)){const file=resolve(id).replaceAll('\\','/'),index=file.lastIndexOf('/node_modules/');if(index<0)continue;const parts=file.slice(index+14).split('/'),name=parts[0].startsWith('@')?parts.slice(0,2).join('/'):parts[0];if(packages.has(name))continue;packages.add(name);const packageRoot=file.slice(0,index+14)+name;
  let license;for(const candidate of ['LICENSE','LICENSE.md','LICENSE.txt','license','LICENSE-MIT'])try{license=await readFile(join(packageRoot,candidate),'utf8');break;}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!license)throw Error('Browser Harness dependency license missing: '+name);licenses.push({fileName:'licenses/harness/'+name.replaceAll('/','__')+'.txt',source:license});
 }
 return {code,record,licenses};
}

/** Both browser entrypoints share the formal Harness kernel and host adapter. */
export function workbenchHarnessPlugin({workspaceRoot=process.cwd()}={}){
 let kernel;const prepared=()=>kernel??=buildWorkbenchHarness(workspaceRoot);
 return {name:'yixu-workbench-harness-host',enforce:'pre',
  resolveId(source,importer){const file=importer?.replaceAll('\\','/');if(source==='../agent/runtime.ts'&&['/src/workbench/runtime.ts','/src/platform/desktop-runtime.ts'].some(path=>file?.endsWith(path)))return virtualId;},
  async load(id){if(id===virtualId)return (await prepared()).code;},
  async generateBundle(){if(!kernel)return;for(const asset of (await kernel).licenses)this.emitFile({type:'asset',...asset});}
 };
}
