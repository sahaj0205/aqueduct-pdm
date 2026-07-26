# Domain Notes

For a reader who knows software and does not know buildings.

Everything in this project rests on six pieces of physics. If those six make sense, every
threshold, every rule and every residual in the codebase follows from them. Each section
below gives the plain-language version first and the technical version second; you can stop
after the first paragraph of each and still read the rest of the repository.

Part 2 is the provenance: where every fault signature in this project came from, which
published source defined it, and — where a source and this building disagree — which one
won and why.

---

## Part 1 — What this equipment is

### The building, in one paragraph

One commercial building with two pieces of plant. A **chiller plant** makes cold water. An
**air handling unit** blows air over a coil full of that cold water and pushes the chilled
air to the occupied rooms. The cold water travels between them in the **chilled water
loop**, and that pipe is the reason this project can do cross-asset diagnosis at all: a
symptom seen at the air handler can be traced upstream to the machine that supplies it.
Heat taken out of the building has to go somewhere, so the chiller dumps it into a second
water loop that runs to **cooling towers** on the roof, which throw it away by evaporating
water into the outside air.

The building has 107 measured points across 8 assets: 30 on the air handler, 29 on the
chilled water plant, 9 on each of three chillers, 7 on each of three cooling towers.

### What an air handling unit does

**Plainly.** It is a big metal box containing a fan, some filters, and two radiators. It
takes some air from outside and some air sucked back out of the building, mixes them,
cleans the mixture, makes it colder or warmer, and blows it down ducts into the rooms. The
number it is trying to hit is the temperature of the air leaving it — the *supply air
temperature*. Almost every air-side fault in this project is some version of "it cannot hit
that number, or it is hitting it the expensive way".

**Technically.** Outdoor air and return air meet at a mixing box, in a ratio set by two
modulating dampers that move in opposition — as the outdoor damper opens, the return damper
closes. The mixture passes a filter bank, then a heating coil, then a cooling coil fed with
chilled water through a modulating valve. A supply fan pushes the conditioned air into a
duct held at a static pressure setpoint, and variable-air-volume (VAV) terminal boxes at
each zone throttle their own branch to hold that zone's temperature. So there are three
control loops that matter: mixed-air (the dampers), supply-air temperature (the coil
valves), and duct static pressure (the fan speed).

Two consequences the code depends on. First, **the correct behaviour of the unit depends on
which mode it is in** — heating, cooling with outdoor air, cooling with mechanical cooling,
or unoccupied — so a rule that is right in one mode is wrong in another, and every rule in
`analytics/rules/apar.py` is gated on the detected mode. Second, the supply fan adds real
heat to the air it moves, a few tenths of a kelvin, which is why the energy-balance rule
subtracts a fan-heat term rather than expecting supply air to equal mixed air exactly.

### What a chiller does

**Plainly.** A chiller is a machine that makes cold water, and it works the same way a
fridge does. It is a heat pump: it cannot destroy heat, only move it. It takes heat out of
the water going to the building and puts that heat into a different loop of water going to
the roof. It costs electricity to move heat *uphill* — from something cold to something
warm — and the further uphill it has to go, the more electricity it takes.

**Technically.** A vapour-compression cycle with four parts.

- **Evaporator.** Chilled water from the building enters warm, refrigerant boils at low
  pressure taking heat out of it, and the water leaves cold. This plant does not hold a
  fixed supply temperature: it **resets** the setpoint between about 6.7 °C and 12.2 °C
  depending on the load, averaging 9.3 °C over a summer. That is standard practice — a
  warmer setpoint is cheaper to make, so you only ask for cold water when you need it — and
  it is why the capacity rule compares supply temperature against the plant's *current*
  setpoint rather than against a constant.
- **Compressor.** Raises the refrigerant's pressure, which raises the temperature at which
  it will condense. This is the part that consumes electricity, and it is the only part
  that does.
- **Condenser.** The now-hot high-pressure refrigerant gives its heat up to the *condenser
  water* loop and condenses back to liquid.
- **Expansion device.** Drops the pressure back down, and round again.

The condenser water then goes to a **cooling tower**, which sprays it over a fill medium in
a fan-driven airstream. Some of it evaporates, and evaporation is what actually carries the
heat away. That is why a tower's performance is limited by the outdoor **wet-bulb**
temperature — how cold you could get something by evaporating water into today's air —
rather than by the ordinary dry-bulb temperature on a thermometer.

