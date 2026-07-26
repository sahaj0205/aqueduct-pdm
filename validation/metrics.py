"""Score what fired against what was injected: false alarms, detection, lead time.

Three numbers, in the order a building operator would want them.

FIRST, THE FALSE-ALARM RATE. Field studies of automated fault detection in buildings
report the same failure again and again: the detection works and the programme dies
anyway, because operators stop reading a screen that cries wolf. A system with
perfect recall and one spurious finding a day per unit is worse than useless -- it
trains the person it was bought for to ignore it. So the rate on equipment that was
working is the first thing in the report, not a caveat at the end of it.

SECOND, DETECTION AT SEVERITY LEVEL 1. Every accuracy figure in this document is
computed over the window in which the injected fault had not yet exceeded LBNL's
mildest published severity for it. That restriction is the whole point. A condenser
down to 65% of its heat transfer, a damper stuck three-quarters open, a valve leaking
at full severity -- these move the signals so far that detecting them is not evidence
of anything, and reporting accuracy over the full trajectory would mostly be
reporting accuracy on the easy end of it. Level 1 is the case that is genuinely hard
to separate from a warm afternoon, and it is the case where a warning is still worth
having.

THIRD, LEAD TIME. The gap between the first warning and the failure is what the
system is actually for. Detecting a fault the day the equipment stops is a report,
not a prediction.

WHAT IS BEING CLAIMED, PRECISELY

Detection here is a claim about a MACHINE, not about a fault mode: on this asset, on
this day, did the platform tell an operator something was wrong. Any of the nine
rules or any confirmed degradation mode counts. That is deliberately generous --
the condenser-fouling run is credited when the efficiency mode fires, and the two
are physically the same thing, but the sensor-drift run would also be credited if an
unrelated mode fired for its own reasons. Whether the right fault was NAMED is a
separate question with a separate answer, and it is the sensor-versus-equipment
confusion matrix that answers it.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from validation.detect import RULES_ONLY, Sweep, Window
from validation.groundtruth import FaultEvent, ScenarioLabel, SeverityWindow

POSITIVE = "positive"
NEGATIVE = "negative"
EXCLUDED = "excluded"

# Which asset the platform is expected to show a fault on, when the answer key names
# something the database does not model as a monitored machine.
#
# Both entries below are the same situation: the fault is injected into a piece of
# plant that has no instrumentation of its own, and it is measurable only through the
# machine downstream of it. Recording the substitution here, with the reason, rather
# than quietly scoring against whichever asset happened to fire.
INJECTED_INTO_ASSET: dict[str, tuple[str, ...]] = {
    # The bypass valve belongs to the chilled-water plant, which ships a supply
    # temperature and a setpoint and nothing else. Leaked water shows up as the
    # chiller working against a warmer return, so chiller-1 is where it is visible.
    "chw-plant-1": ("chiller-1",),
    # The cooling tower has a fan and two water temperatures but no health model and
    # no rule of its own -- it is the held-out fault. Fouling reaches the chiller as
    # warmer condenser water.
    "ct-1": ("chiller-1",),
}

# Scenarios excluded from the accuracy figures, with the reason each is excluded.
# Both are reported on their own instead of being dropped: an exclusion that is not
# visible in the output is indistinguishable from a result that was inconvenient.
EXCLUDED_SCENARIOS: dict[str, str] = {
    "cooling_tower_fouling": (
        "held out by design. No rule in this project references a cooling tower "
        "point, a tower approach temperature or the wet-bulb temperature, and no "
        "failure mode is configured for the tower. Scoring it as a missed detection "
        "would charge the rule library for a fault it was deliberately never given, "
        "and scoring it as fault-free would credit the chillers for staying quiet "
        "while their condenser water got warmer. It is reported separately."
    ),
}


@dataclass(frozen=True)
class AssetDay:
    """One asset on one day: what was true, what the platform said, and whether scored."""

    scenario_id: str
    asset_id: str
    day: date
    label: str
    reason: str
    flagged: bool
    findings: tuple[str, ...]


def affected_assets(event: FaultEvent) -> tuple[str, ...]:
    """The monitored machines an injected fault is expected to be visible on."""
    return INJECTED_INTO_ASSET.get(event.asset_id, (event.asset_id,))


def asset_days(
    sweep: Sweep,
    labels: dict[str, ScenarioLabel],
    events: list[FaultEvent],
    severity_windows: dict[str, SeverityWindow],
) -> list[AssetDay]:
    """Label every (asset, day) the data covers, then attach what the platform said.

    Four outcomes, and the interesting work is in the exclusions.

      POSITIVE -- a fault was injected on this machine and this day falls inside the
        severity-1 window. These are the days a detection is owed.

      NEGATIVE -- either the run had no fault injected at all, or the day falls
        before injection. Pre-injection days of a faulted run are ordinary negatives
        and are counted as such: the equipment really was healthy, and a finding
        raised then really is a false alarm, including inside the commissioning
        window the baselines were fitted on.

      EXCLUDED, fault past level 1 -- the days after the trajectory reaches the
        second measured rung. The fault is present, so these are not negatives, but
        detecting it there is the easy case this document declines to take credit for.

      EXCLUDED, coupled machine -- the other two chillers during a chiller run. The
        source data is a whole-plant simulation: when one chiller is fouled the other
        two see a different loop around them, so they cannot be asserted to be
        fault-free, and a firing on chiller-2 during the fouling run is neither
        clearly right nor clearly wrong. Rather than pick whichever reading suited
        the numbers, those asset-days are removed from both sides.
    """
    injected: dict[str, dict[str, FaultEvent]] = {}
    for event in events:
        for asset in affected_assets(event):
            injected.setdefault(event.scenario_id, {})[asset] = event

    out: list[AssetDay] = []
    for scenario_id, per_asset in sorted(sweep.scored.items()):
        excluded_reason = EXCLUDED_SCENARIOS.get(scenario_id)
        label = labels.get(scenario_id)
        severity = severity_windows.get(scenario_id)
        faulted_here = injected.get(scenario_id, {})

        for asset_id, days in sorted(per_asset.items()):
            active: dict[date, list[str]] = {}
            for finding in sweep.findings:
                if finding.scenario_id != scenario_id or finding.asset_id != asset_id:
                    continue
                for day in finding.active_days:
                    active.setdefault(day, []).append(finding.fault_id)

            event = faulted_here.get(asset_id)
            for day in sorted(days):
                found = tuple(sorted(active.get(day, ())))
                verdict, reason = _label(
                    scenario_id, asset_id, day, label, event, severity,
                    faulted_here, excluded_reason,
                )
                out.append(
                    AssetDay(
                        scenario_id=scenario_id, asset_id=asset_id, day=day,
                        label=verdict, reason=reason, flagged=bool(found),
                        findings=found,
                    )
                )
    return out


def _label(
    scenario_id: str,
    asset_id: str,
    day: date,
    label: ScenarioLabel | None,
    event: FaultEvent | None,
    severity: SeverityWindow | None,
    faulted_here: dict[str, FaultEvent],
    excluded_reason: str | None,
) -> tuple[str, str]:
    """One asset-day's truth label. See asset_days for the four outcomes."""
    if excluded_reason is not None:
        return EXCLUDED, "held-out scenario"
    if label is not None and label.is_fault_free:
        return NEGATIVE, "fault-free run"
    if scenario_id in RULES_ONLY:
        return NEGATIVE, "LBNL fault-free reference year, rule firings only"
    if event is None:
        if faulted_here:
            return EXCLUDED, (
                "machine shares a simulated plant with a faulted machine, so it "
                "cannot be asserted healthy"
            )
        return NEGATIVE, "no fault injected on this machine in this run"
    # Order matters here. A day before the fault was injected is a healthy day
    # whatever happens to the trajectory afterwards, so it is labelled before the
    # severity window is consulted. Getting this the other way round threw away the
    # whole pre-injection stretch of the step-fault run -- three weeks of healthy
    # air handler that the false-alarm rate is entitled to.
    onset_day = event.t_onset.date()
    if day < onset_day:
        return NEGATIVE, "before the fault was injected"
    if severity is None or not severity.scored:
        return EXCLUDED, (
            severity.reason if severity is not None else "no severity window computed"
        )
    end_day = severity.t_to.date() if severity.t_to else onset_day
    if day <= end_day:
        return POSITIVE, "fault present, still at or below severity level 1"
    return EXCLUDED, "fault present but past severity level 1"


