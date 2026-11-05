import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuardPlugin } from '../lib/plugin.mjs';
import { estimate } from '../lib/core.mjs';

class Base {
  constructor(ctx) { this.ctx = ctx; }
  async compactRegion(start, end, agent) {
    agent.session.messages = [{ role: 'user', content: [{ type: 'text', text: 'Summary: synthetic prior work retained.' }] }, agent.session.messages.at(-1)];
    agent.session.surface.replaceGeneration++;
    return { shadowedSeqs: [start, end] };
  }
}
function fixture() {
  const hooks = new Map(); const commands = [];
  const ctx = { on: (name, fn) => hooks.set(name, fn), commands: { register: command => commands.push(command) }, tokenMeter: { measure: () => ({ totalTokens: 0 }) } };
  const Plugin = createGuardPlugin({ BasicCompactionEngine: Base, toolPairingBalancedBefore: () => true, BlockAssembler: class {}, overflowCode: 'CONTEXT_WINDOW_EXCEEDED', makeCounter: () => async (model, messages, tools) => estimate({ messages, tools }) });
  const plugin = new Plugin(ctx);
  const session = { messages: [], surface: { nodes: [0, 1, 2, 3], replaceGeneration: 0 }, requestHeader: () => ({ config: { provider: 'lmstudio', model: 'test', maxTokens: 8192 }, tools: [] }), deriveMessages() { return this.messages; }, eventAt: seq => ({ type: seq === 0 ? 'system/message' : 'user/message', seq }), deriveEventMessage: () => ({ role: 'user', content: 'recent'.repeat(1000) }) };
  const agent = { options: { provider: 'lmstudio', model: 'test' }, session };
  return { hooks, commands, plugin, agent };
}
async function withCapacity(fn) {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [{ id: 'test', type: 'llm', state: 'loaded', loaded_context_length: 30208 }] }) });
  try { await fn(); } finally { globalThis.fetch = oldFetch; }
}
test('multi-step workflow compacts large history then admits subsequent request', () => withCapacity(async () => {
  const { hooks, agent } = fixture();
  agent.session.messages = [{ role: 'user', content: 'old'.repeat(30000) }, { role: 'user', content: 'latest instruction' }];
  const signal = new AbortController().signal;
  const next = async () => ({ kind: 'enter', messages: [{ role: 'user', content: 'continue synthetic task' }] });
  assert.equal((await hooks.get('agent/pre-step')({ agent, signal }, next)).kind, 'enter');
  assert.equal(agent.session.surface.replaceGeneration, 1);
  await hooks.get('agent/pre-step')({ agent, signal }, next);
  assert.equal(agent.session.surface.replaceGeneration, 1);
  let sent = false;
  const stream = hooks.get('llm/stream')({ provider: 'lmstudio', model: 'test', messages: agent.session.messages, maxTokens: 8192, signal }, async function* () { sent = true; yield 'ok'; });
  for await (const chunk of stream) assert.equal(chunk, 'ok');
  assert.equal(sent, true);
}));
test('final stream guard prevents an oversized newly admitted message', () => withCapacity(async () => {
  const { hooks } = fixture(); let sent = false;
  const stream = hooks.get('llm/stream')({ provider: 'lmstudio', model: 'test', messages: [{ role: 'user', content: 'x'.repeat(100000) }], maxTokens: 8192 }, async function* () { sent = true; });
  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  assert.equal(chunks[0].type, 'finish');
  assert.equal(chunks[0].reason.failure.code, 'CONTEXT_WINDOW_EXCEEDED');
  assert.equal(sent, false);
}));
test('repairs invalid historical cap without altering valid user output choices', async () => {
  const { hooks, agent } = fixture();
  const invoke = maxTokens => hooks.get('agent/request')({ agent }, async () => ({ provider: 'lmstudio', maxTokens }));
  assert.equal((await invoke(1)).maxTokens, 8192);
  assert.equal((await invoke(16384)).maxTokens, 16384);
});
test('failed compaction does not allow generation', () => withCapacity(async () => {
  const { hooks, plugin, agent } = fixture();
  agent.session.messages = [{ content: 'x'.repeat(100000) }];
  plugin.compactRegion = async () => { throw new Error('summary failed'); };
  await assert.rejects(hooks.get('agent/pre-step')({ agent, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] })), /summary failed/);
  assert.equal(agent.session.surface.replaceGeneration, 0);
}));
test('recovery retries at most once per turn', () => withCapacity(async () => {
  const { hooks, plugin, agent } = fixture();
  let calls = 0;
  plugin.compactIfNeeded = async () => { calls++; agent.session.surface.replaceGeneration++; };
  const event = { agent, failure: { code: 'CONTEXT_WINDOW_EXCEEDED' }, signal: new AbortController().signal };
  assert.equal((await hooks.get('agent/request-error')(event, () => ({ kind: 'fail' }))).kind, 'retry');
  assert.equal((await hooks.get('agent/request-error')(event, () => ({ kind: 'fail' }))).kind, 'fail');
  assert.equal(calls, 1);
}));

test('admitted inputs are not counted again on request or overflow recovery', async () => {
  const { hooks, plugin, agent } = fixture();
  plugin.pending.set(agent, [{ content: 'pending' }]);
  await hooks.get('agent/request')({ agent }, async () => ({ provider: 'lmstudio', maxTokens: 8192 }));
  assert.equal(plugin.pending.has(agent), false);
  plugin.pending.set(agent, [{ content: 'pending' }]);
  await hooks.get('agent/request-error')({ agent, failure: { code: 'OTHER' }, signal: new AbortController().signal }, () => ({ kind: 'fail' }));
  assert.equal(plugin.pending.has(agent), false);
});
