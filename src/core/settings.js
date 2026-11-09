import { createClient } from '@supabase/supabase-js';
import { encrypt, decrypt, keyBytes } from './supabase-auth.js';

export function createSettingsStore({ url, apiKey, botSecret, encryptionKey }) {
  const client = createClient(url, apiKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-bot-secret': botSecret } }
  });
  const secret = keyBytes(encryptionKey);
  return {
    async set(scope, key, value) {
      const encoded = encrypt(JSON.stringify(value), secret);
      const { error } = await client.from('settings').upsert({ scope, key, value: { encrypted: encoded }, updated_at: new Date().toISOString() });
      if (error) throw error;
    },
    async get(scope, key) {
      const { data, error } = await client.from('settings').select('value').eq('scope', scope).eq('key', key).maybeSingle();
      if (error) throw error;
      return data?.value?.encrypted ? JSON.parse(decrypt(data.value.encrypted, secret)) : null;
    },
    async list(scope) {
      const { data, error } = await client.from('settings').select('key,value').eq('scope', scope).limit(100);
      if (error) throw error;
      return Object.fromEntries((data || []).filter((row) => row.value?.encrypted).map((row) => [row.key, JSON.parse(decrypt(row.value.encrypted, secret))]));
    }
  };
}
