import test from 'node:test';
import assert from 'node:assert/strict';
import { configOf, estimate, loadedCapacity, budgetOf, chunkData, summarizeBounded, summaryMessages, assertTextContent } from '../lib/core.mjs';

const config = configOf();
test('rejects unsafe configuration and one-token budgets', () => {
  for (const value of [{ baseURL: 'http://example.com' }, { baseURL: 'http://localhost/a' }, { outputTokens: -1 }, { thresholdRatio: 1 }, { unknown: 1 }]) assert.throws(() => configOf(value));
  assert.throws(() => budgetOf(config, 30208, 1));
  assert.throws(() => budgetOf(config, 8192));
  assert.equal(budgetOf(config, 30208).available, 19968);
});
test('exact loaded model capacity is rechecked and never substitutes max capacity', async () => {
  let capacity = 30208;
  const fetcher = async () => ({ ok: true, json: async () => ({ data: [{ id: 'test', type: 'llm', state: 'loaded', loaded_context_length: capacity, max_context_length: 262144 }] }) });
  assert.equal(await loadedCapacity(config, 'test', undefined, fetcher), 30208);
  capacity = 16384;
  assert.equal(await loadedCapacity(config, 'test', undefined, fetcher), 16384);
  await assert.rejects(loadedCapacity(config, 'other', undefined, fetcher));
});
test('capacity failure is fail-closed', async () => {
  await assert.rejects(loadedCapacity(config, 'test', undefined, async () => ({ ok: false, status: 401 })));
  await assert.rejects(loadedCapacity(config, 'test', undefined, async () => ({ ok: true, json: async () => ({ data: [] }) })));
});
test('chunks preserve Unicode and stay within complete request budget', () => {
  const original = '汉字😀code\n'.repeat(10000);
  const chunks = chunkData(original, 4096);
  assert.equal(chunks.join(''), original);
  for (const part of chunks) assert.ok(estimate(summaryMessages(part)) <= 4096);
});
test('oversized history is reduced in bounded calls without tools', async () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'DATA old work '.repeat(30000) }] }];
  const original = structuredClone(messages); let calls = 0;
  const result = await summarizeBounded(messages, { config, capacity: 30208, complete: async request => {
    calls++; assert.equal(request.length, 2); assert.ok(estimate(request) < 20000);
    return { text: 'Goal: example. Constraints: keep history. Completed: synthetic work. Files: none. Failures: none. Pending: verify. Next step: verify.', finish: 'stop' };
  } });
  assert.ok(calls > 1); assert.equal(calls, result.calls); assert.deepEqual(messages, original);
});
test('rejects truncated or empty summaries', async () => {
  for (const result of [{ text: 'partial', finish: 'length' }, { text: '', finish: 'stop' }]) await assert.rejects(summarizeBounded([{ role: 'user', content: 'hello' }], { config, capacity: 30208, complete: async () => result }));
});
test('cancellation and call limits stop work', async () => {
  const signal = AbortSignal.abort(new Error('cancelled'));
  let calls = 0;
  await assert.rejects(summarizeBounded([{ content: 'hello' }], { config, capacity: 30208, signal, complete: async () => { calls++; } }));
  assert.equal(calls, 0);
  await assert.rejects(summarizeBounded([{ content: 'abc'.repeat(100000) }], { config: configOf({ maxCalls: 1 }), capacity: 30208, complete: async () => ({ text: 'Goal: test. Constraints: none. Completed: test. Files: none. Failures: none. Pending: verify. Next step: verify.', finish: 'stop' }) }), /limit/);
});
test('provider-confirmed overflow splits input with a bounded retry', async () => {
  let calls = 0;
  const result = await summarizeBounded([{ content: 'data'.repeat(5000) }], { config, capacity: 30208, complete: async () => {
    if (++calls === 1) { const e = new Error('overflow'); e.code = 'CONTEXT_WINDOW_EXCEEDED'; throw e; }
    return { text: 'Goal: test. Constraints: none. Completed: test. Files: none. Failures: none. Pending: verify. Next step: verify.', finish: 'stop' };
  } });
  assert.equal(result.calls, 4);
});
test('unsupported images and file references are rejected', () => {
  for (const type of ['image', 'file', 'audio']) assert.throws(() => assertTextContent([{ content: [{ type }] }]));
  assert.throws(() => assertTextContent([{ content: [{ type: 'tool-result', content: [{ type: 'image' }] }] }]));
});

