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
import { createAdminList, messageIds } from './core/admins.js';
import { ProviderRouter } from './ai/providers.js';
import { checkPassword, safeEqual, cookieHeader, cookieName, issueSession, parseCookies, validSession, clearCookieHeader } from './core/web-auth.js';

const logger = pino({ level: config.LOG_LEVEL, redact: ['req.headers.authorization', 'password', 'token', 'key'] });
const app = express();
app.set('trust proxy', 1);
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
const aiLimit = new SlidingWindow({ limit: 5, windowMs: 60_000 });
const claimLimit = new SlidingWindow({ limit: 5, windowMs: 15 * 60_000 });
const webLoginLimit = new SlidingWindow({ limit: 5, windowMs: 15 * 60_000 });
const router = new Router({ logger });
const settingsStore = config.supabaseEnabled && config.AUTH_ENCRYPTION_KEY
  ? createSettingsStore({ url: config.SUPABASE_URL, apiKey: config.SUPABASE_API_KEY, botSecret: config.SUPABASE_BOT_SECRET, encryptionKey: config.AUTH_ENCRYPTION_KEY })
  : null;
const aiRouter = settingsStore ? new ProviderRouter({ settings: settingsStore, logger }) : null;
const admins = createAdminList({ settings: settingsStore, envJids: [...config.adminJids, config.OWNER_JID], logger });
const paused = new Set(); // group JIDs, or 'ALL'

const roleNames = ['announcements', 'open_chat', 'cyber', 'help', 'distro', 'projects'];
const providerNames = ['groq', 'openrouter', 'gemini', 'kilo'];
const roleLabel = (role) => role.replace('_', ' ');

async function loadPaused() {
  if (!settingsStore) return;
  try { for (const [key, value] of Object.entries(await settingsStore.list('paused'))) if (value) paused.add(key); }
  catch (err) { logger.warn({ err }, 'could not load paused groups'); }
}
async function setPaused(key, value) {
  if (value) paused.add(key); else paused.delete(key);
  if (settingsStore) await settingsStore.set('paused', key, value);
}

