import { interfaceLanguage, locale } from './i18n.ts';
/** Display units only. Accounting and provider limits always remain exact tokens. */
export function formatTokens(tokens:number){
  if(interfaceLanguage()==='en')return Intl.NumberFormat(locale(),{notation:'compact',maximumFractionDigits:2}).format(tokens);
  return Intl.NumberFormat('zh-CN',{maximumFractionDigits:Math.abs(tokens)<10000?4:2}).format(tokens/10000)+'万';
}
export const tokenInputWan=(tokens:number)=>String(tokens/10000);
export function tokensFromWan(value:string){
  if(!/^\d+(?:\.\d{0,4})?$/.test(value.trim()))return NaN;
  const tokens=Math.round(Number(value)*10000);return Number.isSafeInteger(tokens)?tokens:NaN;
}
