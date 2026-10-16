import {existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createLocalBridge} from './local-bridge.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const port=Number(process.env.YIXU_PORT??process.env.YIXU_WORKBENCH_PORT??4323);
if(!Number.isSafeInteger(port)||port<1024||port>65535)throw Error('测试台端口应在1024至65535之间');
if(!existsSync(resolve(root,'dist/workbench.html'))||process.argv.includes('--build')){
  if(!existsSync(resolve(root,'node_modules/vite/bin/vite.js')))throw Error('请先在项目目录执行 npm ci --ignore-scripts 安装现有依赖');
  const result=spawnSync(process.execPath,[resolve(root,'node_modules/vite/bin/vite.js'),'build'],{cwd:root,stdio:'inherit'});
  if(result.status!==0)process.exit(result.status??1);
}
const server=createLocalBridge({port,workspaceRoot:root});
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`端口${port}已被使用。请使用现有测试台，或通过YIXU_WORKBENCH_PORT指定另一个端口。`:error.message);process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>{
  console.log(`宜序伴读 · 共读工作台\nhttp://127.0.0.1:${port}/workbench.html\n本地存档独立保存；网页默认界面演练。按 Ctrl+C 结束服务。`);
});
const stop=()=>server.close(()=>process.exit(0));
process.on('SIGINT',stop);process.on('SIGTERM',stop);
