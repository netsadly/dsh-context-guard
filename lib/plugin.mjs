import { configOf, estimate, assertTextContent, loadedCapacity, budgetOf, summarizeBounded, GuardError, SUMMARY_INSTRUCTION, REPAIR_INSTRUCTION } from './core.mjs';
import { completeLocal } from './transport.mjs';
import { checkpointStore } from './checkpoints.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function createGuardPlugin({ BasicCompactionEngine, toolPairingBalancedBefore, toolPairingBalancedAfter, BlockAssembler, overflowCode, makeCounter, checkpointRoot = join(homedir(), '.dsh', 'context-guard-checkpoints') }) {
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
      this.recovery = new WeakMap();
      this.softPressure = new WeakMap();

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
        // Apply the same configured ceiling as pre-step budgeting. Old durable
        // headers may still carry a larger reservation from another capacity.
        return { ...proposal, maxTokens: this.outputReservation(proposal.maxTokens) };
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
              if (self.recovery.has(invocation.agent)) throw new GuardError('BUSY', 'Recovery already running');
              const progress = { saved: 0, reused: 0, paused: false };
              self.recovery.set(invocation.agent, progress);
              try {
                const result = await self.compactNow(invocation.agent, invocation.signal, invocation.commandId);
                return { kind: 'success', text: result ? `Recovered ${result.shadowedSeqs.length} history items; original events retained. Task was not resumed.` : 'No balanced compactable history.', ...(result ? { sourceEventSeq: result.summarySeq } : {}) };
              } catch (error) {
                if (progress.paused && !invocation.signal.aborted) return { kind: 'success', text: `Recovery paused: saved ${progress.saved}, reused ${progress.reused} checkpoints. Run recover again to continue. History has NOT been replaced; task was not resumed.` };
                throw error;
              } finally { self.recovery.delete(invocation.agent); }
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

    outputReservation(requested) {
      return Number.isSafeInteger(requested) && requested >= 128
        ? Math.min(requested, this.guard.outputTokens)
        : this.guard.outputTokens;
    }

    async measureGuard(agent, signal) {
      const target = this.target(agent);
      if (!target) throw new GuardError('ROUTE', 'Unsupported route');
      const capacity = await loadedCapacity(this.guard, target.model, signal);
      const header = agent.session.requestHeader();
      const output = agent.options.maxTokens ?? header?.config.maxTokens;
      const budget = budgetOf(this.guard, capacity, this.outputReservation(output));
      const messages = [...agent.session.deriveMessages(), ...(this.pending.get(agent) ?? [])];
      assertTextContent(messages);
      const count = Math.max(this.ctx.tokenMeter.measure(agent.session).totalTokens, await this.countTokens(target.model, messages, header?.tools ?? [], signal));
      return { count, budget };
    }

    selectRange(session, includeCompletedTail = false) {
      const nodes = session.surface.nodes;
      const startIndex = session.eventAt(nodes[0])?.type === 'system/message' ? 1 : 0;
      if (includeCompletedTail) {
        // Completed tool results may themselves exceed the budget. Include their
        // whole balanced group instead of repeatedly compressing a tiny prefix.
        let end = nodes.length - 1;
        const last = session.eventAt(nodes[end]);
        if (last?.type === 'user/message' && last.data?.source?.kind !== 'compact-checkpoint') end--;
        for (; end >= startIndex; end--) {
          if (end === startIndex && session.eventAt(nodes[end])?.data?.source?.kind === 'compact-checkpoint') return null;
          if (toolPairingBalancedAfter(session, nodes[end])) return { start: nodes[startIndex], end: nodes[end] };
        }
        return null;
      }
      let retained = 0; let cut = nodes.length;
      while (cut > startIndex) {
        const message = session.deriveEventMessage(session.eventAt(nodes[cut - 1]));
        retained += estimate(message);
        cut--;
        if (retained >= this.guard.retainTokens && toolPairingBalancedBefore(session, nodes[cut])) break;
      }
      if (cut <= startIndex) return null;
      if (cut === startIndex + 1 && session.eventAt(nodes[startIndex])?.data?.source?.kind === 'compact-checkpoint') return null;
      return { start: nodes[startIndex], end: nodes[cut - 1] };
    }

    softPlan(agent, state, range) {
      const target = this.target(agent);
      const generation = agent.session.surface.replaceGeneration;
      const budgetKey = JSON.stringify([target, state.budget.capacity, state.budget.output, state.budget.available]);
      const rangeKey = JSON.stringify([generation, range.start, range.end]);
      const gap = Math.max(256, Math.min(2048, Math.floor(state.budget.available * 0.08)));
      const nodes = agent.session.surface.nodes;
      const start = nodes.indexOf(range.start), end = nodes.indexOf(range.end);
      if (start < 0 || end < start) throw new GuardError('RANGE', 'Compaction range is not on the current surface');
      const sourceTokens = nodes.slice(start, end + 1).reduce((total, seq) =>
        total + estimate(agent.session.deriveEventMessage(agent.session.eventAt(seq))), 0);
      return { budgetKey, rangeKey, generation, gap, sourceTokens };
    }

    deferSoftCompaction(agent, state, plan) {
      // Small prefixes rarely repay a seven-section checkpoint plus framing.
      // This only postpones optional work; hard pressure always bypasses it.
      if (plan.sourceTokens < Math.min(this.guard.summaryTokens, 1024) + plan.gap) return true;
      const previous = this.softPressure.get(agent.session);
      if (!previous || previous.budgetKey !== plan.budgetKey || previous.generation !== plan.generation) return false;
      if (previous.rejectedRange === plan.rangeKey) return true;
      return previous.afterCount !== undefined && state.count < previous.afterCount + plan.gap;
    }

    async compactIfNeeded(agent, trigger, signal) {
      if (!this.target(agent)) return null;
      let state = await this.measureGuard(agent, signal);
      if (trigger !== 'context-overflow' && state.count < state.budget.trigger) return null;
      let result = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        signal?.throwIfAborted();
        const range = this.selectRange(agent.session, state.count > state.budget.available || trigger === 'context-overflow');
        if (!range) break;
        const hard = state.count > state.budget.available || trigger === 'context-overflow';
        const plan = this.softPlan(agent, state, range);
        if (!hard && this.deferSoftCompaction(agent, state, plan)) return result;
        const generation = agent.session.surface.replaceGeneration;
        try {
          result = await this.compactRegion(range.start, range.end, agent, signal);
        } catch (error) {
          signal?.throwIfAborted();
          // The native transaction rejects non-reducing summaries before commit.
          // Soft pressure is advisory: unchanged, still-safe history can proceed.
          if (trigger !== 'context-overflow' && state.count <= state.budget.available
            && agent.session.surface.replaceGeneration === generation
            && error instanceof Error && error.message.startsWith('summary is not smaller than the shadowed content (')) {
            const current = await this.measureGuard(agent, signal);
            signal?.throwIfAborted();
            if (current.count <= current.budget.available) {
              this.softPressure.set(agent.session, { ...plan, rejectedRange: plan.rangeKey });
              return result;
            }
          }
          throw error;
        }
        state = await this.measureGuard(agent, signal);
        this.softPressure.set(agent.session, {
          budgetKey: plan.budgetKey, generation: agent.session.surface.replaceGeneration,
          afterCount: state.count
        });
        if (state.count <= state.budget.available) return result;
      }
      if (trigger !== 'context-overflow' && state.count <= state.budget.available) return result;
      throw new GuardError('PRESSURE', 'History could not be reduced below the safe budget. Original history retained; use /context-guard recover while idle, or shorten the newest input.');
    }

    async summarize(input, agent, signal) {
      const target = this.target(agent);
      if (!target) throw new GuardError('ROUTE', 'Unsupported summarization route');
      const capacity = await loadedCapacity(this.guard, target.model, signal);
      const timeout = AbortSignal.timeout(this.recovery.has(agent) ? Math.min(this.guard.timeoutMs, 210000) : this.guard.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const progress = this.recovery.get(agent);
      const checkpoints = progress ? checkpointStore(checkpointRoot, {
        version: 2, session: agent.session.id, target, capacity, config: this.guard, prompt: [SUMMARY_INSTRUCTION, REPAIR_INSTRUCTION], input
      }) : undefined;
      let result;
      try { result = await summarizeBounded(input.messages, {
        config: this.guard, capacity, signal: combined,
        checkpoints, maxNewCalls: progress ? 2 : Infinity,
        onProgress: state => { if (progress) Object.assign(progress, state); },
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
      }); } catch (error) { if (progress && error.code === 'CHECKPOINT_PAUSE') progress.paused = true; throw error; }
      return { summary: [{ type: 'text', text: result.text }], provider: target.provider, model: target.model, maxTokens: this.guard.summaryTokens };
    }
  };
}