// ---------- web pages ----------
const esc = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const css = 'body{font-family:system-ui,sans-serif;max-width:720px;margin:4vh auto;padding:16px;background:#f7f9fb;color:#17202a}main{background:#fff;padding:22px;border-radius:16px;box-shadow:0 8px 30px #17202a12}h1{margin-top:0}h2{margin:26px 0 6px;font-size:1.1rem}label{display:block;margin:10px 0;text-transform:capitalize}select,input{display:block;width:100%;box-sizing:border-box;padding:11px;margin-top:5px;border:1px solid #ccd5df;border-radius:8px}button,a.btn{display:inline-block;margin:14px 8px 0 0;padding:11px 16px;border:0;border-radius:8px;background:#1769aa;color:#fff;font-weight:700;text-decoration:none;font-size:1rem}.ok{color:#087443}.warn{color:#b54708}.hint{color:#607080}.err{color:#b42318}code{background:#eef2f6;padding:2px 6px;border-radius:5px}';
const page = (title, body, head = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${head}<style>${css}</style></head><body><main>${body}</main></body></html>`;
const statusLine = () => lastConnection === 'open'
  ? '<strong class="ok">Connected to WhatsApp</strong>'
  : `<strong class="warn">Not connected to WhatsApp (${esc(lastConnection)})</strong>`;

const webAuthed = (req) => Boolean(config.dashboardEnabled && validSession(parseCookies(req.headers.cookie)[cookieName()], config.sessionSecret));
const safeNext = (value) => ['/pair', '/setup'].includes(value) ? value : '/setup';
const loginPage = (next, error = '') => page('Bot login', `<h1>${esc(config.BOT_NAME)} admin</h1><p>Enter the admin password to continue.</p>${error ? `<p class="err">${esc(error)}</p>` : ''}<form method="post" action="/login"><input type="hidden" name="next" value="${esc(next)}"><input type="password" name="password" autocomplete="current-password" required autofocus><button type="submit">Sign in</button></form>`);

async function participatingGroups() {
  if (lastConnection !== 'open' || !socket?.groupFetchAllParticipating) return {};
  try {
    return await Promise.race([socket.groupFetchAllParticipating(), new Promise((resolve) => setTimeout(() => resolve({}), 8_000))]);
  } catch (err) { logger.warn({ err }, 'could not fetch WhatsApp groups'); return {}; }
}

app.get('/health', (req, res) => {
  if (config.HEALTH_TOKEN && req.get('x-health-token') !== config.HEALTH_TOKEN) return res.sendStatus(401);
  res.json({ ok: lastConnection === 'open', connection: lastConnection, uptimeSec: Math.floor((Date.now() - startedAt) / 1000) });
});
app.get('/login', (req, res) => res.type('html').send(loginPage(safeNext(req.query.next))));
app.post('/login', (req, res) => {
  if (!config.dashboardEnabled) return res.status(503).type('html').send(page('Not set up', '<h1>Admin login is not set up</h1><p>In Render, open this service, go to <b>Environment</b>, and add <code>ADMIN_PASSWORD</code> (8+ characters). Then redeploy.</p>'));
  if (!webLoginLimit.allow(req.ip)) return res.status(429).type('html').send(loginPage(safeNext(req.body.next), 'Too many attempts. Try again in 15 minutes.'));
  if (!checkPassword(String(req.body.password || ''), { hash: config.ADMIN_PASSWORD_HASH, plain: config.ADMIN_PASSWORD })) return res.status(401).type('html').send(loginPage(safeNext(req.body.next), 'Incorrect password.'));
  res.setHeader('Set-Cookie', cookieHeader(issueSession(config.sessionSecret)));
  res.redirect(safeNext(req.body.next));
});
app.get('/logout', (_req, res) => { res.setHeader('Set-Cookie', clearCookieHeader()); res.redirect('/'); });
app.get('/', (_req, res) => {
  res.type('html').send(page(`${config.BOT_NAME} Community Bot`, `<h1>${esc(config.BOT_NAME)} Community Bot</h1><p>${statusLine()}</p><a class="btn" href="/login?next=/setup">Open admin panel</a><a class="btn" href="/health">Health</a>`));
});

app.get('/pair', async (req, res) => {
  if (!webAuthed(req)) return res.redirect('/login?next=/pair');
  res.setHeader('Cache-Control', 'no-store');
  if (lastConnection === 'open') return res.type('html').send(page('WhatsApp', `<h1>Already connected</h1><p class="ok">${esc(config.BOT_NAME)} is linked to WhatsApp.</p><a class="btn" href="/setup">Back to admin panel</a>`));
  if (!latestQr) return res.status(202).type('html').send(page('WhatsApp pairing', '<h1>Getting a QR code...</h1><p class="hint">This page refreshes by itself.</p>', '<meta http-equiv="refresh" content="4">'));
  const image = await QRCode.toDataURL(latestQr, { errorCorrectionLevel: 'M', margin: 2, width: 320 });
  res.type('html').send(page(`Pair ${config.BOT_NAME}`, `<h1>Connect ${esc(config.BOT_NAME)}</h1><ol><li>Open WhatsApp on the spare bot phone.</li><li>Go to <b>Settings, Linked devices, Link a device</b>.</li><li>Scan the QR code below.</li></ol><img style="width:320px;max-width:100%;image-rendering:pixelated" src="${image}" alt="WhatsApp pairing QR code"><p class="hint">The QR refreshes automatically. Keep this page private.</p>`, '<meta http-equiv="refresh" content="20">'));
});

app.get('/setup', async (req, res) => {
  if (!webAuthed(req)) return res.redirect('/login?next=/setup');
  res.setHeader('Cache-Control', 'no-store');
  if (!settingsStore) return res.status(503).type('html').send(page('Setup', '<h1>Storage not ready</h1><p>The Supabase settings in Render are missing or incomplete.</p>'));
  try {
    const groups = await participatingGroups();
    const savedGroups = await settingsStore.list('group_map');
    const savedKeys = await settingsStore.list('ai_keys');
    const roleFields = roleNames.map((role) => {
      const saved = savedGroups[role] || '';
      const known = Object.entries(groups).map(([id, group]) => `<option value="${esc(id)}"${id === saved ? ' selected' : ''}>${esc(group.subject || id)}</option>`);
      if (saved && !groups[saved]) known.unshift(`<option value="${esc(saved)}" selected>Saved group (${esc(saved.slice(0, 12))}...)</option>`);
      return `<label>${esc(roleLabel(role))}<select name="${role}"><option value="">Not assigned</option>${known.join('')}</select></label>`;
    }).join('');
    const keyFields = providerNames.map((name) => `<label>${esc(name)} API key ${savedKeys[name] ? '<span class="ok">(saved, leave empty to keep)</span>' : '<span class="hint">(not set)</span>'}<input type="password" name="${name}" autocomplete="off"></label>`).join('');
    const claim = config.PAIR_TOKEN
      ? `<p>To become a bot admin, send this message to the bot in a private chat:</p><p><code>!claim ${esc(config.PAIR_TOKEN)}</code></p><p class="hint">${admins.count()} admin(s) registered so far.</p>`
      : '<p class="warn">Add <code>PAIR_TOKEN</code> (any short secret word) in Render to enable admin commands in WhatsApp.</p>';
    const connect = lastConnection === 'open' ? '' : '<a class="btn" href="/pair">Scan WhatsApp QR code</a>';
    const groupNote = lastConnection === 'open'
      ? `<p class="hint">The bot can see ${Object.keys(groups).length} WhatsApp group(s). Add the bot number to a group if one is missing, then reload this page.</p>`
      : '<p class="warn">Connect WhatsApp first, then the group lists fill in.</p>';
    res.type('html').send(page(`${config.BOT_NAME} admin`, `<h1>${esc(config.BOT_NAME)} admin panel</h1><p>${statusLine()}</p>${connect}${req.query.saved ? '<p class="ok">Saved.</p>' : ''}<h2>1. Make yourself admin</h2>${claim}<form method="post" action="/setup"><h2>2. Which group is which?</h2><p class="hint">You can also type <code>!setgroup cyber</code> inside a group as an admin.</p>${roleFields}<h2>3. AI keys (optional)</h2>${keyFields}<button type="submit">Save</button></form>${groupNote}<p><a href="/logout">Sign out</a></p>`));
  } catch (error) { logger.error({ err: error }, 'setup page failed'); res.status(500).type('html').send(page('Error', '<h1>Could not load the admin panel</h1><p>Check the Render logs and try again.</p>')); }
});
app.post('/setup', async (req, res) => {
  if (!webAuthed(req)) return res.redirect('/login?next=/setup');
  res.setHeader('Cache-Control', 'no-store');
  if (!settingsStore) return res.status(503).send('Secure settings storage is not ready.');
  try {
    for (const role of roleNames) if (req.body[role]) await settingsStore.set('group_map', role, req.body[role]);
    for (const provider of providerNames) if (req.body[provider]?.trim()) await settingsStore.set('ai_keys', provider, req.body[provider].trim());
    res.redirect('/setup?saved=1');
  } catch (error) { logger.error({ err: error }, 'setup save failed'); res.status(500).send('Could not save setup data.'); }
});
app.listen(config.PORT, () => logger.info({ port: config.PORT }, 'health server listening'));

// ---------- WhatsApp commands ----------
router.command('help', async ({ send }) => send(`*${config.BOT_NAME} commands*\n!ask <question> - ask a Linux question\n!start - a beginner first step\n!privacy - what I store`));
router.command('privacy', async ({ send }) => send('I store minimal metadata for moderation, XP, and operations. Raw message text is not kept as a long-term record. Ask an admin if you want anything removed.'));
router.command('start', async ({ send }) => send('Welcome. Start with one small Linux goal today, then ask in Help & Support if you get stuck.'));
router.command('ask', async ({ args, send, sender }) => {
  if (!aiRouter) return send('AI is not set up yet. An admin can add a key in the admin panel.');
  if (!args.trim()) return send('Use !ask followed by your Linux question.');
  if (!aiLimit.allow(sender)) return send('Give me a minute, then ask again.');
  try { await send(await aiRouter.ask({ question: args.trim() })); }
  catch { await send('I cannot answer right now. Try again in a bit.'); }
});

router.command('claim', async ({ args, send, isGroup, sender, ids }) => {
  if (isGroup) return;
  if (!config.PAIR_TOKEN) return send('Admin setup is not switched on yet. The owner needs to add PAIR_TOKEN in Render.');
  if (!claimLimit.allow(sender)) return;
  if (!safeEqual(args.trim(), config.PAIR_TOKEN)) return send('That code is not valid. The current code is shown in the admin panel.');
  try { await admins.add(ids); } catch (err) { logger.error({ err }, 'could not save admin'); return send('I could not save that. Try again in a minute.'); }
  return send('Done, you are an admin. Send !adminhelp to see what you can do.');
});
router.command('adminhelp', async ({ send }) => send(`*Admin commands*\n!status - how the bot is doing\n!setgroup <role> - run inside a group. Roles: ${roleNames.join(', ')}\n!pause / !resume - run inside a group to silence the bot there\n!pause all / !resume all - in a private chat, for every group`), { adminOnly: true });
router.command('status', async ({ send }) => {
  let mapped = {}; let keys = {};
  try { if (settingsStore) { mapped = await settingsStore.list('group_map'); keys = await settingsStore.list('ai_keys'); } } catch { /* shown as empty */ }
  const mappedText = roleNames.map((role) => `${mapped[role] ? 'yes' : 'no '} ${roleLabel(role)}`).join('\n');
  return send(`*${config.BOT_NAME} status*\nWhatsApp: ${lastConnection}\nAdmins: ${admins.count()}\nPaused: ${paused.size ? [...paused].map((x) => (x === 'ALL' ? 'everything' : 'a group')).join(', ') : 'nothing'}\nAI keys: ${Object.keys(keys).join(', ') || 'none'}\n\n*Groups set up*\n${mappedText}`);
}, { adminOnly: true });
router.command('setgroup', async ({ args, send, isGroup, jid }) => {
  if (!isGroup) return send('Send this inside the group you want to set, for example: !setgroup cyber');
  const role = args.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!roleNames.includes(role)) return send(`Pick one of: ${roleNames.join(', ')}`);
  if (!settingsStore) return send('Settings storage is not ready yet.');
  try { await settingsStore.set('group_map', role, jid); } catch (err) { logger.error({ err }, 'setgroup failed'); return send('I could not save that. Try again in a minute.'); }
  return send(`Done. This group is now the ${roleLabel(role)} group.`);
}, { adminOnly: true });
const pauseHandler = (value) => async ({ args, send, isGroup, jid }) => {
  const all = args.trim().toLowerCase() === 'all';
  if (!isGroup && !all) return send(`Use ${value ? '!pause' : '!resume'} inside a group, or ${value ? '!pause' : '!resume'} all.`);
  try { await setPaused(all ? 'ALL' : jid, value); } catch (err) { logger.error({ err }, 'pause change failed'); return send('I could not save that. Try again in a minute.'); }
  return send(value ? 'Okay, I will stay quiet there. Admins can still use commands. Send !resume to undo.' : 'Back on.');
};
router.command('pause', pauseHandler(true), { adminOnly: true });
router.command('resume', pauseHandler(false), { adminOnly: true });

// ---------- WhatsApp connection ----------
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
  const ids = messageIds(message, isGroup);
  const isAdmin = admins.has(ids);
  if (!isAdmin && (paused.has('ALL') || paused.has(jid))) return;
  const send = async (textToSend) => {
    if (!textToSend || !socket) return;
    const cleaned = cleanWhatsApp(textToSend, { maxChars: config.MAX_MESSAGE_CHARS });
    if (cleaned) await socket.sendMessage(jid, { text: cleaned });
  };
  await router.dispatch({ text, jid, sender, ids, isGroup, isAdmin, send, message });
}

process.on('SIGTERM', async () => { clearTimeout(reconnectTimer); try { socket?.end?.(new Error('shutdown')); } finally { process.exit(0); } });
process.on('SIGINT', () => process.emit('SIGTERM'));
Promise.all([admins.load(), loadPaused()])
  .catch(() => {})
  .finally(() => connect().catch((error) => logger.error({ err: error }, 'initial connection failed')));
