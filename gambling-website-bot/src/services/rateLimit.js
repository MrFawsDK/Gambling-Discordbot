// Fixed window counter per key. Simple and good enough for one process.
export class RateLimiter {
  constructor({ windowMs, max, now = () => Date.now() }) {
    this.windowMs = windowMs;
    this.max = max;
    this.now = now;
    this.hits = new Map();
  }

  // Returns true if the request is allowed.
  hit(key) {
    const now = this.now();
    const entry = this.hits.get(key);
    if (!entry || now - entry.start >= this.windowMs) {
      this.hits.set(key, { start: now, count: 1 });
      return true;
    }
    entry.count++;
    return entry.count <= this.max;
  }

  sweep() {
    const now = this.now();
    for (const [key, entry] of this.hits) if (now - entry.start >= this.windowMs) this.hits.delete(key);
  }
}
