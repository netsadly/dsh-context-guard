import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createGuardPlugin } from '../lib/plugin.mjs';
import { REASONING_ONLY_EOS } from '../lib/reasoning.mjs';

test('native agent settles attempts, preserves thinking, avoids tool replay and bounds outer retries', { skip: !process.env.DSH_TEST_MODULES, timeout: 30000 }, async t => {
  const mod = name => import(pathToFileURL(join(process.env.DSH_TEST_MODULES, '@deepseek-ai', name, 'lib/index.js')));
  const [{ Context }, { SessionStore }, { SessionProjectionRegistry }, { AgentRegistry }, { AgentLoop }, { SystemPrompt }, { ToolRuntime, defineContentToolFixture }, { BasicCompactionEngine }, comp, llm, retry] = await Promise.all(['cordis', 'dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-agent-loop', 'dsh-system-prompt', 'dsh-tools', 'dsh-compaction-basic', 'dsh-compaction', 'dsh-llm', 'dsh-llm-retry'].map(mod));
  for (const mode of ['recover', 'tools', 'cancel', 'always', 'normal']) for (const outer of [true, false]) await t.test(`${mode}, retry outer=${outer}`, async () => {
    const ctx = new Context();
    new SessionProjectionRegistry(ctx); new SessionStore(ctx); new AgentRegistry(ctx);
    new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false });
    new ToolRuntime(ctx);
    let requests = 0, executions = 0, agent;
    const captured = [];
    ctx.tools.register(defineContentToolFixture({ name: 'lookup', description: 'Synthetic lookup', parameters: {}, execute: async () => { executions++; return [{ type: 'text', text: '42' }]; } }));
    const retryPolicy = { mode: mode === 'normal' ? 'normal' : 'always', maxRetries: 10, retryableCodes: [REASONING_ONLY_EOS], initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 };
    ctx.provide('llm', {
      prepareCall: async config => ({ config, retryPolicy, stream: request => ctx.llm.stream(request) }),
      async *stream(request) {
        yield* ctx.waterfall('llm/stream', request, async function* () {
          requests++; captured.push(request);
          assert.ok(requests <= 3, 'must not loop indefinitely');
          yield { type: 'reasoning-delta', index: 0, text: 'Checking constraints.' };
          if (mode === 'cancel') { agent.cancel({ kind: 'user' }); return; }
          if (mode === 'recover' && requests === 2 || mode === 'tools' && requests === 3) yield { type: 'text-delta', index: 1, text: '42' };
          if (mode === 'tools' && requests === 2) yield { type: 'tool-call-delta', index: 1, id: 'synthetic-call', name: 'lookup', argumentsDelta: '{}' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        });
      }
    });
    ctx.provide('commands', { register() {} });
    ctx.provide('tokenMeter', { measure: () => ({ totalTokens: 0, nodes: [] }) });
    const Plugin = createGuardPlugin({ BasicCompactionEngine, ...comp, BlockAssembler: llm.BlockAssembler, overflowCode: llm.CONTEXT_WINDOW_EXCEEDED_CODE, makeCounter: () => async () => 100 });
    if (outer) retry.apply(ctx);
    const guard = new Plugin(ctx); guard.compactIfNeeded = async () => null;
    if (!outer) retry.apply(ctx);
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [{ id: 'test', state: 'loaded', type: 'llm', loaded_context_length: 16896 }] }) });
    try {
      const loop = new AgentLoop(ctx, { agents: [], maxParallelToolCalls: { get: () => 1 } });
      agent = await loop.create(`synthetic-${mode}-${outer}`, { provider: 'lmstudio', model: 'test', reasoningEffort: 'high', maxTokens: 2048 });
      agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'Solve using lookup if needed.' }], source: { kind: 'human' } }));
      await agent.whenIdle();
      const events = agent.session.snapshotEvents();
      const end = events.findLast(e => e.type === 'turn/end');
      assert.ok(captured.every(r => r.reasoningEffort === 'high' && r.tools.some(tool => tool.name === 'lookup')));
      if (mode === 'recover' || mode === 'tools') {
        assert.equal(end.data.reason.kind, 'completed', JSON.stringify(end)); assert.equal(requests, mode === 'tools' ? 3 : 2);
        assert.equal(end.data.reason.kind, 'completed');
        assert.equal(events.filter(e => e.type === 'assistant/attempt').length, 1);
        assert.equal(executions, mode === 'tools' ? 1 : 0);
        assert.deepEqual(captured[0].messages, captured[1].messages);
      } else if (mode === 'cancel') {
        assert.equal(requests, 1); assert.equal(end.data.reason.kind, 'aborted');
      } else {
        assert.equal(requests, 2); assert.equal(end.data.reason.kind, 'error');
        assert.equal(events.filter(e => e.type === 'assistant/message').length, 0);
        assert.ok(events.filter(e => e.type === 'assistant/attempt').length >= 2);
      }
      assert.equal(guard.reasoningFailures.size, 0, 'idle clears per-turn failure budget');
    } finally { globalThis.fetch = oldFetch; await ctx.fiber.dispose(); }
  });
});



