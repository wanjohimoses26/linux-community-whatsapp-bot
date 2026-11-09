import 'dotenv/config';
import { z } from 'zod';

const csv = (value) => value ? value.split(',').map((x) => x.trim()).filter(Boolean) : [];
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default('info'),
  BOT_NAME: z.string().min(1).max(32).default('Tux'),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_KEY: z.string().min(1).optional(),
  ADMIN_JIDS: z.string().optional(),
  OWNER_JID: z.string().optional(),
  MAX_AI_QUEUE: z.coerce.number().int().min(1).max(100).default(20),
  MAX_MESSAGE_CHARS: z.coerce.number().int().min(500).max(10000).default(4096),
  DM_MEMBER_CACHE_TTL_MS: z.coerce.number().int().positive().default(14400000),
  HEALTH_TOKEN: z.string().optional()
}).passthrough();

const raw = schema.parse(process.env);
export const config = Object.freeze({
  ...raw,
  adminJids: new Set(csv(raw.ADMIN_JIDS)),
  groups: Object.freeze({
    announcements: process.env.GROUP_ANNOUNCEMENTS || '', open: process.env.GROUP_OPEN_CHAT || '',
    cyber: process.env.GROUP_CYBER || '', help: process.env.GROUP_HELP || '',
    distro: process.env.GROUP_DISTRO || '', projects: process.env.GROUP_PROJECTS || ''
  }),
  supabaseEnabled: Boolean(raw.SUPABASE_URL && raw.SUPABASE_SERVICE_KEY)
});
