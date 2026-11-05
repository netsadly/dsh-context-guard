import { GuardError } from './core.mjs';

// The Harness adapter can omit reasoning_effort for "off". On LM Studio that
// leaves model-default thinking enabled, consuming the entire summary allowance.
// Only our tool-free compaction calls use this explicit local transport.
export async function completeLocal(config, request) {
  const signal = request.signal;
  signal?.throwIfAborted();
  const messages = request.messages.map(message => {
    if (!Array.isArray(message.content) || message.content.some(block => block.type !== 'text')) throw new GuardError('SUMMARY', 'Summary transport accepts only text messages');
    return { role: message.role, content: message.content.map(block => block.text).join('\n') };
  });
  const response = await fetch(`${config.baseURL.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST', signal, redirect: 'error', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: request.model, messages, max_tokens: request.maxTokens, temperature: 0, stream: false, reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false } })
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    const overflow = /context.{0,30}(exceed|length|window)|exceed.{0,30}context/i.test(detail);
    throw new GuardError(overflow ? 'CONTEXT_WINDOW_EXCEEDED' : 'SUMMARY_HTTP', `Summary HTTP ${response.status}${overflow ? ': context overflow' : ''}`);
  }
  const body = await response.json();
  signal?.throwIfAborted();
  const choice = body.choices?.[0];
  if (choice?.finish_reason !== 'stop' || typeof choice.message?.content !== 'string' || choice.message.tool_calls?.length) throw new GuardError('SUMMARY', 'Local summary missing a complete text-only stop result');
  return choice.message.content;
}
