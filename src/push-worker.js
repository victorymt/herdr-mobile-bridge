function summary(next, task, result, now, extra = {}) {
  Object.defineProperty(next.summaries, task.subscription_id, { value: { ...(Object.hasOwn(next.summaries, task.subscription_id) ? next.summaries[task.subscription_id] : {}), last_result: result, updated_at: now, ...extra }, enumerable: true, writable: true, configurable: true });
}

export function pruneDeliveries(next, subscriptions, now) {
  const ids = new Set(subscriptions.map((subscription) => subscription.id));
  next.deliveries = next.deliveries.filter((task) => {
    if (task.expires_at > now && ids.has(task.subscription_id)) return true;
    summary(next, task, ids.has(task.subscription_id) ? 'expired' : 'cancelled', now);
    return false;
  });
}

export function deliveryFailure(error, now) {
  const status = Number(error?.status || error?.statusCode || 0);
  const expired = status === 404 || status === 410 || error?.code === 'subscription_expired';
  const retry = !expired && (!status || status === 408 || status === 429 || status >= 500);
  const header = error?.headers?.['retry-after'] ?? error?.headers?.get?.('retry-after');
  let retryAt = 0;
  if (typeof header === 'string' || typeof header === 'number') {
    const seconds = Number(header);
    retryAt = String(header).trim() !== '' && Number.isFinite(seconds) && seconds >= 0 ? now + seconds * 1000 : Date.parse(header);
  }
  return { expired, retry, retryAt: Number.isFinite(retryAt) ? retryAt : 0, reason: expired ? 'subscription_expired' : status ? `http_${status}` : 'network_or_timeout' };
}

export class PushWorker {
  constructor(manager, options = {}) {
    this.manager = manager;
    this.store = manager.store;
    this.clock = options.clock || manager.clock;
    this.random = options.random || Math.random;
    this.active = new Map();
    this.stopped = true;
    this.timer = null;
    this.pumping = null;
  }

  start() {
    this.stopped = false;
    this.wake();
  }

  wake(delay = 0) {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.pump(), delay);
    this.timer.unref?.();
  }

  async pump() {
    if (this.stopped) return;
    if (this.pumping) return this.pumping;
    this.pumping = this.dispatch().catch(() => {
      this.manager.logger.warn?.('push worker state unavailable; retrying');
    }).finally(() => {
      this.pumping = null;
      this.wake(1000);
    });
    return this.pumping;
  }

  async dispatch() {
    const now = this.clock();
    await this.store.init();
    if (!this.store.deliveries.length) return;
    const tasks = await this.store.transactEvents((next, subscriptions) => {
      pruneDeliveries(next, subscriptions, now);
      return next.deliveries.filter((task) => task.next_attempt_at <= now);
    });
    for (const task of tasks) {
      if (this.stopped || this.active.size >= 4) break;
      if (this.active.has(task.subscription_id)) continue;
      const running = this.deliver(task).catch(() => {
        this.manager.logger.warn?.('push delivery state unavailable; task retained');
      }).finally(() => {
        this.active.delete(task.subscription_id);
        this.wake();
      });
      this.active.set(task.subscription_id, running);
    }
  }

  async deliver(task) {
    const current = await this.store.transactEvents((next, subscriptions) => {
      pruneDeliveries(next, subscriptions, this.clock());
      const pending = next.deliveries.find((candidate) => candidate.id === task.id);
      if (!pending || pending.next_attempt_at > this.clock()) return null;
      pending.attempts += 1;
      pending.next_attempt_at = this.clock() + 2000;
      return { task: { ...pending }, subscription: subscriptions.find((subscription) => subscription.id === pending.subscription_id) };
    });
    if (!current || this.stopped) return;
    const remaining = Math.floor((current.task.expires_at - this.clock()) / 1000);
    if (remaining < 1) return;
    if (!this.store.deliveries.some((pending) => pending.id === task.id)) return;
    let failure;
    try {
      await this.manager.send(current.subscription, { ...current.task.payload, ttl: remaining }, remaining * 1000);
    } catch (error) { failure = deliveryFailure(error, this.clock()); }
    if (failure?.expired) await this.manager.remove({ id: task.subscription_id });
    await this.store.transactEvents((next) => {
      const pending = next.deliveries.find((candidate) => candidate.id === task.id);
      if (!pending) return;
      const now = this.clock();
      if (!failure) {
        summary(next, task, 'accepted', now, { last_success_at: now, last_error: null });
      } else {
        const delay = Math.min(60_000, 2000 * (2 ** Math.min(pending.attempts - 1, 5))) * (0.8 + this.random() * 0.4);
        pending.next_attempt_at = Math.max(now + delay, failure.retryAt);
        const retry = failure.retry && pending.next_attempt_at < pending.expires_at;
        summary(next, task, retry ? 'retrying' : failure.retry ? 'expired' : 'failed', now, { last_error: failure.reason });
        if (retry) return;
      }
      next.deliveries = next.deliveries.filter((candidate) => candidate.id !== task.id);
    });
  }

  async status(subscriptionId) {
    await this.store.init();
    const known = (await this.store.listSubscriptions()).some((subscription) => subscription.id === subscriptionId);
    const next = this.store.eventSnapshot();
    const pending = next.deliveries.filter((task) => task.subscription_id === subscriptionId && task.expires_at > this.clock());
    return { registered: known, pending: pending.length, retrying: pending.filter((task) => task.attempts > 0).length, ...(Object.hasOwn(next.summaries, subscriptionId) ? next.summaries[subscriptionId] : {}) };
  }

  async close() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.pumping;
    await Promise.all([...this.active.values()]);
  }
}
