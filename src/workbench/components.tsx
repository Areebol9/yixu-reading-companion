import { workbenchErrorLabel } from './copy.ts';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './icons.tsx';

export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const container = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    container.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (Array.from(document.querySelectorAll('[role="dialog"]')).at(-1) !== container.current) return;
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key === 'Tab') {
        const controls = Array.from(container.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),summary,[tabindex="0"]') ?? []);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return <><div className="panel-backdrop" onClick={onClose} /><div className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={container}><div className="modal-header"><h2>{title}</h2><button type="button" className="icon-btn" onClick={onClose} aria-label="关闭"><Icon name="close" /></button></div><div className="modal-content">{children}</div></div></>;
}

export function Drawer({ title, subtitle, children, footer, tabs, onClose }: { title: string; subtitle: string; children: ReactNode; footer?: ReactNode; tabs?: ReactNode; onClose: () => void }) {
  const container = useRef<HTMLElement>(null), close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    container.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (Array.from(document.querySelectorAll('[role="dialog"]')).at(-1) !== container.current) return;
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key === 'Tab') {
        const controls = Array.from(container.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),summary,[tabindex="0"]') ?? []);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return <><div className="panel-backdrop" onClick={onClose} /><section className="drawer" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={container}><header className="drawer-header"><div><h2>{title}</h2><p>{subtitle}</p></div><button className="icon-btn" aria-label="关闭" onClick={onClose}><Icon name="close" /></button></header>{tabs}<div className="drawer-content">{children}</div>{footer && <footer className="drawer-footer">{footer}</footer>}</section></>;
}

export function ImportDialog({ onClose, onFile, onText }: { onClose: () => void; onFile: (file: File) => Promise<void>; onText: (title: string, text: string) => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [title, setTitle] = useState(''), [text, setText] = useState('');
  async function run(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); onClose(); } catch (error) { setError(error instanceof Error ? error.message : '导入失败，请检查文件后重试。'); } finally { setBusy(false); }
  }
  return <Dialog title="添加书籍或备份" onClose={onClose}>
    <div className={`import-drop${dragging ? ' dragging' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); const file = event.dataTransfer.files[0]; if (file && !busy) void run(() => onFile(file)); }}>
      <Icon name="book" size={31} /><h3>{busy ? '正在整理文件…' : '拖入文件'}</h3><p>支持 TXT 小说与宜序伴读共读备份<br />导入后选择阅读位置，即可开始伴读。</p><button className="btn btn-primary" disabled={busy} onClick={() => input.current?.click()}><Icon name="plus" size={16} />选择文件</button>
      <input ref={input} type="file" accept=".txt,.json,text/plain,application/json" hidden onChange={event => { const file = event.target.files?.[0]; if (file) void run(() => onFile(file)); event.target.value = ''; }} />
    </div>
    {error && <p className="callout amber" role="alert">{workbenchErrorLabel(error)}</p>}
    <details className="import-alternative"><summary>也可以粘贴一段原文</summary><label className="form-field"><span>书名</span><input value={title} onChange={event => setTitle(event.target.value)} placeholder="为这份原文起一个名字" maxLength={100} /></label><label className="form-field"><span>原文内容</span><textarea rows={6} value={text} onChange={event => setText(event.target.value)} placeholder="粘贴你有权阅读和使用的原文" /></label><button className="btn btn-primary" disabled={busy || !title.trim() || !text.trim()} onClick={() => void run(() => onText(title.trim(), text))}>添加原文<Icon name="arrow" size={15} /></button></details>
    <p className="inline-note" style={{ marginTop: 17 }}>TXT加入当前书架；导入共读备份会创建独立阅读存档，已有存档保留。</p>
  </Dialog>;
}

export function Notice({ text, error, onClose }: { text: string; error?: boolean; onClose: () => void }) {
  return <div className={`notification${error ? ' error' : ''}`} role={error ? 'alert' : 'status'}><span>{text}</span><button className="icon-btn" onClick={onClose} aria-label="收起提示"><Icon name="close" size={15} /></button></div>;
}

export function EmptyReader({ onImport, onSettings }: { onImport: () => void; onSettings: () => void }) {
  return <div className="reader-empty"><div className="empty-illustration"><Icon name="book" size={45} /></div><h3>添加书籍，开始共读</h3><p>放入一本书，选好你正在读的位置。<br />翻页、插话，或让伙伴安静陪你读。</p><div className="empty-actions"><button className="btn btn-primary" onClick={onImport}><Icon name="plus" size={16} />添加书籍<Icon name="arrow" size={15} /></button><button className="btn btn-small" onClick={onSettings}>模型设置</button></div><div className="empty-steps"><span><b>1</b>导入原文</span><Icon name="chevron" size={10} /><span><b>2</b>选择阅读位置</span><Icon name="chevron" size={10} /><span><b>3</b>开始共读</span></div></div>;
}
