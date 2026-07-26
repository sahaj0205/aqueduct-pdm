/**
 * Preparing the fan chart's data. Pure, so it can be checked without a browser.
 *
 * THE FAN CHART IS TWO PANELS SHARING ONE TIME AXIS, and the reason is that the
 * checkpoint asks for two different things that cannot honestly be drawn on one pair
 * of axes.
 *
 *   TOP: the degradation indicator against calendar time, with the failure threshold
 *        as a horizontal line and the predicted crossing window shaded. This is the
 *        physics — how far the machine has actually travelled and how far it has left
 *        to go. Its y axis is the indicator's own unit, kelvin or watts or kW/ton.
 *
 *   BOTTOM: the remaining-life interval as a function of WHEN THE PREDICTION WAS MADE.
 *        Its y axis is days. This is the panel that narrows, and the narrowing is the
 *        claim the whole project rests on: as evidence accumulates the model gets more
 *        certain, and you can watch it happen.
 *
 * Putting the interval on the top panel instead would mean drawing days on an axis
 * measured in kelvin. Putting the indicator on the bottom panel would mean hiding the
 * threshold, which is the only thing that makes "failure" mean anything. So: two
 * panels, one x axis, and the reader's eye travels down from "here is the machine" to
 * "here is how sure we are".
 *
 * WHAT THIS MODULE WILL NOT DO. If the advisory carries a refusal, no band is
 * produced — not a wide one, not a dashed one. A refused prediction is not an
 * uncertain prediction, and drawing any band at all would contradict the sentence
 * printed beside it. `fanBand` returns an empty array and the caller renders the
 * reason instead.
 */

import type { AdvisoryPayload, HealthPoint, RulPoint } from "../types.ts";

const DAY_MS = 86_400_000;

/**
 * How far back before an advisory's evidence window both panels reach.
 *
 * The advisory's own window is the span the fault CLASSIFICATION was computed over --
 * a month or two, chosen so the isolation sweep has a stable operating point. The
 * degradation story is longer than that and starts earlier: the coil leak's onset is
 * confirmed on 19 March and its first prediction published on 1 April, both well
 * before the classification window opens on 27 May. Clipping to the classification
 * window threw away the first two months of predictions, which is exactly where the
 * interval does most of its closing -- 2,259 days down to 138 before the window even
 * begins.
 *
 * A hundred and twenty days is the span of a synthesised run, so this reaches back to
 * the start of whichever run the advisory belongs to and no further. Reaching further
 * would pull in the SAME mode's estimates from a different run and draw two unrelated
 * histories as one line with a two-year gap in it.
 *
 * Shared by the indicator panel, the band panel and the health query, so the two
 * panels cannot end up with different x domains.
 */
export const LOOKBACK_DAYS = 120;

export interface IndicatorPoint {
  /** Epoch millis, so Recharts can scale a real time axis rather than categories. */
  t: number;
  raw: number | null;
  clamped: number | null;
}

export interface BandPoint {
  t: number;
  p10: number | null;
  p50: number | null;
  p90: number | null;
  /** p90 - p10, carried so the tooltip can state the width without recomputing. */
  width: number | null;
  n: number;
}

export function toEpoch(iso: string): number {
  return new Date(iso).getTime();
}

/**
 * The indicator history for one mode, in calendar order.
 *
 * Both series are kept. The clamped one is what health and the prediction are
 * computed from and is the honest line to read a trend off; the raw one is what the
 * sensor actually said. Showing only the clamped line would hide the excursions that
 * caused the contradiction the advisory layer has to guard against, and showing only
 * the raw line would make the trend unreadable.
 */
export function indicatorSeries(
  series: HealthPoint[],
  modeId: string | null,
): IndicatorPoint[] {
  if (!modeId) return [];
  return series
    .filter((point) => point.mode_id === modeId)
    .map((point) => ({
      t: toEpoch(point.time),
      raw: point.indicator_raw,
      clamped: point.indicator_monotonic,
    }))
    .sort((a, b) => a.t - b.t);
}

/**
 * The narrowing band, one point per date a prediction was published.
 *
 * Restricted to the advisory's own RUN, not to its classification window -- see
 * LOOKBACK_DAYS. Without the restriction to one run the air handler's coil leak would
 * draw its 2036 estimates and its 2038 estimates on one axis with a two-year gap
 * between them, which is not a narrowing interval, it is two.
 *
 * Points where the upper end is unbounded keep p10 and p50 and carry a null p90, so
 * the line continues and the band is simply absent there. That is the truthful
 * rendering of "there may be no failure date at all" — an open top, not a guessed one.
 */
