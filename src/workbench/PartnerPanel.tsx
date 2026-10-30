import { t, interfaceLanguage } from './i18n.ts';
import { useEffect, useRef, useState } from 'react';
import type { WorkbenchClient, WorkbenchSnapshot } from './contract.ts';
import { getPartnerPersonaSnapshot, getPartnerPersonaSummary, getPartnerPersonaParameters, personaReadableText } from '../core/partner-persona.ts';
import type { ModelParameterPatch, PartnerPersonaParameters } from '../core/types.ts';
import { DEFAULT_PERSONA_TEMPLATE_ID, personaTemplates } from '../core/persona-templates.ts';
import { workbenchErrorLabel } from './copy.ts';
import { Dialog } from './components.tsx';
import { Icon } from './icons.tsx';
import { PartnerAvatar, avatarPresets } from './PartnerAvatar.tsx';
import { avatarCropBox, cropAvatar, initialAvatarCrop, loadAvatarImage } from './avatar-crop.ts';
import type { AvatarImage, AvatarCrop } from './avatar-crop.ts';
import { ModelParameterFields, modelParameterError } from './ModelParameterFields.tsx';
import type { ModelParameterValues } from './ModelParameterFields.tsx';

type PartnerTab = 'about' | 'relationship' | 'memories';
type ProfileDraft = { name: string; userAddress: string; partnerAddress: string; relationshipRequests: string; backgroundPersona: boolean; limitAutomaticRequests: boolean; persona: Required<PartnerPersonaParameters>; fixedPersona: Array<keyof PartnerPersonaParameters>; modelServiceId: string; modelParameters: ModelParameterValues };
const personaFields: { key: keyof PartnerPersonaParameters; label: string; hint: string }[] = [
  { key: 'identityBackground', get label(){return t("身份与背景");}, get hint(){return t("身份、来历与生活背景");} },
  { key: 'values', get label(){return t("价值观");}, get hint(){return t("在意的事情与判断原则");} },
  { key: 'thinking', get label(){return t("思考方式");}, get hint(){return t("观察、理解与分析事情的方式");} },
  { key: 'interests', get label(){return t("兴趣与偏好");}, get hint(){return t("阅读兴趣与个人偏好");} },
  { key: 'emotions', get label(){return t("情绪与反应");}, get hint(){return t("情绪倾向与回应方式");} },
  { key: 'boundaries', get label(){return t("相处边界");}, get hint(){return t("个人界限与相处分寸");} },
  { key: 'expression', get label(){return t("表达方式");}, get hint(){return t("语气、用词与交流习惯");} },
];
const tabLabels: { id: PartnerTab; label: string }[] = [{ id: 'about', get label(){return t("伙伴介绍");} }, { id: 'relationship', get label(){return t("相处方式");} }, { id: 'memories', get label(){return t("共同经历");} }];

