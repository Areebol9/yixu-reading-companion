import { t, interfaceLanguage, isInterfaceMessage } from './i18n.ts';
import type { ReadingRecoveryCapability } from '../core/types.ts';

/** User-facing wording only. Original diagnostic messages stay in process records. */
export function workbenchErrorLabel(text: string): string {
  if(isInterfaceMessage(text))return t(text);
  if (/当前伙伴尚未绑定可用模型/.test(text)) return t("请在伙伴页面为这位伙伴选择模型并保存。你仍可以阅读和查看已有记录。");
  if (/后台整理尚未设置可用模型/.test(text)) return t("请在“模型设置”中选择后台整理使用的模型并保存。");
  if (/尚未设置可用的模型|请先配置并启用模型/.test(text)) return t("开始伴读前，请先在“模型设置”中选择服务并保存。你仍可以阅读和查看已有记录。");
  if (/保存.{0,12}(失败|未完成)|未.{0,4}保存|save-failed|save failed|persist.{0,8}fail/i.test(text)) return t("这次内容尚未保存成功。请保留正在编辑的内容，并查看处理详情。");
  if (/仍由当前执行者处理|请求.{0,8}(处理中|正在执行)|in.flight/i.test(text)) return t("这次请求仍在处理中，收到回复后会继续保存。");
  if (/未知|未确定|unknown|unresolved|cohort|待确认|未定原调用|核验.*回执|核清.*回执/i.test(text)) return t("这次请求的结果尚未确认。请在处理详情中查看已有回复和进度，避免重复发送。");
  if (/上限|预算|额度|quota|limit/i.test(text)) return t("已达到用量或处理容量上限。请检查模型设置和用量。");
  if (/渠道|服务|密钥|认证|401|403/i.test(text)) return t("模型服务暂不可用。请在“模型设置”中检查服务并保存。");
  if (/fetch|connect|ECONN|timeout|网络/i.test(text)) return t("这次连接中断，回复是否完整收到仍需确认。请查看处理详情。");
  if (/JSON|schema|parse|载体|complete native response|final body/i.test(text)) return t("这次回复的内容无法完整处理，尚未完成保存。请查看处理详情。");
  if (/requestId|payload|\bhash\b|claim|回执|宿主|派发|候选|指针|调用身份|[a-f\d]{24,}|https?:\/\/|^[\x00-\x7f]+$/i.test(text)) return t("这次处理未完成，相关记录已保留。请查看处理详情。");
  if(interfaceLanguage()==='en')return t('这次处理未完成，相关记录已保留。请查看处理详情。');
  return text.replace(/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}/gi, t("本次请求")).replace(/[A-Z]:[\\/][^\s，。]+/g, t("本机资料")).slice(0, 180);
}

/** Explain the action and its effect; implementation reasons belong in diagnostics. */
export function recoveryReasonLabel(decision: ReadingRecoveryCapability): string {
  const reason = decision.reason ?? '';
  if (decision.availability === 'running') return t("这次请求仍在处理中，收到回复后会继续保存。");
  if (decision.responsibility === 'settlement') return t("这次处理已结束，相关费用仍待确认，费用记录会继续保留。");
  if (decision.kind === 'history') {
    if (/已保存|已提交|已完成|消费/.test(reason) && !/错误|失败|未完整/.test(reason)) return t("这次处理已结束，已有内容和处理记录可在历史中查看。");
    return t("这次处理已结束，尚未完成的部分及已有回复保留在历史记录中。");
  }
  if (/许可|撤回|形成来源/.test(reason)) return t("这次使用的原文范围已改变，暂时无法继续处理。已有内容和回复会保留。");
  if (/版本|前缀范围|身份|不属于|不存在|未绑定/.test(reason)) return t("这次处理所需的原文或保存记录暂时无法对应，已有内容和回复会保留。");
  if (/正在收妥并结束|正在等待回复并保存阅读记录/.test(reason)) return t("正在等待已发出的回复并保存，完成后结束本次共读。");
  if (decision.execution === 'receipt' || decision.kind === 'settlement') return t("这次请求的结果尚未确认。先查看是否已有回复可以保存，避免重复发送。");
  if (decision.execution === 'local-result') return t("已收到这次回复，保存尚未完成。继续保存会使用已有回复。");
  if (/等待实际读完/.test(reason)) return t("相关想法已经准备好，读完这一整段后再分享。");
  if (/等待.*发表条件/.test(reason)) return t("相关想法已经保存，正在等待合适的分享时机。");
  if (decision.execution === 'continue') return /重复失败/.test(reason)
    ? t("这次整理连续未能完成，已暂停。继续时会保留已有进度，并再次使用模型。")
    : t("已有进度会保留，继续时将接着处理，并可能使用模型。");
  if (decision.availability === 'blocked') return t("这次处理暂时无法继续，已有内容和回复会保留。");
  return reason ? workbenchErrorLabel(reason) : t("请在处理详情中查看这次进度。");
}

export function readingStatusLabel(text: string): string {
  if (text === '正在读当前现场') return t("正在阅读当前内容");
  if (text === '正在跟随阅读页面') return t("正在跟读");
  if (/^正在定位当前阅读页/.test(text)) return t("正在确认阅读位置");
  if (/^现场任务未完成/.test(text)) return t("当前内容处理未完成，请查看处理详情");
  if (/^维护任务未完成|^维护未完成/.test(text)) return t("后台整理未完成，请查看处理详情");
  if (/^正在接续并行完成的/.test(text)) return t("正在合并阅读进度");
  if (/^并发理解接续已停止/.test(text)) return t("后台理解已暂停，请查看处理详情");
  if (/^准备前文/.test(text)) return interfaceLanguage()==='en'?t('正在补读前文'):text.replace(/^准备前文/, t("正在补读前文"));
  if(interfaceLanguage()==='en'&&/[\p{Script=Han}]/u.test(text)&&!isInterfaceMessage(text))return t('正在跟读');
  return t(text);
}
