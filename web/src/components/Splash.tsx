import { Credit } from "../design/Credit.tsx";
import { Mark } from "../design/Mark.tsx";
import { BRAND } from "../lib/brand.ts";
import type { ClockRange, TwinTopology } from "../types.ts";
import styles from "./Splash.module.css";

/**
 * The front door.
 *
 * WHAT THE FIRST ATTEMPT GOT WRONG. It was five questions and five paragraphs of answers,
 * centred on a white page — a frequently-asked-questions list, which is the single most
 * amateur structure a product can open with. Software that expects to be paid for does
 * not open by anticipating confusion; it opens with a claim and then proves it. The
 * information was right and the form was a student essay.
 *
 * THE STATISTICS ARE REAL AND ARE READ FROM THE RUNNING SYSTEM. Every number on this page
 * is counted from the same two responses the dashboard behind it is loading — how many
 * recordings exist, how many days they cover, how many sensor points the semantic model
 * declares, how many machines it describes. Nothing is typed in. That is not only
 * honesty: a front page quoting figures its own backend would contradict is the most
 * embarrassing failure available to this kind of product, and the only reliable defence
 * is to not have the figures written down anywhere.
 *
 * WHILE THEY LOAD they render as em dashes rather than as zeros. A zero is a claim.
 */

interface Props {
  onStart: () => void;
  onSkip: () => void;
  /** Null until the shell's first fetch lands. Numbers show as dashes until then. */
  range: ClockRange | null;
  topology: TwinTopology | null;
}

/**
 * The four stages, each on its own saturated card.
 *
 * The colours are cycled and never repeated back to back — that rhythm is part of the
 * language. They are safe here for the reason set out in tokens.css: this page carries no
 * severity badge, no health bar, no chart and no plant drawing, so a peach card cannot be
 * mistaken for the orange that means `high`.
 */
const STEPS = [
  {
    n: "01",
    tone: "plain",
    name: "Ingest",
    what: "Five-minute readings off every instrument on the plant, with a quality gate that refuses frozen, stale and out-of-range values rather than averaging them in.",
  },
  {
    n: "02",
    tone: "plain",
    name: "Detect",
    what: "Physics rules written against the equipment, not a model fitted to history. Ten successive checks, and almost all of them are refusals to judge.",
  },
  {
    n: "03",
    tone: "ochre",
    name: "Predict",
    what: "Remaining life as a range with a stated confidence, or an explicit refusal when the evidence will not carry one. Never a bare date.",
  },
  {
    n: "04",
    tone: "plain",
    name: "Price",
    what: "What acting costs against what waiting is expected to cost, so the queue is ordered by dollars returned per dollar spent rather than by severity.",
  },
];

export function Splash({ onStart, onSkip, range, topology }: Props) {
  // Counted from the live responses. See the note above on why nothing here is a literal.
  const recordings = range?.eras.length ?? null;
  const days = range ? range.eras.reduce((sum, e) => sum + e.days, 0) : null;
  const points = topology
    ? topology.nodes.reduce((sum, n) => sum + n.points.length, 0)
    : null;
  const machines = topology
    ? new Set(topology.nodes.filter((n) => n.asset_id).map((n) => n.asset_id)).size
    : null;

  const stats = [
    { value: recordings, label: "Recordings", note: "independent runs of the same plant" },
    { value: days, label: "Days of data", note: "at five-minute resolution" },
    { value: points, label: "Sensor points", note: "declared by the semantic model" },
    { value: machines, label: "Machines", note: "chillers, towers, air handler" },
  ];

  return (
    <div className={styles.page}>
      <div className={styles.mesh} aria-hidden="true" />
      <header className={styles.bar}>
        <div className={styles.brand}>
          <span className={styles.mark}>
            <Mark size={24} />
          </span>
          <span className={styles.wordmark}>{BRAND.name}</span>
        </div>
        <span className={styles.tag}>{BRAND.tagline}</span>
      </header>

      <main className={styles.main}>
        <section className={styles.hero}>
          <div className={styles.heroCopy}>
            <h1 className={styles.headline}>
            Know which machine fails next, and what waiting for it costs.
          </h1>
            <p className={styles.lede}>
            {BRAND.name} watches the cooling plant of a large building, finds faults in
            the sensor data before anybody reports them, and prices the decision to act
            now against the decision to wait.
          </p>
            <div className={styles.actions}>
            <button className={styles.primary} onClick={onStart}>
              Take the guided tour
              <span className={styles.arrow} aria-hidden="true">
                →
              </span>
            </button>
            <button className={styles.secondary} onClick={onSkip}>
              Open the console
            </button>
          </div>
            <p className={styles.duration}>Ten stops, about four minutes.</p>
          </div>

          {/* The right-hand slot. This language puts an illustrated artifact here; ours
              holds the figures the running system is reporting, which is the honest
              equivalent — an artifact that is true rather than one that is drawn. */}
          <div className={styles.stats} aria-label="what is loaded">
            {stats.map((s) => (
              <div key={s.label} className={styles.stat}>
                <span className={styles.statValue}>
                  {s.value === null ? "—" : s.value.toLocaleString()}
                </span>
                <span className={styles.statLabel}>{s.label}</span>
                <span className={styles.statNote}>{s.note}</span>
              </div>
            ))}
          </div>
        </section>

        <section className={styles.process}>
          <h2 className={styles.sectionHead}>How it works</h2>
          <div className={styles.steps}>
            {STEPS.map((s) => (
              <div key={s.n} className={`${styles.step} ${styles[s.tone]}`}>
                <span className={styles.stepNo}>{s.n}</span>
                <h3 className={styles.stepName}>{s.name}</h3>
                <p className={styles.stepWhat}>{s.what}</p>
              </div>
            ))}
          </div>
        </section>

        {/* The one dark element on the page, and it carries the two facts a visitor is
            most likely to get wrong: that this is a recording, and that the accuracy
            figures are not the system marking its own homework. Given contrast rather
            than a footnote because both are load-bearing. */}
        <section className={styles.honest}>
          <h2 className={styles.honestHead}>Before you go in</h2>
          <div className={styles.honestGrid}>
            <div>
              <h3>This is a recording, not a live building.</h3>
              <p>
                The sensor data is real, published by a United States national laboratory.
                The faults were then introduced deliberately, at moments we chose. The
                clock along the top of every screen is your position in that recording —
                move it, and every screen shows what the system had worked out by that
                date and nothing it learned later.
              </p>
            </div>
            <div>
              <h3>The system is not marking its own homework.</h3>
              <p>
                Because we placed the faults, we know exactly what broke and when. The half
                of the system that does the detecting has never seen that record — it signs
                in to the database as a user with no permission to read it at all. When it
                gets something right, it could not have been reading the answers.
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer className={styles.foot}>
        <Credit />
        <span>
          Source data: LBNL fault-detection datasets for a single-duct air handler and a
          water-cooled chiller plant.
        </span>
        <span className={styles.footMeta}>
          {range ? `${range.t_from.slice(0, 4)}–${range.t_to.slice(0, 4)} simulated` : ""}
        </span>
      </footer>
    </div>
  );
}
