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
function fixture(config = {}) {
  const hooks = new Map(); const commands = [];
  const ctx = { on: (name, fn) => hooks.set(name, fn), commands: { register: command => commands.push(command) }, tokenMeter: { measure: () => ({ totalTokens: 0 }) } };
  const Plugin = createGuardPlugin({ BasicCompactionEngine: Base, toolPairingBalancedBefore: () => true, toolPairingBalancedAfter: () => true, BlockAssembler: class {}, overflowCode: 'CONTEXT_WINDOW_EXCEEDED', makeCounter: () => async (model, messages, tools) => estimate({ messages, tools }) });
  const plugin = new Plugin(ctx, config);
  const session = { messages: [], surface: { nodes: [0, 1, 2, 3], replaceGeneration: 0 }, requestHeader: () => ({ config: { provider: 'lmstudio', model: 'test', maxTokens: 8192 }, tools: [] }), deriveMessages() { return this.messages; }, eventAt: seq => ({ type: seq === 0 ? 'system/message' : 'user/message', seq }), deriveEventMessage: () => ({ role: 'user', content: 'recent'.repeat(1000) }) };
  const agent = { options: { provider: 'lmstudio', model: 'test' }, session };
  return { hooks, commands, plugin, agent };
}

test('native request-config hook remains config-only; stalled stream uses bounded answer and new task restores tools', async () => {
 const {hooks,agent,plugin}=fixture({outputTokens:2048});agent.session.id='loop-test';
 const events=[{seq:1,type:'user/message',data:{role:'user',source:{kind:'user'},content:[{type:'text',text:'Find model rankings.'}]}}];
 for(let i=0;i<3;i++)events.push({seq:2+i*2,type:'tool/call',data:{callId:String(i),name:'web_fetch',arguments:'{"url":"https://example.com"}'}},{seq:3+i*2,type:'tool/result',data:{message:{toolCallId:String(i),isError:true,content:[{type:'text',text:'fetch failed'}]}}});
 agent.session.snapshotEvents=()=>events;
 let compactions=0;plugin.compactIfNeeded=async()=>{compactions++;};
 const decision=await hooks.get('agent/pre-step')({agent,signal:new AbortController().signal},async()=>({kind:'enter',messages:[]}));
 assert.equal(compactions,0);assert.deepEqual(decision.messages,[]);
 const config=await hooks.get('agent/request')({agent},async()=>({provider:'lmstudio',model:'test',maxTokens:8192}));
 assert.equal(config.maxTokens,2048);assert.equal(config.messages,undefined);
 const original=globalThis.fetch;let posted;let forwarded=false;let answer='Insufficient evidence; repeated fetch failed.';
 globalThis.fetch=async(url,options)=>url.endsWith('/api/v0/models')?{ok:true,json:async()=>({data:[{id:'test',state:'loaded',type:'llm',loaded_context_length:16896}]})}:{ok:true,json:async()=>{posted=JSON.parse(options.body);return {choices:[{finish_reason:'stop',message:{content:answer}}]};}};
 try {
  const request={...config,sessionId:'loop-test',messages:[{role:'user',content:[{type:'text',text:'huge '.repeat(20000)}]}],tools:[{name:'web_fetch'}]};
  const chunks=[];for await(const c of hooks.get('llm/stream')(request,async function*(){forwarded=true;}))chunks.push(c);
  assert.equal(forwarded,false);assert.match(chunks[0].text,/阶段答复/);assert.equal(posted.reasoning_effort,'none');assert.equal(posted.tools,undefined);assert.equal(request.tools.length,1);
  answer='   ';const blank=[];for await(const c of hooks.get('llm/stream')(request,async function*(){}))blank.push(c);assert.match(blank[0].text,/未能生成完整/);
  const aborted={...request,signal:AbortSignal.abort(new Error('user canceled'))};await assert.rejects(async()=>{for await(const c of hooks.get('llm/stream')(aborted,async function*(){})){}},/user canceled/);
  events.push({seq:9,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'Now inspect a different file.'}]}});
  await hooks.get('agent/pre-step')({agent,signal:new AbortController().signal},async()=>({kind:'enter',messages:[]}));
  const small={...request,messages:[{role:'user',content:'new task'}]};
  for await(const c of hooks.get('llm/stream')(small,async function*(){forwarded=true;yield {type:'finish',reason:{kind:'stop'}};})){}
  assert.equal(forwarded,true);assert.equal(small.tools.length,1);assert.equal(compactions,1);
 }finally{globalThis.fetch=original;}
});

