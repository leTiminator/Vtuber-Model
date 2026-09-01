/**
 * One Euro filter (Casiez, Roussel & Vogel, 2012).
 *
 * Face tracking has to feel instant when you move and dead still when you do
 * not. A fixed low-pass can only pick one of those. This filter widens its own
 * cutoff as the signal speeds up, so slow drift gets smoothed hard while fast
 * motion passes through nearly untouched.
 */
const alphaFor = (cutoff, dt) => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

class LowPass {
  constructor() {
    this.value = null;
  }
  filter(x, alpha) {
    this.value = this.value === null ? x : alpha * x + (1 - alpha) * this.value;
    return this.value;
  }
  reset() {
    this.value = null;
  }
}

export class OneEuro {
  /**
   * @param {object} opts
   * @param {number} opts.minCutoff Hz. Lower = steadier when still, more lag.
   * @param {number} opts.beta      Speed coefficient. Higher = less lag when moving fast.
   * @param {number} opts.dCutoff   Hz. Cutoff for the derivative estimate itself.
   */
  constructor({ minCutoff = 1.2, beta = 0.05, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = new LowPass();
    this.dx = new LowPass();
    this.last = null;
  }

  filter(value, dt) {
    if (!Number.isFinite(value)) return this.x.value ?? 0;
    if (dt <= 0) return this.x.value ?? value;

    const derivative = this.last === null ? 0 : (value - this.last) / dt;
    this.last = value;

    const edx = this.dx.filter(derivative, alphaFor(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.x.filter(value, alphaFor(cutoff, dt));
  }

  reset() {
    this.x.reset();
    this.dx.reset();
    this.last = null;
  }
}

/** A named bank of One Euro filters sharing one set of tuning parameters. */
export class FilterBank {
  constructor(opts) {
    this.opts = opts;
    this.filters = new Map();
  }

  filter(key, value, dt) {
    let f = this.filters.get(key);
    if (!f) {
      f = new OneEuro(this.opts);
      this.filters.set(key, f);
    }
    return f.filter(value, dt);
  }

  /** Re-tune every filter in the bank without losing their current state. */
  configure(opts) {
    Object.assign(this.opts, opts);
    for (const f of this.filters.values()) Object.assign(f, opts);
  }

  reset() {
    for (const f of this.filters.values()) f.reset();
  }
}
