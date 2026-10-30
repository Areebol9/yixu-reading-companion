import { useSyncExternalStore } from 'react';
import { processEnglish } from './i18n-process.en.ts';
import { uiEnglish } from './i18n-ui.en.ts';
export type InterfaceLanguage = 'zh-CN' | 'en';
export const systemLanguage = ():InterfaceLanguage => typeof window === 'undefined' || typeof navigator === 'undefined' || /^zh\b/i.test(navigator.language) ? 'zh-CN' : 'en';
let language:InterfaceLanguage = systemLanguage();
const listeners = new Set<()=>void>();
const english:Record<string,string> = {...processEnglish,...uiEnglish};
const translatedMessages=new Set(Object.values(english));
const escapePattern=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const templates=Object.entries(english).filter(([key])=>/\{\d+\}/.test(key)).map(([key,value])=>({
  pattern:new RegExp('^'+key.split(/\{\d+\}/).map(escapePattern).join('(.*?)')+'$'),
  translatedPattern:new RegExp('^'+value.split(/\{\d+\}/).map(escapePattern).join('(.*?)')+'$'),
  indexes:[...key.matchAll(/\{(\d+)\}/g)].map(match=>Number(match[1])),value,
}));
export const interfaceLanguage = () => language;
export const locale = () => language === 'en' ? 'en-US' : 'zh-CN';
export const isInterfaceMessage = (text:string) => Object.hasOwn(english,text)||translatedMessages.has(text)||templates.some(template=>template.translatedPattern.test(text));
export function setInterfaceLanguage(value:InterfaceLanguage){
  if(typeof document!=='undefined'){document.documentElement.lang=value;document.title=value==='en'?'Yixu Reading':'宜序伴读';}
  if(language===value)return;
  language=value;for(const listener of listeners)listener();
}
export function useInterfaceLanguage(){return useSyncExternalStore(listener=>{listeners.add(listener);return()=>listeners.delete(listener);},interfaceLanguage,interfaceLanguage);}
/** Translate interface copy only. Reader text and saved conversation content never pass through this function. */
export function t(source:string,...values:unknown[]):string {
  let translated=language==='en'?(english[source]??source):source;
  // Some status labels arrive already formatted by the host. Match only known
  // interface templates; the underlying record is kept verbatim.
  if(language==='en'&&!Object.hasOwn(english,source)&&!values.length&&/[\p{Script=Han}]/u.test(source)){
    for(const template of templates){const match=template.pattern.exec(source);if(!match)continue;const found:unknown[]=[];template.indexes.forEach((index,i)=>{found[index]=match[i+1];});return template.value.replace(/\{(\d+)\}/g,(_m,index:string)=>String(found[Number(index)]??''));}
  }
  return translated.replace(/\{(\d+)\}/g,(_match,index:string)=>String(values[Number(index)]??''));
}
/** For application-generated status text, never source text or conversation bodies. */
export function systemText(source:string,fallback:string){const value=t(source);return language==='en'&&/[\p{Script=Han}]/u.test(value)?t(fallback):value;}
export function formatNumber(value:number,options?:Intl.NumberFormatOptions){return Intl.NumberFormat(locale(),options).format(value);}
