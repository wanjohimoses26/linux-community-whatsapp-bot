import express from 'express';
import pino from 'pino';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from 'baileys';
import QRCode from 'qrcode';
import { config } from './config.js';
import { Router } from './core/router.js';
import { SlidingWindow } from './core/rate-limit.js';
import { LoopGuard } from './core/loop-guard.js';
import { cleanWhatsApp } from './core/cleaner.js';
import { useSupabaseAuthState } from './core/supabase-auth.js';
import { createSettingsStore } from './core/settings.js';
import { ProviderRouter } from './ai/providers.js';
import { cookieHeader, cookieName, issueSession, parseCookies, validSession, verifyPassword, clearCookieHeader } from './core/web-auth.js';

const logger = pino({ level: config.LOG_LEVEL, redact: ['req.headers.authorization', 'password', 'token', 'key'] });
const app = express();
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'");
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
const startedAt = Date.now();
let socket;
let reconnectTimer;
let reconnectAttempt = 0;
let lastConnection = 'starting';
let latestQr = '';
const guard = new LoopGuard({ minIntervalMs: 5_000 });
const inboundLimit = new SlidingWindow({ limit: 30, windowMs: 60_000 });
const router = new Router({ logger });
const settingsStore = config.supabaseEnabled && config.AUTH_ENCRYPTION_KEY
  ? createSettingsStore({ url: config.SUPABASE_URL, apiKey: config.SUPABASE_API_KEY, botSecret: config.SUPABASE_BOT_SECRET, encryptionKey: config.AUTH_ENCRYPTION_KEY })
  : null;
const aiRouter = settingsStore ? new ProviderRouter({ settings: settingsStore, logger }) : null;

const esc = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const roleNames = ['announcements', 'open_chat', 'cyber', 'help', 'distro', 'projects'];
const setupOwners = new Set();
const setupGroupLists = new Map();
const webLoginLimit = new SlidingWindow({ limit: 5, windowMs: 15 * 60_000 });

