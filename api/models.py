"""Pydantic v2 response models: the published shape of every endpoint.

These are the contract. The frontend is written against them and nothing else, so
a field renamed here is a breaking change and a field renamed in the analytics
layer is not. That indirection is the point -- the internal dataclasses in
analytics/ are free to change shape as the maths changes, and this file decides
what any of it looks like from outside.

TWO CONVENTIONS THAT RUN THROUGH ALL OF THEM

Optional means "the system declines to say", never "we forgot to fill this in".
A null p50 means the remaining-life model does not bound the crossing. A null
priority means the cost of inaction could not be computed at all. Both are answers,
and the frontend has to render them as answers rather than as blanks -- which is
why every one of them travels next to a text field carrying the reason.

Units are in the field name or in a sibling field, never assumed. A number called
`cost_usd` and a number called `duration_hours` cannot be confused; a number called
`value` can.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class AssetSummary(BaseModel):
    """One row of the asset list."""

    asset_id: str
    name: str
    brick_class: str = Field(description="Brick Schema class, e.g. brick:Chiller")
    criticality_tier: int = Field(ge=1, le=3, description="1 is most critical")
    replacement_cost_usd: float | None
    occupants_served: int
    health: int | None = Field(
        default=None,
        description="Latest asset roll-up, 0 to 100. Null if never scored.",
    )
    weakest_mode: str | None = Field(
        default=None, description="Which failure mode produced the roll-up minimum"
    )
    health_as_of: datetime | None = None
    open_advisories: int = 0


class PointSummary(BaseModel):
    """One sensor or setpoint on an asset."""

    point_id: str
    name: str
    brick_class: str
    unit_si: str
    expected_min: float | None
    expected_max: float | None
    usable: bool = Field(
        default=True,
        description=(
            "False when the source data for this point is known to be defective in a "
            "way no per-row processing can repair. Distinct from the quality score: "
            "quality asks whether a reading can be believed right now, this asks "
            "whether the column means what its name says at all. Published so a "
            "chart can grey the point out AND say why -- a measurement that vanishes "
            "without explanation is what an engineer spends an afternoon looking for."
        ),
    )
    unusable_reason: str | None = None


class AssetDetail(AssetSummary):
    """An asset with its instrument list attached."""

    install_date: str | None = None
    repair_cost_usd: float | None = None
    points: list[PointSummary] = []


class HealthPoint(BaseModel):
    """One day of one failure mode's health, or of the asset roll-up."""

    time: datetime
    mode_id: str | None = Field(
        default=None, description="Null on the asset roll-up row"
    )
    health: int | None
    indicator_raw: float | None
    indicator_monotonic: float | None = Field(
        default=None,
        description=(
            "The indicator after enforcing that degradation does not un-happen. "
            "Health is computed from THIS, not from indicator_raw, so the two can "
            "differ substantially on a noisy indicator."
        ),
    )
    t_onset: datetime | None = Field(
        default=None,
        description=(
            "When degradation was confirmed, or null if it never was. Nothing "
            "projects a trend forward before this is set."
        ),
    )
    weakest_mode: str | None = None


class HealthSeries(BaseModel):
    """Health over time for one asset, per mode plus the roll-up."""

    asset_id: str
    modes: list[str]
    series: list[HealthPoint]


class TimeseriesPoint(BaseModel):
    """One hour of one measurement."""

    bucket: datetime
    avg: float | None
    min: float | None
    max: float | None
    stddev: float | None = Field(
        default=None,
        description=(
            "Sample standard deviation within the hour. Carried because a widening "
            "spread is itself an early degradation signal, so a chart that only "
            "shows the mean loses it."
        ),
    )
    samples: int


class TimeseriesResult(BaseModel):
    """Hourly readings for one or more points over a window."""

    asset_id: str
    unit_si: dict[str, str] = Field(
        description="Unit per point id, so a chart never has to guess"
    )
    source: str = Field(
        default="app.measurements_hourly",
        description=(
            "Always the hourly rollup, never the raw table. A year of one point at "
            "the five-minute cadence is over a hundred thousand rows and no chart "
            "can draw them; more importantly, serving raw would let a client pull "
            "the whole measurement history one request at a time."
        ),
    )
    series: dict[str, list[TimeseriesPoint]]


class RulPoint(BaseModel):
    """One date's remaining-life estimate, for the narrowing-interval chart."""

    as_of: datetime
    p10: float | None = Field(default=None, description="Days. Pessimistic end.")
    p50: float | None = Field(default=None, description="Days. Plan around this.")
    p90: float | None = Field(default=None, description="Days. Optimistic end.")
    width: float | None = Field(
        default=None,
        description=(
            "P90 minus P10 in days. The number the demo rests on: it should shrink "
            "as evidence accumulates. Null when either end is unbounded."
        ),
    )
    mu_hat: float
    sigma_hat: float
    n_samples: int


