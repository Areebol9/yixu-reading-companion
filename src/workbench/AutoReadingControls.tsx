import { t, locale, systemText } from './i18n.ts';
import {useEffect,useState} from 'react';
import type {WorkbenchClient,WorkbenchSnapshot,AutoReadingSettings,AutoReadingEstimate} from './contract.ts';
import {Dialog} from './components.tsx';
import {formatTokens,tokenInputWan,tokensFromWan} from './token-display.ts';
import {autoReadingChapters} from './auto-reading.ts';
const number=(n:number)=>Intl.NumberFormat(locale()).format(n);
export function AutoReadingControls({client,snapshot,onStart,onError}:{client:WorkbenchClient;snapshot:WorkbenchSnapshot;onStart:(settings:AutoReadingSettings)=>Promise<void>;onError:(message:string)=>void}){
  const {book,page,autoReading,budget}=snapshot;
  const saved=autoReading?.settings,chapters=book?autoReadingChapters(book):[];
  const current=chapters.findIndex(c=>c.index===page?.chapterIndex),available=chapters.slice(Math.max(0,current)).filter(chapter=>(chapter.contentEnd??chapter.end)>(page?.position??0));
  const [target,setTarget]=useState(saved?.targetChapterIndex??available[0]?.index??0),[speed,setSpeed]=useState(saved?.charactersPerMinute??1000),[limit,setLimit]=useState(tokenInputWan(saved?.tokenLimit??snapshot.settings.tokenLimit)),[manual,setManual]=useState(saved?.budgetMode==='manual'),[estimate,setEstimate]=useState<AutoReadingEstimate>(),[working,setWorking]=useState(false),[open,setOpen]=useState(false);
  const active=['starting','reading','finishing'].includes(autoReading?.phase??''),count=available.findIndex(c=>c.index===target)+1;
  useEffect(()=>{if(saved&&saved.bookId===book?.id&&saved.version===book?.version){setTarget(saved.targetChapterIndex);setSpeed(saved.charactersPerMinute);setLimit(tokenInputWan(saved.tokenLimit));setManual(saved.budgetMode==='manual');}else{setTarget(available[0]?.index??0);setManual(false);}},[book?.id,book?.version]);
  useEffect(()=>{if(!active&&available.length&&!available.some(c=>c.index===target))setTarget(available[0].index);},[page?.chapterIndex,page?.position,active,target]);
  useEffect(()=>{if(!book||!page||!available.some(c=>c.index===target))return;let cancelled=false;
    void client.estimateAutoReading(target).then(value=>{if(!cancelled){setEstimate(value);if(!manual&&!active)setLimit(tokenInputWan(value.total));}}).catch(error=>{if(!cancelled)onError(error.message);});
    return()=>{cancelled=true;};
  },[client,book?.id,book?.version,target,snapshot.settings.model,snapshot.settings.effort,snapshot.settings.maxOutput,manual]);
  const settings=():AutoReadingSettings=>({bookId:book!.id,version:book!.version,targetChapterIndex:target,charactersPerMinute:speed,tokenLimit:tokensFromWan(limit),budgetMode:manual?'manual':'estimate'});
  const perform=async(action:()=>Promise<unknown>)=>{setWorking(true);try{await action();}catch(error){onError((error as Error).message);}finally{setWorking(false);}};
  const status=snapshot.connectionError?t("连接中断，状态待核"):autoReading?.phase==='finishing'?t("正在保存读点"):autoReading?.phase==='complete'?t("翻阅完成"):active?t("运行中"):t("已暂停");
  return <>
    <div className="auto-reading-controls" role="region" aria-label={t("自动伴读")}>
      {active?<button className="btn btn-primary btn-small" onClick={()=>void perform(()=>client.stopAutoReading())}>{t("停止自动伴读")}</button>:<button className="btn btn-primary btn-small" disabled={(!snapshot.modelReady||snapshot.backgroundModelReady===false)||!book||!page||!available.length||snapshot.pageLoading||snapshot.busyAction||working} onClick={()=>void perform(()=>onStart(settings()))}>{working?t("正在开始…"):t("开始自动伴读")}</button>}
      <button className="btn btn-small" aria-label={t("自动伴读设置")} onClick={()=>setOpen(true)}>{t("设置")}</button>
      <span className="auto-reading-status" role="status" title={autoReading?.reason?systemText(autoReading.reason,'自动伴读'):undefined}>{status}{budget?t(" · 余量 {0} token",formatTokens(Math.max(0,budget.remainingTokens))):''}</span>
    </div>
    {open&&<Dialog title={t("自动伴读设置")} onClose={()=>setOpen(false)}>
      <div className="auto-reading-fields">
        <label>{t("阅读章节数")}<input aria-label={t("阅读章节数")} type="number" min="1" max={available.length||1} value={count||1} disabled={!book} onChange={e=>{const value=Number(e.target.value);if(Number.isInteger(value)&&value>0&&value<=available.length)setTarget(available[value-1].index);}} /></label>
        <label>{t("读到")}<select aria-label={t("终止章节")} value={target} disabled={!book} onChange={e=>setTarget(Number(e.target.value))}>{available.map(c=><option value={c.index} key={c.index}>{c.title}</option>)}</select></label>
        <label>{t("字／分钟")}<input aria-label={t("阅读速度")} type="number" min="1" value={speed} onChange={e=>setSpeed(Number(e.target.value))}/></label>
        <label>{t("本轮上限（万 token）")}<input aria-label={t("本轮上限（万 token）")} type="number" min="0" step="0.1" value={limit} onChange={e=>{setLimit(e.target.value);setManual(true);}}/></label>
      </div>
      {page&&<p className="form-hint">{t('从{0}当前读点开始，到{1}结束。',page.chapterTitle,chapters.find(c=>c.index===target)?.title??'')}</p>}
      {budget&&<p className="form-hint">{t('已用 {0}，预留 {1}，已生效上限 {2} token。',formatTokens(budget.actualTokens),formatTokens(budget.reservedTokens),formatTokens(budget.tokenLimit))}</p>}
      {estimate&&<details className="auto-estimate"><summary>{t("建议上限")}{formatTokens(estimate.total)} token{manual?t(" · 当前采用手动设置"):''}</summary><p>{t(estimate.basis)} {t('尚需处理约 {0} 字，预计新用量 {1}，估算余量 {2} token。',number(estimate.remainingChars),formatTokens(estimate.additional),formatTokens(estimate.margin))}</p></details>}
      <div className="material-actions">
        {estimate&&<button className="btn btn-small" onClick={()=>{setLimit(tokenInputWan(estimate.total));setManual(false);}}>{t("采用估算")}</button>}
        <button className="btn btn-primary btn-small" disabled={!book||!available.length||working} onClick={()=>void perform(async()=>{await client.configureAutoReading(settings());setOpen(false);})}>{active?t("应用更改"):t("保存设置")}</button>
      </div>
      {autoReading?.reason&&<p className="form-hint">{systemText(autoReading.reason,'已暂停')}{snapshot.app.readingControl?.inFlight?t("；正在等待已发出的回复并保存。"):''}</p>}
    </Dialog>}
  </>;
}
