import test from 'node:test';
import assert from 'node:assert/strict';
import { completeLocal } from '../lib/transport.mjs';
import { configOf, summaryMessages } from '../lib/core.mjs';

test('local summary transport explicitly disables thinking and rejects incomplete results', async () => {
  const original = globalThis.fetch;
  const request = { model: 'test', messages: summaryMessages('synthetic'), maxTokens: 2048 };
  try {
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.reasoning_effort, 'none');
      assert.equal(body.chat_template_kwargs.enable_thinking, false);
      assert.equal(body.tools, undefined);
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'complete' }, finish_reason: 'stop' }] }) };
    };
    assert.equal(await completeLocal(configOf(), request), 'complete');
    for (const choice of [{ message: { content: 'partial' }, finish_reason: 'length' }, { message: { content: 'EOF' } }, { message: { content: 'tool', tool_calls: [{}] }, finish_reason: 'stop' }]) {
      globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [choice] }) });
      await assert.rejects(completeLocal(configOf(), request));
    }
  } finally { globalThis.fetch = original; }
});