test('soft pressure skips tiny prefixes without spending a summary call; hard pressure still compacts', async()=>{
 const {plugin,agent}=fixture({outputTokens:2048});let calls=0;let count=12000;
 plugin.measureGuard=async()=>({count,budget:{capacity:16896,output:2048,trigger:11520,available:12800}});
 plugin.selectRange=()=>({start:1,end:2});agent.session.deriveEventMessage=()=>({role:'user',content:'small'});
 plugin.compactRegion=async()=>{calls++;count=10000;return {shadowedSeqs:[1,2]};};
 await plugin.compactIfNeeded(agent,'pressure');await plugin.compactIfNeeded(agent,'pressure');assert.equal(calls,0);
 count=13000;await plugin.compactIfNeeded(agent,'pressure');assert.equal(calls,1);
});

test('soft pressure does not retry an unchanged rejected span; a smaller capacity bypasses deferral',async()=>{
 const {plugin,agent}=fixture({outputTokens:2048});let calls=0;let available=12800;
 plugin.measureGuard=async()=>({count:12000,budget:{capacity:available+4096,output:2048,trigger:available*.9,available}});
 plugin.selectRange=()=>({start:1,end:2});
 plugin.compactRegion=async()=>{calls++;throw new Error('summary is not smaller than the shadowed content (3000 >= 2000)');};
 await plugin.compactIfNeeded(agent,'pressure');await plugin.compactIfNeeded(agent,'pressure');assert.equal(calls,1);
 available=11000;await assert.rejects(plugin.compactIfNeeded(agent,'pressure'),/not smaller/);assert.equal(calls,2);
});

test('successful soft compaction waits for meaningful growth but never defers actual overflow',async()=>{
 const {plugin,agent}=fixture({outputTokens:2048});let count=12500;let calls=0;
 plugin.measureGuard=async()=>({count,budget:{capacity:16896,output:2048,trigger:11520,available:12800}});
 plugin.selectRange=()=>({start:1,end:2});
 plugin.compactRegion=async()=>{calls++;agent.session.surface.replaceGeneration++;count=11700;return {shadowedSeqs:[1,2]};};
 await plugin.compactIfNeeded(agent,'pressure');count=11900;await plugin.compactIfNeeded(agent,'pressure');assert.equal(calls,1);
 await plugin.compactIfNeeded(agent,'context-overflow');assert.equal(calls,2);
});

