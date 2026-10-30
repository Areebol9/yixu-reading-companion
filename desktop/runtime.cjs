'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
function clientPaths(root, env = process.env) {
  const base = env.LOCALAPPDATA || env.APPDATA;
  if (!env.YIXU_DATA_DIR && !base) throw Error('请使用 YIXU_DATA_DIR 指定可写的数据目录。');
  let dataRoot = env.YIXU_DATA_DIR ? path.resolve(env.YIXU_DATA_DIR) : path.join(base, 'YixuReading', 'Desktop');
  // Desktop and agent launches may see different Windows app-container views
  // of LOCALAPPDATA. Keep the chosen directory outside that redirected tree.
  const locationFile=path.join(os.homedir(),'.yixu-reading','desktop-data-location.json');
  if(!env.YIXU_DATA_DIR){
    try{
      const location=JSON.parse(fs.readFileSync(locationFile,'utf8'));
      if(location.schema!=='yixu-desktop-data-location-v1'||typeof location.dataRoot!=='string'||!path.isAbsolute(location.dataRoot))throw Error('客户端数据目录设置无效，原存档保持。');
      dataRoot=location.dataRoot;
      if(!fs.statSync(dataRoot).isDirectory())throw Error('原阅读数据目录暂不可用，未新建空存档。');
      return runtimePaths(root,dataRoot,env);
    }catch(error){if(error.code!=='ENOENT'||fs.existsSync(locationFile))throw error;}
  }
  const bindingFile=path.join(dataRoot,'companion-host','data','native-home.json');
  let bindingText;
  try{bindingText=fs.readFileSync(bindingFile,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
  if(bindingText!==undefined){
    let binding;try{binding=JSON.parse(bindingText);}catch{throw Error('原阅读数据的位置记录无法读取，请检查该文件；未改用新目录。');}
    if(binding?.schema!=='yixu-native-home-v1'||typeof binding.nativeHome!=='string'||!path.isAbsolute(binding.nativeHome))throw Error('原阅读数据的位置记录无效，未改用新目录。');
    const nativeHome=path.resolve(binding.nativeHome),hostRoot=path.dirname(nativeHome),boundRoot=path.dirname(hostRoot);
    if(path.basename(nativeHome)!=='dsh-home'||path.basename(hostRoot)!=='companion-host')throw Error('原阅读数据的位置记录不完整，未改用新目录。');
    const requested=fs.statSync(dataRoot,{bigint:true}),bound=fs.statSync(boundRoot,{bigint:true});
    if(!bound.isDirectory())throw Error('原阅读数据目录暂不可用，未新建空存档。');
    const same=requested.dev!==0n&&requested.ino!==0n&&requested.dev===bound.dev&&requested.ino===bound.ino;
    if(env.YIXU_DATA_DIR&&!same&&path.resolve(dataRoot)!==boundRoot)throw Error('指定目录与原阅读数据的位置记录不同，请选择原目录；未新建空存档。');
    dataRoot=boundRoot;
  }
  if(!env.YIXU_DATA_DIR){
    fs.mkdirSync(dataRoot,{recursive:true});fs.mkdirSync(path.dirname(locationFile),{recursive:true});
    try{fs.writeFileSync(locationFile,JSON.stringify({schema:'yixu-desktop-data-location-v1',dataRoot}),{flag:'wx',mode:0o600});}
    catch(error){if(error.code!=='EEXIST')throw error;return clientPaths(root,env);}
  }
  return runtimePaths(root,dataRoot,env);
}
function runtimePaths(root,dataRoot,env){
  const port = Number(env.YIXU_PORT ?? env.YIXU_WORKBENCH_PORT ?? 0);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535 || (port > 0 && port < 1024)) throw Error('YIXU_PORT 应为 0 或 1024 至 65535 之间的本地端口。');
  return {root, dataRoot, port, profile: path.join(dataRoot, 'desktop-browser')};
}
module.exports = {clientPaths};