Three chillers share the loops in this plant, and one of them runs about one percent of the
year — it is a standby machine. That fact matters to the validation harness: an idle chiller
is not a chiller correctly found healthy.

### What an economizer is

**Plainly.** When it is cold outside, you do not need a chiller to make cold air. You can
just open a damper and let the outside in. That is an economizer, and it is called *free
cooling* because the only energy it costs is fan power. Getting it wrong is one of the most
common and most expensive faults in commercial buildings, because a damper stuck in the
wrong position wastes energy continuously without anybody being uncomfortable enough to
complain.

**Technically.** An economizer is a control sequence, not a piece of hardware. Above a
changeover condition it holds the outdoor air damper at the **minimum position** required
for ventilation — enough fresh air for the occupants and no more, because everything beyond
that has to be cooled. Below the changeover it modulates the damper open to use outdoor air
as the cooling source, and only brings the chilled water valve in when outdoor air alone
cannot hold the supply air setpoint. Changeover can be on dry-bulb temperature or on
enthalpy (total heat content including humidity), which matters in humid climates because
cool wet air can carry more heat than warm dry air.

The mode structure this creates is exactly what the APAR rule set is organised around, and
it is why three of the six rules implemented here are about the damper and the mixed-air
temperature rather than about the coil.

### What approach temperature means

**Plainly.** In a heat exchanger, heat only moves if there is a temperature difference. The
approach is that difference: how much hotter the refrigerant has to be than the water it is
trying to dump heat into. When a heat exchanger gets dirty, heat moves less easily, so the
machine has to push a *bigger* temperature difference to shift the same heat. A rising
approach is the classic fingerprint of a fouling heat exchanger, which is why it is the
first thing a chiller diagnostic normally looks at.

**Technically.** Condenser approach is the saturated condensing temperature minus the
leaving condenser water temperature; evaporator approach is the leaving chilled water
temperature minus the saturated evaporating temperature. Both grow as the effective
heat-transfer coefficient times area (`UA`) degrades.

**And this project cannot compute either of them.** This is the single largest concession
the codebase makes to its data, and it is worth understanding because it explains why the
chiller rules look unlike a textbook's.

The LBNL chiller plant publishes 78 columns and every one of them is water-side or
air-side. There is no refrigerant pressure and no saturation temperature anywhere, so the
approach cannot be measured. It cannot be recovered either. Each heat exchanger gives one
equation, `Q = UA × LMTD`, in two unknowns — `UA` and the saturation temperature — and the
water side supplies no second equation, because `Q = ṁ × cp × ΔT` is an identity rather than
new information. Assuming a design `UA` and solving looks like a way out and is not: the
algebra collapses to a fixed function of the measured water temperatures, so the resulting
"approach" cannot move in response to the fault it was written to catch, because fouling
changes the real `UA` that the assumption has already pinned.

So the two approach rules a textbook would write are replaced by the same two failure modes
expressed in quantities this plant actually measures: a **condenser-side leaving-water
temperature residual** against a fitted heat-rejection baseline, and an **evaporator-side
capacity check** — is the chilled water above setpoint while the compressor has nothing left
to give. The physics being tested is identical. Only the observable changed.

### Why kW/ton must be compared at matched lift and part-load ratio

**Plainly.** The same healthy chiller uses wildly different amounts of electricity per unit
of cooling depending on how hard the day is. Comparing today's efficiency against
yesterday's therefore tells you mostly about the weather. If you set a fixed efficiency
limit, it fires on every hot afternoon and misses every failing machine on a mild morning.
This is the single most common way chiller fault detection is done badly, and avoiding it is
what most of `analytics/baselines/` exists for.

**Technically.** A **ton** of refrigeration is 3,516.85 watts of cooling — the rate that
would freeze a short ton of ice in a day, which is where the name comes from. **kW/ton** is
electrical power in divided by cooling power out, so lower is better, and it is the inverse
of the dimensionless coefficient of performance.

Two operating variables dominate it.

**Lift** is the temperature gap the compressor has to push against — roughly the condensing
temperature minus the evaporating temperature. Compressor work rises with lift, so a hot
afternoon with warm condenser water is intrinsically less efficient than a mild morning at
the same load. Nothing is wrong with the machine.

