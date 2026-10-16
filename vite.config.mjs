import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';
import {workbenchHarnessPlugin} from './scripts/workbench-harness-build.mjs';
const bridgePort=Number(process.env.YIXU_PORT??process.env.YIXU_WORKBENCH_PORT??4323),devPort=Number(process.env.YIXU_DEV_PORT??5174);
if([bridgePort,devPort].some(port=>!Number.isSafeInteger(port)||port<1024||port>65535))throw Error('客户端端口应在1024至65535之间');
export default defineConfig({base:'./',plugins:[workbenchHarnessPlugin()],server:{port:devPort,strictPort:true,proxy:{'/api':`http://127.0.0.1:${bridgePort}`}},build:{target:'es2022',sourcemap:true,rolldownOptions:{input:{main:fileURLToPath(new URL('./index.html',import.meta.url)),workbench:fileURLToPath(new URL('./workbench.html',import.meta.url))}}}});
