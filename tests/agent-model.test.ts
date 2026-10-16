import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatModel, ModelOutputError, conservativeRequestTokens, reserveUsage } from '../src/core/model.ts';
import { initialState } from '../src/core/state.ts';
import type { ModelMessage, ModelTool } from '../src/core/types.ts';

const tool: ModelTool = { name: 'read_evidence', description: '读取获准依据', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } };
test('原生工具协议保留调用关联和思考续传，工具调用可不带正文，工具定义计入预留', async () => {
  const state = initialState(), service = state.settings.services[0]; let wire: any;
  const messages: ModelMessage[] = [{ role: 'assistant', content: '', reasoning_content: '工程续传字段', tool_calls: [{ id: 'call-a', type: 'function', function: { name: 'read_evidence', arguments: '{"query":"AX"}' } }] }, { role: 'tool', tool_call_id: 'call-a', content: '工程结果' }];
  const model = new ChatModel(async request => { wire = request.body; return { status: 200, body: { choices: [{ finish_reason: 'tool_calls', message: { content: null, reasoning_content: 'next', tool_calls: [{ id: 'call-b', type: 'function', function: { name: 'read_evidence', arguments: '{"query":"BX"}' } }] } }], usage: { prompt_tokens: 120, completion_tokens: 25 } } }; });
  const result = await model.completeTools(service, messages, [tool], new AbortController().signal);
  assert.equal(wire.response_format, undefined); assert.deepEqual(wire.messages, messages); assert.deepEqual(wire.tools, [{ type: 'function', function: tool }]);
  assert.equal(result.content, ''); assert.equal(result.reasoning, 'next'); assert.equal(result.toolCalls[0].id, 'call-b'); assert.equal(result.input, 120);
  const withTools = reserveUsage(state, service, messages, '工程Agent', [tool]); assert.equal(withTools.input, conservativeRequestTokens(messages, [tool])); assert.ok(withTools.input > conservativeRequestTokens(messages));
});

test('截断和重复标识中止任务，同时保留供应商已返回的用量', async () => {
  const service = initialState().settings.services[0], valid = { id: 'a', type: 'function', function: { name: 'read_evidence', arguments: '{}' } };
  for (const choice of [
    { finish_reason: 'length', message: { content: '' } },
    { finish_reason: 'tool_calls', message: { tool_calls: [valid, valid] } },
    { finish_reason: 'stop', message: { content: 'done', tool_calls: [valid] } },
  ]) {
    const model = new ChatModel(async () => ({ status: 200, body: { choices: [choice], usage: { prompt_tokens: 41, completion_tokens: 37 } } }));
    await assert.rejects(model.completeTools(service, [], [tool], new AbortController().signal), error => error instanceof ModelOutputError && error.response.input === 41 && error.response.output === 37);
  }
});

test('缺少usage时工具描述和调用历史也按保守值计费，预算不足在请求之前拒绝', async () => {
  const state = initialState(), service = state.settings.services[0], messages: ModelMessage[] = [{ role: 'user', content: '工程核对' }];
  const huge = { ...tool, description: '资料'.repeat(2000) }; state.settings.tokenLimit = service.maxOutput + 1000;
  assert.throws(() => reserveUsage(state, service, messages, '工程', [huge]), /用量上限/); assert.equal(state.usage.length, 0);
  const model = new ChatModel(async () => ({ status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: '结果' } }] } }));
  const result = await model.completeTools(service, messages, [tool], new AbortController().signal);
  assert.equal(result.estimated, true); assert.equal(result.input, conservativeRequestTokens(messages, [tool])); assert.equal(result.output, service.maxOutput);
});