**Part-load ratio** is the current cooling load as a fraction of the machine's capacity.
Efficiency is not monotonic in it: at very low load the fixed parasitic losses and the
surge-avoidance margins dominate and kW/ton is poor, efficiency is usually best somewhere
around 70–90% load, and it falls off slightly at 100%. So "half loaded" is not "half as
efficient" in either direction.

The consequence for this codebase is that **every chiller efficiency judgement is a residual,
never a level**. A baseline is fitted on fault-free operation with lift and load as its
drivers, and the rule compares measured power against what that model says this machine
should draw *at this instant's lift and this instant's load*. What is left over is the part
the operating conditions do not explain.

The recorded numbers make the point concretely. This machine was commissioned at
**1.3402 kW/ton** averaged over its first three weeks, but the same healthy machine runs
about 1.2 kW/ton on a mild morning and 1.9 on a hot afternoon. An absolute limit set
anywhere between those two is wrong half the time. The failure threshold in
`app.failure_modes` is therefore **+0.536 kW/ton of excess over the condition-matched
baseline** — 40% of the commissioned value, which is the conventional point at which the
annual energy penalty exceeds the cost of an overhaul.

Below 20 tons of load, the rules stop evaluating entirely: every per-ton quantity is
dominated by dividing through a small number. That is about an eighth of this machine's
capacity, and it discards 3% of the running samples in the fault-free year.

### What condenser fouling physically is

**Plainly.** The inside of the condenser tubes furs up, exactly like the element of a
kettle. Once there is a layer of scale and slime between the refrigerant and the water,
heat cannot get across as easily. The machine compensates by running hotter, running hotter
costs more electricity, and eventually it cannot make enough cold water at all. It is the
most common chiller fault, it is gradual, and it is completely reversible with a brush —
which makes it the ideal fault for predictive maintenance. You want to be told a month
early, not on the day.

**Technically.** Three things accumulate on the water side of the condenser tubes.
**Scale** — dissolved calcium and magnesium salts precipitating out onto the hottest surface
in the loop, because their solubility falls as temperature rises. **Biofilm** — microbial
growth, which an open cooling-tower loop is ideal for: warm, aerated, and continuously
inoculated with whatever the tower washes out of the outdoor air. **Silt** — the same
mechanism, particulate rather than biological.

The effect is a fall in `UA`. Rejecting the same heat now needs a higher condensing
temperature, which raises lift, which raises compressor work — this project's threshold
rationale uses the standard figure of about **2.5% more compressor power per kelvin** of
extra lift. So the first symptom is an energy penalty, not a comfort complaint. Capacity
loss comes later, when the compressor reaches its limit and the machine can no longer hold
its chilled water setpoint on a design day.

**One naming trap, because it has bitten this project once.** LBNL and ASHRAE both express
fouling severity as **percent heat transfer retained**. So `095` is the *mild* case and
`065` is the *severe* one, and sorting the severity files numerically runs the trajectory
backwards from broken to healthy. The scenario manifests carry a comment saying so in
capitals.

The threshold here is **3.0 K of excess leaving condenser water** at matched load and
matched entering water. That is roughly a 7–9% compressor power penalty, which is the point
at which a tube-brush cleaning pays for itself inside one cooling season — and it is seven
times the 0.42 K spread of the fitted baseline, so it cannot be reached by scatter.

---

## Part 2 — Where every fault signature comes from

Four published sources, plus one ASHRAE guideline used for a single control tolerance.

| source | what this project takes from it | public? |
|:---|:---|:---|
| **ASHRAE RP-1043** | The chiller fault taxonomy — which faults a centrifugal chiller has, and the convention of grading each at four severities. | No. Purchasable from ASHRAE. |
| **LBNL Fault Detection and Diagnostics Datasets** | All of the data, and the air-side fault set. Produced by a consortium of LBNL, PNNL, NREL, ORNL and Drexel. | Yes. |
| **NIST APAR** — House, Vaezi-Nejad & Whitcomb 2001; Schein, Bushby, Castro & House 2006 | The air-side rules: 28 expert rules derived from mass and energy balances, of which this project implements 6. | Yes. |
| **Brick Schema** | The semantic model — equipment classes, point classes, and the `feeds` topology every traversal walks. | Yes. |
| ASHRAE Guideline 36 | One number: the ±1.1 K supply-air control tolerance, used to justify the coil leak-by threshold. | No. Purchasable. |

### ASHRAE RP-1043 — the chiller fault taxonomy

