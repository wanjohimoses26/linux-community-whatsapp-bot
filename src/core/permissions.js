export const ROLES = Object.freeze({ owner: 5, admin: 4, mod: 3, helper: 2, member: 1 });
export function hasRole(role, required) { return (ROLES[role] || 0) >= (ROLES[required] || 99); }
export function isConfiguredAdmin(jid, config) { return config.adminJids.has(jid) || jid === config.OWNER_JID; }
