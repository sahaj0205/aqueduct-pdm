import { Link } from "react-router-dom";

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
 *
 * WHY THIS PAGE GREW A NAVIGATION SECTION. Six separate things had been built and this
 * page offered two of them. The deck, the facility-manager platform, the flow reference
 * and the walkthrough were each reachable only by typing their address, which means that
 * for anybody who was handed a link rather than a briefing, four of the six did not
 * exist. The fix is not more buttons in the hero — it is one section that names every
 * way in, says who each is for, and says what has to be running before it will work.
 *
 * THE ORDER OF THAT SECTION IS A RANKING, not a menu. The deck first because it is the
 * only artefact that makes the whole case unaided; the platform second because it is the
 * product rather than an explanation of one; the console third because it is the
 * evidence and it is also the only entry that can fail; the reference last because it is
 * a document and documents are looked up rather than visited.
 */

interface Props {
  /** Null until the shell's first fetch lands. Numbers show as dashes until then. */
  range: ClockRange | null;
  topology: TwinTopology | null;
}

/**
 * Every way into the system, ranked, with the cost of entry stated.
 *
 * `needs` IS THE LOAD-BEARING FIELD. Three of these four are frozen captures that render
 * on a laptop with no network; the console is live and talks to an API that has to be
 * started first. A visitor who clicks the console cold gets a red error panel and
 * reasonably concludes the whole project is broken, when in fact they have opened the one
 * screen with a prerequisite. Saying so on the card costs one line and prevents that.
 *
 * THE WALKTHROUGH IS NOT IN THIS LIST, deliberately — it is a footnote under the grid.
 * It covers the same ground as the flow reference, told as a camera move rather than as a
 * document, so giving it equal billing would ask a first-time visitor to choose between
 * two entries that answer the same question. It keeps its address and its link; it does
 * not keep a card.
 */
interface Way {
  to: string;
  /** True for the flow reference, which is a file in `public/` and not a React route. */
  external?: boolean;
  name: string;
  what: string;
  /** Size and shape, so a visitor knows what they are committing to before clicking. */
  meta: string;
  /** What must already be running. Null when the entry is a frozen capture. */
  needs: string | null;
}

const WAYS: Way[] = [
  {
    to: "/deck",
    name: "The deck",
    what: "The whole case, in ten acts, for somebody deciding whether the system is worth having. The claim sits on the slide and the evidence sits behind a click — the rules, the scenarios and every validation figure each open a panel, and only if the room asks for one.",
    meta: "53 slides · ten acts",
    needs: null,
  },
  {
    to: "/fm",
    name: "The platform",
    what: "What a facility manager is actually handed: a worklist ordered by money returned rather than by severity, the asset register behind it, the week's schedule, the instruments, and the system's own track record against what really happened.",
    meta: "six sections",
    needs: null,
  },
  {
    to: "/console",
    name: "The console",
    what: "The same system opened up for somebody checking the working. A clock along the top drags through the recording and every screen shows only what was known by that date. The guided tour starts from inside it.",
    meta: "seven screens",
    needs: "make api",
  },
  {
    to: "/flow.html",
    external: true,
    name: "The flow reference",
    what: "One reading followed through thirteen stages, with the module that handles it and the database table it lands in named at each one. A document rather than a screen — it prints, and it can be sent to somebody with nothing running.",
    meta: "thirteen stages · one file",
    needs: null,
  },
];

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

export function Splash({ range, topology }: Props) {
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
            {/* The two entries that cannot fail. Both are frozen captures, so neither
                can put an error panel in front of somebody who has just arrived — which
                is why the console, live and dependent on an API, is not offered here but
                in the ranked section below where its prerequisite can be stated. */}
            <div className={styles.actions}>
            <Link className={styles.primary} to="/deck">
              Watch the deck
              <span className={styles.arrow} aria-hidden="true">
                →
              </span>
            </Link>
            <Link className={styles.secondary} to="/fm">
              Open the platform
            </Link>
          </div>
            <p className={styles.duration}>
              Ten acts. Neither needs anything running — every figure in both was
              captured from the database and travels with the page.
            </p>
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

        {/* Navigation before explanation. A visitor who already knows what this is
            should not have to scroll past four paragraphs about the pipeline to find the
            way in, so the ranked entries sit directly under the hero and "How it works"
            moves below them. */}
        <section className={styles.ways}>
          <h2 className={styles.sectionHead}>Ways in</h2>
          <div className={styles.wayGrid}>
            {WAYS.map((w) => {
              const body = (
                <>
                  <div className={styles.wayHead}>
                    <h3 className={styles.wayName}>{w.name}</h3>
                    <span className={styles.wayArrow} aria-hidden="true">
                      →
                    </span>
                  </div>
                  <p className={styles.wayWhat}>{w.what}</p>
                  <p className={styles.wayMeta}>
                    <span>{w.meta}</span>
                    {w.needs ? (
                      <span className={styles.wayNeeds}>
                        needs <code>{w.needs}</code>
                      </span>
                    ) : (
                      <span className={styles.wayFree}>nothing to start</span>
                    )}
                  </p>
                </>
              );
              // The reference is a standalone file in `public/` rather than a route, so
              // it gets a real anchor and a full page load. Routing it through the SPA
              // would only bounce it back out again through the redirect in App.tsx.
              return w.external ? (
                <a key={w.to} className={styles.way} href={w.to}>
                  {body}
                </a>
              ) : (
                <Link key={w.to} className={styles.way} to={w.to}>
                  {body}
                </Link>
              );
            })}
          </div>

          {/* The walkthrough, kept and demoted. See the note above WAYS for why it is a
              line of prose here rather than a fifth card. */}
          <p className={styles.also}>
            There is also <Link to="/story">the walkthrough</Link> — the same journey as
            the reference above, told as a camera move through the plant rather than as a
            document. Twenty-one scenes, built for a projector, nothing to start.
          </p>
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
