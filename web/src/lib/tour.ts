import { addDays, eraAt } from "./clock.ts";
import type { ClockRange, InjectedFault } from "../types.ts";

/**
 * The guided path through the demonstration, in the order of the argument.
 *
 * WHY IT EXISTS. Seven screens of equal weight is the confusion this whole phase set out
 * to remove. Renaming them and putting them in the order of the argument helps a reader
 * who already knows they are reading an argument; somebody meeting the system cold still
 * has to pick a tab and hope. This drives the screens and the clock in sequence, one
 * sentence a step, so the case makes itself.
 *
 * BUILT FROM THE DATA, NOT WRITTEN DOWN. Every moment this tour stops at is derived from
 * the run list the API returns, and refined by the answer key only when the reveal
 * service is running. Twice in this phase a sentence with a number written into it turned
 * out to be describing a database that had moved on — a caption claiming six of a hundred
 * and seven readings had a baseline when it was four of a hundred and nine, and a comment
 * claiming three unit changes in a funnel that has six. A tour with dates typed into it
 * would fail the same way, silently, in front of an audience.
 *
 * IT DEGRADES RATHER THAN BREAKS. With no answer key every step still has a moment to
 * stand at, taken from the runs themselves; the steps that would have pointed at an
 * injection date point at the end of a run instead. Nothing is hidden and no step
 * disappears, because a tour that silently drops steps teaches the presenter a running
 * order that will not hold on another machine.
 */

export interface TourStep {
  /** Path to show. Matches the routes in App. */
  to: string;
  /** Where to stand the clock. Null leaves it wherever the viewer left it. */
  at: Date | null;
  /** The claim this step makes. Shown at display size. */
  title: string;
  /** One sentence telling the viewer what to look at, and why it matters. */
  say: string;
}

/** Earliest injection in the answer key, or null when the reveal service is absent. */
function firstOnset(faults: InjectedFault[] | null): InjectedFault | null {
  if (!faults || faults.length === 0) return null;
  return [...faults].sort(
    (a, b) => new Date(a.t_onset).getTime() - new Date(b.t_onset).getTime(),
  )[0]!;
}

export function buildTour(
  range: ClockRange,
  faults: InjectedFault[] | null,
): TourStep[] {
  const first = range.eras[0];
  // No runs means no database worth touring. The caller checks for an empty list.
  if (!first) return [];

  const endOfFirst = new Date(first.t_to);
  const startOfFirst = new Date(first.t_from);

  // A day before the earliest injection: the interesting thing to watch is the system
  // NOT knowing yet. Landing on the onset itself skips exactly that. Falls back to the
  // opening of the first run, which is commissioning data with nothing wrong in it.
  const onset = firstOnset(faults);
  const beforeAnything =
    onset && eraAt(range, new Date(onset.t_onset))
      ? addDays(new Date(onset.t_onset), -1)
      : startOfFirst;

  return [
    {
      to: "/",
      at: endOfFirst,
      title: "Something in this building is going wrong.",
      say: "Two numbers, and the gap between them: what leaving the work alone is expected to cost, against what doing it costs. Everything else on this screen explains that gap.",
    },
    {
      to: "/building",
      at: endOfFirst,
      title: "This is where it sits.",
      say: "Heat flows left to right — towers throw it away, chillers make cold water, the air handler blows it at the rooms. The colour is one question at a time; the switch above picks which.",
    },
    {
      to: "/",
      at: beforeAnything,
      title: "Now wind the clock back. Nothing is wrong yet.",
      say: onset
        ? "This is the day before anything was injected. The queue is quiet, and the system has no idea what is coming — which is the only honest way to watch it find out."
        : "This is the opening of the run, before anything has gone wrong. The queue is quiet, and the system has no idea what is coming.",
    },
    {
      to: "/how-we-know",
      at: endOfFirst,
      title: "It does not find out by being clever.",
      say: "Ten stages, and almost all of them are refusals. Read down the column of numbers: three hundred thousand readings become four findings, and every narrowing has a stated reason.",
    },
    {
      to: "/how-we-know",
      at: endOfFirst,
      title: "The rules fire on healthy machines too.",
      say: "The right-hand column is the same machine on the same day of the year with nothing wrong. Look at stage five, then stage six: the healthy machine's alarms all die at the requirement that a complaint must hold for an hour.",
    },
    {
      to: "/sensor-or-machine",
      at: null,
      title: "The same symptom, two completely different jobs.",
      say: "Air coming out too warm is a coil that cannot cool, and it is also a thermometer reading high. Telling them apart is worth the ratio at the top of this screen, and it decides which van goes out.",
    },
    {
      to: "/time-left",
      at: null,
      title: "How long it has, and how wrong we were.",
      say: "The range closes as evidence arrives — that is the model working. Then look at the chart: the blue line never reaches the green one. It is late, consistently, which is the dangerous direction.",
    },
    {
      to: "/rules",
      at: null,
      title: "Every number here had to justify itself.",
      say: "Click any row. The reason a threshold is that number and not another is stored beside it in a column that cannot be left empty — so no figure in this system arrived without an argument.",
    },
    {
      to: "/answer",
      at: endOfFirst,
      title: "And here is what was actually broken.",
      say: "Everything up to this point was worked out from readings alone. This page is served by a different process on a different credential, because the detection path is not permitted to read it. That is what makes the accuracy figures mean anything.",
    },
  ];
}