const webAuthed = (req) => Boolean(config.ADMIN_PASSWORD_HASH && config.WEB_SESSION_SECRET && validSession(parseCookies(req.headers.cookie)[cookieName()], config.WEB_SESSION_SECRET));
const safeNext = (value) => ['/pair', '/setup'].includes(value) ? value : '/';
const loginPage = (next, error = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Secure bot login</title><style>body{font-family:system-ui;max-width:460px;margin:12vh auto;padding:20px;background:#f7f9fb;color:#17202a}main{background:#fff;padding:28px;border-radius:16px;box-shadow:0 8px 30px #17202a12}input,button{width:100%;box-sizing:border-box;padding:12px;margin-top:8px;border-radius:8px}input{border:1px solid #ccd5df}button{border:0;background:#1769aa;color:#fff;font-weight:700}.error{color:#b42318}</style></head><body><main><h1>Secure bot dashboard</h1><p>Enter the dashboard password to continue.</p>${error ? `<p class="error">${esc(error)}</p>` : ''}<form method="post" action="/login"><input type="hidden" name="next" value="${esc(next)}"><input type="password" name="password" autocomplete="current-password" required autofocus><button type="submit">Sign in</button></form></main></body></html>`;

async function participatingGroups() {
  return socket?.groupFetchAllParticipating ? await socket.groupFetchAllParticipating() : {};
}

app.get('/health', (req, res) => {
  if (config.HEALTH_TOKEN && req.get('x-health-token') !== config.HEALTH_TOKEN) return res.sendStatus(401);
  res.json({ ok: lastConnection === 'open', connection: lastConnection, uptimeSec: Math.floor((Date.now() - startedAt) / 1000) });
});
app.get('/login', (req, res) => res.type('html').send(loginPage(safeNext(req.query.next))));
app.post('/login', (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  if (!config.ADMIN_PASSWORD_HASH || !config.WEB_SESSION_SECRET) return res.status(503).send('Dashboard authentication is not configured.');
  if (!webLoginLimit.allow(ip)) return res.status(429).type('html').send(loginPage(safeNext(req.body.next), 'Too many attempts. Try again in 15 minutes.'));
  if (!verifyPassword(String(req.body.password || ''), config.ADMIN_PASSWORD_HASH)) return res.status(401).type('html').send(loginPage(safeNext(req.body.next), 'Incorrect password.'));
  res.setHeader('Set-Cookie', cookieHeader(issueSession(config.WEB_SESSION_SECRET)));
  res.redirect(safeNext(req.body.next));
});
app.get('/logout', (_req, res) => { res.setHeader('Set-Cookie', clearCookieHeader()); res.redirect('/'); });
app.get('/', (_req, res) => {
  res.status(200).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${config.BOT_NAME} Community Bot</title><style>body{font-family:system-ui,sans-serif;max-width:680px;margin:12vh auto;padding:24px;color:#17202a;background:#f7f9fb}main{background:#fff;border:1px solid #e3e8ed;border-radius:16px;padding:28px;box-shadow:0 8px 30px #17202a12}h1{margin-top:0}a{display:inline-block;margin:6px 8px 6px 0;padding:10px 14px;border-radius:8px;background:#1769aa;color:#fff;text-decoration:none}small{display:block;margin-top:18px;color:#607080}</style></head><body><main><h1>${config.BOT_NAME} Community Bot</h1><p>The service is online. WhatsApp connection status: <strong>${lastConnection}</strong>.</p><a href="/login?next=/pair">Connect WhatsApp</a><a href="/login?next=/setup">Configure bot</a><a href="/health">Health status</a><a href="/logout">Sign out</a><small>Dashboard access is password-protected. Keep your password private.</small></main></body></html>`);
});
app.get('/pair', async (req, res) => {
  if (!webAuthed(req)) return res.redirect('/login?next=/pair');
  res.setHeader('Cache-Control', 'no-store');
  if (!latestQr) return res.status(202).type('html').send('<!doctype html><meta http-equiv="refresh" content="4"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WhatsApp pairing</title><p>Waiting for a fresh QR code. Refreshing shortly…</p>');
  const image = await QRCode.toDataURL(latestQr, { errorCorrectionLevel: 'M', margin: 2, width: 320 });
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="20"><title>Pair ${config.BOT_NAME}</title><style>body{font-family:system-ui,sans-serif;text-align:center;margin:5vh auto;padding:20px;background:#f7f9fb;color:#17202a}main{background:#fff;border-radius:16px;padding:24px;max-width:420px;margin:auto;box-shadow:0 8px 30px #17202a12}img{width:320px;max-width:100%;image-rendering:pixelated}li{text-align:left;margin:10px 0}</style></head><body><main><h1>Connect ${config.BOT_NAME}</h1><ol><li>Open WhatsApp on the spare bot phone.</li><li>Go to <b>Settings → Linked devices → Link a device</b>.</li><li>Scan the QR code below.</li></ol><img src="${image}" alt="WhatsApp pairing QR code"><p>This QR refreshes automatically. Keep this link private.</p></main></body></html>`);
});
app.get('/setup', async (req, res) => {
  if (!webAuthed(req)) return res.redirect('/login?next=/setup');
  res.setHeader('Cache-Control', 'no-store');
  if (!settingsStore) return res.status(503).send('Secure settings storage is not ready.');
  try {
    const groups = socket?.groupFetchAllParticipating ? await socket.groupFetchAllParticipating() : {};
    const savedGroups = await settingsStore.list('group_map');
    const savedKeys = await settingsStore.list('ai_keys');
    const options = Object.entries(groups).map(([id, group]) => `<option value="${esc(id)}">${esc(group.subject || id)} (${esc(id)})</option>`).join('');
    const roleFields = roleNames.map((role) => `<label>${esc(role.replace('_', ' '))}<select name="${role}"><option value="">Not assigned</option>${options}</select></label>`).join('');
    const savedNote = req.query.saved ? '<p class="ok">Saved securely. Group mapping and provider keys are encrypted in Supabase.</p>' : '';
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(config.BOT_NAME)} setup</title><style>body{font-family:system-ui;max-width:760px;margin:5vh auto;padding:20px;background:#f7f9fb;color:#17202a}main{background:#fff;padding:24px;border-radius:16px;box-shadow:0 8px 30px #17202a12}label{display:block;margin:12px 0;text-transform:capitalize}select,input{display:block;width:100%;box-sizing:border-box;padding:11px;margin-top:5px;border:1px solid #ccd5df;border-radius:8px}button{margin-top:18px;padding:12px 18px;border:0;border-radius:8px;background:#1769aa;color:#fff;font-weight:700}.ok{color:#087443}.hint{color:#607080}</style></head><body><main><h1>${esc(config.BOT_NAME)} setup</h1><p class="hint">Choose which WhatsApp group plays each community role. Provider keys are encrypted before storage and are never displayed again.</p>${savedNote}<form method="post" action="/setup"><h2>Groups</h2>${roleFields}<h2>AI providers</h2><label>Groq API key<input type="password" name="groq" autocomplete="off"></label><label>OpenRouter API key<input type="password" name="openrouter" autocomplete="off"></label><label>Kilo API key<input type="password" name="kilo" autocomplete="off"></label><button type="submit">Save securely</button></form><p class="hint">Found ${Object.keys(groups).length} WhatsApp groups. <a href="/">Back to dashboard</a></p></main></body></html>`);
  } catch (error) { logger.error({ err: error }, 'setup page failed'); res.status(500).send('Could not load setup data.'); }
});
app.post('/setup', async (req, res) => {
  if (!webAuthed(req)) return res.redirect('/login?next=/setup');
  res.setHeader('Cache-Control', 'no-store');
  if (!settingsStore) return res.status(503).send('Secure settings storage is not ready.');
  try {
    for (const role of roleNames) if (req.body[role]) await settingsStore.set('group_map', role, req.body[role]);
    for (const provider of ['groq', 'openrouter', 'kilo']) if (req.body[provider]?.trim()) await settingsStore.set('ai_keys', provider, req.body[provider].trim());
    res.redirect('/setup?saved=1');
  } catch (error) { logger.error({ err: error }, 'setup save failed'); res.status(500).send('Could not save setup data.'); }
});
app.listen(config.PORT, () => logger.info({ port: config.PORT }, 'health server listening'));

router.command('help', async ({ send }) => send(cleanWhatsApp(`*${config.BOT_NAME} commands*\n!rank, !top, !start, !explain <command>, !privacy\nAsk a question with !ask <question>.`)));
router.command('privacy', async ({ send }) => send('I store minimal metadata for moderation, XP, and operations. Raw message text is not kept as a long-term record. Ask an admin or use !stop to opt out of onboarding.'));
router.command('start', async ({ send }) => send('Welcome. Start with one small Linux goal today, then ask in Help & Support if you get stuck.'));
router.command('claim', async ({ args, send, isGroup, sender }) => {
  if (isGroup) return;
  if (!config.PAIR_TOKEN || args.trim() !== config.PAIR_TOKEN) return send('That setup code is not valid. Open the private setup link to get the current code.');
  setupOwners.add(sender);
  return send('Setup claimed for this DM. Send !groups and I will show every WhatsApp group I can see. I will not assign or post to any group until you choose it.');
});
router.command('groups', async ({ send, isGroup, sender }) => {
  if (isGroup) return;
  if (!setupOwners.has(sender)) return send('For safety, claim setup first with !claim <private setup code>.');
  const groups = await participatingGroups();
  const list = Object.entries(groups);
  setupGroupLists.set(sender, list);
  if (!list.length) return send('I cannot see any WhatsApp groups yet. Add the bot number to a group, then send !groups again.');
  const lines = list.map(([id, group], index) => `${index + 1}. ${group.subject || id}`);
  return send(`I can see these groups:\n\n${lines.join('\n')}\n\nChoose only the community groups. Reply like:\n!use 2 open_chat\n!use 5 cyber\n\nRoles: ${roleNames.join(', ')}\nUnassigned groups will be ignored.`);
});
router.command('use', async ({ args, send, isGroup, sender }) => {
  if (isGroup) return;
  if (!setupOwners.has(sender)) return send('For safety, claim setup first with !claim <private setup code>.');
  if (!settingsStore) return send('Secure setup storage is not ready yet.');
  const match = args.trim().match(/^(\d+)\s+(announcements|open_chat|cyber|help|distro|projects)$/i);
  const list = setupGroupLists.get(sender) || [];
  if (!match) return send('Use this format: !use <group number> <role>\nExample: !use 3 cyber');
  const index = Number(match[1]) - 1;
  if (!list[index]) return send('That group number is not in the last !groups list. Send !groups again.');
  const [groupId, group] = list[index];
  const role = match[2].toLowerCase();
  await settingsStore.set('group_map', role, groupId);
  return send(`Saved: ${group.subject || groupId} is now the ${role.replace('_', ' ')} group. Send !groups to review or !use another assignment.`);
});
router.command('done', async ({ send, isGroup, sender }) => {
  if (isGroup) return;
  if (!setupOwners.has(sender)) return send('For safety, claim setup first with !claim <private setup code>.');
  setupOwners.delete(sender);
  setupGroupLists.delete(sender);
  return send('Setup complete. I will only use the groups you assigned. You can repeat the private claim flow later to change the mapping.');
});
router.command('ask', async ({ args, send }) => {
  if (!aiRouter) return send('AI setup is not ready yet. Open the private setup page and add a provider key.');
  if (!args.trim()) return send('Use !ask followed by your Linux question.');
  try { await send(cleanWhatsApp(await aiRouter.ask({ question: args.trim() }), { maxChars: config.MAX_MESSAGE_CHARS })); }
  catch { await send('No AI provider is available right now. Add a provider key in the private setup page or try again later.'); }
});

async function connect() {
  const result = await guard.run('connect', async () => {
    if (config.NODE_ENV === 'production' && (!config.supabaseEnabled || !config.AUTH_ENCRYPTION_KEY)) {
      lastConnection = 'blocked';
      logger.error('production startup blocked: encrypted Supabase auth requires SUPABASE_URL, SUPABASE_API_KEY, SUPABASE_BOT_SECRET, and AUTH_ENCRYPTION_KEY');
      return;
    }
    const auth = config.NODE_ENV === 'production'
      ? await useSupabaseAuthState({ url: config.SUPABASE_URL, apiKey: config.SUPABASE_API_KEY, botSecret: config.SUPABASE_BOT_SECRET, encryptionKey: config.AUTH_ENCRYPTION_KEY, logger })
      : await useMultiFileAuthState('.qr');
    const { state, saveCreds } = auth;
    socket = makeWASocket({ auth: state, logger: pino({ level: 'silent' }), markOnlineOnConnect: false, syncFullHistory: false });
    socket.ev.on('creds.update', saveCreds);
    socket.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) { latestQr = qr; logger.info('new WhatsApp pairing QR is available at the protected pair endpoint'); }
      if (connection) { lastConnection = connection; logger.info({ connection }, 'WhatsApp connection state'); }
      if (connection === 'open') { latestQr = ''; reconnectAttempt = 0; return; }
      if (connection !== 'close') return;
      const status = lastDisconnect?.error?.output?.statusCode;
      if (status === DisconnectReason.loggedOut) { logger.error('Logged out; refusing automatic reconnect'); return; }
      const delay = Math.min(60_000, 1_000 * (2 ** reconnectAttempt++)) + Math.floor(Math.random() * 500);
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, delay);
    });
    socket.ev.on('messages.upsert', async ({ messages }) => {
      for (const message of messages) {
        try { await handleMessage(message); } catch (error) { logger.error({ err: error }, 'message handling failed'); }
      }
    });
  }, { minIntervalMs: 1_000 });
  if (result.skipped) logger.debug({ reason: result.reason }, 'connection attempt skipped');
}

async function handleMessage(message) {
  if (!message.message || message.key.fromMe) return;
  const jid = message.key.remoteJid;
  const sender = message.key.participant || jid;
  if (!jid || !sender || !inboundLimit.allow(sender)) return;
  const text = message.message.conversation || message.message.extendedTextMessage?.text || '';
  if (!text) return;
  const isGroup = jid.endsWith('@g.us');
  const send = async (textToSend) => {
    if (!textToSend || !socket) return;
    await socket.sendMessage(jid, { text: cleanWhatsApp(textToSend, { maxChars: config.MAX_MESSAGE_CHARS }) });
  };
  await router.dispatch({ text, jid, sender, isGroup, isAdmin: config.adminJids.has(sender), send, message });
}

process.on('SIGTERM', async () => { clearTimeout(reconnectTimer); try { socket?.end?.(new Error('shutdown')); } finally { process.exit(0); } });
process.on('SIGINT', () => process.emit('SIGTERM'));
connect().catch((error) => logger.error({ err: error }, 'initial connection failed'));