export function fanBand(
  history: RulPoint[],
  payload: AdvisoryPayload,
): BandPoint[] {
  if (payload.forecast.refusal !== null) return [];
  const from = toEpoch(payload.window.from) - LOOKBACK_DAYS * DAY_MS;
  const to = toEpoch(payload.window.to) + 2 * DAY_MS;
  return history
    .map((point) => ({
      t: toEpoch(point.as_of),
      p10: point.p10,
      p50: point.p50,
      p90: point.p90,
      width: point.width,
      n: point.n_samples,
    }))
    .filter((point) => point.t >= from && point.t <= to)
    .sort((a, b) => a.t - b.t);
}

export interface CrossingWindow {
  /** Epoch millis of the earliest, median and latest predicted crossing. */
  p10: number;
  p50: number;
  p90: number | null;
  from: string;
}

/**
 * Where the top panel shades the predicted failure window.
 *
 * The interval is published in DAYS FROM the date it was made, so turning it into a
 * region on a calendar axis means adding it to that date. An interval of 11 to 34 days
 * made on 23 June becomes a shaded band from 4 July to 27 July, which is the form a
 * maintenance planner can actually put in a diary.
 */
export function crossingWindow(payload: AdvisoryPayload): CrossingWindow | null {
  const { p10, p50, p90, as_of, refusal } = payload.forecast;
  if (refusal !== null || p10 === null || p50 === null || as_of === null) return null;
  const base = toEpoch(as_of);
  return {
    p10: base + p10 * DAY_MS,
    p50: base + p50 * DAY_MS,
    p90: p90 === null ? null : base + p90 * DAY_MS,
    from: as_of,
  };
}

export interface Narrowing {
  first: BandPoint | null;
  last: BandPoint | null;
  narrowestWidth: number | null;
  widestWidth: number | null;
  /** Percent the interval closed between the first and last bounded estimate. */
  percentClosed: number | null;
  /** True if every step was at least as narrow as the one before it. */
  monotone: boolean;
  bounded: number;
  unbounded: number;
}

/**
 * How much the interval closed, stated rather than left to the eye.
 *
 * `monotone` is reported separately from `percentClosed` and the distinction is not
 * pedantry. These intervals close dramatically over a run and still widen from one day
 * to the next, because each estimate is refitted from that day's evidence and a single
 * flat day genuinely is weaker evidence about a rate than the day before. A chart
 * claiming monotone convergence would be overselling; one showing a 97 percent close
 * with visible local widenings is what the model actually does.
 */
export function narrowing(band: BandPoint[]): Narrowing {
  const bounded = band.filter(
    (point): point is BandPoint & { width: number } => point.width !== null,
  );
  if (bounded.length === 0) {
    return {
      first: band[0] ?? null,
      last: band[band.length - 1] ?? null,
      narrowestWidth: null,
      widestWidth: null,
      percentClosed: null,
      monotone: false,
      bounded: 0,
      unbounded: band.length,
    };
  }
  const first = bounded[0]!;
  const last = bounded[bounded.length - 1]!;
  const widths = bounded.map((point) => point.width);
  let monotone = true;
  for (let i = 1; i < widths.length; i += 1) {
    if (widths[i]! > widths[i - 1]!) {
      monotone = false;
      break;
    }
  }
  return {
    first,
    last,
    narrowestWidth: Math.min(...widths),
    widestWidth: Math.max(...widths),
    percentClosed:
      first.width > 0 ? (1 - last.width / first.width) * 100 : null,
    monotone,
    bounded: bounded.length,
    unbounded: band.length - bounded.length,
  };
}

/**
 * The calendar span both panels and the health query cover, as ISO strings.
 *
 * One function so the indicator line, the band and the health request are guaranteed
 * to be fetched and drawn over the same interval. Three separate date calculations is
 * how a chart ends up with a band that extends past its own indicator.
 */
export function chartWindow(payload: AdvisoryPayload): { from: string; to: string } {
  const from = new Date(toEpoch(payload.window.from) - LOOKBACK_DAYS * DAY_MS);
  const to = new Date(toEpoch(payload.window.to) + 2 * DAY_MS);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** Health over the window, for the small trend panel. */
export function healthSeries(
  series: HealthPoint[],
  modeId: string | null,
): { t: number; health: number | null; rollup: number | null }[] {
  const byTime = new Map<number, { health: number | null; rollup: number | null }>();
  for (const point of series) {
    const t = toEpoch(point.time);
    const entry = byTime.get(t) ?? { health: null, rollup: null };
    if (point.mode_id === null) entry.rollup = point.health;
    else if (point.mode_id === modeId) entry.health = point.health;
    byTime.set(t, entry);
  }
  return [...byTime.entries()]
    .map(([t, value]) => ({ t, ...value }))
    .sort((a, b) => a.t - b.t);
}
