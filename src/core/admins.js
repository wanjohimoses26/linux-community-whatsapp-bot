/** Admin identity helpers. WhatsApp may show the same person as a phone JID or a LID, so we keep every form we see. */
export const normalizeJid = (jid = '') => String(jid).split('@')[0].split(':')[0];

export function messageIds(message, isGroup) {
  const k = message?.key || {};
  const raw = isGroup ? [k.participant, k.participantPn, k.participantAlt] : [k.remoteJid, k.remoteJidAlt, k.participantPn];
  return [...new Set(raw.filter(Boolean).map(normalizeJid).filter(Boolean))];
}

export function createAdminList({ settings, envJids = [], logger } = {}) {
  const ids = new Set(envJids.filter(Boolean).map(normalizeJid));
  return {
    async load() {
      if (!settings) return;
      try { for (const key of Object.keys(await settings.list('admins'))) ids.add(key); }
      catch (err) { logger?.warn({ err }, 'could not load saved admins'); }
    },
    has: (candidates) => candidates.some((id) => ids.has(id)),
    async add(candidates) {
      for (const id of candidates) { ids.add(id); if (settings) await settings.set('admins', id, true); }
    },
    count: () => ids.size
  };
}
