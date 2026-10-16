import type { State } from './types.ts';
export function initialState(): State {
  return {
    schema: 1, books: [], memories: [], chats: [], conversations: [], usage: [], forgotten: [],
    partnerId: 'default', partners: [{ id: 'default', name: '共读伙伴', traits: '有自己的阅读判断，愿意听取不同意见；关注当前作品，表达简短自然。', backgroundBooks: [] }],
    settings: {
      serviceId: 'wechat', tokenLimit: 100_000, searchEnabled: false, searchProvider: 'exa', searchEndpoint: 'https://mcp.exa.ai/mcp', searchSecretRef: '', minReadChars: 160, minReactionMs: 18_000, defaultQuiet: false, readingEffort: 'medium',
      services: [
        { id: 'wechat', name: '腾讯渠道 · DeepSeek Flash', baseUrl: 'https://chatapi.weixin.qq.com/openai/v1', model: 'Deepseek-v4-flash', contextLimit: 200_000, effort: 'high', maxOutput: 4096, enabled: false, secretRef: 'wechat', fallback: false },
        { id: 'deepseek', name: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', contextLimit: 1_000_000, effort: 'high', maxOutput: 4096, enabled: false, secretRef: 'deepseek', fallback: false }
      ]
    }
  };
}
