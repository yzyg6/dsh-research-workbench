export function stripAgentEnvelope(text) {
  // A continuation can echo ACP metadata around the model response.
  return text.trim()
    .replace(/^<acp(?:\s+[^<>]{1,256})?>[^<>]{0,256}<\/acp>\s*/, '')
    .replace(/\s*<acp(?:\s+[^<>]{1,256})?>[^<>]{0,256}<\/acp>$/, '').trim();
}

export function structuredAgentReply(text) {
  const reply = stripAgentEnvelope(text);
  const wrapped = reply.match(/^\x60{3}(?:json)?\s*([\s\S]*?)\s*\x60{3}$/i);
  if (wrapped) return wrapped[1];
  const fences = [...reply.matchAll(/^\s*\x60{3}(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n[\t ]*\x60{3}[\t ]*$/gim)];
  if (fences.length === 1 && !reply.startsWith('{')) return fences[0][1].trim();
  const start = reply.indexOf('{');
  if (start > 0 && start <= 300 && reply.endsWith('}') && fences.length === 0) return reply.slice(start);
  return reply;
}
