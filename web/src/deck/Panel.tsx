/**
 * The drawer: the evidence behind a claim on a slide.
 *
 * WHY DEPTH LIVES HERE AND NOT ON SLIDES. Nine rules, five baselines, eight scenarios, six
 * failure modes, five quality checks and six validation numbers is thirty-nine things worth
 * being able to show, and not one of them is worth a slide of its own. On the surface they
 * make a deck nobody sits through; behind a click they cost nothing until the room asks,
 * and then they answer completely.
 *
 * ONE COMPONENT RENDERS ALL OF THEM, tagged by kind, for the same reason one component
 * renders every slide: a room learns to read a drawer once and then knows what to expect
 * from the next one.
 *
 * EVERYTHING HERE IS FROM THE CATALOGUE, which came from the repository and the database.
 * A drawer is opened when somebody has decided not to take the slide's word for it, so it
 * is the last place in the deck that could survive an invented number.
 */

import {
  BLEND,
  INVENTORY,
  MODES,
  ONSET,
  QUALITY,
  REFUSALS,
  RULE_ENGINE,
  assetById,
  baselineById,
  checkById,
  metricById,
  modeById,
  ruleById,
  scenarioById,
} from "./catalogue.ts";
import type { PanelKind, PanelRef } from "./deck.ts";
import styles from "./Panel.module.css";

/* -------------------------------------------------------------- shared building blocks */

/** A labelled value. The workhorse of every drawer. */
function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className={styles.row}>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}

function Prose({ children }: { children: React.ReactNode }) {
  return <p className={styles.prose}>{children}</p>;
}

/** A block set apart, for the one thing in a drawer that is easy to get wrong. */
function Note({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.note}>
      <span className={styles.noteLabel}>{label}</span>
      <span>{children}</span>
    </div>
  );
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

/* --------------------------------------------------------------------- the drawers */

/** Every ground truth set for one scenario, exactly as the manifest and the answer key hold it. */
function ScenarioBody({ id }: { id: string }) {
  const s = scenarioById(id);
  if (!s) return <Prose>No scenario with that identifier.</Prose>;
  const clean = s.faultMode === "none";
  return (
    <>
      <Prose>{s.description}</Prose>
      <dl className={styles.rows}>
        <Row k="machine" v={s.asset} />
        <Row k="fault injected" v={clean ? "none — this is a control run" : s.faultMode} />
        <Row k="shape" v={s.profile === "progressive" ? "progressive — climbs to failure" : s.profile === "step" ? "step — jumps at onset" : "none"} />
      </dl>

      <div className={styles.truthBlock}>
        <span className={styles.truthLabel}>ground truth — hidden from the pipeline</span>
        <dl className={styles.rows}>
          <Row k="onset" v={clean ? "no fault begins" : day(s.onset)} />
          <Row k="fully degraded" v={s.failure && !clean ? day(s.failure) : "—"} />
          <Row k="days to failure" v={clean ? "—" : s.daysToFailure === 0 ? "0 — a step, not a slide" : `${s.daysToFailure}`} />
          <Row k="healthy days before onset" v={`${s.preOnsetDays}`} />
          <Row k="total window" v={`${s.spanDays} days`} />
        </dl>
      </div>

      <dl className={styles.rows}>
        <Row k="source window read" v={`${s.sourceStart}, from the 2018 record`} />
        <Row k="source file" v={<code>{s.sourceFile}</code>} />
        <Row k="degradation measured on" v={<code>{s.indicator}</code>} />
        <Row k="seed" v={<code>{s.seed}</code>} />
      </dl>

      {s.ladder.length > 0 && (
        <>
          <span className={styles.subhead}>severity rungs available, mildest first</span>
          <ul className={styles.list}>
            {s.ladder.map((r) => (
              <li key={r.file}>
                <strong>{r.label}</strong>
                <br />
                <code>{r.file}</code>
              </li>
            ))}
          </ul>
        </>
      )}

      <Note label="why the seed matters">
        The rate of decline is drawn from it, so this manifest rebuilds byte-identical data
        every time. A scenario nobody can reproduce cannot be an answer key.
      </Note>
    </>
  );
}

