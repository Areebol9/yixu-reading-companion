import { t } from './i18n.ts';
import type { ModelEffort, Service } from '../core/types.ts';
import { modelParameterSupport } from '../core/model-parameters.ts';
import { tokensFromWan } from './token-display.ts';

export type ModelParameterValues = { effort: ModelEffort; maxOutput: number; contextLimit: number; temperature?: number; topP?: number };
type ParameterService = Pick<Service, 'baseUrl' | 'model' | 'thinking' | 'effort'> & { id?: string };

export function modelParameterError(service: ParameterService, values: ModelParameterValues): string | undefined {
  if (![values.maxOutput, values.contextLimit].every(value => Number.isSafeInteger(value) && value > 0)) return t("请为单次输出和上下文上限填写大于零的 token 数。");
  const support = modelParameterSupport({ ...service, effort: values.effort });
  for (const [key, label, range] of [['temperature', t("生成变化程度"), support.temperature], ['topP', t("候选范围"), support.topP]] as const) {
    const value = values[key];
    if (value === undefined) continue;
    if (!range) return t("当前渠道与型号不支持已保存的采样设置，请在「模型参数」中清除不适用的采样设置。");
    if (!Number.isFinite(value) || value < range.min || value > range.max) return t("{0}请填写 {1}～{2} 之间的数值，或留空使用服务默认值。",label,range.min,range.max);
  }
}

export function ModelParameterFields({ service, values, disabled, onChange }: { service: ParameterService; values: ModelParameterValues; disabled?: boolean; onChange: (values: ModelParameterValues) => void }) {
  const support = modelParameterSupport({ ...service, effort: values.effort });
  const unsupportedSampling = (!support.temperature && values.temperature !== undefined) || (!support.topP && values.topP !== undefined);
  const efforts = [...new Set([...(support.efforts.length ? support.efforts : [values.effort]), values.effort])];
  const patch = <K extends keyof ModelParameterValues>(key: K, value: ModelParameterValues[K]) => onChange({ ...values, [key]: value });
  return <div className="model-parameter-fields">
    <p className="form-hint">{t(support.note)}</p>
    {unsupportedSampling && <p className="form-hint">{t("此配置中有当前渠道与型号不支持的采样设置。")}<button className="text-action" type="button" disabled={disabled} onClick={() => onChange({ ...values, temperature: support.temperature ? values.temperature : undefined, topP: support.topP ? values.topP : undefined })}>{t("清除不适用的采样设置")}</button></p>}
    <div className="form-grid">
      {support.efforts.length>0&&<label className="form-field"><span>{t("思考强度")}</span><select disabled={disabled || support.efforts.length < 2} value={values.effort} onChange={event => patch('effort', event.target.value as ModelEffort)}>{efforts.map(effort => <option key={effort} value={effort}>{effort.charAt(0).toUpperCase() + effort.slice(1)}{!support.efforts.includes(effort) && support.efforts.length > 0 ? t("（已有配置）") : ''}</option>)}</select></label>}
      {support.temperature && <label className="form-field"><span>{t("生成变化程度（temperature）")}</span><input type="number" min={support.temperature.min} max={support.temperature.max} step="0.01" disabled={disabled} value={values.temperature ?? ''} placeholder={t("服务默认值")} onChange={event => patch('temperature', event.target.value === '' ? undefined : Number(event.target.value))} /></label>}
      {support.topP && <label className="form-field"><span>{t("候选范围（top_p）")}</span><input type="number" min={support.topP.min} max={support.topP.max} step="0.01" disabled={disabled} value={values.topP ?? ''} placeholder={t("服务默认值")} onChange={event => patch('topP', event.target.value === '' ? undefined : Number(event.target.value))} /></label>}
      <label className="form-field"><span>{t("单次模型输出上限（万 token）")}</span><input type="number" min={0.0001} step={0.0001} disabled={disabled} value={Number.isFinite(values.maxOutput) ? values.maxOutput / 10000 : ''} onChange={event => patch('maxOutput', tokensFromWan(event.target.value))} /></label>
      <label className="form-field"><span>{t("模型上下文上限（万 token）")}</span><input type="number" min={0.0001} step={0.1} disabled={disabled} value={Number.isFinite(values.contextLimit) ? values.contextLimit / 10000 : ''} onChange={event => patch('contextLimit', tokensFromWan(event.target.value))} /></label>
    </div>
    <p className="form-hint">{t("单次输出上限包含模型思考与实际输出，和回复字数分别计算。采样参数留空时沿用服务默认值。")}</p>
  </div>;
}
