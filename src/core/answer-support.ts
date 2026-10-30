import { bookTextSlice, requireBookText } from './books.ts';
import { isEvidenceAllowed } from './context.ts';
import { isNaturalReadingText } from './reading-output.ts';
import type { Book, Evidence, Memory, ModelTool, Range } from './types.ts';

export const ANSWER_SUPPORT_MAX_CLAIMS = 4;
export const ANSWER_SUPPORT_STATEMENT_LIMIT = 400;
export const answerSupportReminder = '对照主张和原文，由当前任务核清关系方向（谁作用于谁）、判断或说法的归属、否定的对象、当时与后来及确定程度；人物猜测、原文明确事实和你的解释分别表达。程序仅核验原文身份、许可和连续字句，未判定主张得到语义支持。';
export const answerSupportPolicy = 'check_answer_support是同一答复任务的可选原文对照工具。有影响回答的关键一两项事实、关系或因果需要复核时，选本轮已经取得的p编号及原句，把准备表达的自然主张与原文并列后自行核清，再继续自然回答。可省略quote以取回该p原段；指定quote须是该p内连续原字句。它不调用第二个模型、不保存事实表、不宣称语义正确；短问、感受和主动反应按实际需要使用，不要求每问调用，也不改变最终答复格式。';
export const readingAnswerSupportTool: ModelTool = {
  name: 'check_answer_support',
  description: '可选：把少量关键主张与本轮已给入的原文并列，由当前任务核对含义。只核验来源权限和连续字句，不自动判定主张正确。',
  parameters: {
    type: 'object',
    properties: {
      claims: {
        type: 'array', minItems: 1, maxItems: ANSWER_SUPPORT_MAX_CLAIMS,
        items: {
          type: 'object',
          properties: {
            statement: { type: 'string', minLength: 1, maxLength: ANSWER_SUPPORT_STATEMENT_LIMIT, description: '准备表达的完整自然主张，程序原样返回。' },
            sourceId: { type: 'string', pattern: '^p[1-9][0-9]*$', description: '本轮实际已给入的原文p编号。' },
            quote: { type: 'string', minLength: 1, maxLength: 200, description: '该p内连续原字句；省略时返回完整原p段。' },
          },
          required: ['statement', 'sourceId'], additionalProperties: false,
        },
      },
    },
    required: ['claims'], additionalProperties: false,
  },
};

export type AnswerSupportResult = {
  checks: { statement: string; sourceId: string; quote: string; evidence: Evidence }[];
  reminder: string;
};

function fields(value: unknown, names: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !names.includes(key))) throw Error(`${label}字段无效`);
  return value as Record<string, unknown>;
}

/** Turn-local provenance and verbatim comparison only. The returned statement
 * remains the model's claim, never a machine-certified fact or durable memory. */
export function validateAnswerSupport(book: Book, passages: ReadonlyMap<string, NonNullable<Memory['sourceQuote']>>, input: unknown, extra: Range[] = []): AnswerSupportResult {
  const value = fields(input, ['claims'], '答复原文对照');
  if (!Array.isArray(value.claims) || value.claims.length < 1 || value.claims.length > ANSWER_SUPPORT_MAX_CLAIMS) throw Error(`答复原文对照须包含1至${ANSWER_SUPPORT_MAX_CLAIMS}项主张`);
  requireBookText(book);
  const checks = value.claims.map(raw => {
    const claim = fields(raw, ['statement', 'sourceId', 'quote'], '对照主张');
    if (typeof claim.statement !== 'string' || !isNaturalReadingText(claim.statement, ANSWER_SUPPORT_STATEMENT_LIMIT)) throw Error(`对照主张须为1至${ANSWER_SUPPORT_STATEMENT_LIMIT}字符的自然文字`);
    if (typeof claim.sourceId !== 'string' || !/^p[1-9]\d*$/.test(claim.sourceId)) throw Error('对照来源须为本轮实际提供的p编号');
    const passage = passages.get(claim.sourceId);
    if (!passage) throw Error('对照来源未在本轮实际提供');
    const span = passage.evidence;
    if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end <= span.start ||
        !isEvidenceAllowed(book, [span], extra) || typeof passage.text !== 'string' || !passage.text.trim() || passage.text.length > 200 || bookTextSlice(book, span.start, span.end) !== passage.text) throw Error('对照来源的书籍版本、阅读许可或原字句已失效');
    if (claim.quote !== undefined && (typeof claim.quote !== 'string' || !claim.quote.trim() || claim.quote.length > 200)) throw Error('对照引文须为连续原字句');
    const quote = claim.quote === undefined ? passage.text : claim.quote as string;
    const offset = passage.text.indexOf(quote);
    if (offset < 0) throw Error('对照引文须连续逐字出自指定p原段，不能拼接或改写');
    return { statement: claim.statement, sourceId: claim.sourceId, quote, evidence: { ...span, start: span.start + offset, end: span.start + offset + quote.length } };
  });
  return { checks, reminder: answerSupportReminder };
}
