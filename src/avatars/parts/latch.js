/**
 * Which face shows: the head-on drawing while the head is square to the
 * camera, the drawn three-quarter view once it turns away. Leaving is quick,
 * because a turn is deliberate; coming back is slow, because centre is where
 * the head hovers. Pure, so a recording can drive it in Node.
 */

/** Seconds past the hold before the face gives way. */
export const LEAVE = 0.08;
/** Seconds inside the hold before the face comes back, while inside BACK_AT of it. */
export const BACK = 0.35;
export const BACK_AT = 0.75;
/** How far past centre, as a fraction of the hold, counts as a sweep to the other side. */
export const CROSS = 0.35;

export class FaceLatch {
  constructor() {
    this.reset();
  }

  reset() {
    this.on = true;
    this.since = 0;
    this.side = 0; // which side the head was on when the face gave way
    this.crossed = false; // and whether it has just swept across to the other
  }

  /** yaw in radians (avatar space), dt in seconds, hold in radians, back in seconds. */
  update(yaw, dt, hold, back = BACK) {
    const turn = Math.abs(yaw);
    const side = yaw < 0 ? -1 : 1;
    this.crossed = false;
    if (this.on) {
      this.since = turn > hold ? this.since + dt : 0;
      if (this.since >= LEAVE) {
        this.on = false;
        this.since = 0;
        this.side = side;
      }
    } else if (side === -this.side && turn > hold * CROSS) {
      /* A sweep across centre, not a hover near it: waiting out the return
       * leaves the far view showing while the head is already the other way. */
      this.on = true;
      this.since = 0;
      this.crossed = true;
    } else {
      this.since = turn > hold ? 0 : this.since + dt;
      if (this.since >= back && turn < hold * BACK_AT) {
        this.on = true;
        this.since = 0;
      }
    }
    return this.on;
  }
}
