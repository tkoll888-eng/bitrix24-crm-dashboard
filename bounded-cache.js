export class BoundedTtlCache {
  constructor({ maxEntries = 512, now = Date.now } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError("maxEntries must be a positive integer");
    }
    if (typeof now !== "function") {
      throw new TypeError("now must be a function");
    }
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
  }

  get size() {
    return this.entries.size;
  }

  pruneExpired(at = this.now()) {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= at) this.entries.delete(key);
    }
  }

  async getOrCreate(key, ttlMs, produce) {
    const at = this.now();
    this.pruneExpired(at);

    const hit = this.entries.get(key);
    if (hit) {
      // Refresh Map insertion order so capacity eviction is LRU-style.
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.value;
    }

    const value = await produce();
    const writtenAt = this.now();
    this.pruneExpired(writtenAt);
    this.entries.delete(key);
    this.entries.set(key, {
      expiresAt: writtenAt + Math.max(0, Number(ttlMs) || 0),
      value,
    });

    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
    return value;
  }
}
