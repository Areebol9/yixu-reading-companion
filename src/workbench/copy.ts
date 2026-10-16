/** User-facing wording only. Original diagnostic messages stay in process records. */
export function workbenchErrorLabel(text: string): string {
  if (/保存|写入|存储|事务|persist|storage/i.test(text)) return '保存未完成。请保留输入，查看处理详情后重试。';
  if (/未知|未确定|unknown|unresolved|cohort|待确认/i.test(text)) return '本次请求的结果尚未确认。请查看处理详情，不要重复发送。';
  if (/上限|预算|额度|quota|limit/i.test(text)) return '已达到用量或处理容量上限。请检查模型设置和用量。';
  if (/渠道|服务|密钥|认证|401|403/i.test(text)) return '模型服务暂不可用。请在“模型设置”中检查服务并保存。';
  if (/fetch|connect|ECONN|timeout|网络/i.test(text)) return '模型连接中断。请查看处理详情，确认原请求状态后再继续。';
  if (/JSON|schema|parse|载体|complete native response|final body/i.test(text)) return '模型返回的内容暂时无法处理。请查看处理详情和原问题状态。';
  if (/^[\x00-\x7f]+$/.test(text)) return '本次处理未完成。请查看处理详情，确认原请求状态后再继续。';
  return text.replace(/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}/gi, '本次请求').replace(/[A-Z]:[\\/][^\s，。]+/g, '本机资料').slice(0, 180);
}

export function readingStatusLabel(text: string): string {
  if (text === '正在读当前现场') return '正在阅读当前内容';
  if (text === '正在跟随阅读页面') return '正在跟读';
  if (/^正在定位当前阅读页/.test(text)) return '正在确认阅读位置';
  if (/^现场任务未完成/.test(text)) return '当前内容处理未完成，请查看处理详情';
  if (/^维护任务未完成|^维护未完成/.test(text)) return '后台整理未完成，请查看处理详情';
  if (/^正在接续并行完成的/.test(text)) return '正在合并阅读进度';
  if (/^并发理解接续已停止/.test(text)) return '后台理解已暂停，请查看处理详情';
  if (/^准备前文/.test(text)) return text.replace(/^准备前文/, '正在补读前文');
  return text;
}
