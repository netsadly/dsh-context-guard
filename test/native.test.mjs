import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
  const [{ Context }, { SessionStore }, { BasicCompactionEngine }, { toolPairingBalancedBefore, toolPairingBalancedAfter }, { BlockAssembler, createUserMessage, CONTEXT_WINDOW_EXCEEDED_CODE }] = await Promise.all(['cordis', 'dsh-session', 'dsh-compaction-basic', 'dsh-compaction', 'dsh-llm'].map(native));
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [{ id: 'test', type: 'llm', state: 'loaded', loaded_context_length: 30208 }] }) });
  try {
    for (const mode of ['complete', 'eof', 'cancel', 'malformed', 'repair', 'resume']) await t.test(mode, async () => {
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
      let command;
      ctx.provide('commands', { register(value) { command = value; } });
      const controller = new AbortController();
      let summaryCalls = 0;
      ctx.provide('llm', { async *stream() {
        summaryCalls++;
        yield { type: 'text-delta', index: 0, text: (mode === 'malformed' || (mode === 'repair' && summaryCalls === 1)) ? 'not a checkpoint' : summary };
        if (mode === 'cancel') controller.abort(new Error('cancelled'));
        if (mode !== 'eof') yield { type: 'finish', reason: { kind: 'stop' } };
      } });
      const Plugin = createGuardPlugin({ BasicCompactionEngine, toolPairingBalancedBefore, toolPairingBalancedAfter, BlockAssembler, overflowCode: CONTEXT_WINDOW_EXCEEDED_CODE, makeCounter: () => async (_, messages) => estimate(messages), checkpointRoot: await mkdtemp(join(tmpdir(), 'dsh-native-checkpoints-')) });
      const plugin = new Plugin(ctx);
      const agent = { session, options: { provider: 'lmstudio', model: 'test' }, runMaintenance: fn => fn(controller.signal) };
      let attempts = 1;
      if (mode === 'resume') {
        const invocation = { agent, signal: controller.signal, commandId: 'synthetic-command', rawInput: 'recover' };
        const first = await command.handler(invocation);
        assert.match(first.text, /Recovery paused/);
        assert.equal(session.surface.replaceGeneration, 0);
        assert.deepEqual(session.surface.nodes, surface);
        let next;
        do { next = await command.handler(invocation); attempts++; } while (/Recovery paused/.test(next.text) && attempts < 10);
        assert.match(next.text, /^Recovered/);
        assert.equal(session.surface.replaceGeneration, 1);
      } else if (mode === 'complete' || mode === 'repair') {
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
      assert.equal(session.snapshotEvents().filter(x => x.type === 'compaction/start').length, attempts);
      assert.equal(session.snapshotEvents().filter(x => x.type === 'compaction/end').length, attempts);
      assert.equal(flushes, attempts);
    });
  } finally { globalThis.fetch = oldFetch; }
});



test('native pairing selection includes completed results and excludes unfinished groups', {skip:!root}, async()=>{
 const {toolPairingBalancedBefore,toolPairingBalancedAfter}=await import(pathToFileURL(join(root,'@deepseek-ai/dsh-compaction/lib/index.js')));
 const Plugin=createGuardPlugin({BasicCompactionEngine:class{},toolPairingBalancedBefore,toolPairingBalancedAfter});
 const plugin=Object.create(Plugin.prototype);plugin.guard={retainTokens:2000};
 const events=[{seq:0,type:'system/message',data:{}},{seq:1,type:'user/message',data:{source:{kind:'compact-checkpoint'}}},{seq:2,type:'assistant/message',data:{message:{content:[{type:'tool-call'},{type:'tool-call'}]}}},{seq:3,type:'tool/result',data:{}},{seq:4,type:'tool/result',data:{}}];
 const session={surface:{nodes:[0,1,2,3],replaceGeneration:0},eventAt:i=>events[i],deriveEventMessage:()=>({content:'x'.repeat(8000)})};
 assert.equal(plugin.selectRange(session,true),null); // Incomplete pair leaves only checkpoint.
 session.surface.nodes.push(4);
 assert.deepEqual(plugin.selectRange(session,true),{start:1,end:4});
 assert.equal(plugin.selectRange(session,false),null); // Do not recompress sole checkpoint.
 events.push({seq:5,type:'user/message',data:{source:{kind:'human'}}});session.surface.nodes.push(5);
 assert.deepEqual(plugin.selectRange(session,true),{start:1,end:4});
 const onlyCheckpoint={...session,surface:{nodes:[0,1,5],replaceGeneration:0}};
 assert.equal(plugin.selectRange(onlyCheckpoint,true),null);
});
