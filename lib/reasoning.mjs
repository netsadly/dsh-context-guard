export const REASONING_ONLY_EOS = 'CONTEXT_GUARD_REASONING_ONLY_EOS';

// Keep the original stream, including reasoning and usage, in the failed attempt.
// Only a normal stop with reasoning but no answer/action becomes an error.
export async function* requireReasoningAnswer(stream, signal) {
  let reasoning = false, answer = false;
  for await (const chunk of stream) {
    signal?.throwIfAborted();
    if (chunk.type === 'reasoning-delta' && chunk.text?.trim()) reasoning = true;
    if (chunk.type === 'text-delta' && chunk.text?.trim()) answer = true;
    if (chunk.type === 'tool-call-delta') answer = true;
    if (chunk.type === 'block-start' && !['text', 'reasoning'].includes(chunk.blockType)) answer = true;
    if (chunk.type === 'block-end') {
      if (chunk.block.type === 'reasoning' && chunk.block.text?.trim()) reasoning = true;
      else if (chunk.block.type === 'text') answer ||= !!chunk.block.text?.trim();
      else if (chunk.block.type !== 'reasoning') answer = true;
    }
    if (chunk.type === 'finish' && chunk.reason.kind === 'stop' && reasoning && !answer) {
      yield { ...chunk, reason: { kind: 'error', failure: {
        code: REASONING_ONLY_EOS,
        message: '模型在思考阶段提前结束，未生成正文或工具调用。思考模式保持开启；如已重试仍失败，请调整模型设置后再试，不能将本次视为任务完成。'
      } } };
    } else yield chunk;
  }
}
