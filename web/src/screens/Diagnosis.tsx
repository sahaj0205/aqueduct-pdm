import { useEffect, useState } from "react";

import { api } from "../api.ts";
import { ClassTimeline } from "../components/ClassTimeline.tsx";
import { Reconciliation } from "../components/Reconciliation.tsx";
import { ScreenHead } from "../design/ScreenHead.tsx";
import { Term } from "../design/Term.tsx";
import type { DiagnosisPair } from "../types.ts";

/**
 * Sensor or equipment: two faults that look the same and are not.
 *
 * A supply air temperature above its setpoint is produced by a coil that cannot cool
 * AND by a thermometer reading high. From the symptom alone they are identical, and
 * getting them the wrong way round sends a technician with a wrench to something that
 * needs a calibration kit.
 *
 * This screen does NOT pretend the two were seen together. They are two runs two years
 * apart and no position of the clock holds both; the banner says so. What it does show
 * is what separates them, and what separating them is worth — which is a number, and
 * not a small one.
 */

/**
 * The headline, with the ratio live rather than typed in.
 *
 * Defined once and used in both the loading and the loaded state, so the screen has a
 * title before it has data. The number is whatever the API computed for this pair — it
 * was 3.16× the last time anybody looked, and writing that into the string would leave
 * the screen asserting a figure the tables below it had stopped agreeing with.
 */
function Head({ ratio }: { ratio: number | null }) {
  return (
    <ScreenHead
      sub={
        <>
          Air coming out too warm is produced by a cooling coil that cannot cool
          <em> and</em> by a thermometer reading high. From the symptom alone the two are
          identical — and sending the wrong van costs the difference above.
        </>
      }
      why={
        <>
          What separates them is <Term id="isolation">isolation</Term>: asking whether
          assuming <strong>one single reading</strong> is wrong would make every violated
          relation hold true again. A bad measurement is wrong by a consistent amount
          everywhere it appears, and a failing machine is not — so if one correction fixes
          everything, the instrument is at fault, and if it does not, the machine is.
          <br />
          <br />
          The two faults here are from different <Term id="era">runs</Term> two years
          apart and no position of the clock holds both. The screen says so rather than
          implying they were seen side by side.
        </>
      }
    >
      {ratio === null
        ? "One symptom, two causes"
        : `One symptom. Two causes. ${ratio}× apart.`}
    </ScreenHead>
  );
}

export function Diagnosis() {
  const [pair, setPair] = useState<DiagnosisPair | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await api.diagnosisPair();
        if (!cancelled) setPair(next);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="notice">
        <strong>The pair could not be loaded.</strong>
        <div className="muted" style={{ marginTop: 6 }}>
          {error}
        </div>
      </div>
    );
  }
  if (!pair) {
    return (
      <section>
        <Head ratio={null} />
        <div className="muted">Loading the pair…</div>
      </section>
    );
  }

  const withAlternative = [pair.left, pair.right].find((c) => c?.alternative);

  return (
    <section>
      <Head ratio={pair.cost_ratio} />

      {pair.composed && (
        <div className="notice" style={{ marginBottom: 14 }}>
          <strong>These two are from different runs, two years apart.</strong>
          <div className="muted" style={{ marginTop: 6, lineHeight: 1.5 }}>
            No position of the clock holds both, so this comparison is composed rather
            than observed — each fault is shown on the last day it appeared in a queue,
            which is where its classifier had the most evidence. Saying so matters: the
            alternative is a screen implying these were seen side by side, which they
            never were.
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        {pair.left && <Reconciliation side={pair.left} />}
        {pair.right && <Reconciliation side={pair.right} />}
      </div>

      {withAlternative?.alternative && withAlternative.intervention && (
        <div
          className="notice"
          style={{ marginTop: 14, borderLeft: "3px solid var(--warn)" }}
        >
          <strong>
            What the discrimination is worth: {pair.cost_ratio}× on the same symptom.
          </strong>
          <div className="muted" style={{ marginTop: 7, lineHeight: 1.6 }}>
            {withAlternative.fault_id} dispatched as a{" "}
            <strong>{withAlternative.fault_class}</strong> fault costs{" "}
            <strong>
              $
              {withAlternative.intervention.effort_usd.toLocaleString(undefined, {
                minimumFractionDigits: 2,
              })}
            </strong>{" "}
            — {withAlternative.intervention.duration_hours} h,{" "}
            {withAlternative.intervention.intervention_id}. The same rule on the same
            machine, classified the other way, costs{" "}
            <strong>
              $
              {withAlternative.alternative.effort_usd.toLocaleString(undefined, {
                minimumFractionDigits: 2,
              })}
            </strong>{" "}
            — {withAlternative.alternative.duration_hours} h,{" "}
            {withAlternative.alternative.intervention_id}. Both figures are real
            advisories this system produced on different days, not a lookup: the
            classifier called this fault both things, so both dispatches were costed.
          </div>
        </div>
      )}

      {pair.left && (
        <ClassTimeline history={pair.left.history} faultId={pair.left.fault_id} />
      )}
      {pair.right && (
        <ClassTimeline history={pair.right.history} faultId={pair.right.fault_id} />
      )}
    </section>
  );
}
