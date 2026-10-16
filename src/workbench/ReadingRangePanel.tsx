import { workbenchErrorLabel } from './copy.ts';
import { useState } from 'react';
import type { WorkbenchClient, WorkbenchSnapshot } from './contract.ts';
import { Dialog } from './components.tsx';
import { Icon } from './icons.tsx';

export function ReadingRangePanel({ client, snapshot, onClose }: { client: WorkbenchClient; snapshot: WorkbenchSnapshot; onClose: () => void }) {
  const book = snapshot.book, page = snapshot.page;
  const [rangeMode, setRangeMode] = useState<'previous' | 'section'>('previous');
  const [from, setFrom] = useState(String(book?.frontMatterIncluded ? 0 : book?.frontMatterEnd ?? 0));
  const [through, setThrough] = useState(String(page?.position ?? 0)), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const firstBody = book?.frontMatterIncluded ? 0 : book?.frontMatterEnd ?? 0;
  async function prepare() { const start = rangeMode === 'previous' ? firstBody : Number(from), end = Number(through); if (!book || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < firstBody || end <= start || end > book.textLength) { setError('请选择已经读过的有效正文范围。'); return; } setSaving(true); setError(''); try { await client.preparePrevious(end, start); onClose(); } catch (error) { setError(error instanceof Error ? error.message : '前文准备暂未完成，已保存的进度保留。'); } finally { setSaving(false); } }
  return <Dialog title="补读前文" onClose={onClose}>
    <p className="callout">让伙伴了解你已经读过的前文。请选择真实读过的范围；已有交流记录保持不变。</p>
    {!!book?.known.length && <details className="known-ranges"><summary>查看已读范围详情</summary><p className="form-hint">允许阅读：{book.known.map(range => `${range.start}—${range.end}`).join('、')}。<br />已完成深度理解：{book.prepared.length ? book.prepared.map(range => `${range.start}—${range.end}`).join('、') : '尚待处理'}。<br />上方位置仅表示正在浏览的地方；回看会保留已有许可，跳转不会补上未确认的空缺。</p></details>}
    <div className="choice-row range-choices"><button className={`choice${rangeMode === 'previous' ? ' selected' : ''}`} onClick={() => setRangeMode('previous')}><strong>从开头补读</strong><small>确认当前位置之前的正文</small></button><button className={`choice${rangeMode === 'section' ? ' selected' : ''}`} onClick={() => setRangeMode('section')}><strong>选择一段前文</strong><small>跳章或资料不连续时使用</small></button></div>
    <p className="form-hint">当前浏览：{page?.chapterTitle}。默认补至当前屏幕的正文位置，当前屏幕的正文由“跟随阅读”逐段接上。</p>
    {rangeMode === 'section' && <label className="form-field"><span>这段从哪里开始</span><select value={from} onChange={event => setFrom(event.target.value)}>{book?.chapters.map(chapter => <option key={chapter.index} value={chapter.start}>{chapter.title} · 开头</option>)}</select></label>}
    <label className="form-field"><span>你已经读到哪里（之前的内容）</span><select value={through} onChange={event => setThrough(event.target.value)}><option value={page?.position ?? 0}>当前浏览位置 · 屏幕正文之前</option>{book?.chapters.filter(chapter => chapter.start !== page?.position).map(chapter => <option key={chapter.index} value={chapter.start}>{chapter.title} · 开头</option>)}</select></label>
    <details className="exact-range"><summary>精确指定文字位置</summary><p className="form-hint">按原文字位置填写，结束位置之前的文字会获准使用。文件中尚未读过的部分继续保留在本机。</p>{rangeMode === 'section' && <label className="form-field"><span>开始文字位置</span><input type="number" min={firstBody} max={book?.textLength} value={from} onChange={event => setFrom(event.target.value)} /></label>}<label className="form-field"><span>结束文字位置</span><input type="number" min={firstBody} max={book?.textLength} value={through} onChange={event => setThrough(event.target.value)} /></label></details>
    <p className="form-hint">{snapshot.mode === 'live' ? `使用 ${snapshot.settings.model} / ${snapshot.settings.effort}，会产生实际用量。` : '当前是界面演示，只检查准备流程。'}补读期间可以继续浏览原文；暂停会停止新增处理并收取已发出的回复。</p>
    {error && <p className="callout amber" role="alert">{workbenchErrorLabel(error)}</p>}
    <div className="dialog-actions"><button className="btn btn-outline" onClick={onClose}>暂不补读</button><button className="btn btn-primary" disabled={saving || snapshot.app.busy || !snapshot.modelReady} onClick={() => void prepare()}><Icon name="play" size={14} />{saving ? '正在补读前文…' : '确认并补读'}</button></div>
    {saving && <button className="text-action" onClick={() => void client.pause()}>暂停补读</button>}
  </Dialog>;
}
