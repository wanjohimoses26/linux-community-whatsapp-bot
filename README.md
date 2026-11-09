# Linux Community WhatsApp Bot

A safety-first foundation for the six-group Linux community bot. This repository deliberately starts with a small, observable core: reconnect-safe Baileys lifecycle, health endpoint, command routing, rate limits, output cleaning, loop guards, and a privacy-conscious Supabase schema.

## Important operating decisions

1. **Pairing is manual and one-time.** Do not deploy a real number until the production auth-state adapter encrypts Baileys credentials in Supabase. The current `.qr` adapter is development-only and must never be relied on across Render restarts.
2. **WhatsApp is not a durable job queue.** Every scheduled action needs a database claim/lease, an idempotency key, a retry limit, and a quiet-hours/daily-cap check. Never use an unbounded `setInterval` that can create duplicate posts after reconnects.
3. **The bot never assumes it can delete, mute, kick, promote, or read group membership.** Those actions require the bot to be a group admin and must be tested against the actual Baileys version and WhatsApp behavior. Every failure becomes an audit event, not a retry loop.
4. **Privacy is opt-in where possible.** Store hashes for member identity, avoid long-term raw messages, give a visible `!privacy` command, and make onboarding resumable and stoppable. Do not send unsolicited DMs in bulk until members have initiated contact or the community has explicitly agreed.
5. **Admin actions are out-of-band or strongly authenticated.** Do not build a password-only chat login as the primary control plane. Prefer Render environment access plus a private admin endpoint or TOTP-backed, short-lived sessions. Never echo secrets into logs or group chats.
6. **Security content is educational only.** The bot may support CTFs, labs, defensive troubleshooting, and authorized testing. It must refuse instructions targeting real systems, credentials, private data, or evasion.

## Local setup

```bash
cp .env.example .env
npm install
npm run check
npm test
npm start
```

The service exposes `GET /health` on `PORT`. In development, scan the printed Baileys QR. For production, replace `useMultiFileAuthState('.qr')` in `src/index.js` with an encrypted Supabase-backed auth adapter before pairing.

Apply `supabase/schema.sql` in Supabase, then create the six group rows with stable WhatsApp group IDs. Do not use display names as identifiers; names change and are not unique.

## Build phases

### Phase 0: hardening before real traffic

- Implement encrypted, versioned Supabase auth state with transactional writes.
- Add message receipt idempotency (`message_id` unique) before any side effect.
- Add structured DB repositories with explicit timeouts and bounded queries.
- Add a real scheduler based on persisted leases: `job_key`, `run_after`, `lease_until`, `attempts`, `last_error`.
- Add a circuit breaker per AI provider and a global daily budget.
- Add integration tests using a fake socket and a test Supabase project.

### Phase 1: moderation and permissions

- Stable member hashing with a server-side pepper; rotate only with a migration plan.
- Role lookup from the database on every privileged action, with short cache TTL.
- Anti-link, flood, repeat-message, warning decay, appeal, and group pause.
- All destructive actions require capability checks, an idempotency key, and an audit row. If the bot lacks WhatsApp admin privileges, explain once and stop retrying.

### Phase 2: community features

- XP ledger with per-user/per-group cooldowns and a daily ceiling.
- Rank calculations derived from the ledger, not hand-edited counters.
- One active question per group enforced by a database constraint/transaction.
- Onboarding only after a member starts a DM or an administrator explicitly launches a small batch.

### Phase 3: AI and CTF

- AI is invoked only for explicit commands, approved unanswered Help tickets, or scheduled content generation.
- Normalize/hash requests for short-lived cache; never cache private screenshots or sensitive support content.
- CTF flags are compared as salted hashes; never store plaintext flags. Do not put answers in group messages.
- Hints and challenge release use persisted timestamps and a single scheduler lease.

### Phase 4: adaptation and extras

- Measure replies and reactions, not just messages sent.
- Change one posting variable at a time and require a minimum sample size before adapting.
- Use fatigue rules with cooldowns and an admin override. Never let “quiet detection” bypass the daily cap.
- Add anonymous questions, mentor matching, installation requests, and vision support only after privacy review and abuse handling are tested.

## Loop and failure controls

- **Reconnect loop:** exponential backoff with jitter, one pending reconnect timer, no reconnect after `loggedOut`.
- **Message loop:** ignore `fromMe`, process each message ID once, and never react to the bot's own generated messages.
- **Scheduler loop:** one lease per job key, bounded attempts, persisted next-run time, and a dead-letter state for repeated failures.
- **AI retry loop:** at most one retry per request, provider cooldown, global queue cap, and no retry for policy refusal or invalid input.
- **Moderation loop:** a warning or deletion action is idempotent; failure is recorded and not immediately retried.
- **DM loop:** member verification cache has an expiry; no repeated onboarding questions; explicit opt-out is respected everywhere.

## Acceptance criteria

- Restarting the process does not duplicate a welcome, warning, XP award, scheduled post, or CTF solve.
- A temporary Supabase outage leaves the bot in a safe read-only/degraded mode rather than sending uncontrolled messages.
- A provider outage drains gracefully and never exceeds configured per-provider or global budgets.
- Every privileged action has an audit record with actor, target, action, timestamp, and result.
- The bot stays silent when silence is safer: unknown commands, non-members in DMs, empty cleaned responses, full queues, paused groups, and failed capability checks.
- All public bot output passes the cleaner and length cap; no provider names, prompts, keys, stack traces, or reasoning blocks are exposed.
- A human admin can pause a group, disable AI, disable all scheduled posts, and recover from a bad deployment without database surgery.

## Deployment

Render should run one Node web service with the health endpoint monitored externally. Set environment variables from `.env.example`, use Supabase only for durable state, and configure an external health check no more often than needed to keep the service warm. Keep a rollback copy of the previous deploy and test reconnects after every deployment.

The original plan's “all free tiers” assumption is not a reliability guarantee. Provider quotas, WhatsApp enforcement, Render behavior, and Supabase limits change. Treat each as a budget with alerts and a safe fallback, not as unlimited capacity.