class RulHistory(BaseModel):
    """Every estimate ever published for one asset, oldest first, per mode."""

    asset_id: str
    modes: dict[str, list[RulPoint]]
    failure_threshold: dict[str, float] = Field(
        default_factory=dict,
        description="Per mode, the indicator value counted as failed",
    )
    indicator_unit: dict[str, str] = Field(default_factory=dict)


class GraphNode(BaseModel):
    """One asset reached by a traversal, and how far away it is."""

    asset_id: str
    name: str
    brick_class: str
    hops: int = Field(
        description=(
            "Shortest number of graph edges, counting equipment the database does "
            "not model as an asset -- the two water loops are each one hop."
        )
    )
    health: int | None = None
    open_advisories: int = 0


class GraphResult(BaseModel):
    """A traversal result in one direction."""

    asset_id: str
    direction: str = Field(description="upstream or downstream")
    nodes: list[GraphNode]
    zones: list[str] = Field(
        default_factory=list,
        description="Occupied spaces reached, downstream only",
    )
    occupants: int = 0


class AdvisorySummary(BaseModel):
    """One row of the operator's queue."""

    advisory_id: str
    asset_id: str
    asset_name: str
    fault_id: str
    fault_title: str
    fault_class: str = Field(description="sensor, equipment, control or ambiguous")
    mode_id: str | None
    status: str
    health: int | None
    severity: float = Field(ge=0.0, le=1.0)
    priority: float | None = Field(
        default=None,
        description=(
            "Expected USD saved per USD spent. Null means the cost of inaction "
            "could not be computed -- an answer, not a gap, and NOT the same as "
            "zero. Null rows are ranked among themselves by severity."
        ),
    )
    cost_usd: float
    effort_usd: float
    consequential: bool = Field(
        description=(
            "True when an upstream fault plausibly produces this symptom. Such rows "
            "are demoted, never hidden."
        )
    )
    cause_asset: str | None
    cause_fault: str | None
    why: str = Field(description="One line: the remaining-life sentence or the refusal")
    # The three quantiles are lifted onto the queue row rather than left in the detail
    # payload, so the dashboard can render a countdown per row without one request per
    # advisory. All three are null together when there is no prediction, and `why`
    # then carries the reason.
    p10: float | None = Field(default=None, description="Days. Pessimistic end.")
    p50: float | None = Field(default=None, description="Days. Plan around this.")
    p90: float | None = Field(default=None, description="Days. Optimistic end.")
    generated_at: datetime


class AdvisoryDetail(BaseModel):
    """The whole advisory, evidence and graph trace included.

    `detail` is passed through as the JSON the advisory layer wrote, rather than
    being re-modelled field by field. That is a deliberate exception to this file's
    own rule: the payload is deeply nested, its shape is already fixed by
    `as_payload` in the advisory layer, and re-declaring forty nested fields here
    would create two contracts to keep in step instead of one. The keys are
    documented at that function.
    """

    advisory_id: str
    asset_id: str
    fault_id: str
    status: str
    generated_at: datetime
    window_from: datetime
    window_to: datetime
    detail: dict


class SiteSummary(BaseModel):
    """The strip along the top of the dashboard."""

    assets: int
    advisories: int
    consequential: int
    unpriced: int
    by_class: dict[str, int]
    worst_health: int | None
    worst_health_asset: str | None
    total_cost_of_inaction_usd: float
    total_effort_usd: float
    horizon_days: float
    generated_at: datetime | None


# ---------------------------------------------------------------------------
# the digital twin
# ---------------------------------------------------------------------------


class TwinPoint(BaseModel):
    """One reading attached to one node of the twin."""

    graph_name: str = Field(
        description="Local name in the semantic model, which is the source CSV column"
    )
    point_id: str | None = Field(
        description=(
            "The database key for this reading, or null where the model declares a "
            "sensor that never became a stored column. Null is a fact about coverage, "
            "not missing data."
        )
    )
    brick_class: str
    name: str | None
    unit_si: str | None


class TwinNode(BaseModel):
    """One piece of equipment, space or water loop in the drawn building."""

    node_id: str
    label: str
    brick_class: str
    asset_id: str | None = Field(
        description=(
            "The database asset this node's readings belong to, or null for nodes "
            "the database does not model as an asset -- the two water loops and the "
            "grouping nodes carry no readings and so map to nothing."
        )
    )
    parent: str | None = Field(
        description="Containing node from brick:hasPart, for nesting the drawing"
    )
    points: list[TwinPoint]


class TwinEdge(BaseModel):
    """One relation between two nodes."""

    from_node: str
    to_node: str
    relation: str = Field(
        description=(
            "feeds = what flows, so the direction a fault travels and the direction "
            "the picture reads. hasPart = containment. Not interchangeable."
        )
    )