RP-1043 is the ASHRAE research project that established the standard fault set for
vapour-compression chiller diagnostics. It instrumented a **90-ton centrifugal chiller** and
ran **seven faults**, each at **four severity levels**:

1. condenser fouling
2. non-condensable gas in the refrigerant
3. reduced condenser water flow
4. reduced evaporator water flow
5. excess oil
6. refrigerant overcharge
7. refrigerant leak

**It is not a public dataset.** It is available for purchase from ASHRAE, and this project
has not bought it. **It is cited here strictly as the taxonomy reference** — the authority
for *which faults a chiller has* and for the four-severity grading convention that the
trajectory synthesiser in `simulator/` imitates. No RP-1043 measurement appears anywhere in
this repository, and no accuracy number is computed against it.

Two honest consequences of citing a taxonomy you do not hold the data for.

**The taxonomy and the available data do not overlap perfectly.** The LBNL chiller plant
ships 23 fault runs — bypass valve leakage and stuck, chiller temperature bias, chiller
fouling, cooling tower bias, cooling tower fouling, cooling tower mistuned control, and
secondary loop pressure bias. Of RP-1043's seven, only **condenser fouling** has a
corresponding LBNL run. Non-condensable gas and refrigerant leak are not in the LBNL data at
all.

**One failure mode is declared from the taxonomy and never exercised.**
`chiller-refrigerant-loss` exists in `app.failure_modes` because refrigerant leak is in the
taxonomy and it is a real prognostic concern. Its indicator is computable — chilled water
temperature above the plant setpoint, measured only at full compressor command — and it
produces **no health number in this building at all**, because its validity gate leaves too
few samples inside the three-week commissioning window to establish a healthy baseline.
Rather than assume the baseline is zero, the health layer declines and reports the mode as
unscored. Asserting a baseline it does not have is how the clean chiller once came out at 68
on a mode whose reference window held six days.

**And this plant is not RP-1043's machine.** The taxonomy is transferable; the numbers are
not. Every threshold in this project is justified against *this* building's own
commissioning data, with the justification recorded in the database beside it.

### LBNL Fault Detection and Diagnostics Datasets — the data and the air-side faults

Every measurement in this project comes from here. Two of the published systems are used:
the **single-duct VAV air handling unit** and the **chiller plant**. Each ships CSVs at
several fault severities plus a fault-free reference run, and a Brick `.ttl` semantic model
of the equipment.

Using third-party labelled data rather than a self-built simulator is the reason any
accuracy figure this project reports means anything: the labels were created by somebody
else. The one thing this project synthesised is the *trajectory between* the measured
severity levels, because no public run-to-failure dataset exists for building HVAC. That
distinction is stated at the top of `VALIDATION.md` and argued in `AI_LOG.md` D-02 and D-03.

### NIST APAR — the air-side rules

APAR (Air-handling unit Performance Assessment Rules) is a set of **28 expert rules derived
from mass and energy balances**, published by NIST — House, Vaezi-Nejad and Whitcomb in
2001, extended and field-tested by Schein, Bushby, Castro and House in 2006. Each rule is an
inequality that must hold if the unit is working, organised by operating mode, and each is
derived rather than fitted: they come from conservation of mass and energy across the mixing
box and the coils, not from training on fault data.

This project implements **6 of the 28**, keeping APAR's own rule numbering so they can be
looked up in the source:

| rule | what it asserts must hold |
|:---|:---|
| `apar-6` | Supply air is not warmer than return air while economizing. |
| `apar-7` | With both coils shut, supply air equals mixed air plus fan heat. |
| `apar-16` | Air does not leave the cooling coil warmer than it entered. |
| `apar-18` | Outdoor air fraction is the minimum the unit should be holding. |
| `apar-20` | The cooling coil valve is not fully open and stuck there. |
| `apar-27` | Mixed air is not hotter than both the return and outdoor air feeding it. |

The other 22 need points this building does not publish, or cover modes these runs do not
enter.

### Brick Schema — the semantic model

Brick is an open ontology for building metadata: an RDF vocabulary of equipment classes,
point classes, and relationships such as `feeds`, `hasPart` and `hasPoint`. This project
uses it for three things that would otherwise each need bespoke code — dispatching rules
onto assets by class, resolving `brick:AHU` and `brick:Air_Handling_Unit` as the same thing
through the published class hierarchy, and walking the chilled water loop upstream with a
transitive SPARQL query. Brick 1.3's class hierarchy is vendored into `model/` because every
dispatch in the system resolves through it. Rejected alternatives are in `AI_LOG.md` D-04.

