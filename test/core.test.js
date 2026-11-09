import test from 'node:test';
import assert from 'node:assert/strict';
import { LoopGuard } from '../src/core/loop-guard.js';
import { SlidingWindow } from '../src/core/rate-limit.js';
import { cleanWhatsApp } from '../src/core/cleaner.js';

test('loop guard blocks overlapping and cooldown runs', async () => {
  const guard = new LoopGuard({ minIntervalMs: 60_000 });
  let calls = 0;
  const first = await guard.run('job', async () => { calls += 1; return 42; });
  const second = await guard.run('job', async () => { calls += 1; return 99; });
  assert.equal(first.value, 42);
  assert.equal(second.skipped, true);
  assert.equal(calls, 1);
});

test('sliding window rate-limits a sender', () => {
  const limit = new SlidingWindow({ limit: 2, windowMs: 60_000 });
  assert.equal(limit.allow('u'), true);
  assert.equal(limit.allow('u'), true);
  assert.equal(limit.allow('u'), false);
  assert.equal(limit.allow('v'), true);
});

test('cleaner removes reasoning and filler without exposing it', () => {
  const result = cleanWhatsApp('Certainly! <think>secret reasoning</think>\n\n# Answer\nUse `ls` — it lists files.');
  assert.equal(result.includes('secret reasoning'), false);
  assert.equal(result.includes('Certainly'), false);
  assert.equal(result.includes('# Answer'), false);
  assert.equal(result.includes('—'), false);
  assert.match(result, /lists files/);
});
