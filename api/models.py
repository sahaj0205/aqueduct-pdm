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
