# Linux Community WhatsApp Bot ("Tux")

A WhatsApp bot for the Linux community groups. It runs on Render, keeps its data in Supabase, and is managed from a simple admin web page plus a few WhatsApp commands.

## What works today

| Feature | Status |
|---|---|
| Stays connected to WhatsApp, reconnects by itself | Working |
| Admin web page (connect WhatsApp, assign groups, add AI keys) | Working |
| `!ask`, `!start`, `!privacy`, `!help` | Working |
| Admin commands: `!status`, `!setgroup`, `!pause`, `!resume` | Working |
| Moderation (anti-link, flood, warnings), welcome messages | Not built yet |
| XP and ranks, daily questions, CTF, recaps | Not built yet |

The database tables for the not-built features already exist in `supabase/schema.sql`.

## First-time setup (about 10 minutes)

All settings live in **Render, your service, Environment**. Nothing secret goes in GitHub.

1. Make sure these four are set (they should already be): `SUPABASE_URL`, `SUPABASE_API_KEY`, `SUPABASE_BOT_SECRET`, `AUTH_ENCRYPTION_KEY`. Also set `NODE_ENV` to `production`.
2. Add **`ADMIN_PASSWORD`**: any passphrase of 8+ characters. This is your admin web page login.
3. Add **`PAIR_TOKEN`**: any short secret word. You will use it once to make yourself a bot admin.
4. Save. Render redeploys by itself.
5. Open your service URL (`https://<your-service>.onrender.com`), click **Open admin panel**, and log in.
6. If WhatsApp shows "not connected", click **Scan WhatsApp QR code** and scan it from the spare bot phone (Settings, Linked devices). This is only needed once.
7. In the admin panel, copy the `!claim ...` message and send it to the bot in a private WhatsApp chat. You are now an admin.
8. Add the bot number to your groups. In each group, send `!setgroup <role>` (for example `!setgroup cyber`). Roles: announcements, open_chat, cyber, help, distro, projects. You can also do this from the admin panel.
9. Optional: paste an AI key (Groq, OpenRouter, Gemini) in the admin panel to switch on `!ask`.

## Everyday use

- `!status` shows whether the bot is healthy and which groups are set up.
- `!pause` inside a group makes the bot silent there (`!resume` undoes it). `!pause all` in a private chat silences everything.
- `!adminhelp` lists the admin commands. Normal members never see them.

## If something is wrong

- **Bot does not answer:** check the admin panel for "Connected". If not, re-scan the QR code.
- **Cannot log in:** check `ADMIN_PASSWORD` in Render. After changing it, wait for the redeploy.
- **`!claim` says the code is invalid:** it must match `PAIR_TOKEN` exactly. The admin panel shows the current one.
- **Render free plan sleeps** after 15 minutes without web traffic. Point a free uptime monitor (UptimeRobot, cron-job.org) at `/health` every 5 minutes.

## For developers

```bash
cp .env.example .env
npm install
npm test
npm start
```

Optional: `node scripts/hash-pass.js "passphrase"` prints a hash you can use as `ADMIN_PASSWORD_HASH` instead of the plain password.

WhatsApp login data is encrypted (AES-256-GCM) before it is stored in Supabase. Apply `supabase/schema.sql` to a new Supabase project before first run.
