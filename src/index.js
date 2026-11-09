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

const logger = pino({ level: config.LOG_LEVEL, redact: ['req.headers.authorization', 'password', 'token', 'key'] });
const app = express();
const startedAt = Date.now();
let socket;
let reconnectTimer;
let reconnectAttempt = 0;
let lastConnection = 'starting';
let latestQr = '';
const guard = new LoopGuard({ minIntervalMs: 5_000 });
const inboundLimit = new SlidingWindow({ limit: 30, windowMs: 60_000 });
const router = new Router({ logger });

app.get('/health', (req, res) => {
  if (config.HEALTH_TOKEN && req.get('x-health-token') !== config.HEALTH_TOKEN) return res.sendStatus(401);
  res.json({ ok: lastConnection === 'open', connection: lastConnection, uptimeSec: Math.floor((Date.now() - startedAt) / 1000) });
});
app.get('/', (_req, res) => {
  res.status(200).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${config.BOT_NAME} Community Bot</title><style>body{font-family:system-ui,sans-serif;max-width:680px;margin:12vh auto;padding:24px;color:#17202a;background:#f7f9fb}main{background:#fff;border:1px solid #e3e8ed;border-radius:16px;padding:28px;box-shadow:0 8px 30px #17202a12}h1{margin-top:0}a{color:#1769aa;text-decoration:none}small{color:#607080}</style></head><body><main><h1>${config.BOT_NAME} Community Bot</h1><p>The service is online. WhatsApp connection status: <strong>${lastConnection}</strong>.</p><p><a href="/health">View health status</a></p><small>Linux community bot infrastructure</small></main></body></html>`);
});
app.get('/pair', async (req, res) => {
  if (!config.PAIR_TOKEN || req.query.token !== config.PAIR_TOKEN) return res.sendStatus(404);
  if (!latestQr) return res.status(202).type('html').send('<!doctype html><meta http-equiv="refresh" content="4"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WhatsApp pairing</title><p>Waiting for a fresh QR code. Refreshing shortly…</p>');
  const image = await QRCode.toDataURL(latestQr, { errorCorrectionLevel: 'M', margin: 2, width: 320 });
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="20"><title>Pair ${config.BOT_NAME}</title><style>body{font-family:system-ui,sans-serif;text-align:center;margin:5vh auto;padding:20px;background:#f7f9fb;color:#17202a}main{background:#fff;border-radius:16px;padding:24px;max-width:420px;margin:auto;box-shadow:0 8px 30px #17202a12}img{width:320px;max-width:100%;image-rendering:pixelated}li{text-align:left;margin:10px 0}</style></head><body><main><h1>Connect ${config.BOT_NAME}</h1><ol><li>Open WhatsApp on the spare bot phone.</li><li>Go to <b>Settings → Linked devices → Link a device</b>.</li><li>Scan the QR code below.</li></ol><img src="${image}" alt="WhatsApp pairing QR code"><p>This QR refreshes automatically. Keep this link private.</p></main></body></html>`);
});
app.listen(config.PORT, () => logger.info({ port: config.PORT }, 'health server listening'));

router.command('help', async ({ send }) => send(cleanWhatsApp(`*${config.BOT_NAME} commands*\n!rank, !top, !start, !explain <command>, !privacy\nAsk a question with !ask <question>.`)));
router.command('privacy', async ({ send }) => send('I store minimal metadata for moderation, XP, and operations. Raw message text is not kept as a long-term record. Ask an admin or use !stop to opt out of onboarding.'));
router.command('start', async ({ send }) => send('Welcome. Start with one small Linux goal today, then ask in Help & Support if you get stuck.'));

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