/** One machine: what it is, what it costs, what is measured on it, and how it fails. */
function AssetBody({ id }: { id: string }) {
  const a = assetById(id);
  if (!a) return <Prose>No machine with that identifier.</Prose>;
  const modes = MODES.filter(
    (m) => m.brickClass === a.brickClass || (a.brickClass === "brick:AHU" && m.brickClass === "brick:Air_Handling_Unit"),
  );
  const points = a.id === "chiller-1" ? INVENTORY.points : [];
  const fixes = INVENTORY.interventions.filter((i) => modes.some((m) => m.id === i.fault_id));

  return (
    <>
      <dl className={styles.rows}>
        <Row k="name" v={a.name} />
        <Row k="class" v={<code>{a.brickClass}</code>} />
        <Row k="instruments" v={`${a.points}`} />
        <Row k="replacement cost" v={`$${a.replacementUsd.toLocaleString("en-US")}`} />
      </dl>

      {points.length > 0 && (
        <>
          <span className={styles.subhead}>what is measured</span>
          <ul className={styles.list}>
            {points.map((p) => (
              <li key={p.point_id}>
                {p.name} <span className={styles.dim}>· {p.unit_si}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <span className={styles.subhead}>how it fails</span>
      {modes.length > 0 ? (
        <ul className={styles.list}>
          {modes.map((m) => (
            <li key={m.id}>
              <strong>{m.name}</strong> — fails at {m.threshold} {m.unit}
              {!m.computable && <span className={styles.dim}> · not computable in this building</span>}
            </li>
          ))}
        </ul>
      ) : (
        /*
         * A real gap, stated rather than left as an empty list. Degradation models exist for
         * chillers and air handlers only; this machine is watched by the rule engine and by
         * the quality layer, but nothing computes a health score or a failure date for it.
         * An empty heading here would read as a rendering fault instead of as the limitation
         * it actually is.
         */
        <Note label="no degradation model">
          No failure mode is defined for this class of equipment, so this machine has no
          health score and no remaining-life estimate. It is still covered by the quality
          checks and by the rule engine, and it can still be named as the cause of a fault
          downstream of it — but nothing here predicts its own failure.
        </Note>
      )}

      {fixes.length > 0 && (
        <>
          <span className={styles.subhead}>what fixing it takes</span>
          <ul className={styles.list}>
            {fixes.map((f, i) => (
              <li key={`${f.fault_id}-${i}`}>
                <strong>{f.hours} hours · ${f.cost} parts</strong>
                <br />
                {f.action}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/** One rule: what it tests, what it reads, why it means anything. */
function RuleBody({ id }: { id: string }) {
  const r = ruleById(id);
  if (!r) return <Prose>No rule with that identifier.</Prose>;
  return (
    <>
      <Prose>{r.why}</Prose>
      <dl className={styles.rows}>
        <Row k="applies to" v={r.appliesTo} />
        <Row k="only in" v={r.mode} />
        <Row k="fires when" v={<code className={styles.test}>{r.test}</code>} />
      </dl>
      <span className={styles.subhead}>reads</span>
      <ul className={styles.list}>
        {r.reads.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      <dl className={styles.rows}>
        <Row k="minimum quality" v={`${RULE_ENGINE.minInputQuality} — below this the rule is not run`} />
        <Row k="must hold for" v={`${RULE_ENGINE.persistenceMinutes} minutes continuously`} />
      </dl>
      {r.nuance && <Note label="the nuance">{r.nuance}</Note>}
    </>
  );
}

/** One quality check: what it asks, over what window, and why that window. */
function CheckBody({ id }: { id: string }) {
  const c = checkById(id);
  if (!c) return <Prose>No check with that identifier.</Prose>;
  return (
    <>
      <Prose>{c.asks}</Prose>
      <dl className={styles.rows}>
        <Row
          k="window"
          v={c.windowMinutes >= 1440 ? `${c.windowMinutes / 60} hours — a full day` : `${c.windowMinutes / 60} hours`}
        />
        <Row k="direction" v="trailing — uses nothing recorded after the instant being scored" />
      </dl>
      <Note label="why that window">{c.why}</Note>
      <Note label="how it combines">
        The composite is the <strong>minimum</strong> of all five, never the mean, and the
        gate is {QUALITY.gate}. A reading that is perfect on four checks and impossible on
        one is not eighty percent trustworthy.
      </Note>
    </>
  );
}

/** One baseline: what it predicts, from what, and where its constants came from. */
function BaselineBody({ id }: { id: string }) {
  const b = baselineById(id);
  if (!b) return <Prose>No baseline with that identifier.</Prose>;
  return (
    <>
      <Prose>{b.why}</Prose>
      <dl className={styles.rows}>
        <Row k="predicts" v={b.targetName} />
        <Row k="point" v={<code>{b.target}</code>} />
        <Row k="applies to" v={b.appliesTo} />
        <Row k="model form" v={<code>{b.form}</code>} />
        <Row k="terms" v={b.terms} />
      </dl>
      <span className={styles.subhead}>driven by</span>
      <ul className={styles.list}>
        {b.drivers.map((d) => (
          <li key={d}>{d}</li>
        ))}
      </ul>
      <Note label="fitted on">
        21 days of commissioning data, when the machine was newly verified as working. The
        constants are frozen after that — refitting later would teach the model that a
        degrading machine is normal.
      </Note>
      {b.nuance && <Note label="the nuance">{b.nuance}</Note>}
    </>
  );
}

/** One failure mode: the threshold, and the argument for it. */
function ModeBody({ id }: { id: string }) {
  const m = modeById(id);
  if (!m) return <Prose>No failure mode with that identifier.</Prose>;
  return (
    <>
      <dl className={styles.rows}>
        <Row k="applies to" v={<code>{m.brickClass}</code>} />
        <Row k="fails at" v={`${m.threshold} ${m.unit} of excess over the fitted baseline`} />
        <Row k="computable here" v={m.computable ? "yes" : "no — the instrument does not exist in this building"} />
      </dl>
      <span className={styles.subhead}>why that threshold and not another</span>
      <Prose>{m.rationale}</Prose>
      <Note label="why this is a required column">
        Health is the distance travelled from commissioning toward this number. If the
        threshold were arbitrary, every health score derived from it would be arbitrary too —
        so the database refuses to store one without a written justification.
      </Note>
    </>
  );
}

/** One validation number: what it means, and how it was arrived at. */
function MetricBody({ id }: { id: string }) {
  const m = metricById(id);
  if (!m) return <Prose>No metric with that identifier.</Prose>;
  return (
    <>
      <div className={`${styles.headline} ${m.verdict === "bad" ? styles.headlineBad : ""}`}>
        {m.value}
      </div>
      <span className={styles.subhead}>what it means</span>
      <Prose>{m.means}</Prose>
      <span className={styles.subhead}>how it was computed</span>
      <Prose>{m.how}</Prose>
      {m.verdict === "bad" && (
        <Note label="reported anyway">
          This number is bad and it is on the slide at its real value. A system that only
          publishes its good numbers cannot be improved, and the whole point of the answer
          key was to make improvement measurable.
        </Note>
      )}
    </>
  );
}

/**
 * The arithmetic, for when the room asks for it and only then.
 *
 * Kept in plain language with the symbols named rather than assumed. Somebody who wants the
 * real derivation is going to read the code, so what belongs here is enough to follow the
 * argument, not enough to reimplement it.
 */
function MathsBody({ id }: { id: string }) {
  switch (id) {
    case "blend-formula":
      return (
        <>
          <span className={styles.subhead}>what is being built</span>
          <Prose>
            A signal that starts at the clean run and ends at the faulted one, passing through
            every intermediate severity — without inventing a single measurement.
          </Prose>
          <code className={styles.block}>{BLEND.contribution}</code>
          <Prose>
            At any instant, the faulted run minus the clean run is what the fault did. Same
            weather, same hour, same control decisions — so everything except the fault
            cancels out of that subtraction.
          </Prose>
          <code className={styles.block}>{BLEND.formula}</code>
          <Prose>
            Progress climbs from 0 at onset to 1 at failure. That fraction of the measured
            contribution is added back onto the clean signal. The output&rsquo;s weather and
            control variation is therefore genuine; only the fault&rsquo;s magnitude is
            interpolated.
          </Prose>
          <Note label="why it can never go backwards">
            The rate of climb is set by {BLEND.rateKnots} multipliers drawn from the
            scenario&rsquo;s seed, each strictly positive, then accumulated. A sum of positive
            numbers can flatten but cannot reverse — which is the one-directional slide the
            remaining-life maths assumes.
          </Note>
        </>
      );

    case "least-squares":
      return (
        <>
          <span className={styles.subhead}>what fitting actually means</span>
          <Prose>
            The equation&rsquo;s shape is fixed by physics. What is unknown is a handful of
            constants — how much this particular machine&rsquo;s power rises per unit of load,
            and so on.
          </Prose>
          <Prose>
            Fitting is: try every possible set of constants, and keep the set that makes the
            equation&rsquo;s predictions come closest to what was actually measured, across all
            21 days at once. Closest means the sum of the squared misses is as small as it can
            be, which has an exact answer rather than needing a search.
          </Prose>
          <Note label="and then frozen">
            Refitting on later data would absorb the degradation into the model. The machine
            would look healthy because the baseline had quietly learned to expect a sick one.
          </Note>
        </>
      );

    case "cusum":
      return (
        <>
          <span className={styles.subhead}>the running total</span>
          <Prose>
            First, work out what normal looks like: the average and the spread of the indicator
            over a reference stretch when the machine was well. Then, each day, take how far
            above that average the day sat, subtract a small allowance, and add whatever is
            left to a running total. Negative days pull it back toward zero, and it never goes
            below zero.
          </Prose>
          <dl className={styles.rows}>
            <Row k="allowance" v={`${ONSET.slackSigma} standard deviations — drift smaller than this is ignored`} />
            <Row k="declares a change at" v={`${ONSET.decisionSigma} standard deviations of accumulated total`} />
            <Row k="minimum reference" v={`${ONSET.minReferenceSamples} days, else it reports undetectable`} />
          </dl>
          <Note label={`why ${ONSET.decisionSigma} and not something tuned`}>
            That value was chosen from its false-alarm property, not from how well it separates
            any scenario here: at this design, a machine that is <em>not</em> degrading produces a
            spurious onset about once every 465 days. Tuning it against the answer key would
            have made the validation meaningless.
          </Note>
          <Note label="two dates, not one">
            The total is slow to declare by construction — it has to accumulate evidence. So the
            crossing is <em>when we knew</em>, and the last time the total sat at zero is{" "}
            <em>when it started</em>. Only the second is reported as the onset.
          </Note>
        </>
      );

    case "first-passage":
      return (
        <>
          <span className={styles.subhead}>what is being predicted</span>
          <Prose>
            Failure is the <em>first moment</em> the indicator touches its threshold — not the
            average level, not the level at some horizon. Equipment that crosses and comes back
            has still crossed, and the maintenance decision was already triggered.
          </Prose>
          <Prose>
            The indicator is treated as drifting upward at some rate with some random jitter
            around it. For that description, the distribution of when it first touches a line
            has an exact formula — no simulation, so the same inputs give the same answer every
            time.
          </Prose>
          <span className={styles.subhead}>where the band comes from</span>
          <Prose>
            The rate itself is not known exactly; it is estimated from the days since onset, so
            it carries its own uncertainty. That uncertainty is carried all the way through
            rather than being collapsed to a best guess — which is why the output is a band and
            there is no point estimate anywhere in the calculation.
          </Prose>
          <Note label="the defect is the point">
            If the estimated rate might be zero or negative, the machine might never reach the
            threshold at all. The arithmetic handles that natively: total probability of ever
            failing comes out below one, and if the far edge of the band falls in that missing
            mass, the model genuinely cannot bound the date and says so. That is not a special
            case bolted on — it falls out of the formula.
          </Note>
          <span className={styles.subhead}>the four refusals</span>
          <ul className={styles.list}>
            {REFUSALS.map((r) => (
              <li key={r.rank}>
                <strong>{r.rank}. {r.reason}</strong>
                <br />
                {r.why}
              </li>
            ))}
          </ul>
        </>
      );

    default:
      return <Prose>No note with that identifier.</Prose>;
  }
}

/* --------------------------------------------------------------------- the drawer */

const KIND_LABEL: Record<PanelKind, string> = {
  scenario: "built scenario",
  asset: "machine",
  rule: "rule",
  check: "quality check",
  baseline: "baseline",
  mode: "failure mode",
  metric: "validation number",
  maths: "the arithmetic",
};

function Body({ open }: { open: PanelRef }) {
  switch (open.kind) {
    case "scenario":
      return <ScenarioBody id={open.id} />;
    case "asset":
      return <AssetBody id={open.id} />;
    case "rule":
      return <RuleBody id={open.id} />;
    case "check":
      return <CheckBody id={open.id} />;
    case "baseline":
      return <BaselineBody id={open.id} />;
    case "mode":
      return <ModeBody id={open.id} />;
    case "metric":
      return <MetricBody id={open.id} />;
    case "maths":
      return <MathsBody id={open.id} />;
  }
}

export function Panel({ open, onClose }: { open: PanelRef | null; onClose: () => void }) {
  return (
    <aside
      className={`${styles.panel} ${open ? styles.shown : ""}`}
      aria-hidden={!open}
      aria-label={open ? open.label : "detail"}
    >
      {open && (
        <>
          <header className={styles.head}>
            <span className={styles.kind}>{KIND_LABEL[open.kind]}</span>
            <h3 className={styles.title}>{open.label}</h3>
            <button type="button" className={styles.close} onClick={onClose} aria-label="close">
              &times;
            </button>
          </header>
          <div className={styles.body}>
            <Body open={open} />
          </div>
        </>
      )}
    </aside>
  );
}
