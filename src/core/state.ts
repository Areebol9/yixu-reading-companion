import type { State } from './types.ts';
import {createPartnerFromTemplate} from './partner-persona.ts';
export function initialState(): State {
  const state:State = {
    schema: 1, publicationTrackingStartedAt:Date.now(), books: [], memories: [], chats: [], conversations: [], usage: [], forgotten: [],
    partnerId: 'default', partners: [],
    settings: {
      serviceId: 'wechat', tokenLimit: 100_000, searchEnabled: false, searchProvider: 'exa', searchEndpoint: 'https://mcp.exa.ai/mcp', searchSecretRef: '', minReadChars: 160, minReactionMs: 18_000, defaultQuiet: false, readingEffort: 'medium',
      services: [
        { id: 'wechat', name: '腾讯渠道 · DeepSeek Flash', baseUrl: 'https://chatapi.weixin.qq.com/openai/v1', model: 'Deepseek-v4-flash', contextLimit: 200_000, effort: 'high', maxOutput: 4096, enabled: false, secretRef: 'wechat', fallback: false },
        { id: 'deepseek', name: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', contextLimit: 1_000_000, effort: 'high', maxOutput: 4096, enabled: false, secretRef: 'deepseek', fallback: false }
      ]
    }
  };
  createPartnerFromTemplate(state,undefined,{id:'default'});
  return state;
}