class TwinTopology(BaseModel):
    """The shape of the building: every node worth drawing and every edge between them."""

    nodes: list[TwinNode]
    edges: list[TwinEdge]
    node_count: int
    edge_count: int
    point_count: int = Field(
        description="Distinct readings. Matches app.points exactly."
    )
    point_attachments: int = Field(
        description=(
            "How many node-to-reading attachments there are, which is larger than "
            "point_count when one reading belongs to several nodes. The three cooling "
            "towers share one supply temperature setpoint, so it is drawn on all "
            "three and counted once."
        )
    )


class TwinPointState(BaseModel):
    """What one reading was doing at one moment."""

    point_id: str
    value: float | None
    at: datetime | None = Field(
        description="Bucket the value came from. Null when nothing was reported."
    )
    observed: float | None = Field(
        description=(
            "The raw sample the residual was computed from. Carried next to expected "
            "and residual because those three must agree with each other: `value` "
            "above is an HOURLY AVERAGE from the rollup and is a different number at "
            "a different instant, so subtracting expected from it gives a third "
            "answer that is not the residual. Subtract from this one."
        )
    )
    residual_at: datetime | None = Field(
        description="Instant the residual triple belongs to, which is not `at`"
    )
    expected: float | None = Field(
        description=(
            "What the fitted baseline said this reading should be under the "
            "conditions of that moment. Null for the great majority of points: only "
            "the ones a baseline was fitted for carry an expectation."
        )
    )
    residual: float | None
    sigma: float | None = Field(
        description=(
            "Residual in units of the baseline's own residual spread -- the number "
            "to colour a node by. Null wherever expected is null."
        )
    )
    baseline_id: str | None


class TwinAssetState(BaseModel):
    """Condition and prognosis for one machine at one moment."""

    asset_id: str
    health: int | None
    weakest_mode: str | None
    health_at: datetime | None
    rul_mode: str | None = Field(
        description="The mode predicted to fail soonest, which is the one shown"
    )
    rul_p10: float | None
    rul_p50: float | None
    rul_p90: float | None
    rul_as_of: datetime | None
    open_advisories: int


class TwinState(BaseModel):
    """Every live number the twin needs for one moment, in one response."""

    as_of: datetime
    advisory_vintage: datetime | None = Field(
        description=(
            "Which day's advisory queue these counts come from -- the most recent "
            "queue computed at or before as_of. Null when none had been computed yet."
        )
    )
    points: dict[str, TwinPointState]
    assets: dict[str, TwinAssetState]
    points_reporting: int
    points_with_baseline: int = Field(
        description=(
            "How many of the reporting points carry a modelled expectation. This is "
            "much smaller than points_reporting and the gap is real: baselines were "
            "fitted only where a residual drives a detection rule."
        )
    )
    stale_after_hours: float


class EraSummary(BaseModel):
    """One run of the building, and what the clock can reach inside it."""

    era: int = Field(description="Calendar year, which is one run in this database")
    t_from: datetime
    t_to: datetime
    days: int
    assets: list[str] = Field(description="Machines with a scored history in this run")
    queue_days: int = Field(
        description=(
            "How many days inside the run have an advisory queue computed. Fewer than "
            "`days` is normal and is not a gap: a day on which nothing was open "
            "produces no rows, and an empty queue is what a healthy building looks like."
        )
    )


class ClockRange(BaseModel):
    """Everywhere the clock is allowed to stand."""

    eras: list[EraSummary]
    t_from: datetime
    t_to: datetime


class TraceStage(BaseModel):
    """One narrowing in the detection pipeline, and everything that did not get through."""

    ordinal: int
    stage: str
    unit: str = Field(
        description=(
            "What is being counted, and it changes six times down the ten stages: "
            "readings, instants, rule evaluations, firings, points, failure modes, "
            "findings. A drawing that ran one bar smoothly into the next would be "
            "claiming 292,000 readings become 2 findings by attrition. They do not — "
            "they become 2 findings by being aggregated into a different kind of thing."
        )
    )
    entered: int
    passed: int
    dropped: dict[str, int] = Field(
        description="Reason to count, in the engine's own words, for everything that did not pass"
    )
    detail: dict = Field(description="Stage-specific evidence: which rules, which modes, which faults")


class MachineTrace(BaseModel):
    """What the pipeline did on one machine on one day."""

    asset_id: str
    as_of: datetime
    stages: list[TraceStage]
    clean: list[TraceStage] | None = Field(
        default=None,
        description=(
            "The same machine on the same day of the year in the fault-free run, when "
            "one exists. Every run reads the same source year shifted by whole years, "
            "so this is the same weather and the same occupancy with nothing wrong — "
            "which is what makes the two funnels comparable rather than merely adjacent."
        ),
    )
    clean_as_of: datetime | None = None
