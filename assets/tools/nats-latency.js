/* Request/reply latency from observed traffic. A message carrying a reply-to subject is a request; the next message on that
   subject is its reply. Timing is the browser's receive time for both, so it measures what a subscriber on the bus sees.
   Requests with no reply after a timeout count as timeouts; a 503 reply is "no responders". */
(function () {
  const lib = DT.lib;

  /* Nearest-rank percentile of an ascending array. */
  lib.percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1))] : 0);

  lib.LatencyTracker = class {
    constructor({ timeoutMs = 5000, maxPending = 10000, maxSubjects = 500, keep = 1000 } = {}) {
      this.timeoutMs = timeoutMs; this.maxPending = maxPending; this.maxSubjects = maxSubjects; this.keep = keep;
      this.pending = new Map(); this.stats = new Map(); this.overflow = 0; this.requests = 0;
    }
    _row(subject) {
      let s = this.stats.get(subject);
      if (!s) {
        if (this.stats.size >= this.maxSubjects) { this.overflow++; return null; }
        this.stats.set(subject, s = { subject, requests: 0, replies: 0, timeouts: 0, noResponders: 0, samples: [], sum: 0, last: 0, lastAt: 0 });
      }
      return s;
    }
    /* m: { subject, reply, status } */
    observe(m, now = Date.now()) {
      if (m.reply) {
        this.requests++;
        if (this.pending.size >= this.maxPending) this.sweep(now);
        if (this.pending.size >= this.maxPending) { this.pending.delete(this.pending.keys().next().value); this.overflow++; }
        this.pending.set(m.reply, { subject: m.subject, t: now });
        const s = this._row(m.subject); if (s) s.requests++;
        return;
      }
      const req = this.pending.get(m.subject);
      if (!req) return;
      this.pending.delete(m.subject);
      const s = this._row(req.subject); if (!s) return;
      if (m.status === 503) { s.noResponders++; return; }
      const ms = Math.max(0, now - req.t);
      s.replies++; s.sum += ms; s.last = ms; s.lastAt = now; s.samples.push(ms);
      if (s.samples.length > this.keep) s.samples.splice(0, s.samples.length - this.keep);
    }
    /* Requests older than the timeout are counted as unanswered. */
    sweep(now = Date.now()) {
      for (const [reply, req] of this.pending) {
        if (now - req.t < this.timeoutMs) continue;
        this.pending.delete(reply);
        const s = this._row(req.subject); if (s) s.timeouts++;
      }
    }
    snapshot(now = Date.now()) {
      this.sweep(now);
      return [...this.stats.values()].map(s => {
        const sorted = s.samples.slice().sort((a, b) => a - b);
        return {
          subject: s.subject, requests: s.requests, replies: s.replies, timeouts: s.timeouts, noResponders: s.noResponders,
          min: sorted[0] || 0, p50: lib.percentile(sorted, 50), p95: lib.percentile(sorted, 95), p99: lib.percentile(sorted, 99), max: sorted[sorted.length - 1] || 0,
          avg: s.replies ? s.sum / s.replies : 0, last: s.last, lastAt: s.lastAt,
          failRate: s.requests ? (s.timeouts + s.noResponders) / s.requests : 0,
        };
      }).sort((a, b) => b.requests - a.requests);
    }
    clear() { this.pending.clear(); this.stats.clear(); this.overflow = 0; this.requests = 0; }
  };
})();