# ---------------------------------------------------------------------------
# 1. false alarms
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FalseAlarms:
    """What the platform raised on equipment that was working."""

    scenario_id: str
    asset_days: int
    findings: int
    alarm_days: int
    episodes: int
    detectors: str

    @property
    def findings_per_asset_day(self) -> float:
        return self.findings / self.asset_days if self.asset_days else 0.0

    @property
    def alarm_day_fraction(self) -> float:
        return self.alarm_days / self.asset_days if self.asset_days else 0.0


def false_alarms(days: list[AssetDay], sweep: Sweep) -> list[FalseAlarms]:
    """Per run, the false-alarm load on the asset-days labelled healthy.

    Three counts, because they answer three different questions and only the first is
    the headline.

      findings per asset-day -- how many separate things an operator is asked to
        dispose of, per machine per day. This is the number that decides whether
        anybody keeps using the system. A finding is one (machine, fault) pair
        raised once, however many separate episodes it covered.

      alarm-days -- what share of days had at least one finding standing. This is
        exactly the false-positive count in the detection confusion matrix, so the
        two sections cannot quietly disagree.

      episodes -- the raw count of sustained stretches, kept only so these figures
        can be lined up against the per-rule tables in checkpoints 3.3 and 3.4,
        which counted this way.
    """
    healthy: dict[str, set[tuple[str, date]]] = {}
    for entry in days:
        if entry.label != NEGATIVE:
            continue
        healthy.setdefault(entry.scenario_id, set()).add((entry.asset_id, entry.day))

    out: list[FalseAlarms] = []
    for scenario_id, pairs in sorted(healthy.items()):
        by_asset: dict[str, set[date]] = {}
        for asset_id, day in pairs:
            by_asset.setdefault(asset_id, set()).add(day)

        findings = 0
        episodes = 0
        alarm_days = 0
        for finding in sweep.for_window(scenario_id):
            overlap = finding.active_days & by_asset.get(finding.asset_id, frozenset())
            if not overlap:
                continue
            findings += 1
            episodes += finding.episodes
        for asset_id, asset_days_set in by_asset.items():
            flagged = {
                day
                for finding in sweep.for_window(scenario_id)
                if finding.asset_id == asset_id
                for day in finding.active_days & asset_days_set
            }
            alarm_days += len(flagged)

        out.append(
            FalseAlarms(
                scenario_id=scenario_id, asset_days=len(pairs), findings=findings,
                alarm_days=alarm_days, episodes=episodes,
                detectors=("rules only" if scenario_id in RULES_ONLY
                           else "rules and confirmed degradation"),
            )
        )
    return out


