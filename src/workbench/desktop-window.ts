import {useEffect,useState} from 'react';
import type {AutoReadingSettings} from './contract.ts';

export type DesktopWindowState={visible:boolean;focused:boolean;minimized?:boolean;developerMode:boolean};
export interface YixuDesktop {
  setLanguage?(language:'zh-CN'|'en'):Promise<{language:'zh-CN'|'en'}>;
  getWindowState():Promise<DesktopWindowState>;
  chooseProjectDirectory?(current?:string):Promise<string|null>;
  openProjectDirectory?(directory:string):Promise<void>;
  getSourceFilePath?(file:File):string;
  openSourceFileDirectory?(filename:string):Promise<void>;
  onWindowStateChanged(listener:(state:DesktopWindowState)=>void):()=>void;
  onAutoReadingRequested?(listener:(request:{id:string;settings:AutoReadingSettings})=>void):()=>void;
  respondAutoReading?(id:string,result:{ok:boolean;error?:string}):void|Promise<void>;
}
declare global {interface Window {yixuDesktop?:YixuDesktop}}
export function sourceFileFromSelection(file:File):import('../core/types.ts').BookSourceFile {
  const path=window.yixuDesktop?.getSourceFilePath?.(file);
  return{name:file.name,...(path?{path}:{})};
}
const browserState:DesktopWindowState={visible:true,focused:true,developerMode:true};
const waitingState:DesktopWindowState={visible:false,focused:false,developerMode:false};
let latest:DesktopWindowState|undefined;
export function nativeReadingVisible(state:DesktopWindowState|undefined){return state?.visible===true&&state.focused===true&&state.minimized!==true;}
export function manualReadingVisible(){return typeof window==='undefined'||!window.yixuDesktop||nativeReadingVisible(latest);}
export function useDesktopWindowState(){
  const [state,setState]=useState<DesktopWindowState>(()=>window.yixuDesktop?latest??waitingState:browserState);
  useEffect(()=>{
    const desktop=window.yixuDesktop;if(!desktop)return;
    let closed=false,received=false;
    const receive=(value:DesktopWindowState)=>{if(closed)return;latest={visible:value.visible===true,focused:value.focused===true,minimized:value.minimized===true,developerMode:value.developerMode===true};setState(latest);};
    const stop=desktop.onWindowStateChanged(value=>{received=true;receive(value);});
    void desktop.getWindowState().then(value=>{if(!received)receive(value);}).catch(()=>receive(waitingState));
    return()=>{closed=true;stop();};
  },[]);
  return state;
}
