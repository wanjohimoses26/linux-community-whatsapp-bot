export class SlidingWindow {
  #events = new Map();
  constructor({ limit, windowMs }) { this.limit = limit; this.windowMs = windowMs; }
  allow(key) {
    const now = Date.now();
    const values = (this.#events.get(key) || []).filter((t) => now - t < this.windowMs);
    if (values.length >= this.limit) { this.#events.set(key, values); return false; }
    values.push(now); this.#events.set(key, values); return true;
  }
  prune() { const now = Date.now(); for (const [k, values] of this.#events) { if (!values.some((t) => now - t < this.windowMs)) this.#events.delete(k); } }
}