# ---------------------------------------------------------------------------
# 2. detection at severity level 1
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Confusion:
    """A 2x2 detection table over asset-days."""

    tp: int
    fp: int
    fn: int
    tn: int

    @property
    def precision(self) -> float | None:
        return self.tp / (self.tp + self.fp) if (self.tp + self.fp) else None

    @property
    def recall(self) -> float | None:
        return self.tp / (self.tp + self.fn) if (self.tp + self.fn) else None

    @property
    def f1(self) -> float | None:
        p, r = self.precision, self.recall
        if p is None or r is None or (p + r) == 0.0:
            return None
        return 2.0 * p * r / (p + r)


def confusion(days: list[AssetDay]) -> Confusion:
    """Precision, recall and F1 over every scored asset-day."""
    tp = fp = fn = tn = 0
    for entry in days:
        if entry.label == POSITIVE:
            tp += entry.flagged
            fn += not entry.flagged
        elif entry.label == NEGATIVE:
            fp += entry.flagged
            tn += not entry.flagged
    return Confusion(tp=tp, fp=fp, fn=fn, tn=tn)


@dataclass(frozen=True)
class FalsePositiveSource:
    """One channel's contribution to the false-positive count, and its size."""

    scenario_id: str
    asset_id: str
    fault_id: str
    source: str
    fp_days: int
    detail: str
    peak_severity: float
    calendar_twins: tuple[date, ...]

    @property
    def health_points_lost(self) -> int:
        """How far the health score actually fell, in points out of a hundred."""
        return round(self.peak_severity * 100.0)


