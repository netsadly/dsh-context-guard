import { assertTextContent, GuardError } from './core.mjs';

// Image references are NOT image tokens. Keep originals intact for the native
// attachment adapter; use a detached text projection only for token counting.
export function imageBudget(messages, model, requestTarget) {
  let tokens = 0;
  function blocks(content, role, nested = false) {
    if (!Array.isArray(content)) return content;
    return content.map(block => {
      if (block.type === 'tool-result' && Array.isArray(block.content)) return { ...block, content: blocks(block.content, role, true) };
      if (block.type !== 'image') return block;
      const ref = block.attachment;
      if (!ref || typeof ref.attachmentId !== 'string' || !ref.attachmentId ||
          !['image/png', 'image/jpeg', 'image/webp'].includes(ref.mediaType) ||
          ![ref.width, ref.height, ref.bytes].every(n => Number.isSafeInteger(n) && n > 0) ||
          (block.offloaded !== undefined && block.offloaded !== true) ||
          !['user', 'tool'].includes(role) || nested) {
        throw new GuardError('UNSUPPORTED_CONTENT', 'Invalid or unsupported image attachment');
      }
      if (block.offloaded !== true) {
        if (model.type !== 'vlm') throw new GuardError('UNSUPPORTED_CONTENT', 'The loaded text model cannot receive images; select a vision model');
        // Qwen3.5 uses 16px patches, merged 2x2. Deliberately reserve the
        // merged grid at DOUBLE cost plus framing and minimum-size upscaling. Unknown vision
        // architectures still support text, but need a verified image budget.
        // https://huggingface.co/Qwen/Qwen3.5-27B/blob/main/config.json
        if (model.arch !== 'qwen35') throw new GuardError('UNSUPPORTED_CONTENT', `Image budgeting is not verified for architecture ${model.arch ?? 'unknown'}`);
        const size = requestTarget ? requestTarget(ref) : ref;
        if (!size || ![size.width, size.height].every(n => Number.isSafeInteger(n) && n > 0)) throw new GuardError('UNSUPPORTED_CONTENT', 'Invalid request image dimensions');
        tokens += Math.max(512, (Math.ceil(size.width / 32) + 1) * (Math.ceil(size.height / 32) + 1) * 2) + 256;
        if (!Number.isSafeInteger(tokens)) throw new GuardError('UNSUPPORTED_CONTENT', 'Image budget is too large');
      }
      return { type: 'text', text: `[Image attachment ${JSON.stringify(ref)}; ${block.offloaded ? 'offloaded' : 'visual tokens reserved separately'}]` };
    });
  }
  const textMessages = messages.map(message => ({ ...message, content: blocks(message.content, message.role) }));
  assertTextContent(textMessages);
  return { messages: textMessages, tokens };
}

export function hasImage(content) {
  return Array.isArray(content) && content.some(block => block.type === 'image' || (block.type === 'tool-result' && hasImage(block.content)));
}
