import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createGuardPlugin } from '../lib/plugin.mjs';
import { estimate } from '../lib/core.mjs';

// Point at an installed/extracted Harness node_modules directory. Never ship it.
const root = process.env.DSH_TEST_MODULES;
const summary = 'Goal: synthetic test. Constraints: retain history. Completed: checked. Files: none. Failures: none. Pending: verify. Next step: verify.';
test('native bundle patch disables the old service and inserts the replacement', { skip: !root }, async () => {
  const { applyEntryPatches } = await import(pathToFileURL(join(root, '@deepseek-ai/cordis-plugin-include/lib/index.js')));
  const { default: yaml } = await import(pathToFileURL(join(root, 'yaml/dist/index.js')));
  const patch = yaml.parse(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'));
  const warnings = [];
  const result = applyEntryPatches([{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' }], patch, (...args) => warnings.push(args));
  assert.deepEqual(warnings, []);
  assert.equal(result.find(x => x.id === 'compaction-basic').disabled, true);
  assert.equal(result.find(x => x.id === 'context-guard').name, 'dsh-context-guard');
});
test('native Harness compaction preserves events, persists, and rolls back malformed streams', { skip: !root }, async t => {
  const native = name => import(pathToFileURL(join(root, '@deepseek-ai', name, 'lib/index.js')));
  const [{ Context }, { SessionStore }, { BasicCompactionEngine }, { toolPairingBalancedBefore }, { BlockAssembler, createUserMessage, CONTEXT_WINDOW_EXCEEDED_CODE }] = await Promise.all(['cordis', 'dsh-session', 'dsh-compaction-basic', 'dsh-compaction', 'dsh-llm'].map(native));
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [{ id: 'test', type: 'llm', state: 'loaded', loaded_context_length: 30208 }] }) });
  try {
    for (const mode of ['complete', 'eof', 'cancel', 'malformed']) await t.test(mode, async () => {
      const ctx = new Context();
      const store = new SessionStore(ctx);
      const session = store.prepare('synthetic', { meta: { cwd: process.cwd() } });
      for (let i = 0; i < 3; i++) session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `Synthetic ${i} `.repeat(2000) }], source: { kind: 'human' } }), { surfaceOp: 'append' });
      const original = session.snapshotEvents();
      const surface = [...session.surface.nodes];
      let flushes = 0;
      store.flush = async () => { flushes++; };
      ctx.provide('tokenMeter', {
        estimateMessage: estimate,
        measure: s => {
          const nodes = s.surface.nodes.map(seq => { const tokens = estimate(s.deriveEventMessage(s.eventAt(seq))); return { seq, tokens, heuristicTokens: tokens }; });
          return { nodes, totalTokens: nodes.reduce((n, x) => n + x.tokens, 0) };
        }
      });
      ctx.provide('commands', { register() {} });
      const controller = new AbortController();
      ctx.provide('llm', { async *stream() {
        yield { type: 'text-delta', index: 0, text: mode === 'malformed' ? 'not a checkpoint' : summary };
        if (mode === 'cancel') controller.abort(new Error('cancelled'));
        if (mode !== 'eof') yield { type: 'finish', reason: { kind: 'stop' } };
      } });
      const Plugin = createGuardPlugin({ BasicCompactionEngine, toolPairingBalancedBefore, BlockAssembler, overflowCode: CONTEXT_WINDOW_EXCEEDED_CODE, makeCounter: () => async (_, messages) => estimate(messages) });
      const plugin = new Plugin(ctx);
      const agent = { session, options: { provider: 'lmstudio', model: 'test' }, runMaintenance: fn => fn(controller.signal) };
      if (mode === 'complete') {
        const result = await plugin.compactNow(agent, controller.signal);
        assert.ok(result.shadowedSeqs.length > 0);
        assert.equal(session.surface.replaceGeneration, 1);
        assert.ok(session.deriveMessages().length < 3);
      } else {
        await assert.rejects(plugin.compactNow(agent, controller.signal));
        assert.deepEqual(session.surface.nodes, surface);
        assert.equal(session.surface.replaceGeneration, 0);
      }
      assert.deepEqual(session.snapshotEvents().slice(0, original.length), original);
      assert.equal(session.snapshotEvents().filter(x => x.type === 'compaction/start').length, 1);
      assert.equal(session.snapshotEvents().filter(x => x.type === 'compaction/end').length, 1);
      assert.equal(flushes, 1);
    });
  } finally { globalThis.fetch = oldFetch; }
});


