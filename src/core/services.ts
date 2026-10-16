import type { Service } from './types.ts';

export function validateService(service: Service, allowDraft = false): Service {
  if (!/^(wechat|deepseek|custom-[a-z0-9-]{8,64})$/.test(service.id)) throw new Error('服务标识无效');
  if (typeof service.name !== 'string' || typeof service.model !== 'string' || typeof service.baseUrl !== 'string' || typeof service.enabled !== 'boolean' || typeof service.fallback !== 'boolean') throw new Error('服务配置字段无效');
  if (!['medium','high'].includes(service.effort) || service.thinking !== undefined && !['deepseek','none'].includes(service.thinking)) throw new Error('模型思考配置无效');
  for (const price of [service.inputPrice, service.outputPrice]) if (price !== undefined && (!Number.isFinite(price) || price < 0)) throw new Error('模型计价无效');
  if (allowDraft && service.id.startsWith('custom-') && !service.enabled && (!service.baseUrl || !service.model)) return { ...service };
  let url: URL;
  try { url = new URL(service.baseUrl); } catch { throw new Error('请填写完整的 HTTPS 服务地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('服务地址应为不带密钥、参数的 HTTPS 接口地址');
  const baseUrl = url.toString().replace(/\/$/, '');
  const fixed = service.id === 'wechat' ? 'https://chatapi.weixin.qq.com/openai/v1' : service.id === 'deepseek' ? 'https://api.deepseek.com' : undefined;
  if (fixed && baseUrl !== fixed) throw new Error('预置渠道地址固定，其他服务请使用自定义渠道');
  if (!service.model.trim() || service.model.length > 150) throw new Error('模型名称无效');
  if (!Number.isSafeInteger(service.contextLimit) || service.contextLimit < 4096 || service.contextLimit > (service.id === 'wechat' ? 200000 : 1000000)) throw new Error('上下文限制无效');
  if (!Number.isSafeInteger(service.maxOutput) || service.maxOutput < 256 || service.maxOutput > 65536) throw new Error('单次输出限制无效');
  return { ...service, baseUrl, model: service.model.trim() };
}
