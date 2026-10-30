import {parentPort} from 'node:worker_threads';
import {createLocalBridge} from '../../scripts/local-bridge.mjs';

if(!parentPort)throw Error('模型网关需要所属宿主');
const server=createLocalBridge({port:0,workspaceRoot:process.cwd()});
let closing;
parentPort.on('message',message=>{
  if(message?.type!=='close'||closing)return;
  // The archive drains requests before disposing this gateway. Never terminate
  // an active provider connection just to make the host close faster.
  closing=new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  closing.then(()=>{parentPort.postMessage({type:'closed'});parentPort.close();},error=>{parentPort.postMessage({type:'close-error',message:error.message});closing=undefined;});
});
server.once('error',error=>{parentPort.postMessage({type:'failed',message:error.message});parentPort.close();});
server.listen(0,'127.0.0.1',()=>{
  const address=server.address();
  if(!address||typeof address==='string')throw Error('模型网关未取得本机端口');
  parentPort.postMessage({type:'ready',port:address.port});
});
