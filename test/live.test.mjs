import test from 'node:test';
import assert from 'node:assert/strict';
import { configOf, loadedCapacity, summarizeBounded, budgetOf } from '../lib/core.mjs';
import { makeTokenCounter } from '../lib/tokenizer.mjs';
import { completeLocal } from '../lib/transport.mjs';

test('loaded LM Studio model produces a complete bounded synthetic checkpoint', { skip: !process.env.DSH_LIVE_MODEL, timeout: 180000 }, async () => {
  const { LMStudioClient } = await import(process.env.DSH_SDK_URL || '@lmstudio/sdk');
  const config = configOf();
  const model = process.env.DSH_LIVE_MODEL;
  const capacity = await loadedCapacity(config, model);
  const countTokens = makeTokenCounter(LMStudioClient, config);
  const signal = AbortSignal.timeout(170000);
  const result = await summarizeBounded([{ role: 'user', content: [{ type: 'text', text: 'Goal: build a synthetic calculator. Constraints: no external services. Completed: parser implemented. Files: calculator.mjs. Failures: division by zero test failed. Pending: fix zero handling. Next step: run regression tests. '.repeat(60) }] }], {
    config, capacity, signal,
    complete: async (messages, maxTokens) => {
      const count = await countTokens(model, messages, [], signal);
      assert.ok(count < budgetOf(config, capacity, maxTokens).available);
      return { text: await completeLocal(config, { model, messages, maxTokens, signal }), finish: 'stop' };
    }
  });
  assert.match(result.text, /calculator\.mjs/);
  assert.match(result.text, /zero/i);
});

 test('live model repairs missing sections with distinct corrective prompt', { skip: !process.env.DSH_LIVE_MODEL, timeout: 120000 }, async () => {
  const config = configOf(); const model = process.env.DSH_LIVE_MODEL;
  const capacity = await loadedCapacity(config, model); let calls = 0;
  const result = await summarizeBounded([{ role: 'user', content: [{ type: 'text', text: 'Goal: maintain calculator. Completed: parser implemented. Files: calculator.mjs. Constraints: preserve files. Failures: division by zero test failed; file lookup timed out. Pending: fix both and rerun tests. ' + 'Previous incomplete checkpoint: Goal: calculator. Files: C:/synthetic/unfinished-path. '.repeat(12) }] }], { config, capacity, signal: AbortSignal.timeout(110000),
    complete: async (messages, maxTokens, signal) => {
      if (++calls === 1) return { finish: 'stop', text: 'Goal: calculator. Files: incomplete' };
      assert.match(messages[0].content[0].text, /exactly seven nonempty lines/);
      return { finish: 'stop', text: await completeLocal(config, { model, messages, maxTokens, signal }) };
    }
  });
  assert.equal(calls, 2); assert.match(result.text, /zero/i); assert.match(result.text, /timed out|timeout/i);
});
