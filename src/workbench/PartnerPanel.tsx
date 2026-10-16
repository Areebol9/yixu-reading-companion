import { workbenchErrorLabel } from './copy.ts';
import { useState } from 'react';
import type { WorkbenchClient, WorkbenchSnapshot } from './contract.ts';
import { currentBookVoiceChoice } from '../core/reading-policy.ts';
import { Drawer } from './components.tsx';
import { Icon } from './icons.tsx';

export function PartnerPanel({ client, snapshot, onClose }: { client: WorkbenchClient; snapshot: WorkbenchSnapshot; onClose: () => void }) {
  const partner = snapshot.app.state.partners.find(item => item.id === snapshot.app.state.partnerId);
  const [name, setName] = useState(partner?.name ?? ''), [traits, setTraits] = useState(partner?.traits ?? '');
  const [error, setError] = useState(''), [saving, setSaving] = useState(false);
  async function save() { setSaving(true); setError(''); try { await client.updatePartner(name, traits); onClose(); } catch (error) { setError(error instanceof Error ? error.message : '伙伴特点保存未完成，请重试。'); } finally { setSaving(false); } }
  return <Drawer title="伙伴设置" subtitle="设置伙伴名称和交流偏好" onClose={onClose} footer={<><small>已有的阅读与交流经历继续保存。</small><button className="btn btn-primary" disabled={saving || snapshot.app.busy} onClick={() => void save()}><Icon name="check" size={15} />{saving ? '保存中…' : '保存设置'}</button></>}>
    <label className="form-field"><span>伙伴名称</span><input value={name} maxLength={100} onChange={event => setName(event.target.value)} /></label>
    <label className="form-field"><span>伙伴特点与交流偏好</span><textarea value={traits} rows={8} maxLength={12000} onChange={event => setTraits(event.target.value)} /></label>
    <section className="form-section"><h3>作品文风</h3><label className="check-choice"><input type="checkbox" checked={traits.includes(currentBookVoiceChoice)} onChange={event => setTraits(previous => event.target.checked ? [previous.trim(), currentBookVoiceChoice].filter(Boolean).join('\n\n') : previous.replace(currentBookVoiceChoice, '').trim())} /><span>参考当前作品的表达风格</span></label><p>开启后，伙伴会参考当前作品的表达风格。</p></section>
    <section className="form-section"><h3>已有阅读背景</h3><p>{partner?.backgroundBooks.length ? `已保存 ${partner.backgroundBooks.length} 本背景资料的阅读背景。` : '当前伙伴尚未导入初始阅读背景。'}</p><p>阅读背景与实际共同经历分别保存。模型自身熟悉某个书名，也不记作这位伙伴已经读过。</p></section>
    {error && <div className="callout amber" role="alert">{workbenchErrorLabel(error)}</div>}
  </Drawer>;
}
