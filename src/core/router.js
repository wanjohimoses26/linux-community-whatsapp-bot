export class Router {
  constructor({ logger }) { this.logger = logger; this.commands = new Map(); this.listeners = []; }
  command(name, handler, options = {}) { this.commands.set(name.toLowerCase(), { handler, ...options }); }
  listener(handler) { this.listeners.push(handler); }
  async dispatch(ctx) {
    for (const listener of this.listeners) await listener(ctx);
    const match = ctx.text?.trim().match(/^!(\S+)(?:\s+([\s\S]*))?$/);
    if (!match) return;
    const item = this.commands.get(match[1].toLowerCase());
    if (!item) return;
    if (item.groupOnly && !ctx.isGroup) return;
    if (item.adminOnly && !ctx.isAdmin) return;
    await item.handler({ ...ctx, args: match[2] || '' });
  }
}
