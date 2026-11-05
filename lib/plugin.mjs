import { configOf, estimate, assertTextContent, loadedCapacity, budgetOf, summarizeBounded, GuardError } from './core.mjs';
import { completeLocal } from './transport.mjs';

export function createGuardPlugin({ BasicCompactionEngine, toolPairingBalancedBefore, BlockAssembler, overflowCode, makeCounter }) {
  return class ContextGuard extends BasicCompactionEngine {
    static inject = ['llm', 'tokenMeter', 'sessions', 'commands'];
    // Core validation is authoritative; do not inherit the base-only schema.
    static Config = undefined;

    constructor(ctx, input = {}) {
      const config = configOf(input);
      super(ctx, { auto: false, headroomTokens: config.safetyTokens, maxTokens: config.summaryTokens, retainTokens: config.retainTokens });
      this.guard = config;
      this.countTokens = makeCounter(config);
      this.retries = new WeakMap();
      this.pending = new WeakMap();

      ctx.on('agent/pre-step', async (event, next) => {
        const decision = await next();
        if (decision.kind !== 'enter' || !this.target(event.agent)) return decision;
        this.pending.set(event.agent, decision.messages);
        await this.compactIfNeeded(event.agent, 'pressure', event.signal);
        return decision;
      });
      ctx.on('agent/request', async ({ agent }, next) => {
        const proposal = await next();
        // The loop has admitted pre-step messages to the session by this point.
        this.pending.delete(agent);
        if (proposal.provider !== config.provider) return proposal;
        // Replace only a broken near-zero historical cap; preserve valid choices.
        return { ...proposal, maxTokens: proposal.maxTokens >= 128 ? proposal.maxTokens : config.outputTokens };
      });
      ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') { this.retries.delete(agent); this.pending.delete(agent); } });
      ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
        this.pending.delete(agent);
        if (!this.target(agent) || failure.code !== overflowCode || signal.aborted || this.retries.get(agent)) return next();
        this.retries.set(agent, true);
        const generation = agent.session.surface.replaceGeneration;
        await this.compactIfNeeded(agent, 'context-overflow', signal);
        return agent.session.surface.replaceGeneration > generation ? { kind: 'retry' } : next();
      });

      const self = this;
      ctx.on('llm/stream', function (request, next) {
        if (request.provider !== config.provider) return next();
        return (async function* () {
          assertTextContent(request.messages);
          const capacity = await loadedCapacity(config, request.model, request.signal);
          const budget = budgetOf(config, capacity, request.maxTokens ?? config.outputTokens);
          const count = await self.countTokens(request.model, request.messages, request.tools ?? [], request.signal);
          if (count > budget.available) {
            yield { type: 'finish', reason: { kind: 'error', failure: { code: overflowCode, message: `Context Guard stopped an oversized request: estimate ${count}, input budget ${budget.available}. Use /context-guard recover.` } } };
            return;
          }
          if (request.purpose === 'compaction') {
            const text = await completeLocal(config, request);
            yield { type: 'text-delta', index: 0, text };
            yield { type: 'finish', reason: { kind: 'stop' } };
            return;
          }
          yield* next();
        })();
      });
      ctx.commands.register({
        definitionId: 'dsh-context-guard', name: 'context-guard', description: 'Context budget status or safe history recovery: status | recover',
        input: { hint: 'status | recover' },
        handler: async invocation => {
          const action = invocation.rawInput.trim() || 'status';
          if (!['status', 'recover'].includes(action)) return { kind: 'error', text: 'Usage: /context-guard status | recover' };
          try {
            if (!self.target(invocation.agent)) throw new GuardError('ROUTE', 'This command supports only the configured local provider');
            if (action === 'recover') {
              const result = await self.compactNow(invocation.agent, invocation.signal, invocation.commandId);
              return { kind: 'success', text: result ? `Recovered ${result.shadowedSeqs.length} history items; original events retained. Task was not resumed.` : 'No balanced compactable history.', ...(result ? { sourceEventSeq: result.summarySeq } : {}) };
            }
            const state = await self.measureGuard(invocation.agent, invocation.signal);
            return { kind: 'success', text: JSON.stringify({ ...state.budget, estimatedInput: state.count, note: 'Padded tokenizer estimate; not exact provider-template usage. Original history is retained.' }) };
          } catch (error) { return { kind: 'error', text: `Context Guard: ${error.message}` }; }
        }
      });
    }

    target(agent) {
      const options = agent.options ?? {};
      const header = agent.session.requestHeader()?.config ?? {};
      const provider = options.provider ?? header.provider;
      const model = options.model ?? header.model;
      return provider === this.guard.provider && model ? { provider, model } : null;
    }

    async measureGuard(agent, signal) {
      const target = this.target(agent);
      if (!target) throw new GuardError('ROUTE', 'Unsupported route');
      const capacity = await loadedCapacity(this.guard, target.model, signal);
      const header = agent.session.requestHeader();
      const output = agent.options.maxTokens ?? header?.config.maxTokens;
      const budget = budgetOf(this.guard, capacity, output >= 128 ? output : this.guard.outputTokens);
      const messages = [...agent.session.deriveMessages(), ...(this.pending.get(agent) ?? [])];
      assertTextContent(messages);
      const count = Math.max(this.ctx.tokenMeter.measure(agent.session).totalTokens, await this.countTokens(target.model, messages, header?.tools ?? [], signal));
      return { count, budget };
    }

    selectRange(session) {
      const nodes = session.surface.nodes;
      const startIndex = session.eventAt(nodes[0])?.type === 'system/message' ? 1 : 0;
      let retained = 0; let cut = nodes.length;
      while (cut > startIndex) {
        const message = session.deriveEventMessage(session.eventAt(nodes[cut - 1]));
        retained += estimate(message);
        cut--;
        if (retained >= this.guard.retainTokens && toolPairingBalancedBefore(session, nodes[cut])) break;
      }
      if (cut <= startIndex) return null;
      return { start: nodes[startIndex], end: nodes[cut - 1] };
    }

    async compactIfNeeded(agent, trigger, signal) {
      if (!this.target(agent)) return null;
      let state = await this.measureGuard(agent, signal);
      if (trigger !== 'context-overflow' && state.count < state.budget.trigger) return null;
      let result = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        signal?.throwIfAborted();
        const range = this.selectRange(agent.session);
        if (!range) break;
        result = await this.compactRegion(range.start, range.end, agent, signal);
        state = await this.measureGuard(agent, signal);
        if (state.count < state.budget.trigger) return result;
      }
      throw new GuardError('PRESSURE', 'History could not be reduced below the safe budget. Original history retained; use /context-guard recover while idle, or shorten the newest input.');
    }

    async summarize(input, agent, signal) {
      const target = this.target(agent);
      if (!target) throw new GuardError('ROUTE', 'Unsupported summarization route');
      const capacity = await loadedCapacity(this.guard, target.model, signal);
      const timeout = AbortSignal.timeout(this.guard.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const result = await summarizeBounded(input.messages, {
        config: this.guard, capacity, signal: combined,
        complete: async (messages, maxTokens, abort) => {
          const assembler = new BlockAssembler();
          let sawFinish = false;
          for await (const chunk of this.ctx.llm.stream({ ...target, messages, maxTokens, reasoningEffort: 'off', purpose: 'compaction', sessionId: agent.session.id, signal: abort })) {
            abort.throwIfAborted();
            if (sawFinish) throw new GuardError('SUMMARY', 'Data received after terminal summary finish');
            if (chunk.type === 'finish') sawFinish = true;
            assembler.push(chunk);
          }
          abort.throwIfAborted();
          if (!sawFinish) throw new GuardError('SUMMARY', 'Summary stream ended without an explicit finish');
          const finish = assembler.finish;
          if (finish.kind === 'error' || finish.kind === 'aborted') {
            const error = new GuardError(finish.failure.code === overflowCode ? 'CONTEXT_WINDOW_EXCEEDED' : 'SUMMARY', finish.failure.message);
            throw error;
          }
          const blocks = assembler.blocks();
          if (blocks.some(block => !['text', 'reasoning'].includes(block.type))) throw new GuardError('SUMMARY', 'Unexpected non-text summary output');
          return { finish: finish.kind === 'stop' ? 'stop' : finish.kind, text: blocks.filter(block => block.type === 'text').map(block => block.text).join('\n') };
        }
      });
      return { summary: [{ type: 'text', text: result.text }], provider: target.provider, model: target.model, maxTokens: this.guard.summaryTokens };
    }
  };
}
