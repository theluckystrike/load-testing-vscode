'use strict';
// Latency histogram in microseconds with a fixed memory size, written for this extension (no dependency).
// Values under 2,048 us are counted exactly. Above that, each power of two is split into 1,024 equal buckets,
// so a percentile is within 0.1 % of the true value (the same idea as an HDR histogram with 3 digits).
// Range: 1 us to about 71 minutes. Larger values go into the last bucket. Memory: about 100 KB per histogram.

const SUB = 1024;            // buckets per power of two
const LINEAR = 2 * SUB;      // values 0..2047 are exact
const MAX_EXP = 22;          // 2^32 us is about 71 minutes
const SIZE = LINEAR + MAX_EXP * SUB;

function indexOf(us) {
  let v = Math.floor(us);
  if (!(v > 0)) return 0;
  if (v < LINEAR) return v;
  const e = Math.floor(Math.log2(v)) - 10; // >= 1 here
  if (e > MAX_EXP) return SIZE - 1;
  let m = Math.floor(v / 2 ** e); // 1024..2047
  if (m >= LINEAR) m = LINEAR - 1;   // float rounding guard
  if (m < SUB) m = SUB;
  return LINEAR + (e - 1) * SUB + (m - SUB);
}

/** The middle value (us) of a bucket, used when a percentile lands in it. */
function valueOf(i) {
  if (i < LINEAR) return i;
  const k = i - LINEAR;
  const e = Math.floor(k / SUB) + 1;
  const m = SUB + (k % SUB);
  return (m + 0.5) * 2 ** e;
}

class Histogram {
  constructor() { this.counts = new Float64Array(SIZE); this.reset(); }

  reset() {
    this.counts.fill(0);
    this.n = 0; this.sum = 0; this.min = Infinity; this.max = 0;
  }

  /** Records one value in microseconds. */
  record(us) {
    if (!Number.isFinite(us) || us < 0) us = 0;
    this.counts[indexOf(us)]++;
    this.n++; this.sum += us;
    if (us < this.min) this.min = us;
    if (us > this.max) this.max = us;
  }

  /** p in 0..100. Returns microseconds, or 0 when empty. */
  percentile(p) {
    if (!this.n) return 0;
    if (p <= 0) return this.min;
    if (p >= 100) return this.max;
    const want = Math.ceil((p / 100) * this.n);
    let seen = 0;
    for (let i = 0; i < SIZE; i++) {
      seen += this.counts[i];
      if (seen >= want) return Math.min(Math.max(valueOf(i), this.min), this.max);
    }
    return this.max;
  }

  mean() { return this.n ? this.sum / this.n : 0; }

  add(other) {
    if (!other || !other.n) return this;
    for (let i = 0; i < SIZE; i++) if (other.counts[i]) this.counts[i] += other.counts[i];
    this.n += other.n; this.sum += other.sum;
    if (other.min < this.min) this.min = other.min;
    if (other.max > this.max) this.max = other.max;
    return this;
  }

  /** Summary in milliseconds with 3 decimals. */
  summary() {
    const ms = (us) => Math.round(us) / 1000;
    return {
      count: this.n, min: this.n ? ms(this.min) : 0, mean: ms(this.mean()), p50: ms(this.percentile(50)),
      p90: ms(this.percentile(90)), p95: ms(this.percentile(95)), p99: ms(this.percentile(99)), max: ms(this.max),
    };
  }

  /** Sparse form for the JSON report: [[bucket, count], ...] plus the totals. */
  toJSON() {
    const b = [];
    for (let i = 0; i < SIZE; i++) if (this.counts[i]) b.push([i, this.counts[i]]);
    return { v: 1, n: this.n, sum: this.sum, min: this.n ? this.min : 0, max: this.max, b };
  }

  static fromJSON(o) {
    const h = new Histogram();
    if (!o || o.v !== 1 || !Array.isArray(o.b)) return h;
    for (const pair of o.b) {
      if (!Array.isArray(pair)) continue;
      const i = pair[0] | 0, c = Number(pair[1]);
      if (i >= 0 && i < SIZE && c > 0 && Number.isFinite(c)) h.counts[i] += c;
    }
    h.n = Number(o.n) || 0; h.sum = Number(o.sum) || 0; h.min = h.n ? Number(o.min) || 0 : Infinity; h.max = Number(o.max) || 0;
    return h;
  }
}

module.exports = { Histogram, indexOf, valueOf, SIZE };