### Every failure mode and rule, mapped to its source

The **degradation modes** — the things that wear out, each with a threshold and a written
justification stored in `app.failure_modes`:

| mode | class | threshold | taxonomy source | threshold justified by | exercised? |
|:---|:---|:---|:---|:---|:---|
| `chiller-condenser-fouling` | Chiller | 3.0 K excess leaving condenser water | RP-1043, fault 1 | 2.5%/K compressor penalty → 7–9% at 3 K, pays back a tube brushing in one season; also 7× the 0.42 K baseline spread | yes — LBNL `chiller_fouling` runs |
| `chiller-efficiency-loss` | Chiller | +0.536 kW/ton over baseline | RP-1043, general degradation | 40% over the commissioned 1.3402 kW/ton, the conventional economic-overhaul trigger | yes |
| `chiller-refrigerant-loss` | Chiller | 2.0 K above setpoint at full command | RP-1043, fault 7 | fault-free full-command operation sits 0.22 K above setpoint, 99th percentile 1.505 K | **no** — not in the LBNL data, and no usable commissioning reference |
| `coil-valve-leak-by` | AHU | 2.8 K depression with valve shut | LBNL `coi_leakage` | 2.8 K (5 °F) over 5.0 m³/s ≈ 17 kW of unwanted cooling, paid twice; 2.5× the ±1.1 K tolerance in ASHRAE Guideline 36 | yes |
| `fan-bearing-degradation` | AHU | 88.9 W excess at matched speed and flow | **this project** — general rotating-machinery wear, not in either published fault set | 15% of the commissioned 592.4 W, the NEMA 1.15 service factor — past it the motor is outside its own rating | fires on all three faulted AHU runs, on neither fault-free one |
| `filter-loading` | AHU | 250 Pa | standard practice | 250 Pa (1.0 in w.g.) final-pressure change-out for a MERV 13 bank | **no — not computable.** No filter differential pressure exists in either dataset, and there is no filter in the simulation to load. |

The **rules** — instantaneous assertions rather than wear models:

| rule | class | source |
|:---|:---|:---|
| `apar-6`, `apar-7`, `apar-16`, `apar-18`, `apar-20`, `apar-27` | AHU | NIST APAR, House et al. 2001 / Schein et al. 2006, original numbering |
| `chiller-kw-per-ton-residual` | Chiller | RP-1043 taxonomy, re-expressed as a residual against a fitted baseline because raw kW/ton is condition-dominated |
| `chiller-excess-lift` | Chiller | RP-1043 taxonomy; stands in for condenser approach, which this plant cannot measure |
| `chiller-capacity-shortfall` | Chiller | RP-1043 taxonomy; stands in for evaporator approach, same reason |

The **injected scenarios** the validation harness scores against, and the LBNL files each is
built from:

| scenario | LBNL source files | severities used |
|:---|:---|:---|
| `ahu_cooling_valve_leakage` | `coi_leakage_010_annual.csv` | 1 (all four published files are byte-identical) |
| `ahu_sat_sensor_drift` | `coi_bias_2_annual.csv`, `coi_bias_4_annual.csv` | 2 |
| `ahu_oa_damper_stuck` | `damper_stuck_010/025/075_annual.csv` | 3, applied as a step |
| `chiller_condenser_fouling` | `ChillerPlant_chiller_fouling_095/065.csv` | 2 |
| `chiller_bypass_valve_leakage` | `ChillerPlant_bypass_leakage_025/050/075.csv` | 3 |
| `cooling_tower_fouling` | `ChillerPlant_coolingtower_fouling_095/080/065.csv` | 3 — **held out** |

### No rule is written for non-condensable gas

> No rule is written for non-condensable gas. It is reserved to demonstrate that
> unsupervised detection catches faults the rule library does not cover.

Three things have to be said next to that, because the instruction and the available data
do not line up, and the same qualification is recorded in `analytics/rules/chiller.py` where
the rules themselves live.

**Non-condensable gas is in RP-1043's taxonomy and is not in the LBNL data.** The LBNL
chiller plant ships 23 fault runs and none of them injects non-condensable gas; neither does
any of them inject a refrigerant leak. So there is no run on which a non-condensable-gas
detector could be demonstrated either succeeding or failing.

