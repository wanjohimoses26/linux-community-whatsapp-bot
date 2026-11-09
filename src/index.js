import express from 'express';
import pino from 'pino';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from 'baileys';
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
const guard = new LoopGuard({ minIntervalMs: 5_000 });
const inboundLimit = new SlidingWindow({ limit: 30, windowMs: 60_000 });
const router = new Router({ logger });

app.get('/health', (req, res) => {
  if (config.HEALTH_TOKEN && req.get('x-health-token') !== config.HEALTH_TOKEN) return res.sendStatus(401);
  res.json({ ok: lastConnection === 'open', connection: lastConnection, uptimeSec: Math.floor((Date.now() - startedAt) / 1000) });
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
    socket.ev.on('connection.update', ({ connection, lastDisconnect }) => {
      if (connection) { lastConnection = connection; logger.info({ connection }, 'WhatsApp connection state'); }
      if (connection === 'open') { reconnectAttempt = 0; return; }
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
