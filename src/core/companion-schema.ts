import type { ReadingReply, ReadingStrategy } from './types.ts';


export const companionWorkspaceSchema = {
  type: 'object', description: '工作台只引用完整认识，不另写摘要。省略保持旧指针；focus=[]明确清空关注。working/focus是导航，可选择合法目录；understanding及正文修改须有本任务实际读取依据；tN为本次thoughts第N条成功形成的认识。',
  properties: {
    working: {type:'array',uniqueItems:true,items:{type:'string'},description:'下一轮当前工作集的具体完整文档；省略保持，[]退出当前工作集但长期正文仍保留。'},
    understanding: { type: 'string', pattern: '^m[1-9][0-9]*$|^t[1-9][0-9]*$', description: '当前完整理解：本轮取得全文的opinion m，或本次完整opinion的tN。' },
    focus: { type: 'array', uniqueItems: true, items: { type: 'string', pattern: '^m[1-9][0-9]*$|^t[1-9][0-9]*$' }, description: '仍在关注的完整认识引用；省略保持，明确空数组清空，不因本轮未提及而结束旧问题。' }
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
    !/^[cehps][0-9]+$/.test(id) && (!/^t[0-9]/.test(id) || /^t[1-9][0-9]*$/.test(id)&&Number.isSafeInteger(Number(id.slice(1)))) &&
    (!/^m[0-9]/.test(id) || /^m[1-9][0-9]*$/.test(id) && Number.isSafeInteger(Number(id.slice(1))));
  if (value.understanding !== undefined && !valid(value.understanding)) throw Error('工作台understanding须引用完整认识的m编号或本次tN');
  if (value.focus !== undefined && (!Array.isArray(value.focus) || value.focus.some(id => !valid(id)))) throw Error('工作台focus须为完整认识引用数组，空数组表示清空');
  if(value.working!==undefined&&(!Array.isArray(value.working)||value.working.some(id=>!valid(id))))throw Error('当前工作集须为文档引用数组');
  return { ...(value.understanding !== undefined ? { understanding: value.understanding as string } : {}), ...(value.focus !== undefined ? { focus: [...new Set(value.focus as string[])] } : {}),...(value.working!==undefined?{working:[...new Set(value.working as string[])]}:{}) };
}

export function companionThoughtLimit(workspace: ReadingReply['workspace'], index: number, kind: unknown): number|undefined {
  return kind === 'opinion' ? undefined : 1800;
}

export function assertCompanionProposals(workspace: ReadingReply['workspace'], thoughts: ReadingReply['thoughts']): void {
  // working/focus are normalized together with actual version inheritance in
  // the core. A mistaken navigation label cannot reject otherwise valid edits.
  const reference=workspace?.understanding;
  if(!reference||!/^t[1-9][0-9]*$/.test(reference))return;
  const thought=thoughts[Number(reference.slice(1))-1];
  if(!thought)throw Error('工作台tN未指向本次实际提交的认识');
  if(thought.kind!=='opinion')throw Error('工作台完整理解须为opinion');
}