export function PartnerPanel({ client, snapshot, onClose }: { client: WorkbenchClient; snapshot: WorkbenchSnapshot; onClose: () => void }) {
  const state = snapshot.app.state, partner = state.partners.find(item => item.id === state.partnerId);
  const profile = profileDraft(snapshot);
  const [draft, setDraft] = useState(profile), [tab, setTab] = useState<PartnerTab>('about');
  const [templateMode, setTemplateMode] = useState<'create' | 'adopt'>(), [templateId, setTemplateId] = useState(interfaceLanguage()==='en'?'yu-xiaoyu-en':DEFAULT_PERSONA_TEMPLATE_ID);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [saving, setSaving] = useState(false), [switching, setSwitching] = useState(false);
  const [nextAction, setNextAction] = useState<{ action: () => void }>();
  const [image, setImage] = useState<AvatarImage>(), [crop, setCrop] = useState<AvatarCrop>(initialAvatarCrop), [decoding, setDecoding] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null), page = useRef<HTMLElement>(null), pickerSequence = useRef(0);
  const close = useRef<() => void>(() => {}), mounted = useRef(true);
  const dirty = JSON.stringify(draft) !== JSON.stringify(profile);
  const busy = saving || decoding;
  const persona = partner ? getPartnerPersonaSnapshot(state, partner.id) : undefined;
  const personaSummary = persona ? getPartnerPersonaSummary(persona) : '';
  const availableServices = snapshot.services.filter(service => !service.binding && (service.scope === 'workbench' || !snapshot.services.some(other => other.id === service.id && other.scope === 'workbench')));
  const selectedModelService = draft.modelServiceId === 'bound' ? undefined : availableServices.find(service => service.id === draft.modelServiceId);
  const boundModelService = partner?.modelService;
  const parameterService = selectedModelService ?? boundModelService;
  const template = personaTemplates.find(item => item.id === templateId) ?? personaTemplates[0];
  const savedThemes = state.partnerThemes?.filter(item => item.partnerId === partner?.id) ?? [];
  const previousThemes = new Set(savedThemes.map(item => item.previousId).filter(Boolean));
  const themes = savedThemes.filter(item => !previousThemes.has(item.id) && !item.retired);
  const memories = state.memories.filter(item => item.partnerId === partner?.id && !item.forgotten && !item.invalidatedBy && !item.replacedBy && !item.historicalOnly);
  const assistantCounts=new Map((snapshot.app.conversationStatistics?.byBookPartner??[]).filter(item=>item.partnerId===partner?.id).map(item=>[item.bookId,item.assistantCount]));
  const books = state.books.map(book => ({ book, memories: memories.filter(item => item.bookId === book.id), assistantCount:assistantCounts.get(book.id)??0 })).filter(item => item.memories.length || item.assistantCount);
  const currentPartnerId = useRef(partner?.id);
  const previousProfile = useRef(profile);
  const partnerDrafts = useRef(new Map<string, { draft: ProfileDraft; profile: ProfileDraft }>());

  useEffect(() => {
    if (currentPartnerId.current === partner?.id) return;
    if (currentPartnerId.current) partnerDrafts.current.set(currentPartnerId.current, { draft, profile: previousProfile.current });
    currentPartnerId.current = partner?.id;
    previousProfile.current = profile;
    const cached = partner?.id ? partnerDrafts.current.get(partner.id) : undefined;
    setDraft(cached ? mergeProfileDraft(cached.draft, cached.profile, profile) : profile); setTemplateMode(undefined); setImage(undefined); setError(''); setNotice(''); setDecoding(false);
    pickerSequence.current++;
  }, [partner?.id]);
  useEffect(() => {
    const previous = previousProfile.current;
    previousProfile.current = profile;
    setDraft(current => mergeProfileDraft(current, previous, profile));
  }, [partner?.id, JSON.stringify(profile)]);
  useEffect(() => () => { if (image) URL.revokeObjectURL(image.url); }, [image]);
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement as HTMLElement | null;
    page.current?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (Array.from(document.querySelectorAll('[role="dialog"]')).at(-1) !== page.current) return;
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key === 'Tab') {
        const controls = Array.from(page.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]):not([hidden]),textarea:not([disabled]),select:not([disabled]),summary,[tabindex="0"]') ?? []).filter(element => element.getClientRects().length);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === page.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === page.current)) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { mounted.current = false; pickerSequence.current++; document.removeEventListener('keydown', key); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);

  function continueWith(action: () => void) { if (busy) return; if (dirty) setNextAction({ action }); else action(); }
  close.current = () => continueWith(onClose);
  async function run(action: () => Promise<unknown>, message: string, changePartner = false) {
    if (changePartner) setSwitching(true); else setSaving(true);
    setError(''); setNotice('');
    try { await action(); if (mounted.current) setNotice(message); return true; }
    catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : t("这次修改尚未保存，请重试。")); return false; }
    finally { if (mounted.current) { if (changePartner) setSwitching(false); else setSaving(false); } }
  }
  async function saveProfile() {
    if (!partner || !draft.name.trim()) { setError(t("请填写伙伴的显示名。")); return false; }
    if (draft.modelServiceId !== 'bound' && !selectedModelService) { setError(t("所选模型服务已发生变化，请刷新列表后重新选择。")); return false; }
    const cleaned: ProfileDraft = { ...draft, name: draft.name.trim(), userAddress: draft.userAddress.trim(), partnerAddress: draft.partnerAddress.trim(), relationshipRequests: draft.relationshipRequests.trim(), persona: { identityBackground: draft.persona.identityBackground.trim(), values: draft.persona.values.trim(), thinking: draft.persona.thinking.trim(), interests: draft.persona.interests.trim(), emotions: draft.persona.emotions.trim(), boundaries: draft.persona.boundaries.trim(), expression: draft.persona.expression.trim() } };
    const { name, modelServiceId, modelParameters, ...preferences } = cleaned;
    const parametersChanged = modelServiceId !== 'bound' || JSON.stringify(modelParameters) !== JSON.stringify(profile.modelParameters);
    if (parametersChanged && parameterService) { const parameterError = modelParameterError({ ...parameterService, effort: draft.modelParameters.effort }, draft.modelParameters); if (parameterError) { setError(parameterError); return false; } }
    const parameterPatch: ModelParameterPatch = { ...modelParameters, temperature: modelParameters.temperature ?? null, topP: modelParameters.topP ?? null };
    const saved = await run(() => client.updatePartnerProfile(partner.id, { name, preferences: { ...partner.preferences, ...preferences }, ...(modelServiceId !== 'bound' ? { modelServiceId } : {}), ...(parametersChanged ? { modelParameters: parameterPatch } : {}) }), t("相处设置已保存。"));
    if (saved) { const savedDraft = profileDraft(client.getSnapshot(), partner.id); setDraft(savedDraft); partnerDrafts.current.set(partner.id, { draft: savedDraft, profile: savedDraft }); }
    return saved;
  }
  async function chooseImage(file: File) {
    const sequence = ++pickerSequence.current;
    setDecoding(true); setError('');
    try {
      const selected = await loadAvatarImage(file);
      if (sequence !== pickerSequence.current || !mounted.current) { URL.revokeObjectURL(selected.url); return; }
      setImage(selected); setCrop({ ...initialAvatarCrop });
    } catch (error) { if (sequence === pickerSequence.current && mounted.current) setError(error instanceof Error ? error.message : t("图片无法打开，请重新选择。")); }
    finally { if (sequence === pickerSequence.current && mounted.current) setDecoding(false); }
  }
  async function saveImage() {
    if (!partner || !image) return;
    let dataUrl: string;
    try { dataUrl = cropAvatar(image, crop); } catch (error) { setError(error instanceof Error ? error.message : t("图片裁剪未完成，请重试。")); return; }
    if (await run(() => client.setPartnerAvatar(partner.id, dataUrl), t("头像已保存。"))) setImage(undefined);
  }
  const cropBox = image ? avatarCropBox(image, crop, 240) : undefined;

  return <section className="partner-page" role="dialog" aria-modal="true" aria-label={t("阅读伙伴")} tabIndex={-1} ref={page}>
    <header className="partner-page-header"><button className="btn btn-subtle partner-back" disabled={busy} onClick={() => continueWith(onClose)}><Icon name="arrow" size={17} />{t("返回阅读")}</button><span>{t("阅读伙伴")}</span><small>{t("伙伴的经历随共读继续保存")}</small></header>
    <div className="partner-page-layout">
      <aside className="partner-rail" aria-label={t("我的伙伴")}><h2>{t("我的伙伴")}</h2><div className="partner-list">{state.partners.map(item => <button key={item.id} className={`partner-list-item${item.id === partner?.id ? ' selected' : ''}`} disabled={busy || switching} aria-pressed={item.id === partner?.id} onClick={() => { if (item.id === partner?.id) { setTemplateMode(undefined); return; } continueWith(() => { void run(() => client.selectPartner(item.id), t("已切换伙伴。"), true); }); }}><PartnerAvatar client={client} avatar={item.avatar} name={item.name} size={39} /><span><strong>{item.name}</strong><small>{item.id === partner?.id ? t("当前伙伴") : t("切换到这位伙伴")}</small></span>{item.id === partner?.id && <Icon name="check" size={14} />}</button>)}</div><button className="btn btn-outline partner-new" disabled={busy || switching} onClick={() => continueWith(() => setTemplateMode('create'))}><Icon name="plus" size={15} />{t("认识新伙伴")}</button><p className="partner-rail-note">{t("每位伙伴各自保存人格与经历，可以随时切换回来。")}</p></aside>
      <main className="partner-main">
        {switching && <p className="partner-feedback partner-switching" role="status"><Icon name="clock" size={15} />{t("正在保存当前共读，随后切换伙伴…")}</p>}{error && <div className="callout amber partner-feedback" role="alert">{workbenchErrorLabel(error)}</div>}{notice && <p className="partner-feedback partner-success" role="status"><Icon name="check" size={15} />{notice}</p>}
        {templateMode ? <>
          <div className="partner-section-heading"><div><p className="partner-eyebrow">{templateMode === 'adopt' ? t("为当前伙伴选择初始人格") : t("认识新伙伴")}</p><h1>{t("从一份完整介绍开始")}</h1><p>{templateMode === 'adopt' ? t("采用后，当前伙伴会从这份人格接续相处，已有记录继续保存。") : t("选择人格后建立另一位伙伴，原伙伴和经历继续保留。")}</p></div><button className="text-action" disabled={busy} onClick={() => setTemplateMode(undefined)}>{t("返回当前伙伴")}<Icon name="chevron" size={12} /></button></div>
          <div className="persona-choices" aria-label={t("初始人格")}>{[...personaTemplates].sort((a,b)=>interfaceLanguage()==='en'?Number(b.id==='yu-xiaoyu-en')-Number(a.id==='yu-xiaoyu-en'):0).map(item => <button key={item.id} className={`persona-choice${templateId === item.id ? ' selected' : ''}`} aria-pressed={templateId === item.id} disabled={busy} onClick={() => setTemplateId(item.id)}><PartnerAvatar client={client} avatar={item.avatar} name={item.name} size={46} /><strong>{t(item.name)}</strong><small>{item.id==='yu-xiaoyu-en'?'English':t('中文人格')}</small>{item.id === (interfaceLanguage()==='en'?'yu-xiaoyu-en':DEFAULT_PERSONA_TEMPLATE_ID) && <small>{t("默认初始人格")}</small>}{templateId === item.id && <Icon name="check" size={15} />}</button>)}</div>
          {template && <section className="partner-card persona-introduction"><div className="partner-card-heading"><div><h2>{t(template.name)}</h2><p>{t("初始人格")}</p></div><button className="btn btn-primary" disabled={busy || switching || !partner && templateMode === 'adopt'} onClick={() => { void run(async () => { if (templateMode === 'adopt' && partner) await client.adoptPartnerPersona(partner.id, template.id); else {const id=await client.createPartner(template.id);await client.selectPartner(id);} setTemplateMode(undefined); setTab('about'); }, templateMode === 'adopt' ? t("当前伙伴已采用所选人格。") : t("新伙伴已建立。"), templateMode === 'create'); }}>{templateMode === 'adopt' ? t("当前伙伴采用这个人格") : t("选择{0}",t(template.name))}<Icon name="arrow" size={15} /></button></div><p className="partner-persona-summary">{getPartnerPersonaSummary({ name: template.name, text: template.text, partnerId: template.id, preferences: {} })}</p><details className="partner-persona-details" key={template.id}><summary>{t("查看完整人格")}<Icon name="chevron" size={14} /></summary><PersonaText text={template.text} /></details></section>}
        </> : partner ? <>
          <div className="partner-hero"><PartnerAvatar client={client} avatar={partner.avatar} name={partner.name} size={82} /><div><p className="partner-eyebrow">{t("当前阅读伙伴")}</p><h1>{partner.name}</h1><p>{personaSummary || t("为这位伙伴选择人格，或先设置彼此的称呼。")}</p></div></div>
          <nav className="partner-tabs" aria-label={t("伙伴资料")}>{tabLabels.map(item => <button key={item.id} className={tab === item.id ? 'selected' : ''} aria-current={tab === item.id ? 'page' : undefined} onClick={() => setTab(item.id)}>{item.label}</button>)}</nav>
          {tab === 'about' && <>
            <section className="partner-card persona-introduction"><div className="partner-card-heading"><div><h2>{t("认识")}{partner.name}</h2><p>{t("展开后查看完整设定，具体设置在「相处方式」中修改。")}</p></div>{!persona?.personaVersionId && <button className="btn btn-outline btn-small" disabled={busy} onClick={() => continueWith(() => setTemplateMode('adopt'))}>{t("选择初始人格")}<Icon name="chevron" size={13} /></button>}</div>{persona?.text?.trim() ? <details className="partner-persona-details" key={partner.id}><summary>{t("查看完整人格")}<Icon name="chevron" size={14} /></summary><PersonaText text={persona.text} /></details> : <div className="partner-empty"><Icon name="leaf" size={27} /><h3>{t("从初始人格认识彼此")}</h3><p>{t("选择并采用一份完整人格后，会在这里展示这位伙伴的介绍。")}</p></div>}</section>
            <p className="partner-section-note">{t("介绍中的初始背景属于角色设定。实际共读、交流与个人体会在「共同经历」中记录。")}</p>
          </>}
          {tab === 'relationship' && <>
            <section className="partner-card partner-model-card"><div className="partner-card-heading"><div><h2>{t("使用的模型")}</h2><p>{t("为这位伙伴明确选择模型。后台整理的独立模型在「设置」中配置。")}</p></div><button className="text-action" disabled={busy} onClick={() => { setError(''); void client.refreshServices().catch(error => setError(error instanceof Error ? error.message : t("模型服务列表刷新失败，请重试。"))); }}>{t("刷新服务列表")}<Icon name="history" size={12} /></button></div>
              {boundModelService ? <div className="partner-bound-model"><span>{t("当前绑定")}</span><strong>{boundModelService.model} / {boundModelService.effort}</strong><small>{boundModelService.name || boundModelService.model}</small></div> : <p className="form-hint partner-unbound-model">{t("尚未绑定模型，请选择模型服务并保存。")}</p>}
              <label className="form-field"><span>{t("伙伴模型服务")}</span><select value={draft.modelServiceId} disabled={busy || !availableServices.length} onChange={event => { const id = event.target.value, service = id === 'bound' ? boundModelService : availableServices.find(item => item.id === id); setDraft(previous => ({ ...previous, modelServiceId: id, modelParameters: parametersForService(service, snapshot) })); }}><option value="bound">{boundModelService ? t("保持当前绑定：{0} / {1}",boundModelService.model,boundModelService.effort) : t("请选择模型服务")}</option>{draft.modelServiceId !== 'bound' && !selectedModelService && <option value={draft.modelServiceId} disabled>{t("所选服务已变化，请重新选择")}</option>}{availableServices.map(service => <option key={`${service.scope}:${service.id}`} value={service.id}>{service.name || service.model} · {service.model} / {service.effort ?? 'high'} · {service.hasKey ? t("已配置") : t("需要配置")}</option>)}</select></label>
              {selectedModelService && <p className="form-hint partner-model-selection" role="status">{t("保存后使用：")}{selectedModelService.model} / {selectedModelService.effort ?? 'high'}{t("。选择同名服务也会更新这位伙伴保存的模型配置。")}</p>}
              {!availableServices.length && <p className="form-hint">{t("先到「设置」添加模型服务，再回到这里刷新并选择。")}</p>}
              {parameterService && <details className="partner-model-parameters"><summary>{t("模型参数")}<Icon name="chevron" size={14} /></summary><ModelParameterFields service={{ ...parameterService, effort: draft.modelParameters.effort }} values={draft.modelParameters} disabled={busy} onChange={modelParameters => setDraft(previous => ({ ...previous, modelParameters }))} /><p className="form-hint">{t("保存后仅更新这位伙伴的模型绑定。其他伙伴和后台模型分别保存。")}</p></details>}
            </section>
            <section className="partner-card"><div className="partner-card-heading"><div><h2>{t("头像与称呼")}</h2><p>{t("显示名与彼此称呼可以分别设置。")}</p></div></div><div className="partner-avatar-editor"><PartnerAvatar client={client} avatar={partner.avatar} name={draft.name || partner.name} size={76} /><div className="partner-avatar-options"><div className="avatar-presets" aria-label={t("预设头像")}>{avatarPresets.map(item => <button key={item.id} className={`avatar-preset${partner.avatar?.kind === 'preset' && partner.avatar.id === item.id ? ' selected' : ''}`} aria-label={t("使用{0}头像",item.label)} title={item.label} aria-pressed={partner.avatar?.kind === 'preset' && partner.avatar.id === item.id} disabled={busy} onClick={() => { void run(() => client.updatePartnerProfile(partner.id, { avatar: { kind: 'preset', id: item.id } }), t("头像已保存。")); }}><PartnerAvatar client={client} avatar={{ kind: 'preset', id: item.id }} name={draft.name || partner.name} size={39} /></button>)}</div><button className="text-action" disabled={busy} onClick={() => fileInput.current?.click()}>{decoding ? t("正在打开图片…") : t("上传并裁剪头像")}<Icon name="chevron" size={12} /></button><input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void chooseImage(file); }} /></div></div>
            <label className="form-field"><span>{t("伙伴显示名")}</span><input disabled={busy} value={draft.name} maxLength={100} onChange={event => setDraft(previous => ({ ...previous, name: event.target.value }))} /></label><div className="form-grid"><label className="form-field"><span>{t("伙伴怎样称呼你")}</span><input disabled={busy} value={draft.userAddress} maxLength={100} onChange={event => setDraft(previous => ({ ...previous, userAddress: event.target.value }))} placeholder={t("选填，按你的习惯设置")} /></label><label className="form-field"><span>{t("你怎样称呼伙伴")}</span><input disabled={busy} value={draft.partnerAddress} maxLength={100} onChange={event => setDraft(previous => ({ ...previous, partnerAddress: event.target.value }))} placeholder={t("选填，例如昵称")} /></label></div></section>
            <section className="partner-card"><div className="partner-card-heading"><div><h2>{t("相处要求")}</h2><p>{t("希望伙伴了解的交流习惯与相处边界。")}</p></div></div><label className="form-field"><span>{t("写下你希望怎样相处")}</span><textarea disabled={busy} value={draft.relationshipRequests} rows={5} maxLength={4000} onChange={event => setDraft(previous => ({ ...previous, relationshipRequests: event.target.value }))} placeholder={t("可以随时补充或修改")} /></label></section>
            <section className="partner-card"><div className="partner-background-setting"><div><label htmlFor="partner-limit-automatic">{t("减少自动请求")}</label><p>{t("合并一段阅读后的自动思考，降低用量。你主动聊天或邀请回复时照常回应。开启后可能错过一些短暂细节；关闭后伙伴会更频繁地参与，也会增加消耗。")}</p></div><button id="partner-limit-automatic" className="switch" type="button" role="switch" aria-label={t("减少自动请求")} aria-checked={draft.limitAutomaticRequests} disabled={busy} onClick={() => setDraft(previous => ({ ...previous, limitAutomaticRequests: !previous.limitAutomaticRequests }))}><span /></button></div></section>
            <details className="partner-card partner-advanced" key={partner.id}>
              <summary><span><strong>{t("高级参数")}</strong><small>{t("修改当前人格与后台整理方式")}</small></span><Icon name="chevron" size={16} /></summary>
              <div className="partner-advanced-content">
                <div className="partner-background-setting"><div><label htmlFor="partner-background-persona">{t("后台整理使用伙伴人格")}</label><p>{t("默认关闭。开启后，后台参考人格整理认识，并可从真实经历修订未固定的倾向。关闭时保留书籍资料与已有发言，不修改人格。前台交流始终使用所选人格。")}</p></div><button id="partner-background-persona" className="switch" type="button" role="switch" aria-label={t("后台整理使用伙伴人格")} aria-checked={draft.backgroundPersona} disabled={busy} onClick={() => setDraft(previous => ({ ...previous, backgroundPersona: !previous.backgroundPersona }))}><span /></button></div>
                <p className="form-hint partner-persona-hint">{t("这里可修改人格的七个维度，留空沿用完整设定。保存文字会形成一次人格修订；身份背景由你明确修改，其他未固定的倾向可随真实经历发展。共同经历继续保留。")}</p>
                <div className="partner-persona-fields">{personaFields.map(field => <div className="partner-persona-dimension" key={field.key}><div className="partner-persona-dimension-heading"><label htmlFor={`partner-persona-${field.key}`}>{field.label}</label>{field.key==='identityBackground'?<small>{t("仅由你修改")}</small>:<label className="check-choice"><input type="checkbox" disabled={busy} checked={draft.fixedPersona.includes(field.key)} onChange={event => { const checked = event.target.checked; setDraft(previous => ({ ...previous, fixedPersona: personaFields.filter(item => item.key === field.key ? checked : previous.fixedPersona.includes(item.key)).map(item => item.key) })); }} />{t("长期保持")}</label>}</div><textarea id={`partner-persona-${field.key}`} aria-label={field.label} disabled={busy} value={draft.persona[field.key]} rows={3} maxLength={4000} onChange={event => setDraft(previous => ({ ...previous, persona: { ...previous.persona, [field.key]: event.target.value } }))} placeholder={t("选填：{0}",field.hint)} /></div>)}</div>
              </div>
            </details>
            <div className="partner-save-row"><small>{dirty ? t("有修改等待保存") : t("相处设置已保存")}</small><button className="btn btn-primary" disabled={busy || !dirty || !draft.name.trim()} onClick={() => void saveProfile()}><Icon name="check" size={15} />{saving ? t("保存中…") : t("保存相处设置")}</button></div>
          </>}
          {tab === 'memories' && <>
            <section className="partner-card"><div className="partner-card-heading"><div><h2>{t("实际经历")}</h2><p>{t("来自这位伙伴已经保存的阅读理解与实际回复。")}</p></div></div>{books.length ? <div className="partner-experience-list">{books.map(item => <article key={item.book.id}><span className="partner-book-icon"><Icon name="book" size={20} /></span><div><h3>{item.book.title}</h3><p>{[item.memories.length ? t("{0} 份已保存理解",item.memories.length) : '', item.assistantCount ? t("{0} 条实际回复",item.assistantCount) : ''].filter(Boolean).join(' · ')}</p></div></article>)}</div> : <div className="partner-empty"><Icon name="book" size={27} /><h3>{t("共同经历从共读开始")}</h3><p>{t("这位伙伴尚未保存阅读理解或实际回复。之后的经历会在这里出现。")}</p></div>}</section>
            <section className="partner-card"><div className="partner-card-heading"><div><h2>{t("个人主题")}</h2><p>{t("从具体阅读与交流中逐渐形成、持续发展的个人体会。")}</p></div></div>{themes.length ? <div className="partner-theme-list">{themes.map(theme => <details key={theme.id}><summary><span>{theme.title}</span><Icon name="chevron" size={14} /></summary><p>{theme.summary}</p><PersonaText text={theme.text} /></details>)}</div> : <div className="partner-empty"><Icon name="leaf" size={27} /><h3>{t("体会会随经历慢慢积累")}</h3><p>{t("当前尚未形成个人主题，有实际依据的体会会持续保存在这里。")}</p></div>}</section>
          </>}
        </> : <div className="partner-empty"><h1>{t("选择一位阅读伙伴")}</h1><button className="btn btn-primary" onClick={() => setTemplateMode('create')}>{t("认识新伙伴")}</button></div>}
      </main>
    </div>
    {nextAction && <Dialog title={t("保存相处设置")} onClose={() => setNextAction(undefined)}><p className="form-hint">{t("当前有修改等待保存，可以保存后继续，也可以放弃这次编辑。")}</p>{error && <p className="callout amber" role="alert">{workbenchErrorLabel(error)}</p>}<div className="dialog-actions"><button className="btn btn-subtle" disabled={busy} onClick={() => setNextAction(undefined)}>{t("继续编辑")}</button><button className="btn btn-outline" disabled={busy} onClick={() => { const next = nextAction.action; setDraft(profile); setNextAction(undefined); next(); }}>{t("放弃修改并继续")}</button><button className="btn btn-primary" disabled={busy || !draft.name.trim()} onClick={() => { void (async () => { if (await saveProfile()) { const next = nextAction.action; setNextAction(undefined); next(); } })(); }}>{t("保存并继续")}</button></div></Dialog>}
    {image && cropBox && <Dialog title={t("裁剪头像")} onClose={() => { if (!saving) setImage(undefined); }}><p className="form-hint">{t("调整缩放与位置，圆形区域就是头像效果。")}</p><div className="avatar-crop-preview"><img src={image.url} alt={t("头像裁剪预览")} draggable={false} style={cropBox} /></div><label className="avatar-crop-control"><span>{t("缩放")}</span><input type="range" min="1" max="3" step="0.01" value={crop.zoom} disabled={saving} onChange={event => setCrop(previous => ({ ...previous, zoom: Number(event.target.value) }))} /></label><label className="avatar-crop-control"><span>{t("左右位置")}</span><input type="range" min="0" max="100" step="1" value={crop.x} disabled={saving} onChange={event => setCrop(previous => ({ ...previous, x: Number(event.target.value) }))} /></label><label className="avatar-crop-control"><span>{t("上下位置")}</span><input type="range" min="0" max="100" step="1" value={crop.y} disabled={saving} onChange={event => setCrop(previous => ({ ...previous, y: Number(event.target.value) }))} /></label>{error && <p className="callout amber" role="alert">{workbenchErrorLabel(error)}</p>}<div className="dialog-actions"><button className="btn btn-outline" disabled={saving} onClick={() => setImage(undefined)}>{t("取消")}</button><button className="btn btn-primary" disabled={saving} onClick={() => void saveImage()}>{saving ? t("保存中…") : t("使用这张头像")}</button></div></Dialog>}
  </section>;
}

