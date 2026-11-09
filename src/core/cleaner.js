const FILLERS = [/^certainly[,!]?\s*/i, /^great question[,!]?\s*/i, /^as an ai[,!]?\s*/i, /^sure[,!]?\s*/i];
const THINK = /<think>[\s\S]*?<\/think>|thinking:\s*[\s\S]*?(?=\n\n|$)/gi;
export function cleanWhatsApp(text, { maxChars = 900, allowLong = false } = {}) {
  if (!text || typeof text !== 'string') return '';
  let out = text.replace(THINK, '').replace(/[\u2013\u2014]/g, ',').trim();
  for (const pattern of FILLERS) out = out.replace(pattern, '');
  out = out.replace(/^#{1,6}\s+/gm, '').replace(/\|/g, ' ');
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  if (!allowLong && out.length > maxChars) out = `${out.slice(0, maxChars - 1).trimEnd()}…`;
  return out;
}