**The fault this project actually holds out is cooling tower fouling**, chosen in checkpoint
2.4 precisely because it *is* in the data. The held-out property is honoured against it
literally: no rule in this project references a cooling tower point, a tower approach
temperature, or the wet-bulb temperature, and none can fire on tower fouling except through
its second-order effect on chiller efficiency. `VALIDATION.md` section 4 confirms **zero
rule firings** on the tower run.

**And the held-out fault was not detected.** Two degradation findings do appear on the tower
run, and the tempting reading is that the trending layer caught what the rules could not.
The harness tests that reading and it fails: both findings also appear on a run with no
fault injected at all, on the same machines, on the same day of the year. So the tower
fouling was missed, and the demonstration the instruction above asks for is still
outstanding. It is what the unsupervised layer in Task 8 exists to attempt.

Physically, for completeness: non-condensable gas is air or nitrogen that has leaked into a
refrigerant circuit running below atmospheric pressure. It collects in the condenser, where
it occupies surface area that refrigerant should be condensing on and adds its own partial
pressure to the total. Both effects push condensing pressure up, so the signature closely
resembles condenser fouling — a rising condenser approach and rising kW/ton — which is
exactly why discriminating the two is a hard diagnostic problem and why RP-1043 measured
them separately.

---

## Part 3 — Glossary

Terms used across this project's documents and code, defined once.

| term | meaning |
|:---|:---|
| **AHU** | Air handling unit. The box of fans and coils that conditions air. |
| **approach temperature** | The temperature gap a heat exchanger needs to move its heat. Rises as the exchanger fouls. Not measurable in this plant. |
| **changepoint detection** | Deciding *when* a statistical property of a series changed. Here a cumulative-sum (CUSUM) test that accumulates deviation from the commissioning mean and declares an onset when the running total crosses a decision interval. |
| **CHW / CDW** | Chilled water (to the building) and condenser water (to the towers). |
| **commissioning window** | Three weeks at the start of a run that the operator asserts was healthy. Every baseline and every health score is measured against it. |
| **dry-bulb / wet-bulb** | Ordinary air temperature; and the temperature you could reach by evaporating water into that air. A cooling tower's floor is the wet-bulb. |
| **economizer** | Cooling with outdoor air instead of the chiller. |
| **EWMA** | Exponentially weighted moving average — a smoother that weights recent samples more heavily, used on rule inputs and reset at each mode switch. |
| **first-passage time** | For a drifting random process, the time at which it first crosses a fixed level. This is what the remaining-life estimate is: the distribution of when the degradation indicator first reaches its failure threshold. |
| **isotonic regression** | Fitting the closest never-increasing (or never-decreasing) version of a wobbly series. Used to enforce that health can flatten but not climb, rather than crudely clamping each point to the one before it. |
| **kW/ton** | Electrical power in per unit of cooling out. Lower is better. Must be compared at matched lift and load. |
| **lift** | The temperature gap the compressor works across — condensing minus evaporating temperature. |
| **LMTD** | Log-mean temperature difference, the correct average driving temperature across a heat exchanger. |
| **MERV** | Filter efficiency rating. MERV 13 is a typical commercial final filter. |
| **part-load ratio (PLR)** | Current load as a fraction of rated capacity. Efficiency is not monotonic in it. |
| **residual** | Observed minus expected, where expected comes from a model fitted at the current operating conditions. Nearly every number this project judges is a residual. |
| **SAT / MAT / RAT / OAT** | Supply, mixed, return and outdoor air temperature. |
| **static pressure** | Duct pressure the supply fan holds so the VAV boxes have something to throttle. |
| **ton (of refrigeration)** | 3,516.85 W of cooling. |
| **VAV** | Variable air volume. Terminal boxes that vary airflow per zone rather than varying its temperature. |
| **Wiener process** | A continuous random walk with a constant drift rate. The degradation model here: the indicator drifts toward its threshold at an uncertain rate, and the belief about that rate tightens as days accumulate. |

---

## Where to read next

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how the layers fit together, and every rejected
  alternative.
- [`VALIDATION.md`](VALIDATION.md) — how well it works, regenerated from the database on
  every run.
- [`AI_LOG.md`](AI_LOG.md) — the nine decisions the system rests on, with what happened
  after each was made.
