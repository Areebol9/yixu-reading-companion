import type { ReadingReply, ReadingStrategy } from './types.ts';
import { READING_THOUGHT_LIMIT,READING_DOCUMENT_MAX_CHARS } from './types.ts';

export const COMPANION_UNDERSTANDING_LIMIT = READING_DOCUMENT_MAX_CHARS;
export const COMPANION_FOCUS_LIMIT = 32;
export const companionWorkspaceSchema = {
  type: 'object', description: '工作台只引用完整认识，不另写摘要。省略保持旧指针；focus=[]明确清空关注。旧m须本轮确实取得完整正文，目录不授予写入资格；tN为本次thoughts第N条成功形成的认识。',
  properties: {
    working: {type:'array',maxItems:16,uniqueItems:true,items:{type:'string'},description:'下一轮当前工作集的具体完整文档；省略保持，[]退出当前工作集但长期正文仍保留。'},
    understanding: { type: 'string', pattern: '^m[1-9][0-9]*$|^t(?:[1-9]|1[0-6])$', description: '当前完整理解：本轮取得全文的opinion m，或本次完整opinion的tN。' },
    focus: { type: 'array', maxItems: COMPANION_FOCUS_LIMIT, uniqueItems: true, items: { type: 'string', pattern: '^m[1-9][0-9]*$|^t(?:[1-9]|1[0-6])$' }, description: '仍在关注的完整认识引用；省略保持，明确空数组清空，不因本轮未提及而结束旧问题。' }
  }, additionalProperties: false
};

/** Scope/existence/full-body authority are checked by the core before publication. */
export function parseCompanionWorkspace(raw: unknown, strategy?: ReadingStrategy): ReadingReply['workspace'] {
  if (raw === undefined) return undefined;
  if (strategy !== 'companion') throw Error('workspace仅持续伴读模式可提交');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('工作台引用格式无效');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(k => !['understanding','focus','working'].includes(k))) throw Error('工作台仅接受understanding、working和focus引用');
  const valid = (id: unknown): id is string => typeof id === 'string' && !!id && id.length <= 128 && id.trim() === id &&
    !/^[cehps][0-9]+$/.test(id) && (!/^t[0-9]/.test(id) || /^t(?:[1-9]|1[0-6])$/.test(id)) &&
    (!/^m[0-9]/.test(id) || /^m[1-9][0-9]*$/.test(id) && Number.isSafeInteger(Number(id.slice(1))));
  if (value.understanding !== undefined && !valid(value.understanding)) throw Error('工作台understanding须引用完整认识的m编号或本次tN');
  if (value.focus !== undefined && (!Array.isArray(value.focus) || value.focus.length > COMPANION_FOCUS_LIMIT || value.focus.some(id => !valid(id)))) throw Error('工作台focus须为完整认识引用数组，空数组表示清空');
  if(value.working!==undefined&&(!Array.isArray(value.working)||value.working.length>16||value.working.some(id=>!valid(id))))throw Error('当前工作集须为至多16篇完整文档的引用');
  return { ...(value.understanding !== undefined ? { understanding: value.understanding as string } : {}), ...(value.focus !== undefined ? { focus: [...new Set(value.focus as string[])] } : {}),...(value.working!==undefined?{working:[...new Set(value.working as string[])]}:{}) };
}

export function companionThoughtLimit(workspace: ReadingReply['workspace'], index: number, kind: unknown): number {
  return kind === 'opinion' ? COMPANION_UNDERSTANDING_LIMIT : 1800;
}

export function assertCompanionProposals(workspace: ReadingReply['workspace'], thoughts: ReadingReply['thoughts']): void {
  for (const reference of [workspace?.understanding, ...(workspace?.focus ?? []),...(workspace?.working??[])]) {
    if (!reference || !/^t[1-9][0-9]*$/.test(reference)) continue;
    const index = Number(reference.slice(1)) - 1;
    if (index >= READING_THOUGHT_LIMIT || !thoughts[index]) throw Error('工作台tN未指向本次实际提交的认识');
    if (reference === workspace?.understanding && thoughts[index].kind !== 'opinion') throw Error('工作台完整理解须为opinion');
    if (!['story','opinion','question'].includes(thoughts[index].kind)) throw Error('工作台关注须引用作品事实、看法或完整原问');
  }
}
