# Aqueduct PDM — Project Context

## Summary

A predictive maintenance platform for building HVAC equipment. It ingests
labelled HVAC fault data, models the equipment semantically, detects faults
using physics-derived rules, tracks degradation, and predicts remaining useful
life with calibrated confidence intervals.

## Scope

One commercial building, two equipment classes:

- **A single-duct VAV air handling unit (AHU).** An air handler that
  conditions air and pushes it to variable-air-volume terminal boxes serving
  the occupied spaces.
- **A water-cooled chiller plant.** The machine that makes the cold water,
  rejecting its heat to a cooling tower.

The two are connected by a **chilled water (CHW) loop**: the chiller feeds the
AHU's cooling coil. That CHW loop edge is the reason cross-asset root cause
analysis is possible at all — a symptom observed at the air handler (for
example, the coil failing to hit its supply air temperature setpoint) can be
traced upstream to the chiller that supplies it, rather than being written up
as an AHU fault. Without a modelled connection between the two assets, every
diagnosis stops at the boundary of a single machine.

## Data source

**LBNL Fault Detection and Diagnostics Datasets** — public, produced by a
consortium of LBNL, PNNL, NREL, ORNL and Drexel.

We use two of the published systems:

- the **single-duct AHU**, and
- the **chiller plant**.

Each system ships:

- CSVs at multiple **fault severity levels**, plus a **fault-free** baseline
  case, and
- a **Brick Schema `.ttl` semantic model** describing the equipment, its
  points, and how they relate.

Using third-party labelled data rather than a self-built simulator means every
accuracy number this project reports is computed against labels the project did
not create. See `AI_LOG.md`, entry D-02.

## Layer order

Data flows through the platform in this order. Each layer consumes the one
above it.

1. **ingest** — read the source CSVs into the time-series database
2. **quality scoring** — score and flag each measurement for trustworthiness
3. **semantic graph** — the Brick model of assets, points, and the CHW loop
4. **rule engine** — physics-derived fault rules evaluated over the data
5. **condition-normalised baselines** — what "normal" looks like given the
   current operating conditions
6. **health index** — a single degradation number per asset over time
7. **RUL estimation** — remaining useful life, with confidence intervals
8. **cross-asset diagnosis** — root cause traced across the CHW loop edge
9. **advisories** — the recommended action for a human
10. **API** — serves all of the above
11. **UI** — presents it

## Directory layout

```
model/                  semantic model — Brick graph and asset definitions
ingestion/              dataset loaders and their manifests
analytics/              the analytics layers, in the order listed above
  quality/              measurement quality scoring
  rules/                physics-derived fault rules
  baselines/            condition-normalised expected behaviour
  health/               health index
  rul/                  remaining useful life estimation
  diagnosis/            cross-asset root cause analysis
api/                    FastAPI service
web/                    React + TypeScript + Vite frontend
validation/             accuracy measurement against ground-truth labels
data/                   datasets (data/raw/ is gitignored)
scripts/                database schema and operational scripts
docs/                   implementation notes and architecture
```

`analytics/` was called `platform/` until checkpoint 3.1. It had to be renamed:
`platform` is a Python standard library module, so a top-level package of that
name shadows it, and importing pandas — which calls
`platform.python_implementation()` at import time — fails outright. Anything
that refers to `platform/...` means `analytics/...`.
