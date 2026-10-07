/**
 * Human-friendly durations for Arena: "15m", "1h", "4h", "1d", "7d".
 *
 * An open call's horizon is any whole number of minutes from 5 minutes to
 * 30 days (within its book's range). It is public from the moment of the lock,
 * so recovering a call from its hash only has to try coins and sides.
 *
 * The grid below (5-minute steps up to a day, whole hours up to a week, whole
 * days up to 30 days: 455 horizons) dates from when the horizon was hidden in
 * the hash. It's kept for callers that still search a horizon they don't know.
 */

export const MINUTE = 60;
export const HOUR = 3_600;
export const DAY = 86_400;

/** Callbook.sol: MIN_PERIOD, MAX_PERIOD, MIN_FREE_HORIZON, MAX_HORIZON. */
export const MIN_PERIOD = 5 * MINUTE;
export const MAX_PERIOD = 7 * DAY;
export const MIN_HORIZON = 5 * MINUTE;
export const MAX_HORIZON = 30 * DAY;

const UNIT_SECONDS = {
  s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
  m: MINUTE, min: MINUTE, mins: MINUTE, minute: MINUTE, minutes: MINUTE,
  h: HOUR, hr: HOUR, hrs: HOUR, hour: HOUR, hours: HOUR,
  d: DAY, day: DAY, days: DAY,
  w: 7 * DAY, wk: 7 * DAY, week: 7 * DAY, weeks: 7 * DAY,
};

/**
 * Seconds in "4h", "90m", "1d", "1h30m", "2 days", or a number of seconds.
 * Throws a plain sentence for anything else.
 */
export function parseDuration(input, what = "duration") {
  if (typeof input === "number" && Number.isFinite(input) && input > 0) return Math.round(input);
  const text = String(input ?? "").trim().toLowerCase();
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/g)];
  const consumed = parts.map((m) => m[0]).join("").replace(/\s+/g, "");
  if (!parts.length || consumed !== text.replace(/\s+/g, "")) {
    throw new Error(`"${input}" isn't a ${what} I understand. Use something like 15m, 1h, 4h, 1d or 7d.`);
  }
  let total = 0;
  for (const [, n, unit] of parts) {
    const scale = UNIT_SECONDS[unit];
    if (!scale) throw new Error(`"${unit}" isn't a unit I know in "${input}". Use m, h, d or w (for example 4h).`);
    total += Number(n) * scale;
  }
  return Math.round(total);
}

/** 14400 -> "4h", 5400 -> "1h30m", 86400 -> "1d". */
export function formatDuration(sec) {
  let s = Math.max(0, Math.round(Math.abs(sec)));
  if (s === 0) return "0s";
  const out = [];
  for (const [unit, size] of [["d", DAY], ["h", HOUR], ["m", MINUTE], ["s", 1]]) {
    if (s >= size) {
      out.push(`${Math.floor(s / size)}${unit}`);
      s %= size;
    }
  }
  return out.join("");
}

/** "in 3h12m" / "3h12m ago", for countdowns. Seconds are dropped above an hour. */
export function countdown(sec) {
  const abs = Math.abs(sec);
  const rounded = abs >= HOUR ? Math.round(abs / MINUTE) * MINUTE : abs;
  return sec >= 0 ? `in ${formatDuration(rounded)}` : `${formatDuration(rounded)} ago`;
}

/** "2026-10-05 18:00 UTC" */
export function utc(sec) {
  const d = new Date(sec * 1000).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, d.endsWith(":00.000Z") ? 16 : 19)} UTC`;
}

/** True for a horizon on the recoverable grid (see the top of this file). */
export function onHorizonGrid(sec) {
  if (!Number.isInteger(sec) || sec < MIN_HORIZON || sec > MAX_HORIZON) return false;
  if (sec <= DAY) return sec % (5 * MINUTE) === 0;
  if (sec <= 7 * DAY) return sec % HOUR === 0;
  return sec % DAY === 0;
}

/** The horizons people use most, tried first when recovering a call. */
export const COMMON_HORIZONS = [
  "5m", "10m", "15m", "30m", "45m", "1h", "2h", "3h", "4h", "6h", "8h", "12h", "1d", "2d", "3d", "7d", "14d", "30d",
].map((h) => parseDuration(h));

/** Every grid horizon in [min, max], the common ones first. */
export function horizonGrid(min = MIN_HORIZON, max = MAX_HORIZON) {
  const all = [];
  for (let s = MIN_HORIZON; s <= MAX_HORIZON; s += s < DAY ? 5 * MINUTE : s < 7 * DAY ? HOUR : DAY) all.push(s);
  const inRange = (s) => s >= min && s <= max;
  const common = COMMON_HORIZONS.filter(inRange);
  const rest = all.filter((s) => inRange(s) && !common.includes(s));
  return [...common, ...rest];
}

/** Validate a strategy book's period ("every") and horizon. Returns seconds. */
export function strategyTiming(every, horizon) {
  const periodSec = parseDuration(every, "period");
  const horizonSec = horizon == null ? periodSec : parseDuration(horizon, "horizon");
  if (periodSec % MINUTE || periodSec < MIN_PERIOD || periodSec > MAX_PERIOD) {
    throw new Error(`A strategy book calls every 5m to 7d, in whole minutes; "${every}" is ${formatDuration(periodSec)}.`);
  }
  if (horizonSec % MINUTE || horizonSec < periodSec || horizonSec > MAX_HORIZON) {
    throw new Error(`Each call is held from one period (${formatDuration(periodSec)}) up to 30d, in whole minutes; "${horizon}" is ${formatDuration(horizonSec)}.`);
  }
  return { periodSec, horizonSec };
}

/**
 * The shortest open call: 5 minutes, the contract's own floor. Calls under an
 * hour are priced on 5-minute candles, longer ones on hourly candles
 * (app/verify/callbook-callers.js).
 */
export const MIN_CALL_HORIZON = MIN_HORIZON;

/** Validate an open call's horizon (and a book's bounds, raised to MIN_CALL_HORIZON). Returns seconds. */
export function callHorizon(horizon, { min = MIN_CALL_HORIZON, max = MAX_HORIZON } = {}) {
  const sec = parseDuration(horizon, "horizon");
  const lo = Math.max(min, MIN_CALL_HORIZON);
  if (sec < lo || sec > max) {
    throw new Error(`A call's horizon must be between ${formatDuration(lo)} and ${formatDuration(max)}; "${horizon}" is ${formatDuration(sec)}.`);
  }
  if (sec % MINUTE) throw new Error(`A call's horizon is a whole number of minutes (for example 15m, 4h, 1d); "${horizon}" is ${formatDuration(sec)}.`);
  return sec;
}
