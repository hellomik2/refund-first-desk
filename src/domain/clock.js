// Waiting periods (the buyer's notice period, the store's hold window) are days long. The demo
// fast-forwards them. Fast-forward only moves this policy clock; measured timings (how long a
// refund took) always use the real clock.
const DAY_MS = 24 * 60 * 60 * 1000;

export function createClock(db) {
  return {
    now() {
      return new Date(Date.now() + db.data.clockOffsetMs);
    },
    fastForwardDays(days) {
      db.data.clockOffsetMs += days * DAY_MS;
      return this.now();
    },
    isFastForwarded() {
      return db.data.clockOffsetMs !== 0;
    },
  };
}
