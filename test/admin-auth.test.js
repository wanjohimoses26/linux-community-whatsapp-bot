import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPassword, hashPassword, issueSession, validSession, safeEqual } from '../src/core/web-auth.js';
import { createAdminList, messageIds, normalizeJid } from '../src/core/admins.js';

test('checkPassword accepts a plain passphrase or a scrypt hash', () => {
  assert.equal(checkPassword('correct horse', { plain: 'correct horse' }), true);
  assert.equal(checkPassword('wrong', { plain: 'correct horse' }), false);
  const hash = hashPassword('another passphrase');
  assert.equal(checkPassword('another passphrase', { hash }), true);
  assert.equal(checkPassword('nope', { hash }), false);
  assert.equal(checkPassword('anything', {}), false);
});

test('hash wins over plain when both are set', () => {
  const hash = hashPassword('from-the-hash');
  assert.equal(checkPassword('from-plain', { hash, plain: 'from-plain' }), false);
});

test('sessions validate and reject tampering', () => {
  const secret = 'x'.repeat(32);
  const cookie = issueSession(secret);
  assert.equal(validSession(cookie, secret), true);
  assert.equal(validSession(`${cookie}x`, secret), false);
  assert.equal(validSession(undefined, secret), false);
  assert.equal(safeEqual('a', 'a'), true);
  assert.equal(safeEqual('a', 'b'), false);
});

test('jids normalize and admin list matches any known form', async () => {
  assert.equal(normalizeJid('254700000000:12@s.whatsapp.net'), '254700000000');
  const ids = messageIds({ key: { remoteJid: '111@lid', remoteJidAlt: '254700000000@s.whatsapp.net' } }, false);
  assert.deepEqual(ids, ['111', '254700000000']);
  const groupIds = messageIds({ key: { remoteJid: 'g@g.us', participant: '111@lid' } }, true);
  assert.deepEqual(groupIds, ['111']);
  const saved = new Map();
  const settings = { list: async () => Object.fromEntries(saved), set: async (_s, k, v) => { saved.set(k, v); } };
  const admins = createAdminList({ settings, envJids: ['254700000000@s.whatsapp.net'] });
  assert.equal(admins.has(['254700000000']), true);
  assert.equal(admins.has(['999']), false);
  await admins.add(['999']);
  assert.equal(admins.has(['999']), true);
  const reloaded = createAdminList({ settings });
  await reloaded.load();
  assert.equal(reloaded.has(['999']), true);
});
