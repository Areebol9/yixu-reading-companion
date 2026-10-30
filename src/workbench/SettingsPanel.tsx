import { t } from './i18n.ts';
import type { InterfaceLanguage } from './i18n.ts';
import {tokensFromWan} from './token-display.ts';
import { workbenchErrorLabel } from './copy.ts';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Drawer } from './components.tsx';
import { Icon } from './icons.tsx';
import type { WorkbenchService } from './contract.ts';
import type { ModelEffort, Service } from '../core/types.ts';
import { ModelParameterFields, modelParameterError } from './ModelParameterFields.tsx';

export type SettingsDraft = { serviceId?: string; mode: 'offline' | 'live'; endpoint: string; model: string; effort: ModelEffort; thinking?: Service['thinking']; temperature?: number; topP?: number; apiKey: string; tokenLimit: number; maxOutput: number; contextLimit: number; pageChars: number };
export function SettingsPanel({ initial, language, onLanguageChange, secretPresent, modelReady, services, developerContent, developerMode=true, onRefreshServices, onUseService, onSave, onClose }: { initial: SettingsDraft; language:InterfaceLanguage; onLanguageChange:(value:InterfaceLanguage)=>Promise<void>; secretPresent: boolean; modelReady: boolean; services: WorkbenchService[]; developerContent?: ReactNode; developerMode?:boolean; onRefreshServices: () => Promise<void>; onUseService: (id: string) => Promise<SettingsDraft>; onSave: (draft: SettingsDraft) => Promise<void>; onClose: () => void }) {
  const [draft, setDraft] = useState(initial), [showKey, setShowKey] = useState(false), [operation, setOperation] = useState<'selecting'|'saving'>(), [error, setError] = useState('');
  const [tab,setTab]=useState<'model'|'developer'>('model');
  const saving=operation!==undefined;
  const available = services.filter(service => !service.binding && (service.scope === 'workbench' || !services.some(other => other.id === service.id && other.scope === 'workbench')));
  const nativeService = available.find(service => service.transport === 'native-codex' && service.baseUrl === draft.endpoint);
  const selectedService = available.find(service => service.baseUrl === draft.endpoint && service.model === draft.model && (!draft.serviceId || service.id === draft.serviceId));
  const keyPresent = selectedService?.hasKey ?? (draft.endpoint === initial.endpoint && draft.model === initial.model && secretPresent);
  const patch = <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => setDraft(previous => ({ ...previous, [key]: value, ...(['endpoint','model'].includes(key) ? {serviceId:undefined} : {}) }));
  const parameterService = { id: draft.serviceId, baseUrl: draft.endpoint, model: draft.model, effort: draft.effort, thinking: draft.thinking ?? selectedService?.thinking };
  async function save() {
    setError('');
    if (!Number.isSafeInteger(draft.tokenLimit)||draft.tokenLimit<0||![draft.maxOutput, draft.contextLimit, draft.pageChars].every(value => Number.isSafeInteger(value) && value > 0)) { setError(t("请为用量与处理参数填写正整数。")); return; }
    const parameterError = modelParameterError(parameterService, draft);
    if (parameterError) { setError(parameterError); return; }
    if (draft.mode === 'live' && (!draft.endpoint.trim() || !draft.model.trim())) { setError(t("请先选择已有渠道，或填写接口地址和实际模型。")); return; }
    setOperation('saving');
    try { await onSave(draft); onClose(); } catch (error) { setError(error instanceof Error ? error.message : t("设置保存未完成，请重试。")); } finally { setOperation(undefined); }
  }
  return <Drawer title={t("设置")} subtitle={t("模型服务、用量与开发者选项")} onClose={onClose} tabs={developerContent && <nav className="drawer-tabs" aria-label={t("设置分类")}><button className={tab==='model'?'selected':''} onClick={()=>setTab('model')}>{t("模型设置")}</button><button className={tab==='developer'?'selected':''} onClick={()=>setTab('developer')}>{t("开发者")}</button></nav>} footer={tab==='model' && <><small>{t("保存设置不会请求模型。")}<br />{t("使用模型时才产生用量。")}</small><button className="btn btn-primary" onClick={() => void save()} disabled={saving}><Icon name="check" size={15} />{operation==='selecting'?t("正在选择…"):operation==='saving'?t("保存中…"):t("保存设置")}</button></>}>
    {tab==='model' && <>
    <section className="form-section"><h3>{t('界面语言')}</h3><label className="form-field"><span>Language / 语言</span><select value={language} disabled={saving} onChange={event=>{const value=event.target.value as InterfaceLanguage;setOperation('saving');setError('');void onLanguageChange(value).catch(error=>setError(error instanceof Error?error.message:t('语言设置尚未保存，请重试。'))).finally(()=>setOperation(undefined));}}><option value="zh-CN">简体中文</option><option value="en">English</option></select></label><p>{t('语言选择立即保存。书籍原文、聊天和已有伙伴资料保持原样。')}</p></section>
    {developerMode&&<section className="form-section"><h3>{t("阅读方式")}</h3><div className="choice-row"><button className={`choice${draft.mode === 'offline' ? ' selected' : ''}`} aria-pressed={draft.mode === 'offline'} onClick={() => patch('mode', 'offline')}><strong><Icon name="leaf" size={16} />{t("界面演示")}</strong><small>{t("使用固定回复体验操作。")}<br />{t("不连接模型服务。")}</small></button><button className={`choice${draft.mode === 'live' ? ' selected' : ''}`} aria-pressed={draft.mode === 'live'} onClick={() => patch('mode', 'live')}><strong><Icon name="spark" size={16} />{t("AI共读")}</strong><small>{t("使用你选择的模型服务。")}<br />{t("跟读和提问会产生用量。")}</small></button></div><p>{t("切换阅读方式建立独立存档，原存档可从阅读存档打开；书籍原文和浏览位置会带入，伙伴理解按新存档实际准备。")}</p></section>}
    <section className="form-section"><h3>{t("数据与隐私")}</h3><div className="callout">{t("书籍、聊天、伙伴理解和体验备注保存在本机阅读存档。AI共读通过本机服务，将获准正文和本题需要的理解、交流发送至所选模型服务，费用按该渠道结算。")}</div><p>{t("此入口支持章节阅读、交流、段评与点赞、安静模式、暂停继续和本机备份。语音、联网搜索与手机外部页面跟随尚未在此入口提供。")}</p><p>{t("密钥由本机服务保存，阅读界面取得配置状态。此入口的共读备份包含原文与理解，目前不导出密钥。")}</p></section>
    <section className="form-section"><div className="side-heading"><h3 style={{ marginBottom: 0 }}>{t("后台整理模型")}</h3><button className="text-action" onClick={() => { setError(''); void onRefreshServices().catch(error => setError(error instanceof Error ? error.message : t("渠道读取失败，请确认本机服务正在运行。"))); }}>{t("刷新服务列表")}<Icon name="history" size={12} /></button></div>
      <label className="form-field"><span>{t("可用模型服务")}</span><select value={selectedService?.id ?? ''} disabled={saving} onChange={event => { const id = event.target.value; if (!id) return; setOperation('selecting'); setError(''); void onUseService(id).then(config => setDraft(previous => ({ ...config, mode: previous.mode, tokenLimit: previous.tokenLimit, pageChars: previous.pageChars }))).catch(error => setError(error instanceof Error ? error.message : t("渠道选择未完成。"))).finally(() => setOperation(undefined)); }}><option value="">{draft.endpoint && draft.model ? t("自定义模型服务") : t("请选择模型服务")}</option>{available.map(service => <option key={`${service.scope}:${service.id}`} value={service.id}>{service.name || service.model} · {service.model} / {service.effort ?? 'high'} · {service.hasKey ? t("已配置") : t("需要配置")}</option>)}</select></label>
      <p>{t("后台使用这里的模型整理书籍资料。每位伙伴交流时使用的模型，在伙伴页面独立绑定。保存设置不会调用模型。")}</p>
      <details className="custom-service"><summary>{t("高级服务设置")}</summary>{nativeService && <p>{t("本机 Luna 服务沿用已有认证和本轮总用量记录，固定为 gpt-6-luna / high。")}<button className="text-action" onClick={() => setDraft(previous => ({ ...previous, serviceId: undefined, endpoint: '', model: '', apiKey: '' }))}>{t("改用自定义接口")}</button></p>}<label className="form-field"><span>{t("兼容 OpenAI 的接口地址")}</span><input type="url" disabled={!!nativeService} value={draft.endpoint} onChange={event => patch('endpoint', event.target.value)} placeholder="https://…/v1" autoComplete="off" /></label><label className="form-field"><span>{t("模型名称")}</span><input disabled={!!nativeService} value={draft.model} onChange={event => patch('model', event.target.value)} placeholder="gpt-6-luna" autoComplete="off" /></label><label className="form-field"><span>{t("API 密钥")}{keyPresent && t("· 本机已配置")}</span><input disabled={!!nativeService} type={showKey ? 'text' : 'password'} value={draft.apiKey} onChange={event => patch('apiKey', event.target.value)} placeholder={keyPresent ? t("留空沿用所选渠道的本机认证") : t("自定义远程接口按需填写")} autoComplete="new-password" /></label><label className="check-choice"><input type="checkbox" checked={showKey} onChange={event => setShowKey(event.target.checked)} />{t("显示本次输入的密钥")}</label></details>
      <details className="custom-service"><summary>{t("模型参数")}</summary><ModelParameterFields service={parameterService} values={draft} disabled={saving} onChange={values => setDraft(previous => ({ ...previous, ...values }))} /></details>
      <div className="selected-model"><span>{t("后台使用的模型")}</span><strong>{draft.model || t("尚未选择")} / {draft.effort}</strong><small>{nativeService?.dataLocation ?? (draft.endpoint || t("尚未选择服务"))}</small></div>
    </section>
    <section className="form-section"><h3>{t("用量上限")}</h3><label className="form-field"><span>{t("当前存档用量上限（万 token）")}</span><input type="number" min={0} step={0.1} value={Number.isFinite(draft.tokenLimit)?draft.tokenLimit/10000:''} onChange={event => patch('tokenLimit', tokensFromWan(event.target.value))} /></label><p>{t("本轮历史用量和未结算预留继续累计，修改上限不清账。后台单次输出和上下文容量在上方「模型参数」中设置。")}</p></section>
    </>}
    {tab==='developer' && <>{!modelReady && <div className="callout amber">{t("开始自动伴读前，请先设置后台整理使用的模型。")}<button className="text-action" onClick={()=>setTab('model')}>{t("前往模型设置")}</button></div>}{developerContent}</>}
    {error && <div className="callout amber" role="alert">{workbenchErrorLabel(error)}</div>}
  </Drawer>;
}