def false_positive_sources(
    days: list[AssetDay], sweep: Sweep, labels: dict[str, ScenarioLabel]
) -> list[FalsePositiveSource]:
    """Which channels produced the false positives, and how much of the total each is.

    A precision figure with no attribution behind it is not actionable and is barely
    honest -- "43%" could mean every detector is noisy or it could mean one channel is
    broken and the rest are silent, and those call for opposite responses. So the
    false-positive asset-days are broken out per channel.

    The calendar twin is carried for the same reason it is carried on the held-out
    run: every synthesised window reads the same 2018 source data shifted by whole
    years, so a channel that raises the same finding on the same day of the year
    across different runs is tracking the season, and one that does not is tracking
    something in the run.
    """
    healthy: dict[tuple[str, str], set[date]] = {}
    for entry in days:
        if entry.label == NEGATIVE:
            healthy.setdefault((entry.scenario_id, entry.asset_id), set()).add(entry.day)

    elsewhere: dict[tuple[str, str, tuple[int, int]], list[date]] = {}
    for finding in sweep.findings:
        day = finding.first_seen.date()
        elsewhere.setdefault(
            (finding.asset_id, finding.fault_id, (day.month, day.day)), []
        ).append(day)

    out: list[FalsePositiveSource] = []
    for finding in sweep.findings:
        overlap = finding.active_days & healthy.get(
            (finding.scenario_id, finding.asset_id), frozenset()
        )
        if not overlap:
            continue
        day = finding.first_seen.date()
        twins = [
            other
            for other in elsewhere.get(
                (finding.asset_id, finding.fault_id, (day.month, day.day)), []
            )
            if other != day
        ]
        out.append(
            FalsePositiveSource(
                scenario_id=finding.scenario_id, asset_id=finding.asset_id,
                fault_id=finding.fault_id, source=finding.source,
                fp_days=len(overlap), detail=finding.detail,
                peak_severity=finding.peak_severity,
                calendar_twins=tuple(sorted(twins)),
            )
        )
    return sorted(out, key=lambda s: (-s.fp_days, s.asset_id))


@dataclass(frozen=True)
class EventOutcome:
    """Whether one injected fault was caught while it was still at level 1."""

    scenario_id: str
    asset_id: str
    fault_mode: str
    mildest_label: str
    window_days: float
    positive_days: int
    detected_days: int
    caught: bool
    first_detection: datetime | None
    first_channel: str | None
    days_after_injection: float | None

    @property
    def coverage(self) -> float:
        return self.detected_days / self.positive_days if self.positive_days else 0.0


def event_outcomes(
    days: list[AssetDay],
    sweep: Sweep,
    events: list[FaultEvent],
    severity_windows: dict[str, SeverityWindow],
) -> list[EventOutcome]:
    """Per injected fault, the roll-up of the asset-day table.

    The asset-day view answers "how much of the mild period did we have this
    flagged". This answers the question a maintenance planner would actually ask,
    which is "did you catch it at all, and how long did you take".
    """
    positives: dict[tuple[str, str], list[AssetDay]] = {}
    for entry in days:
        if entry.label == POSITIVE:
            positives.setdefault((entry.scenario_id, entry.asset_id), []).append(entry)

    out: list[EventOutcome] = []
    for event in sorted(events, key=lambda e: e.t_onset):
        severity = severity_windows.get(event.scenario_id)
        for asset_id in affected_assets(event):
            scored = positives.get((event.scenario_id, asset_id))
            if not scored:
                continue
            detected = [e for e in scored if e.flagged]
            window_end = severity.t_to if severity and severity.t_to else None
            inside = [
                f for f in sweep.for_window(event.scenario_id)
                if f.asset_id == asset_id
                and f.first_seen >= event.t_onset
                and (window_end is None or f.first_seen <= window_end)
            ]
            first = min(inside, key=lambda f: f.first_seen) if inside else None
            out.append(
                EventOutcome(
                    scenario_id=event.scenario_id, asset_id=asset_id,
                    fault_mode=event.fault_mode, mildest_label=event.mildest_label,
                    window_days=severity.days if severity else 0.0,
                    positive_days=len(scored), detected_days=len(detected),
                    caught=bool(detected),
                    first_detection=first.first_seen if first else None,
                    first_channel=f"{first.fault_id}" if first else None,
                    days_after_injection=(
                        (first.first_seen - event.t_onset).total_seconds() / 86400.0
                        if first else None
                    ),
                )
            )
    return out


