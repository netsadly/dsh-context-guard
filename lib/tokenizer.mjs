import { GuardError } from './core.mjs';

export function makeTokenCounter(LMStudioClient, config) {
  const client = new LMStudioClient({ baseUrl: config.baseURL.replace(/^http:/, 'ws:').replace(/\/$/, '') });
  let inFlight;
  return async (modelId, messages, tools = [], signal) => {
    signal?.throwIfAborted();
    if (inFlight) throw new GuardError('TOKENIZER_BUSY', 'Previous tokenizer RPC is still pending; refusing to accumulate requests');
    const model = client.llm.createDynamicHandle({ identifier: modelId, deviceIdentifier: null });
    const timeout = AbortSignal.timeout(config.capacityTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let listener;
    const cancelled = new Promise((_, reject) => {
      listener = () => reject(combined.reason);
      combined.addEventListener('abort', listener, { once: true });
    });
    try {
      // Tokenize the complete serialized structure rather than chars/4. Extra
      // per-message framing covers differences from the provider's template.
      // This is still a padded estimate, not an exact wire-template count.
      // SDK 1.5 has no cancellation argument for countTokens. Cancel the caller
      // promptly, but keep the single-flight lock until the RPC actually settles.
      const pending = model.countTokens(JSON.stringify({ messages, tools }));
      inFlight = pending;
      pending.then(() => { if (inFlight === pending) inFlight = undefined; }, () => { if (inFlight === pending) inFlight = undefined; });
      const count = await Promise.race([pending, cancelled]);
      combined.throwIfAborted();
      if (!Number.isSafeInteger(count) || count < 0) throw new GuardError('TOKENIZER', 'Invalid tokenizer result');
      return Math.ceil(count * 1.1) + messages.length * 32 + 512;
    } finally { combined.removeEventListener('abort', listener); }
  };
}