function mergeProfileDraft(draft: ProfileDraft, previous: ProfileDraft, current: ProfileDraft): ProfileDraft {
  const merge = <T extends object>(editing: T, before: T, saved: T): T => Object.fromEntries(Object.keys(saved).map(key => {
    const field = key as keyof T;
    return [key, JSON.stringify(editing[field]) === JSON.stringify(before[field]) ? saved[field] : editing[field]];
  })) as T;
  return { ...merge(draft, previous, current), persona: merge(draft.persona, previous.persona, current.persona), modelParameters: draft.modelServiceId === 'bound' ? merge(draft.modelParameters, previous.modelParameters, current.modelParameters) : draft.modelParameters };
}

function parametersForService(service: { effort?: ModelParameterValues['effort']; maxOutput?: number; contextLimit?: number; temperature?: number; topP?: number } | undefined, snapshot: WorkbenchSnapshot): ModelParameterValues {
  return { effort: service?.effort ?? snapshot.settings.effort, maxOutput: service?.maxOutput ?? snapshot.settings.maxOutput, contextLimit: service?.contextLimit ?? snapshot.settings.contextLimit, temperature: service?.temperature, topP: service?.topP };
}
function profileDraft(snapshot: WorkbenchSnapshot, partnerId = snapshot.app.state.partnerId): ProfileDraft {
  const state = snapshot.app.state, partner = state.partners.find(item => item.id === partnerId);
  const persona: PartnerPersonaParameters = partner ? getPartnerPersonaParameters(getPartnerPersonaSnapshot(state, partner.id)) : {};
  return { name: partner?.name ?? '', userAddress: partner?.preferences?.userAddress ?? '', partnerAddress: partner?.preferences?.partnerAddress ?? '', relationshipRequests: partner?.preferences?.relationshipRequests ?? '', backgroundPersona: partner?.preferences?.backgroundPersona === true, limitAutomaticRequests: partner?.preferences?.limitAutomaticRequests !== false,
    persona: { identityBackground: persona.identityBackground ?? '', values: persona.values ?? '', thinking: persona.thinking ?? '', interests: persona.interests ?? '', emotions: persona.emotions ?? '', boundaries: persona.boundaries ?? '', expression: persona.expression ?? '' },
    fixedPersona: personaFields.filter(field => partner?.preferences?.fixedPersona?.includes(field.key)).map(field => field.key), modelServiceId: 'bound', modelParameters: parametersForService(partner?.modelService, snapshot) };
}

function PersonaText({ text }: { text: string }) {
  const sections = personaReadableText(text).split(/(^#{1,6} .+$)/m).flatMap(section => /^#{1,6}\s/.test(section) ? [section] : section.split(/\n\s*\n/)).map(section => section.trim()).filter(Boolean);
  return <div className="persona-prose">{sections.map((paragraph, index) => /^#{1,6}\s/.test(paragraph) ? <h3 key={index}>{paragraph.replace(/^#{1,6}\s+/, '')}</h3> : <p key={index}>{paragraph}</p>)}</div>;
}
