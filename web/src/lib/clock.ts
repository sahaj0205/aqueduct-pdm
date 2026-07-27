/**
 * Where the clock stands, and everything that follows from that.
 *
 * Pure functions over plain values, with no React and no fetching, so the behaviour
 * that decides what every screen shows can be checked in a terminal rather than by
 * clicking. `npm run verify:clock` does exactly that.
 *
 * TWO GRANULARITIES, ON PURPOSE. The scrubber moves in DAYS, because everything the
 * clock drives — health, remaining life, the advisory queue — is computed once a day
 * and a finer scrubber would move without changing anything on screen. Charts that
 * show one day's measurements move in HOURS, because that is the resolution the
 * readings are stored at. `dayOf` and `hoursOfDay` are the two ends of that.
 *
 * TIME IS UTC THROUGHOUT. Every timestamp from the API carries a zone and every
 * timestamp sent back is an ISO string in UTC. The building's own clock is a
 * different thing and is not modelled: this database holds runs placed years apart to
 * keep them separate, so "what time is it in the building" has no answer here worth
 * having.
 */

import type { ClockRange, EraSummary, InjectedFault } from "../types.ts";

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

/** Midnight UTC on the day a moment falls in. */
export function dayOf(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

export function toIso(at: Date): string {
  return at.toISOString();
}

/** The twenty-four hourly marks of a day, for the charts that show one day. */
export function hoursOfDay(at: Date): Date[] {
  const start = dayOf(at).getTime();
  return Array.from({ length: 24 }, (_, i) => new Date(start + i * HOUR_MS));
}

/** Whole days between two moments, ignoring the time of day. */
export function daysBetween(from: Date, to: Date): number {
  return Math.round((dayOf(to).getTime() - dayOf(from).getTime()) / DAY_MS);
}

export function addDays(at: Date, days: number): Date {
  return new Date(at.getTime() + days * DAY_MS);
}

/** Which run a moment falls inside, or null between runs. */
export function eraAt(range: ClockRange, at: Date): EraSummary | null {
  const t = at.getTime();
  return (
    range.eras.find(
      (e) => t >= new Date(e.t_from).getTime() && t <= new Date(e.t_to).getTime(),
    ) ?? null
  );
}

/**
 * Move a moment to the nearest place the clock is allowed to stand.
 *
 * The runs in this database are separated by whole years of nothing, and a clock left
 * in one of those gaps shows a building with no readings, no health and no queue —
 * which looks like a broken dashboard rather than like an empty stretch of calendar.
 * So a moment outside every run is pulled to the closest edge of the closest run.
 */
export function clampToEra(range: ClockRange, at: Date): Date {
  if (eraAt(range, at)) return at;
  let best: Date | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const era of range.eras) {
    for (const edge of [new Date(era.t_from), new Date(era.t_to)]) {
      const gap = Math.abs(edge.getTime() - at.getTime());
      if (gap < bestGap) {
        bestGap = gap;
        best = edge;
      }
    }
  }
  return best ?? at;
}

/**
 * Step the clock, staying inside the run it is already in.
 *
 * Deliberately does NOT roll from the end of one run into the start of the next. Two
 * runs are two different simulations of the same building, and a clock that ran off
 * the end of one into another would show the queue emptying and refilling with
 * different machines for no reason a viewer could see. Stopping at the edge is the
 * honest behaviour, and `atEnd` lets the caller stop playing rather than sit there
 * incrementing nothing.
 */
export function step(range: ClockRange, at: Date, days: number): { at: Date; atEnd: boolean } {
  const era = eraAt(range, at);
  if (!era) return { at: clampToEra(range, at), atEnd: false };
  const next = addDays(at, days);
  const first = new Date(era.t_from);
  const last = new Date(era.t_to);
  if (next.getTime() > last.getTime()) return { at: last, atEnd: true };
  if (next.getTime() < first.getTime()) return { at: first, atEnd: true };
  return { at: next, atEnd: false };
}

/** How far through its run a moment is, 0 to 1, for the scrubber's position. */
export function positionInEra(era: EraSummary, at: Date): number {
  const first = new Date(era.t_from).getTime();
  const last = new Date(era.t_to).getTime();
  if (last <= first) return 0;
  const clamped = Math.min(Math.max(at.getTime(), first), last);
  return (clamped - first) / (last - first);
}

/** The moment a fraction of the way through a run, for dragging the scrubber. */
export function momentAtPosition(era: EraSummary, fraction: number): Date {
  const first = new Date(era.t_from).getTime();
  const last = new Date(era.t_to).getTime();
  const clamped = Math.min(Math.max(fraction, 0), 1);
  return dayOf(new Date(first + clamped * (last - first)));
}

/**
 * When a fault was at a given rung of its severity ladder.
 *
 * SEVERITY IS A POSITION ON THE CLOCK, NOT A SEPARATE DATASET. Each scenario walks
 * its whole ladder once, from healthy to its worst measured rung, so "show me this
 * fault at severity 3" means "put the clock where this trajectory reached rung 3".
 * The alternative — holding each rung as its own run — would need every severity
 * precomputed separately and would leave nothing downstream a history to fit a trend
 * to, because a fault held at a fixed severity never degrades.
 *
 * Returns the MIDPOINT of the rung rather than its start. The start is the instant
 * the trajectory crosses into it, where the difference from the rung below is still
 * nothing; the midpoint is where the rung actually looks like itself.
 */
export function momentAtSeverity(fault: InjectedFault, level: number): Date | null {
  const rungs = fault.ladder.length;
  if (rungs === 0 || level < 1 || level > rungs) return null;
  const onset = new Date(fault.t_onset).getTime();
  const failure = fault.t_failure ? new Date(fault.t_failure).getTime() : null;
  if (failure === null || failure <= onset) return dayOf(new Date(onset));
  const midpoint = (level - 0.5) / rungs;
  return dayOf(new Date(onset + midpoint * (failure - onset)));
}

/**
 * Which faults the answer key says were running at a moment.
 *
 * Used only to label the control bar. The operator view never asks this — it gets its
 * range from the health history, which records what was computed rather than what was
 * true — so the control bar still works, in dates alone, when the reveal service is
 * not running.
 */
export function faultsActiveAt(faults: InjectedFault[], at: Date): InjectedFault[] {
  const t = at.getTime();
  return faults.filter(
    (f) =>
      new Date(f.t_onset).getTime() <= t &&
      (f.t_failure === null || new Date(f.t_failure).getTime() >= t),
  );
}

/** Speeds the play button offers, in simulated days per real second. */
export const SPEEDS = [1, 2, 5, 10] as const;
export type Speed = (typeof SPEEDS)[number];