test('actual loaded capacity changes recompute boundaries and final request protection immediately',async()=>{
 const originalFetch=globalThis.fetch;let capacity=16896;
 globalThis.fetch=async()=>({ok:true,json:async()=>({data:[{id:'test',state:'loaded',type:'llm',loaded_context_length:capacity,max_context_length:262144}]})});
 try {
  const {plugin,agent,hooks}=fixture({outputTokens:2048,thresholdRatio:.9});plugin.countTokens=async()=>12000;
  assert.deepEqual((await plugin.measureGuard(agent)).budget,{capacity:16896,output:2048,available:12800,trigger:11520});
  capacity=12288;assert.deepEqual((await plugin.measureGuard(agent)).budget,{capacity:12288,output:2048,available:8192,trigger:7372});
  let sent=false;const chunks=[];
  for await(const c of hooks.get('llm/stream')({provider:'lmstudio',model:'test',maxTokens:2048,messages:[]},async function*(){sent=true;}))chunks.push(c);
  assert.equal(sent,false);assert.equal(chunks[0].reason.failure.code,'CONTEXT_WINDOW_EXCEEDED');
  capacity=24576;assert.equal((await plugin.measureGuard(agent)).budget.trigger,18432);
 } finally {globalThis.fetch=originalFetch;}
});
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
test('repairs invalid cap and respects configured ceiling while preserving smaller choices', async () => {
  const { hooks, agent } = fixture();
  const invoke = maxTokens => hooks.get('agent/request')({ agent }, async () => ({ provider: 'lmstudio', maxTokens }));
  assert.equal((await invoke(1)).maxTokens, 8192);
  assert.equal((await invoke(16384)).maxTokens, 8192);
  assert.equal((await invoke(1024)).maxTokens, 1024);
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

test('hard pressure includes complete tool tail rather than checkpoint only', () => withCapacity(async () => {
  const {plugin,agent}=fixture();
  agent.session.surface.nodes=[0,1,2,3];
  agent.session.eventAt=seq=>({type:seq===0?'system/message':seq===1?'user/message':seq===2?'assistant/message':'tool/result',data:{source:{kind:'compact-checkpoint'}}});
  assert.deepEqual(plugin.selectRange(agent.session,true),{start:1,end:3});
  let selected; plugin.compactRegion=async(start,end)=>{selected={start,end};agent.session.messages=[{content:'small checkpoint'}];return {shadowedSeqs:[1,2,3]};};
  agent.session.messages=[{content:'large result '.repeat(10000)}];
  await plugin.compactIfNeeded(agent,'pressure',new AbortController().signal);
  assert.deepEqual(selected,{start:1,end:3});
}));
test('soft pressure with no useful prefix admits request but hard pressure fails closed',()=>withCapacity(async()=>{
  const {plugin,agent}=fixture();plugin.selectRange=()=>null;
  plugin.measureGuard=async()=>({count:17000,budget:{trigger:16000,available:19968}});
  assert.equal(await plugin.compactIfNeeded(agent,'pressure'),null);
  plugin.measureGuard=async()=>({count:21000,budget:{trigger:16000,available:19968}});
  await assert.rejects(plugin.compactIfNeeded(agent,'pressure'),/safe budget/);
}));
test('aggressive range preserves newest human instruction',()=>{
 const {plugin,agent}=fixture();
 agent.session.eventAt=seq=>({type:seq===0?'system/message':'user/message',data:{source:{kind:'human'}}});
 assert.deepEqual(plugin.selectRange(agent.session,true),{start:1,end:2});
});

test('16K context uses configured output ceiling before and during resumed requests', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ok:true,json:async()=>({data:[{id:'test',type:'llm',state:'loaded',loaded_context_length:16896}]})});
  try {
    const {plugin,agent,hooks}=fixture({outputTokens:2048});
    plugin.countTokens=async()=>10169;
    plugin.selectRange=()=>null;
    const state=await plugin.measureGuard(agent);
    assert.equal(state.budget.output,2048);
    assert.equal(state.budget.available,12800);
    await plugin.compactIfNeeded(agent,'pressure',new AbortController().signal);
    for(const cap of [undefined,1,8192,16384]) {
      const request=await hooks.get('agent/request')({agent},async()=>({provider:'lmstudio',maxTokens:cap}));
      assert.equal(request.maxTokens,2048);
    }
    const smaller=await hooks.get('agent/request')({agent},async()=>({provider:'lmstudio',maxTokens:1024}));
    assert.equal(smaller.maxTokens,1024);
    const other=await hooks.get('agent/request')({agent},async()=>({provider:'other',maxTokens:8192}));
    assert.equal(other.maxTokens,8192);
    assert.equal(agent.session.requestHeader().config.maxTokens,8192,'original durable header must not be edited');
  } finally { globalThis.fetch=originalFetch; }
});

test('non-shrinking soft compaction preserves usable history, but hard pressure and cancellation still fail closed', async () => {
  const {plugin,agent}=fixture();
  plugin.selectRange=()=>({start:1,end:2});
  let count=11000;
  plugin.measureGuard=async()=>({count,budget:{trigger:10240,available:12800}});
  const refused=new Error('summary is not smaller than the shadowed content (402 estimated framed tokens >= 234)');
  plugin.compactRegion=async()=>{throw refused;};
  assert.equal(await plugin.compactIfNeeded(agent,'pressure',new AbortController().signal),null);
  count=13000;
  await assert.rejects(plugin.compactIfNeeded(agent,'pressure',new AbortController().signal),e=>e===refused);
  count=11000;
  await assert.rejects(plugin.compactIfNeeded(agent,'context-overflow',new AbortController().signal),e=>e===refused);
  let measures=0;
  plugin.softPressure.delete(agent.session);
  plugin.measureGuard=async()=>({count:++measures===1?11000:13000,budget:{trigger:10240,available:12800}});
  await assert.rejects(plugin.compactIfNeeded(agent,'pressure',new AbortController().signal),e=>e===refused);
  plugin.measureGuard=async()=>({count:11000,budget:{trigger:10240,available:12800}});
  plugin.softPressure.delete(agent.session);
  plugin.compactRegion=async()=>{throw new Error('Summary is missing the Failures section');};
  await assert.rejects(plugin.compactIfNeeded(agent,'pressure',new AbortController().signal),/missing the Failures/);
  const controller=new AbortController();
  plugin.compactRegion=async()=>{controller.abort(new Error('cancelled'));throw refused;};
  await assert.rejects(plugin.compactIfNeeded(agent,'pressure',controller.signal),/cancelled/);
  plugin.compactRegion=async()=>{agent.session.surface.replaceGeneration++;throw refused;};
  await assert.rejects(plugin.compactIfNeeded(agent,'pressure',new AbortController().signal),e=>e===refused);
});
