/** Prevents duplicate timers, overlapping jobs, and runaway retries. */
export class LoopGuard {
  #running = new Set();
  #lastRun = new Map();
  constructor({ minIntervalMs = 60_000 } = {}) { this.minIntervalMs = minIntervalMs; }
  async run(key, fn, { minIntervalMs = this.minIntervalMs } = {}) {
    if (this.#running.has(key)) return { skipped: true, reason: 'already_running' };
    const last = this.#lastRun.get(key) || 0;
    if (Date.now() - last < minIntervalMs) return { skipped: true, reason: 'cooldown' };
    this.#running.add(key);
    try { this.#lastRun.set(key, Date.now()); return { skipped: false, value: await fn() }; }
    finally { this.#running.delete(key); }
  }
}
