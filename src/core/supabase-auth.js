import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { initAuthCreds, makeCacheableSignalKeyStore, BufferJSON, proto } from 'baileys';

const keyBytes = (value) => {
  if (!value) throw new Error('AUTH_ENCRYPTION_KEY is required');
  const decoded = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (decoded.length !== 32) throw new Error('AUTH_ENCRYPTION_KEY must decode to exactly 32 bytes');
  return decoded;
};

function encrypt(value, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secret, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${ciphertext.toString('base64')}`;
}
function decrypt(value, secret) {
  const [iv, tag, ciphertext] = value.split('.').map((part) => Buffer.from(part, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', secret, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export async function useSupabaseAuthState({ url, apiKey, botSecret, encryptionKey, logger }) {
  const client = createClient(url, apiKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-bot-secret': botSecret } }
  });
  const secret = keyBytes(encryptionKey);
  const read = async (key) => {
    const { data, error } = await client.from('bot_auth').select('value').eq('key', key).maybeSingle();
    if (error) throw error;
    return data ? JSON.parse(decrypt(data.value, secret), BufferJSON.reviver) : null;
  };
  const write = async (key, value) => {
    const encoded = encrypt(JSON.stringify(value, BufferJSON.replacer), secret);
    const { error } = await client.from('bot_auth').upsert({ key, value: encoded, updated_at: new Date().toISOString() });
    if (error) throw error;
  };
  const remove = async (key) => {
    const { error } = await client.from('bot_auth').delete().eq('key', key);
    if (error) throw error;
  };
  const creds = (await read('creds')) || initAuthCreds();
  const rawKeys = {
    async get(type, ids) {
      const result = {};
      await Promise.all(ids.map(async (id) => {
        let value = await read(`key:${type}:${id}`);
        if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
        result[id] = value;
      }));
      return result;
    },
    async set(data) {
      await Promise.all(Object.entries(data).flatMap(([type, values]) => Object.entries(values).map(([id, value]) => {
        const key = `key:${type}:${id}`;
        return value ? write(key, value) : remove(key);
      })));
    },
    async clear() {
      const { error } = await client.from('bot_auth').delete().like('key', 'key:%');
      if (error) throw error;
    }
  };
  logger?.info('using encrypted Supabase auth state');
  return {
    state: { creds, keys: makeCacheableSignalKeyStore(rawKeys, logger) },
    saveCreds: () => write('creds', creds)
  };
}