# ---------------------------------------------------------------------------
# 3. lead time
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class LeadTime:
    """One channel's warning on one injected fault."""

    scenario_id: str
    fault_mode: str
    asset_id: str
    source: str
    fault_id: str
    first_seen: datetime
    t_failure: datetime
    lead_days: float


def lead_times(
    sweep: Sweep, events: list[FaultEvent], skip: frozenset[str] | None = None
) -> list[LeadTime]:
    """Every warning the platform gave before each injected failure, and how early.

    The population is one row per (injected fault, detection channel), not one row
    per fault. That is what makes a distribution out of five events: condenser
    fouling is caught by the approach-temperature rule, by the kilowatt-per-ton
    rule, by the condenser-fouling degradation mode and by the efficiency mode, and
    those four warnings arrive on four different days. Reporting only the earliest
    would describe a system that always warns as early as its luckiest detector.

    Only detections raised BEFORE the failure date count. A finding first raised
    after the equipment has already reached terminal severity has a negative lead
    and is not a warning, so it is dropped from the distribution rather than
    averaged into it -- and the count of those dropped is reported.
    """
    skip = skip or frozenset()
    by_scenario: dict[str, list[FaultEvent]] = {}
    for event in events:
        by_scenario.setdefault(event.scenario_id, []).append(event)

    out: list[LeadTime] = []
    for scenario_id, group in by_scenario.items():
        if scenario_id in skip:
            continue
        for event in group:
            if event.t_failure is None or event.t_failure <= event.t_onset:
                continue
            for asset_id in affected_assets(event):
                for finding in sweep.for_window(scenario_id):
                    if finding.asset_id != asset_id:
                        continue
                    if finding.first_seen >= event.t_failure:
                        continue
                    out.append(
                        LeadTime(
                            scenario_id=scenario_id, fault_mode=event.fault_mode,
                            asset_id=asset_id, source=finding.source,
                            fault_id=finding.fault_id, first_seen=finding.first_seen,
                            t_failure=event.t_failure,
                            lead_days=(
                                event.t_failure - finding.first_seen
                            ).total_seconds() / 86400.0,
                        )
                    )
    return sorted(out, key=lambda lt: (lt.fault_mode, -lt.lead_days))


@dataclass(frozen=True)
class LeadSummary:
    """The lead-time distribution for one failure mode, or pooled across all."""

    fault_mode: str
    n: int
    median: float
    p10: float
    minimum: float
    maximum: float
    earliest_channel: str


def percentile(values: list[float], q: float) -> float:
    """The q-th percentile by linear interpolation, on a sorted copy.

    Written out rather than taken from numpy so the convention is visible: with four
    or five samples the choice of interpolation moves the tenth percentile by days,
    and a reader comparing this against their own tooling needs to know which
    definition produced the number.
    """
    if not values:
        return float("nan")
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = q * (len(ordered) - 1)
    low = int(position)
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] + (position - low) * (ordered[high] - ordered[low])


