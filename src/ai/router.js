export class AiRouter {
  #queue = [];
  #active = false;
  constructor({ maxQueue = 20, logger }) { this.maxQueue = maxQueue; this.logger = logger; }
  enqueue(job) {
    if (this.#queue.length >= this.maxQueue) return Promise.reject(new Error('AI queue is full'));
    return new Promise((resolve, reject) => { this.#queue.push({ job, resolve, reject }); this.#drain(); });
  }
  async #drain() {
    if (this.#active) return;
    this.#active = true;
    while (this.#queue.length) {
      const item = this.#queue.shift();
      try { item.resolve(await item.job()); } catch (error) { item.reject(error); }
    }
    this.#active = false;
  }
}
