import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTokenCounter } from '../lib/tokenizer.mjs';
import { configOf } from '../lib/core.mjs';

test('cancelled tokenizer RPC holds its single-flight lock until it settles', async () => {
  let resolve; let calls = 0;
  class Client { llm = { createDynamicHandle: () => ({ countTokens: () => { calls++; return new Promise(r => { resolve = r; }); } }) }; }
  const count = makeTokenCounter(Client, configOf());
  const controller = new AbortController();
  const pending = count('test', [], [], controller.signal);
  controller.abort(new Error('cancelled'));
  await assert.rejects(pending, /cancelled/);
  await assert.rejects(count('test', []), /still pending/);
  assert.equal(calls, 1);
  resolve(10);
  await Promise.resolve();
  const next = count('test', []);
  resolve(10);
  assert.equal(await next, 523);
});