def lead_summaries(leads: list[LeadTime]) -> list[LeadSummary]:
    """Per failure mode, and then pooled: median and tenth-percentile warning."""
    groups: dict[str, list[LeadTime]] = {}
    for lead in leads:
        groups.setdefault(lead.fault_mode, []).append(lead)

    out: list[LeadSummary] = []
    for mode, group in sorted(groups.items()):
        values = [lt.lead_days for lt in group]
        earliest = max(group, key=lambda lt: lt.lead_days)
        out.append(
            LeadSummary(
                fault_mode=mode, n=len(values),
                median=statistics.median(values), p10=percentile(values, 0.10),
                minimum=min(values), maximum=max(values),
                earliest_channel=f"{earliest.fault_id} on {earliest.asset_id}",
            )
        )
    if leads:
        values = [lt.lead_days for lt in leads]
        earliest = max(leads, key=lambda lt: lt.lead_days)
        out.append(
            LeadSummary(
                fault_mode="ALL FAULTS POOLED", n=len(values),
                median=statistics.median(values), p10=percentile(values, 0.10),
                minimum=min(values), maximum=max(values),
                earliest_channel=f"{earliest.fault_id} on {earliest.asset_id}",
            )
        )
    return out


def late_findings(
    sweep: Sweep, events: list[FaultEvent], skip: frozenset[str] | None = None
) -> list[tuple[str, str, str, float]]:
    """Findings first raised after the failure date, which are reports not warnings."""
    skip = skip or frozenset()
    out = []
    for event in events:
        if event.t_failure is None or event.scenario_id in skip:
            continue
        for asset_id in affected_assets(event):
            for finding in sweep.for_window(event.scenario_id):
                if finding.asset_id != asset_id:
                    continue
                if finding.first_seen < event.t_failure:
                    continue
                out.append((
                    event.scenario_id, asset_id, finding.fault_id,
                    (finding.first_seen - event.t_failure).total_seconds() / 86400.0,
                ))
    return sorted(out)


# ---------------------------------------------------------------------------
# the held-out fault
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class HeldOut:
    """One finding on a run whose fault the rule library was never given."""

    scenario_id: str
    asset_id: str
    source: str
    fault_id: str
    first_seen: datetime
    active_days: int
    calendar_twin: date | None

    @property
    def attributable(self) -> bool:
        """Whether this finding can be credited to the held-out fault at all."""
        return self.calendar_twin is None


def held_out(sweep: Sweep, labels: dict[str, ScenarioLabel]) -> list[HeldOut]:
    """What fired on the held-out run, and whether the fault can be credited for it.

    The cooling tower fault exists to test whether anything catches a fault the rule
    library does not cover. Something did fire on it, and the obvious reading is that
    the degradation layer caught what the rules could not. The obvious reading is
    wrong, and this function is what shows it.

    Every synthesised run reads the same 2018 source window shifted forward by a whole
    number of years, so a detection driven by the weather lands on the same day of the
    year in every run, and a detection driven by the injected fault does not. So each
    finding on the held-out run is checked against the fault-free runs for the same
    machine and the same channel firing on the same calendar day. A match -- the same
    channel, the same machine, the same day of the year, on a run with no fault in it
    at all -- means the finding tracks the season and not the tower.
    """
    twins: dict[tuple[str, str, tuple[int, int]], date] = {}
    for finding in sweep.findings:
        label = labels.get(finding.scenario_id)
        if label is None or not label.is_fault_free:
            continue
        day = finding.first_seen.date()
        twins[(finding.asset_id, finding.fault_id, (day.month, day.day))] = day

    out: list[HeldOut] = []
    for scenario_id in sorted(EXCLUDED_SCENARIOS):
        for finding in sweep.for_window(scenario_id):
            day = finding.first_seen.date()
            out.append(
                HeldOut(
                    scenario_id=scenario_id, asset_id=finding.asset_id,
                    source=finding.source, fault_id=finding.fault_id,
                    first_seen=finding.first_seen,
                    active_days=len(finding.active_days),
                    calendar_twin=twins.get(
                        (finding.asset_id, finding.fault_id, (day.month, day.day))
                    ),
                )
            )
    return sorted(out, key=lambda h: (h.asset_id, h.fault_id))


def scored_span(days: list[AssetDay]) -> tuple[date, date] | None:
    """The calendar extent of everything scored, for the report header."""
    if not days:
        return None
    return min(d.day for d in days), max(d.day for d in days)


def window_days(window: Window) -> int:
    return (window.t_to - window.t_from) // timedelta(days=1)
