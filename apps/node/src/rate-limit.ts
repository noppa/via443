/** Fixed-window counter per key, e.g. requests to unknown tunnel hosts per client IP. */
export class RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  #windowStart = 0;
  #counts = new Map<string, number>();

  constructor(limit: number, windowMs: number) {
    this.#limit = limit;
    this.#windowMs = windowMs;
  }

  /** Counts a hit and returns whether the key is still within its limit. */
  hit(key: string, now = Date.now()): boolean {
    if (now - this.#windowStart >= this.#windowMs) {
      this.#windowStart = now;
      this.#counts = new Map();
    }
    const count = (this.#counts.get(key) ?? 0) + 1;
    this.#counts.set(key, count);
    return count <= this.#limit;
  }

  isLimited(key: string, now = Date.now()): boolean {
    if (now - this.#windowStart >= this.#windowMs) return false;
    return (this.#counts.get(key) ?? 0) >= this.#limit;
  }
}
