import { t, locale } from './i18n.ts';
import {useEffect,useRef,useState} from 'react';
import type {BookView} from '../core/application-contract.ts';
import {bodyChapterCount} from '../core/book-versions.ts';
import {decodeBook} from '../core/books.ts';
import {Dialog} from './components.tsx';
import type {BookProjectLocations} from '../host/contract.ts';
import './book-directory.css';
import {sourceFileFromSelection} from './desktop-window.ts';

export function BookDetailsPanel({book,onRename,onExtend,onExtendFile,onRecognizeDirectory,onGetProjectLocations,onSaveProjectCopy,backgroundModelReady,onClose}:{book:BookView;onRename:(title:string)=>Promise<void>;onExtend:(raw:string,sourceFile?:import('../core/types.ts').BookSourceFile)=>Promise<void>;onExtendFile?:(file:File)=>Promise<void>;onRecognizeDirectory:(useModel:boolean)=>Promise<void>;onGetProjectLocations:()=>Promise<BookProjectLocations>;onSaveProjectCopy:(parentDirectory:string)=>Promise<{directory:string;title:string}>;backgroundModelReady?:boolean;onClose:()=>void}){
  const [title,setTitle]=useState(book.title),[saving,setSaving]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [recognizing,setRecognizing]=useState<'local'|'model'|undefined>();
  const [locations,setLocations]=useState<BookProjectLocations>();
  useEffect(()=>{let active=true;if(window.yixuDesktop)void onGetProjectLocations().then(value=>{if(active)setLocations(value);}).catch(reason=>{if(active)setError(reason instanceof Error?reason.message:String(reason));});return()=>{active=false;};},[book.id]);
  const fileInput=useRef<HTMLInputElement>(null);
  useEffect(()=>{setTitle(book.title);setError('');setNotice('');},[book.id,book.title]);
  const count=bodyChapterCount(book);
  async function save(action:()=>Promise<void>,success?:string){
    setSaving(true);setError('');setNotice('');
    try{await action();if(success)setNotice(success);}catch(reason){setError(reason instanceof Error?reason.message:String(reason));}finally{setSaving(false);}
  }
  async function recognize(useModel:boolean){
    setRecognizing(useModel?'model':'local');setError('');setNotice('');
    try{await onRecognizeDirectory(useModel);setNotice(t("目录已更新，阅读位置和已有记录已保留。"));}catch(reason){setError(t("{0} 原目录已保留，可以稍后重新识别。",reason instanceof Error?reason.message:String(reason)));}finally{setRecognizing(undefined);}
  }
  async function openProject(){
    try{
      const desktop=window.yixuDesktop,selected=await desktop?.chooseReadingProjectDirectory?.(locations?.openedProjectDirectory);if(!selected||!desktop?.openReadingProjectDirectory)return;
      await save(async()=>{await desktop.openReadingProjectDirectory!(selected);},t("正在保存当前阅读记录并打开工程…"));
    }catch(reason){setError(reason instanceof Error?reason.message:String(reason));}
  }
  async function saveProjectCopy(){
    try{
      const selected=await window.yixuDesktop?.chooseProjectDirectory?.();if(!selected)return;
      await save(async()=>{const result=await onSaveProjectCopy(selected);setNotice(t("工程副本已保存到：{0}。副本包含交流记录，分享请自行操作。",result.directory));});
    }catch(reason){setError(reason instanceof Error?reason.message:String(reason));}
  }
  const project=locations?.projects.find(project=>project.bookId===book.id);
  return <Dialog title={t("书籍信息")} onClose={onClose}><div className="book-details">
    <form onSubmit={event=>{event.preventDefault();if(!saving&&title.trim()&&title.trim()!==book.title)void save(()=>onRename(title.trim()),t("书名已保存。"));}}>
      <label className="form-field"><span>{t("书名")}</span><input aria-label={t("书名")} value={title} maxLength={200} disabled={saving} onChange={event=>setTitle(event.target.value)} /></label>
      <button className="btn btn-outline btn-small" disabled={saving||!title.trim()||title.trim()===book.title}>{t("保存书名")}</button>
    </form>
    <section className="book-source-details" aria-label={t("当前正文")}><h3>{t("当前正文")}</h3><p>{count?t("{0} 章",count.toLocaleString(locale())):t("{0} 个目录项",book.chapters.length.toLocaleString(locale()))} · {book.textLength.toLocaleString(locale())} {t("字")}</p></section>
    <section className="book-source-details" aria-label={t("书籍工程与原文")}><h3>{t("书籍工程")}</h3>
      {locations?.openedProjectDirectory?<p className="form-hint" style={{overflowWrap:'anywhere'}}>{t("当前工程：")}{locations.openedProjectDirectory}</p>:<p>{t("当前使用本机书架。保存工程副本后，可选择该目录继续阅读。")}</p>}
      <div className="book-directory-actions"><button type="button" className="btn btn-outline btn-small" disabled={saving||!window.yixuDesktop?.chooseReadingProjectDirectory} onClick={()=>void openProject()}>{t("打开书籍工程")}</button><button type="button" className="btn btn-outline btn-small" disabled={saving||!window.yixuDesktop?.chooseProjectDirectory} onClick={()=>void saveProjectCopy()}>{t("保存工程副本")}</button>{locations?.openedProjectDirectory&&window.yixuDesktop?.useLocalLibrary&&<button type="button" className="btn btn-outline btn-small" disabled={saving} onClick={()=>void save(async()=>{await window.yixuDesktop!.useLocalLibrary!();},t("正在保存当前阅读记录并返回本机书架…"))}>{t("返回本机书架")}</button>}</div>
      <p className="form-hint">{t("打开工程会读取所选目录中的阅读存档。保存工程副本会在选定文件夹内新建书名子文件夹，包含已保存的书籍资料和交流记录；分享由你自行操作。")}</p>
      {project&&<details><summary>{t("工作资料目录")}</summary><p className="form-hint" style={{overflowWrap:'anywhere'}}>{project.directory}</p><p className="form-hint">{t("此目录由应用管理工作资料。保存工程副本可得到完整阅读工程。")}</p></details>}
      <h3>{t("原始 TXT 文件")}</h3>
      {book.sourceFile?<><p style={{overflowWrap:'anywhere'}}>{t("文件名：")}{book.sourceFile.name}</p>{book.sourceFile.path?<><p className="form-hint" style={{overflowWrap:'anywhere'}}>{t("导入时的位置：")}{book.sourceFile.path}</p>{window.yixuDesktop?.openSourceFileDirectory&&<button type="button" className="btn btn-outline btn-small" onClick={()=>void window.yixuDesktop!.openSourceFileDirectory!(book.sourceFile!.path!).catch(reason=>setError(String(reason)))}>{t("打开原文所在文件夹")}</button>}</>:<p className="form-hint">{t("此入口记录了文件名；完整路径可通过本地客户端导入时记录。")}</p>}</>:<p className="form-hint">{t("来源文件信息可在导入 TXT 时记录。")}</p>}
      <p className="form-hint">{t("阅读使用存档中按版本保存的正文副本。原始 TXT 保持原位置，添加后续内容时通过“更新正文”导入。")}</p>
    </section>
    <section className="book-source-details" aria-label={t("目录识别")}><h3>{t("目录")}</h3>
      <p>{(book.directory?.entries.length??book.chapters.length).toLocaleString(locale())} {t("个目录项")}{book.directory?.unresolved?t(" · 还有标题有待确认"):book.directory?t(" · 已识别"):t(" · 可重新识别部、卷和章节层级")}</p>
      <div className="book-directory-actions"><button type="button" className="btn btn-outline btn-small" disabled={saving||!!recognizing} onClick={()=>void recognize(false)}>{recognizing==='local'?t("正在整理目录…"):t("重新识别目录（本地）")}</button><button type="button" className="btn btn-outline btn-small" disabled={saving||!!recognizing||!backgroundModelReady} onClick={()=>void recognize(true)}>{recognizing==='model'?t("正在辅助识别…"):t("模型辅助识别")}</button></div>
      <p className="book-directory-model-note">{t("本地识别可直接使用。模型辅助只发送候选标题和附近排版信息，使用后台已选模型，并产生模型用量。")}</p>
      {!backgroundModelReady&&<p className="book-directory-model-note">{t("如需模型辅助，请先在设置中选择可用的后台模型。")}</p>}
      {recognizing&&<p className="book-directory-progress" role="status">{recognizing==='model'?t("正在请后台模型确认标题与层级，阅读可以继续。"):t("正在从原文标题和排版整理目录，阅读可以继续。")}</p>}
    </section>
    <section className="book-source-details"><h3>{t("更新正文")}</h3><p>{t("选择包含后续章节的 TXT 文件。文件中已有的正文和章节顺序需与当前内容一致，更新后保留阅读位置、交流和伙伴资料。")}</p>
      <button type="button" className="btn btn-outline btn-small" disabled={saving} onClick={()=>fileInput.current?.click()}>{t("选择 TXT 文件")}</button>
      <input ref={fileInput} type="file" accept=".txt,text/plain" aria-label={t("选择更新正文的 TXT 文件")} disabled={saving} hidden onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void save(()=>onExtendFile?onExtendFile(file):file.arrayBuffer().then(bytes=>onExtend(decodeBook(bytes),sourceFileFromSelection(file))),t("正文已更新，已有阅读记录已保留。"));}} />
    </section>
    {saving&&<p className="form-hint" role="status">{t("正在保存书籍信息…")}</p>}
    {notice&&<p className="form-hint" role="status">{notice}</p>}
    {error&&<p className="callout amber" role="alert">{error}</p>}
  </div></Dialog>;
}
